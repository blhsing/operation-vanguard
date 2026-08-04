using OperationVanguard.Core;

namespace OperationVanguard.Tests;

public sealed class GameSimulationTests
{
    [Fact]
    public void WarmupTransitionsToLiveAndEmitsOrderedLifecycleEvents()
    {
        var simulation = CreateSimulation("warmup-transition");

        Assert.Equal(MatchPhase.Warmup, simulation.World.Match.Phase);
        Assert.Equal(GameConstants.Match.WarmupDuration, simulation.World.Match.TimeRemaining);

        var events = simulation.Step(GameConstants.Match.WarmupDuration);

        Assert.Equal(1, simulation.World.Tick);
        Assert.Equal(GameConstants.Match.WarmupDuration, simulation.World.Time);
        Assert.Equal(MatchPhase.Live, simulation.World.Match.Phase);
        Assert.Equal(1, simulation.World.Match.Round);
        Assert.Equal(simulation.Mode.TimeLimit, simulation.World.Match.TimeRemaining);
        Assert.Collection(
            events,
            first => Assert.Equal(SimEventType.MatchStateChanged, first.Type),
            second =>
            {
                var announce = Assert.IsType<AnnounceEvent>(second);
                Assert.Equal(Team.None, announce.Team);
                Assert.Equal(simulation.Mode.IntroLine, announce.Line);
            });
    }

    [Fact]
    public void LoadoutChangesAreDeferredUntilRespawnAndBetweenTickEventsAreRetained()
    {
        var simulation = CreateSimulation("deferred-loadout");
        var player = simulation.AddPlayer(new AddPlayerOptions
        {
            Name = "Player",
            Team = Team.Allies,
        });

        var firstTick = simulation.Step();
        Assert.True(player.Alive);
        Assert.Contains(firstTick, simEvent => simEvent.Type == SimEventType.Spawn);
        Assert.Equal(WeaponData.DefaultPrimary, player.Weapons[(int)WeaponSlot.Primary].DefId);

        var nextLoadout = LoadoutSystem.BotLoadout(BotArchetype.Sniper, 0);
        simulation.SetLoadout(player.Id, nextLoadout);
        Assert.Equal(WeaponData.DefaultPrimary, player.Weapons[(int)WeaponSlot.Primary].DefId);

        var damage = simulation.DamagePlayer(player, new DamageInfo
        {
            Amount = 500d,
            Attacker = player.Id,
            Victim = player.Id,
            Cause = DamageCause.Suicide,
            WeaponId = string.Empty,
            Location = HitLocation.Chest,
            Position = MathEx.Clone(player.Position),
            Direction = new Vec3(),
            Distance = 0d,
            IgnoreArmor = true,
        });
        Assert.True(damage.Killed);
        Assert.False(player.Alive);

        simulation.RequestRespawn(player.Id);
        player.RespawnTimer = 0d;
        var respawnTick = simulation.Step();

        Assert.True(player.Alive);
        Assert.Equal(nextLoadout.Primary, player.Weapons[(int)WeaponSlot.Primary].DefId);
        Assert.Equal(
            [SimEventType.Damage, SimEventType.Kill, SimEventType.Spawn],
            respawnTick.Select(simEvent => simEvent.Type).ToArray());
    }

    [Fact]
    public void ScoreLimitEndsMatchOnceAndOutroClockClampsAtZero()
    {
        var simulation = CreateSimulation("score-limit");
        simulation.World.Match.Phase = MatchPhase.Live;
        simulation.World.Match.TimeRemaining = 100d;
        var allies = Assert.Single(
            simulation.World.Match.Scores,
            score => score.Team == Team.Allies);
        allies.Score = simulation.Mode.ScoreLimit;

        var endingEvents = simulation.Step();

        Assert.Equal(MatchPhase.MatchEnd, simulation.World.Match.Phase);
        Assert.Equal(Team.Allies, simulation.World.Match.Winner);
        Assert.Equal(GameConstants.Match.OutroDuration, simulation.World.Match.TimeRemaining);
        Assert.Single(endingEvents, simEvent => simEvent.Type == SimEventType.MatchStateChanged);

        var heldEvents = simulation.Step(GameConstants.Match.OutroDuration + 1d);
        Assert.Equal(0d, simulation.World.Match.TimeRemaining);
        Assert.DoesNotContain(heldEvents, simEvent => simEvent.Type == SimEventType.MatchStateChanged);
    }

    [Fact]
    public void EqualSeedsProduceIdenticalInitialSpawnAndRngState()
    {
        var first = CreateSimulation("deterministic-spawn");
        var second = CreateSimulation("deterministic-spawn");
        var firstPlayer = first.AddPlayer(new AddPlayerOptions
        {
            Name = "Bot",
            Team = Team.Axis,
            IsBot = true,
        });
        var secondPlayer = second.AddPlayer(new AddPlayerOptions
        {
            Name = "Bot",
            Team = Team.Axis,
            IsBot = true,
        });

        first.Step();
        second.Step();

        Assert.Equal(firstPlayer.Position.X, secondPlayer.Position.X);
        Assert.Equal(firstPlayer.Position.Y, secondPlayer.Position.Y);
        Assert.Equal(firstPlayer.Position.Z, secondPlayer.Position.Z);
        Assert.Equal(firstPlayer.Yaw, secondPlayer.Yaw);
        Assert.Equal(first.World.RngState, second.World.RngState);
    }

    private static GameSimulation CreateSimulation(string seed) => new(new GameOptions
    {
        MapId = "crossfire",
        ModeId = "tdm",
        Seed = seed,
    });
}
