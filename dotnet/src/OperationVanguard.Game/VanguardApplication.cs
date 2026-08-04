using OperationVanguard.Core;

namespace OperationVanguard.Game;

public static class VanguardApplication
{
    [STAThread]
    public static int Execute(string[] args)
    {
        try
        {
            if (args.Contains("--validate", StringComparer.OrdinalIgnoreCase))
            {
                return ValidateContent();
            }

            using var game = new VanguardGame(args);
            game.Run();
            return 0;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine($"Operation Vanguard failed: {exception}");
            return 1;
        }
    }

    private static int ValidateContent()
    {
        var errors = new List<string>();
        errors.AddRange(CampaignCatalog.ValidateAllMissions()
            .SelectMany(pair => pair.Value.Select(error => $"{pair.Key}: {error}")));
        errors.AddRange(Maps.All.SelectMany(Maps.ValidateStructure));
        foreach (var map in Maps.All)
        {
            var world = new BrushCollisionWorld(map.Brushes, map.Bounds);
            if (map.Spawns.Count > 0 && !double.IsFinite(world.GroundHeightAt(
                    map.Spawns[0].Position.X,
                    map.Spawns[0].Position.Z,
                    map.Bounds.Max.Y,
                    map.Bounds.Max.Y - map.Bounds.Min.Y + 20)))
            {
                errors.Add($"{map.Id}: first spawn has no collision ground beneath it");
            }
        }

        if (errors.Count > 0)
        {
            foreach (var error in errors) Console.Error.WriteLine(error);
            return 2;
        }

        Console.WriteLine(
            $"Validated {Maps.All.Count} maps and {CampaignCatalog.CampaignMissions.Count} campaign missions.");
        return 0;
    }
}
