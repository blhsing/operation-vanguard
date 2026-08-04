using System.Reflection;
using System.Text.Json;

namespace OperationVanguard.Core;

/// <summary>
/// The six canonical maps, loaded from the generated cross-language parity
/// payload embedded in the assembly. No Node runtime or web files are needed
/// when the .NET game runs.
/// </summary>
public static class Maps
{
    private const string ContentResource = "OperationVanguard.Parity.Content.json";
    private static readonly string[] CanonicalOrder =
        ["crossfire", "refinery", "shipment_yard", "highrise", "dust_market", "subway"];

    private static readonly IReadOnlyDictionary<string, MapDef> ById = Load();

    public static IReadOnlyList<MapDef> All { get; } =
        CanonicalOrder.Select(id => ById[id]).ToArray();

    public static IReadOnlyList<string> Ids { get; } = [.. CanonicalOrder];
    public static string DefaultId => "crossfire";

    public static MapDef Get(string id) => ById.TryGetValue(id, out var map)
        ? map
        : throw new KeyNotFoundException($"Unknown map id: {id}");

    public static bool TryGet(string id, out MapDef? map) => ById.TryGetValue(id, out map);

    public static IReadOnlyList<MapDef> ForMode(string modeId) => All
        .Where(map => map.SupportedModes is null || map.SupportedModes.Count == 0 ||
                      map.SupportedModes.Contains(modeId, StringComparer.Ordinal))
        .ToArray();

    public static IReadOnlyList<MapDef> ForPlayerCount(int count)
    {
        var fitting = All.Where(map => map.PlayerCount is [var minimum, var maximum] &&
                                       count >= minimum && count <= maximum).ToArray();
        return fitting.Length > 0 ? fitting : All;
    }

    /// <summary>
    /// Checks data-only invariants. Collision-backed spawn validation is added
    /// by <c>MapValidation</c> once its world has been constructed.
    /// </summary>
    public static IReadOnlyList<string> ValidateStructure(MapDef map)
    {
        var errors = new List<string>();
        var tag = map.Id;
        if (map.Brushes.Count == 0)
        {
            errors.Add($"{tag}: has no geometry");
            return errors;
        }
        if (map.Bounds.Min.X >= map.Bounds.Max.X || map.Bounds.Min.Z >= map.Bounds.Max.Z)
        {
            errors.Add($"{tag}: bounds are inverted or degenerate");
            return errors;
        }

        var allied = map.Spawns.Count(spawn => spawn.Team == Team.Allies);
        var axis = map.Spawns.Count(spawn => spawn.Team == Team.Axis);
        var neutral = map.Spawns.Count(spawn => spawn.Team == Team.None);
        if (allied < 8) errors.Add($"{tag}: only {allied} Allied spawns, want at least 8");
        if (axis < 8) errors.Add($"{tag}: only {axis} Axis spawns, want at least 8");
        if (neutral < 4) errors.Add($"{tag}: only {neutral} neutral spawns for free-for-all, want 4+");

        foreach (var spawn in map.Spawns.Where(spawn => !InBounds(spawn.Position, map.Bounds)))
            errors.Add($"{tag}: spawn '{spawn.Group}' at ({spawn.Position.X}, {spawn.Position.Z}) is outside bounds");

        foreach (var group in map.Objectives.GroupBy(objective => objective.Kind))
        {
            foreach (var duplicate in group.GroupBy(objective => objective.Label).Where(labels => labels.Count() > 1))
                errors.Add($"{tag}: duplicate objective label '{duplicate.Key}' for kind '{group.Key}'");
        }
        foreach (var objective in map.Objectives)
        {
            if (!InBounds(objective.Position, map.Bounds))
                errors.Add($"{tag}: objective '{objective.Label}' ({objective.Kind}) is outside bounds");
            if (objective.Size.X <= 0 || objective.Size.Y <= 0 || objective.Size.Z <= 0)
                errors.Add($"{tag}: objective '{objective.Label}' has a non-positive size");
        }

        RequireObjectiveCount(map, ObjectiveKind.DominationFlag, 3, "Domination", errors);
        RequireObjectiveCount(map, ObjectiveKind.BombSite, 2, "Search & Destroy", errors);
        var hardpoints = map.Objectives.Where(objective => objective.Kind == ObjectiveKind.Hardpoint).ToArray();
        if (hardpoints.Length is > 0 and < 3)
            errors.Add($"{tag}: Hardpoint rotation needs at least 3 zones, found {hardpoints.Length}");
        if (hardpoints.Length > 0 && !hardpoints.Select(point => point.Order ?? -1).Order().SequenceEqual(Enumerable.Range(0, hardpoints.Length)))
            errors.Add($"{tag}: Hardpoint zone orders must be 0..n-1 with no gaps");

        if (map.Lanes.Count < 2) errors.Add($"{tag}: needs at least 2 lanes to describe its layout");
        foreach (var lane in map.Lanes)
        {
            if (lane.Path.Count < 2) errors.Add($"{tag}: lane '{lane.Name}' needs at least 2 waypoints");
            if (lane.Path.Any(point => !InBounds(point, map.Bounds, 2)))
                errors.Add($"{tag}: lane '{lane.Name}' has a waypoint outside bounds");
        }

        if (map.CoverPoints.Count < 20)
            errors.Add($"{tag}: only {map.CoverPoints.Count} cover points — bots will look lost with fewer than 20");
        var invalidCover = map.CoverPoints.FirstOrDefault(point => point.Exposure is < 0 or > 1);
        if (invalidCover is not null)
            errors.Add($"{tag}: cover point at ({invalidCover.Position.X}, {invalidCover.Position.Z}) has exposure outside 0..1");

        foreach (var link in map.NavLinks)
        {
            if (!InBounds(link.From, map.Bounds, 2) || !InBounds(link.To, map.Bounds, 2))
                errors.Add($"{tag}: nav link from ({link.From.X}, {link.From.Z}) leaves the map");
            if (link.Cost <= 0) errors.Add($"{tag}: nav link has a non-positive cost");
        }

        var lightCount = map.Lighting.Lights?.Count ?? 0;
        if (lightCount > 16)
            errors.Add($"{tag}: declares {lightCount} point lights, more than the 16 every quality tier renders");
        if (map.Lighting.AmbientIntensity <= 0)
            errors.Add($"{tag}: ambientIntensity must be positive or unlit surfaces render black");

        var outsideBrushes = map.Brushes.Count(brush => !InBounds(brush.Position, map.Bounds, 4));
        if (outsideBrushes > 0) errors.Add($"{tag}: {outsideBrushes} brushes sit outside the declared bounds");
        return errors;
    }

    private static IReadOnlyDictionary<string, MapDef> Load()
    {
        using var stream = typeof(Maps).Assembly.GetManifestResourceStream(ContentResource)
            ?? throw new InvalidOperationException($"Embedded content resource '{ContentResource}' is missing.");
        using var document = JsonDocument.Parse(stream);
        var raw = document.RootElement.GetProperty("maps").GetRawText();
        var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
        var maps = JsonSerializer.Deserialize<Dictionary<string, MapDef>>(raw, options)
            ?? throw new InvalidOperationException("Could not deserialize the map registry.");
        foreach (var id in CanonicalOrder)
            if (!maps.ContainsKey(id)) throw new InvalidOperationException($"Map payload is missing '{id}'.");
        return maps;
    }

    private static bool InBounds(Vec3 point, MapBounds bounds, double margin = 0) =>
        point.X >= bounds.Min.X - margin && point.X <= bounds.Max.X + margin &&
        point.Z >= bounds.Min.Z - margin && point.Z <= bounds.Max.Z + margin &&
        point.Y >= bounds.Min.Y - margin && point.Y <= bounds.Max.Y + margin;

    private static void RequireObjectiveCount(
        MapDef map,
        ObjectiveKind kind,
        int wanted,
        string label,
        ICollection<string> errors)
    {
        var count = map.Objectives.Count(objective => objective.Kind == kind);
        if (count != 0 && count != wanted)
            errors.Add($"{map.Id}: {label} needs exactly {wanted} zones, found {count}");
    }
}
