using OperationVanguard.Core;

namespace OperationVanguard.Tests;

public sealed class DeployablesParityTests
{
    [Fact]
    public void SpecsMatchEveryTypeScriptBalanceConstant()
    {
        var expected = new[]
        {
            Entry(DeployableKind.Claymore, 1.5, 30, 4.5, 0.9, 160, 5, 0, 1, false, 0.4, 0.3, 0.15),
            Entry(DeployableKind.ProximityMine, 2, 25, 3.2, Math.PI, 140, 4.5, 0, 1, false, 0.3, 0.12, 0.3),
            Entry(DeployableKind.C4Placed, 0.4, 25, 0, 0, 190, 6.5, 0, 1, false, 0.25, 0.12, 0.2),
            Entry(DeployableKind.TrophySystem, 1, 60, 8, Math.PI, 0, 0, 0, 3, false, 0.4, 0.5, 0.4),
            Entry(DeployableKind.AmmoBox, 0.5, 80, 2.5, Math.PI, 0, 0, 90, 8, false, 0.7, 0.5, 0.5),
            Entry(DeployableKind.DeployableCover, 0.8, 250, 0, 0, 0, 0, 0, 0, true, 1.9, 1.15, 0.35),
            Entry(DeployableKind.TacticalInsertion, 1, 15, 0, 0, 0, 0, 0, 1, false, 0.2, 0.4, 0.2),
            Entry(DeployableKind.SentryGun, 2.5, 220, 32, 1.4, 22, 0, 60, 0, true, 0.7, 1, 0.7),
            Entry(DeployableKind.CarePackage, 3, 200, 2, Math.PI, 0, 0, 120, 1, true, 1.2, 1, 1.2),
        };

        foreach (var item in expected)
        {
            var actual = DeployableSystem.DeployableSpec(item.Kind);
            Assert.Equal(item.ArmTime, actual.ArmTime);
            Assert.Equal(item.Health, actual.Health);
            Assert.Equal(item.TriggerRadius, actual.TriggerRadius);
            Assert.Equal(item.TriggerArc, actual.TriggerArc);
            Assert.Equal(item.Damage, actual.Damage);
            Assert.Equal(item.BlastRadius, actual.BlastRadius);
            Assert.Equal(item.Lifetime, actual.Lifetime);
            Assert.Equal(item.Charges, actual.Charges);
            Assert.Equal(item.Solid, actual.Solid);
            Assert.Equal(item.SizeX, actual.Size.X);
            Assert.Equal(item.SizeY, actual.Size.Y);
            Assert.Equal(item.SizeZ, actual.Size.Z);
        }
    }

    [Fact]
    public void PlacementUsesSurfaceNudgeAndFallsBackToGround()
    {
        var collision = new SimulationRuntimeTestCollision
        {
            RayHits = true,
            RayPoint = new Vec3(3, 4, 5),
            RayNormal = new Vec3(1, 0, 0),
        };
        var player = new PlayerState
        {
            Position = new Vec3(10, 2, 20),
            Yaw = 0.75,
            Pitch = 0.2,
        };
        var output = new Vec3();

        var wall = DeployableSystem.PlacementPoint(collision, player, 2.5, output);

        Assert.Same(output, wall.Position);
        Assert.True(wall.OnWall);
        Assert.Equal(3.08, output.X, 12);
        Assert.Equal(4, output.Y, 12);
        Assert.Equal(5, output.Z, 12);
        Assert.Equal(-Math.PI / 2, wall.Yaw, 12);

        collision.RayHits = false;
        collision.GroundHeight = 1.25;
        var ground = DeployableSystem.PlacementPoint(collision, player, 2.5, output);

        Assert.False(ground.OnWall);
        Assert.Equal(player.Yaw, ground.Yaw);
        Assert.Equal(10, output.X);
        Assert.Equal(1.3, output.Y, 12);
        Assert.Equal(20, output.Z);
    }

    [Fact]
    public void ClaymoreArmsBeforeTriggeringAndOnlyWatchesItsFrontArc()
    {
        var collision = new SimulationRuntimeTestCollision { Visible = true };
        var world = new WorldState { Tick = 17 };
        var owner = Player(1, Team.Allies, 20, 0, 20);
        var enemy = Player(2, Team.Axis, 0, 0, -1.5);
        world.Players.Add(enemy.Id, enemy);
        var nextId = 100;
        var mine = DeployableSystem.Place(
            world,
            DeployableKind.Claymore,
            owner,
            new Vec3(),
            yaw: 0,
            () => nextId++);

        var beforeArmed = DeployableSystem.StepDeployables(world, collision, 1, new Rng(1));
        Assert.Empty(beforeArmed.Explosions);
        Assert.True(world.Deployables.ContainsKey(mine.Id));
        Assert.Equal(0.5, mine.ArmTime, 12);

        enemy.Position.Z = 1.5;
        var behind = DeployableSystem.StepDeployables(world, collision, 0.5, new Rng(1));
        Assert.Empty(behind.Explosions);
        Assert.True(world.Deployables.ContainsKey(mine.Id));

        enemy.Position.Z = -1.5;
        var triggered = DeployableSystem.StepDeployables(world, collision, 0, new Rng(1));
        var explosion = Assert.Single(triggered.Explosions);
        Assert.Same(mine.Position, explosion.Position);
        Assert.Equal(160, explosion.Damage);
        Assert.Equal(5, explosion.Radius);
        Assert.False(world.Deployables.ContainsKey(mine.Id));
        var @event = Assert.IsType<ExplosionEvent>(Assert.Single(triggered.Events));
        Assert.Equal(ProjectileKind.ClaymoreProjectile, @event.Kind);
        Assert.NotSame(mine.Position, @event.Position);
    }

    [Fact]
    public void TrophyInterceptsProjectilesInInsertionOrderUntilChargesAreSpent()
    {
        var world = new WorldState { Tick = 4 };
        var owner = Player(1, Team.Allies, 0, 0, 0);
        var trophy = DeployableSystem.Place(
            world,
            DeployableKind.TrophySystem,
            owner,
            new Vec3(),
            0,
            () => 50);
        trophy.ArmTime = 0;

        foreach (var id in new[] { 9, 3, 12, 1 })
        {
            world.Projectiles.Add(id, new ProjectileState
            {
                Id = id,
                Team = Team.Axis,
                Position = new Vec3(1, 0, 0),
            });
        }

        var result = DeployableSystem.StepDeployables(
            world,
            new SimulationRuntimeTestCollision(),
            0,
            new Rng(2));

        Assert.Equal(new[] { 9, 3, 12 }, result.Intercepted);
        Assert.Equal(0, trophy.Charges);
        Assert.Equal(3, result.Events.Count);
        Assert.Equal(4, world.Projectiles.Count);
    }

    [Fact]
    public void AmmoCooldownAndCarePackageGrantMatchRuntimeSemantics()
    {
        var world = new WorldState();
        DeployableSystem.ResetDeployables(world);
        var owner = Player(7, Team.Allies, 0, 0, 0);
        world.Players.Add(owner.Id, owner);
        var box = DeployableSystem.Place(
            world,
            DeployableKind.AmmoBox,
            owner,
            new Vec3(),
            0,
            () => 70);
        box.ArmTime = 0;

        var first = DeployableSystem.StepDeployables(
            world,
            new SimulationRuntimeTestCollision(),
            0,
            new Rng(3));
        Assert.Equal(new[] { owner.Id }, first.Resupply);
        Assert.Equal(7, box.Charges);

        world.Time = 7.999;
        Assert.Empty(DeployableSystem.StepDeployables(
            world,
            new SimulationRuntimeTestCollision(),
            0,
            new Rng(3)).Resupply);

        world.Time = 8;
        Assert.Equal(new[] { owner.Id }, DeployableSystem.StepDeployables(
            world,
            new SimulationRuntimeTestCollision(),
            0,
            new Rng(3)).Resupply);

        world.Deployables.Clear();
        var package = DeployableSystem.Place(
            world,
            DeployableKind.CarePackage,
            owner,
            new Vec3(),
            0,
            () => 71,
            payload: "gunship");
        var settling = DeployableSystem.StepDeployables(
            world,
            new SimulationRuntimeTestCollision(),
            2.999,
            new Rng(3));
        Assert.Empty(settling.Grants);
        Assert.True(world.Deployables.ContainsKey(package.Id));

        var collected = DeployableSystem.StepDeployables(
            world,
            new SimulationRuntimeTestCollision(),
            0.001,
            new Rng(3));
        var grant = Assert.Single(collected.Grants);
        Assert.Equal(owner.Id, grant.Player);
        Assert.Equal("gunship", grant.KillstreakId);
        Assert.False(world.Deployables.ContainsKey(package.Id));
        var earned = Assert.IsType<GenericSimEvent>(Assert.Single(collected.Events));
        Assert.Equal(SimEventType.KillstreakEarned, earned.Type);
        Assert.Equal(true, earned.Data!["fromCarePackage"]);
    }

    [Fact]
    public void DetonateC4CopiesPositionAndLeavesUnarmedChargesInPlace()
    {
        var world = new WorldState();
        var owner = Player(4, Team.Allies, 0, 0, 0);
        var first = DeployableSystem.Place(
            world,
            DeployableKind.C4Placed,
            owner,
            new Vec3(1, 2, 3),
            0,
            () => 1);
        first.ArmTime = 0;
        var second = DeployableSystem.Place(
            world,
            DeployableKind.C4Placed,
            owner,
            new Vec3(4, 5, 6),
            0,
            () => 2);

        var explosions = DeployableSystem.DetonateC4(world, owner.Id);

        var explosion = Assert.Single(explosions);
        Assert.Equal(190, explosion.Damage);
        Assert.Equal(6.5, explosion.Radius);
        Assert.NotSame(first.Position, explosion.Position);
        Assert.False(world.Deployables.ContainsKey(first.Id));
        Assert.True(world.Deployables.ContainsKey(second.Id));
    }

    private static PlayerState Player(int id, Team team, double x, double y, double z) =>
        new()
        {
            Id = id,
            Team = team,
            Position = new Vec3(x, y, z),
            Alive = true,
            Health = 100,
            MaxHealth = 100,
        };

    private static ExpectedSpec Entry(
        DeployableKind kind,
        double armTime,
        double health,
        double triggerRadius,
        double triggerArc,
        double damage,
        double blastRadius,
        double lifetime,
        int charges,
        bool solid,
        double sizeX,
        double sizeY,
        double sizeZ) =>
        new(
            kind,
            armTime,
            health,
            triggerRadius,
            triggerArc,
            damage,
            blastRadius,
            lifetime,
            charges,
            solid,
            sizeX,
            sizeY,
            sizeZ);

    private sealed record ExpectedSpec(
        DeployableKind Kind,
        double ArmTime,
        double Health,
        double TriggerRadius,
        double TriggerArc,
        double Damage,
        double BlastRadius,
        double Lifetime,
        int Charges,
        bool Solid,
        double SizeX,
        double SizeY,
        double SizeZ);
}
