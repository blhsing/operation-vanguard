using System.Text.Json.Serialization;

namespace OperationVanguard.Core;

[JsonConverter(typeof(JsonStringEnumConverter<WeaponClass>))]
public enum WeaponClass
{
    [JsonStringEnumMemberName("assault_rifle")] AssaultRifle,
    [JsonStringEnumMemberName("smg")] SubmachineGun,
    [JsonStringEnumMemberName("lmg")] LightMachineGun,
    [JsonStringEnumMemberName("sniper")] SniperRifle,
    [JsonStringEnumMemberName("marksman")] MarksmanRifle,
    [JsonStringEnumMemberName("shotgun")] Shotgun,
    [JsonStringEnumMemberName("pistol")] Pistol,
    [JsonStringEnumMemberName("launcher")] Launcher,
    [JsonStringEnumMemberName("melee")] Melee,
    [JsonStringEnumMemberName("special")] Special,
}

[JsonConverter(typeof(JsonStringEnumConverter<FireMode>))]
public enum FireMode
{
    [JsonStringEnumMemberName("auto")] Auto,
    [JsonStringEnumMemberName("semi")] Semi,
    [JsonStringEnumMemberName("burst")] Burst,
    [JsonStringEnumMemberName("bolt")] BoltAction,
    [JsonStringEnumMemberName("swing")] Swing,
}

public enum AttachmentSlot
{
    Muzzle = 0,
    Barrel = 1,
    Optic = 2,
    Underbarrel = 3,
    Magazine = 4,
    Stock = 5,
    RearGrip = 6,
    Laser = 7,
}

[JsonConverter(typeof(JsonStringEnumConverter<WeaponTrait>))]
public enum WeaponTrait
{
    [JsonStringEnumMemberName("one_shot_upper_torso")] OneShotUpperTorso,
    [JsonStringEnumMemberName("explosive")] Explosive,
    [JsonStringEnumMemberName("no_akimbo")] NoAkimbo,
    [JsonStringEnumMemberName("rechamber")] Rechamber,
    [JsonStringEnumMemberName("shell_reload")] ShellReload,
    [JsonStringEnumMemberName("steady_aim")] SteadyAim,
    [JsonStringEnumMemberName("air_lock_on")] AirLockOn,
    [JsonStringEnumMemberName("no_falloff")] NoFalloff,
    [JsonStringEnumMemberName("always_suppressed")] AlwaysSuppressed,
}

public sealed class DamageStop
{
    public double Distance { get; set; }
    public double Damage { get; set; }

    public DamageStop Clone() => new() { Distance = Distance, Damage = Damage };
}

public sealed class RecoilStep
{
    public double Pitch { get; set; }
    public double Yaw { get; set; }

    public RecoilStep Clone() => new() { Pitch = Pitch, Yaw = Yaw };
}

public sealed class RecoilProfile
{
    public List<RecoilStep> Pattern { get; set; } = [];
    public double RandomPitch { get; set; }
    public double RandomYaw { get; set; }
    public double RecoverySpeed { get; set; }
    public double RecoveryFraction { get; set; }
    public double ViewKickMultiplier { get; set; }
    public double CameraShake { get; set; }

    public RecoilProfile Clone() => new()
    {
        Pattern = Pattern.Select(step => step.Clone()).ToList(),
        RandomPitch = RandomPitch,
        RandomYaw = RandomYaw,
        RecoverySpeed = RecoverySpeed,
        RecoveryFraction = RecoveryFraction,
        ViewKickMultiplier = ViewKickMultiplier,
        CameraShake = CameraShake,
    };
}

public sealed class SpreadProfile
{
    public double HipMin { get; set; }
    public double HipMax { get; set; }
    public double AdsMin { get; set; }
    public double AdsMax { get; set; }
    public double PerShot { get; set; }
    public double Recovery { get; set; }
    public double MovingMultiplier { get; set; }
    public double JumpingMultiplier { get; set; }
    public double CrouchMultiplier { get; set; }
    public double ProneMultiplier { get; set; }

    public SpreadProfile Clone() => (SpreadProfile)MemberwiseClone();
}

public sealed class WeaponHandling
{
    public double AdsTime { get; set; }
    public double SprintOutTime { get; set; }
    public double DrawTime { get; set; }
    public double HolsterTime { get; set; }
    public double ReloadTime { get; set; }
    public double ReloadEmptyTime { get; set; }
    public double ReloadAmmoTime { get; set; }
    public double ReloadEmptyAmmoTime { get; set; }
    public double MovementSpeedMultiplier { get; set; }
    public double AdsSpeedMultiplier { get; set; }
    public double SwayAmount { get; set; }
    public double SwaySpeed { get; set; }

    public WeaponHandling Clone() => (WeaponHandling)MemberwiseClone();
}

public sealed class WeaponAudioDef
{
    public double BodyFreq { get; set; }
    public double CrackDuration { get; set; }
    public double Boom { get; set; }
    public double Mech { get; set; }
    public double Tail { get; set; }
    public bool Suppressed { get; set; }

    public WeaponAudioDef Clone() => (WeaponAudioDef)MemberwiseClone();
}

public sealed class WeaponModelDef
{
    public double Length { get; set; }
    public int Color { get; set; }
    public int AccentColor { get; set; }
    public string MagStyle { get; set; } = "none";
    public string StockStyle { get; set; } = "none";
    public bool HasCarryHandle { get; set; }
    public double BarrelLength { get; set; }
    public double SightHeight { get; set; }

    public WeaponModelDef Clone() => (WeaponModelDef)MemberwiseClone();
}

public sealed class WeaponDef
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string ShortName { get; set; } = "";
    public WeaponClass Class { get; set; }
    public string Description { get; set; } = "";
    public FireMode FireMode { get; set; }
    public double Rpm { get; set; }
    public int BurstCount { get; set; }
    public double BurstDelay { get; set; }
    public int MagSize { get; set; }
    public int StartingReserve { get; set; }
    public int MaxReserve { get; set; }
    public int Pellets { get; set; }
    public List<DamageStop> Damage { get; set; } = [];
    public double VehicleDamageMultiplier { get; set; }
    public double Penetration { get; set; }
    public double MuzzleVelocity { get; set; }
    public double BulletGravity { get; set; }
    public RecoilProfile Recoil { get; set; } = new();
    public SpreadProfile Spread { get; set; } = new();
    public WeaponHandling Handling { get; set; } = new();
    public List<AttachmentSlot> AttachmentSlots { get; set; } = [];
    public int UnlockLevel { get; set; }
    public WeaponAudioDef Audio { get; set; } = new();
    public WeaponModelDef Model { get; set; } = new();
    public double AdsZoom { get; set; }
    public bool Scoped { get; set; }
    public double ScopeFocusTime { get; set; }
    public double MeleeDamage { get; set; }
    public List<WeaponTrait> Traits { get; set; } = [];

    public WeaponDef Clone() => new()
    {
        Id = Id,
        Name = Name,
        ShortName = ShortName,
        Class = Class,
        Description = Description,
        FireMode = FireMode,
        Rpm = Rpm,
        BurstCount = BurstCount,
        BurstDelay = BurstDelay,
        MagSize = MagSize,
        StartingReserve = StartingReserve,
        MaxReserve = MaxReserve,
        Pellets = Pellets,
        Damage = Damage.Select(stop => stop.Clone()).ToList(),
        VehicleDamageMultiplier = VehicleDamageMultiplier,
        Penetration = Penetration,
        MuzzleVelocity = MuzzleVelocity,
        BulletGravity = BulletGravity,
        Recoil = Recoil.Clone(),
        Spread = Spread.Clone(),
        Handling = Handling.Clone(),
        AttachmentSlots = [.. AttachmentSlots],
        UnlockLevel = UnlockLevel,
        Audio = Audio.Clone(),
        Model = Model.Clone(),
        AdsZoom = AdsZoom,
        Scoped = Scoped,
        ScopeFocusTime = ScopeFocusTime,
        MeleeDamage = MeleeDamage,
        Traits = [.. Traits],
    };
}

public static class WeaponMath
{
    public static double FireInterval(WeaponDef def) => def.Rpm > 0 ? 60 / def.Rpm : 0;

    public static double DamageAtRange(IReadOnlyList<DamageStop> stops, double distance)
    {
        if (stops.Count == 0) return 0;
        var first = stops[0];
        if (distance <= first.Distance) return first.Damage;

        for (var i = 1; i < stops.Count; i++)
        {
            var previous = stops[i - 1];
            var current = stops[i];
            if (distance > current.Distance) continue;
            var span = current.Distance - previous.Distance;
            if (span <= 0) return current.Damage;
            var t = (distance - previous.Distance) / span;
            return previous.Damage + (current.Damage - previous.Damage) * t;
        }

        return stops[^1].Damage;
    }

    public static double ShotsToKill(
        IReadOnlyList<DamageStop> stops,
        double distance,
        double health,
        double multiplier = 1)
    {
        var damage = DamageAtRange(stops, distance) * multiplier;
        return damage <= 0 ? double.PositiveInfinity : Math.Ceiling(health / damage);
    }

    public static double TimeToKill(WeaponDef def, double distance, double health, double multiplier = 1)
    {
        var perShot = DamageAtRange(def.Damage, distance) * multiplier * Math.Max(1, def.Pellets);
        if (perShot <= 0) return double.PositiveInfinity;
        var shots = (int)Math.Ceiling(health / perShot);
        if (shots <= 1) return 0;

        var interval = FireInterval(def);
        if (def.FireMode == FireMode.Burst && def.BurstCount > 1)
        {
            var fullBursts = (shots - 1) / def.BurstCount;
            var remainder = (shots - 1) % def.BurstCount;
            return fullBursts * ((def.BurstCount - 1) * interval + def.BurstDelay)
                   + remainder * interval;
        }
        return (shots - 1) * interval;
    }
}
