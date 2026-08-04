using System.Collections.ObjectModel;
using System.Text.Json.Serialization;

namespace OperationVanguard.Core;

[JsonConverter(typeof(JsonStringEnumConverter<KillstreakKind>))]
public enum KillstreakKind
{
    [JsonStringEnumMemberName("passive")] Passive,
    [JsonStringEnumMemberName("call_in")] CallIn,
    [JsonStringEnumMemberName("controlled")] Controlled,
    [JsonStringEnumMemberName("care_package")] CarePackage,
    [JsonStringEnumMemberName("deployable")] Deployable,
}

public sealed class KillstreakDef
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public int Cost { get; set; }
    public int ScoreCost { get; set; }
    public string Description { get; set; } = "";
    public KillstreakKind Kind { get; set; }
    public double Duration { get; set; }
    public KillstreakVehicleKind? Vehicle { get; set; }
    public double? Damage { get; set; }
    public double? Radius { get; set; }
    public double? Health { get; set; }
    public int UnlockLevel { get; set; }
    public string FriendlyAnnounce { get; set; } = "";
    public string EnemyAnnounce { get; set; } = "";
}

public static class KillstreakData
{
    public static IReadOnlyList<string> DefaultKillstreaks { get; } =
        new[] { "uav", "precision_airstrike", "chopper_gunner" };

    public static IReadOnlyList<KillstreakDef> All { get; }
    public static IReadOnlyDictionary<string, KillstreakDef> Killstreaks { get; }

    static KillstreakData()
    {
        var all = RegistryJson.DeserializeList<KillstreakDef>(RegistryPayloads.KillstreaksJson);
        All = all.AsReadOnly();
        Killstreaks = new ReadOnlyDictionary<string, KillstreakDef>(
            all.ToDictionary(definition => definition.Id, StringComparer.Ordinal));
    }

    public static KillstreakDef GetKillstreak(string id)
        => Killstreaks.TryGetValue(id, out var definition)
            ? definition
            : throw new KeyNotFoundException($"Unknown killstreak: {id}");

    public static IReadOnlyList<KillstreakDef> KillstreaksUpTo(int cost)
        => All.Where(definition => definition.Cost <= cost)
            .OrderBy(definition => definition.Cost)
            .ThenBy(definition => definition.Id, StringComparer.Ordinal)
            .ToArray();
}
