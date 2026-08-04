using System.Text.Json.Serialization;

namespace OperationVanguard.Core;

/// <summary>Hit locations in the same declaration order as the TypeScript multiplier table.</summary>
public enum HitLocation
{
    [JsonStringEnumMemberName("head")]
    Head = 0,
    [JsonStringEnumMemberName("neck")]
    Neck = 1,
    [JsonStringEnumMemberName("chest")]
    Chest = 2,
    [JsonStringEnumMemberName("stomach")]
    Stomach = 3,
    [JsonStringEnumMemberName("upperArm")]
    UpperArm = 4,
    [JsonStringEnumMemberName("lowerArm")]
    LowerArm = 5,
    [JsonStringEnumMemberName("upperLeg")]
    UpperLeg = 6,
    [JsonStringEnumMemberName("lowerLeg")]
    LowerLeg = 7,
    [JsonStringEnumMemberName("foot")]
    Foot = 8,
}

/// <summary>
/// Shared tuning constants. Units are metres, seconds, and radians.
/// Nested classes retain the object grouping used by constants.ts.
/// </summary>
public static class GameConstants
{
    public const int TickRate = 64;
    public const double TickDt = 1d / TickRate;
    public const double TickMs = 1000d / TickRate;
    public const int SnapshotRate = 32;
    public const double SnapshotDt = 1d / SnapshotRate;
    public const double InterpolationDelay = SnapshotDt * 2d;
    public const int MaxTicksPerFrame = 8;
    public const int InputBufferSize = 128;
    public const double MaxLagCompensation = 0.25d;
    public const int LagCompensationHistoryTicks = 20;

    public const double PlayerRadius = 0.36d;
    public const double MaxTraceDistance = 400d;
    public const double DecalLifetime = 22d;
    public const int MaxDecals = 256;

    public const double XpPerScore = 1d;
    public const int MaxRank = 55;
    public const int MaxPrestige = 10;
    public const int MaxWeaponLevel = 30;
    public const int MaxPlayers = 24;
    public const int DefaultTeamSize = 6;
    public const string DefaultServerUrl = "ws://127.0.0.1:8790";

    public static class StanceHeight
    {
        public const double Stand = 1.8d;
        public const double Crouch = 1.15d;
        public const double Prone = 0.55d;

        public static double For(Stance stance) => stance switch
        {
            Stance.Stand => Stand,
            Stance.Crouch => Crouch,
            Stance.Prone => Prone,
            _ => Stand,
        };
    }

    public static class EyeHeight
    {
        public const double Stand = 1.62d;
        public const double Crouch = 1d;
        public const double Prone = 0.42d;

        public static double For(Stance stance) => stance switch
        {
            Stance.Stand => Stand,
            Stance.Crouch => Crouch,
            Stance.Prone => Prone,
            _ => Stand,
        };
    }

    public static class StanceTransition
    {
        public const double StandToCrouch = 0.2d;
        public const double CrouchToStand = 0.22d;
        public const double CrouchToProne = 0.35d;
        public const double ProneToCrouch = 0.45d;
        public const double StandToProne = 0.5d;
        public const double ProneToStand = 0.6d;
    }

    public static class Move
    {
        public const double BaseSpeed = 4.6d;
        public const double StrafeMultiplier = 0.88d;
        public const double BackMultiplier = 0.76d;
        public const double SprintMultiplier = 1.52d;
        public const double TacticalSprintMultiplier = 1.92d;
        public const double TacticalSprintDuration = 2.4d;
        public const double TacticalSprintCooldown = 6d;
        public const double CrouchMultiplier = 0.52d;
        public const double ProneMultiplier = 0.22d;
        public const double AdsMultiplier = 0.42d;
        public const double GroundAcceleration = 62d;
        public const double GroundFriction = 52d;
        public const double AirAcceleration = 11d;
        public const double AirFriction = 0.2d;
        public const double MaximumAirSpeedGain = 1.4d;
        public const double Gravity = 21.5d;
        public const double JumpVelocity = 6.1d;
        public const double CoyoteTime = 0.09d;
        public const double JumpBufferTime = 0.12d;
        public const double JumpCooldown = 0.28d;
        public const double MaximumSlopeAngle = 48d * (Math.PI / 180d);
        public const double StepHeight = 0.42d;
        public const double GroundSnapDistance = 0.32d;
        public const double MaximumFallSpeed = 55d;
        public const double SafeFallHeight = 4.2d;
        public const double LethalFallHeight = 13d;
        public const double MaximumFallDamage = 100d;
    }

    public static class Slide
    {
        public const double MinimumSpeed = 5.2d;
        public const double BoostSpeed = 8.4d;
        public const double Duration = 0.85d;
        public const double Friction = 6.4d;
        public const double Cooldown = 0.55d;
        public const double SlopeAcceleration = 9d;
        public const double CameraRoll = 0.12d;
    }

    public static class Mantle
    {
        public const double MinimumHeight = 0.42d;
        public const double MaximumHeight = 2.05d;
        public const double Reach = 0.85d;
        public const double Clearance = 0.95d;
        public const double MinimumDuration = 0.34d;
        public const double MaximumDuration = 0.78d;
    }

    public static class Lean
    {
        public const double MaximumAngle = 22d * (Math.PI / 180d);
        public const double MaximumOffset = 0.42d;
        public const double Speed = 7.5d;
    }

    public static class Health
    {
        public const double Maximum = 100d;
        public const double RegenerationDelay = 5d;
        public const double RegenerationRate = 40d;
        public const double RegenerationInterruptDelay = 2.5d;
    }

    public static class Armor
    {
        public const int MaximumPlates = 3;
        public const double PerPlate = 50d;
        public const double PlateApplyTime = 1.6d;
    }

    public static class HitMultiplier
    {
        public const double Head = 1.8d;
        public const double Neck = 1.5d;
        public const double Chest = 1d;
        public const double Stomach = 1.05d;
        public const double UpperArm = 0.9d;
        public const double LowerArm = 0.85d;
        public const double UpperLeg = 0.9d;
        public const double LowerLeg = 0.8d;
        public const double Foot = 0.75d;

        public static double For(HitLocation location) => location switch
        {
            HitLocation.Head => Head,
            HitLocation.Neck => Neck,
            HitLocation.Chest => Chest,
            HitLocation.Stomach => Stomach,
            HitLocation.UpperArm => UpperArm,
            HitLocation.LowerArm => LowerArm,
            HitLocation.UpperLeg => UpperLeg,
            HitLocation.LowerLeg => LowerLeg,
            HitLocation.Foot => Foot,
            _ => Chest,
        };
    }

    public static class Score
    {
        public const int Kill = 100;
        public const int Assist = 50;
        public const int HeadshotBonus = 25;
        public const int LongshotBonus = 50;
        public const int KillstreakKill = 25;
        public const int ObjectiveCapture = 200;
        public const int ObjectiveDefend = 100;
        public const int ObjectiveAssist = 75;
        public const int PlantBomb = 250;
        public const int DefuseBomb = 250;
        public const int ConfirmKill = 50;
        public const int DenyKill = 50;
        public const int Revenge = 50;
        public const int FirstBlood = 100;
        public const int DestroyKillstreak = 150;
        public const int SaveTeammate = 75;
    }

    public static class Match
    {
        public const double WarmupDuration = 8d;
        public const double OutroDuration = 14d;
        public const double KillcamDuration = 4d;
        public const double RespawnDelay = 4d;
        public const double MaximumRespawnDelay = 5d;
    }

    public static class Spawn
    {
        public const double EnemyDangerRadius = 18d;
        public const double EnemyHardBanRadius = 8d;
        public const double FriendlyAttractRadius = 22d;
        public const double EnemyViewConeHalfAngle = 55d * (Math.PI / 180d);
        public const double EnemyViewConePenalty = 900d;
        public const double RecentUseWindow = 12d;
        public const double RecentUsePenalty = 320d;
        public const double RecentDeathRadius = 10d;
        public const double RecentDeathPenalty = 260d;
        public const double DangerZonePenalty = 1400d;
    }

    public static class Perception
    {
        public const double GunshotRadius = 90d;
        public const double SuppressedGunshotRadius = 28d;
        public const double FootstepRadiusWalk = 16d;
        public const double FootstepRadiusSprint = 26d;
        public const double FootstepRadiusCrouch = 6d;
        public const double ReloadRadius = 9d;
        public const double ExplosionRadius = 140d;
    }

    public static class Network
    {
        public const int ProtocolVersion = 8;
        public const int DefaultPort = 8790;
        public const int SnapshotRate = 20;
        public const double InterpolationDelay = 2d / SnapshotRate;
        public const double TimeoutSeconds = 20d;
        public const double HeartbeatInterval = 3d;
        public const double MaximumInputDt = TickDt * 3d;
        public const int MaximumInputsPerPacket = 16;
        public const double InterestRadius = 160d;
        public const int MaximumNameLength = 20;
        public const int MaximumChatLength = 160;
        public const string DefaultUrl = DefaultServerUrl;
    }

    public static class Render
    {
        public const double DefaultFov = 80d;
        public const double MinimumFov = 65d;
        public const double MaximumFov = 120d;
        public const double NearPlane = 0.05d;
        public const double FarPlane = 800d;
        public const double ViewmodelFov = 62d;
        public const double ViewmodelNear = 0.01d;
        public const double ViewmodelFar = 12d;
        public const int ShadowMapSize = 2048;
        public const int MaximumParticles = 4000;
    }

    public static class TeamColors
    {
        public const uint Allies = 0x4a9effu;
        public const uint Axis = 0xff5a4au;
        public const uint Neutral = 0xc8c8c8u;
        public const uint Friendly = 0x5ce65cu;
        public const uint Enemy = 0xff3b30u;
    }
}
