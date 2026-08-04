namespace OperationVanguard.Core;

/// <summary>An axis-aligned box in world space.</summary>
public sealed record Zone(Vec3 Center, Vec3 Size);

/// <summary>
/// The small, data-authored trigger vocabulary understood by the campaign runtime.
/// Kind intentionally retains the exact TypeScript content identifier.
/// </summary>
public abstract record Trigger(string Kind);

public sealed record ReachTrigger(Zone Zone) : Trigger("reach");

public sealed record EliminateTrigger(int Count) : Trigger("eliminate");

public sealed record ClearTrigger() : Trigger("clear");

public sealed record SurviveTrigger(double Seconds) : Trigger("survive");

public sealed record HoldTrigger(Zone Zone, double Seconds) : Trigger("hold");

public sealed record InteractTrigger(Zone Zone, double Seconds, string Verb) : Trigger("interact");

public sealed record EscortTrigger(string Ally, Zone Zone) : Trigger("escort");

/// <summary>A group of hostiles that arrives together.</summary>
public sealed class Wave
{
    public required Vec3 Spawn { get; init; }

    public int Count { get; init; }

    /// <summary>Seconds between arrivals.</summary>
    public double Interval { get; init; }

    /// <summary>Seconds after activation before the first arrival.</summary>
    public double? Delay { get; init; }

    public IReadOnlyList<BotArchetype>? Archetypes { get; init; }

    public bool Endless { get; init; }

    /// <summary>Where the hostile holds when it has nobody to shoot at.</summary>
    public Vec3? Post { get; init; }
}

public sealed class Objective
{
    public required string Id { get; init; }

    public required string Label { get; init; }

    public required Trigger Trigger { get; init; }

    public IReadOnlyList<string>? After { get; init; }

    public IReadOnlyList<Wave>? Waves { get; init; }

    public string? Line { get; init; }

    public bool Checkpoint { get; init; }

    public double? TimeLimit { get; init; }

    public bool ReapOnComplete { get; init; }
}

public sealed class AllySpec
{
    public required string Id { get; init; }

    public required string Name { get; init; }

    public required Vec3 Spawn { get; init; }

    public BotArchetype Archetype { get; init; }

    public bool Essential { get; init; }
}

public sealed class MissionDef
{
    public required string Id { get; init; }

    public required string Name { get; init; }

    public required string MapId { get; init; }

    public required string Brief { get; init; }

    public required MissionInsertion Insertion { get; init; }

    public DifficultyId Difficulty { get; init; }

    public required IReadOnlyList<AllySpec> Allies { get; init; }

    public IReadOnlyList<Wave>? Garrison { get; init; }

    public required IReadOnlyList<Objective> Objectives { get; init; }

    public required string Outro { get; init; }
}

public sealed record MissionInsertion(Vec3 Position, double Yaw);

public enum MissionPhase
{
    Briefing,
    Active,
    Failed,
    Complete,
}

public sealed class MissionState
{
    public MissionPhase Phase { get; set; }

    public FailureReason Failure { get; set; }

    public double Elapsed { get; set; }

    public double TransitionTimer { get; set; }

    public required IDictionary<string, ObjectiveState> Objectives { get; init; }

    public int Restarts { get; set; }

    public string LastLine { get; set; } = string.Empty;
}

public sealed class ObjectiveState
{
    public required string Id { get; init; }

    public bool Active { get; set; }

    public bool Complete { get; set; }

    public double Elapsed { get; set; }

    public double Progress { get; set; }

    public int Kills { get; set; }
}

/// <summary>Durable, version-independent campaign progress captured by the native client.</summary>
public sealed class CampaignSaveSnapshot
{
    public required string MissionId { get; init; }
    public double Elapsed { get; init; }
    public int Restarts { get; init; }
    public string LastLine { get; init; } = string.Empty;
    public required Vec3 Position { get; init; }
    public double Yaw { get; init; }
    public double Pitch { get; init; }
    public double Health { get; init; }
    public double Armor { get; init; }
    public WeaponSlot ActiveSlot { get; init; }
    public int LethalCount { get; init; }
    public int TacticalCount { get; init; }
    public double FieldUpgradeCharge { get; init; }
    public required IReadOnlyList<CampaignWeaponSave> Weapons { get; init; }
    public required IReadOnlyDictionary<string, CampaignObjectiveSave> Objectives { get; init; }
}

public sealed class CampaignWeaponSave
{
    public required string DefId { get; init; }
    public int AmmoInMag { get; init; }
    public int AmmoReserve { get; init; }
    public required IReadOnlyList<string> Attachments { get; init; }
}

public sealed class CampaignObjectiveSave
{
    public required string Id { get; init; }
    public bool Active { get; init; }
    public bool Complete { get; init; }
    public double Elapsed { get; init; }
    public double Progress { get; init; }
    public int Kills { get; init; }
}

public sealed record CampaignHudObjective(string Label, double Progress, Vec3? Position);

public enum FailureReason
{
    None,
    PlayerDown,
    AllyLost,
    OutOfTime,
}

/// <summary>Campaign tuning values, preserved exactly from campaign-types.ts.</summary>
public static class CampaignTuning
{
    public const double StalemateRelease = 40;
    public const double BriefingTime = 4;
    public const double RestartDelay = 2.5;
    public const double FollowDistance = 11;
    public const double LeashDistance = 26;
    public const double AllyRecovery = 12;
    public const int MaxConcurrentHostiles = 6;
    public const double CorpseLinger = 2.0;
}

/// <summary>Exact string identifiers used by the original authored content.</summary>
public static class CampaignContentIds
{
    public static string GetBotArchetypeId(BotArchetype archetype) => archetype switch
    {
        BotArchetype.Rifleman => "rifleman",
        BotArchetype.Rusher => "rusher",
        BotArchetype.Sniper => "sniper",
        BotArchetype.Support => "support",
        BotArchetype.Scout => "scout",
        _ => throw new ArgumentOutOfRangeException(nameof(archetype), archetype, null),
    };

    public static bool TryParseBotArchetypeId(string id, out BotArchetype archetype)
    {
        switch (id)
        {
            case "rifleman": archetype = BotArchetype.Rifleman; return true;
            case "rusher": archetype = BotArchetype.Rusher; return true;
            case "sniper": archetype = BotArchetype.Sniper; return true;
            case "support": archetype = BotArchetype.Support; return true;
            case "scout": archetype = BotArchetype.Scout; return true;
            default: archetype = default; return false;
        }
    }

    public static string GetDifficultyId(DifficultyId difficulty) => difficulty switch
    {
        DifficultyId.Recruit => "recruit",
        DifficultyId.Regular => "regular",
        DifficultyId.Hardened => "hardened",
        DifficultyId.Veteran => "veteran",
        _ => throw new ArgumentOutOfRangeException(nameof(difficulty), difficulty, null),
    };

    public static bool TryParseDifficultyId(string id, out DifficultyId difficulty)
    {
        switch (id)
        {
            case "recruit": difficulty = DifficultyId.Recruit; return true;
            case "regular": difficulty = DifficultyId.Regular; return true;
            case "hardened": difficulty = DifficultyId.Hardened; return true;
            case "veteran": difficulty = DifficultyId.Veteran; return true;
            default: difficulty = default; return false;
        }
    }

    public static string GetMissionPhaseId(MissionPhase phase) => phase switch
    {
        MissionPhase.Briefing => "briefing",
        MissionPhase.Active => "active",
        MissionPhase.Failed => "failed",
        MissionPhase.Complete => "complete",
        _ => throw new ArgumentOutOfRangeException(nameof(phase), phase, null),
    };

    public static bool TryParseMissionPhaseId(string id, out MissionPhase phase)
    {
        switch (id)
        {
            case "briefing": phase = MissionPhase.Briefing; return true;
            case "active": phase = MissionPhase.Active; return true;
            case "failed": phase = MissionPhase.Failed; return true;
            case "complete": phase = MissionPhase.Complete; return true;
            default: phase = default; return false;
        }
    }

    public static string GetFailureReasonId(FailureReason reason) => reason switch
    {
        FailureReason.None => "none",
        FailureReason.PlayerDown => "player_down",
        FailureReason.AllyLost => "ally_lost",
        FailureReason.OutOfTime => "out_of_time",
        _ => throw new ArgumentOutOfRangeException(nameof(reason), reason, null),
    };

    public static bool TryParseFailureReasonId(string id, out FailureReason reason)
    {
        switch (id)
        {
            case "none": reason = FailureReason.None; return true;
            case "player_down": reason = FailureReason.PlayerDown; return true;
            case "ally_lost": reason = FailureReason.AllyLost; return true;
            case "out_of_time": reason = FailureReason.OutOfTime; return true;
            default: reason = default; return false;
        }
    }
}
