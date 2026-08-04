using System.Collections.Concurrent;
using System.Text.Json;
using OperationVanguard.Core;
using OperationVanguard.Game;

namespace OperationVanguard.Game.Tests;

public sealed class OnlineSessionTests
{
    [Fact]
    public void WaitsForWelcomeThenAdoptsServerIdAndPredictsLocally()
    {
        var transport = new PumpedFakeTransport();
        using var session = CreateSession(transport);

        Assert.Equal(NetStatus.Connecting, session.Status);
        Assert.Null(session.Player);
        Assert.Equal(0, session.LocalId);
        Assert.Equal("crossfire", session.Map.Id);
        Assert.Equal("tdm", session.Mode.Id);
        Assert.Same(session.Simulation.World, session.World);

        transport.CompleteOpen();
        Assert.Equal(1, session.PumpNetwork());
        var helloFrame = Assert.Single(transport.Sent);
        var hello = NetProtocol.DecodeControl<JsonElement>(helloFrame);
        Assert.Equal(NetMessage.Hello, hello.Type);
        Assert.Equal("Native Alice", hello.Payload.GetProperty("name").GetString());

        transport.Deliver(Welcome(41));
        session.PumpNetwork();

        Assert.Equal(NetStatus.Playing, session.Status);
        Assert.Equal(41, session.LocalId);
        Assert.True(session.IsReady);
        Assert.NotNull(session.Player);
        Assert.Equal("Native Alice", session.Player.Name);
        Assert.True(session.Player.Alive);
        Assert.Equal(Team.None, session.Player.Team);

        var spawn = session.Map.Spawns[0];
        MathEx.Copy(session.Player.Position, spawn.Position);
        session.Player.OnGround = true;
        var before = (session.Player.Position.X, session.Player.Position.Y, session.Player.Position.Z);
        var input = Input(moveForward: 1d);
        session.Tick(input);

        Assert.Equal(1, input.Seq);
        Assert.NotEqual(before,
            (session.Player.Position.X, session.Player.Position.Y, session.Player.Position.Z));
        Assert.Equal(1, session.NetworkStats.Pending);
        Assert.Same(input, session.LastInput);
    }

    [Fact]
    public void WelcomeReconfiguresPresentationWithoutASecondConnection()
    {
        var transport = new PumpedFakeTransport();
        using var session = CreateSession(transport);
        var provisional = session.Simulation;

        transport.CompleteOpen();
        session.PumpNetwork();
        Assert.Equal(1, transport.OpenCalls);
        Assert.Single(transport.Sent);

        transport.Deliver(Welcome(
            73,
            mapId: "subway",
            modeId: "domination",
            seed: "authoritative-room"));
        session.PumpNetwork();

        Assert.Equal(NetStatus.Playing, session.Status);
        Assert.Equal(73, session.LocalId);
        Assert.Equal("subway", session.Map.Id);
        Assert.Equal("domination", session.Mode.Id);
        Assert.Equal("authoritative-room", session.Options.Seed);
        Assert.NotSame(provisional, session.Simulation);
        Assert.Equal(1, transport.OpenCalls);
        Assert.Equal(0, transport.CloseCalls);
        Assert.Single(transport.Sent);
    }

    [Fact]
    public void InterpolatesRemoteRosterAndRemovesPlayersMissingFromNewFrames()
    {
        var transport = new PumpedFakeTransport();
        using var session = CreatePlayingSession(transport, localId: 7);

        transport.Deliver(SnapshotFrame(0d, 7, Remote(9, 0d)));
        transport.Deliver(SnapshotFrame(0.1d, 7, Remote(9, 10d)));
        transport.Deliver(SnapshotFrame(0.2d, 7, Remote(9, 20d)));
        session.Tick(Input(), GameConstants.TickDt);

        var remote = session.World.Players[9];
        Assert.Equal(11.5625d, remote.Position.X, 4);
        Assert.Equal(Team.Axis, remote.Team);
        Assert.Equal(Stance.Crouch, remote.Stance);
        Assert.Equal(MoveState.Sprint, remote.MoveState);
        Assert.True(remote.IsBot);
        Assert.Equal(80d, remote.Health);

        transport.Deliver(SnapshotFrame(0.3d, 7));
        transport.Deliver(SnapshotFrame(0.4d, 7));
        transport.Deliver(SnapshotFrame(0.5d, 7));
        session.Tick(Input());

        Assert.False(session.World.Players.ContainsKey(9));
        Assert.True(session.World.Players.ContainsKey(7));
    }

    [Fact]
    public void DrainsWireEventsAndRequestsRespawnOnFireWhileDead()
    {
        var transport = new PumpedFakeTransport();
        using var session = CreatePlayingSession(transport, localId: 12);
        transport.ClearSent();
        session.Player!.Alive = false;
        transport.Deliver(NetProtocol.EncodeControl(NetMessage.Events, new object[]
        {
            new AnnounceEvent
            {
                Tick = 8,
                Team = Team.Allies,
                Line = "Reinforcements inbound",
            },
        }));

        session.Tick(Input(buttons: InputFlag.Fire));

        var announcement = Assert.IsType<AnnounceEvent>(Assert.Single(session.LastEvents));
        Assert.Equal("Reinforcements inbound", announcement.Line);
        Assert.Contains(transport.Sent,
            frame => NetProtocol.PeekType(frame) == NetMessage.Respawn);
        Assert.Contains(transport.Sent,
            frame => NetProtocol.PeekType(frame) == NetMessage.Input);

        session.Tick(Input());
        Assert.Empty(session.LastEvents);

        transport.ClearSent();
        session.Say("Push now");
        var chat = NetProtocol.DecodeControl<ChatPayload>(Assert.Single(transport.Sent));
        Assert.Equal(12, chat.Payload.From);
        Assert.Equal("Push now", chat.Payload.Text);
    }

    [Fact]
    public void CancellationClosesConnectionAndDisposeReleasesOwnedTransportOnce()
    {
        using var cancellation = new CancellationTokenSource();
        var transport = new PumpedFakeTransport();
        var session = CreatePlayingSession(transport, localId: 4, cancellation.Token);

        cancellation.Cancel();
        session.PumpNetwork();

        Assert.Equal(NetStatus.Disconnected, session.Status);
        Assert.Equal("連線中斷", session.StatusDetail);
        Assert.Equal(1, transport.CloseCalls);

        session.Dispose();
        session.Dispose();

        Assert.True(session.IsDisposed);
        Assert.True(transport.Disposed);
        Assert.Equal(1, transport.CloseCalls);
        Assert.Throws<ObjectDisposedException>(() => session.Tick(Input()));
    }

    [Fact]
    public void AppliesAuthoritativeLocalVitalsClockScoreAndMatchCompletion()
    {
        var transport = new PumpedFakeTransport();
        var online = CreatePlayingSession(transport, localId: 22);
        using var session = new NativeSession(online);
        transport.Deliver(NetProtocol.EncodeSnapshot(new Snapshot
        {
            Tick = 320,
            ServerTime = 5d,
            Extension = new SnapshotExtension
            {
                Match = new SnapshotMatchState
                {
                    Phase = MatchPhase.MatchEnd,
                    TimeRemaining = 4,
                    Round = 2,
                    Winner = Team.Allies,
                    Scores = [new TeamScore { Team = Team.Allies, Score = 75 }],
                },
                Objectives = [new ObjectiveSummaryEntry("B", Team.Axis, .5, true, true)],
                Players =
                [
                    new PlayerCombatSnapshot
                    {
                        Id = 22,
                        MaxHealth = 100,
                        AdsProgress = .8,
                        Score = 250,
                        LethalCount = 1,
                        Weapons =
                        [
                            new WeaponCombatSnapshot
                            {
                                DefId = online.Options.Loadout.Primary,
                                AmmoInMag = 19,
                                AmmoReserve = 60,
                            },
                            new WeaponCombatSnapshot
                            {
                                DefId = online.Options.Loadout.Secondary,
                                AmmoInMag = 7,
                                AmmoReserve = 21,
                            },
                        ],
                    },
                ],
            },
            Players =
            [
                new PlayerSnapshot
                {
                    Id = 22,
                    Team = (int)Team.Allies,
                    Alive = false,
                    Health = 0,
                    Stance = (int)Stance.Prone,
                    MoveState = (int)MoveState.Idle,
                    WeaponSlot = (int)WeaponSlot.Secondary,
                },
            ],
        }));
        transport.Deliver(NetProtocol.EncodeControl(NetMessage.Events, new object[]
        {
            new ScoreEvent { Tick = 320, Player = 22, Amount = 250, Reason = "objective" },
            new GenericSimEvent(SimEventType.MatchStateChanged)
            {
                Tick = 320,
                Data = new Dictionary<string, object?>
                {
                    ["phase"] = MatchPhase.MatchEnd,
                    ["winner"] = Team.Allies,
                },
            },
        }));

        session.Tick(Input(), GameConstants.TickDt);

        Assert.Equal(320, session.World.Tick);
        Assert.Equal(5d, session.World.Time, 3);
        Assert.False(session.Player.Alive);
        Assert.Equal(0d, session.Player.Health);
        Assert.Equal(Team.Allies, session.Player.Team);
        Assert.Equal(Stance.Stand, session.Player.Stance);
        Assert.Equal(WeaponSlot.Secondary, session.Player.ActiveSlot);
        Assert.Equal(250d, session.Player.Score);
        Assert.Equal(7, WeaponSystem.ActiveWeapon(session.Player)!.AmmoInMag);
        Assert.Equal(75, Assert.Single(session.World.Match.Scores).Score);
        Assert.Equal("B", Assert.Single(session.ObjectiveStatus()).Label);
        Assert.Equal(MatchPhase.MatchEnd, session.World.Match.Phase);
        Assert.Equal(Team.Allies, session.Winner);
        Assert.True(session.IsComplete);
        Assert.Equal(NativeSessionKind.Online, session.Kind);
        Assert.Equal(NetStatus.Playing, session.NetworkStatus);
        Assert.NotNull(session.NetworkStats);
    }

    [Fact]
    public void UsesNewestDiscreteLocalStateAndAppliesEachCombatExtensionOnce()
    {
        var transport = new PumpedFakeTransport();
        using var session = CreatePlayingSession(transport, localId: 31);
        session.Player!.Alive = false;

        transport.Deliver(NetProtocol.EncodeSnapshot(new Snapshot
        {
            Tick = 1,
            ServerTime = 0,
            Players =
            [
                new PlayerSnapshot { Id = 31, Alive = false, Health = 0, X = 1 },
            ],
        }));
        transport.Deliver(NetProtocol.EncodeSnapshot(new Snapshot
        {
            Tick = 7,
            ServerTime = .1,
            Players =
            [
                new PlayerSnapshot
                {
                    Id = 31,
                    Team = (int)Team.Allies,
                    Alive = true,
                    Health = 100,
                    OnGround = true,
                    X = 42,
                },
            ],
            Extension = new SnapshotExtension
            {
                Match = new SnapshotMatchState
                {
                    Phase = MatchPhase.Live,
                    TimeRemaining = 30,
                },
                Players =
                [
                    new PlayerCombatSnapshot
                    {
                        Id = 31,
                        MaxHealth = 100,
                        Weapons =
                        [
                            new WeaponCombatSnapshot
                            {
                                DefId = session.Options.Loadout.Primary,
                                AmmoInMag = 17,
                                AmmoReserve = 60,
                            },
                            new WeaponCombatSnapshot
                            {
                                DefId = session.Options.Loadout.Secondary,
                                AmmoInMag = 8,
                                AmmoReserve = 24,
                            },
                        ],
                    },
                ],
            },
        }));

        session.Tick(Input());

        Assert.True(session.Player.Alive);
        Assert.Equal(100, session.Player.Health);
        Assert.InRange(session.Player.Position.X, 40, 43);
        var weapon = WeaponSystem.ActiveWeapon(session.Player)!;
        Assert.Equal(17, weapon.AmmoInMag);
        var firstTime = session.World.Time;

        // Presentation prediction is allowed to advance between packets. The
        // same latest extension must not overwrite it again on every frame.
        weapon.AmmoInMag = 11;
        session.Tick(Input());

        Assert.Equal(11, WeaponSystem.ActiveWeapon(session.Player)!.AmmoInMag);
        Assert.True(session.World.Time > firstTime);
        Assert.True(session.World.Match.TimeRemaining < 30);
    }

    private static OnlineSession CreateSession(
        PumpedFakeTransport transport,
        CancellationToken cancellationToken = default) => new(new OnlineSessionOptions
        {
            ServerUrl = "ws://native.test:8790",
            MapId = "crossfire",
            ModeId = "tdm",
            Seed = "online-session-test",
            PlayerName = "Native Alice",
            Loadout = LoadoutSystem.DefaultLoadout("Native"),
        }, transport, new FixedNetClock(), cancellationToken);

    private static OnlineSession CreatePlayingSession(
        PumpedFakeTransport transport,
        int localId,
        CancellationToken cancellationToken = default)
    {
        var session = CreateSession(transport, cancellationToken);
        transport.CompleteOpen();
        session.PumpNetwork();
        transport.Deliver(Welcome(localId));
        session.PumpNetwork();
        transport.ClearSent();
        return session;
    }

    private static byte[] Welcome(
        int id,
        string mapId = "crossfire",
        string modeId = "tdm",
        string seed = "server-seed") =>
        NetProtocol.EncodeControl(NetMessage.Welcome, new WelcomePayload
        {
            YourId = id,
            MapId = mapId,
            ModeId = modeId,
            Seed = seed,
            TickRate = GameConstants.TickRate,
            SnapshotRate = GameConstants.Network.SnapshotRate,
        });

    private static byte[] SnapshotFrame(double time, int localId, PlayerSnapshot? remote = null)
    {
        var players = new List<PlayerSnapshot>
        {
            new()
            {
                Id = localId,
                Team = (int)Team.Allies,
                Alive = true,
                OnGround = true,
                X = 100d,
                Health = 100,
            },
        };
        if (remote is not null)
        {
            players.Add(remote);
        }

        return NetProtocol.EncodeSnapshot(new Snapshot
        {
            Tick = (uint)Math.Round(time * GameConstants.TickRate),
            ServerTime = time,
            AckedInput = 0,
            Players = players,
        });
    }

    private static PlayerSnapshot Remote(int id, double x) => new()
    {
        Id = id,
        Team = (int)Team.Axis,
        Alive = true,
        OnGround = true,
        IsBot = true,
        Stance = (int)Stance.Crouch,
        MoveState = (int)MoveState.Sprint,
        X = x,
        Y = 2d,
        Z = 4d,
        Vx = 3d,
        Yaw = 0.5d,
        Pitch = -0.2d,
        Lean = 0.3d,
        Health = 80,
    };

    private static InputCommand Input(
        double moveForward = 0d,
        InputFlag buttons = InputFlag.None) => new()
        {
            Tick = 1,
            Dt = GameConstants.TickDt,
            MoveForward = moveForward,
            Buttons = (int)buttons,
            KillstreakSlot = -1,
        };

    private sealed class FixedNetClock : INetClock
    {
        public double NowMilliseconds => 1_000d;
    }

    private sealed class PumpedFakeTransport :
        INetClientTransport,
        IPumpableNetClientTransport,
        IDisposable
    {
        private readonly ConcurrentQueue<Action> _notifications = new();
        private bool _closed;

        public bool IsOpen { get; private set; }
        public bool Disposed { get; private set; }
        public int CloseCalls { get; private set; }
        public int OpenCalls { get; private set; }
        public string OpenedUrl { get; private set; } = string.Empty;
        public List<byte[]> Sent { get; } = [];

        public event Action? Opened;
        public event Action<byte[]>? MessageReceived;
        public event Action? Closed;
        public event Action? Error
        {
            add { }
            remove { }
        }

        public void Open(string url)
        {
            OpenCalls++;
            OpenedUrl = url;
        }

        public void Send(byte[] bytes) => Sent.Add(bytes.ToArray());

        public void Close()
        {
            if (_closed)
            {
                return;
            }

            _closed = true;
            CloseCalls++;
            IsOpen = false;
            _notifications.Enqueue(() => Closed?.Invoke());
        }

        public int Pump(int maximumNotifications = 256)
        {
            var count = 0;
            while (count < maximumNotifications && _notifications.TryDequeue(out var notification))
            {
                notification();
                count++;
            }

            return count;
        }

        public void CompleteOpen()
        {
            IsOpen = true;
            _notifications.Enqueue(() => Opened?.Invoke());
        }

        public void Deliver(byte[] bytes)
        {
            var copy = bytes.ToArray();
            _notifications.Enqueue(() => MessageReceived?.Invoke(copy));
        }

        public void ClearSent() => Sent.Clear();

        public void Dispose()
        {
            Close();
            Disposed = true;
        }
    }
}
