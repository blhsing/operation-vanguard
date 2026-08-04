namespace OperationVanguard.Core;

/// <summary>A transient hazard the spawn system should route players away from.</summary>
public sealed class DangerZone
{
    public Vec3 Position { get; set; } = new();

    public double Radius { get; set; }

    public double TimeRemaining { get; set; }
}

public sealed class RecentSpawnDeath
{
    public Vec3 Position { get; set; } = new();

    public double Time { get; set; }
}

/// <summary>Bookkeeping retained between spawn selections.</summary>
public sealed class SpawnContext
{
    public Dictionary<int, double> RecentUse { get; } = [];

    public List<RecentSpawnDeath> RecentDeaths { get; } = [];

    public List<DangerZone> DangerZones { get; } = [];

    public Dictionary<string, double> GroupWeights { get; } = new(StringComparer.Ordinal);
}

public sealed class SpawnChoice
{
    public Vec3 Position { get; set; } = new();

    public double Yaw { get; set; }

    public int Index { get; set; }

    public double Score { get; set; }
}

public sealed class SpawnSelectionOptions
{
    public bool InitialOnly { get; set; }
}

/// <summary>Influence-map spawn scoring and selection.</summary>
public static class SpawnSystem
{
    private static readonly QueryFilter SpawnFilter = new(CollisionLayer.Movement);
    private static readonly QueryFilter SightFilter = new(CollisionLayer.Sight);
    private static readonly Vec3 Eye = new();
    private static readonly Vec3 Forward = new();
    private static readonly Vec3 Candidate = new();

    public static SpawnContext CreateSpawnContext() => new();

    public static void NoteDeath(SpawnContext context, Vec3 position, double time)
    {
        context.RecentDeaths.Add(new RecentSpawnDeath
        {
            Position = new Vec3(position.X, position.Y, position.Z),
            Time = time,
        });

        while (context.RecentDeaths.Count > 48)
        {
            context.RecentDeaths.RemoveAt(0);
        }
    }

    public static void AddDangerZone(
        SpawnContext context,
        Vec3 position,
        double radius,
        double duration)
    {
        context.DangerZones.Add(new DangerZone
        {
            Position = new Vec3(position.X, position.Y, position.Z),
            Radius = radius,
            TimeRemaining = duration,
        });
    }

    public static void TickSpawnContext(SpawnContext context, double deltaTime, double time)
    {
        for (var index = context.DangerZones.Count - 1; index >= 0; index--)
        {
            var zone = context.DangerZones[index];
            zone.TimeRemaining -= deltaTime;
            if (zone.TimeRemaining <= 0d)
            {
                context.DangerZones.RemoveAt(index);
            }
        }

        var cutoff = time - GameConstants.Spawn.RecentUseWindow * 2d;
        while (context.RecentDeaths.Count > 0 && context.RecentDeaths[0].Time < cutoff)
        {
            context.RecentDeaths.RemoveAt(0);
        }
    }

    /// <summary>Score one candidate. Higher is better; negative infinity is unusable.</summary>
    public static double ScoreSpawn(
        WorldState world,
        ICollisionWorld collision,
        SpawnContext context,
        SpawnPoint spawn,
        int spawnIndex,
        PlayerState player,
        double time)
    {
        if (spawn.Team != Team.None && spawn.Team != player.Team)
        {
            return double.NegativeInfinity;
        }

        MathEx.Set(Candidate, spawn.Position.X, spawn.Position.Y, spawn.Position.Z);
        var groundY = collision.GroundHeightAt(Candidate.X, Candidate.Z, Candidate.Y + 3d, 12d);
        if (!double.IsFinite(groundY))
        {
            return double.NegativeInfinity;
        }

        Candidate.Y = groundY + 0.05d;
        if (!collision.IsCapsuleFree(
                Candidate,
                GameConstants.StanceHeight.Stand,
                GameConstants.PlayerRadius,
                SpawnFilter))
        {
            return double.NegativeInfinity;
        }

        var score = 1000d;
        score += context.GroupWeights.GetValueOrDefault(spawn.Group) * 400d;
        score += (spawn.Priority ?? 0d) * 40d;

        var eyeY = Candidate.Y + 1.6d;
        foreach (var other in world.Players.Values)
        {
            if (!other.Alive || other.Id == player.Id)
            {
                continue;
            }

            var distance = MathEx.Distance(Candidate, other.Position);
            if (SimulationTypes.IsEnemyTeam(player.Team, other.Team))
            {
                if (distance < GameConstants.Spawn.EnemyHardBanRadius)
                {
                    return double.NegativeInfinity;
                }

                if (distance < GameConstants.Spawn.EnemyDangerRadius)
                {
                    var amount = 1d - MathEx.Clamp01(
                        (distance - GameConstants.Spawn.EnemyHardBanRadius) /
                        (GameConstants.Spawn.EnemyDangerRadius - GameConstants.Spawn.EnemyHardBanRadius));
                    score -= 700d * amount * amount;
                }

                if (distance < 70d)
                {
                    MathEx.Set(Eye, other.Position.X, other.Position.Y + 1.6d, other.Position.Z);
                    MathEx.AnglesToForward(Forward, other.Yaw, other.Pitch);
                    MathEx.Set(Candidate, Candidate.X, eyeY, Candidate.Z);
                    if (MathEx.InCone(
                            Eye,
                            Forward,
                            Candidate,
                            GameConstants.Spawn.EnemyViewConeHalfAngle,
                            70d) &&
                        collision.IsVisible(Eye, Candidate, SightFilter))
                    {
                        score -= GameConstants.Spawn.EnemyViewConePenalty *
                            (1d - MathEx.Clamp01(distance / 70d) * 0.6d);
                    }

                    Candidate.Y = groundY + 0.05d;
                }
            }
            else
            {
                if (distance < GameConstants.Spawn.FriendlyAttractRadius)
                {
                    score += 90d *
                        (1d - MathEx.Clamp01(distance / GameConstants.Spawn.FriendlyAttractRadius));
                }

                if (distance < 1.6d)
                {
                    score -= 300d;
                }
            }
        }

        if (context.RecentUse.TryGetValue(spawnIndex, out var lastUsed))
        {
            var age = time - lastUsed;
            if (age < GameConstants.Spawn.RecentUseWindow)
            {
                score -= GameConstants.Spawn.RecentUsePenalty *
                    (1d - age / GameConstants.Spawn.RecentUseWindow);
            }
        }

        foreach (var death in context.RecentDeaths)
        {
            var age = time - death.Time;
            if (age > GameConstants.Spawn.RecentUseWindow)
            {
                continue;
            }

            var distance = MathEx.DistanceXz(Candidate, death.Position);
            if (distance < GameConstants.Spawn.RecentDeathRadius)
            {
                var proximity = 1d - distance / GameConstants.Spawn.RecentDeathRadius;
                var recency = 1d - age / GameConstants.Spawn.RecentUseWindow;
                score -= GameConstants.Spawn.RecentDeathPenalty * proximity * recency;
            }
        }

        foreach (var zone in context.DangerZones)
        {
            var distance = MathEx.Distance(Candidate, zone.Position);
            if (distance < zone.Radius)
            {
                score -= GameConstants.Spawn.DangerZonePenalty * (1d - distance / zone.Radius);
            }
        }

        return score;
    }

    public static SpawnChoice? SelectSpawn(
        WorldState world,
        MapDef map,
        ICollisionWorld collision,
        SpawnContext context,
        PlayerState player,
        Rng rng,
        SpawnSelectionOptions? options = null)
    {
        options ??= new SpawnSelectionOptions();
        var best = double.NegativeInfinity;
        var candidates = new List<SpawnChoice>();

        for (var index = 0; index < map.Spawns.Count; index++)
        {
            var spawn = map.Spawns[index];
            if (spawn.InitialOnly == true && !options.InitialOnly)
            {
                continue;
            }

            if (options.InitialOnly && spawn.InitialOnly != true && spawn.Team != player.Team)
            {
                continue;
            }

            var score = ScoreSpawn(world, collision, context, spawn, index, player, world.Time);
            if (double.IsNegativeInfinity(score))
            {
                continue;
            }

            if (score > best)
            {
                best = score;
            }

            candidates.Add(new SpawnChoice
            {
                Position = new Vec3(spawn.Position.X, spawn.Position.Y, spawn.Position.Z),
                Yaw = spawn.Yaw,
                Index = index,
                Score = score,
            });
        }

        if (candidates.Count == 0)
        {
            return FallbackSpawn(map, collision, player);
        }

        var band = Math.Max(120d, Math.Abs(best) * 0.08d);
        var shortlist = candidates.Where(candidate => candidate.Score >= best - band).ToArray();
        var chosen = shortlist.Length > 0
            ? shortlist[rng.Int(0, shortlist.Length - 1)]
            : candidates[0];

        context.RecentUse[chosen.Index] = world.Time;
        var groundY = collision.GroundHeightAt(
            chosen.Position.X,
            chosen.Position.Z,
            chosen.Position.Y + 3d,
            12d);
        if (double.IsFinite(groundY))
        {
            chosen.Position.Y = groundY + 0.05d;
        }

        return chosen;
    }

    public static void SetGroupWeights(
        SpawnContext context,
        IReadOnlyDictionary<string, double> weights)
    {
        context.GroupWeights.Clear();
        foreach (var (group, weight) in weights)
        {
            context.GroupWeights[group] = weight;
        }
    }

    public static void ResetSpawnContext(SpawnContext context)
    {
        context.RecentUse.Clear();
        context.RecentDeaths.Clear();
        context.DangerZones.Clear();
        context.GroupWeights.Clear();
    }

    public static double RespawnDelayFor(PlayerState player, double baseDelay, double maximum)
    {
        _ = player;
        return Math.Min(maximum, baseDelay);
    }

    public static double NearestEnemyDistance(WorldState world, Vec3 from, Team team)
    {
        var best = double.PositiveInfinity;
        foreach (var other in world.Players.Values)
        {
            if (!other.Alive || !SimulationTypes.IsEnemyTeam(team, other.Team))
            {
                continue;
            }

            var distance = MathEx.Distance(from, other.Position);
            if (distance < best)
            {
                best = distance;
            }
        }

        return best;
    }

    public static IReadOnlyList<int> PlayersLookingAt(
        WorldState world,
        ICollisionWorld collision,
        Vec3 point,
        Team team)
    {
        var output = new List<int>();
        foreach (var other in world.Players.Values)
        {
            if (!other.Alive || !SimulationTypes.IsEnemyTeam(team, other.Team))
            {
                continue;
            }

            MathEx.Set(Eye, other.Position.X, other.Position.Y + 1.6d, other.Position.Z);
            MathEx.AnglesToForward(Forward, other.Yaw, other.Pitch);
            if (!MathEx.InCone(
                    Eye,
                    Forward,
                    point,
                    GameConstants.Spawn.EnemyViewConeHalfAngle,
                    70d))
            {
                continue;
            }

            if (!collision.IsVisible(Eye, point, SightFilter))
            {
                continue;
            }

            output.Add(other.Id);
        }

        return output;
    }

    private static SpawnChoice? FallbackSpawn(
        MapDef map,
        ICollisionWorld collision,
        PlayerState player)
    {
        SpawnChoice? best = null;
        for (var index = 0; index < map.Spawns.Count; index++)
        {
            var spawn = map.Spawns[index];
            if (spawn.Team != Team.None && spawn.Team != player.Team)
            {
                continue;
            }

            var groundY = collision.GroundHeightAt(
                spawn.Position.X,
                spawn.Position.Z,
                spawn.Position.Y + 3d,
                12d);
            var y = double.IsFinite(groundY) ? groundY + 0.05d : spawn.Position.Y;
            var choice = new SpawnChoice
            {
                Position = new Vec3(spawn.Position.X, y, spawn.Position.Z),
                Yaw = spawn.Yaw,
                Index = index,
                Score = 0d,
            };
            best ??= choice;
        }

        if (best is not null)
        {
            return best;
        }

        if (map.Spawns.Count == 0)
        {
            return null;
        }

        var any = map.Spawns[0];
        return new SpawnChoice
        {
            Position = new Vec3(any.Position.X, any.Position.Y, any.Position.Z),
            Yaw = any.Yaw,
            Index = 0,
            Score = 0d,
        };
    }
}
