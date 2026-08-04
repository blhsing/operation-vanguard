using System.Text.Json;
using OperationVanguard.Core;

namespace OperationVanguard.Tests;

[Collection("Networking runtime serial")]
public sealed class NetClientParityTests
{
    [Fact]
    public void OpeningTransportSendsTheExactHelloContract()
    {
        var transport = new FakeNetTransport();
        var clock = new FakeNetClock();
        var collision = new SimulationRuntimeTestCollision();
        using var client = new NetClient(new NetClientOptions
        {
            Url = "ws://host.test:9000/room",
            Name = "測試 Alice",
            Loadout = LoadoutSystem.DefaultLoadout("Assault"),
            Collision = collision,
        }, transport, clock);

        Assert.Equal(NetStatus.Connecting, client.Status);
        Assert.Equal("ws://host.test:9000/room", transport.OpenedUrl);
        Assert.Empty(transport.Sent);

        transport.CompleteOpen();

        var frame = Assert.Single(transport.Sent);
        var hello = NetProtocol.DecodeControl<JsonElement>(frame);
        Assert.Equal(NetMessage.Hello, hello.Type);
        Assert.Equal(GameConstants.Network.ProtocolVersion,
            hello.Payload.GetProperty("protocolVersion").GetInt32());
        Assert.Equal("測試 Alice", hello.Payload.GetProperty("name").GetString());
        Assert.Equal(WeaponData.DefaultPrimary,
            hello.Payload.GetProperty("loadout").GetProperty("primary").GetString());
    }

    [Fact]
    public void WelcomeTransitionsToPlayingAndPublishesServerMetadata()
    {
        var transport = new FakeNetTransport();
        var clock = new FakeNetClock();
        using var client = NetworkingTestData.Connect(
            transport,
            clock,
            new SimulationRuntimeTestCollision(),
            localId: 41);

        Assert.Equal(NetStatus.Playing, client.Status);
        Assert.Equal(41, client.LocalId);
        Assert.NotNull(client.Welcome);
        Assert.Equal("crossfire", client.Welcome.MapId);
        Assert.Equal("tdm", client.Welcome.ModeId);
        Assert.Equal(GameConstants.Network.SnapshotRate, client.Welcome.SnapshotRate);
    }

    [Fact]
    public void RejectAndConnectErrorUseWebClientStatusSemantics()
    {
        var rejectedTransport = new FakeNetTransport();
        using var rejected = new NetClient(new NetClientOptions
        {
            Url = "ws://reject.test",
            Name = "A",
            Collision = new SimulationRuntimeTestCollision(),
        }, rejectedTransport, new FakeNetClock());
        rejectedTransport.CompleteOpen();
        rejectedTransport.Deliver(NetProtocol.EncodeControl(NetMessage.Reject, new RejectPayload
        {
            Reason = "protocol mismatch",
        }));
        rejectedTransport.CloseFromRemote();

        Assert.Equal(NetStatus.Rejected, rejected.Status);
        Assert.Equal("protocol mismatch", rejected.StatusDetail);

        var failedTransport = new FakeNetTransport();
        using var failed = new NetClient(new NetClientOptions
        {
            Url = "ws://offline.test",
            Name = "B",
            Collision = new SimulationRuntimeTestCollision(),
        }, failedTransport, new FakeNetClock());
        failedTransport.Fail();
        failedTransport.CloseFromRemote();

        Assert.Equal(NetStatus.Rejected, failed.Status);
        Assert.Equal("無法連線到伺服器", failed.StatusDetail);
    }

    [Fact]
    public void TickPredictsNowAndSendsRedundantUnacknowledgedInputs()
    {
        var (collision, player) = NetworkingTestData.Player();
        var transport = new FakeNetTransport();
        var clock = new FakeNetClock { NowMilliseconds = 1_250d };
        using var client = NetworkingTestData.Connect(transport, clock, collision, player.Id);
        transport.ClearSent();
        var before = (player.Position.X, player.Position.Y, player.Position.Z);
        var first = NetworkingTestData.Forward(99);
        first.MoveRight = -0.5d;
        first.Yaw = 0.75d;
        first.Pitch = -0.2d;
        first.Buttons = (int)InputFlag.Sprint;

        client.Tick(player, first);

        Assert.Equal(1, first.Seq);
        Assert.NotEqual(before, (player.Position.X, player.Position.Y, player.Position.Z));
        Assert.Equal(2, transport.Sent.Count);
        var inputFrame = Assert.Single(transport.Sent, frame =>
            NetProtocol.PeekType(frame) == NetMessage.Input);
        var wire = Assert.Single(NetProtocol.DecodeInputs(inputFrame));
        Assert.Equal(1u, wire.Seq);
        Assert.Equal(99u, wire.Tick);
        Assert.Equal(GameConstants.TickDt, wire.Dt, 6);
        Assert.Equal(1d, wire.MoveForward, 6);
        Assert.Equal(-0.5d, wire.MoveRight, 2);
        Assert.Equal(0.75d, wire.Yaw, 3);
        Assert.Equal(-0.2d, wire.Pitch, 3);
        Assert.Equal((uint)InputFlag.Sprint, wire.Buttons);
        Assert.Equal(0, wire.WeaponSlot);

        var pingFrame = Assert.Single(transport.Sent, frame =>
            NetProtocol.PeekType(frame) == NetMessage.Ping);
        var ping = NetProtocol.DecodeControl<JsonElement>(pingFrame).Payload;
        Assert.Equal(1_250d, ping.GetProperty("t").GetDouble());
        Assert.Equal(1, client.Stats().Pending);

        transport.ClearSent();
        var second = NetworkingTestData.Forward(100);
        client.Tick(player, second);

        var secondFrame = Assert.Single(transport.Sent);
        var resent = NetProtocol.DecodeInputs(secondFrame);
        Assert.Equal([1u, 2u], resent.Select(input => input.Seq));
        Assert.Equal(2, client.Stats().Pending);
    }

    [Fact]
    public void TickDoesNothingBeforeWelcomeAndDoesNotPredictDeadPlayers()
    {
        var (collision, player) = NetworkingTestData.Player();
        var transport = new FakeNetTransport();
        using var client = new NetClient(new NetClientOptions
        {
            Url = "ws://pending.test",
            Name = "A",
            Collision = collision,
        }, transport, new FakeNetClock());
        var connectingInput = NetworkingTestData.Forward(50);

        client.Tick(player, connectingInput);

        Assert.Equal(50, connectingInput.Seq);
        Assert.Empty(transport.Sent);

        transport.CompleteOpen();
        transport.Deliver(NetProtocol.EncodeControl(NetMessage.Welcome, new WelcomePayload
        {
            YourId = player.Id,
        }));
        transport.ClearSent();
        player.Alive = false;
        var deadInput = NetworkingTestData.Forward(51);
        client.Tick(player, deadInput);

        Assert.Equal(1, deadInput.Seq);
        Assert.Equal(0, client.Stats().Pending);
        var inputs = NetProtocol.DecodeInputs(transport.Sent[0]);
        Assert.Empty(inputs);
    }

    [Fact]
    public void PongUsesExponentialRoundTripSmoothingAndJavascriptRounding()
    {
        var transport = new FakeNetTransport();
        var clock = new FakeNetClock { NowMilliseconds = 1_123d };
        using var client = NetworkingTestData.Connect(
            transport, clock, new SimulationRuntimeTestCollision());

        transport.Deliver(NetProtocol.EncodeControl(NetMessage.Pong, new { t = 1_000d }));
        Assert.Equal(123, client.Stats().Ping);

        clock.NowMilliseconds = 1_400d;
        transport.Deliver(NetProtocol.EncodeControl(NetMessage.Pong, new { t = 1_200d }));

        // 123 ms * .8 + 200 ms * .2 = 138.4 ms, Math.round => 138.
        Assert.Equal(138, client.Stats().Ping);
    }

    [Fact]
    public void SnapshotReconcileCorrectsPhysicsAcknowledgesInputAndPreservesAim()
    {
        var (collision, player) = NetworkingTestData.Player();
        var transport = new FakeNetTransport();
        using var client = NetworkingTestData.Connect(
            transport, new FakeNetClock(), collision, player.Id);
        transport.ClearSent();
        var input = NetworkingTestData.Forward(1);
        input.Yaw = 0.8d;
        input.Pitch = -0.25d;
        client.Tick(player, input);

        var authoritative = NetworkingTestData.SnapshotOf(player);
        authoritative.X += 5d;
        authoritative.Vx = 0d;
        authoritative.Vy = 0d;
        authoritative.Vz = 0d;
        authoritative.Yaw = -2.4d;
        authoritative.Pitch = 0.7d;
        transport.Deliver(NetProtocol.EncodeSnapshot(new Snapshot
        {
            Tick = 10,
            ServerTime = 1d,
            AckedInput = 1,
            Players = [authoritative],
        }));

        client.Reconcile(player);

        Assert.Equal(authoritative.X, player.Position.X, 4);
        Assert.Equal(0.8d, player.Yaw);
        Assert.Equal(-0.25d, player.Pitch);
        Assert.Equal(0, client.Stats().Pending);
        Assert.Equal(1, client.Stats().Mispredictions);

        client.Tick(player, NetworkingTestData.Forward(2));
        authoritative.Alive = false;
        transport.Deliver(NetProtocol.EncodeSnapshot(new Snapshot
        {
            Tick = 11,
            ServerTime = 1.1d,
            AckedInput = 1,
            Players = [authoritative],
        }));
        client.Reconcile(player);

        Assert.Equal(new NetClientStats(0, 0, 0d, 0, 2), client.Stats());
    }

    [Fact]
    public void RemotePlayersAdvanceBetweenFramesAndResetOnSnapshotArrival()
    {
        var transport = new FakeNetTransport();
        using var client = NetworkingTestData.Connect(
            transport, new FakeNetClock(), new SimulationRuntimeTestCollision());
        transport.Deliver(NetProtocol.EncodeSnapshot(SnapshotAt(0d, 0d)));
        transport.Deliver(NetProtocol.EncodeSnapshot(SnapshotAt(0.1d, 10d)));
        transport.Deliver(NetProtocol.EncodeSnapshot(SnapshotAt(0.2d, 20d)));

        Assert.Equal(12.5d, client.RemotePlayers(0.025d)[0].X, 5);
        Assert.Equal(15d, client.RemotePlayers(0.025d)[0].X, 5);

        transport.Deliver(NetProtocol.EncodeSnapshot(SnapshotAt(0.3d, 30d)));

        Assert.Equal(20d, client.RemotePlayers(0d)[0].X, 5);
        Assert.Equal(4, client.Stats().Snapshots);
    }

    [Fact]
    public void EventsRestoreBothServerNumericAndTypeScriptStringUnions()
    {
        var transport = new FakeNetTransport();
        using var client = NetworkingTestData.Connect(
            transport, new FakeNetClock(), new SimulationRuntimeTestCollision());
        transport.Deliver(NetProtocol.EncodeEvents(
        [
            new ShotEvent
            {
                Tick = 3,
                Player = 7,
                WeaponId = "vk47",
                Origin = new Vec3(1d, 2d, 3d),
                Direction = new Vec3(0d, 0d, 1d),
                Suppressed = true,
                ShotIndex = 4,
            },
        ]));

        transport.Deliver(NetProtocol.EncodeControl(NetMessage.Events, new object[]
        {
            new
            {
                type = "impact", tick = 4, position = new { x = 1, y = 2, z = 3 },
                normal = new { x = 0, y = 1, z = 0 }, surface = 2, shooter = 7, penetrated = true,
            },
            new
            {
                type = "hit", tick = 5, attacker = 7, victim = 8, location = "upperArm",
                damage = 12.5, lethal = false, position = new { x = 2, y = 3, z = 4 }, weaponId = "vk47",
            },
            new
            {
                type = "damage", tick = 6, victim = 8, attacker = 7, amount = 12.5,
                direction = new { x = 1, y = 0, z = 0 }, cause = 0,
            },
            new
            {
                type = "kill", tick = 7, killer = 7, victim = 8, assists = new[] { 9 },
                weaponId = "vk47", headshot = true, cause = 0, distance = 31.5,
                killerWasLowHealth = false, victimPosition = new { x = 1, y = 0, z = 2 },
                killerPosition = new { x = 3, y = 0, z = 4 },
            },
            new
            {
                type = "explosion", tick = 8, position = new { x = 1, y = 2, z = 3 },
                radius = 5.5, owner = 7, kind = "killstreak",
            },
            new
            {
                type = "footstep", tick = 9, player = 7, position = new { x = 1, y = 2, z = 3 },
                surface = 1, loud = true,
            },
            new { type = "score_awarded", tick = 10, player = 7, amount = 100, reason = "kill" },
            new { type = "announce", tick = 11, team = 1, line = "Push forward" },
            new
            {
                type = "reload", tick = 12, player = 7, team = 1,
                position = new { x = 2, y = 0, z = 4 },
                data = new { weaponSlot = 2, nested = new { ready = true } },
            },
        }));

        Assert.Collection(client.Events,
            item =>
            {
                var shot = Assert.IsType<ShotEvent>(item);
                Assert.Equal(3, shot.Tick);
                Assert.Equal("vk47", shot.WeaponId);
                Assert.True(shot.Suppressed);
            },
            item => Assert.IsType<ImpactEvent>(item),
            item =>
            {
                var hit = Assert.IsType<HitEvent>(item);
                Assert.Equal(HitLocation.UpperArm, hit.Location);
            },
            item => Assert.IsType<DamageEvent>(item),
            item =>
            {
                var kill = Assert.IsType<KillEvent>(item);
                Assert.Equal([9], kill.Assists);
            },
            item =>
            {
                var explosion = Assert.IsType<ExplosionEvent>(item);
                Assert.Equal("killstreak", explosion.Kind);
            },
            item => Assert.IsType<FootstepEvent>(item),
            item => Assert.IsType<ScoreEvent>(item),
            item =>
            {
                var announce = Assert.IsType<AnnounceEvent>(item);
                Assert.Equal("Push forward", announce.Line);
            },
            item =>
            {
                var generic = Assert.IsType<GenericSimEvent>(item);
                Assert.Equal(SimEventType.Reload, generic.Type);
                Assert.Equal(7, generic.Player);
                Assert.Equal(2, generic.Data!["weaponSlot"]);
                var nested = Assert.IsType<Dictionary<string, object?>>(generic.Data["nested"]);
                Assert.Equal(true, nested["ready"]);
            });

        var drained = client.DrainEvents();
        Assert.Equal(10, drained.Count);
        Assert.Empty(client.Events);
        Assert.Empty(client.DrainEvents());
    }

    [Fact]
    public void UnknownEventDoesNotDiscardKnownEventsInTheSameBatch()
    {
        var transport = new FakeNetTransport();
        using var client = NetworkingTestData.Connect(
            transport, new FakeNetClock(), new SimulationRuntimeTestCollision());

        transport.Deliver(NetProtocol.EncodeControl(NetMessage.Events, new object[]
        {
            new { type = "future_event", tick = 20, data = new { value = 1 } },
            new { type = "announce", tick = 21, team = 1, line = "Known event survived" },
        }));

        var announce = Assert.IsType<AnnounceEvent>(Assert.Single(client.Events));
        Assert.Equal("Known event survived", announce.Line);
    }

    [Fact]
    public void ChatIsBoundedAndOnlyLocalByeDisconnectsTheClient()
    {
        var transport = new FakeNetTransport();
        using var client = NetworkingTestData.Connect(
            transport, new FakeNetClock(), new SimulationRuntimeTestCollision(), localId: 7);
        for (var index = 0; index < 33; index++)
        {
            transport.Deliver(NetProtocol.EncodeControl(NetMessage.Chat, new ChatPayload
            {
                From = index,
                Text = $"message-{index}",
            }));
        }

        Assert.Equal(32, client.Chat.Count);
        Assert.Equal("message-1", client.Chat[0].Text);
        Assert.Equal("message-32", client.Chat[^1].Text);

        transport.Deliver(NetProtocol.EncodeControl(NetMessage.Bye, new ByePayload { Id = 99 }));
        Assert.Equal(NetStatus.Playing, client.Status);

        transport.Deliver(NetProtocol.EncodeControl(NetMessage.Bye, new ByePayload { Id = 7 }));
        Assert.Equal(NetStatus.Disconnected, client.Status);
        Assert.Equal("你已離開伺服器", client.StatusDetail);
        transport.CloseFromRemote();
        Assert.Equal("你已離開伺服器", client.StatusDetail);
    }

    [Fact]
    public void RespawnSayCloseAndDisposeMatchClientLifecycle()
    {
        var (collision, player) = NetworkingTestData.Player();
        var transport = new FakeNetTransport();
        var client = NetworkingTestData.Connect(
            transport, new FakeNetClock(), collision, player.Id);
        transport.ClearSent();

        client.RequestRespawn();
        client.Say("集合到 B 點");

        Assert.Equal(2, transport.Sent.Count);
        var respawn = NetProtocol.DecodeControl<JsonElement>(transport.Sent[0]);
        Assert.Equal(NetMessage.Respawn, respawn.Type);
        Assert.Equal(JsonValueKind.Object, respawn.Payload.ValueKind);
        Assert.Empty(respawn.Payload.EnumerateObject());
        var chat = NetProtocol.DecodeControl<ChatPayload>(transport.Sent[1]);
        Assert.Equal(NetMessage.Chat, chat.Type);
        Assert.Equal(player.Id, chat.Payload.From);
        Assert.Equal("集合到 B 點", chat.Payload.Text);

        client.Tick(player, NetworkingTestData.Forward(1));
        transport.Deliver(NetProtocol.EncodeSnapshot(SnapshotAt(1d, 5d)));
        Assert.Equal(1, client.Stats().Pending);
        Assert.Equal(1, client.Snapshots.Size);

        client.Dispose();
        client.Dispose();

        Assert.Equal(1, transport.CloseCalls);
        Assert.Equal(NetStatus.Disconnected, client.Status);
        Assert.Equal("連線中斷", client.StatusDetail);
        Assert.Equal(0, client.Stats().Pending);
        Assert.Equal(0, client.Snapshots.Size);

        transport.ClearSent();
        client.Say("too late");
        transport.Deliver(NetProtocol.EncodeSnapshot(SnapshotAt(2d, 9d)));
        Assert.Empty(transport.Sent);
        Assert.Equal(0, client.Snapshots.Size);
    }

    private static Snapshot SnapshotAt(double serverTime, double x) => new()
    {
        Tick = (uint)Math.Round(serverTime * GameConstants.TickRate),
        ServerTime = serverTime,
        Players =
        [
            new PlayerSnapshot
            {
                Id = 100,
                Team = (int)Team.Axis,
                Alive = true,
                OnGround = true,
                X = x,
                Health = 100,
            },
        ],
    };
}
