namespace OperationVanguard.Core;

/// <summary>Team-wide killstreak effects which have no world entity.</summary>
public sealed class TeamEffects
{
    public double Uav { get; set; }

    public double AdvancedUav { get; set; }

    public double CounterUav { get; set; }

    public double Emp { get; set; }
}

/// <summary>A scripted strike in flight.</summary>
public sealed class PendingStrike
{
    /// <summary>One of "airstrike", "cluster", or "cruise".</summary>
    public string Kind { get; set; } = string.Empty;

    public int Owner { get; set; }

    public Team Team { get; set; }

    public Vec3 Target { get; set; } = new();

    public double Delay { get; set; }

    public double Damage { get; set; }

    public double Radius { get; set; }

    public int Bombs { get; set; }

    public double Spacing { get; set; }

    public int Fired { get; set; }

    public Vec3 Heading { get; set; } = new();
}

/// <summary>State retained by the killstreak runtime across simulation ticks.</summary>
public sealed class KillstreakRuntime
{
    public Dictionary<Team, TeamEffects> Effects { get; set; } = [];

    public List<PendingStrike> PendingStrikes { get; set; } = [];

    public int NextId { get; set; } = 50_000;
}

public sealed class KillstreakResult
{
    public List<SimEvent> Events { get; set; } = [];

    public List<KillstreakEntityState> Spawned { get; set; } = [];

    public bool Used { get; set; }

    public bool EndsMatch { get; set; }
}

public sealed class KillstreakTickResult
{
    public List<SimEvent> Events { get; set; } = [];

    public List<ExplosionRequest> Explosions { get; set; } = [];

    public List<DirectHitRequest> Hits { get; set; } = [];
}

/// <summary>Killstreak activation, lifecycle, and radar queries.</summary>
public static class KillstreakRuntimeSystem
{
    private const string Airstrike = "airstrike";
    private const string Cluster = "cluster";
    private const string Cruise = "cruise";

    private static readonly QueryFilter StrikeFilter =
        new(CollisionLayer.World | CollisionLayer.Breakable);
    private static readonly Vec3 Aim = new();
    private static readonly Vec3 Eye = new();
    private static readonly Vec3 ToTarget = new();
    private static readonly RaycastHit TraceHit = new();

    private static readonly KillstreakResult Result = new();
    private static readonly KillstreakTickResult Tick = new();
    private static readonly Dictionary<int, double> VehicleFireTimes = [];

    public static KillstreakRuntime CreateKillstreakRuntime()
    {
        var runtime = new KillstreakRuntime();
        runtime.Effects.Add(Team.Allies, EmptyEffects());
        runtime.Effects.Add(Team.Axis, EmptyEffects());
        runtime.Effects.Add(Team.None, EmptyEffects());
        return runtime;
    }

    public static TeamEffects TeamEffects(KillstreakRuntime runtime, Team team)
    {
        if (!runtime.Effects.TryGetValue(team, out var effects))
        {
            effects = EmptyEffects();
            runtime.Effects[team] = effects;
        }

        return effects;
    }

    public static bool HasRadar(KillstreakRuntime runtime, Team team)
    {
        var own = TeamEffects(runtime, team);
        if (own.Uav <= 0d && own.AdvancedUav <= 0d)
        {
            return false;
        }

        foreach (var pair in runtime.Effects)
        {
            if (pair.Key == team || !SimulationTypes.IsEnemyTeam(team, pair.Key))
            {
                continue;
            }

            if (pair.Value.CounterUav > 0d)
            {
                return false;
            }
        }

        return true;
    }

    public static KillstreakResult CallKillstreak(
        WorldState world,
        ICollisionWorld collision,
        KillstreakRuntime runtime,
        PlayerState player,
        string streakId,
        Rng rng)
    {
        Result.Events = [];
        Result.Spawned = [];
        Result.Used = false;
        Result.EndsMatch = false;

        if (!KillstreakData.Killstreaks.TryGetValue(streakId, out var definition))
        {
            return Result;
        }

        var inventoryIndex = player.KillstreakInventory.IndexOf(streakId);
        if (inventoryIndex < 0)
        {
            return Result;
        }

        MathEx.Set(Eye, player.Position.X, player.Position.Y + 1.6d, player.Position.Z);
        MathEx.AnglesToForward(Aim, player.Yaw, player.Pitch);
        var target = TraceToGround(collision, Eye, Aim);

        switch (streakId)
        {
            case "uav":
                TeamEffects(runtime, player.Team).Uav = definition.Duration;
                break;

            case "advanced_uav":
                TeamEffects(runtime, player.Team).AdvancedUav = definition.Duration;
                TeamEffects(runtime, player.Team).Uav = definition.Duration;
                break;

            case "counter_uav":
                TeamEffects(runtime, player.Team).CounterUav = definition.Duration;
                break;

            case "emp_burst":
                foreach (var pair in runtime.Effects)
                {
                    if (SimulationTypes.IsEnemyTeam(player.Team, pair.Key))
                    {
                        pair.Value.Emp = definition.Duration;
                    }
                }
                break;

            case "precision_airstrike":
                runtime.PendingStrikes.Add(new PendingStrike
                {
                    Kind = Airstrike,
                    Owner = player.Id,
                    Team = player.Team,
                    Target = target,
                    Delay = 4d,
                    Damage = definition.Damage ?? 180d,
                    Radius = definition.Radius ?? 7d,
                    Bombs = 6,
                    Spacing = 0.18d,
                    Fired = 0,
                    Heading = StrikeHeading(player),
                });
                break;

            case "cluster_strike":
                runtime.PendingStrikes.Add(new PendingStrike
                {
                    Kind = Cluster,
                    Owner = player.Id,
                    Team = player.Team,
                    Target = target,
                    Delay = 3d,
                    Damage = definition.Damage ?? 130d,
                    Radius = definition.Radius ?? 5d,
                    Bombs = 9,
                    Spacing = 0.12d,
                    Fired = 0,
                    Heading = StrikeHeading(player),
                });
                break;

            case "cruise_missile":
                runtime.PendingStrikes.Add(new PendingStrike
                {
                    Kind = Cruise,
                    Owner = player.Id,
                    Team = player.Team,
                    Target = target,
                    Delay = 2.5d,
                    Damage = definition.Damage ?? 220d,
                    Radius = definition.Radius ?? 9d,
                    Bombs = 1,
                    Spacing = 0d,
                    Fired = 0,
                    Heading = StrikeHeading(player),
                });
                break;

            case "sentry_gun":
            case "care_package":
                break;

            case "attack_chopper":
            case "chopper_gunner":
            case "vtol_jet":
            case "gunship":
                Result.Spawned.Add(SpawnAirVehicle(runtime, definition, player, world));
                break;

            case "juggernaut":
                player.MaxHealth = 400d;
                player.Health = 400d;
                break;

            case "tactical_nuke":
                Result.EndsMatch = true;
                break;
        }

        player.KillstreakInventory.RemoveAt(inventoryIndex);
        Result.Used = true;
        Result.Events.Add(new GenericSimEvent(SimEventType.KillstreakCalled)
        {
            Tick = world.Tick,
            Player = player.Id,
            Team = player.Team,
            Data = new Dictionary<string, object?>
            {
                ["killstreakId"] = streakId,
                ["target"] = new Vec3(target.X, target.Y, target.Z),
            },
        });
        Result.Events.Add(new AnnounceEvent
        {
            Tick = world.Tick,
            Team = player.Team,
            Line = definition.FriendlyAnnounce,
        });

        if (!string.IsNullOrEmpty(definition.EnemyAnnounce))
        {
            Result.Events.Add(new AnnounceEvent
            {
                Tick = world.Tick,
                Team = Opposing(player.Team),
                Line = definition.EnemyAnnounce,
            });
        }

        _ = rng;
        return Result;
    }

    public static KillstreakTickResult StepKillstreaks(
        WorldState world,
        ICollisionWorld collision,
        KillstreakRuntime runtime,
        double deltaTime,
        Rng rng)
    {
        Tick.Events = [];
        Tick.Explosions = [];
        Tick.Hits = [];

        foreach (var effects in runtime.Effects.Values)
        {
            effects.Uav = Math.Max(0d, effects.Uav - deltaTime);
            effects.AdvancedUav = Math.Max(0d, effects.AdvancedUav - deltaTime);
            effects.CounterUav = Math.Max(0d, effects.CounterUav - deltaTime);
            effects.Emp = Math.Max(0d, effects.Emp - deltaTime);
        }

        for (var index = runtime.PendingStrikes.Count - 1; index >= 0; index--)
        {
            var strike = runtime.PendingStrikes[index];
            strike.Delay -= deltaTime;
            if (strike.Delay > 0d)
            {
                continue;
            }

            var spread = strike.Kind == Cluster ? 9d : 7d;
            var offset =
                (strike.Fired - (strike.Bombs - 1d) / 2d) *
                (spread / Math.Max(1, strike.Bombs - 1)) *
                2d;
            var lateral = strike.Kind == Cluster ? rng.Signed(spread) : 0d;
            var position = new Vec3(
                strike.Target.X + strike.Heading.X * offset - strike.Heading.Z * lateral,
                strike.Target.Y + 0.4d,
                strike.Target.Z + strike.Heading.Z * offset + strike.Heading.X * lateral);

            Tick.Explosions.Add(new ExplosionRequest
            {
                Position = position,
                Radius = strike.Radius,
                Damage = strike.Damage,
                Owner = strike.Owner,
            });
            Tick.Events.Add(new ExplosionEvent
            {
                Tick = world.Tick,
                Position = position,
                Radius = strike.Radius,
                Owner = strike.Owner,
                Kind = "killstreak",
            });

            strike.Fired++;
            if (strike.Fired >= strike.Bombs)
            {
                runtime.PendingStrikes.RemoveAt(index);
            }
            else
            {
                strike.Delay = strike.Spacing;
            }
        }

        foreach (var vehicle in world.KillstreakEntities.Values.ToArray())
        {
            vehicle.TimeRemaining -= deltaTime;
            if (vehicle.TimeRemaining <= 0d || vehicle.Health <= 0d)
            {
                world.KillstreakEntities.Remove(vehicle.Id);
                if (vehicle.Health <= 0d)
                {
                    Tick.Events.Add(new GenericSimEvent(SimEventType.KillstreakDestroyed)
                    {
                        Tick = world.Tick,
                        Player = vehicle.Owner,
                        Team = vehicle.Team,
                        Position = new Vec3(vehicle.Position.X, vehicle.Position.Y, vehicle.Position.Z),
                        Data = new Dictionary<string, object?> { ["kind"] = vehicle.Kind },
                    });
                    Tick.Explosions.Add(new ExplosionRequest
                    {
                        Position = vehicle.Position,
                        Radius = 6d,
                        Damage = 100d,
                        Owner = 0,
                    });
                }

                continue;
            }

            StepVehicle(world, collision, vehicle, deltaTime, rng);
        }

        return Tick;
    }

    public static void ResetKillstreakRuntime(KillstreakRuntime runtime)
    {
        foreach (var effects in runtime.Effects.Values)
        {
            effects.Uav = 0d;
            effects.AdvancedUav = 0d;
            effects.CounterUav = 0d;
            effects.Emp = 0d;
        }

        runtime.PendingStrikes.Clear();
        VehicleFireTimes.Clear();
    }

    public static bool IsRevealedOnRadar(
        KillstreakRuntime runtime,
        Team viewerTeam,
        PlayerState target,
        bool suppressedRecently)
    {
        if (!SimulationTypes.IsEnemyTeam(viewerTeam, target.Team))
        {
            return true;
        }

        if (suppressedRecently)
        {
            return true;
        }

        return HasRadar(runtime, viewerTeam);
    }

    public static double RadarTimeRemaining(KillstreakRuntime runtime, Team team)
    {
        if (!HasRadar(runtime, team))
        {
            return 0d;
        }

        var effects = TeamEffects(runtime, team);
        return Math.Max(effects.Uav, effects.AdvancedUav);
    }

    private static TeamEffects EmptyEffects() => new();

    private static Team Opposing(Team team) =>
        team == Team.Allies ? Team.Axis : Team.Allies;

    private static Vec3 StrikeHeading(PlayerState player)
    {
        var heading = new Vec3();
        MathEx.AnglesToForward(heading, player.Yaw, 0d);
        return heading;
    }

    private static Vec3 TraceToGround(ICollisionWorld collision, Vec3 origin, Vec3 direction)
    {
        var hit = collision.Raycast(origin, direction, 300d, StrikeFilter, TraceHit);
        if (hit.Hit)
        {
            return new Vec3(hit.Point.X, hit.Point.Y, hit.Point.Z);
        }

        var x = origin.X + direction.X * 60d;
        var z = origin.Z + direction.Z * 60d;
        var ground = collision.GroundHeightAt(x, z, origin.Y + 50d, 200d);
        return new Vec3(x, double.IsFinite(ground) ? ground : origin.Y, z);
    }

    private static KillstreakEntityState SpawnAirVehicle(
        KillstreakRuntime runtime,
        KillstreakDef definition,
        PlayerState player,
        WorldState world)
    {
        var kind = definition.Vehicle ?? KillstreakVehicleKind.Chopper;
        var entry = new Vec3(player.Position.X * 0.4d, 42d, player.Position.Z * 1.4d);
        var entity = new KillstreakEntityState
        {
            Id = runtime.NextId++,
            Kind = kind,
            Owner = player.Id,
            Team = player.Team,
            Position = entry,
            Velocity = new Vec3(),
            Yaw = player.Yaw,
            Pitch = 0d,
            Health = definition.Health ?? 900d,
            TimeRemaining = definition.Duration,
            Controlled = definition.Kind == KillstreakKind.Controlled,
            PathIndex = 0d,
        };
        _ = world;
        return entity;
    }

    private static void StepVehicle(
        WorldState world,
        ICollisionWorld collision,
        KillstreakEntityState vehicle,
        double deltaTime,
        Rng rng)
    {
        const double orbitRadius = 55d;
        const double orbitSpeed = 0.22d;
        if (!vehicle.Controlled)
        {
            vehicle.PathIndex += orbitSpeed * deltaTime;
            vehicle.Position.X = Math.Cos(vehicle.PathIndex) * orbitRadius;
            vehicle.Position.Z = Math.Sin(vehicle.PathIndex) * orbitRadius;
            vehicle.Position.Y = 38d;
            vehicle.Yaw = vehicle.PathIndex + Math.PI / 2d;
        }

        var last = VehicleFireTimes.TryGetValue(vehicle.Id, out var value) ? value : 0d;
        var interval = vehicle.Kind == KillstreakVehicleKind.Chopper ? 0.16d : 0.09d;
        if (world.Time - last < interval)
        {
            return;
        }

        var team = world.Players.TryGetValue(vehicle.Owner, out var owner)
            ? owner.Team
            : vehicle.Team;
        PlayerState? best = null;
        var bestDistance = double.PositiveInfinity;
        foreach (var player in world.Players.Values)
        {
            if (!player.Alive || !SimulationTypes.IsEnemyTeam(team, player.Team))
            {
                continue;
            }

            var distance = MathEx.Distance(vehicle.Position, player.Position);
            if (distance > 90d || distance >= bestDistance)
            {
                continue;
            }

            MathEx.Set(ToTarget, player.Position.X, player.Position.Y + 1.2d, player.Position.Z);
            if (!collision.IsVisible(vehicle.Position, ToTarget, StrikeFilter))
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

        VehicleFireTimes[vehicle.Id] = world.Time;
        if (!rng.Chance(0.35d))
        {
            Tick.Events.Add(new ImpactEvent
            {
                Tick = world.Tick,
                Position = new Vec3(
                    best.Position.X + rng.Signed(2d),
                    best.Position.Y,
                    best.Position.Z + rng.Signed(2d)),
                Normal = new Vec3(0d, 1d, 0d),
                Surface = default,
                Shooter = vehicle.Owner,
                Penetrated = false,
            });
            return;
        }

        Tick.Hits.Add(new DirectHitRequest
        {
            Victim = best.Id,
            Attacker = vehicle.Owner,
            Damage = vehicle.Kind == KillstreakVehicleKind.Chopper ? 28d : 45d,
            Position = new Vec3(best.Position.X, best.Position.Y, best.Position.Z),
        });
    }
}
