using OperationVanguard.Core;

namespace OperationVanguard.Tests;

/// <summary>
/// End-to-end ports of the web deployable and killstreak tests. These deliberately
/// drive <see cref="GameSimulation"/> through input commands so registry/runtime
/// wiring is covered in addition to the lower-level subsystem parity tests.
/// </summary>
public sealed class SimulationIntegrationParityTests
{
    private const double Tick = GameConstants.TickDt;
    private static readonly Vec3 ClearGround = new(-8d, .05d, 28d);

    [Fact]
    public void LethalAndTacticalInputsRouteToTheRightRuntimeAndConsumeACharge()
    {
        var (claymoreSimulation, claymoreOwner) = MakeSimulation(lethal: "claymore");
        var lethalBefore = claymoreOwner.LethalCount;

        Press(claymoreSimulation, claymoreOwner.Id, InputFlag.Lethal);

        var claymore = Assert.Single(claymoreSimulation.World.Deployables.Values);
        Assert.Equal(DeployableKind.Claymore, claymore.Kind);
        Assert.Empty(claymoreSimulation.World.Projectiles);
        Assert.True(
            MathEx.Distance(claymore.Position, claymoreOwner.Position) < 3d,
            "placed lethal should remain within arm's reach");
        Assert.Equal(lethalBefore - 1, claymoreOwner.LethalCount);

        var (fragSimulation, fragOwner) = MakeSimulation(lethal: "frag");
        var fragBefore = fragOwner.LethalCount;
        Press(fragSimulation, fragOwner.Id, InputFlag.Lethal);

        Assert.Empty(fragSimulation.World.Deployables);
        Assert.Equal(ProjectileKind.Frag, Assert.Single(fragSimulation.World.Projectiles.Values).Kind);
        Assert.Equal(fragBefore - 1, fragOwner.LethalCount);

        var (tacticalSimulation, tacticalOwner) = MakeSimulation();
        var tacticalBefore = tacticalOwner.TacticalCount;
        Press(tacticalSimulation, tacticalOwner.Id, InputFlag.Tactical);

        Assert.Empty(tacticalSimulation.World.Deployables);
        Assert.Equal(
            ProjectileKind.Flashbang,
            Assert.Single(tacticalSimulation.World.Projectiles.Values).Kind);
        Assert.Equal(tacticalBefore - 1, tacticalOwner.TacticalCount);
    }

    [Fact]
    public void SecondC4LethalInputDetonatesTheArmedChargeAndKillsItsTarget()
    {
        var (simulation, owner) = MakeSimulation(lethal: "c4");
        Press(simulation, owner.Id, InputFlag.Lethal);
        var charge = Assert.Single(simulation.World.Deployables.Values);

        var victim = AddPlayer(simulation, Team.Axis, "Victim");
        Run(simulation, 1d, () => Pin(victim, InFrontOf(charge, 1d)));
        Assert.True(victim.Alive);

        Press(simulation, owner.Id, InputFlag.Lethal);
        simulation.Step(Tick);

        Assert.Empty(simulation.World.Deployables);
        Assert.False(victim.Alive);
        Assert.True(victim.Deaths > 0);
    }

    [Fact]
    public void FieldUpgradeChargesRejectsEarlyInputThenDeploysAndSpendsItsCharge()
    {
        var (simulation, owner) = MakeSimulation(fieldUpgrade: "trophy_system");
        Assert.Equal(0d, owner.FieldUpgradeCharge);

        Run(simulation, 5d);
        Assert.InRange(owner.FieldUpgradeCharge, double.Epsilon, 1d - double.Epsilon);

        Press(simulation, owner.Id, InputFlag.FieldUpgrade);
        Assert.Empty(simulation.World.Deployables);

        Run(simulation, 300d);
        Assert.Equal(1d, owner.FieldUpgradeCharge);

        Press(simulation, owner.Id, InputFlag.FieldUpgrade);
        Assert.Equal(
            DeployableKind.TrophySystem,
            Assert.Single(simulation.World.Deployables.Values).Kind);
        Assert.Equal(0d, owner.FieldUpgradeCharge);
    }

    [Fact]
    public void SentryKillstreakSpawnsConsumesAndEventuallyKillsAVisibleEnemy()
    {
        var (simulation, owner) = MakeSimulation();
        owner.KillstreakInventory.Add("sentry_gun");

        CallStreak(simulation, owner.Id, pitch: .3d);

        var sentry = Assert.Single(simulation.World.Deployables.Values);
        Assert.Equal(DeployableKind.SentryGun, sentry.Kind);
        Assert.Empty(owner.KillstreakInventory);

        var target = AddPlayer(simulation, Team.Axis, "Target");
        Run(simulation, 10d, () => Pin(target, InFrontOf(sentry, 8d)));

        Assert.True(target.Deaths > 0, "a sentry should kill a stationary visible target");
    }

    [Fact]
    public void CarePackageMustSettleBeforeItsPayloadCanBeCollected()
    {
        var (simulation, owner) = MakeSimulation();
        owner.KillstreakInventory.Add("care_package");

        CallStreak(simulation, owner.Id, pitch: .4d);

        var package = Assert.Single(simulation.World.Deployables.Values);
        Assert.Equal(DeployableKind.CarePackage, package.Kind);
        Assert.False(string.IsNullOrEmpty(package.Payload));
        Assert.Empty(owner.KillstreakInventory);

        Run(simulation, 1d, () => Pin(owner, package.Position));
        Assert.Empty(owner.KillstreakInventory);
        Assert.True(simulation.World.Deployables.ContainsKey(package.Id));

        Run(simulation, 3d, () => Pin(owner, package.Position));
        Assert.Single(owner.KillstreakInventory);
        Assert.Equal(package.Payload, owner.KillstreakInventory[0]);
        Assert.Empty(simulation.World.Deployables);
    }

    [Fact]
    public void ExplosionDamageHasTheWebPlateauMonotonicFalloffAndHardRadiusCutoff()
    {
        Assert.True(DamageAt(.5d, 5.5d, 130d) >= 100d);
        Assert.True(DamageAt(1.8d, 5.5d, 130d) >= 100d);

        var edgeDamage = DamageAt(4.9d, 5.5d, 130d);
        Assert.InRange(edgeDamage, 5d + double.Epsilon, 100d - double.Epsilon);

        var previous = double.PositiveInfinity;
        foreach (var distance in new[] { .5d, 1.5d, 2.5d, 3.5d, 4.5d, 5.4d })
        {
            var damage = DamageAt(distance, 5.5d, 130d);
            Assert.True(damage <= previous + 1e-6d, $"damage rose at {distance}m");
            previous = damage;
        }

        Assert.Equal(0d, DamageAt(7d, 5.5d, 130d));
    }

    [Fact]
    public void PrecisionAirstrikeKillsEnemiesAtItsTargetButSparesFriendlies()
    {
        var (simulation, caller) = MakeSimulation();
        var victim = AddPlayer(simulation, Team.Axis, "Victim");
        var mate = AddPlayer(simulation, Team.Allies, "Mate");
        caller.KillstreakInventory.Add("precision_airstrike");

        CallStreak(simulation, caller.Id, pitch: .35d);
        var strike = Assert.Single(simulation.Killstreaks.PendingStrikes);

        Run(simulation, 8d, () =>
        {
            Pin(victim, strike.Target);
            Pin(mate, strike.Target);
        });

        Assert.True(victim.Deaths > 0, "an enemy held on the strike target should die");
        Assert.Equal(0, mate.Deaths);
    }

    [Fact]
    public void AttackChopperRequiresLineOfSightBeforeItCanFire()
    {
        var runtime = KillstreakRuntimeSystem.CreateKillstreakRuntime();
        KillstreakRuntimeSystem.ResetKillstreakRuntime(runtime);
        var world = new WorldState();
        var caller = BarePlayer(1, Team.Allies, new Vec3());
        var victim = BarePlayer(2, Team.Axis, new Vec3(8d, 0d, 0d));
        world.Players.Add(caller.Id, caller);
        world.Players.Add(victim.Id, victim);
        caller.KillstreakInventory.Add("attack_chopper");
        var collision = new SimulationRuntimeTestCollision { Visible = false };
        var rng = new Rng(8);

        var called = KillstreakRuntimeSystem.CallKillstreak(
            world,
            collision,
            runtime,
            caller,
            "attack_chopper",
            rng);
        var chopper = Assert.Single(called.Spawned);
        world.KillstreakEntities.Add(chopper.Id, chopper);

        var firedWithoutSight = false;
        for (var index = 0; index < Math.Round(2d / Tick); index++)
        {
            world.Tick++;
            world.Time += Tick;
            var result = KillstreakRuntimeSystem.StepKillstreaks(
                world,
                collision,
                runtime,
                Tick,
                rng);
            firedWithoutSight |= result.Hits.Count > 0 || result.Events.Any(e => e is ImpactEvent);
        }

        Assert.False(firedWithoutSight);

        collision.Visible = true;
        var landedHit = false;
        for (var index = 0; index < Math.Round(5d / Tick) && !landedHit; index++)
        {
            world.Tick++;
            world.Time += Tick;
            var result = KillstreakRuntimeSystem.StepKillstreaks(
                world,
                collision,
                runtime,
                Tick,
                rng);
            landedHit = result.Hits.Any(hit => hit.Victim == victim.Id);
        }

        Assert.True(landedHit, "a visible target should eventually receive chopper fire");
    }

    [Fact]
    public void EmpInputJamsTheEnemyTeamAndNotTheCaller()
    {
        var (simulation, caller) = MakeSimulation();
        AddPlayer(simulation, Team.Axis, "Enemy");
        caller.KillstreakInventory.Add("emp_burst");

        CallStreak(simulation, caller.Id);

        Assert.True(simulation.TeamIsJammed(Team.Axis));
        Assert.False(simulation.TeamIsJammed(Team.Allies));
        Assert.Empty(caller.KillstreakInventory);
    }

    private static (GameSimulation Simulation, PlayerState Player) MakeSimulation(
        string lethal = "frag",
        string fieldUpgrade = "")
    {
        var simulation = new GameSimulation(new GameOptions
        {
            MapId = "crossfire",
            ModeId = "tdm",
            Seed = "dep",
        });
        simulation.World.Match.Phase = MatchPhase.Live;
        simulation.World.Match.TimeRemaining = 600d;

        var loadout = LoadoutSystem.DefaultLoadout();
        loadout.Lethal = lethal;
        loadout.FieldUpgrade = fieldUpgrade;
        var player = simulation.AddPlayer(new AddPlayerOptions
        {
            Name = "Owner",
            Team = Team.Allies,
            Loadout = loadout,
        });
        simulation.SpawnPlayer(player);
        Pin(player, ClearGround);
        player.Yaw = 0d;
        player.Pitch = 0d;
        return (simulation, player);
    }

    private static PlayerState AddPlayer(GameSimulation simulation, Team team, string name)
    {
        var player = simulation.AddPlayer(new AddPlayerOptions { Name = name, Team = team });
        simulation.SpawnPlayer(player);
        return player;
    }

    private static void Press(
        GameSimulation simulation,
        int playerId,
        InputFlag buttons,
        double pitch = 0d)
    {
        simulation.SetInput(playerId, Input(buttons: buttons, pitch: pitch));
        simulation.Step(Tick);
        simulation.SetInput(playerId, Input(pitch: pitch));
    }

    private static void CallStreak(
        GameSimulation simulation,
        int playerId,
        int slot = 0,
        double pitch = 0d)
    {
        var command = Input(pitch: pitch);
        command.KillstreakSlot = slot;
        simulation.SetInput(playerId, command);
        simulation.Step(Tick);
        simulation.SetInput(playerId, Input(pitch: pitch));
    }

    private static InputCommand Input(InputFlag buttons = InputFlag.None, double pitch = 0d) =>
        new()
        {
            Dt = Tick,
            Pitch = pitch,
            Buttons = (int)buttons,
            KillstreakSlot = -1,
        };

    private static void Run(GameSimulation simulation, double seconds, Action? beforeTick = null)
    {
        var ticks = (int)Math.Round(seconds / Tick);
        for (var index = 0; index < ticks; index++)
        {
            beforeTick?.Invoke();
            simulation.Step(Tick);
        }
    }

    private static void Pin(PlayerState player, Vec3 position)
    {
        player.Position.X = position.X;
        player.Position.Y = position.Y;
        player.Position.Z = position.Z;
        player.Velocity.X = 0d;
        player.Velocity.Y = 0d;
        player.Velocity.Z = 0d;
    }

    private static Vec3 InFrontOf(DeployableState deployable, double distance)
    {
        var forward = new Vec3();
        MathEx.AnglesToForward(forward, deployable.Yaw, 0d);
        return new Vec3(
            deployable.Position.X + forward.X * distance,
            deployable.Position.Y,
            deployable.Position.Z + forward.Z * distance);
    }

    private static double DamageAt(double distance, double radius, double maxDamage)
    {
        var simulation = new GameSimulation(new GameOptions
        {
            MapId = "crossfire",
            ModeId = "tdm",
            Seed = "blast",
        });
        simulation.World.Match.Phase = MatchPhase.Live;
        var thrower = AddPlayer(simulation, Team.Allies, "Thrower");
        var victim = AddPlayer(simulation, Team.Axis, "Victim");
        Pin(thrower, ClearGround);
        Pin(victim, new Vec3(ClearGround.X, ClearGround.Y, ClearGround.Z - distance));

        var targets = new List<ExplosionTarget>();
        Combat.ResolveExplosion(
            simulation.World,
            simulation.Collision,
            new Vec3(ClearGround.X, ClearGround.Y + .2d, ClearGround.Z),
            radius,
            maxDamage,
            thrower.Id,
            friendlyFire: false,
            targets);

        return targets.FirstOrDefault(target => target.Player.Id == victim.Id)?.Damage ?? 0d;
    }

    private static PlayerState BarePlayer(int id, Team team, Vec3 position) => new()
    {
        Id = id,
        Team = team,
        Position = position,
        Alive = true,
        Health = 100d,
        MaxHealth = 100d,
    };
}
