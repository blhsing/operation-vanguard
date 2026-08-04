using System.Text.Json;
using OperationVanguard.Core;

namespace OperationVanguard.Tests;

public sealed class ProtocolParityTests
{
    [Fact]
    public void AnglePackingMatchesUnsignedJavaScriptTurns()
    {
        foreach (var sample in ParityFixture.Protocol.GetProperty("angles").EnumerateArray())
        {
            var packed = NetProtocol.PackAngle(sample.GetProperty("radians").GetDouble());
            Assert.Equal(sample.GetProperty("packed").GetUInt16(), packed);
            Assert.Equal(sample.GetProperty("unpacked").GetDouble(), NetProtocol.UnpackAngle(packed));
        }
    }

    [Fact]
    public void Utf8ControlFrameIsByteIdentical()
    {
        var expected = ParityFixture.Protocol.GetProperty("control");
        var loadout = new Dictionary<string, object?>
        {
            ["primary"] = "vk47",
            ["attachments"] = new[] { "red_dot", "foregrip" },
        };
        var actual = NetProtocol.EncodeControl(NetMessage.Hello, new HelloPayload
        {
            ProtocolVersion = 8,
            Name = "先鋒 🎮",
            Loadout = loadout,
        });
        Assert.Equal(Convert.FromBase64String(expected.GetProperty("base64").GetString()!), actual);

        var decoded = NetProtocol.DecodeControl<HelloPayload>(actual);
        Assert.Equal(NetMessage.Hello, decoded.Type);
        Assert.Equal(8, decoded.Payload.ProtocolVersion);
        Assert.Equal("先鋒 🎮", decoded.Payload.Name);
    }

    [Fact]
    public void EventFrameIsByteIdenticalToWebStringUnions()
    {
        var fixture = ParityFixture.Protocol.GetProperty("events");
        SimEvent[] events =
        [
            new HitEvent
            {
                Tick = 17,
                Attacker = 7,
                Victim = 9,
                Location = HitLocation.UpperArm,
                Damage = 33.5,
                Lethal = false,
                Position = new Vec3(1.25, 2, -3.5),
                WeaponId = "vk47",
            },
            new FootstepEvent
            {
                Tick = 18,
                Player = 9,
                Position = new Vec3(-4, .125, 6.5),
                Surface = SurfaceType.Wood,
                Loud = true,
            },
            new DamageEvent
            {
                Tick = 19,
                Victim = 9,
                Attacker = 7,
                Amount = 12.25,
                Direction = new Vec3(0, .5, -1),
                Cause = DamageCause.Explosion,
            },
            new ExplosionEvent
            {
                Tick = 20,
                Position = new Vec3(8, 1, -2),
                Radius = 5.5,
                Owner = 7,
                Kind = ProjectileKind.Frag,
            },
            new GenericSimEvent(SimEventType.RoundStart)
            {
                Tick = 21,
                Player = 7,
                Team = Team.Allies,
                Position = new Vec3(3, 0, 4),
                Data = new Dictionary<string, object?>
                {
                    ["round"] = 2,
                    ["phase"] = MatchPhase.Live,
                },
            },
        ];

        var actual = NetProtocol.EncodeEvents(events);
        Assert.Equal(Convert.FromBase64String(fixture.GetProperty("base64").GetString()!), actual);

        var payload = NetProtocol.DecodeControl<JsonElement>(actual).Payload.EnumerateArray().ToArray();
        Assert.Equal("hit", payload[0].GetProperty("type").GetString());
        Assert.Equal("upperArm", payload[0].GetProperty("location").GetString());
        Assert.Equal(JsonValueKind.Number, payload[1].GetProperty("surface").ValueKind);
        Assert.Equal((int)SurfaceType.Wood, payload[1].GetProperty("surface").GetInt32());
        Assert.Equal(JsonValueKind.Number, payload[2].GetProperty("cause").ValueKind);
        Assert.Equal(JsonValueKind.Number, payload[3].GetProperty("kind").ValueKind);
        Assert.Equal("round_start", payload[4].GetProperty("type").GetString());
        Assert.Equal(JsonValueKind.Number, payload[4].GetProperty("team").ValueKind);
        Assert.Equal(JsonValueKind.Number, payload[4].GetProperty("data").GetProperty("phase").ValueKind);
    }

    [Fact]
    public void EveryEventDiscriminantMatchesTheWebEnum()
    {
        string[] expected =
        [
            "shot", "impact", "hit", "kill", "damage", "reload", "reload_complete",
            "weapon_swap", "melee", "footstep", "jump", "land", "slide", "mantle",
            "spawn", "death", "projectile_thrown", "explosion", "flash",
            "objective_captured", "objective_contested", "objective_neutralized",
            "bomb_planted", "bomb_defused", "killstreak_earned", "killstreak_called",
            "killstreak_destroyed", "score_awarded", "medal_earned", "match_state_changed",
            "round_start", "round_end", "chat", "announce", "tag_collected",
            "deployable_placed", "deployable_destroyed",
        ];
        var events = Enum.GetValues<SimEventType>()
            .Select(type => (SimEvent)new GenericSimEvent(type))
            .ToArray();

        var payload = NetProtocol.DecodeControl<JsonElement>(NetProtocol.EncodeEvents(events))
            .Payload
            .EnumerateArray()
            .Select(item => item.GetProperty("type").GetString())
            .ToArray();

        Assert.Equal(expected, payload);
    }

    [Fact]
    public void SnapshotFrameIsByteIdentical()
    {
        var fixture = ParityFixture.Protocol.GetProperty("snapshot");
        var value = fixture.GetProperty("value");
        var snapshot = new Snapshot
        {
            Tick = value.GetProperty("tick").GetUInt32(),
            ServerTime = value.GetProperty("serverTime").GetDouble(),
            AckedInput = value.GetProperty("ackedInput").GetUInt32(),
            Players = value.GetProperty("players").EnumerateArray().Select(ReadPlayer).ToList(),
        };
        var encoded = NetProtocol.EncodeSnapshot(snapshot);
        Assert.Equal(Convert.FromBase64String(fixture.GetProperty("base64").GetString()!), encoded);

        var decoded = NetProtocol.DecodeSnapshot(encoded);
        Assert.Equal(snapshot.Tick, decoded.Tick);
        Assert.Equal(snapshot.AckedInput, decoded.AckedInput);
        Assert.Equal(snapshot.Players.Count, decoded.Players.Count);
        Assert.Equal((float)snapshot.ServerTime, decoded.ServerTime);
        Assert.Equal((float)snapshot.Players[0].X, decoded.Players[0].X);
        Assert.Equal(-48 / 127d, decoded.Players[0].Lean);
    }

    [Fact]
    public void NativeSnapshotExtensionRoundTripsWithoutChangingLegacyFrames()
    {
        var legacy = new Snapshot
        {
            Tick = 7,
            ServerTime = 1.5,
            AckedInput = 4,
            Players = [new PlayerSnapshot { Id = 3, Alive = true, Health = 100 }],
        };
        var legacyBytes = NetProtocol.EncodeSnapshot(legacy);
        var extended = new Snapshot
        {
            Tick = legacy.Tick,
            ServerTime = legacy.ServerTime,
            AckedInput = legacy.AckedInput,
            Players = legacy.Players,
            Extension = new SnapshotExtension
            {
                Match = new SnapshotMatchState
                {
                    Phase = MatchPhase.Live,
                    TimeRemaining = 321.5,
                    Round = 2,
                    Winner = Team.Allies,
                    Scores = [new TeamScore { Team = Team.Allies, Score = 75, RoundsWon = 1 }],
                },
                Objectives = [new ObjectiveSummaryEntry("B", Team.Axis, .45, true, true)],
                Players =
                [
                    new PlayerCombatSnapshot
                    {
                        Id = 3,
                        AdsProgress = .8,
                        Score = 900,
                        Weapons = [new WeaponCombatSnapshot { DefId = "vk47", AmmoInMag = 17 }],
                    },
                ],
            },
        };

        var bytes = NetProtocol.EncodeSnapshot(extended);
        Assert.True(bytes.AsSpan(0, legacyBytes.Length).SequenceEqual(legacyBytes));
        Assert.True(bytes.Length > legacyBytes.Length);

        var decoded = NetProtocol.DecodeSnapshot(bytes);
        Assert.NotNull(decoded.Extension);
        Assert.Equal(MatchPhase.Live, decoded.Extension.Match.Phase);
        Assert.Equal(321.5, decoded.Extension.Match.TimeRemaining);
        Assert.Equal(75, Assert.Single(decoded.Extension.Match.Scores).Score);
        Assert.Equal("B", Assert.Single(decoded.Extension.Objectives).Label);
        Assert.Equal(17, Assert.Single(Assert.Single(decoded.Extension.Players).Weapons).AmmoInMag);
    }

    [Fact]
    public void InputBatchKeepsTheNewestSixteenAndMatchesEveryByte()
    {
        var fixture = ParityFixture.Protocol.GetProperty("inputs");
        var inputs = fixture.GetProperty("source").EnumerateArray().Select(ReadInput).ToArray();
        var encoded = NetProtocol.EncodeInputs(inputs);
        Assert.Equal(Convert.FromBase64String(fixture.GetProperty("base64").GetString()!), encoded);

        var decoded = NetProtocol.DecodeInputs(encoded);
        Assert.Equal(fixture.GetProperty("encodedCount").GetInt32(), decoded.Count);
        Assert.Equal(inputs[^decoded.Count].Seq, decoded[0].Seq);
        Assert.Equal(inputs[^1].Seq, decoded[^1].Seq);
    }

    private static PlayerSnapshot ReadPlayer(JsonElement value) => new()
    {
        Id = value.GetProperty("id").GetInt32(),
        Team = value.GetProperty("team").GetInt32(),
        Alive = value.GetProperty("alive").GetBoolean(),
        OnGround = value.GetProperty("onGround").GetBoolean(),
        IsBot = value.GetProperty("isBot").GetBoolean(),
        Stance = value.GetProperty("stance").GetInt32(),
        MoveState = value.GetProperty("moveState").GetInt32(),
        X = value.GetProperty("x").GetDouble(),
        Y = value.GetProperty("y").GetDouble(),
        Z = value.GetProperty("z").GetDouble(),
        Vx = value.GetProperty("vx").GetDouble(),
        Vy = value.GetProperty("vy").GetDouble(),
        Vz = value.GetProperty("vz").GetDouble(),
        Yaw = value.GetProperty("yaw").GetDouble(),
        Pitch = value.GetProperty("pitch").GetDouble(),
        Health = value.GetProperty("health").GetInt32(),
        WeaponSlot = value.GetProperty("weaponSlot").GetInt32(),
        Lean = value.GetProperty("lean").GetDouble(),
    };

    private static WireInput ReadInput(JsonElement value) => new()
    {
        Seq = value.GetProperty("seq").GetUInt32(),
        Tick = value.GetProperty("tick").GetUInt32(),
        Dt = value.GetProperty("dt").GetDouble(),
        MoveForward = value.GetProperty("moveForward").GetDouble(),
        MoveRight = value.GetProperty("moveRight").GetDouble(),
        Yaw = value.GetProperty("yaw").GetDouble(),
        Pitch = value.GetProperty("pitch").GetDouble(),
        Buttons = value.GetProperty("buttons").GetUInt32(),
        WeaponSlot = value.GetProperty("weaponSlot").GetInt32(),
    };
}
