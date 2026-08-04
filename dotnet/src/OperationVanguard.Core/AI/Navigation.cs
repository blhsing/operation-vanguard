namespace OperationVanguard.Core;

/// <summary>A directed traversal edge in the authored-and-sampled navigation graph.</summary>
public sealed class NavEdge
{
    public int To { get; set; }
    public double Cost { get; set; }
}

/// <summary>A standable position and its tactical metadata.</summary>
public sealed class NavNode
{
    public int Id { get; set; }
    public Vec3 Position { get; set; } = new();

    /// <summary>Indices of reachable neighbours and the traversal cost of each.</summary>
    public List<NavEdge> Edges { get; set; } = [];

    /// <summary>Whether this is a designated fighting position.</summary>
    public bool IsCover { get; set; }

    /// <summary>Exposure from zero (safe) to one (open).</summary>
    public double Exposure { get; set; }

    /// <summary>Tactical value of holding this position.</summary>
    public double Value { get; set; }

    /// <summary>Facing a bot should adopt while holding this node.</summary>
    public double Facing { get; set; }

    public bool Crouch { get; set; }

    /// <summary>The authored lane name, or an empty string for off-lane nodes.</summary>
    public string Lane { get; set; } = string.Empty;
}

/// <summary>
/// Navigation graph built from adaptive standable-position sampling, authored lanes,
/// cover points, spawns, and explicit traversal links.
/// </summary>
public sealed class NavGraph
{
    private const double BucketSize = 8d;
    private const double StoreyHeight = 3.4d;

    private static readonly QueryFilter NavigationFilter = new(CollisionLayer.Movement);
    private static readonly SweepHit Sweep = CollisionTypes.CreateSweepHit();
    private static readonly Vec3 Delta = new();
    private static readonly Vec3 Probe = new();

    private readonly Dictionary<int, List<int>> _buckets = [];
    private readonly ICollisionWorld _collision;

    private float[]? _scratchG;
    private float[]? _scratchF;
    private int[]? _scratchFrom;
    private byte[]? _scratchClosed;

    public NavGraph(MapDef map, ICollisionWorld collision)
    {
        _collision = collision;
        Build(map, collision);
    }

    public List<NavNode> Nodes { get; } = [];

    /// <summary>Can a player body walk directly between these two points?</summary>
    public bool CanWalkBetween(Vec3 a, Vec3 b) => Walkable(a, b, _collision);

    /// <summary>
    /// Finds the nearest node the body can actually walk to. At most six candidates
    /// are probed; if all are blocked, the nearest candidate is returned as a fallback.
    /// </summary>
    public int NearestReachableNode(Vec3 position, double maxDistance = 30d)
    {
        var candidates = new List<ReachableCandidate>();
        var order = 0;
        foreach (var index in NearbyIndices(position, maxDistance))
        {
            var distance = MathEx.Distance(Nodes[index].Position, position);
            if (distance < maxDistance)
            {
                candidates.Add(new ReachableCandidate(index, distance, order));
            }

            order++;
        }

        if (candidates.Count == 0)
        {
            return -1;
        }

        // Array.sort is stable in JavaScript. The explicit discovery-order tie-breaker
        // retains that property with List.Sort on every .NET runtime.
        candidates.Sort(static (a, b) =>
        {
            var distanceOrder = a.Distance.CompareTo(b.Distance);
            return distanceOrder != 0 ? distanceOrder : a.Order.CompareTo(b.Order);
        });

        const int limit = 6;
        for (var i = 0; i < Math.Min(limit, candidates.Count); i++)
        {
            var index = candidates[i].Index;
            if (Walkable(position, Nodes[index].Position, _collision))
            {
                return index;
            }
        }

        return candidates[0].Index;
    }

    private void Build(MapDef map, ICollisionWorld collision)
    {
        SampleGrid(map, collision);

        foreach (var lane in map.Lanes)
        {
            for (var i = 0; i < lane.Path.Count; i++)
            {
                var a = lane.Path[i];
                AddNode(a, collision, new NodeOptions(lane.Name, 0.6d, 0.5d));

                if (i + 1 >= lane.Path.Count)
                {
                    continue;
                }

                var b = lane.Path[i + 1];
                var distance = MathEx.Distance(a, b);
                var steps = (int)Math.Floor(distance / 8d);
                for (var step = 1; step <= steps; step++)
                {
                    var amount = (double)step / (steps + 1);
                    AddNode(
                        new Vec3(
                            a.X + (b.X - a.X) * amount,
                            a.Y + (b.Y - a.Y) * amount,
                            a.Z + (b.Z - a.Z) * amount),
                        collision,
                        new NodeOptions(lane.Name, 0.6d, 0.4d));
                }
            }
        }

        foreach (var coverPoint in map.CoverPoints)
        {
            AddNode(
                coverPoint.Position,
                collision,
                new NodeOptions(
                    string.Empty,
                    coverPoint.Exposure,
                    coverPoint.Value,
                    true,
                    coverPoint.Facing,
                    coverPoint.Crouch));
        }

        foreach (var spawn in map.Spawns)
        {
            AddNode(
                spawn.Position,
                collision,
                new NodeOptions(string.Empty, 0.5d, 0.2d),
                6d);
        }

        const double maximumEdge = 6.5d;
        for (var i = 0; i < Nodes.Count; i++)
        {
            var a = Nodes[i];
            foreach (var j in NearbyIndices(a.Position, maximumEdge))
            {
                if (j <= i)
                {
                    continue;
                }

                var b = Nodes[j];
                var distance = MathEx.Distance(a.Position, b.Position);
                if (distance > maximumEdge || Math.Abs(a.Position.Y - b.Position.Y) > 1.2d)
                {
                    continue;
                }

                if (!Walkable(a.Position, b.Position, collision))
                {
                    continue;
                }

                var cost = distance * (1d + (a.Exposure + b.Exposure) * 0.25d);
                a.Edges.Add(new NavEdge { To = j, Cost = cost });
                b.Edges.Add(new NavEdge { To = i, Cost = cost });
            }
        }

        foreach (var link in map.NavLinks)
        {
            var from = NearestNode(link.From, 6d);
            var to = NearestNode(link.To, 6d);
            if (from < 0 || to < 0 || from == to)
            {
                continue;
            }

            var distance = MathEx.Distance(link.From, link.To);
            Nodes[from].Edges.Add(new NavEdge { To = to, Cost = distance * link.Cost });
            if (link.Bidirectional)
            {
                Nodes[to].Edges.Add(new NavEdge { To = from, Cost = distance * link.Cost });
            }
        }

        KeepLargestComponent();
    }

    /// <summary>
    /// Removes standable but disconnected roofs, ledges, and out-of-bounds surfaces,
    /// retaining the first largest component when component sizes tie.
    /// </summary>
    private void KeepLargestComponent()
    {
        if (Nodes.Count == 0)
        {
            return;
        }

        var component = new int[Nodes.Count];
        Array.Fill(component, -1);
        var bestId = -1;
        var bestSize = 0;
        var nextId = 0;

        for (var start = 0; start < Nodes.Count; start++)
        {
            if (component[start] != -1)
            {
                continue;
            }

            var id = nextId++;
            var size = 0;
            var stack = new List<int> { start };
            component[start] = id;
            while (stack.Count > 0)
            {
                var slot = stack.Count - 1;
                var nodeIndex = stack[slot];
                stack.RemoveAt(slot);
                size++;

                foreach (var edge in Nodes[nodeIndex].Edges)
                {
                    if (component[edge.To] != -1)
                    {
                        continue;
                    }

                    component[edge.To] = id;
                    stack.Add(edge.To);
                }
            }

            if (size > bestSize)
            {
                bestSize = size;
                bestId = id;
            }
        }

        if (bestSize == Nodes.Count)
        {
            return;
        }

        var remap = new int[Nodes.Count];
        Array.Fill(remap, -1);
        var kept = new List<NavNode>(bestSize);
        for (var i = 0; i < Nodes.Count; i++)
        {
            if (component[i] != bestId)
            {
                continue;
            }

            remap[i] = kept.Count;
            kept.Add(Nodes[i]);
        }

        foreach (var node in kept)
        {
            var edges = new List<NavEdge>(node.Edges.Count);
            foreach (var edge in node.Edges)
            {
                var mapped = remap[edge.To];
                if (mapped != -1)
                {
                    edges.Add(new NavEdge { To = mapped, Cost = edge.Cost });
                }
            }

            node.Edges = edges;
        }

        for (var i = 0; i < kept.Count; i++)
        {
            kept[i].Id = i;
        }

        Nodes.Clear();
        Nodes.AddRange(kept);

        _buckets.Clear();
        foreach (var node in Nodes)
        {
            BucketOf(node.Position).Add(node.Id);
        }

        _scratchG = null;
        _scratchF = null;
        _scratchFrom = null;
        _scratchClosed = null;
    }

    /// <summary>
    /// Adaptively samples up to four standable floors in each X/Z column. Small maps
    /// use denser spacing so narrow walkable gaps are not skipped.
    /// </summary>
    private void SampleGrid(MapDef map, ICollisionWorld collision)
    {
        var extent = Math.Max(
            map.Bounds.Max.X - map.Bounds.Min.X,
            map.Bounds.Max.Z - map.Bounds.Min.Z);
        var spacing = Math.Max(1.5d, Math.Min(3d, extent / 26d));
        var minimumX = map.Bounds.Min.X + 1d;
        var maximumX = map.Bounds.Max.X - 1d;
        var minimumZ = map.Bounds.Min.Z + 1d;
        var maximumZ = map.Bounds.Max.Z - 1d;
        var ceiling = map.Bounds.Max.Y;

        for (var z = minimumZ; z <= maximumZ; z += spacing)
        {
            for (var x = minimumX; x <= maximumX; x += spacing)
            {
                var probeY = ceiling;
                for (var level = 0; level < 4; level++)
                {
                    var groundY = collision.GroundHeightAt(
                        x,
                        z,
                        probeY,
                        probeY - map.Bounds.Min.Y);
                    if (!double.IsFinite(groundY))
                    {
                        break;
                    }

                    var feet = new Vec3(x, groundY + 0.05d, z);
                    if (collision.IsCapsuleFree(
                            feet,
                            GameConstants.StanceHeight.Stand,
                            GameConstants.PlayerRadius,
                            NavigationFilter))
                    {
                        PushNode(new NodeSpec(
                            feet,
                            false,
                            0.55d,
                            0.3d,
                            0d,
                            false,
                            string.Empty));
                    }

                    probeY = groundY - 0.3d;
                    if (probeY <= map.Bounds.Min.Y)
                    {
                        break;
                    }
                }
            }
        }
    }

    private int PushNode(NodeSpec spec)
    {
        var node = new NavNode
        {
            Id = Nodes.Count,
            Position = spec.Position,
            IsCover = spec.IsCover,
            Exposure = spec.Exposure,
            Value = spec.Value,
            Facing = spec.Facing,
            Crouch = spec.Crouch,
            Lane = spec.Lane,
        };
        Nodes.Add(node);
        BucketOf(node.Position).Add(node.Id);
        return node.Id;
    }

    /// <summary>Finds the real floor on the storey intended by an authored point.</summary>
    private static double FloorNear(Vec3 position, ICollisionWorld collision)
    {
        var inStorey = collision.GroundHeightAt(
            position.X,
            position.Z,
            position.Y + 1d,
            StoreyHeight);
        if (double.IsFinite(inStorey))
        {
            return inStorey;
        }

        return collision.GroundHeightAt(position.X, position.Z, position.Y + 4d, 14d);
    }

    private int AddNode(
        Vec3 position,
        ICollisionWorld collision,
        NodeOptions options,
        double minimumSeparation = 2.2d)
    {
        var groundY = FloorNear(position, collision);
        var y = double.IsFinite(groundY) ? groundY + 0.05d : position.Y;
        var adjusted = new Vec3(position.X, y, position.Z);

        if (!collision.IsCapsuleFree(
                adjusted,
                GameConstants.StanceHeight.Crouch,
                GameConstants.PlayerRadius,
                NavigationFilter))
        {
            return -1;
        }

        foreach (var index in NearbyIndices(adjusted, minimumSeparation))
        {
            var existing = Nodes[index];
            if (MathEx.Distance(existing.Position, adjusted) >= minimumSeparation)
            {
                continue;
            }

            if (options.IsCover && !existing.IsCover)
            {
                existing.IsCover = true;
                existing.Facing = options.Facing;
                existing.Crouch = options.Crouch;
                existing.Exposure = options.Exposure;
                existing.Value = Math.Max(existing.Value, options.Value);
            }
            else if (options.Lane.Length > 0 && existing.Lane.Length == 0)
            {
                existing.Lane = options.Lane;
            }

            return index;
        }

        return PushNode(new NodeSpec(
            adjusted,
            options.IsCover,
            options.Exposure,
            options.Value,
            options.Facing,
            options.Crouch,
            options.Lane));
    }

    /// <summary>
    /// Checks a route with stepped capsule sweeps, following the real floor and retrying
    /// low obstructions exactly as the movement controller's step-up path would.
    /// </summary>
    private static bool Walkable(Vec3 a, Vec3 b, ICollisionWorld collision)
    {
        MathEx.Subtract(Delta, b, a);
        var distance = Math.Sqrt(Delta.X * Delta.X + Delta.Z * Delta.Z);
        if (distance < 0.01d)
        {
            return true;
        }

        var steps = Math.Max(2, (int)Math.Ceiling(distance / 1.5d));
        MathEx.Set(Probe, a.X, a.Y, a.Z);

        for (var i = 1; i <= steps; i++)
        {
            var amount = (double)i / steps;
            var targetX = a.X + (b.X - a.X) * amount;
            var targetZ = a.Z + (b.Z - a.Z) * amount;

            var groundY = collision.GroundHeightAt(targetX, targetZ, Probe.Y + 2.2d, 5d);
            if (!double.IsFinite(groundY))
            {
                return false;
            }

            var rise = groundY + 0.05d - Probe.Y;
            if (rise > 0.55d || rise < -2.5d)
            {
                return false;
            }

            var next = new Vec3(targetX, groundY + 0.05d, targetZ);
            MathEx.Subtract(Delta, next, Probe);
            collision.SweepCapsule(
                Probe,
                GameConstants.StanceHeight.Crouch,
                GameConstants.PlayerRadius,
                Delta,
                NavigationFilter,
                Sweep);
            if (Sweep.Hit && Sweep.Fraction < 0.92d)
            {
                if (rise > GameConstants.Move.StepHeight)
                {
                    return false;
                }

                var lifted = new Vec3(Probe.X, next.Y, Probe.Z);
                if (!collision.IsCapsuleFree(
                        lifted,
                        GameConstants.StanceHeight.Crouch,
                        GameConstants.PlayerRadius,
                        NavigationFilter))
                {
                    return false;
                }

                MathEx.Subtract(Delta, next, lifted);
                collision.SweepCapsule(
                    lifted,
                    GameConstants.StanceHeight.Crouch,
                    GameConstants.PlayerRadius,
                    Delta,
                    NavigationFilter,
                    Sweep);
                if (Sweep.Hit && Sweep.Fraction < 0.92d)
                {
                    return false;
                }
            }

            MathEx.Set(Probe, next.X, next.Y, next.Z);
        }

        return true;
    }

    private static int BucketKey(double x, double z)
    {
        var bucketX = (int)Math.Floor(x / BucketSize) + 512;
        var bucketZ = (int)Math.Floor(z / BucketSize) + 512;
        return bucketZ * 1024 + bucketX;
    }

    private List<int> BucketOf(Vec3 position)
    {
        var key = BucketKey(position.X, position.Z);
        if (!_buckets.TryGetValue(key, out var bucket))
        {
            bucket = [];
            _buckets.Add(key, bucket);
        }

        return bucket;
    }

    /// <summary>Enumerates bucket contents in the same dz/dx/insertion order as the web graph.</summary>
    private IEnumerable<int> NearbyIndices(Vec3 position, double radius)
    {
        var cells = (int)Math.Ceiling(radius / BucketSize);
        for (var deltaZ = -cells; deltaZ <= cells; deltaZ++)
        {
            for (var deltaX = -cells; deltaX <= cells; deltaX++)
            {
                var key = BucketKey(
                    position.X + deltaX * BucketSize,
                    position.Z + deltaZ * BucketSize);
                if (!_buckets.TryGetValue(key, out var bucket))
                {
                    continue;
                }

                foreach (var index in bucket)
                {
                    yield return index;
                }
            }
        }
    }

    public int NearestNode(Vec3 position, double maxDistance = 30d)
    {
        var best = -1;
        var bestDistance = maxDistance;
        foreach (var index in NearbyIndices(position, maxDistance))
        {
            var distance = MathEx.Distance(Nodes[index].Position, position);
            if (distance < bestDistance)
            {
                bestDistance = distance;
                best = index;
            }
        }

        return best;
    }

    /// <summary>A* path from start to goal, inclusive, or an empty list if unreachable.</summary>
    public List<int> FindPath(int startIndex, int goalIndex, List<int>? output = null)
    {
        output ??= [];
        output.Clear();
        if (startIndex < 0 || goalIndex < 0 || startIndex >= Nodes.Count || goalIndex >= Nodes.Count)
        {
            return output;
        }

        if (startIndex == goalIndex)
        {
            output.Add(startIndex);
            return output;
        }

        var nodeCount = Nodes.Count;
        var gScore = _scratchG ??= new float[nodeCount];
        var fScore = _scratchF ??= new float[nodeCount];
        var cameFrom = _scratchFrom ??= new int[nodeCount];
        var closed = _scratchClosed ??= new byte[nodeCount];

        if (gScore.Length < nodeCount)
        {
            _scratchG = new float[nodeCount];
            _scratchF = new float[nodeCount];
            _scratchFrom = new int[nodeCount];
            _scratchClosed = new byte[nodeCount];
            return FindPath(startIndex, goalIndex, output);
        }

        Array.Fill(gScore, float.PositiveInfinity);
        Array.Fill(fScore, float.PositiveInfinity);
        Array.Fill(cameFrom, -1);
        Array.Clear(closed);

        var goal = Nodes[goalIndex].Position;
        var open = new List<int> { startIndex };
        gScore[startIndex] = 0f;
        fScore[startIndex] = (float)MathEx.Distance(Nodes[startIndex].Position, goal);

        var guard = 0;
        while (open.Count > 0 && guard++ < 4096)
        {
            var bestSlot = 0;
            for (var i = 1; i < open.Count; i++)
            {
                if (fScore[open[i]] < fScore[open[bestSlot]])
                {
                    bestSlot = i;
                }
            }

            var current = open[bestSlot];
            if (current == goalIndex)
            {
                var node = current;
                while (node != -1)
                {
                    output.Add(node);
                    node = cameFrom[node];
                }

                output.Reverse();
                return output;
            }

            open.RemoveAt(bestSlot);
            closed[current] = 1;

            foreach (var edge in Nodes[current].Edges)
            {
                if (closed[edge.To] != 0)
                {
                    continue;
                }

                var tentative = (double)gScore[current] + edge.Cost;
                if (tentative >= gScore[edge.To])
                {
                    continue;
                }

                cameFrom[edge.To] = current;
                gScore[edge.To] = (float)tentative;
                fScore[edge.To] = (float)(tentative + MathEx.Distance(Nodes[edge.To].Position, goal));
                if (!open.Contains(edge.To))
                {
                    open.Add(edge.To);
                }
            }
        }

        return output;
    }

    /// <summary>Returns the highest-scoring authored cover near a point.</summary>
    public NavNode? FindCover(Vec3 near, Vec3 threatFrom, double radius = 25d)
    {
        NavNode? best = null;
        var bestScore = double.NegativeInfinity;

        MathEx.Subtract(Delta, threatFrom, near);
        MathEx.Normalize(Delta, Delta);

        foreach (var index in NearbyIndices(near, radius))
        {
            var node = Nodes[index];
            if (!node.IsCover)
            {
                continue;
            }

            var distance = MathEx.Distance(node.Position, near);
            if (distance > radius)
            {
                continue;
            }

            var score = node.Value * 10d - node.Exposure * 8d - distance * 0.25d;
            var deltaX = threatFrom.X - node.Position.X;
            var deltaZ = threatFrom.Z - node.Position.Z;
            var toThreat = Math.Atan2(-deltaX, -deltaZ);
            var facingError = Math.Abs(Wrap(toThreat - node.Facing));
            score -= facingError * 2.2d;

            var threatDistance = MathEx.DistanceXz(node.Position, threatFrom);
            if (threatDistance < 6d)
            {
                score -= 12d;
            }

            if (score > bestScore)
            {
                bestScore = score;
                best = node;
            }
        }

        return best;
    }

    public int Size => Nodes.Count;

    /// <summary>Fraction of nodes reachable from the largest discovered component.</summary>
    public double Connectivity()
    {
        if (Nodes.Count == 0)
        {
            return 1d;
        }

        var seen = new byte[Nodes.Count];
        var bestComponent = 0;
        for (var start = 0; start < Nodes.Count; start++)
        {
            if (seen[start] != 0)
            {
                continue;
            }

            var count = 0;
            var stack = new List<int> { start };
            seen[start] = 1;
            while (stack.Count > 0)
            {
                var slot = stack.Count - 1;
                var nodeIndex = stack[slot];
                stack.RemoveAt(slot);
                count++;

                foreach (var edge in Nodes[nodeIndex].Edges)
                {
                    if (seen[edge.To] != 0)
                    {
                        continue;
                    }

                    seen[edge.To] = 1;
                    stack.Add(edge.To);
                }
            }

            if (count > bestComponent)
            {
                bestComponent = count;
            }
        }

        return (double)bestComponent / Nodes.Count;
    }

    private static double Wrap(double angle)
    {
        var wrapped = (angle + Math.PI) % (Math.PI * 2d);
        if (wrapped < 0d)
        {
            wrapped += Math.PI * 2d;
        }

        return wrapped - Math.PI;
    }

    private readonly record struct ReachableCandidate(int Index, double Distance, int Order);

    private readonly record struct NodeOptions(
        string Lane,
        double Exposure,
        double Value,
        bool IsCover = false,
        double Facing = 0d,
        bool Crouch = false);

    private readonly record struct NodeSpec(
        Vec3 Position,
        bool IsCover,
        double Exposure,
        double Value,
        double Facing,
        bool Crouch,
        string Lane);
}
