using OperationVanguard.Core;

namespace OperationVanguard.Game;

public sealed class OnlineSessionOptions
{
    public string ServerUrl { get; set; } = GameConstants.Network.DefaultUrl;
    public string MapId { get; set; } = string.Empty;
    public string ModeId { get; set; } = string.Empty;
    public string? Seed { get; set; }
    public string PlayerName { get; set; } = string.Empty;
    public Loadout Loadout { get; set; } = new();
}

/// <summary>
/// Native online-match adapter. The server owns simulation; this class owns a
/// collision-identical presentation world, predicts only the welcomed local id,
/// interpolates everyone else, and exposes the same state shape as LocalSession.
/// </summary>
public sealed class OnlineSession : IDisposable, IAsyncDisposable
{
    private readonly INetClientTransport _transport;
    private readonly CancellationTokenRegistration _cancellationRegistration;
    private Rng _presentationRng;
    private IReadOnlyList<ObjectiveSummaryEntry> _objectiveStatus = [];
    private Snapshot? _lastAppliedExtensionSnapshot;
    private int _localId;
    private int _disposed;

    public OnlineSession(
        OnlineSessionOptions options,
        INetClientTransport? transport = null,
        INetClock? clock = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(options);
        Options = options;
        Simulation = new GameSimulation(new GameOptions
        {
            MapId = options.MapId,
            ModeId = options.ModeId,
            Seed = options.Seed,
        });
        _presentationRng = new Rng(Rng.HashString($"{options.Seed ?? options.MapId}:online-presentation"));

        _transport = transport ?? new ClientWebSocketTransport();
        try
        {
            Network = new NetClient(new NetClientOptions
            {
                Url = options.ServerUrl,
                Name = options.PlayerName,
                Loadout = options.Loadout,
                Collision = Simulation.Collision,
            }, _transport, clock);
        }
        catch
        {
            DisposeTransportSynchronously(_transport);
            throw;
        }

        _cancellationRegistration = cancellationToken.CanBeCanceled
            ? cancellationToken.UnsafeRegister(static state =>
                ((INetClientTransport)state!).Close(), _transport)
            : default;
    }

    public OnlineSessionOptions Options { get; }
    public NetClient Network { get; }
    public GameSimulation Simulation { get; private set; }
    public MapDef Map => Simulation.Map;
    public GameModeDef Mode => Simulation.Mode;
    public BrushCollisionWorld Collision => Simulation.Collision;
    public WorldState World => Simulation.World;

    /// <summary>Zero until Welcome is pumped; thereafter it is server-assigned.</summary>
    public int LocalId => _localId;

    /// <summary>Null while connecting or when Welcome has not yet been adopted.</summary>
    public PlayerState? Player =>
        _localId != 0 && World.Players.TryGetValue(_localId, out var player) ? player : null;

    public NetStatus Status => Network.Status;
    public string StatusDetail => Network.StatusDetail;
    public WelcomePayload? Welcome => Network.Welcome;
    public bool IsReady => Status == NetStatus.Playing && Player is not null;
    public bool IsDisposed => Volatile.Read(ref _disposed) != 0;
    public InputCommand LastInput { get; private set; } = new();
    public IReadOnlyList<SimEvent> LastEvents { get; private set; } = [];
    public NetClientStats NetworkStats => Network.Stats();
    public IReadOnlyList<ObjectiveSummaryEntry> ObjectiveStatus => _objectiveStatus;

    /// <summary>
    /// Pump native worker-thread notifications and adopt a newly welcomed local id.
    /// Menus may call this while waiting; Tick calls it automatically.
    /// </summary>
    public int PumpNetwork(int maximumNotifications = 256)
    {
        ObjectDisposedException.ThrowIf(IsDisposed, this);
        var count = _transport is IPumpableNetClientTransport pumpable
            ? pumpable.Pump(maximumNotifications)
            : 0;
        AdoptWelcomeConfiguration();
        AdoptWelcomePlayer();
        return count;
    }

    /// <summary>
    /// One fixed online tick. No local GameSimulation.Step occurs: NetClient owns
    /// prediction/reconciliation and snapshots own the remote roster.
    /// </summary>
    public void Tick(InputCommand input, double deltaTime = GameConstants.TickDt)
    {
        ObjectDisposedException.ThrowIf(IsDisposed, this);
        ArgumentNullException.ThrowIfNull(input);
        LastInput = input;

        PumpNetwork();
        SyncLatestLocalState();
        var local = Player;
        if (local is { Alive: false } &&
            SimulationTypes.HasFlag(input.Buttons, InputFlag.Fire))
        {
            Network.RequestRespawn();
        }

        Network.Tick(local, input);
        Network.Reconcile(local);
        ApplySnapshot(deltaTime);
        StepLocalWeapon(input, deltaTime);
        LastEvents = Network.DrainEvents();
        ApplyAuthoritativeEvents(LastEvents);
    }

    public void RequestRespawn()
    {
        ObjectDisposedException.ThrowIf(IsDisposed, this);
        Network.RequestRespawn();
    }

    public void Say(string text)
    {
        ObjectDisposedException.ThrowIf(IsDisposed, this);
        Network.Say(text);
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        _cancellationRegistration.Dispose();
        Network.Dispose();
        DisposeTransportSynchronously(_transport);
        GC.SuppressFinalize(this);
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        _cancellationRegistration.Dispose();
        Network.Dispose();
        if (_transport is IAsyncDisposable asynchronous)
        {
            await asynchronous.DisposeAsync().ConfigureAwait(false);
        }
        else if (_transport is IDisposable disposable)
        {
            disposable.Dispose();
        }

        GC.SuppressFinalize(this);
    }

    private void AdoptWelcomeConfiguration()
    {
        var welcome = Network.Welcome;
        if (welcome is null ||
            !Maps.Ids.Contains(welcome.MapId, StringComparer.Ordinal) ||
            !ModeData.MultiplayerModeIds.Contains(welcome.ModeId, StringComparer.Ordinal))
        {
            // Leave unsupported selections visible to VanguardGame's existing
            // connection error path instead of throwing from a content lookup.
            return;
        }

        if (Simulation.Map.Id == welcome.MapId &&
            Simulation.Mode.Id == welcome.ModeId &&
            Options.Seed == welcome.Seed)
        {
            return;
        }

        // Welcome is authoritative for content and seed. Rebuild only the local
        // presentation/prediction world; the accepted socket and player id stay
        // alive, avoiding a leave/rejoin race when the room is full.
        var replacement = new GameSimulation(new GameOptions
        {
            MapId = welcome.MapId,
            ModeId = welcome.ModeId,
            Seed = welcome.Seed,
        });
        Network.RebindCollision(replacement.Collision);
        Simulation = replacement;
        _presentationRng = new Rng(Rng.HashString($"{welcome.Seed}:online-presentation"));
        _objectiveStatus = [];
        _lastAppliedExtensionSnapshot = null;
        Options.MapId = welcome.MapId;
        Options.ModeId = welcome.ModeId;
        Options.Seed = welcome.Seed;
    }

    private void AdoptWelcomePlayer()
    {
        var welcomedId = Network.LocalId;
        if (welcomedId == 0 || welcomedId == _localId)
        {
            return;
        }

        _localId = welcomedId;
        if (World.Players.ContainsKey(welcomedId))
        {
            return;
        }

        var player = Simulation.AddPlayer(new AddPlayerOptions
        {
            Id = welcomedId,
            Name = Options.PlayerName,
            Team = Team.None,
            Loadout = Options.Loadout,
        });
        if (Simulation.GetResolvedLoadout(welcomedId) is { } resolved)
            LoadoutSystem.ApplyLoadout(player, resolved);
        // The server owns the spawn. This temporary live state allows immediate
        // prediction until the first authoritative snapshot arrives.
        player.Alive = true;
    }

    private void ApplySnapshot(double deltaTime)
    {
        var snapshots = Network.RemotePlayers(deltaTime);
        var latest = Network.Snapshots.Latest;
        if (latest is not null)
        {
            World.Tick = unchecked((int)latest.Tick);
            World.Time = Math.Max(latest.ServerTime, World.Time + deltaTime);
        }
        else
        {
            World.Time += deltaTime;
        }
        var seen = new HashSet<int>();
        foreach (var snapshot in snapshots)
        {
            seen.Add(snapshot.Id);
            if (snapshot.Id == _localId)
            {
                // Reconciliation owns local movement, while SyncLatestLocalState
                // takes discrete life/team/slot state from the newest frame.
                continue;
            }

            if (!World.Players.TryGetValue(snapshot.Id, out var player))
            {
                player = Simulation.AddPlayer(new AddPlayerOptions
                {
                    Id = snapshot.Id,
                    Name = $"Player {snapshot.Id}",
                    Team = (Team)snapshot.Team,
                    IsBot = snapshot.IsBot,
                });
            }

            player.Position.X = snapshot.X;
            player.Position.Y = snapshot.Y;
            player.Position.Z = snapshot.Z;
            player.Velocity.X = snapshot.Vx;
            player.Velocity.Y = snapshot.Vy;
            player.Velocity.Z = snapshot.Vz;
            player.Yaw = snapshot.Yaw;
            player.Pitch = snapshot.Pitch;
            player.Lean = snapshot.Lean;
            player.Stance = (Stance)snapshot.Stance;
            player.MoveState = (MoveState)snapshot.MoveState;
            player.OnGround = snapshot.OnGround;
            player.Alive = snapshot.Alive;
            player.Health = snapshot.Health;
            player.Team = (Team)snapshot.Team;
        }

        if (snapshots.Count > 0)
        {
            foreach (var id in World.Players.Keys.ToArray())
            {
                if (id != _localId && !seen.Contains(id))
                {
                    Simulation.RemovePlayer(id);
                }
            }
        }

        var appliedExtension = false;
        if (latest?.Extension is { } extension &&
            !ReferenceEquals(latest, _lastAppliedExtensionSnapshot))
        {
            ApplyExtension(extension);
            _lastAppliedExtensionSnapshot = latest;
            appliedExtension = true;
        }

        if (!appliedExtension && World.Match.Phase != MatchPhase.MatchEnd)
            World.Match.TimeRemaining = Math.Max(0d, World.Match.TimeRemaining - deltaTime);
    }

    private void SyncLatestLocalState()
    {
        var local = Player;
        var latest = Network.Snapshots.Latest;
        if (local is null || latest is null) return;
        var authoritative = latest.Players.Find(player => player.Id == _localId);
        if (authoritative is null) return;

        // These values are discontinuous and must never come from the delayed
        // interpolation sample. In particular, a respawn must reconcile from
        // its new authoritative transform during this tick, not one frame later.
        local.Alive = authoritative.Alive;
        local.Health = authoritative.Health;
        local.Team = (Team)authoritative.Team;
        local.ActiveSlot = (WeaponSlot)authoritative.WeaponSlot;
    }

    private void StepLocalWeapon(InputCommand input, double deltaTime)
    {
        if (Player is not { Alive: true } local || local.Weapons.Count == 0)
            return;
        var resolved = Simulation.GetResolvedLoadout(local.Id);
        if (resolved is null) return;
        WeaponSystem.SetTrigger(local, input);
        WeaponSystem.StepWeapon(
            local,
            input,
            World.Time,
            deltaTime,
            _presentationRng,
            state => state.DefId == resolved.Primary.Id ? resolved.Primary : resolved.Secondary);
    }

    private void ApplyExtension(SnapshotExtension extension)
    {
        World.Match.Phase = extension.Match.Phase;
        World.Match.TimeRemaining = extension.Match.TimeRemaining;
        World.Match.Round = extension.Match.Round;
        World.Match.Winner = extension.Match.Winner;
        World.Match.Scores = extension.Match.Scores.Select(score => new TeamScore
        {
            Team = score.Team,
            Score = score.Score,
            RoundsWon = score.RoundsWon,
        }).ToList();
        _objectiveStatus = extension.Objectives.ToArray();

        foreach (var combat in extension.Players)
        {
            if (!World.Players.TryGetValue(combat.Id, out var player)) continue;
            player.MaxHealth = combat.MaxHealth;
            player.Armor = combat.Armor;
            player.RespawnTimer = combat.RespawnTimer;
            player.AdsProgress = combat.AdsProgress;
            player.IsAds = combat.IsAds;
            player.Action = combat.Action;
            player.ActionTimer = combat.ActionTimer;
            player.LethalCount = combat.LethalCount;
            player.TacticalCount = combat.TacticalCount;
            player.FieldUpgradeCharge = combat.FieldUpgradeCharge;
            player.KillstreakInventory = combat.KillstreakInventory.ToList();
            player.FlashAmount = combat.FlashAmount;
            player.ConcussionAmount = combat.ConcussionAmount;
            player.EmpTime = combat.EmpTime;
            player.Kills = combat.Kills;
            player.Deaths = combat.Deaths;
            player.Assists = combat.Assists;
            player.Score = combat.Score;
            player.Killstreak = combat.Killstreak;
            player.BestKillstreak = combat.BestKillstreak;
            player.StreakScore = combat.StreakScore;
            player.Captures = combat.Captures;
            player.Defends = combat.Defends;
            player.Plants = combat.Plants;
            player.Defuses = combat.Defuses;
            player.DamageDealt = combat.DamageDealt;
            player.Headshots = combat.Headshots;
            player.Weapons = combat.Weapons.Select(weapon => new WeaponState
            {
                DefId = weapon.DefId,
                AmmoInMag = weapon.AmmoInMag,
                AmmoReserve = weapon.AmmoReserve,
                Attachments = weapon.Attachments.ToList(),
                ShotsInBurst = weapon.ShotsInBurst,
                RecoilYaw = weapon.RecoilYaw,
                RecoilPitch = weapon.RecoilPitch,
                Spread = weapon.Spread,
                NextFireTime = weapon.NextFireTime,
                Heat = weapon.Heat,
            }).ToList();
        }
    }

    private void ApplyAuthoritativeEvents(IReadOnlyList<SimEvent> events)
    {
        var hasExtension = Network.Snapshots.Latest?.Extension is not null;
        foreach (var simulationEvent in events)
        {
            switch (simulationEvent)
            {
                case KillEvent kill when !hasExtension:
                    if (World.Players.TryGetValue(kill.Killer, out var killer)) killer.Kills++;
                    if (World.Players.TryGetValue(kill.Victim, out var victim)) victim.Deaths++;
                    foreach (var id in kill.Assists)
                        if (World.Players.TryGetValue(id, out var assistant)) assistant.Assists++;
                    break;

                case ScoreEvent score when !hasExtension &&
                                           World.Players.TryGetValue(score.Player, out var player):
                    player.Score += score.Amount;
                    break;

                case GenericSimEvent { Type: SimEventType.MatchStateChanged, Data: { } data }:
                    if (TryInteger(data, "phase", out var phase))
                    {
                        World.Match.Phase = (MatchPhase)phase;
                        World.Match.TimeRemaining = World.Match.Phase switch
                        {
                            MatchPhase.Live => Mode.TimeLimit > 0d ? Mode.TimeLimit : Mode.RoundTime,
                            MatchPhase.MatchEnd => GameConstants.Match.OutroDuration,
                            _ => World.Match.TimeRemaining,
                        };
                    }
                    if (TryInteger(data, "winner", out var winner)) World.Match.Winner = (Team)winner;
                    else if (data.ContainsKey("winner")) World.Match.Winner = null;
                    break;
            }
        }
    }

    private static bool TryInteger(IReadOnlyDictionary<string, object?> data, string key, out int value)
    {
        if (data.TryGetValue(key, out var raw))
        {
            switch (raw)
            {
                case int integer:
                    value = integer;
                    return true;
                case long integer when integer is >= int.MinValue and <= int.MaxValue:
                    value = (int)integer;
                    return true;
                case double number when double.IsFinite(number) && number == Math.Truncate(number) &&
                                        number is >= int.MinValue and <= int.MaxValue:
                    value = (int)number;
                    return true;
                case string text when Enum.TryParse<MatchPhase>(text, true, out var phase):
                    value = (int)phase;
                    return true;
                case string text when Enum.TryParse<Team>(text, true, out var team):
                    value = (int)team;
                    return true;
            }
        }

        value = 0;
        return false;
    }

    private static void DisposeTransportSynchronously(INetClientTransport transport)
    {
        if (transport is IDisposable disposable)
        {
            disposable.Dispose();
        }
        else
        {
            transport.Close();
        }
    }
}
