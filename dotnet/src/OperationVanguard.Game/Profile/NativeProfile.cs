using System.Text.Json;
using OperationVanguard.Core;
using OperationVanguard.Game.Input;

namespace OperationVanguard.Game.Profile;

public sealed class NativeProfile
{
    public int Version { get; set; } = ProfileStore.CurrentVersion;
    public string Name { get; set; } = "玩家";
    public int Rank { get; set; } = 1;
    public int Prestige { get; set; }
    public double Xp { get; set; }
    public ProfileStats Stats { get; set; } = new();
    public List<Loadout> Loadouts { get; set; } = [];
    public int ActiveLoadout { get; set; }
    public Dictionary<string, double> WeaponXp { get; set; } = new(StringComparer.Ordinal);
    public LastMatchSettings LastMatch { get; set; } = new();
    public NativeSettings Settings { get; set; } = new();
    public HashSet<string> CompletedMissions { get; set; } = new(StringComparer.Ordinal);
}

public sealed class ProfileStats
{
    public int Kills { get; set; }
    public int Deaths { get; set; }
    public int Assists { get; set; }
    public double Score { get; set; }
    public int Matches { get; set; }
    public int Wins { get; set; }
    public int Headshots { get; set; }
    public double TimePlayed { get; set; }
    public int HighestZombieRound { get; set; }
}

public sealed class LastMatchSettings
{
    public string MapId { get; set; } = Maps.DefaultId;
    public string ModeId { get; set; } = ModeData.DefaultMode;
    public int BotCount { get; set; } = 9;
    public string Difficulty { get; set; } = "recruit";
    public string MissionId { get; set; } = CampaignCatalog.MissionIds[0];
    public bool Online { get; set; }
    public string ServerUrl { get; set; } = GameConstants.Network.DefaultUrl;
}

public sealed class NativeSettings
{
    public double MouseSensitivity { get; set; } = 1;
    public double AdsSensitivityScale { get; set; } = .8;
    public bool InvertY { get; set; }
    public bool AutoSprint { get; set; }
    public bool ToggleAds { get; set; }
    public bool ToggleCrouch { get; set; }
    public double GamepadDeadzone { get; set; } = .14;
    public double GamepadSensitivity { get; set; } = 2.4;
    public double AimAssist { get; set; } = .5;
    public Dictionary<string, List<string>> Bindings { get; set; } = InputBindingCatalog.CreateDefaults();
    public int FieldOfView { get; set; } = 80;
    public bool ShowFps { get; set; }
    public bool ShowCrosshair { get; set; } = true;
    public bool ShowMinimap { get; set; } = true;
    public double HudScale { get; set; } = 1;
    public double MasterVolume { get; set; } = .8;
    public double SfxVolume { get; set; } = 1;
    public double MusicVolume { get; set; } = .5;
}

public static class ProfileStore
{
    public const int CurrentVersion = 1;
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true,
    };

    public static string ProfilePath { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "OperationVanguard",
        "profile.json");

    public static NativeProfile Create()
    {
        var profile = new NativeProfile();
        for (var index = 0; index < 10; index++)
            profile.Loadouts.Add(LoadoutSystem.DefaultLoadout($"兵種{index + 1}"));
        return profile;
    }

    public static NativeProfile Load()
    {
        try
        {
            if (!File.Exists(ProfilePath)) return Create();
            var profile = JsonSerializer.Deserialize<NativeProfile>(File.ReadAllText(ProfilePath), JsonOptions);
            return Sanitize(profile ?? Create());
        }
        catch (IOException)
        {
            return Create();
        }
        catch (JsonException)
        {
            return Create();
        }
        catch (UnauthorizedAccessException)
        {
            return Create();
        }
    }

    public static void Save(NativeProfile profile)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(ProfilePath)!);
            var temporary = ProfilePath + ".tmp";
            File.WriteAllText(temporary, JsonSerializer.Serialize(Sanitize(profile), JsonOptions));
            File.Move(temporary, ProfilePath, true);
        }
        catch (IOException)
        {
            // Persistence is optional; a failed write must never end a match.
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    public static int XpForRank(int rank) => (int)Math.Floor(900d * rank + 55d * rank * rank + .5d);

    public static (int Current, int Next, double Fraction) RankProgress(NativeProfile profile)
    {
        var current = XpForRank(profile.Rank);
        var next = XpForRank(profile.Rank + 1);
        return (current, next, Math.Clamp((profile.Xp - current) / Math.Max(1, next - current), 0, 1));
    }

    private static NativeProfile Sanitize(NativeProfile profile)
    {
        profile.Version = CurrentVersion;
        profile.Name = Clean(profile.Name, "玩家", 20);
        profile.Rank = Math.Clamp(profile.Rank, 1, GameConstants.MaxRank);
        profile.Prestige = Math.Clamp(profile.Prestige, 0, GameConstants.MaxPrestige);
        profile.Xp = FiniteAtLeast(profile.Xp, 0);
        profile.Stats ??= new ProfileStats();
        profile.Stats.Kills = Math.Max(0, profile.Stats.Kills);
        profile.Stats.Deaths = Math.Max(0, profile.Stats.Deaths);
        profile.Stats.Assists = Math.Max(0, profile.Stats.Assists);
        profile.Stats.Matches = Math.Max(0, profile.Stats.Matches);
        profile.Stats.Wins = Math.Max(0, profile.Stats.Wins);
        profile.Stats.Headshots = Math.Max(0, profile.Stats.Headshots);
        profile.Stats.HighestZombieRound = Math.Max(0, profile.Stats.HighestZombieRound);
        profile.Stats.Score = FiniteAtLeast(profile.Stats.Score, 0);
        profile.Stats.TimePlayed = FiniteAtLeast(profile.Stats.TimePlayed, 0);
        profile.LastMatch ??= new LastMatchSettings();
        profile.Settings ??= new NativeSettings();
        profile.WeaponXp ??= new Dictionary<string, double>(StringComparer.Ordinal);
        profile.CompletedMissions ??= new HashSet<string>(StringComparer.Ordinal);

        profile.LastMatch.MapId = Maps.TryGet(profile.LastMatch.MapId, out _)
            ? profile.LastMatch.MapId
            : Maps.DefaultId;
        profile.LastMatch.ModeId = ModeData.TryGetMode(profile.LastMatch.ModeId) is not null
            ? profile.LastMatch.ModeId
            : ModeData.DefaultMode;
        profile.LastMatch.BotCount = Math.Clamp(profile.LastMatch.BotCount, 0, 23);
        profile.LastMatch.Difficulty = BotData.Difficulties.ContainsKey(profile.LastMatch.Difficulty)
            ? profile.LastMatch.Difficulty
            : "recruit";
        profile.LastMatch.MissionId = CampaignCatalog.TryGetMission(profile.LastMatch.MissionId) is not null
            ? profile.LastMatch.MissionId
            : CampaignCatalog.MissionIds[0];
        profile.LastMatch.ServerUrl = Clean(profile.LastMatch.ServerUrl, GameConstants.Network.DefaultUrl, 200);

        profile.Settings.MouseSensitivity = ClampFinite(profile.Settings.MouseSensitivity, 1, .1, 4);
        profile.Settings.AdsSensitivityScale = ClampFinite(profile.Settings.AdsSensitivityScale, .8, .2, 1.5);
        profile.Settings.GamepadDeadzone = ClampFinite(profile.Settings.GamepadDeadzone, .14, 0, .5);
        profile.Settings.GamepadSensitivity = ClampFinite(profile.Settings.GamepadSensitivity, 2.4, .1, 8);
        profile.Settings.AimAssist = ClampFinite(profile.Settings.AimAssist, .5, 0, 1);
        profile.Settings.Bindings = InputBindingCatalog.Sanitize(profile.Settings.Bindings);
        profile.Settings.FieldOfView = Math.Clamp(profile.Settings.FieldOfView, 65, 120);
        profile.Settings.HudScale = ClampFinite(profile.Settings.HudScale, 1, .75, 1.5);
        profile.Settings.MasterVolume = ClampFinite(profile.Settings.MasterVolume, .8, 0, 1);
        profile.Settings.SfxVolume = ClampFinite(profile.Settings.SfxVolume, 1, 0, 1);
        profile.Settings.MusicVolume = ClampFinite(profile.Settings.MusicVolume, .5, 0, 1);

        profile.Loadouts ??= [];
        profile.Loadouts = profile.Loadouts.Take(10)
            .Select((loadout, index) => SanitizeLoadout(loadout, $"兵種{index + 1}"))
            .ToList();
        while (profile.Loadouts.Count < 10)
            profile.Loadouts.Add(LoadoutSystem.DefaultLoadout($"兵種{profile.Loadouts.Count + 1}"));
        profile.ActiveLoadout = Math.Clamp(profile.ActiveLoadout, 0, 9);
        return profile;
    }

    private static Loadout SanitizeLoadout(Loadout? value, string fallbackName)
    {
        var fallback = LoadoutSystem.DefaultLoadout(fallbackName);
        if (value is null) return fallback;
        value.Name = Clean(value.Name, fallbackName, 24);
        value.Primary = Clean(value.Primary, fallback.Primary, 40);
        value.Secondary = Clean(value.Secondary, fallback.Secondary, 40);
        value.Lethal = Clean(value.Lethal, fallback.Lethal, 40);
        value.Tactical = Clean(value.Tactical, fallback.Tactical, 40);
        var fieldUpgrade = value.FieldUpgrade?.Trim() ?? string.Empty;
        value.FieldUpgrade = fieldUpgrade[..Math.Min(fieldUpgrade.Length, 40)];
        value.PrimaryAttachments = (value.PrimaryAttachments ?? []).Where(NotBlank).Take(8).ToList();
        value.SecondaryAttachments = (value.SecondaryAttachments ?? []).Where(NotBlank).Take(8).ToList();
        value.Perks = (value.Perks ?? []).Where(NotBlank).Take(3).ToList();
        value.Killstreaks = (value.Killstreaks ?? fallback.Killstreaks).Where(NotBlank).Take(3).ToList();
        return value;
    }

    private static string Clean(string? value, string fallback, int maximum)
    {
        var clean = value?.Trim();
        if (string.IsNullOrEmpty(clean)) return fallback;
        return clean[..Math.Min(clean.Length, maximum)];
    }

    private static bool NotBlank(string value) => !string.IsNullOrWhiteSpace(value);
    private static double FiniteAtLeast(double value, double minimum) =>
        double.IsFinite(value) ? Math.Max(minimum, value) : minimum;
    private static double ClampFinite(double value, double fallback, double minimum, double maximum) =>
        double.IsFinite(value) ? Math.Clamp(value, minimum, maximum) : fallback;
}
