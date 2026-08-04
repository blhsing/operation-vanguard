namespace OperationVanguard.Core;

public sealed class ZombieBrain
{
    public int Id { get; init; }
    public int TargetId { get; set; }
    public List<int> Path { get; } = [];
    public int PathCursor { get; set; }
    public double PathAge { get; set; }
    public double AttackCooldown { get; set; }
    public double StuckTime { get; set; }
    public Vec3 LastPosition { get; init; } = new();
    public double SpeedJitter { get; init; }
    public double LurchPhase { get; init; }
}

public readonly record struct ZombieMeleeHit(int Zombie, int Victim);

/// <summary>
/// Deterministic horde input controller. Zombies use ordinary InputCommand values,
/// so they share collision and movement with human players.
/// </summary>
public sealed class ZombieDirectorAi
{
    public const double MeleeDamage = 34d;
    public const double MeleeRange = 2d;
    public const double MeleeCooldown = 1.1d;

    private readonly NavGraph _navigation;
    private readonly Rng _rng;
    private readonly Dictionary<int, ZombieBrain> _brains = [];
    private readonly Vec3 _toTarget = new();
    private readonly Vec3 _desired = new();

    public ZombieDirectorAi(NavGraph navigation, Rng rng)
    {
        _navigation = navigation;
        _rng = rng;
    }

    public int Count => _brains.Count;

    public void Register(int id, Vec3 position)
    {
        _brains[id] = new ZombieBrain
        {
            Id = id,
            TargetId = SimulationTypes.NullEntity,
            PathCursor = 0,
            PathAge = 99,
            AttackCooldown = 0,
            StuckTime = 0,
            LastPosition = MathEx.Clone(position),
            SpeedJitter = _rng.Range(.88, 1.12),
            LurchPhase = _rng.Range(0, Math.PI * 2),
        };
    }

    public void Unregister(int id) => _brains.Remove(id);

    public double SpeedMultiplier(int id) =>
        _brains.TryGetValue(id, out var brain) ? brain.SpeedJitter : 1d;

    public List<ZombieMeleeHit> Update(
        WorldState world,
        double deltaTime,
        Action<int, InputCommand> setInput)
    {
        var hits = new List<ZombieMeleeHit>();
        // A snapshot permits the same delete-while-iterating behavior as JavaScript Map.
        foreach (var pair in _brains.ToArray())
        {
            var id = pair.Key;
            var brain = pair.Value;
            if (!world.Players.TryGetValue(id, out var zombie))
            {
                _brains.Remove(id);
                continue;
            }

            var command = new InputCommand
            {
                Dt = deltaTime,
                Seq = world.Tick,
                Tick = world.Tick,
            };
            if (!zombie.Alive)
            {
                setInput(id, command);
                continue;
            }

            brain.AttackCooldown = Math.Max(0, brain.AttackCooldown - deltaTime);
            brain.PathAge += deltaTime;
            var target = PickTarget(world, zombie, brain);
            if (target is null)
            {
                setInput(id, command);
                continue;
            }

            var distance = MathEx.Distance(zombie.Position, target.Position);
            MathEx.Subtract(_toTarget, target.Position, zombie.Position);
            MathEx.Normalize(_toTarget, _toTarget);
            var desiredYaw = MathEx.ForwardToYaw(_toTarget);
            command.Yaw = MathEx.AngleApproach(zombie.Yaw, desiredYaw, 6d * deltaTime);
            command.Pitch = 0;

            if (distance <= MeleeRange && brain.AttackCooldown <= 0)
            {
                brain.AttackCooldown = MeleeCooldown;
                hits.Add(new ZombieMeleeHit(id, target.Id));
            }

            Steer(world, zombie, brain, target, command, deltaTime);
            setInput(id, command);
        }
        return hits;
    }

    public void Clear() => _brains.Clear();

    public static double EstimatedTravelTime(double distance, double speed) =>
        distance / Math.Max(.5, speed);

    private static PlayerState? PickTarget(WorldState world, PlayerState zombie, ZombieBrain brain)
    {
        world.Players.TryGetValue(brain.TargetId, out var current);
        var currentDistance = current is { Alive: true }
            ? MathEx.Distance(zombie.Position, current.Position)
            : double.PositiveInfinity;
        PlayerState? best = current is { Alive: true } ? current : null;
        var bestDistance = currentDistance;

        foreach (var player in world.Players.Values)
        {
            if (player.Team == Team.Hostile || !player.Alive) continue;
            var distance = MathEx.Distance(zombie.Position, player.Position);
            if (distance < bestDistance * .8)
            {
                best = player;
                bestDistance = distance;
            }
        }

        if (best is null)
        {
            foreach (var player in world.Players.Values)
            {
                if (player.Team == Team.Hostile) continue;
                var distance = MathEx.Distance(zombie.Position, player.Position);
                if (distance < bestDistance)
                {
                    best = player;
                    bestDistance = distance;
                }
            }
        }

        brain.TargetId = best?.Id ?? SimulationTypes.NullEntity;
        return best;
    }

    private void Steer(
        WorldState world,
        PlayerState zombie,
        ZombieBrain brain,
        PlayerState target,
        InputCommand command,
        double deltaTime)
    {
        var distance = MathEx.DistanceXz(zombie.Position, target.Position);
        var goal = target.Position;

        if (distance > 7)
        {
            if (brain.PathAge > 1.2 || brain.PathCursor >= brain.Path.Count)
            {
                var from = _navigation.NearestNode(zombie.Position, 18);
                var to = _navigation.NearestNode(target.Position, 18);
                if (from >= 0 && to >= 0)
                {
                    _navigation.FindPath(from, to, brain.Path);
                    brain.PathCursor = brain.Path.Count > 1 ? 1 : 0;
                }
                brain.PathAge = 0;
            }

            var nodeIndex = brain.PathCursor >= 0 && brain.PathCursor < brain.Path.Count
                ? brain.Path[brain.PathCursor]
                : -1;
            var node = nodeIndex >= 0 && nodeIndex < _navigation.Nodes.Count
                ? _navigation.Nodes[nodeIndex]
                : null;
            if (node is not null)
            {
                if (MathEx.DistanceXz(zombie.Position, node.Position) < 2)
                    brain.PathCursor++;
                else
                    goal = node.Position;
            }
        }

        MathEx.Subtract(_desired, goal, zombie.Position);
        _desired.Y = 0;
        MathEx.Normalize(_desired, _desired);
        var lurch = Math.Sin(world.Time * 2.2 + brain.LurchPhase) * .22;
        var cosine = Math.Cos(command.Yaw);
        var sine = Math.Sin(command.Yaw);
        var forward = _desired.X * -sine + _desired.Z * -cosine;
        var right = _desired.X * cosine + _desired.Z * -sine;
        command.MoveForward = MathEx.Clamp(forward, -1, 1);
        command.MoveRight = MathEx.Clamp(right + lurch, -1, 1);
        command.Buttons |= (int)InputFlag.Sprint;

        var moved = MathEx.Distance(zombie.Position, brain.LastPosition);
        MathEx.Copy(brain.LastPosition, zombie.Position);
        if (moved < .02 && distance > MeleeRange)
        {
            brain.StuckTime += deltaTime;
            if (brain.StuckTime > .3) command.Buttons |= (int)InputFlag.Jump;
            if (brain.StuckTime > 1.2)
            {
                brain.PathAge = 99;
                brain.StuckTime = 0;
            }
        }
        else
        {
            brain.StuckTime = 0;
        }
    }
}
