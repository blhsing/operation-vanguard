using OperationVanguard.Core;
using OperationVanguard.Server;

namespace OperationVanguard.Tests;

/// <summary>
/// Runs the real client prediction and interpolation path against the real
/// authoritative server through deterministic in-memory links.
/// </summary>
[Collection("Networking runtime serial")]
public sealed class NetLoopParityTests
{
    [Fact]
    public void MovingPlayerStaysWithinCentimetresOfServerOnLan()
    {
        using var server = Server("loop");
        using var client = new LoopClient(server, "Alice", latencyTicks: 0);

        for (var tick = 0; tick < 240; tick++)
        {
            client.Tick(moveForward: 1d);
            server.Tick();
        }

        Assert.NotNull(client.Local);
        Assert.True(Drift(client) < 0.5d, $"LAN drift was {Drift(client):F6}m");
    }

    [Fact]
    public void MovingPlayerStillConvergesWithHundredMillisecondRoundTrip()
    {
        using var server = Server("loop-lag");
        using var client = new LoopClient(server, "Bob", latencyTicks: 3);

        for (var tick = 0; tick < 240; tick++)
        {
            client.Tick(moveForward: 1d);
            server.Tick();
        }

        Assert.True(Drift(client) < 1.5d, $"lagged drift was {Drift(client):F6}m");
    }

    [Fact]
    public void IdlePlayerDoesNotFightServer()
    {
        using var server = Server("loop-idle");
        using var client = new LoopClient(server, "Carol", latencyTicks: 2);

        for (var tick = 0; tick < 120; tick++)
        {
            client.Tick();
            server.Tick();
        }

        var settled = client.Client.Stats().Mispredictions;
        for (var tick = 0; tick < 120; tick++)
        {
            client.Tick();
            server.Tick();
        }

        // Landing can produce a handful of corrections; steady jitter may not.
        var additional = client.Client.Stats().Mispredictions - settled;
        Assert.True(additional < 5, $"idle client accumulated {additional} new corrections");
    }

    [Fact]
    public void AcknowledgementsDrainInputBufferInsteadOfSaturatingIt()
    {
        using var server = Server("loop-ack");
        using var client = new LoopClient(server, "Dave", latencyTicks: 3);

        for (var tick = 0; tick < 300; tick++)
        {
            client.Tick(moveForward: 1d);
            server.Tick();
        }

        // Only roughly the round trip should remain in flight, nowhere near the cap.
        Assert.True(
            client.Client.Stats().Pending < 20,
            $"input history retained {client.Client.Stats().Pending} commands");
    }

    [Fact]
    public void TwoClientsSeeTheSameWorld()
    {
        using var server = Server("loop-two");
        using var first = new LoopClient(server, "A", latencyTicks: 2);
        using var second = new LoopClient(server, "B", latencyTicks: 2);

        for (var tick = 0; tick < 200; tick++)
        {
            first.Tick(moveForward: 1d);
            second.Tick();
            server.Tick();
        }

        var firstLocal = Assert.IsType<PlayerState>(first.Local);
        var secondViewOfFirst = Assert.Single(
            second.Client.Snapshots.Sample(),
            player => player.Id == first.Id);
        var gap = Math.Sqrt(
            Math.Pow(secondViewOfFirst.X - firstLocal.Position.X, 2d) +
            Math.Pow(secondViewOfFirst.Z - firstLocal.Position.Z, 2d));

        Assert.True(gap < 3d, $"second client saw the first {gap:F6}m away");
    }

    private static GameServer Server(string seed) => new(new GameServerOptions
    {
        MapId = "crossfire",
        ModeId = "tdm",
        Seed = seed,
    });

    private static double Drift(LoopClient client)
    {
        var local = Assert.IsType<PlayerState>(client.Local);
        var authoritative = client.ServerPosition();
        var deltaX = local.Position.X - authoritative.X;
        var deltaZ = local.Position.Z - authoritative.Z;
        return Math.Sqrt(deltaX * deltaX + deltaZ * deltaZ);
    }

    /// <summary>
    /// A real NetClient whose transport schedules frames in both directions by
    /// fixed tick count. Three ticks each way is about 100 ms round trip at 64 Hz.
    /// </summary>
    private sealed class LoopClient : IDisposable
    {
        private readonly GameServer _server;
        private readonly GameSimulation _simulation;
        private readonly DelayedLoopTransport _transport;
        private int _tick;

        public LoopClient(GameServer server, string name, int latencyTicks)
        {
            _server = server;
            _simulation = new GameSimulation(new GameOptions
            {
                MapId = server.Sim.Map.Id,
                ModeId = server.Sim.Mode.Id,
            });
            _transport = new DelayedLoopTransport(server, latencyTicks);
            Client = new NetClient(new NetClientOptions
            {
                Url = "ws://in-memory.test",
                Name = name,
                Loadout = LoadoutSystem.DefaultLoadout(),
                Collision = _simulation.Collision,
            }, _transport);
        }

        public NetClient Client { get; }

        public int Id => _transport.PlayerId ?? 0;

        public PlayerState? Local { get; private set; }

        public void Tick(double moveForward = 0d)
        {
            _tick++;
            _transport.BeginTick();

            var snapshot = Client.Snapshots.Latest;
            var mine = snapshot?.Players.Find(player => player.Id == Id);
            if (Local is null && mine is not null)
            {
                Local = _simulation.AddPlayer(new AddPlayerOptions
                {
                    Id = Id,
                    Name = "me",
                    Team = Team.None,
                });
                Local.Alive = true;
                Local.Position.X = mine.X;
                Local.Position.Y = mine.Y;
                Local.Position.Z = mine.Z;
            }

            if (Local is null)
            {
                return;
            }

            Client.Reconcile(Local);
            var input = SimulationTypes.CreateEmptyInput();
            input.Tick = _tick;
            input.Dt = GameConstants.TickDt;
            input.MoveForward = moveForward;
            Client.Tick(Local, input);
            _transport.DeliverOutbound();
        }

        public Vec3 ServerPosition()
        {
            var player = _server.Sim.World.Players[Id];
            return new Vec3(player.Position.X, player.Position.Y, player.Position.Z);
        }

        public void Dispose()
        {
            Client.Dispose();
            if (Local is not null)
            {
                _simulation.RemovePlayer(Local.Id);
            }
        }
    }

    private sealed class DelayedLoopTransport : INetClientTransport, IClientLink
    {
        private readonly GameServer _server;
        private readonly int _latencyTicks;
        private readonly List<ScheduledFrame> _inbound = [];
        private readonly List<ScheduledFrame> _outbound = [];
        private int _tick;

        public DelayedLoopTransport(GameServer server, int latencyTicks)
        {
            _server = server;
            _latencyTicks = latencyTicks;
        }

        public bool IsOpen { get; private set; }

        public int? PlayerId { get; private set; }

        public event Action? Opened;

        public event Action<byte[]>? MessageReceived;

        public event Action? Closed;

        public event Action? Error;

        public void Open(string url)
        {
            IsOpen = true;
            Opened?.Invoke();
        }

        void INetClientTransport.Send(byte[] bytes)
        {
            var copy = bytes.ToArray();
            if (NetProtocol.PeekType(copy) == NetMessage.Hello)
            {
                var hello = NetProtocol.DecodeControl<HelloPayload>(copy).Payload;
                PlayerId = _server.Join(this, hello);
                return;
            }

            _outbound.Add(new ScheduledFrame(_tick + _latencyTicks, copy));
        }

        void IClientLink.Send(byte[] bytes) =>
            _inbound.Add(new ScheduledFrame(_tick + _latencyTicks, bytes.ToArray()));

        public void Close()
        {
            if (!IsOpen)
            {
                return;
            }

            IsOpen = false;
            if (PlayerId is int playerId)
            {
                _server.Leave(playerId);
            }

            Closed?.Invoke();
        }

        void IClientLink.Close(string reason)
        {
            IsOpen = false;
            Closed?.Invoke();
        }

        public void BeginTick()
        {
            _tick++;
            DeliverDue(_inbound, bytes => MessageReceived?.Invoke(bytes));
        }

        public void DeliverOutbound()
        {
            if (PlayerId is int playerId)
            {
                DeliverDue(_outbound, bytes => _server.Receive(playerId, bytes));
            }
        }

        public void Fail() => Error?.Invoke();

        private void DeliverDue(List<ScheduledFrame> frames, Action<byte[]> deliver)
        {
            var due = frames.Where(frame => frame.DeliverAtTick <= _tick).ToArray();
            frames.RemoveAll(frame => frame.DeliverAtTick <= _tick);
            foreach (var frame in due)
            {
                deliver(frame.Bytes);
            }
        }

        private sealed record ScheduledFrame(int DeliverAtTick, byte[] Bytes);
    }
}
