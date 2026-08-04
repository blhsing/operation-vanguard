namespace OperationVanguard.Core;

public enum InteractKind
{
    Door,
    WallBuy,
    MysteryBox,
    PackAPunch,
    PerkMachine,
    Power,
}

public sealed class ZombieInteractableDef
{
    public string Id { get; init; } = string.Empty;
    public InteractKind Kind { get; init; }
    public Vec3 Position { get; init; } = new();
    public double Yaw { get; init; }
    public int Cost { get; init; }
    public string Zone { get; init; } = string.Empty;
    public string? OpensZone { get; init; }
    public string? WeaponId { get; init; }
    public int? AmmoCost { get; init; }
    public string? PerkId { get; init; }
    public bool RequiresPower { get; init; }
    public string Label { get; init; } = string.Empty;
}

public sealed class ZombieZoneDef
{
    public string Id { get; init; } = string.Empty;
    public string Name { get; init; } = string.Empty;
    public IReadOnlyList<Vec3> SpawnPoints { get; init; } = [];
    public bool StartingZone { get; init; }
}

public sealed class ZombiesMapData
{
    public string MapId { get; init; } = string.Empty;
    public IReadOnlyList<Vec3> PlayerSpawns { get; init; } = [];
    public IReadOnlyList<ZombieZoneDef> Zones { get; init; } = [];
    public IReadOnlyList<ZombieInteractableDef> Interactables { get; init; } = [];
    public string StartingWeapon { get; init; } = string.Empty;
    public string StartingPistol { get; init; } = string.Empty;
    public int StartingPoints { get; init; }
}

public sealed class ZombiePerkDef
{
    public string Id { get; init; } = string.Empty;
    public string Name { get; init; } = string.Empty;
    public int Cost { get; init; }
    public string Description { get; init; } = string.Empty;
    public double? HealthMultiplier { get; init; }
    public double? ReloadMultiplier { get; init; }
    public double? FireRateMultiplier { get; init; }
    public double? SpeedMultiplier { get; init; }
    public double? ReviveMultiplier { get; init; }
    public bool SelfRevive { get; init; }
    public int Color { get; init; }
}

public static class ZombieData
{
    public const int MaximumPerks = 4;
    public const int MysteryBoxCost = 950;
    public const int PackAPunchCost = 5000;
    public const int WallAmmoMagazines = 3;

    public static IReadOnlyDictionary<string, ZombiePerkDef> Perks { get; } =
        new Dictionary<string, ZombiePerkDef>(StringComparer.Ordinal)
        {
            ["juggernog"] = new()
            {
                Id = "juggernog", Name = "重裝可樂", Cost = 2500,
                Description = "倒下前大約能多扛三倍的傷害。", HealthMultiplier = 2.5, Color = 0xc03030,
            },
            ["speed_cola"] = new()
            {
                Id = "speed_cola", Name = "快速可樂", Cost = 3000,
                Description = "裝填時間約減半。這就是繞得動和死掉的差別。", ReloadMultiplier = 0.5,
                Color = 0x30a040,
            },
            ["double_tap"] = new()
            {
                Id = "double_tap", Name = "雙倍快發", Cost = 2000,
                Description = "射速快三分之一。彈藥也燒得一樣快。", FireRateMultiplier = 1.33,
                Color = 0xd0a020,
            },
            ["stamin_up"] = new()
            {
                Id = "stamin_up", Name = "耐力增強", Cost = 2000,
                Description = "移動明顯更快。空間是唯一不會耗盡的資源。", SpeedMultiplier = 1.18,
                Color = 0x3060c0,
            },
            ["quick_revive"] = new()
            {
                Id = "quick_revive", Name = "快速復活", Cost = 1500,
                Description = "救起隊友更快。獨自作戰時，它會扶你起來一次。", ReviveMultiplier = 0.45,
                SelfRevive = true, Color = 0x40c0d0,
            },
        };

    public static IReadOnlyList<string> PerkIds { get; } = [.. Perks.Keys];

    public static class RoundCurve
    {
        public const int BaseCount = 6;
        public const double CountPerRound = 1.7;
        public const double CountPerPlayer = 0.9;
        public const int MaximumAlive = 24;
        public const int BaseHealth = 150;
        public const int HealthPerRound = 100;
        public const int ExponentialFromRound = 10;
        public const double HealthExponent = 1.14;
        public const double BaseSpeed = 1.6;
        public const double SpeedPerRound = 0.09;
        public const double MaximumSpeed = 4.4;
        public const double BaseSpawnInterval = 2.6;
        public const double MinimumSpawnInterval = 0.35;
        public const double SpawnIntervalDecay = 0.93;
        public const double Intermission = 9;
    }

    public static class Points
    {
        public const int Hit = 10;
        public const int Kill = 60;
        public const int HeadshotKill = 100;
        public const int MeleeKill = 130;
        public const int Revive = 100;
        public const int RoundBonus = 50;
    }

    public static class Down
    {
        public const double BleedOutTime = 45;
        public const double ReviveTime = 5;
        public const double ReviveRadius = 2.2;
        public const double ReviveHealth = 100;
        public const double CrawlSpeedMultiplier = 0.35;
    }

    public static int HealthForRound(int round)
    {
        if (round < RoundCurve.ExponentialFromRound)
            return RoundCurve.BaseHealth + (round - 1) * RoundCurve.HealthPerRound;
        var transition = RoundCurve.BaseHealth +
                         (RoundCurve.ExponentialFromRound - 1) * RoundCurve.HealthPerRound;
        return JsRound(transition * Math.Pow(
            RoundCurve.HealthExponent,
            round - RoundCurve.ExponentialFromRound + 1));
    }

    public static double SpeedForRound(int round) => Math.Min(
        RoundCurve.MaximumSpeed,
        RoundCurve.BaseSpeed + (round - 1) * RoundCurve.SpeedPerRound);

    public static int CountForRound(int round, int players)
    {
        var raw = RoundCurve.BaseCount + (round - 1) * RoundCurve.CountPerRound *
            (1 + (players - 1) * RoundCurve.CountPerPlayer);
        return Math.Max(1, JsRound(raw));
    }

    public static double SpawnIntervalForRound(int round) => Math.Max(
        RoundCurve.MinimumSpawnInterval,
        RoundCurve.BaseSpawnInterval * Math.Pow(RoundCurve.SpawnIntervalDecay, round - 1));

    private static int JsRound(double value) => (int)Math.Floor(value + 0.5d);
}
