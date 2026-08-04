using System.Text.Json;
using OperationVanguard.Core;
using OperationVanguard.Server;

namespace OperationVanguard.Tests;

public sealed class GameServerTests
{
    private sealed class FakeLink : IClientLink
    {
        public List<byte[]> Sent { get; } = [];
        public string? Closed { get; private set; }

        public void Send(byte[] bytes) => Sent.Add([.. bytes]);

        public void Close(string reason) => Closed = reason;

        public int Count(NetMessage type) =>
            Sent.Count(bytes => NetProtocol.PeekType(bytes) == type);

        public Snapshot? LastSnapshot()
        {
            for (var index = Sent.Count - 1; index >= 0; index--)
            {
                if (NetProtocol.PeekType(Sent[index]) == NetMessage.Snapshot)
                {
                    return NetProtocol.DecodeSnapshot(Sent[index]);
                }
            }

            return null;
        }
    }

    [Fact]
    public void JoinSanitisesIdentityWelcomesAndBalancesTeams()
    {
        using var server = CreateServer();
        var first = new FakeLink();
        var second = new FakeLink();

        var firstId = server.Join(first, Hello("\u0001  Alice-With-A-Name-That-Is-Too-Long  \u007f"));
        var secondId = server.Join(second, Hello("Bob"));

        Assert.NotNull(firstId);
        Assert.NotNull(secondId);
        Assert.Equal(2, server.PlayerCount);
        Assert.Equal("Alice-With-A-Name-Th", server.Sim.World.Players[firstId!.Value].Name);
        Assert.Equal(Team.Allies, server.Sim.World.Players[firstId.Value].Team);
        Assert.Equal(Team.Axis, server.Sim.World.Players[secondId!.Value].Team);

        var welcome = NetProtocol.DecodeControl<WelcomePayload>(first.Sent[0]);
        Assert.Equal(NetMessage.Welcome, welcome.Type);
        Assert.Equal(firstId.Value, welcome.Payload.YourId);
        Assert.Equal("crossfire", welcome.Payload.MapId);
        Assert.Equal("tdm", welcome.Payload.ModeId);
        Assert.Equal(64, welcome.Payload.TickRate);
        Assert.Equal(GameConstants.Network.SnapshotRate, welcome.Payload.SnapshotRate);
    }

    [Fact]
    public void WrongProtocolIsRejectedBeforeCreatingAPlayer()
    {
        using var server = CreateServer();
        var link = new FakeLink();
        var hello = Hello();
        hello.ProtocolVersion++;

        var id = server.Join(link, hello);

        Assert.Null(id);
        Assert.NotNull(link.Closed);
        Assert.Contains("protocol", link.Closed);
        Assert.Equal(NetMessage.Reject, NetProtocol.PeekType(link.Sent[0]));
        Assert.Empty(server.Sim.World.Players);
    }

    [Fact]
    public void MalformedFramesAreConfinedToTheirClient()
    {
        using var server = CreateServer();
        var link = new FakeLink();
        var id = server.Join(link, Hello())!.Value;

        var exception = Record.Exception(() =>
        {
            server.Receive(id, [(byte)NetMessage.Input, 250]);
            server.Receive(id, [(byte)NetMessage.Chat, 255, 255]);
            server.Receive(id, []);
            server.Tick();
        });

        Assert.Null(exception);
        Assert.True(server.Sim.World.Players.ContainsKey(id));
    }

    [Fact]
    public void ClaimedInputDeltaIsClampedToTheProtocolBand()
    {
        using var honest = CreateServer("clamp");
        using var cheat = CreateServer("clamp");
        var honestLink = new FakeLink();
        var cheatLink = new FakeLink();
        var honestId = honest.Join(honestLink, Hello())!.Value;
        var cheatId = cheat.Join(cheatLink, Hello())!.Value;
        var honestStart = MathEx.Clone(honest.Sim.World.Players[honestId].Position);
        var cheatStart = MathEx.Clone(cheat.Sim.World.Players[cheatId].Position);

        for (uint sequence = 1; sequence <= 32; sequence++)
        {
            honest.Receive(honestId, NetProtocol.EncodeInputs([
                Input(sequence, moveForward: 1d, deltaTime: GameConstants.TickDt),
            ]));
            cheat.Receive(cheatId, NetProtocol.EncodeInputs([
                Input(sequence, moveForward: 1d, deltaTime: 5d),
            ]));
            honest.Tick();
            cheat.Tick();
        }

        var honestPosition = honest.Sim.World.Players[honestId].Position;
        var cheatPosition = cheat.Sim.World.Players[cheatId].Position;
        var honestDistance = MathEx.DistanceXz(honestStart, honestPosition);
        var cheatDistance = MathEx.DistanceXz(cheatStart, cheatPosition);

        Assert.True(cheatDistance < honestDistance * 4d + 1d);
    }

    [Fact]
    public void DuplicateResendsCannotAdvanceTheAcknowledgementTwice()
    {
        using var server = CreateServer();
        var link = new FakeLink();
        var id = server.Join(link, Hello())!.Value;
        var frame = NetProtocol.EncodeInputs([Input(1, moveForward: 1d)]);

        for (var repeat = 0; repeat < 10; repeat++)
        {
            server.Receive(id, frame);
        }

        for (var tick = 0; tick < 4; tick++)
        {
            server.Tick();
        }

        Assert.Equal(1u, link.LastSnapshot()!.AckedInput);

        // Once sequence one is folded in, a later resend is discarded outright.
        server.Receive(id, frame);
        for (var tick = 0; tick < 4; tick++)
        {
            server.Tick();
        }
        Assert.Equal(1u, link.LastSnapshot()!.AckedInput);
    }

    [Fact]
    public void SnapshotsUseNetworkCadenceAndPerClientAcknowledgements()
    {
        using var server = CreateServer();
        var first = new FakeLink();
        var second = new FakeLink();
        var firstId = server.Join(first, Hello("A"))!.Value;
        var secondId = server.Join(second, Hello("B"))!.Value;

        for (uint sequence = 1; sequence <= 64; sequence++)
        {
            server.Receive(firstId, NetProtocol.EncodeInputs([Input(sequence)]));
            if (sequence <= 10)
            {
                server.Receive(secondId, NetProtocol.EncodeInputs([Input(sequence)]));
            }
            server.Tick();
        }

        Assert.InRange(
            first.Count(NetMessage.Snapshot),
            GameConstants.Network.SnapshotRate - 2,
            GameConstants.Network.SnapshotRate + 2);
        Assert.Equal(10u, second.LastSnapshot()!.AckedInput);
        Assert.InRange(first.LastSnapshot()!.AckedInput, 61u, 64u);
    }

    [Fact]
    public void LeaveAndTimeoutRemoveMembershipAndBroadcastBye()
    {
        using var server = CreateServer();
        var first = new FakeLink();
        var second = new FakeLink();
        var firstId = server.Join(first, Hello("A"))!.Value;
        var secondId = server.Join(second, Hello("B"))!.Value;

        server.Leave(firstId);

        Assert.False(server.Sim.World.Players.ContainsKey(firstId));
        Assert.Equal(1, second.Count(NetMessage.Bye));

        for (var tick = 0;
             tick <= (int)(GameConstants.Network.TimeoutSeconds / GameConstants.TickDt);
             tick++)
        {
            server.Tick();
        }
        Assert.False(server.Sim.World.Players.ContainsKey(secondId));
        Assert.Equal(0, server.PlayerCount);
    }

    [Fact]
    public void BotsAndHumanShareOneAuthoritativeMatch()
    {
        using var server = new GameServer(new GameServerOptions
        {
            MapId = "crossfire",
            ModeId = "tdm",
            Seed = "bot-room",
            BotCount = 6,
        });
        var link = new FakeLink();
        var id = server.Join(link, Hello())!.Value;
        var eventCount = 0;
        uint sequence = 1;

        for (var tick = 0; tick < 8; tick++)
        {
            if (tick % 4 == 0)
            {
                server.Receive(id, NetProtocol.EncodeInputs([
                    Input(sequence++, moveForward: 1d),
                ]));
            }

            eventCount += server.Tick().Count;
        }

        Assert.Equal(7, server.Sim.World.Players.Count);
        Assert.True(eventCount > 0);
        var snapshot = link.LastSnapshot()!;
        Assert.Equal(7, snapshot.Players.Count);
        Assert.Equal(6, snapshot.Players.Count(player => player.IsBot));
        Assert.NotNull(snapshot.Extension);
        Assert.Equal(snapshot.Players.Count, snapshot.Extension.Players.Count);
        Assert.Equal(server.Sim.World.Match.Phase, snapshot.Extension.Match.Phase);
    }

    [Fact]
    public void AuthoritativeEventsUseWebStringDiscriminants()
    {
        using var server = CreateServer("event-wire");
        var link = new FakeLink();
        var id = server.Join(link, Hello())!.Value;
        server.Sim.World.Match.Phase = MatchPhase.Live;
        server.Sim.World.Match.TimeRemaining = 60d;

        var input = Input(1);
        input.Buttons = (uint)InputFlag.Fire;
        server.Receive(id, NetProtocol.EncodeInputs([input]));
        server.Tick(1d / GameConstants.Network.SnapshotRate);

        var frame = Assert.Single(
            link.Sent,
            bytes => NetProtocol.PeekType(bytes) == NetMessage.Events);
        var payload = NetProtocol.DecodeControl<JsonElement>(frame).Payload;
        Assert.NotEmpty(payload.EnumerateArray());
        Assert.All(
            payload.EnumerateArray(),
            item => Assert.Equal(JsonValueKind.String, item.GetProperty("type").ValueKind));
    }

    [Fact]
    public void PingChatAndMalformedLoadoutRemainSafe()
    {
        using var server = CreateServer();
        var link = new FakeLink();
        using var loadoutJson = JsonDocument.Parse("{\"primary\":17,\"perks\":\"bad\"}");
        var hello = Hello("Talker");
        hello.Loadout = loadoutJson.RootElement.Clone();
        var id = server.Join(link, hello)!.Value;

        server.Receive(id, NetProtocol.EncodeControl(NetMessage.Ping, new { nonce = 42 }));
        server.Receive(id, NetProtocol.EncodeControl(NetMessage.Chat, new
        {
            text = new string('x', GameConstants.Network.MaximumChatLength + 20),
        }));
        server.Tick();

        Assert.Equal(1, link.Count(NetMessage.Pong));
        var chatFrame = link.Sent.Last(bytes => NetProtocol.PeekType(bytes) == NetMessage.Chat);
        var chat = NetProtocol.DecodeControl<ChatPayload>(chatFrame).Payload;
        Assert.Equal(id, chat.From);
        Assert.Equal(GameConstants.Network.MaximumChatLength, chat.Text.Length);
        Assert.True(server.Sim.World.Players.ContainsKey(id));
    }

    private static GameServer CreateServer(string? seed = null) => new(new GameServerOptions
    {
        MapId = "crossfire",
        ModeId = "tdm",
        Seed = seed,
    });

    private static HelloPayload Hello(string name = "Tester") => new()
    {
        ProtocolVersion = GameConstants.Network.ProtocolVersion,
        Name = name,
        Loadout = LoadoutSystem.DefaultLoadout(),
    };

    private static WireInput Input(
        uint sequence,
        double moveForward = 0d,
        double deltaTime = GameConstants.TickDt) => new()
        {
            Seq = sequence,
            Tick = sequence,
            Dt = deltaTime,
            MoveForward = moveForward,
            MoveRight = 0d,
            Yaw = 0d,
            Pitch = 0d,
            Buttons = 0,
            WeaponSlot = 0,
        };
}
