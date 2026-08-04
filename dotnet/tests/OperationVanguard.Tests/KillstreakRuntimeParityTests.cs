using OperationVanguard.Core;

namespace OperationVanguard.Tests;

public sealed class KillstreakRuntimeParityTests
{
    [Fact]
    public void UavIsConsumedAndEnemyCounterUavOverridesRadar()
    {
        var runtime = FreshRuntime();
        var world = new WorldState { Tick = 42 };
        var allies = Player(1, Team.Allies);
        var axis = Player(2, Team.Axis);
        world.Players.Add(allies.Id, allies);
        world.Players.Add(axis.Id, axis);
        allies.KillstreakInventory.Add("uav");

        var called = KillstreakRuntimeSystem.CallKillstreak(
            world,
            new SimulationRuntimeTestCollision(),
            runtime,
            allies,
            "uav",
            new Rng(1));

        Assert.True(called.Used);
        Assert.False(called.EndsMatch);
        Assert.Empty(allies.KillstreakInventory);
        Assert.Equal(KillstreakData.Killstreaks["uav"].Duration,
            KillstreakRuntimeSystem.TeamEffects(runtime, Team.Allies).Uav);
        Assert.True(KillstreakRuntimeSystem.HasRadar(runtime, Team.Allies));
        Assert.False(KillstreakRuntimeSystem.HasRadar(runtime, Team.Axis));
        Assert.Equal(SimEventType.KillstreakCalled, called.Events[0].Type);
        Assert.IsType<AnnounceEvent>(called.Events[1]);

        axis.KillstreakInventory.Add("counter_uav");
        KillstreakRuntimeSystem.CallKillstreak(
            world,
            new SimulationRuntimeTestCollision(),
            runtime,
            axis,
            "counter_uav",
            new Rng(1));

        Assert.False(KillstreakRuntimeSystem.HasRadar(runtime, Team.Allies));
        Assert.Equal(0, KillstreakRuntimeSystem.RadarTimeRemaining(runtime, Team.Allies));
        Assert.True(KillstreakRuntimeSystem.IsRevealedOnRadar(
            runtime,
            Team.Allies,
            axis,
            suppressedRecently: true));
    }

    [Fact]
    public void TeamEffectsTickDownClampAtZeroAndResetPreservesNextId()
    {
        var runtime = FreshRuntime();
        var effects = KillstreakRuntimeSystem.TeamEffects(runtime, Team.Hostile);
        effects.Uav = 3;
        effects.AdvancedUav = 2;
        effects.CounterUav = 1;
        effects.Emp = 0.5;
        runtime.NextId = 50_123;
        runtime.PendingStrikes.Add(new PendingStrike());

        KillstreakRuntimeSystem.StepKillstreaks(
            new WorldState(),
            new SimulationRuntimeTestCollision(),
            runtime,
            1.5,
            new Rng(2));

        Assert.Equal(1.5, effects.Uav);
        Assert.Equal(0.5, effects.AdvancedUav);
        Assert.Equal(0, effects.CounterUav);
        Assert.Equal(0, effects.Emp);

        KillstreakRuntimeSystem.ResetKillstreakRuntime(runtime);
        Assert.All(runtime.Effects.Values, value =>
        {
            Assert.Equal(0, value.Uav);
            Assert.Equal(0, value.AdvancedUav);
            Assert.Equal(0, value.CounterUav);
            Assert.Equal(0, value.Emp);
        });
        Assert.Empty(runtime.PendingStrikes);
        Assert.Equal(50_123, runtime.NextId);
    }

    [Fact]
    public void PrecisionAirstrikeWaitsFourSecondsThenWalksSixBombsAcrossTarget()
    {
        var runtime = FreshRuntime();
        var world = new WorldState { Tick = 9 };
        var caller = Player(7, Team.Allies);
        caller.Yaw = 0;
        caller.Pitch = 0;
        caller.KillstreakInventory.Add("precision_airstrike");
        world.Players.Add(caller.Id, caller);
        var collision = new SimulationRuntimeTestCollision { GroundHeight = 0 };

        KillstreakRuntimeSystem.CallKillstreak(
            world,
            collision,
            runtime,
            caller,
            "precision_airstrike",
            new Rng(5));

        var strike = Assert.Single(runtime.PendingStrikes);
        Assert.Equal("airstrike", strike.Kind);
        Assert.Equal(4, strike.Delay);
        Assert.Equal(6, strike.Bombs);
        Assert.Equal(0.18, strike.Spacing);
        Assert.Equal(0, strike.Target.X, 12);
        Assert.Equal(0, strike.Target.Y, 12);
        Assert.Equal(-60, strike.Target.Z, 12);

        var early = KillstreakRuntimeSystem.StepKillstreaks(
            world,
            collision,
            runtime,
            3.999,
            new Rng(5));
        Assert.Empty(early.Explosions);

        var positions = new List<Vec3>();
        positions.Add(Assert.Single(KillstreakRuntimeSystem.StepKillstreaks(
            world,
            collision,
            runtime,
            0.001,
            new Rng(5)).Explosions).Position);
        for (var index = 1; index < 6; index++)
        {
            positions.Add(Assert.Single(KillstreakRuntimeSystem.StepKillstreaks(
                world,
                collision,
                runtime,
                0.18,
                new Rng(5)).Explosions).Position);
        }

        Assert.Empty(runtime.PendingStrikes);
        Assert.Equal(new[] { -53d, -55.8d, -58.6d, -61.4d, -64.2d, -67d },
            positions.Select(position => Math.Round(position.Z, 10)));
        Assert.All(positions, position => Assert.Equal(0.4, position.Y, 12));
    }

    [Fact]
    public void AirVehicleSpawnsWithSequentialIdAndUsesFractionalOrbitPhase()
    {
        var runtime = FreshRuntime();
        var world = new WorldState { Time = 0 };
        var caller = Player(8, Team.Allies);
        caller.Position = new Vec3(10, 0, 5);
        caller.Yaw = 0.4;
        caller.KillstreakInventory.Add("attack_chopper");
        world.Players.Add(caller.Id, caller);

        var called = KillstreakRuntimeSystem.CallKillstreak(
            world,
            new SimulationRuntimeTestCollision(),
            runtime,
            caller,
            "attack_chopper",
            new Rng(8));

        var vehicle = Assert.Single(called.Spawned);
        Assert.Equal(50_000, vehicle.Id);
        Assert.Equal(50_001, runtime.NextId);
        Assert.Equal(4, vehicle.Position.X);
        Assert.Equal(42, vehicle.Position.Y);
        Assert.Equal(7, vehicle.Position.Z);
        Assert.Equal(KillstreakVehicleKind.Chopper, vehicle.Kind);
        Assert.False(vehicle.Controlled);
        world.KillstreakEntities.Add(vehicle.Id, vehicle);

        KillstreakRuntimeSystem.StepKillstreaks(
            world,
            new SimulationRuntimeTestCollision(),
            runtime,
            0.5,
            new Rng(8));

        Assert.Equal(0.11, vehicle.PathIndex, 12);
        Assert.Equal(Math.Cos(0.11) * 55, vehicle.Position.X, 12);
        Assert.Equal(38, vehicle.Position.Y);
        Assert.Equal(Math.Sin(0.11) * 55, vehicle.Position.Z, 12);
        Assert.Equal(0.11 + Math.PI / 2, vehicle.Yaw, 12);
    }

    [Fact]
    public void VehicleExpiryIsQuietButDestructionEmitsEventAndNeutralExplosion()
    {
        var runtime = FreshRuntime();
        var world = new WorldState { Tick = 13 };
        var expired = Vehicle(60, health: 10, timeRemaining: 0.1);
        world.KillstreakEntities.Add(expired.Id, expired);

        var expiry = KillstreakRuntimeSystem.StepKillstreaks(
            world,
            new SimulationRuntimeTestCollision(),
            runtime,
            0.1,
            new Rng(9));
        Assert.Empty(expiry.Events);
        Assert.Empty(expiry.Explosions);
        Assert.False(world.KillstreakEntities.ContainsKey(expired.Id));

        var destroyed = Vehicle(61, health: 0, timeRemaining: 10);
        destroyed.Position = new Vec3(2, 20, 4);
        world.KillstreakEntities.Add(destroyed.Id, destroyed);
        var destruction = KillstreakRuntimeSystem.StepKillstreaks(
            world,
            new SimulationRuntimeTestCollision(),
            runtime,
            0,
            new Rng(9));

        var @event = Assert.IsType<GenericSimEvent>(Assert.Single(destruction.Events));
        Assert.Equal(SimEventType.KillstreakDestroyed, @event.Type);
        Assert.Equal(destroyed.Owner, @event.Player);
        Assert.NotSame(destroyed.Position, @event.Position);
        var explosion = Assert.Single(destruction.Explosions);
        Assert.Same(destroyed.Position, explosion.Position);
        Assert.Equal(6, explosion.Radius);
        Assert.Equal(100, explosion.Damage);
        Assert.Equal(0, explosion.Owner);
    }

    [Fact]
    public void JuggernautAndNukeApplyTheirExactDirectEffects()
    {
        var runtime = FreshRuntime();
        var world = new WorldState();
        var player = Player(12, Team.Allies);
        player.Health = 14;
        player.MaxHealth = 100;
        player.KillstreakInventory.Add("juggernaut");

        var juggernaut = KillstreakRuntimeSystem.CallKillstreak(
            world,
            new SimulationRuntimeTestCollision(),
            runtime,
            player,
            "juggernaut",
            new Rng(12));
        Assert.True(juggernaut.Used);
        Assert.Equal(400, player.MaxHealth);
        Assert.Equal(400, player.Health);

        player.KillstreakInventory.Add("tactical_nuke");
        var nuke = KillstreakRuntimeSystem.CallKillstreak(
            world,
            new SimulationRuntimeTestCollision(),
            runtime,
            player,
            "tactical_nuke",
            new Rng(12));
        Assert.True(nuke.Used);
        Assert.True(nuke.EndsMatch);
        Assert.Empty(player.KillstreakInventory);
    }

    private static KillstreakRuntime FreshRuntime()
    {
        var runtime = KillstreakRuntimeSystem.CreateKillstreakRuntime();
        KillstreakRuntimeSystem.ResetKillstreakRuntime(runtime);
        return runtime;
    }

    private static PlayerState Player(int id, Team team) =>
        new()
        {
            Id = id,
            Team = team,
            Position = new Vec3(),
            Alive = true,
            Health = 100,
            MaxHealth = 100,
        };

    private static KillstreakEntityState Vehicle(int id, double health, double timeRemaining) =>
        new()
        {
            Id = id,
            Kind = KillstreakVehicleKind.Chopper,
            Owner = 4,
            Team = Team.Allies,
            Position = new Vec3(),
            Health = health,
            TimeRemaining = timeRemaining,
        };
}
