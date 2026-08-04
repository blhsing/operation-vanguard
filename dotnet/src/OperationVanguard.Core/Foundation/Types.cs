using System.Text.Json.Serialization;

namespace OperationVanguard.Core;

public enum Team
{
    None = 0,
    Allies = 1,
    Axis = 2,
    Hostile = 3,
}

[Flags]
public enum InputFlag : ushort
{
    None = 0,
    Jump = 1 << 0,
    Crouch = 1 << 1,
    Prone = 1 << 2,
    Sprint = 1 << 3,
    TacticalSprint = 1 << 4,
    Fire = 1 << 5,
    Ads = 1 << 6,
    Reload = 1 << 7,
    Melee = 1 << 8,
    Use = 1 << 9,
    Lethal = 1 << 10,
    Tactical = 1 << 11,
    SwapWeapon = 1 << 12,
    LeanLeft = 1 << 13,
    LeanRight = 1 << 14,
    FieldUpgrade = 1 << 15,
}

public enum Stance
{
    Stand = 0,
    Crouch = 1,
    Prone = 2,
}

public enum MoveState
{
    Idle = 0,
    Walk = 1,
    Sprint = 2,
    TacticalSprint = 3,
    Slide = 4,
    Air = 5,
    Mantle = 6,
}

public enum WeaponSlot
{
    Primary = 0,
    Secondary = 1,
    Lethal = 2,
    Tactical = 3,
    Melee = 4,
}

public enum WeaponAction
{
    Ready = 0,
    Firing = 1,
    Reloading = 2,
    Swapping = 3,
    Melee = 4,
    ThrowingGrenade = 5,
    Mantling = 6,
    Sprinting = 7,
}

/// <summary>Shared campaign/loadout archetype identifiers.</summary>
public enum BotArchetype
{
    [JsonStringEnumMemberName("rifleman")]
    Rifleman = 0,
    [JsonStringEnumMemberName("rusher")]
    Rusher = 1,
    [JsonStringEnumMemberName("sniper")]
    Sniper = 2,
    [JsonStringEnumMemberName("support")]
    Support = 3,
    [JsonStringEnumMemberName("scout")]
    Scout = 4,
}

/// <summary>Stable difficulty identifiers shared by campaign and AI.</summary>
public enum DifficultyId
{
    [JsonStringEnumMemberName("recruit")]
    Recruit = 0,
    [JsonStringEnumMemberName("regular")]
    Regular = 1,
    [JsonStringEnumMemberName("hardened")]
    Hardened = 2,
    [JsonStringEnumMemberName("veteran")]
    Veteran = 3,
}

public sealed class InputCommand
{
    public int Seq { get; set; }
    public int Tick { get; set; }
    public double Dt { get; set; }
    public double MoveForward { get; set; }
    public double MoveRight { get; set; }
    public double Yaw { get; set; }
    public double Pitch { get; set; }
    public int Buttons { get; set; }
    public int KillstreakSlot { get; set; } = -1;
}

public sealed class WeaponState
{
    public string DefId { get; set; } = string.Empty;
    public int AmmoInMag { get; set; }
    public int AmmoReserve { get; set; }
    public List<string> Attachments { get; set; } = [];
    public int ShotsInBurst { get; set; }
    public double RecoilYaw { get; set; }
    public double RecoilPitch { get; set; }
    public double Spread { get; set; }
    public double NextFireTime { get; set; }
    public double Heat { get; set; }
}

public sealed class PlayerState
{
    public int Id { get; set; }
    public int EntityId { get; set; }
    public string Name { get; set; } = string.Empty;
    public Team Team { get; set; }
    public bool IsBot { get; set; }
    public double BotSkill { get; set; }

    public Vec3 Position { get; set; } = new();
    public Vec3 Velocity { get; set; } = new();
    public double Yaw { get; set; }
    public double Pitch { get; set; }
    public double Lean { get; set; }

    public Stance Stance { get; set; }
    public Stance PreviousStance { get; set; }
    public double StanceProgress { get; set; }
    public MoveState MoveState { get; set; }
    public bool OnGround { get; set; }
    public Vec3 GroundNormal { get; set; } = new();
    public double AirTime { get; set; }
    public double FallPeakY { get; set; }
    public double SlideTime { get; set; }
    public double SlideCooldown { get; set; }
    public double TacticalSprintTime { get; set; }
    public double TacticalSprintCooldown { get; set; }
    public double JumpCooldown { get; set; }
    public double JumpBuffer { get; set; }
    public double GroundLockout { get; set; }
    public double MantleTime { get; set; }
    public double MantleDuration { get; set; }
    public Vec3 MantleStart { get; set; } = new();
    public Vec3 MantleEnd { get; set; } = new();
    public double SprintOutTime { get; set; }
    public bool SprintOutPending { get; set; }

    public double Health { get; set; }
    public double MaxHealth { get; set; }
    public double Armor { get; set; }
    public bool Alive { get; set; }
    public double RespawnTimer { get; set; }
    public double TimeSinceDamage { get; set; }
    public int LastAttacker { get; set; }
    public Dictionary<int, double> Damagers { get; set; } = [];

    public WeaponSlot ActiveSlot { get; set; }
    public List<WeaponState> Weapons { get; set; } = [];
    public double AdsProgress { get; set; }
    public bool IsAds { get; set; }
    public WeaponAction Action { get; set; }
    public double ActionTimer { get; set; }
    public bool TriggerHeld { get; set; }

    public int LethalCount { get; set; }
    public int TacticalCount { get; set; }
    public double CookTime { get; set; }

    public List<string> Perks { get; set; } = [];
    public string FieldUpgrade { get; set; } = string.Empty;
    public double FieldUpgradeCharge { get; set; }
    public List<string> Killstreaks { get; set; } = [];
    public List<string> KillstreakInventory { get; set; } = [];

    public double FlashAmount { get; set; }
    public double ConcussionAmount { get; set; }
    public double EmpTime { get; set; }
    public double MarkedUntil { get; set; }

    public int Kills { get; set; }
    public int Deaths { get; set; }
    public int Assists { get; set; }
    public double Score { get; set; }
    public int Killstreak { get; set; }
    public int BestKillstreak { get; set; }
    public double StreakScore { get; set; }
    public int Captures { get; set; }
    public int Defends { get; set; }
    public int Plants { get; set; }
    public int Defuses { get; set; }
    public double DamageDealt { get; set; }
    public int Headshots { get; set; }
    public int DeathStreak { get; set; }

    public int LastProcessedInput { get; set; }
    public double Ping { get; set; }
    public bool Connected { get; set; }
    public bool Spectating { get; set; }
    public int SpectateTarget { get; set; }
}

public enum ProjectileKind
{
    Frag = 0,
    Semtex = 1,
    Molotov = 2,
    ThermiteStick = 3,
    Flashbang = 4,
    StunGrenade = 5,
    SmokeGrenade = 6,
    Rocket = 7,
    GrenadeLauncher = 8,
    C4 = 9,
    ClaymoreProjectile = 10,
    ThrowingKnife = 11,
}

public sealed class ProjectileState
{
    public int Id { get; set; }
    public ProjectileKind Kind { get; set; }
    public int Owner { get; set; }
    public Team Team { get; set; }
    public Vec3 Position { get; set; } = new();
    public Vec3 Velocity { get; set; } = new();
    public double Fuse { get; set; }
    public bool Stuck { get; set; }
    public int StuckTo { get; set; }
    public int Bounces { get; set; }
    public double Age { get; set; }
    public bool Armed { get; set; }
}

public enum DeployableKind
{
    Claymore = 0,
    ProximityMine = 1,
    C4Placed = 2,
    TacticalInsertion = 3,
    TrophySystem = 4,
    DeployableCover = 5,
    AmmoBox = 6,
    SentryGun = 7,
    CarePackage = 8,
}

public sealed class DeployableState
{
    public int Id { get; set; }
    public DeployableKind Kind { get; set; }
    public int Owner { get; set; }
    public Team Team { get; set; }
    public Vec3 Position { get; set; } = new();
    public double Yaw { get; set; }
    public double Health { get; set; }
    public double ArmTime { get; set; }
    public int Charges { get; set; }
    public double Age { get; set; }
    public string Payload { get; set; } = string.Empty;
}

public enum KillstreakVehicleKind
{
    UAV = 0,
    CounterUAV = 1,
    Chopper = 2,
    VTOL = 3,
    AC130 = 4,
    PredatorMissile = 5,
    Airstrike = 6,
    ClusterStrike = 7,
}

public sealed class KillstreakEntityState
{
    public int Id { get; set; }
    public KillstreakVehicleKind Kind { get; set; }
    public int Owner { get; set; }
    public Team Team { get; set; }
    public Vec3 Position { get; set; } = new();
    public Vec3 Velocity { get; set; } = new();
    public double Yaw { get; set; }
    public double Pitch { get; set; }
    public double Health { get; set; }
    public double TimeRemaining { get; set; }
    public bool Controlled { get; set; }
    public double PathIndex { get; set; }
}

public enum SimEventType
{
    [JsonStringEnumMemberName("shot")]
    Shot = 0,
    [JsonStringEnumMemberName("impact")]
    Impact = 1,
    [JsonStringEnumMemberName("hit")]
    Hit = 2,
    [JsonStringEnumMemberName("kill")]
    Kill = 3,
    [JsonStringEnumMemberName("damage")]
    Damage = 4,
    [JsonStringEnumMemberName("reload")]
    Reload = 5,
    [JsonStringEnumMemberName("reload_complete")]
    ReloadComplete = 6,
    [JsonStringEnumMemberName("weapon_swap")]
    WeaponSwap = 7,
    [JsonStringEnumMemberName("melee")]
    Melee = 8,
    [JsonStringEnumMemberName("footstep")]
    Footstep = 9,
    [JsonStringEnumMemberName("jump")]
    Jump = 10,
    [JsonStringEnumMemberName("land")]
    Land = 11,
    [JsonStringEnumMemberName("slide")]
    Slide = 12,
    [JsonStringEnumMemberName("mantle")]
    Mantle = 13,
    [JsonStringEnumMemberName("spawn")]
    Spawn = 14,
    [JsonStringEnumMemberName("death")]
    Death = 15,
    [JsonStringEnumMemberName("projectile_thrown")]
    ProjectileThrown = 16,
    [JsonStringEnumMemberName("explosion")]
    Explosion = 17,
    [JsonStringEnumMemberName("flash")]
    Flash = 18,
    [JsonStringEnumMemberName("objective_captured")]
    ObjectiveCaptured = 19,
    [JsonStringEnumMemberName("objective_contested")]
    ObjectiveContested = 20,
    [JsonStringEnumMemberName("objective_neutralized")]
    ObjectiveNeutralized = 21,
    [JsonStringEnumMemberName("bomb_planted")]
    BombPlanted = 22,
    [JsonStringEnumMemberName("bomb_defused")]
    BombDefused = 23,
    [JsonStringEnumMemberName("killstreak_earned")]
    KillstreakEarned = 24,
    [JsonStringEnumMemberName("killstreak_called")]
    KillstreakCalled = 25,
    [JsonStringEnumMemberName("killstreak_destroyed")]
    KillstreakDestroyed = 26,
    [JsonStringEnumMemberName("score_awarded")]
    ScoreAwarded = 27,
    [JsonStringEnumMemberName("medal_earned")]
    MedalEarned = 28,
    [JsonStringEnumMemberName("match_state_changed")]
    MatchStateChanged = 29,
    [JsonStringEnumMemberName("round_start")]
    RoundStart = 30,
    [JsonStringEnumMemberName("round_end")]
    RoundEnd = 31,
    [JsonStringEnumMemberName("chat")]
    Chat = 32,
    [JsonStringEnumMemberName("announce")]
    Announce = 33,
    [JsonStringEnumMemberName("tag_collected")]
    TagCollected = 34,
    [JsonStringEnumMemberName("deployable_placed")]
    DeployablePlaced = 35,
    [JsonStringEnumMemberName("deployable_destroyed")]
    DeployableDestroyed = 36,
}

public abstract class SimEvent
{
    public SimEventType Type { get; set; }
    public int Tick { get; set; }

    protected SimEvent(SimEventType type)
    {
        Type = type;
    }
}

public sealed class ShotEvent : SimEvent
{
    public ShotEvent() : base(SimEventType.Shot) { }
    public int Player { get; set; }
    public string WeaponId { get; set; } = string.Empty;
    public Vec3 Origin { get; set; } = new();
    public Vec3 Direction { get; set; } = new();
    public bool Suppressed { get; set; }
    public int ShotIndex { get; set; }
}

public sealed class ImpactEvent : SimEvent
{
    public ImpactEvent() : base(SimEventType.Impact) { }
    public Vec3 Position { get; set; } = new();
    public Vec3 Normal { get; set; } = new();
    public SurfaceType Surface { get; set; }
    public int Shooter { get; set; }
    public bool Penetrated { get; set; }
}

public sealed class HitEvent : SimEvent
{
    public HitEvent() : base(SimEventType.Hit) { }
    public int Attacker { get; set; }
    public int Victim { get; set; }
    public HitLocation Location { get; set; }
    public double Damage { get; set; }
    public bool Lethal { get; set; }
    public Vec3 Position { get; set; } = new();
    public string WeaponId { get; set; } = string.Empty;
}

public sealed class DamageEvent : SimEvent
{
    public DamageEvent() : base(SimEventType.Damage) { }
    public int Victim { get; set; }
    public int Attacker { get; set; }
    public double Amount { get; set; }
    public Vec3 Direction { get; set; } = new();
    public DamageCause Cause { get; set; }
}

public sealed class KillEvent : SimEvent
{
    public KillEvent() : base(SimEventType.Kill) { }
    public int Killer { get; set; }
    public int Victim { get; set; }
    public List<int> Assists { get; set; } = [];
    public string WeaponId { get; set; } = string.Empty;
    public bool Headshot { get; set; }
    public DamageCause Cause { get; set; }
    public double Distance { get; set; }
    public bool KillerWasLowHealth { get; set; }
    public Vec3 VictimPosition { get; set; } = new();
    public Vec3 KillerPosition { get; set; } = new();
}

public sealed class ExplosionEvent : SimEvent
{
    public ExplosionEvent() : base(SimEventType.Explosion) { }
    public Vec3 Position { get; set; } = new();
    public double Radius { get; set; }
    public int Owner { get; set; }
    /// <summary>ProjectileKind or the string "killstreak", matching the TS union.</summary>
    public object Kind { get; set; } = ProjectileKind.Frag;
}

public sealed class FootstepEvent : SimEvent
{
    public FootstepEvent() : base(SimEventType.Footstep) { }
    public int Player { get; set; }
    public Vec3 Position { get; set; } = new();
    public SurfaceType Surface { get; set; }
    public bool Loud { get; set; }
}

public sealed class ScoreEvent : SimEvent
{
    public ScoreEvent() : base(SimEventType.ScoreAwarded) { }
    public int Player { get; set; }
    public double Amount { get; set; }
    public string Reason { get; set; } = string.Empty;
}

public sealed class AnnounceEvent : SimEvent
{
    public AnnounceEvent() : base(SimEventType.Announce) { }
    public Team Team { get; set; }
    public string Line { get; set; } = string.Empty;
}

public sealed class GenericSimEvent : SimEvent
{
    public GenericSimEvent() : this(SimEventType.MatchStateChanged) { }
    public GenericSimEvent(SimEventType type) : base(type) { }
    public int? Player { get; set; }
    public Team? Team { get; set; }
    public Vec3? Position { get; set; }
    public Dictionary<string, object?>? Data { get; set; }
}

public enum DamageCause
{
    Bullet = 0,
    Explosion = 1,
    Melee = 2,
    Fall = 3,
    Fire = 4,
    Killstreak = 5,
    Vehicle = 6,
    Zombie = 7,
    Suicide = 8,
    OutOfBounds = 9,
    Sentry = 10,
    Environment = 11,
}

public sealed class DamageInfo
{
    public double Amount { get; set; }
    public int Attacker { get; set; }
    public int Victim { get; set; }
    public DamageCause Cause { get; set; }
    public string WeaponId { get; set; } = string.Empty;
    public HitLocation Location { get; set; }
    public Vec3 Position { get; set; } = new();
    public Vec3 Direction { get; set; } = new();
    public double Distance { get; set; }
    public bool IgnoreArmor { get; set; }
}

public enum SurfaceType
{
    Concrete = 0,
    Metal = 1,
    Wood = 2,
    Dirt = 3,
    Grass = 4,
    Sand = 5,
    Water = 6,
    Glass = 7,
    Foliage = 8,
    Flesh = 9,
    Carpet = 10,
    Gravel = 11,
    Snow = 12,
    Tile = 13,
    Plastic = 14,
    Brick = 15,
}

public sealed class SurfaceProperties
{
    public double Penetration { get; set; }
    public double DamageRetention { get; set; }
    public double FootstepVolume { get; set; }
    public bool Breakable { get; set; }
}

public enum MatchPhase
{
    Warmup = 0,
    Countdown = 1,
    Live = 2,
    RoundEnd = 3,
    Overtime = 4,
    MatchEnd = 5,
}

public sealed class TeamScore
{
    public Team Team { get; set; }
    public double Score { get; set; }
    public int RoundsWon { get; set; }
}

public sealed class MatchState
{
    public MatchPhase Phase { get; set; }
    public double TimeRemaining { get; set; }
    public int Round { get; set; }
    public List<TeamScore> Scores { get; set; } = [];
    public Dictionary<string, object?> ModeState { get; set; } = [];
    public Team? Winner { get; set; }
}

public sealed class WorldState
{
    public int Tick { get; set; }
    public double Time { get; set; }
    public Dictionary<int, PlayerState> Players { get; set; } = [];
    public Dictionary<int, ProjectileState> Projectiles { get; set; } = [];
    public Dictionary<int, DeployableState> Deployables { get; set; } = [];
    public Dictionary<int, KillstreakEntityState> KillstreakEntities { get; set; } = [];
    public MatchState Match { get; set; } = new();
    public string MapId { get; set; } = string.Empty;
    public string ModeId { get; set; } = string.Empty;
    public int NextEntityId { get; set; }
    public uint RngState { get; set; }
}

public static class SimulationTypes
{
    public const int NullEntity = 0;

    public static bool IsEnemyTeam(Team a, Team b)
    {
        if (a == Team.Hostile || b == Team.Hostile)
        {
            return a != b;
        }

        if (a == Team.None || b == Team.None)
        {
            return true;
        }

        return a != b;
    }

    public static Team OpposingTeam(Team team) => team == Team.Allies ? Team.Axis : Team.Allies;

    public static bool HasFlag(int buttons, InputFlag flag) => (buttons & (int)flag) != 0;

    public static InputCommand CreateEmptyInput() => new();
}
