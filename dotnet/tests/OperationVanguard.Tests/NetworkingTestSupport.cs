using OperationVanguard.Core;

namespace OperationVanguard.Tests;

[CollectionDefinition("Networking runtime serial", DisableParallelization = true)]
public sealed class NetworkingRuntimeSerialCollection;

internal sealed class FakeNetClock : INetClock
{
    public double NowMilliseconds { get; set; }
}

internal sealed class FakeNetTransport : INetClientTransport
{
    public bool IsOpen { get; private set; }
    public string? OpenedUrl { get; private set; }
    public int CloseCalls { get; private set; }
    public List<byte[]> Sent { get; } = [];

    public event Action? Opened;
    public event Action<byte[]>? MessageReceived;
    public event Action? Closed;
    public event Action? Error;

    public void Open(string url)
    {
        OpenedUrl = url;
    }

    public void Send(byte[] bytes)
    {
        Sent.Add(bytes.ToArray());
    }

    public void Close()
    {
        CloseCalls++;
        IsOpen = false;
        Closed?.Invoke();
    }

    public void CompleteOpen()
    {
        IsOpen = true;
        Opened?.Invoke();
    }

    public void Deliver(byte[] bytes) => MessageReceived?.Invoke(bytes);

    public void Fail() => Error?.Invoke();

    public void CloseFromRemote()
    {
        IsOpen = false;
        Closed?.Invoke();
    }

    public void ClearSent() => Sent.Clear();
}

internal static class NetworkingTestData
{
    private static int _nextPlayerId = 10_000;

    public static (SimulationRuntimeTestCollision Collision, PlayerState Player) Player()
    {
        var id = Interlocked.Increment(ref _nextPlayerId);
        Movement.ResetStride(id);
        var player = WorldFactory.CreatePlayer(new CreatePlayerOptions
        {
            Id = id,
            Name = "Me",
            Team = Team.Allies,
            Position = new Vec3(0d, 0d, 0d),
        });
        player.Alive = true;
        player.OnGround = true;
        return (new SimulationRuntimeTestCollision(), player);
    }

    public static InputCommand Forward(int sequence) => new()
    {
        Seq = sequence,
        Tick = sequence,
        Dt = GameConstants.TickDt,
        MoveForward = 1d,
        KillstreakSlot = -1,
    };

    public static PlayerSnapshot SnapshotOf(PlayerState player) => new()
    {
        Id = player.Id,
        Team = (int)player.Team,
        Alive = player.Alive,
        OnGround = player.OnGround,
        IsBot = player.IsBot,
        Stance = (int)player.Stance,
        MoveState = (int)player.MoveState,
        X = player.Position.X,
        Y = player.Position.Y,
        Z = player.Position.Z,
        Vx = player.Velocity.X,
        Vy = player.Velocity.Y,
        Vz = player.Velocity.Z,
        Yaw = player.Yaw,
        Pitch = player.Pitch,
        Health = (int)player.Health,
        WeaponSlot = (int)player.ActiveSlot,
        Lean = player.Lean,
    };

    public static NetClient Connect(
        FakeNetTransport transport,
        FakeNetClock clock,
        SimulationRuntimeTestCollision collision,
        int localId = 17)
    {
        var client = new NetClient(new NetClientOptions
        {
            Url = "ws://example.test:8790",
            Name = "Alice",
            Loadout = LoadoutSystem.DefaultLoadout("Wire class"),
            Collision = collision,
        }, transport, clock);

        transport.CompleteOpen();
        transport.Deliver(NetProtocol.EncodeControl(NetMessage.Welcome, new WelcomePayload
        {
            YourId = localId,
            MapId = "crossfire",
            ModeId = "tdm",
            Seed = "network-test",
            TickRate = GameConstants.TickRate,
            SnapshotRate = GameConstants.Network.SnapshotRate,
        }));
        return client;
    }
}
