using OperationVanguard.Core;

namespace OperationVanguard.Tests;

[Collection(SimulationParityCollection.Name)]
public sealed class ObjectivesParityTests
{
    private static readonly Vec3 OpenGround = new(-14d, 0.05d, 4d);
    private static readonly QueryFilter MovementFilter = new(CollisionLayer.Movement);

    [Fact]
    public void DominationStartsWithAuthoredFlagOwnership()
    {
        var simulation = MakeSimulation("domination");

        Assert.Equal(Team.Allies, ZoneOwner(simulation, "A"));
        Assert.Equal(Team.None, ZoneOwner(simulation, "B"));
        Assert.Equal(Team.Axis, ZoneOwner(simulation, "C"));
    }

    [Fact]
    public void DominationCapturesNeutralFlagInAdvertisedTime()
    {
        var simulation = MakeSimulation("domination");
        var player = AddAt(simulation, Team.Allies, "Cap");
        var point = Flag(simulation, "B");

        Run(simulation, 6d, (player, point));
        Assert.Equal(Team.None, ZoneOwner(simulation, "B"));
        Assert.True(ZoneProgress(simulation, "B") > 0.4d);

        Run(simulation, 5d, (player, point));
        Assert.Equal(Team.Allies, ZoneOwner(simulation, "B"));
    }

    [Fact]
    public void DominationCaptureStacksSubLinearly()
    {
        var solo = MakeSimulation("domination");
        var soloPlayer = AddAt(solo, Team.Allies, "A1");
        Run(solo, 4d, (soloPlayer, Flag(solo, "B")));
        var soloProgress = ZoneProgress(solo, "B");

        var pair = MakeSimulation("domination");
        var first = AddAt(pair, Team.Allies, "B1");
        var second = AddAt(pair, Team.Allies, "B2");
        var point = Flag(pair, "B");
        var offset = new Vec3(point.X + 1d, point.Y, point.Z);
        Run(pair, 4d, (first, point), (second, offset));
        var pairProgress = ZoneProgress(pair, "B");

        Assert.True(pairProgress > soloProgress);
        Assert.True(pairProgress < soloProgress * 2d);
    }

    [Fact]
    public void DominationMakesNoProgressWhileContested()
    {
        var simulation = MakeSimulation("domination");
        var ally = AddAt(simulation, Team.Allies, "Ally");
        var axis = AddAt(simulation, Team.Axis, "Axis");
        var point = Flag(simulation, "B");

        Run(
            simulation,
            15d,
            (ally, point),
            (axis, new Vec3(point.X + 1.5d, point.Y, point.Z)));

        Assert.Equal(Team.None, ZoneOwner(simulation, "B"));
        Assert.Equal(0d, ZoneProgress(simulation, "B"));
    }

    [Fact]
    public void DominationPartialCaptureDecaysWhenAttackerLeaves()
    {
        var simulation = MakeSimulation("domination");
        var player = AddAt(simulation, Team.Allies, "Quitter");
        var point = Flag(simulation, "B");

        Run(simulation, 5d, (player, point));
        var peak = ZoneProgress(simulation, "B");
        Assert.True(peak > 0.2d);

        Run(simulation, 8d, (player, new Vec3(0d, 0d, 34d)));
        Assert.True(ZoneProgress(simulation, "B") < peak);
    }

    [Fact]
    public void DominationTicksScoreForHeldFlags()
    {
        var simulation = MakeSimulation("domination");
        var player = AddAt(simulation, Team.Allies, "Holder");

        Run(simulation, 12d, (player, Flag(simulation, "A")));

        Assert.True(TeamScore(simulation, Team.Allies) > 0d);
    }

    [Fact]
    public void DominationCreditsFlagContributors()
    {
        var simulation = MakeSimulation("domination");
        var player = AddAt(simulation, Team.Allies, "Cap");

        Run(simulation, 13d, (player, Flag(simulation, "B")));

        Assert.Equal(Team.Allies, ZoneOwner(simulation, "B"));
        Assert.True(player.Captures > 0);
        Assert.True(player.Score > 0d);
    }

    [Fact]
    public void HardpointHasExactlyOneLiveZone()
    {
        var simulation = MakeSimulation("hardpoint");

        Assert.Single(simulation.ObjectiveStatus(), zone => zone.Active);
    }

    [Fact]
    public void HardpointRotatesAfterWindowAndGap()
    {
        var simulation = MakeSimulation("hardpoint");
        var first = simulation.ObjectiveStatus().First(zone => zone.Active).Label;

        Run(simulation, 70d);

        var current = Assert.Single(simulation.ObjectiveStatus(), zone => zone.Active);
        Assert.NotEqual(first, current.Label);
    }

    [Fact]
    public void HardpointScoresForHolderAndStopsWhenContested()
    {
        var simulation = MakeSimulation("hardpoint");
        var zone = simulation.ObjectiveStatus().First(entry => entry.Active);
        var point = StandablePointIn(simulation, ObjectiveKind.Hardpoint, zone.Label);
        var ally = AddAt(simulation, Team.Allies, "Holder");

        Run(simulation, 10d, (ally, point));
        var held = TeamScore(simulation, Team.Allies);
        Assert.True(held > 0d);

        var axis = AddAt(simulation, Team.Axis, "Contester");
        Run(
            simulation,
            10d,
            (ally, point),
            (axis, new Vec3(point.X + 1d, point.Y, point.Z)));

        Assert.Equal(held, TeamScore(simulation, Team.Allies));
    }

    [Fact]
    public void HeadquartersOwnerCannotRespawnWhileHoldingZone()
    {
        var simulation = MakeSimulation("hq");
        var zone = simulation.ObjectiveStatus().First(entry => entry.Active);
        var point = StandablePointIn(simulation, ObjectiveKind.Headquarters, zone.Label);
        var capper = AddAt(simulation, Team.Allies, "Capper");
        var teammate = AddAt(simulation, Team.Allies, "Mate");

        Run(simulation, 14d, (capper, point));
        Assert.Equal(
            Team.Allies,
            simulation.ObjectiveStatus().First(entry => entry.Label == zone.Label).Owner);

        simulation.DamagePlayer(teammate, Damage(
            amount: 500d,
            attacker: SimulationTypes.NullEntity,
            victim: teammate.Id,
            weaponId: string.Empty,
            direction: new Vec3(0d, 1d, 0d),
            distance: 0d));
        Assert.False(teammate.Alive);

        Run(simulation, 12d, (capper, point));
        Assert.False(teammate.Alive);
    }

    [Fact]
    public void SearchAndDestroyPlantDetonationWinsRound()
    {
        var simulation = MakeSimulation("snd");
        var point = StandablePointIn(simulation, ObjectiveKind.BombSite, "A");
        var attacker = AddAt(simulation, Team.Allies, "Planter");
        _ = AddAt(simulation, Team.Axis, "Defender");

        Run(simulation, 6d, (attacker, point));
        Assert.True(simulation.Objectives.Bomb.Planted);
        Assert.Equal(1, attacker.Plants);

        Run(simulation, 47d, (attacker, point));
        Assert.True(RoundsWon(simulation, Team.Allies) > 0);
    }

    [Fact]
    public void SearchAndDestroyDefuseWinsRoundForDefender()
    {
        var simulation = MakeSimulation("snd");
        var point = StandablePointIn(simulation, ObjectiveKind.BombSite, "A");
        var attacker = AddAt(simulation, Team.Allies, "Planter");
        var defender = AddAt(simulation, Team.Axis, "Defuser");

        Run(
            simulation,
            6d,
            (attacker, point),
            (defender, new Vec3(0d, 0d, -34d)));
        Assert.True(simulation.Objectives.Bomb.Planted);

        Run(
            simulation,
            9d,
            (defender, point),
            (attacker, new Vec3(0d, 0d, 34d)));

        Assert.True(RoundsWon(simulation, Team.Axis) > 0);
    }

    [Fact]
    public void SearchAndDestroyInterruptedDefuseRestartsFromZero()
    {
        var simulation = MakeSimulation("snd");
        var point = StandablePointIn(simulation, ObjectiveKind.BombSite, "A");
        var away = new Vec3(0d, 0d, 34d);
        var attacker = AddAt(simulation, Team.Allies, "Planter");
        var defender = AddAt(simulation, Team.Axis, "Defuser");

        Run(
            simulation,
            6d,
            (attacker, point),
            (defender, new Vec3(0d, 0d, -34d)));
        Run(simulation, 4d, (defender, point), (attacker, away));
        Assert.True(simulation.Objectives.Bomb.Progress > 0d);

        Run(simulation, 1d, (defender, away), (attacker, away));
        Assert.Equal(0d, simulation.Objectives.Bomb.Progress);
    }

    [Fact]
    public void KillConfirmedScoresOnlyAfterEnemyTagCollection()
    {
        var simulation = MakeSimulation("kc");
        var killer = AddAt(simulation, Team.Allies, "Killer");
        var victim = AddAt(simulation, Team.Axis, "Victim");
        Stand(victim, OpenGround);

        simulation.DamagePlayer(victim, Damage(
            500d,
            killer.Id,
            victim.Id,
            "vk47",
            new Vec3(0d, 0d, 1d),
            5d));

        Assert.False(victim.Alive);
        var tag = Assert.Single(simulation.Objectives.Tags);
        Assert.Equal(0d, TeamScore(simulation, Team.Allies));

        Run(
            simulation,
            0.5d,
            (killer, new Vec3(tag.Position.X, tag.Position.Y - 0.3d, tag.Position.Z)));

        Assert.True(TeamScore(simulation, Team.Allies) > 0d);
        Assert.Empty(simulation.Objectives.Tags);
    }

    [Fact]
    public void KillConfirmedTeammateCanDenyTag()
    {
        var simulation = MakeSimulation("kc");
        var killer = AddAt(simulation, Team.Allies, "Killer");
        var victim = AddAt(simulation, Team.Axis, "Victim");
        var teammate = AddAt(simulation, Team.Axis, "Mate");
        Stand(victim, OpenGround);

        simulation.DamagePlayer(victim, Damage(
            500d,
            killer.Id,
            victim.Id,
            "vk47",
            new Vec3(0d, 0d, 1d),
            5d));
        var tag = Assert.Single(simulation.Objectives.Tags);

        Run(
            simulation,
            0.5d,
            (teammate, new Vec3(tag.Position.X, tag.Position.Y - 0.3d, tag.Position.Z)));

        Assert.Empty(simulation.Objectives.Tags);
        Assert.Equal(0d, TeamScore(simulation, Team.Allies));
        Assert.True(teammate.Score > 0d);
    }

    [Fact]
    public void TeamDeathmatchAddsTeamPointPerKill()
    {
        var simulation = MakeSimulation("tdm");
        var killer = AddAt(simulation, Team.Allies, "Killer");
        var victim = AddAt(simulation, Team.Axis, "Victim");

        simulation.DamagePlayer(victim, Damage(
            500d,
            killer.Id,
            victim.Id,
            "vk47",
            new Vec3(0d, 0d, 1d),
            5d));

        Assert.Equal(1d, TeamScore(simulation, Team.Allies));
    }

    private static GameSimulation MakeSimulation(string modeId)
    {
        var simulation = new GameSimulation(new GameOptions
        {
            MapId = "crossfire",
            ModeId = modeId,
            Seed = "obj",
        });
        simulation.World.Match.Phase = MatchPhase.Live;
        simulation.World.Match.TimeRemaining = simulation.Mode.TimeLimit > 0d
            ? simulation.Mode.TimeLimit
            : 600d;
        return simulation;
    }

    private static PlayerState AddAt(GameSimulation simulation, Team team, string name)
    {
        var player = simulation.AddPlayer(new AddPlayerOptions
        {
            Name = name,
            Team = team,
        });
        simulation.SpawnPlayer(player);
        return player;
    }

    private static void Stand(PlayerState player, Vec3 point)
    {
        MathEx.Copy(player.Position, point);
        MathEx.Set(player.Velocity, 0d, 0d, 0d);
    }

    private static void Run(
        GameSimulation simulation,
        double seconds,
        params (PlayerState Player, Vec3 Point)[] held)
    {
        var ticks = (int)Math.Floor(seconds / GameConstants.TickDt + 0.5d);
        for (var tick = 0; tick < ticks; tick++)
        {
            foreach (var (player, point) in held)
            {
                Stand(player, point);
            }

            simulation.Step(GameConstants.TickDt);
        }
    }

    private static Vec3 StandablePointIn(
        GameSimulation simulation,
        ObjectiveKind kind,
        string label)
    {
        var objective = simulation.Map.Objectives.FirstOrDefault(candidate =>
            candidate.Kind == kind && candidate.Label == label)
            ?? throw new InvalidOperationException($"No {kind} objective {label}.");

        foreach (var radius in new[] { 0d, 1d, 2d, 3d, 4d, 5d })
        {
            for (var angle = 0; angle < 12; angle++)
            {
                var theta = angle / 12d * Math.PI * 2d;
                var x = objective.Position.X + Math.Cos(theta) * radius;
                var z = objective.Position.Z + Math.Sin(theta) * radius;
                if (Math.Abs(x - objective.Position.X) > objective.Size.X / 2d - 0.4d ||
                    Math.Abs(z - objective.Position.Z) > objective.Size.Z / 2d - 0.4d)
                {
                    continue;
                }

                var ground = simulation.Collision.GroundHeightAt(
                    x,
                    z,
                    objective.Position.Y + 6d,
                    14d);
                if (!double.IsFinite(ground))
                {
                    continue;
                }

                var feet = new Vec3(x, ground + 0.05d, z);
                if (!simulation.Collision.IsCapsuleFree(
                        feet,
                        GameConstants.StanceHeight.Stand,
                        GameConstants.PlayerRadius,
                        MovementFilter))
                {
                    continue;
                }

                return feet;
            }
        }

        throw new InvalidOperationException($"No standable point inside {kind} {label}.");
    }

    private static Vec3 Flag(GameSimulation simulation, string label) =>
        StandablePointIn(simulation, ObjectiveKind.DominationFlag, label);

    private static Team ZoneOwner(GameSimulation simulation, string label) =>
        simulation.ObjectiveStatus().First(entry => entry.Label == label).Owner;

    private static double ZoneProgress(GameSimulation simulation, string label) =>
        simulation.ObjectiveStatus().First(entry => entry.Label == label).Progress;

    private static double TeamScore(GameSimulation simulation, Team team) =>
        simulation.World.Match.Scores.FirstOrDefault(score => score.Team == team)?.Score ?? 0d;

    private static int RoundsWon(GameSimulation simulation, Team team) =>
        simulation.World.Match.Scores.FirstOrDefault(score => score.Team == team)?.RoundsWon ?? 0;

    private static DamageInfo Damage(
        double amount,
        int attacker,
        int victim,
        string weaponId,
        Vec3 direction,
        double distance) => new()
        {
            Amount = amount,
            Attacker = attacker,
            Victim = victim,
            Cause = DamageCause.Bullet,
            WeaponId = weaponId,
            Location = HitLocation.Chest,
            Position = new Vec3(),
            Direction = direction,
            Distance = distance,
            IgnoreArmor = true,
        };
}
