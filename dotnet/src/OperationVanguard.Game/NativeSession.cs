using OperationVanguard.Core;

namespace OperationVanguard.Game;

public enum NativeSessionKind
{
    Campaign,
    Skirmish,
    Zombies,
    Online,
}

/// <summary>
/// Small presentation adapter over the offline session variants. Keeping this
/// union here lets the Raylib shell render one world without moving mode rules
/// out of their parity-specific directors.
/// </summary>
public sealed class NativeSession : IDisposable
{
    private readonly LocalSession? _local;
    private readonly ZombiesSession? _zombies;
    private readonly OnlineSession? _online;
    private bool _disposed;

    public NativeSession(LocalSession local)
    {
        _local = local ?? throw new ArgumentNullException(nameof(local));
        Kind = local.Campaign is null ? NativeSessionKind.Skirmish : NativeSessionKind.Campaign;
    }

    public NativeSession(ZombiesSession zombies)
    {
        _zombies = zombies ?? throw new ArgumentNullException(nameof(zombies));
        Kind = NativeSessionKind.Zombies;
    }

    public NativeSession(OnlineSession online)
    {
        _online = online ?? throw new ArgumentNullException(nameof(online));
        if (!online.IsReady)
            throw new ArgumentException("The online session must be welcomed before gameplay begins.", nameof(online));
        Kind = NativeSessionKind.Online;
    }

    public NativeSessionKind Kind { get; }
    public GameSimulation Simulation => _local?.Simulation ?? _zombies?.Simulation ?? _online!.Simulation;
    public NavGraph Navigation => _local?.Navigation ?? _zombies?.Navigation ??
        throw new InvalidOperationException("An online presentation session has no local navigation controller.");
    public BotController Bots => _local?.Bots ?? _zombies?.Bots ??
        throw new InvalidOperationException("An online presentation session has no local bot controller.");
    public MapDef Map => Simulation.Map;
    public BrushCollisionWorld Collision => Simulation.Collision;
    public WorldState World => Simulation.World;
    public PlayerState Player => _local?.Player ?? _zombies?.Player ?? _online?.Player ??
        throw new InvalidOperationException("The online player has not been welcomed.");
    public MissionDef? Mission => _local?.Mission;
    public CampaignDirector? Campaign => _local?.Campaign;
    public ZombiesDirector? Zombies => _zombies?.Director;
    public ZombieInteractionResult? LastInteraction => _zombies?.LastInteraction;
    public IReadOnlyList<SimEvent> LastEvents => _local?.LastEvents ?? _zombies?.LastEvents ?? _online!.LastEvents;
    public NetStatus? NetworkStatus => _online?.Status;
    public string NetworkStatusDetail => _online?.StatusDetail ?? string.Empty;
    public NetClientStats? NetworkStats => _online?.NetworkStats;
    public bool IsComplete => Kind switch
    {
        NativeSessionKind.Campaign => Campaign?.State.Phase == MissionPhase.Complete,
        NativeSessionKind.Zombies => Zombies?.State.Phase == RoundPhase.GameOver,
        _ => World.Match.Phase == MatchPhase.MatchEnd,
    };
    public Team? Winner => Kind == NativeSessionKind.Zombies ? null : World.Match.Winner;
    public double Elapsed => Campaign?.State.Elapsed ?? World.Time;

    public ZombiesHudSnapshot? CaptureZombiesHud() => _zombies?.CaptureHud();
    public ZombiesRuntimeSnapshot? CaptureZombiesRuntime() => _zombies?.CaptureRuntime();
    public CampaignSaveSnapshot? CaptureCampaignSave() =>
        Campaign is null ? null : Campaign.CaptureSave(Player);
    public IReadOnlyList<ObjectiveSummaryEntry> ObjectiveStatus() =>
        _online?.ObjectiveStatus ?? Simulation.ObjectiveStatus();

    public void Tick(InputCommand input, double deltaTime)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (_local is not null) _local.Tick(input, deltaTime);
        else if (_zombies is not null) _zombies.Tick(input, deltaTime);
        else _online!.Tick(input, deltaTime);
    }

    public void Dispose()
    {
        if (_disposed) return;
        _zombies?.Dispose();
        _online?.Dispose();
        _disposed = true;
    }
}
