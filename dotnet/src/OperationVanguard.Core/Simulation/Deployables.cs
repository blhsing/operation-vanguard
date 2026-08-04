namespace OperationVanguard.Core;

/// <summary>Balance and collision characteristics for one placed-equipment kind.</summary>
public sealed class DeployableSpec
{
    public double ArmTime { get; init; }

    public double Health { get; init; }

    public double TriggerRadius { get; init; }

    public double TriggerArc { get; init; }

    public double Damage { get; init; }

    public double BlastRadius { get; init; }

    public double Lifetime { get; init; }

    public int Charges { get; init; }

    public bool Solid { get; init; }

    public Vec3 Size { get; init; } = new();
}

public sealed class DeployablePlacement
{
    public Vec3 Position { get; init; } = new();

    public double Yaw { get; init; }

    public bool OnWall { get; init; }
}

/// <summary>An explosion for the owning simulation to resolve.</summary>
public sealed class ExplosionRequest
{
    public Vec3 Position { get; set; } = new();

    public double Radius { get; set; }

    public double Damage { get; set; }

    public int Owner { get; set; }
}

/// <summary>Direct weapon damage for the owning simulation to resolve.</summary>
public sealed class DirectHitRequest
{
    public int Victim { get; set; }

    public int Attacker { get; set; }

    public double Damage { get; set; }

    public Vec3 Position { get; set; } = new();
}

public sealed class KillstreakGrant
{
    public int Player { get; set; }

    public string KillstreakId { get; set; } = string.Empty;
}

public sealed class DeployableTickResult
{
    public List<SimEvent> Events { get; set; } = [];

    public List<ExplosionRequest> Explosions { get; set; } = [];

    public List<DirectHitRequest> Hits { get; set; } = [];

    public List<int> Resupply { get; set; } = [];

    public List<KillstreakGrant> Grants { get; set; } = [];

    public List<int> Intercepted { get; set; } = [];
}

/// <summary>Placed-equipment lifecycle and queries, ported from deployables.ts.</summary>
public static class DeployableSystem
{
    private static readonly QueryFilter Sight = new(CollisionLayer.Sight);
    private static readonly QueryFilter Ground = new(CollisionLayer.World | CollisionLayer.Breakable);

    private static readonly Vec3 Eye = new();
    private static readonly Vec3 Aim = new();
    private static readonly Vec3 ToTarget = new();
    private static readonly Vec3 Temp = new();
    private static readonly RaycastHit PlaceScratch = new();

    private static readonly IReadOnlyDictionary<DeployableKind, DeployableSpec> Specs =
        new Dictionary<DeployableKind, DeployableSpec>
        {
            [DeployableKind.Claymore] = Spec(
                armTime: 1.5d, health: 30d, triggerRadius: 4.5d, triggerArc: 0.9d,
                damage: 160d, blastRadius: 5d, lifetime: 0d, charges: 1, solid: false,
                size: new Vec3(0.4d, 0.3d, 0.15d)),
            [DeployableKind.ProximityMine] = Spec(
                armTime: 2d, health: 25d, triggerRadius: 3.2d, triggerArc: Math.PI,
                damage: 140d, blastRadius: 4.5d, lifetime: 0d, charges: 1, solid: false,
                size: new Vec3(0.3d, 0.12d, 0.3d)),
            [DeployableKind.C4Placed] = Spec(
                armTime: 0.4d, health: 25d, triggerRadius: 0d, triggerArc: 0d,
                damage: 190d, blastRadius: 6.5d, lifetime: 0d, charges: 1, solid: false,
                size: new Vec3(0.25d, 0.12d, 0.2d)),
            [DeployableKind.TrophySystem] = Spec(
                armTime: 1d, health: 60d, triggerRadius: 8d, triggerArc: Math.PI,
                damage: 0d, blastRadius: 0d, lifetime: 0d, charges: 3, solid: false,
                size: new Vec3(0.4d, 0.5d, 0.4d)),
            [DeployableKind.AmmoBox] = Spec(
                armTime: 0.5d, health: 80d, triggerRadius: 2.5d, triggerArc: Math.PI,
                damage: 0d, blastRadius: 0d, lifetime: 90d, charges: 8, solid: false,
                size: new Vec3(0.7d, 0.5d, 0.5d)),
            [DeployableKind.DeployableCover] = Spec(
                armTime: 0.8d, health: 250d, triggerRadius: 0d, triggerArc: 0d,
                damage: 0d, blastRadius: 0d, lifetime: 0d, charges: 0, solid: true,
                size: new Vec3(1.9d, 1.15d, 0.35d)),
            [DeployableKind.TacticalInsertion] = Spec(
                armTime: 1d, health: 15d, triggerRadius: 0d, triggerArc: 0d,
                damage: 0d, blastRadius: 0d, lifetime: 0d, charges: 1, solid: false,
                size: new Vec3(0.2d, 0.4d, 0.2d)),
            [DeployableKind.SentryGun] = Spec(
                armTime: 2.5d, health: 220d, triggerRadius: 32d, triggerArc: 1.4d,
                damage: 22d, blastRadius: 0d, lifetime: 60d, charges: 0, solid: true,
                size: new Vec3(0.7d, 1d, 0.7d)),
            [DeployableKind.CarePackage] = Spec(
                armTime: 3d, health: 200d, triggerRadius: 2d, triggerArc: Math.PI,
                damage: 0d, blastRadius: 0d, lifetime: 120d, charges: 1, solid: true,
                size: new Vec3(1.2d, 1d, 1.2d)),
        };

    private static readonly DeployableTickResult Tick = new();
    private static readonly Dictionary<int, double> SentryFireTimes = [];
    private static readonly Dictionary<string, double> ResupplyTimes = new(StringComparer.Ordinal);

    public static DeployableSpec DeployableSpec(DeployableKind kind) =>
        Specs.TryGetValue(kind, out var spec) ? spec : Specs[DeployableKind.Claymore];

    /// <summary>
    /// Trace a placed item onto the aimed-at surface, or put it at the player's feet
    /// if there is no surface within reach. The returned position is <paramref name="output"/>.
    /// </summary>
    public static DeployablePlacement PlacementPoint(
        ICollisionWorld collision,
        PlayerState player,
        double reach,
        Vec3 output)
    {
        MathEx.Set(Eye, player.Position.X, player.Position.Y + 1.6d, player.Position.Z);
        MathEx.AnglesToForward(Aim, player.Yaw, player.Pitch);

        var hit = collision.Raycast(Eye, Aim, reach, Ground, PlaceScratch);
        if (hit.Hit)
        {
            MathEx.Set(
                output,
                hit.Point.X + hit.Normal.X * 0.08d,
                hit.Point.Y + hit.Normal.Y * 0.08d,
                hit.Point.Z + hit.Normal.Z * 0.08d);
            var onWall = Math.Abs(hit.Normal.Y) < 0.5d;
            var yaw = onWall ? Math.Atan2(-hit.Normal.X, -hit.Normal.Z) : player.Yaw;
            return new DeployablePlacement { Position = output, Yaw = yaw, OnWall = onWall };
        }

        var groundY = collision.GroundHeightAt(
            player.Position.X,
            player.Position.Z,
            player.Position.Y + 2d,
            6d);
        MathEx.Set(
            output,
            player.Position.X,
            double.IsFinite(groundY) ? groundY + 0.05d : player.Position.Y,
            player.Position.Z);
        return new DeployablePlacement { Position = output, Yaw = player.Yaw, OnWall = false };
    }

    public static DeployableState Place(
        WorldState world,
        DeployableKind kind,
        PlayerState owner,
        Vec3 position,
        double yaw,
        Func<int> allocateId,
        string payload = "")
    {
        var spec = DeployableSpec(kind);
        var state = new DeployableState
        {
            Id = allocateId(),
            Kind = kind,
            Owner = owner.Id,
            Team = owner.Team,
            Position = new Vec3(position.X, position.Y, position.Z),
            Yaw = yaw,
            Health = spec.Health,
            ArmTime = spec.ArmTime,
            Charges = spec.Charges,
            Age = 0d,
            Payload = payload,
        };
        world.Deployables[state.Id] = state;
        return state;
    }

    public static DeployableTickResult StepDeployables(
        WorldState world,
        ICollisionWorld collision,
        double deltaTime,
        Rng rng)
    {
        Tick.Events = [];
        Tick.Explosions = [];
        Tick.Hits = [];
        Tick.Resupply = [];
        Tick.Grants = [];
        Tick.Intercepted = [];

        foreach (var deployable in world.Deployables.Values.ToArray())
        {
            deployable.Age += deltaTime;
            if (deployable.ArmTime > 0d)
            {
                deployable.ArmTime = Math.Max(0d, deployable.ArmTime - deltaTime);
            }

            var spec = DeployableSpec(deployable.Kind);
            if (deployable.Health <= 0d)
            {
                Destroy(world, deployable, spec, violent: true);
                continue;
            }

            if (spec.Lifetime > 0d && deployable.Age > spec.Lifetime)
            {
                Destroy(world, deployable, spec, violent: false);
                continue;
            }

            if (deployable.ArmTime > 0d)
            {
                continue;
            }

            switch (deployable.Kind)
            {
                case DeployableKind.Claymore:
                case DeployableKind.ProximityMine:
                    StepMine(world, collision, deployable, spec);
                    break;
                case DeployableKind.TrophySystem:
                    StepTrophy(world, deployable, spec);
                    break;
                case DeployableKind.AmmoBox:
                    StepAmmoBox(world, deployable, spec);
                    break;
                case DeployableKind.SentryGun:
                    StepSentry(world, collision, deployable, spec, rng);
                    break;
                case DeployableKind.CarePackage:
                    StepCarePackage(world, deployable, spec, rng);
                    break;
            }
        }

        return Tick;
    }

    public static string RollCarePackage(Rng rng)
    {
        (string Id, double Weight)[] table =
        [
            ("uav", 14d),
            ("counter_uav", 8d),
            ("precision_airstrike", 14d),
            ("cluster_strike", 12d),
            ("sentry_gun", 11d),
            ("cruise_missile", 9d),
            ("attack_chopper", 8d),
            ("vtol_jet", 5d),
            ("chopper_gunner", 4d),
            ("juggernaut", 2d),
        ];

        var available = table
            .Where(entry => KillstreakData.Killstreaks.ContainsKey(entry.Id))
            .ToArray();
        if (available.Length == 0)
        {
            return "uav";
        }

        return rng.PickWeighted(
            available.Select(entry => entry.Id).ToArray(),
            available.Select(entry => entry.Weight).ToArray());
    }

    public static List<DeployableState> SolidDeployables(WorldState world)
    {
        var result = new List<DeployableState>();
        foreach (var deployable in world.Deployables.Values)
        {
            if (DeployableSpec(deployable.Kind).Solid)
            {
                result.Add(deployable);
            }
        }

        return result;
    }

    public static DeployableState? FindInsertion(WorldState world, int playerId)
    {
        foreach (var deployable in world.Deployables.Values)
        {
            if (deployable.Kind == DeployableKind.TacticalInsertion && deployable.Owner == playerId)
            {
                return deployable;
            }
        }

        return null;
    }

    public static List<ExplosionRequest> DetonateC4(WorldState world, int playerId)
    {
        var result = new List<ExplosionRequest>();
        foreach (var deployable in world.Deployables.Values.ToArray())
        {
            if (deployable.Kind != DeployableKind.C4Placed || deployable.Owner != playerId)
            {
                continue;
            }

            if (deployable.ArmTime > 0d)
            {
                continue;
            }

            var spec = DeployableSpec(deployable.Kind);
            result.Add(new ExplosionRequest
            {
                Position = new Vec3(deployable.Position.X, deployable.Position.Y, deployable.Position.Z),
                Radius = spec.BlastRadius,
                Damage = spec.Damage,
                Owner = playerId,
            });
            world.Deployables.Remove(deployable.Id);
        }

        return result;
    }

    public static void ClearOwned(WorldState world, int playerId)
    {
        foreach (var pair in world.Deployables.ToArray())
        {
            if (pair.Value.Owner != playerId)
            {
                continue;
            }

            world.Deployables.Remove(pair.Key);
            SentryFireTimes.Remove(pair.Key);
        }
    }

    public static void ResetDeployables(WorldState world)
    {
        world.Deployables.Clear();
        SentryFireTimes.Clear();
        ResupplyTimes.Clear();
    }

    public static bool DamageDeployable(WorldState world, int id, double amount)
    {
        if (!world.Deployables.TryGetValue(id, out var deployable))
        {
            return false;
        }

        deployable.Health -= amount;
        return deployable.Health <= 0d;
    }

    public static bool IsInterceptable(WorldState world, ProjectileState projectile)
    {
        foreach (var deployable in world.Deployables.Values)
        {
            if (deployable.Kind != DeployableKind.TrophySystem ||
                deployable.Charges <= 0 ||
                deployable.ArmTime > 0d)
            {
                continue;
            }

            if (!SimulationTypes.IsEnemyTeam(deployable.Team, projectile.Team))
            {
                continue;
            }

            if (MathEx.Distance(deployable.Position, projectile.Position) <=
                DeployableSpec(deployable.Kind).TriggerRadius)
            {
                return true;
            }
        }

        return false;
    }

    private static DeployableSpec Spec(
        double armTime,
        double health,
        double triggerRadius,
        double triggerArc,
        double damage,
        double blastRadius,
        double lifetime,
        int charges,
        bool solid,
        Vec3 size) =>
        new()
        {
            ArmTime = armTime,
            Health = health,
            TriggerRadius = triggerRadius,
            TriggerArc = triggerArc,
            Damage = damage,
            BlastRadius = blastRadius,
            Lifetime = lifetime,
            Charges = charges,
            Solid = solid,
            Size = size,
        };

    private static void Destroy(
        WorldState world,
        DeployableState deployable,
        DeployableSpec spec,
        bool violent)
    {
        world.Deployables.Remove(deployable.Id);
        SentryFireTimes.Remove(deployable.Id);

        Tick.Events.Add(new GenericSimEvent(SimEventType.DeployableDestroyed)
        {
            Tick = world.Tick,
            Player = deployable.Owner,
            Team = deployable.Team,
            Position = new Vec3(deployable.Position.X, deployable.Position.Y, deployable.Position.Z),
            Data = new Dictionary<string, object?> { ["kind"] = deployable.Kind },
        });

        if (violent && spec.Damage > 0d)
        {
            Tick.Explosions.Add(new ExplosionRequest
            {
                Position = deployable.Position,
                Radius = spec.BlastRadius,
                Damage = spec.Damage,
                Owner = deployable.Owner,
            });
        }
    }

    private static void StepMine(
        WorldState world,
        ICollisionWorld collision,
        DeployableState deployable,
        DeployableSpec spec)
    {
        MathEx.AnglesToForward(Aim, deployable.Yaw, 0d);

        foreach (var player in world.Players.Values)
        {
            if (!player.Alive || !SimulationTypes.IsEnemyTeam(deployable.Team, player.Team))
            {
                continue;
            }

            MathEx.Set(ToTarget, player.Position.X, player.Position.Y + 0.9d, player.Position.Z);
            if (!MathEx.InCone(
                    deployable.Position,
                    Aim,
                    ToTarget,
                    spec.TriggerArc,
                    spec.TriggerRadius) ||
                !collision.IsVisible(deployable.Position, ToTarget, Sight))
            {
                continue;
            }

            Tick.Explosions.Add(new ExplosionRequest
            {
                Position = deployable.Position,
                Radius = spec.BlastRadius,
                Damage = spec.Damage,
                Owner = deployable.Owner,
            });
            Tick.Events.Add(new ExplosionEvent
            {
                Tick = world.Tick,
                Position = new Vec3(deployable.Position.X, deployable.Position.Y, deployable.Position.Z),
                Radius = spec.BlastRadius,
                Owner = deployable.Owner,
                Kind = ProjectileKind.ClaymoreProjectile,
            });
            world.Deployables.Remove(deployable.Id);
            return;
        }
    }

    private static void StepTrophy(
        WorldState world,
        DeployableState deployable,
        DeployableSpec spec)
    {
        if (deployable.Charges <= 0)
        {
            return;
        }

        foreach (var projectile in world.Projectiles.Values)
        {
            if (!SimulationTypes.IsEnemyTeam(deployable.Team, projectile.Team) ||
                MathEx.Distance(deployable.Position, projectile.Position) > spec.TriggerRadius)
            {
                continue;
            }

            Tick.Intercepted.Add(projectile.Id);
            deployable.Charges--;
            Tick.Events.Add(new ExplosionEvent
            {
                Tick = world.Tick,
                Position = new Vec3(projectile.Position.X, projectile.Position.Y, projectile.Position.Z),
                Radius = 1.2d,
                Owner = deployable.Owner,
                Kind = "killstreak",
            });

            if (deployable.Charges <= 0)
            {
                return;
            }
        }
    }

    private static void StepAmmoBox(
        WorldState world,
        DeployableState deployable,
        DeployableSpec spec)
    {
        if (deployable.Charges <= 0)
        {
            return;
        }

        foreach (var player in world.Players.Values)
        {
            if (!player.Alive || SimulationTypes.IsEnemyTeam(deployable.Team, player.Team) ||
                MathEx.Distance(deployable.Position, player.Position) > spec.TriggerRadius)
            {
                continue;
            }

            var key = $"{deployable.Id}:{player.Id}";
            var last = ResupplyTimes.TryGetValue(key, out var value) ? value : -999d;
            if (world.Time - last < 8d)
            {
                continue;
            }

            ResupplyTimes[key] = world.Time;
            deployable.Charges--;
            Tick.Resupply.Add(player.Id);
            if (deployable.Charges <= 0)
            {
                return;
            }
        }
    }

    private static void StepSentry(
        WorldState world,
        ICollisionWorld collision,
        DeployableState deployable,
        DeployableSpec spec,
        Rng rng)
    {
        MathEx.AnglesToForward(Aim, deployable.Yaw, 0d);
        PlayerState? best = null;
        var bestDistance = spec.TriggerRadius;
        MathEx.Set(Temp, deployable.Position.X, deployable.Position.Y + 0.7d, deployable.Position.Z);

        foreach (var player in world.Players.Values)
        {
            if (!player.Alive || !SimulationTypes.IsEnemyTeam(deployable.Team, player.Team))
            {
                continue;
            }

            var distance = MathEx.Distance(Temp, player.Position);
            if (distance >= bestDistance)
            {
                continue;
            }

            MathEx.Set(ToTarget, player.Position.X, player.Position.Y + 1d, player.Position.Z);
            if (!MathEx.InCone(Temp, Aim, ToTarget, spec.TriggerArc, spec.TriggerRadius) ||
                !collision.IsVisible(Temp, ToTarget, Sight))
            {
                continue;
            }

            best = player;
            bestDistance = distance;
        }

        if (best is null)
        {
            return;
        }

        MathEx.Subtract(ToTarget, best.Position, deployable.Position);
        var desired = Math.Atan2(-ToTarget.X, -ToTarget.Z);
        var delta = desired - deployable.Yaw;
        while (delta > Math.PI)
        {
            delta -= Math.PI * 2d;
        }

        while (delta < -Math.PI)
        {
            delta += Math.PI * 2d;
        }

        const double maximumTurn = 2.2d * (1d / 64d);
        deployable.Yaw += Math.Max(-maximumTurn, Math.Min(maximumTurn, delta));
        if (Math.Abs(delta) > 0.25d)
        {
            return;
        }

        var last = SentryFireTimes.TryGetValue(deployable.Id, out var value) ? value : -999d;
        if (world.Time - last < 0.12d)
        {
            return;
        }

        SentryFireTimes[deployable.Id] = world.Time;
        if (!rng.Chance(0.55d))
        {
            return;
        }

        Tick.Hits.Add(new DirectHitRequest
        {
            Victim = best.Id,
            Attacker = deployable.Owner,
            Damage = spec.Damage,
            Position = new Vec3(best.Position.X, best.Position.Y, best.Position.Z),
        });
    }

    private static void StepCarePackage(
        WorldState world,
        DeployableState deployable,
        DeployableSpec spec,
        Rng rng)
    {
        if (deployable.Charges <= 0)
        {
            return;
        }

        foreach (var player in world.Players.Values)
        {
            if (!player.Alive || MathEx.Distance(deployable.Position, player.Position) > spec.TriggerRadius)
            {
                continue;
            }

            var streak = string.IsNullOrEmpty(deployable.Payload)
                ? RollCarePackage(rng)
                : deployable.Payload;
            deployable.Charges = 0;
            Tick.Grants.Add(new KillstreakGrant { Player = player.Id, KillstreakId = streak });
            Tick.Events.Add(new GenericSimEvent(SimEventType.KillstreakEarned)
            {
                Tick = world.Tick,
                Player = player.Id,
                Team = player.Team,
                Data = new Dictionary<string, object?>
                {
                    ["killstreakId"] = streak,
                    ["fromCarePackage"] = true,
                },
            });
            world.Deployables.Remove(deployable.Id);
            return;
        }
    }
}
