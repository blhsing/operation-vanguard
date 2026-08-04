using OperationVanguard.Core;

namespace OperationVanguard.Tests;

[CollectionDefinition("Campaign runtime serial", DisableParallelization = true)]
public sealed class CampaignRuntimeSerialCollection
{
}

[Collection("Campaign runtime serial")]
public sealed class CampaignRuntimeTests
{
    private static readonly SimEvent[] NoEvents = [];

    public static IEnumerable<object[]> CanonicalMissions =>
        CampaignCatalog.CampaignMissions.Select(mission => new object[] { mission });

    [Fact]
    public void BeginKeepsTheMissionInBriefingAndCreatesTheSquad()
    {
        var mission = BuildMission(
            [Survive("wait", 1d)],
            allies:
            [
                new AllySpec
                {
                    Id = "wingman",
                    Name = "Wingman",
                    Spawn = V(-9d, 0.1d, 13d),
                    Archetype = BotArchetype.Support,
                },
            ]);
        var run = CreateRun(mission);

        Assert.Equal(MissionPhase.Briefing, run.Director.State.Phase);
        Assert.Equal(0, run.Director.HostileCount);
        var allyId = Assert.Single(run.Director.AllyIds);
        Assert.Equal(Team.Allies, run.Simulation.World.Players[allyId].Team);
        Assert.Equal(MatchPhase.Live, run.Simulation.World.Match.Phase);
        Assert.Equal(0d, run.Simulation.World.Match.TimeRemaining);
    }

    [Fact]
    public void BriefingActivatesReadyObjectivesInAuthoredOrderAndAnnouncesThem()
    {
        var mission = BuildMission(
        [
            new Objective
            {
                Id = "first",
                Label = "First",
                Line = "Move now.",
                Trigger = new SurviveTrigger(10d),
            },
            new Objective
            {
                Id = "second",
                Label = "Second",
                After = ["first"],
                Trigger = new SurviveTrigger(10d),
            },
        ]);
        var run = CreateRun(mission);

        var events = EndBriefing(run);

        Assert.Equal(MissionPhase.Active, run.Director.State.Phase);
        Assert.True(run.Director.State.Objectives["first"].Active);
        Assert.False(run.Director.State.Objectives["second"].Active);
        Assert.Collection(
            events,
            simEvent => Assert.Equal(SimEventType.ObjectiveContested, simEvent.Type),
            simEvent =>
            {
                var announce = Assert.IsType<AnnounceEvent>(simEvent);
                Assert.Equal("Move now.", announce.Line);
                Assert.Equal(Team.Allies, announce.Team);
            });
        Assert.Equal("Move now.", run.Director.State.LastLine);
    }

    [Fact]
    public void SequentialSpatialTimedAndInteractTriggersAdvanceFaithfully()
    {
        var zone = new Zone(V(-11d, 0.1d, 13d), V(4d, 4d, 4d));
        var mission = BuildMission(
        [
            new Objective
            {
                Id = "reach",
                Label = "Reach",
                Trigger = new ReachTrigger(zone),
                Checkpoint = true,
            },
            new Objective
            {
                Id = "survive",
                Label = "Survive",
                After = ["reach"],
                Trigger = new SurviveTrigger(0.25d),
            },
            new Objective
            {
                Id = "hold",
                Label = "Hold",
                After = ["survive"],
                Trigger = new HoldTrigger(zone, 0.2d),
            },
            new Objective
            {
                Id = "use",
                Label = "Use",
                After = ["hold"],
                Trigger = new InteractTrigger(zone, 0.2d, "activate"),
            },
        ]);
        var run = CreateRun(mission);
        EndBriefing(run);

        var reachEvents = run.Director.Step(0.1d, NoEvents);
        Assert.True(run.Director.State.Objectives["reach"].Complete);
        Assert.Contains(reachEvents, simEvent => simEvent.Type == SimEventType.RoundStart);
        Assert.Equal(0.4d, run.Director.State.Objectives["survive"].Progress, 12);

        run.Director.Step(0.15d, NoEvents);
        Assert.True(run.Director.State.Objectives["survive"].Complete);
        Assert.Equal(0.75d, run.Director.State.Objectives["hold"].Progress, 12);

        // Use a little more than the mathematical remainder so this assertion is
        // not about binary representation of 0.75 + 0.25.
        run.Director.Step(0.1d, NoEvents);
        Assert.True(run.Director.State.Objectives["hold"].Complete);
        Assert.Equal(0d, run.Director.State.Objectives["use"].Progress);

        // Inside without use pauses at zero.
        run.Director.Step(0.1d, NoEvents);
        Assert.Equal(0d, run.Director.State.Objectives["use"].Progress);

        run.Director.SetUsing(run.Player.Id, true);
        run.Director.Step(0.2d, NoEvents);
        Assert.True(run.Director.State.Objectives["use"].Complete);
        Assert.False(run.Director.State.Objectives["use"].Active);

        // Completion is deliberately observed on the following objective pass.
        var completionEvents = run.Director.Step(0.01d, NoEvents);
        Assert.Equal(MissionPhase.Complete, run.Director.State.Phase);
        Assert.Contains(completionEvents, simEvent => simEvent.Type == SimEventType.MatchStateChanged);
        Assert.Contains(completionEvents, simEvent => simEvent.Type == SimEventType.Announce);
    }

    [Fact]
    public void WavesRunBackwardsThroughThePendingArrayAndRespectTheHostileCap()
    {
        var mission = BuildMission(
        [
            new Objective
            {
                Id = "clear",
                Label = "Clear",
                Trigger = new ClearTrigger(),
                Waves =
                [
                    WaveAt(V(-10d, 0.1d, -8d), endless: true),
                    WaveAt(V(10d, 0.1d, -8d), endless: true),
                ],
            },
        ]);
        var run = CreateRun(mission, seed: 19);
        EndBriefing(run);

        run.Director.Step(0.01d, NoEvents);
        var first = run.Simulation.World.Players.Values.Single(player => player.Name == "Hostile1");
        Assert.True(first.Position.X > 0d); // the last-authored pending wave arrives first

        for (var index = 0; index < 40; index++)
        {
            run.Director.Step(0.5d, NoEvents);
        }

        Assert.Equal(CampaignTuning.MaxConcurrentHostiles, run.Director.HostileCount);
        Assert.Equal(
            CampaignTuning.MaxConcurrentHostiles,
            run.Simulation.World.Players.Values.Count(player => player.Team == Team.Hostile));
    }

    [Fact]
    public void HostileKillsCreditEveryActiveObjectiveThenReapTheCorpse()
    {
        var mission = BuildMission(
        [
            new Objective
            {
                Id = "one",
                Label = "One",
                Trigger = new EliminateTrigger(1),
                Waves = [WaveAt(V(8d, 0.1d, -8d))],
            },
            new Objective
            {
                Id = "also",
                Label = "Also",
                Trigger = new EliminateTrigger(1),
            },
        ]);
        var run = CreateRun(mission);
        EndBriefing(run);
        run.Director.Step(0.01d, NoEvents);

        var hostile = run.Simulation.World.Players.Values.Single(player => player.Team == Team.Hostile);
        hostile.Alive = false;
        hostile.Health = 0d;
        var kill = new KillEvent { Victim = hostile.Id, Killer = run.Player.Id };

        run.Director.Step(0.01d, [kill]);

        Assert.True(run.Director.State.Objectives["one"].Complete);
        Assert.True(run.Director.State.Objectives["also"].Complete);
        Assert.Equal(1, run.Director.State.Objectives["one"].Kills);
        Assert.Equal(1, run.Director.State.Objectives["also"].Kills);
        Assert.Equal(0, run.Director.HostileCount);
        Assert.True(run.Simulation.World.Players.ContainsKey(hostile.Id));

        run.Director.Step(CampaignTuning.CorpseLinger, NoEvents);
        Assert.False(run.Simulation.World.Players.ContainsKey(hostile.Id));
    }

    [Fact]
    public void ClearWaitsForBothTheWaveQueueAndItsLastLivingHostile()
    {
        var mission = BuildMission(
        [
            new Objective
            {
                Id = "clear",
                Label = "Clear",
                Trigger = new ClearTrigger(),
                Waves = [WaveAt(V(8d, 0.1d, -8d))],
            },
        ]);
        var run = CreateRun(mission);
        EndBriefing(run);

        run.Director.Step(0.01d, NoEvents);
        Assert.False(run.Director.State.Objectives["clear"].Complete);
        var hostile = run.Simulation.World.Players.Values.Single(player => player.Team == Team.Hostile);
        hostile.Alive = false;
        hostile.Health = 0d;

        run.Director.Step(
            0.01d,
            [new KillEvent { Victim = hostile.Id, Killer = run.Player.Id }]);

        Assert.True(run.Director.State.Objectives["clear"].Complete);
        Assert.Equal(1d, run.Director.State.Objectives["clear"].Progress);
    }

    [Fact]
    public void ReapOnCompleteRemovesOwnedSurvivorsAndQueuedArrivals()
    {
        var mission = BuildMission(
        [
            new Objective
            {
                Id = "beat",
                Label = "Beat",
                Trigger = new SurviveTrigger(0.01d),
                ReapOnComplete = true,
                Waves = [WaveAt(V(8d, 0.1d, -8d), endless: true)],
            },
        ]);
        var run = CreateRun(mission);
        EndBriefing(run);

        run.Director.Step(0.01d, NoEvents);

        Assert.True(run.Director.State.Objectives["beat"].Complete);
        Assert.Equal(0, run.Director.HostileCount);
        Assert.DoesNotContain(
            run.Simulation.World.Players.Values,
            player => player.Team == Team.Hostile);
    }

    [Fact]
    public void StalemateReleaseClearsThePostsOfObjectiveHostiles()
    {
        var post = V(8d, 0.1d, -5d);
        var mission = BuildMission(
        [
            new Objective
            {
                Id = "quota",
                Label = "Quota",
                Trigger = new EliminateTrigger(99),
                Waves = [WaveAt(V(8d, 0.1d, -8d), post: post)],
            },
        ]);
        var run = CreateRun(mission);
        EndBriefing(run);
        run.Director.Step(0.01d, NoEvents);

        var hostile = run.Simulation.World.Players.Values.Single(player => player.Team == Team.Hostile);
        Assert.NotNull(run.Bots.GetBrain(hostile.Id)?.OrderPosition);

        run.Director.Step(CampaignTuning.StalemateRelease + 0.01d, NoEvents);

        Assert.Null(run.Bots.GetBrain(hostile.Id)?.OrderPosition);
    }

    [Fact]
    public void CheckpointRestoreKeepsCompletedObjectivesAndRespawnsThePlayer()
    {
        var zone = new Zone(V(-11d, 0.1d, 13d), V(4d, 4d, 4d));
        var mission = BuildMission(
        [
            new Objective
            {
                Id = "checkpoint",
                Label = "Checkpoint",
                Trigger = new ReachTrigger(zone),
                Checkpoint = true,
            },
            new Objective
            {
                Id = "later",
                Label = "Later",
                After = ["checkpoint"],
                Trigger = new SurviveTrigger(100d),
            },
        ]);
        var run = CreateRun(mission);
        EndBriefing(run);
        run.Director.Step(0.01d, NoEvents);
        Assert.True(run.Director.State.Objectives["checkpoint"].Complete);

        run.Player.Alive = false;
        run.Player.Health = 0d;
        run.Player.RespawnTimer = 0d;
        run.Director.Step(0.01d, NoEvents);
        Assert.Equal(MissionPhase.Failed, run.Director.State.Phase);
        Assert.Equal(FailureReason.PlayerDown, run.Director.State.Failure);

        run.Director.Step(CampaignTuning.RestartDelay, NoEvents);

        Assert.Equal(MissionPhase.Active, run.Director.State.Phase);
        Assert.Equal(FailureReason.None, run.Director.State.Failure);
        Assert.Equal(1, run.Director.State.Restarts);
        Assert.True(run.Player.Alive);
        Assert.True(run.Director.State.Objectives["checkpoint"].Complete);
        Assert.True(run.Director.State.Objectives["later"].Active);
    }

    [Fact]
    public void RestartWithoutACheckpointClearsHostilesAndRequeuesTheGarrison()
    {
        var mission = BuildMission(
            [Survive("long", 100d)],
            garrison: [WaveAt(V(8d, 0.1d, -8d))]);
        var run = CreateRun(mission);
        EndBriefing(run);
        run.Director.Step(0.01d, NoEvents);
        Assert.Equal(1, run.Director.HostileCount);

        run.Player.Alive = false;
        run.Player.Health = 0d;
        run.Player.RespawnTimer = 0d;
        run.Director.Step(0.01d, NoEvents);
        run.Director.Step(CampaignTuning.RestartDelay, NoEvents);

        Assert.Equal(0, run.Director.HostileCount);
        Assert.DoesNotContain(
            run.Simulation.World.Players.Values,
            player => player.Team == Team.Hostile);

        run.Director.Step(0.01d, NoEvents);
        Assert.Equal(1, run.Director.HostileCount);
        Assert.Contains(
            run.Simulation.World.Players.Values,
            player => player.Name == "Hostile2");
    }

    [Fact]
    public void EssentialAllyFailureRespawnsTheSquadmateOnRestart()
    {
        var mission = BuildMission(
            [Survive("long", 100d)],
            allies:
            [
                new AllySpec
                {
                    Id = "essential",
                    Name = "Essential",
                    Spawn = V(-9d, 0.1d, 13d),
                    Archetype = BotArchetype.Rifleman,
                    Essential = true,
                },
            ]);
        var run = CreateRun(mission);
        EndBriefing(run);
        var ally = run.Simulation.World.Players[Assert.Single(run.Director.AllyIds)];
        ally.Alive = false;
        ally.Health = 0d;

        var failureEvents = run.Director.Step(0.01d, NoEvents);
        Assert.Equal(MissionPhase.Failed, run.Director.State.Phase);
        Assert.Equal(FailureReason.AllyLost, run.Director.State.Failure);
        Assert.Contains(failureEvents, simEvent => simEvent.Type == SimEventType.RoundEnd);

        run.Director.Step(CampaignTuning.RestartDelay, NoEvents);
        Assert.Equal(MissionPhase.Active, run.Director.State.Phase);
        Assert.True(ally.Alive);
    }

    [Fact]
    public void ObjectiveTimeLimitFailsBeforeItsTriggerCanComplete()
    {
        var mission = BuildMission(
        [
            new Objective
            {
                Id = "timed",
                Label = "Timed",
                Trigger = new SurviveTrigger(0.1d),
                TimeLimit = 0.05d,
            },
        ]);
        var run = CreateRun(mission);
        EndBriefing(run);

        run.Director.Step(0.1d, NoEvents);

        Assert.Equal(MissionPhase.Failed, run.Director.State.Phase);
        Assert.Equal(FailureReason.OutOfTime, run.Director.State.Failure);
        Assert.False(run.Director.State.Objectives["timed"].Complete);
    }

    [Fact]
    public void EscortOrdersTheAuthoredAllyAndClearsTheOrderOnArrival()
    {
        var destination = new Zone(V(-4d, 0.1d, 5d), V(4d, 4d, 4d));
        var mission = BuildMission(
        [
            new Objective
            {
                Id = "escort",
                Label = "Escort",
                Trigger = new EscortTrigger("escortee", destination),
            },
        ],
        allies:
        [
            new AllySpec
            {
                Id = "escortee",
                Name = "Escortee",
                Spawn = V(-9d, 0.1d, 13d),
                Archetype = BotArchetype.Rusher,
            },
        ]);
        var run = CreateRun(mission);
        EndBriefing(run);
        var allyId = Assert.Single(run.Director.AllyIds);
        var brain = Assert.IsType<BotBrain>(run.Bots.GetBrain(allyId));
        Assert.NotNull(brain.OrderPosition);

        var ally = run.Simulation.World.Players[allyId];
        MathEx.Copy(ally.Position, destination.Center);
        run.Director.Step(0.01d, NoEvents);

        Assert.True(run.Director.State.Objectives["escort"].Complete);
        Assert.Null(brain.OrderPosition);
    }

    [Fact]
    public void HudObjectivesExposeOnlyActiveIncompleteMarkersInAuthoredOrder()
    {
        var firstZone = new Zone(V(-4d, 0.1d, 5d), V(4d, 4d, 4d));
        var secondZone = new Zone(V(4d, 0.1d, 5d), V(4d, 4d, 4d));
        var mission = BuildMission(
        [
            new Objective { Id = "a", Label = "A", Trigger = new ReachTrigger(firstZone) },
            new Objective { Id = "b", Label = "B", Trigger = new HoldTrigger(secondZone, 2d) },
            new Objective { Id = "c", Label = "C", Trigger = new EliminateTrigger(2) },
        ]);
        var run = CreateRun(mission);
        EndBriefing(run);

        var hud = run.Director.ActiveObjectives();

        Assert.Equal(["A", "B", "C"], hud.Select(item => item.Label));
        Assert.Same(firstZone.Center, hud[0].Position);
        Assert.Same(secondZone.Center, hud[1].Position);
        Assert.Null(hud[2].Position);
    }

    [Fact]
    public void DirectorComposesWithTheLiveFixedStepSimulation()
    {
        var run = CreateRun(CampaignCatalog.GetMission("cold_open"), seed: 23);
        var sawAnnouncement = false;
        var sawHostile = false;
        var ticks = (int)Math.Round(6d / GameConstants.TickDt);

        for (var tick = 0; tick < ticks; tick++)
        {
            run.Bots.Update(GameConstants.TickDt);
            var simulationEvents = run.Simulation.Step(GameConstants.TickDt);
            var campaignEvents = run.Director.Step(GameConstants.TickDt, simulationEvents);
            sawAnnouncement |= campaignEvents.Any(simEvent => simEvent.Type == SimEventType.Announce);
            sawHostile |= run.Director.HostileCount > 0;
        }

        Assert.Equal(MissionPhase.Active, run.Director.State.Phase);
        Assert.NotEmpty(run.Director.ActiveObjectives());
        Assert.True(sawAnnouncement);
        Assert.True(sawHostile);
        Assert.InRange(run.Director.HostileCount, 0, CampaignTuning.MaxConcurrentHostiles);
    }

    [Theory]
    [MemberData(nameof(CanonicalMissions))]
    public void EveryCanonicalMissionCanBeCompletedHeadlessly(MissionDef mission)
    {
        int[] seeds = [7, 15, 23, 31, 39, 47, 55, 63, 71, 79];
        var attempts = new List<string>();

        foreach (var seed in seeds)
        {
            var run = CreateRun(mission, seed);
            var elapsed = DriveMission(run, 600d);
            if (run.Director.State.Phase == MissionPhase.Complete)
            {
                return;
            }

            attempts.Add(
                $"seed {seed}: {elapsed:F0}s, {run.Director.State.Phase}, " +
                $"stuck on {StuckOn(run)}");
        }

        Assert.Fail(
            $"{mission.Id} completed on none of {seeds.Length} deterministic playthroughs: " +
            string.Join(" | ", attempts));
    }

    private static RuntimeRun CreateRun(MissionDef mission, int seed = 7)
    {
        var simulation = new GameSimulation(new GameOptions
        {
            MapId = mission.MapId,
            ModeId = "campaign",
            Seed = $"campaign-runtime-{mission.Id}-{seed}",
        });
        var navigation = new NavGraph(simulation.Map, simulation.Collision);
        var bots = new BotController(simulation, navigation, new Rng(seed));
        var director = new CampaignDirector(
            simulation,
            navigation,
            bots,
            new Rng(seed + 1),
            mission);
        var player = simulation.AddPlayer(new AddPlayerOptions
        {
            Name = "Player",
            Team = Team.Allies,
            IsBot = true,
            BotSkill = 0.75d,
            Loadout = LoadoutSystem.BotLoadout(BotArchetype.Rifleman, 0),
        });
        director.Begin(player);
        bots.Register(player.Id, BotArchetype.Rifleman, BotData.Get(DifficultyId.Veteran));
        return new RuntimeRun(simulation, navigation, bots, director, player);
    }

    private static double DriveMission(RuntimeRun run, double maximumSeconds)
    {
        var ticks = (int)Math.Round(maximumSeconds / GameConstants.TickDt);
        for (var tick = 0; tick < ticks; tick++)
        {
            var objectives = run.Director.ActiveObjectives();
            var marked = objectives.FirstOrDefault(objective => objective.Position is not null);
            Vec3? target = marked?.Position;

            if (target is null &&
                run.Simulation.World.Players.TryGetValue(run.Player.Id, out var player))
            {
                var bestDistance = double.PositiveInfinity;
                foreach (var candidate in run.Simulation.World.Players.Values)
                {
                    if (candidate.Team != Team.Hostile || !candidate.Alive)
                    {
                        continue;
                    }

                    var deltaX = candidate.Position.X - player.Position.X;
                    var deltaZ = candidate.Position.Z - player.Position.Z;
                    var distance = Math.Sqrt(deltaX * deltaX + deltaZ * deltaZ);
                    if (distance < bestDistance)
                    {
                        bestDistance = distance;
                        target = candidate.Position;
                    }
                }
            }

            run.Bots.OrderTo(run.Player.Id, target);
            run.Director.SetUsing(
                run.Player.Id,
                marked is not null && objectives.Any(objective => objective.Progress < 1d));

            run.Bots.Update(GameConstants.TickDt);
            var simulationEvents = run.Simulation.Step(GameConstants.TickDt);
            run.Director.Step(GameConstants.TickDt, simulationEvents);

            if (run.Director.State.Phase == MissionPhase.Complete ||
                run.Director.State.Phase == MissionPhase.Failed &&
                run.Director.State.Restarts > 40)
            {
                return tick * GameConstants.TickDt;
            }
        }

        return maximumSeconds;
    }

    private static string StuckOn(RuntimeRun run)
    {
        var open = run.Director.State.Objectives.Values
            .Where(objective => objective.Active && !objective.Complete)
            .ToArray();
        return open.Length == 0
            ? "nothing active — the graph stalled"
            : string.Join(
                ", ",
                open.Select(
                    objective =>
                        $"{objective.Id} (progress {objective.Progress:F2}, kills {objective.Kills})"));
    }

    private static SimEvent[] EndBriefing(RuntimeRun run) =>
        run.Director.Step(CampaignTuning.BriefingTime, NoEvents);

    private static MissionDef BuildMission(
        IReadOnlyList<Objective> objectives,
        IReadOnlyList<AllySpec>? allies = null,
        IReadOnlyList<Wave>? garrison = null) =>
        new()
        {
            Id = "runtime_test",
            Name = "Runtime Test",
            MapId = "shipment_yard",
            Brief = "Test",
            Insertion = new MissionInsertion(V(-11d, 0.1d, 13d), 0d),
            Difficulty = DifficultyId.Regular,
            Allies = allies ?? [],
            Garrison = garrison,
            Objectives = objectives,
            Outro = "Done.",
        };

    private static Objective Survive(string id, double seconds) => new()
    {
        Id = id,
        Label = id,
        Trigger = new SurviveTrigger(seconds),
    };

    private static Wave WaveAt(Vec3 spawn, Vec3? post = null, bool endless = false) => new()
    {
        Spawn = spawn,
        Count = 1,
        Interval = 0d,
        Archetypes = [BotArchetype.Rifleman],
        Endless = endless,
        Post = post,
    };

    private static Vec3 V(double x, double y, double z) => new(x, y, z);

    private sealed record RuntimeRun(
        GameSimulation Simulation,
        NavGraph Navigation,
        BotController Bots,
        CampaignDirector Director,
        PlayerState Player);
}
