using System.Collections.ObjectModel;

namespace OperationVanguard.Core;

public static class ModeData
{
    public const string ZombiesModeId = "zombies";
    public const string DefaultMode = "tdm";

    private static readonly WeaponClass[] LadderPreferences =
    [
        WeaponClass.Pistol,
        WeaponClass.Pistol,
        WeaponClass.SubmachineGun,
        WeaponClass.SubmachineGun,
        WeaponClass.Shotgun,
        WeaponClass.AssaultRifle,
        WeaponClass.AssaultRifle,
        WeaponClass.SubmachineGun,
        WeaponClass.MarksmanRifle,
        WeaponClass.LightMachineGun,
        WeaponClass.AssaultRifle,
        WeaponClass.SniperRifle,
        WeaponClass.Shotgun,
        WeaponClass.SubmachineGun,
        WeaponClass.MarksmanRifle,
        WeaponClass.AssaultRifle,
        WeaponClass.LightMachineGun,
        WeaponClass.SniperRifle,
        WeaponClass.Launcher,
        WeaponClass.Melee,
    ];

    public static IReadOnlyList<GameModeDef> All { get; }
    public static IReadOnlyDictionary<string, GameModeDef> GameModes { get; }
    public static IReadOnlyList<string> ModeIds { get; }
    public static IReadOnlyList<string> MultiplayerModeIds { get; }
    public static IReadOnlyList<string> PlayableModeIds { get; }

    static ModeData()
    {
        var all = RegistryJson.DeserializeList<GameModeDef>(RegistryPayloads.ModesJson);
        All = all.AsReadOnly();
        GameModes = new ReadOnlyDictionary<string, GameModeDef>(
            all.ToDictionary(mode => mode.Id, StringComparer.Ordinal));
        ModeIds = all.Select(mode => mode.Id).ToArray();
        MultiplayerModeIds = all
            .Where(mode => mode.Id is not ZombiesModeId and not "campaign")
            .Select(mode => mode.Id)
            .ToArray();
        PlayableModeIds = ModeIds.ToArray();
    }

    public static GameModeDef GetMode(string id)
        => GameModes.TryGetValue(id, out var mode)
            ? mode
            : throw new KeyNotFoundException($"Unknown game mode id: {id}");

    public static GameModeDef? TryGetMode(string id)
        => GameModes.TryGetValue(id, out var mode) ? mode : null;

    public static int DefaultTeamSizeFor(GameModeDef mode, int playerCount)
    {
        if (!mode.TeamBased) return playerCount;
        var perTeam = (int)Math.Ceiling(playerCount / 2.0);
        return Math.Max(mode.TeamSize[0], Math.Min(mode.TeamSize[1], perTeam));
    }

    public static IReadOnlyList<string> GunGameLadder()
        => ResolveLadder(WeaponData.WeaponsByClass);

    public static IReadOnlyList<string> ResolveLadder(
        IReadOnlyDictionary<WeaponClass, IReadOnlyList<WeaponDef>> weaponsByClass)
    {
        var used = new HashSet<string>(StringComparer.Ordinal);
        var cursor = new Dictionary<WeaponClass, int>();
        var output = new List<string>();

        foreach (var weaponClass in LadderPreferences)
        {
            if (!weaponsByClass.TryGetValue(weaponClass, out var pool) || pool.Count == 0) continue;
            var index = cursor.GetValueOrDefault(weaponClass);
            string? picked = null;
            for (var i = 0; i < pool.Count; i++)
            {
                var candidate = pool[(index + i) % pool.Count];
                if (used.Contains(candidate.Id)) continue;
                picked = candidate.Id;
                index = (index + i + 1) % pool.Count;
                break;
            }

            picked ??= pool[0].Id;
            cursor[weaponClass] = index;
            used.Add(picked);
            output.Add(picked);
        }

        return output;
    }

    public static bool IsRoundBased(GameModeDef mode) => mode.RoundsToWin > 1;
    public static bool UsesObjectives(GameModeDef mode) => mode.ObjectiveKind is not null;
    public static bool HasReachedScoreLimit(GameModeDef mode, double score)
        => mode.ScoreLimit > 0 && score >= mode.ScoreLimit;

    public static int StreakCost(GameModeDef mode, int killCost, int scoreCost, double discount)
    {
        var baseCost = mode.ScorestreaksOnly ? scoreCost : killCost;
        return Math.Max(1, DataNumber.JsRoundToInt(baseCost * discount));
    }
}
