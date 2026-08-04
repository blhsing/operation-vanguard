using System.Diagnostics;
using System.Text.Json;

namespace OperationVanguard.Core;

public enum NetStatus
{
    Connecting = 0,
    Playing = 1,
    Rejected = 2,
    Disconnected = 3,
}

/// <summary>
/// Minimal ordered-message transport contract. A WebSocket adapter can implement
/// this in the presentation layer; Core remains independent of any socket stack.
/// </summary>
public interface INetClientTransport
{
    bool IsOpen { get; }

    event Action? Opened;
    event Action<byte[]>? MessageReceived;
    event Action? Closed;
    event Action? Error;

    void Open(string url);
    void Send(byte[] bytes);
    void Close();
}

public interface INetClock
{
    double NowMilliseconds { get; }
}

/// <summary>A performance.now-like monotonic clock for production transports.</summary>
public sealed class MonotonicNetClock : INetClock
{
    private readonly long _origin = Stopwatch.GetTimestamp();

    public double NowMilliseconds => Stopwatch.GetElapsedTime(_origin).TotalMilliseconds;
}

public sealed class NetClientOptions
{
    public string Url { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public Loadout Loadout { get; set; } = new();
    public ICollisionWorld Collision { get; set; } = null!;
}

public readonly record struct NetClientStats(
    int Pending,
    int Mispredictions,
    double LastCorrection,
    int Ping,
    int Snapshots);

/// <summary>
/// Client-side connection state: immediate local movement prediction, remote
/// interpolation, reconciliation, control messages, and smoothed round-trip time.
/// </summary>
public sealed class NetClient : IDisposable
{
    private sealed class TimePayload
    {
        public double T { get; set; }
    }

    private readonly NetClientOptions _options;
    private Predictor _predictor;
    private readonly INetClock _clock;
    private INetClientTransport? _transport;
    private int _sequence = 1;
    private double _rtt;
    private double _pingTimer;
    private double _sinceSnapshot;
    private bool _disposed;

    public NetClient(
        NetClientOptions options,
        INetClientTransport transport,
        INetClock? clock = null)
    {
        _options = options ?? throw new ArgumentNullException(nameof(options));
        ArgumentNullException.ThrowIfNull(options.Collision);
        _transport = transport ?? throw new ArgumentNullException(nameof(transport));
        _clock = clock ?? new MonotonicNetClock();
        _predictor = new Predictor(options.Collision);

        transport.Opened += HandleOpened;
        transport.MessageReceived += HandleMessage;
        transport.Closed += HandleClosed;
        transport.Error += HandleError;
        transport.Open(options.Url);
    }

    public NetStatus Status { get; private set; } = NetStatus.Connecting;

    /// <summary>Why the connection ended, when it did.</summary>
    public string StatusDetail { get; private set; } = string.Empty;

    public WelcomePayload? Welcome { get; private set; }

    public int LocalId { get; private set; }

    public SnapshotBuffer Snapshots { get; } = new();

    public List<ChatPayload> Chat { get; } = [];

    /// <summary>Events received from the server, drained once per presentation frame.</summary>
    public List<SimEvent> Events { get; } = [];

    /// <summary>
    /// Replace the collision world used for local prediction without reopening
    /// the transport. Online presentation calls this once after Welcome when the
    /// server-selected map differs from the provisional menu selection.
    /// </summary>
    public void RebindCollision(ICollisionWorld collision)
    {
        ArgumentNullException.ThrowIfNull(collision);
        _options.Collision = collision;
        _predictor = new Predictor(collision);
    }

    /// <summary>
    /// Predict one fixed tick and send the complete unacknowledged input window.
    /// The protocol encoder retains only its newest sixteen entries on the wire.
    /// </summary>
    public void Tick(PlayerState? local, InputCommand input)
    {
        ArgumentNullException.ThrowIfNull(input);
        if (Status != NetStatus.Playing || _transport is null)
        {
            return;
        }

        input.Seq = _sequence++;
        if (local is { Alive: true })
        {
            _predictor.Predict(local, input);
        }

        var pending = _predictor.Unacknowledged();
        var wire = new List<WireInput>(pending.Count);
        foreach (var command in pending)
        {
            wire.Add(ToWire(command));
        }

        Send(NetProtocol.EncodeInputs(wire));

        _pingTimer -= GameConstants.TickDt;
        if (_pingTimer <= 0d)
        {
            _pingTimer = GameConstants.Network.HeartbeatInterval;
            Send(NetProtocol.EncodeControl(NetMessage.Ping, new TimePayload
            {
                T = _clock.NowMilliseconds,
            }));
        }
    }

    /// <summary>Fold the newest authoritative local-player frame into prediction.</summary>
    public void Reconcile(PlayerState? local)
    {
        var snapshot = Snapshots.Latest;
        if (snapshot is null || local is null)
        {
            return;
        }

        var authoritative = snapshot.Players.Find(player => player.Id == LocalId);
        if (authoritative is null)
        {
            return;
        }

        if (!authoritative.Alive || !local.Alive)
        {
            _predictor.Reset();
            return;
        }

        _predictor.Reconcile(local, authoritative, snapshot.AckedInput);
    }

    /// <summary>All players at this frame's delayed interpolation time.</summary>
    public IReadOnlyList<PlayerSnapshot> RemotePlayers(double deltaTime)
    {
        _sinceSnapshot += deltaTime;
        return Snapshots.Sample(_sinceSnapshot);
    }

    public List<SimEvent> DrainEvents()
    {
        var output = Events.ToList();
        Events.Clear();
        return output;
    }

    public void RequestRespawn() =>
        Send(NetProtocol.EncodeControl(NetMessage.Respawn, new Dictionary<string, object?>()));

    public void Say(string text) =>
        Send(NetProtocol.EncodeControl(NetMessage.Chat, new ChatPayload
        {
            From = LocalId,
            Text = text,
        }));

    public NetClientStats Stats()
    {
        var prediction = _predictor.Stats();
        return new NetClientStats(
            prediction.Pending,
            prediction.Mispredictions,
            prediction.LastCorrection,
            JsRound(_rtt * 1000d),
            Snapshots.Size);
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        var transport = _transport;
        if (transport is not null)
        {
            try
            {
                transport.Close();
            }
            finally
            {
                transport.Opened -= HandleOpened;
                transport.MessageReceived -= HandleMessage;
                transport.Closed -= HandleClosed;
                transport.Error -= HandleError;
                _transport = null;
            }
        }

        if (Status != NetStatus.Rejected)
        {
            Status = NetStatus.Disconnected;
            if (string.IsNullOrEmpty(StatusDetail))
            {
                StatusDetail = "連線中斷";
            }
        }

        Snapshots.Clear();
        _predictor.Reset();
    }

    private void HandleOpened()
    {
        Send(NetProtocol.EncodeControl(NetMessage.Hello, new HelloPayload
        {
            ProtocolVersion = GameConstants.Network.ProtocolVersion,
            Name = _options.Name,
            Loadout = _options.Loadout,
        }));
    }

    private void HandleMessage(byte[] bytes)
    {
        switch (NetProtocol.PeekType(bytes))
        {
            case NetMessage.Welcome:
                Welcome = NetProtocol.DecodeControl<WelcomePayload>(bytes).Payload;
                LocalId = Welcome.YourId;
                Status = NetStatus.Playing;
                break;

            case NetMessage.Reject:
                Status = NetStatus.Rejected;
                StatusDetail = NetProtocol.DecodeControl<RejectPayload>(bytes).Payload.Reason;
                break;

            case NetMessage.Snapshot:
                Snapshots.Push(NetProtocol.DecodeSnapshot(bytes));
                _sinceSnapshot = 0d;
                break;

            case NetMessage.Events:
                foreach (var simulationEvent in NetworkEventDecoder.Decode(bytes))
                {
                    Events.Add(simulationEvent);
                }
                break;

            case NetMessage.Chat:
                Chat.Add(NetProtocol.DecodeControl<ChatPayload>(bytes).Payload);
                if (Chat.Count > 32)
                {
                    Chat.RemoveAt(0);
                }
                break;

            case NetMessage.Bye:
                {
                    var bye = NetProtocol.DecodeControl<ByePayload>(bytes).Payload;
                    if (bye.Id == LocalId)
                    {
                        Status = NetStatus.Disconnected;
                        StatusDetail = "你已離開伺服器";
                    }
                    break;
                }

            case NetMessage.Pong:
                {
                    var payload = NetProtocol.DecodeControl<JsonElement>(bytes).Payload;
                    var sentAt = payload.GetProperty("t").GetDouble();
                    var sample = (_clock.NowMilliseconds - sentAt) / 1000d;
                    _rtt = _rtt == 0d ? sample : _rtt * 0.8d + sample * 0.2d;
                    break;
                }

            default:
                break;
        }
    }

    private void HandleClosed()
    {
        if (Status == NetStatus.Rejected)
        {
            return;
        }

        Status = NetStatus.Disconnected;
        if (string.IsNullOrEmpty(StatusDetail))
        {
            StatusDetail = "連線中斷";
        }
    }

    private void HandleError()
    {
        if (Status != NetStatus.Connecting)
        {
            return;
        }

        Status = NetStatus.Rejected;
        StatusDetail = "無法連線到伺服器";
    }

    private void Send(byte[] bytes)
    {
        if (_transport is { IsOpen: true } transport)
        {
            transport.Send(bytes);
        }
    }

    private static WireInput ToWire(InputCommand command) => new()
    {
        Seq = unchecked((uint)command.Seq),
        Tick = unchecked((uint)command.Tick),
        Dt = command.Dt,
        MoveForward = command.MoveForward,
        MoveRight = command.MoveRight,
        Yaw = command.Yaw,
        Pitch = command.Pitch,
        Buttons = unchecked((uint)command.Buttons),
        WeaponSlot = 0,
    };

    private static int JsRound(double value) => checked((int)Math.Floor(value + 0.5d));
}
