using System.Diagnostics;
using System.Globalization;
using OperationVanguard.Core;

namespace OperationVanguard.Tests;

[Collection(SimulationParityCollection.Name)]
public sealed class MatchParityTests
{
    private sealed class MatchHarness
    {
        public required GameSimulation Simulation { get; init; }
        public required BotController Bots { get; init; }
        public required NavGraph Navigation { get; init; }
        public List<SimEvent> Events { get; } = [];

        public void Run(double seconds)
        {
            var ticks = JsRound(seconds / GameConstants.TickDt);
            for (var tick = 0; tick < ticks; tick++)
            {
                Bots.Update(GameConstants.TickDt);
                Events.AddRange(Simulation.Step(GameConstants.TickDt));
            }
        }
    }

    private sealed record NavigationFixture(GameSimulation Simulation, NavGraph Navigation);

    private static readonly IReadOnlyDictionary<string, Lazy<NavigationFixture>> NavigationByMap =
        Maps.Ids.ToDictionary(
            mapId => mapId,
            mapId => new Lazy<NavigationFixture>(
                () =>
                {
                    var simulation = CreateSimulation(mapId, "tdm");
                    return new NavigationFixture(
                        simulation,
                        new NavGraph(simulation.Map, simulation.Collision));
                },
                LazyThreadSafetyMode.ExecutionAndPublication),
            StringComparer.Ordinal);

    private static readonly Lazy<MatchHarness> HardenedMatch = new(
        () =>
        {
            var harness = MakeMatch(botCount: 10, difficulty: BotData.Difficulties["hardened"]);
            harness.Run(75d);
            return harness;
        },
        LazyThreadSafetyMode.ExecutionAndPublication);

    private static readonly Lazy<MatchHarness> BoundsMatch = new(
        () =>
        {
            var harness = MakeMatch(botCount: 12);
            harness.Run(45d);
            return harness;
        },
        LazyThreadSafetyMode.ExecutionAndPublication);

    [Fact]
    public void NavigationCoversCrossfireAsOneConnectedRegion()
    {
        var navigation = Navigation("crossfire");

        Assert.True(navigation.Size > 200);
        Assert.Equal(1d, navigation.Connectivity());
        Assert.All(navigation.Nodes, node => Assert.NotEmpty(node.Edges));
    }

    [Fact]
    public void NavigationPathsBetweenOppositeMapEnds()
    {
        var navigation = Navigation("crossfire");
        var alliedEnd = navigation.NearestNode(new Vec3(0d, 0d, 34d), 20d);
        var axisEnd = navigation.NearestNode(new Vec3(0d, 0d, -34d), 20d);

        Assert.True(alliedEnd >= 0);
        Assert.True(axisEnd >= 0);

        var path = navigation.FindPath(alliedEnd, axisEnd);
        Assert.True(path.Count > 3);
        Assert.Equal(alliedEnd, path[0]);
        Assert.Equal(axisEnd, path[^1]);
    }

    [Fact]
    public void NavigationPreservesAuthoredCrossfireCover()
    {
        var navigation = Navigation("crossfire");

        Assert.True(navigation.Nodes.Count(node => node.IsCover) > 15);
    }

    [Fact]
    public void NavigationReachesCrossfireElevatedCatwalk()
    {
        var navigation = Navigation("crossfire");
        var elevated = navigation.Nodes.Where(node => node.Position.Y > 3d).ToArray();
        Assert.NotEmpty(elevated);

        var ground = navigation.NearestNode(new Vec3(0d, 0d, 20d), 20d);
        Assert.NotEmpty(navigation.FindPath(ground, elevated[0].Id));
    }

    [Theory]
    [InlineData("crossfire")]
    [InlineData("refinery")]
    [InlineData("shipment_yard")]
    [InlineData("highrise")]
    [InlineData("dust_market")]
    [InlineData("subway")]
    public void EverySpawnHasNavigationOnTheSameFloor(string mapId)
    {
        var fixture = NavigationFixtureFor(mapId);
        var orphaned = fixture.Simulation.Map.Spawns.Where(spawn =>
        {
            var index = fixture.Navigation.NearestNode(spawn.Position, 14d);
            return index < 0 ||
                   Math.Abs(fixture.Navigation.Nodes[index].Position.Y - spawn.Position.Y) > 2d;
        }).ToArray();

        Assert.True(
            orphaned.Length == 0,
            $"{mapId}: orphaned spawns: {string.Join(", ", orphaned.Select(spawn =>
                $"{spawn.Group} @ {spawn.Position.X},{spawn.Position.Z}"))}");
    }

    [Theory]
    [InlineData("crossfire")]
    [InlineData("refinery")]
    [InlineData("shipment_yard")]
    [InlineData("highrise")]
    [InlineData("dust_market")]
    [InlineData("subway")]
    public void EveryUpperFloorIsReachableFromGround(string mapId)
    {
        var navigation = Navigation(mapId);
        var floor = navigation.Nodes.Min(node => node.Position.Y);
        var upper = navigation.Nodes.Where(node => node.Position.Y > floor + 2d).ToArray();
        if (upper.Length == 0)
        {
            return;
        }

        var ground = navigation.Nodes.First(node => node.Position.Y <= floor + 0.5d);
        var unreachable = upper
            .Where(node => navigation.FindPath(ground.Id, node.Id).Count == 0)
            .ToArray();

        Assert.True(
            unreachable.Length == 0,
            $"{mapId}: unreachable upper nodes: {string.Join(", ", unreachable.Select(node =>
                FormattableString.Invariant(
                    $"({node.Position.X}, {node.Position.Y:F1}, {node.Position.Z})")))}");
    }

    [Theory]
    [InlineData("crossfire")]
    [InlineData("refinery")]
    [InlineData("shipment_yard")]
    [InlineData("highrise")]
    [InlineData("dust_market")]
    [InlineData("subway")]
    public void EveryLadderLinkHasAClimbableRoute(string mapId)
    {
        var simulation = CreateSimulation(mapId, "tdm");
        var ladders = simulation.Map.NavLinks
            .Where(link => link.Kind == NavLinkKind.Ladder && link.To.Y > link.From.Y + 1d)
            .ToArray();

        foreach (var link in ladders)
        {
            var player = simulation.AddPlayer(new AddPlayerOptions
            {
                Name = "Climber",
                Team = Team.Allies,
                IsBot = false,
            });
            simulation.Step(GameConstants.TickDt);
            MathEx.Set(
                player.Position,
                link.From.X,
                link.From.Y + 0.1d,
                link.From.Z);
            MathEx.Set(player.Velocity, 0d, 0d, 0d);

            var yaw = Math.Atan2(
                -(link.To.X - link.From.X),
                -(link.To.Z - link.From.Z));
            var peak = double.NegativeInfinity;
            for (var tick = 0; tick < JsRound(10d / GameConstants.TickDt); tick++)
            {
                var command = SimulationTypes.CreateEmptyInput();
                command.Dt = GameConstants.TickDt;
                command.Seq = tick;
                command.Tick = simulation.World.Tick;
                command.Yaw = yaw;
                command.MoveForward = 1d;
                command.Buttons |= (int)InputFlag.Sprint;
                simulation.SetInput(player.Id, command);
                simulation.Step(GameConstants.TickDt);
                peak = Math.Max(peak, player.Position.Y);
            }

            Assert.True(
                peak >= link.To.Y - 0.5d,
                FormattableString.Invariant(
                    $"{mapId}: ladder to ({link.To.X}, {link.To.Y}, {link.To.Z}) tops out at {peak:F2}"));
            simulation.RemovePlayer(player.Id);
        }
    }

    [Theory]
    [InlineData("crossfire")]
    [InlineData("refinery")]
    [InlineData("shipment_yard")]
    [InlineData("highrise")]
    [InlineData("dust_market")]
    [InlineData("subway")]
    public void UpperFloorCoverSurvivesIntoNavigationGraph(string mapId)
    {
        var fixture = NavigationFixtureFor(mapId);
        var navigation = fixture.Navigation;
        var floor = navigation.Nodes.Min(node => node.Position.Y);
        if (navigation.Nodes.Count(node => node.Position.Y > floor + 2d) < 20)
        {
            return;
        }

        var authored = fixture.Simulation.Map.CoverPoints
            .Where(point => point.Position.Y > floor + 2d)
            .ToArray();
        if (authored.Length == 0)
        {
            return;
        }

        var cover = navigation.Nodes.Where(node => node.IsCover).ToArray();
        var survived = authored.Count(point => cover.Any(node =>
            MathEx.DistanceXz(node.Position, point.Position) < 2.5d &&
            Math.Abs(node.Position.Y - point.Position.Y) < 2.5d));
        var ratio = survived / (double)authored.Length;

        Assert.True(
            ratio > 0.6d,
            $"{mapId}: only {survived} of {authored.Length} authored upper cover points reached the graph");
    }

    [Theory]
    [InlineData("crossfire")]
    [InlineData("refinery")]
    [InlineData("shipment_yard")]
    [InlineData("highrise")]
    [InlineData("dust_market")]
    [InlineData("subway")]
    public void BotsUseUpperFloorsRatherThanMerelyPathingToThem(string mapId)
    {
        var upperNodes = 0;
        foreach (var seed in new[] { 99, 314 })
        {
            var simulation = CreateSimulation(mapId, "tdm", $"vertical-{mapId}-{seed}");
            var navigation = new NavGraph(simulation.Map, simulation.Collision);
            var floor = navigation.Nodes.Min(node => node.Position.Y);
            var upper = navigation.Nodes.Where(node => node.Position.Y > floor + 2d).ToArray();
            if (upper.Length < 20)
            {
                return;
            }

            upperNodes = upper.Length;
            var bots = new BotController(simulation, navigation, new Rng(seed));
            AddBots(simulation, bots, 10, BotData.Difficulties["regular"]);

            var ticks = JsRound(90d / GameConstants.TickDt);
            for (var tick = 0; tick < ticks; tick++)
            {
                bots.Update(GameConstants.TickDt);
                simulation.Step(GameConstants.TickDt);
                if (tick % 32 != 0)
                {
                    continue;
                }

                if (simulation.World.Players.Values.Any(player =>
                        player.Alive && player.Position.Y > floor + 2d))
                {
                    return;
                }
            }
        }

        Assert.Fail($"{mapId} has a {upperNodes}-node upper floor that no bot stood on in two matches");
    }

    [Fact]
    public void LiveMatchSpawnsEveryBot()
    {
        var harness = MakeMatch(botCount: 8);
        harness.Run(2d);

        Assert.Equal(8, harness.Simulation.World.Players.Values.Count(player => player.Alive));
        Assert.True(CountEvents(harness.Events, SimEventType.Spawn) >= 8);
    }

    [Fact]
    public void LiveMatchNeverSpawnsPlayersOnTopOfEachOther()
    {
        var harness = MakeMatch(botCount: 12);
        harness.Run(2d);
        var players = harness.Simulation.World.Players.Values
            .Where(player => player.Alive)
            .ToArray();

        for (var first = 0; first < players.Length; first++)
        {
            for (var second = first + 1; second < players.Length; second++)
            {
                var distance = MathEx.Distance(players[first].Position, players[second].Position);
                Assert.True(
                    distance > 0.5d,
                    $"{players[first].Name} and {players[second].Name} overlap");
            }
        }
    }

    [Fact]
    public void LiveMatchMovesBotsAwayFromSpawn()
    {
        var harness = MakeMatch(botCount: 8);
        harness.Run(2d);
        var start = harness.Simulation.World.Players.Values.ToDictionary(
            player => player.Id,
            player => MathEx.Clone(player.Position));

        harness.Run(10d);

        var moved = harness.Simulation.World.Players.Values.Count(player =>
            MathEx.Distance(start[player.Id], player.Position) > 6d);
        Assert.True(moved >= 5);
    }

    [Fact]
    public void LiveMatchProducesShotsHitsKillsAndPlausibleAccuracy()
    {
        var harness = HardenedMatch.Value;
        var shots = CountEvents(harness.Events, SimEventType.Shot);
        var hits = CountEvents(harness.Events, SimEventType.Hit);
        var kills = CountEvents(harness.Events, SimEventType.Kill);

        Assert.True(shots > 150, "Bots should be shooting.");
        Assert.True(hits > 20, "Bots should be hitting each other.");
        Assert.True(kills > 4, "Bots should be killing each other.");
        var accuracy = hits / (double)Math.Max(1, shots);
        Assert.InRange(accuracy, 0.020000000000000004d, 0.7999999999999999d);
    }

    [Fact]
    public void LiveMatchRespawnsDeadPlayersCoherently()
    {
        var harness = HardenedMatch.Value;
        var players = harness.Simulation.World.Players.Values.ToArray();
        var totalDeaths = players.Sum(player => player.Deaths);
        Assert.True(totalDeaths > 3);

        var spawns = CountEvents(harness.Events, SimEventType.Spawn);
        var deadNow = players.Count(player => !player.Alive);
        Assert.Equal(players.Length + totalDeaths - deadNow, spawns);

        foreach (var player in players.Where(player => !player.Alive))
        {
            Assert.True(
                player.RespawnTimer <= harness.Simulation.Mode.RespawnDelay + 0.1d,
                $"{player.Name} is stuck dead");
        }
    }

    [Fact]
    public void LiveMatchAwardsScoreAndSortsScoreboard()
    {
        var board = HardenedMatch.Value.Simulation.Scoreboard();

        Assert.Equal(10, board.Count);
        for (var index = 1; index < board.Count; index++)
        {
            Assert.True(board[index - 1].Score >= board[index].Score);
        }
        Assert.True(board[0].Score > 0d);
    }

    [Fact]
    public void LiveMatchNeverLetsPlayerFallOutOfWorld()
    {
        var simulation = BoundsMatch.Value.Simulation;
        foreach (var player in simulation.World.Players.Values)
        {
            Assert.True(double.IsFinite(player.Position.X), $"{player.Name} x");
            Assert.True(double.IsFinite(player.Position.Y), $"{player.Name} y");
            Assert.True(double.IsFinite(player.Position.Z), $"{player.Name} z");
            Assert.True(
                player.Position.Y > simulation.Map.Bounds.Min.Y - 25d,
                $"{player.Name} fell through floor");
        }
    }

    [Fact]
    public void LiveMatchKeepsBotsInsideMapBounds()
    {
        var simulation = BoundsMatch.Value.Simulation;
        var bounds = simulation.Map.Bounds;
        foreach (var player in simulation.World.Players.Values)
        {
            Assert.InRange(player.Position.X, bounds.Min.X - 2d, bounds.Max.X + 2d);
            Assert.InRange(player.Position.Z, bounds.Min.Z - 2d, bounds.Max.Z + 2d);
        }
    }

    [Fact]
    public void LiveMatchClockTransitionsFromWarmupAndRunsDown()
    {
        var harness = MakeMatch(botCount: 6);
        Assert.Equal(MatchPhase.Warmup, harness.Simulation.World.Match.Phase);

        harness.Run(12d);

        Assert.Equal(MatchPhase.Live, harness.Simulation.World.Match.Phase);
        Assert.True(harness.Simulation.World.Match.TimeRemaining < harness.Simulation.Mode.TimeLimit);
    }

    [Fact]
    public void LiveMatchIsDeterministicForSameSeed()
    {
        static string RunOnce()
        {
            var harness = MakeMatch(botCount: 8, seed: "determinism");
            harness.Run(20d);
            return string.Join(
                "|",
                harness.Simulation.World.Players.Values
                    .OrderBy(player => player.Id)
                    .Select(player => string.Format(
                        CultureInfo.InvariantCulture,
                        "{0}:{1:F6},{2:F6}:{3}:{4}",
                        player.Id,
                        player.Position.X,
                        player.Position.Z,
                        player.Kills,
                        player.Deaths)));
        }

        Assert.Equal(RunOnce(), RunOnce());
    }

    [Fact]
    public void FullLobbyMaintainsFourMillisecondTickBudget()
    {
        var harness = MakeMatch(botCount: 12, difficulty: BotData.Difficulties["veteran"]);
        harness.Run(3d);

        const int ticks = 600;
        var started = Stopwatch.GetTimestamp();
        for (var tick = 0; tick < ticks; tick++)
        {
            harness.Bots.Update(GameConstants.TickDt);
            harness.Simulation.Step(GameConstants.TickDt);
        }

        var millisecondsPerTick = Stopwatch.GetElapsedTime(started).TotalMilliseconds / ticks;
        Assert.True(
            millisecondsPerTick < 4d,
            FormattableString.Invariant($"{millisecondsPerTick:F2}ms per tick"));
    }

    [Fact]
    public void EveryRegisteredMapSupportsARealBotMatch()
    {
        foreach (var mapId in Maps.Ids)
        {
            var simulation = CreateSimulation(mapId, "tdm", $"map-{mapId}");
            var navigation = new NavGraph(simulation.Map, simulation.Collision);
            var bots = new BotController(simulation, navigation, new Rng(3));
            var count = Math.Min(8, simulation.Map.PlayerCount[1]);
            AddBots(
                simulation,
                bots,
                count,
                BotData.Difficulties["hardened"],
                BotArchetype.Rifleman);

            Run(simulation, bots, 30d);

            var players = simulation.World.Players.Values.ToArray();
            Assert.Equal(count, players.Length);
            foreach (var player in players)
            {
                Assert.True(double.IsFinite(player.Position.X), $"{mapId}: {player.Name} x");
                Assert.True(double.IsFinite(player.Position.Z), $"{mapId}: {player.Name} z");
                Assert.True(
                    player.Position.Y > simulation.Map.Bounds.Min.Y - 25d,
                    $"{mapId}: {player.Name} fell out of world");
            }

            var combat = players.Sum(player => player.Deaths + player.Kills);
            Assert.True(combat > 0, $"{mapId} produced no combat at all");
        }
    }

    [Fact]
    public void EveryRegisteredMapBuildsConnectedNavigation()
    {
        foreach (var mapId in Maps.Ids)
        {
            var navigation = Navigation(mapId);
            Assert.True(navigation.Size > 30, $"{mapId} node count");
            Assert.Equal(1d, navigation.Connectivity());
        }
    }

    [Fact]
    public void FreeForAllRunsWithoutTeamsAndProducesKills()
    {
        var simulation = CreateSimulation("crossfire", "ffa");
        var navigation = new NavGraph(simulation.Map, simulation.Collision);
        var bots = new BotController(simulation, navigation, new Rng(7));

        AddBots(
            simulation,
            bots,
            6,
            BotData.Difficulties["hardened"],
            BotArchetype.Rifleman,
            Team.None);
        Run(simulation, bots, 40d);

        Assert.True(simulation.World.Players.Values.Sum(player => player.Kills) > 0);
    }

    [Fact]
    public void DominationRunsObjectiveScoringPathWithBots()
    {
        var simulation = CreateSimulation("crossfire", "domination");
        var navigation = new NavGraph(simulation.Map, simulation.Collision);
        var bots = new BotController(simulation, navigation, new Rng(11));

        AddBots(
            simulation,
            bots,
            8,
            BotData.Difficulties["regular"],
            BotArchetype.Rifleman);
        Run(simulation, bots, 30d);

        Assert.Equal(MatchPhase.Live, simulation.World.Match.Phase);
        Assert.All(
            simulation.World.Players.Values,
            player => Assert.True(double.IsFinite(player.Position.X)));
    }

    private static MatchHarness MakeMatch(
        string modeId = "tdm",
        int botCount = 8,
        string seed = "test-seed",
        BotDifficulty? difficulty = null)
    {
        var simulation = CreateSimulation("crossfire", modeId, seed);
        var navigation = new NavGraph(simulation.Map, simulation.Collision);
        var bots = new BotController(simulation, navigation, new Rng(1234));
        AddBots(
            simulation,
            bots,
            botCount,
            difficulty ?? BotData.Difficulties["regular"]);
        return new MatchHarness
        {
            Simulation = simulation,
            Bots = bots,
            Navigation = navigation,
        };
    }

    private static void AddBots(
        GameSimulation simulation,
        BotController bots,
        int count,
        BotDifficulty difficulty,
        BotArchetype? fixedArchetype = null,
        Team? fixedTeam = null)
    {
        for (var index = 0; index < count; index++)
        {
            var archetype = fixedArchetype ??
                LoadoutSystem.BotArchetypes[index % LoadoutSystem.BotArchetypes.Count];
            var team = fixedTeam ?? (index % 2 == 0 ? Team.Allies : Team.Axis);
            var player = simulation.AddPlayer(new AddPlayerOptions
            {
                Name = $"Bot{index}",
                Team = team,
                IsBot = true,
                BotSkill = 0.5d,
                Loadout = LoadoutSystem.BotLoadout(archetype, index),
            });
            bots.Register(player.Id, archetype, difficulty);
        }
    }

    private static void Run(GameSimulation simulation, BotController bots, double seconds)
    {
        var ticks = JsRound(seconds / GameConstants.TickDt);
        for (var tick = 0; tick < ticks; tick++)
        {
            bots.Update(GameConstants.TickDt);
            simulation.Step(GameConstants.TickDt);
        }
    }

    private static GameSimulation CreateSimulation(
        string mapId,
        string modeId,
        string? seed = null) => new(new GameOptions
        {
            MapId = mapId,
            ModeId = modeId,
            Seed = seed,
        });

    private static NavigationFixture NavigationFixtureFor(string mapId) =>
        NavigationByMap[mapId].Value;

    private static NavGraph Navigation(string mapId) =>
        NavigationFixtureFor(mapId).Navigation;

    private static int CountEvents(IEnumerable<SimEvent> events, SimEventType type) =>
        events.Count(simEvent => simEvent.Type == type);

    private static int JsRound(double value) => (int)Math.Floor(value + 0.5d);
}
