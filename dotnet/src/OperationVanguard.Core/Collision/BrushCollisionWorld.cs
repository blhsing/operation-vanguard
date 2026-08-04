namespace OperationVanguard.Core;

/// <summary>
/// Exact brush collision backed by a four-metre XZ spatial hash. Queries retain
/// authored brush order and write into caller-owned result records.
/// </summary>
public sealed partial class BrushCollisionWorld : ICollisionWorld
{
    private const double CellSize = 4d;
    private const double ContactEpsilon = 1e-4;

    private readonly List<BrushCollider> _colliders = [];
    private readonly Aabb _bounds;
    private readonly Dictionary<int, List<int>> _grid = [];
    private readonly int _gridMinX;
    private readonly int _gridMinZ;
    private readonly int _gridW;
    private readonly int _gridH;
    private readonly int[] _visited;
    private int _queryStamp;
    private IReadOnlyList<DynamicCollider> _dynamics = Array.Empty<DynamicCollider>();

    // Instance scratch mirrors the web implementation's module scratch while
    // allowing independent collision worlds to be queried concurrently.
    private readonly Vec3 _local = new();
    private readonly Vec3 _localDir = new();
    private readonly Vec3 _localNormal = new();
    private readonly Vec3 _worldNormal = new();
    private readonly Vec3 _sweptMin = new();
    private readonly Vec3 _sweptMax = new();
    private readonly Vec3 _expandedMin = new();
    private readonly Vec3 _expandedMax = new();
    private readonly Vec3 _point = new();
    private readonly Vec3 _probeA = new();
    private readonly Vec3 _probeB = new();
    private readonly Vec3 _pushOut = new();
    private readonly Vec3 _mtv = new();
    private readonly Vec3 _localBoxMin = new();
    private readonly Vec3 _localBoxMax = new();
    private readonly Aabb _localBox;
    private readonly RaycastHit _sharedRay = new();
    private readonly BrushCollider _tempCollider = new()
    {
        Shape = ColliderShape.Box,
        BrushIndex = -1,
        Surface = SurfaceType.Metal,
        Layer = CollisionLayer.Deployable,
    };

    private static readonly QueryFilter GroundFilter =
        new(CollisionLayer.World | CollisionLayer.Breakable);

    public BrushCollisionWorld(IReadOnlyList<Brush> brushes, MapBounds bounds)
        : this(brushes, new Aabb(bounds.Min, bounds.Max))
    {
    }

    public BrushCollisionWorld(IReadOnlyList<Brush> brushes, Aabb bounds)
    {
        _localBox = new Aabb(_localBoxMin, _localBoxMax);
        _bounds = new Aabb(
            new Vec3(bounds.Min.X, bounds.Min.Y, bounds.Min.Z),
            new Vec3(bounds.Max.X, bounds.Max.Y, bounds.Max.Z));

        for (var brushIndex = 0; brushIndex < brushes.Count; brushIndex++)
        {
            foreach (var collider in BrushCollision.BrushToColliders(brushes[brushIndex], brushIndex))
            {
                _colliders.Add(collider);
            }
        }

        var padding = CellSize * 2d;
        _gridMinX = (int)Math.Floor((_bounds.Min.X - padding) / CellSize);
        _gridMinZ = (int)Math.Floor((_bounds.Min.Z - padding) / CellSize);
        _gridW = Math.Max(
            1,
            (int)Math.Ceiling((_bounds.Max.X + padding) / CellSize) - _gridMinX + 1);
        _gridH = Math.Max(
            1,
            (int)Math.Ceiling((_bounds.Max.Z + padding) / CellSize) - _gridMinZ + 1);

        for (var colliderIndex = 0; colliderIndex < _colliders.Count; colliderIndex++)
        {
            var collider = _colliders[colliderIndex];
            var x0 = CellX(collider.Bounds.Min.X);
            var x1 = CellX(collider.Bounds.Max.X);
            var z0 = CellZ(collider.Bounds.Min.Z);
            var z1 = CellZ(collider.Bounds.Max.Z);
            for (var z = z0; z <= z1; z++)
            {
                for (var x = x0; x <= x1; x++)
                {
                    var key = z * _gridW + x;
                    if (!_grid.TryGetValue(key, out var bucket))
                    {
                        bucket = [];
                        _grid.Add(key, bucket);
                    }

                    bucket.Add(colliderIndex);
                }
            }
        }

        _visited = new int[_colliders.Count];
    }

    public int ColliderCount => _colliders.Count;

    public void SetDynamicColliders(IReadOnlyList<DynamicCollider> colliders)
    {
        _dynamics = colliders;
    }

    public RaycastHit Raycast(
        Vec3 origin,
        Vec3 direction,
        double maxDistance,
        QueryFilter filter,
        RaycastHit output)
    {
        ResetRay(output);
        var best = maxDistance;
        var stamp = NewQuery();

        var cellX = CellX(origin.X);
        var cellZ = CellZ(origin.Z);
        var stepX = direction.X > 0d ? 1 : direction.X < 0d ? -1 : 0;
        var stepZ = direction.Z > 0d ? 1 : direction.Z < 0d ? -1 : 0;
        var inverseX = Math.Abs(direction.X) > MathEx.Epsilon
            ? 1d / direction.X
            : double.PositiveInfinity;
        var inverseZ = Math.Abs(direction.Z) > MathEx.Epsilon
            ? 1d / direction.Z
            : double.PositiveInfinity;
        var worldX = (cellX + _gridMinX) * CellSize;
        var worldZ = (cellZ + _gridMinZ) * CellSize;
        var nextX = stepX == 0
            ? double.PositiveInfinity
            : ((stepX > 0 ? worldX + CellSize : worldX) - origin.X) * inverseX;
        var nextZ = stepZ == 0
            ? double.PositiveInfinity
            : ((stepZ > 0 ? worldZ + CellSize : worldZ) - origin.Z) * inverseZ;
        var deltaX = stepX == 0 ? double.PositiveInfinity : Math.Abs(CellSize * inverseX);
        var deltaZ = stepZ == 0 ? double.PositiveInfinity : Math.Abs(CellSize * inverseZ);
        var travelled = 0d;
        var maxCells = _gridW + _gridH + 4;

        for (var cell = 0; cell < maxCells; cell++)
        {
            if (cellX < 0 || cellZ < 0 || cellX >= _gridW || cellZ >= _gridH ||
                travelled > maxDistance || travelled > best)
            {
                break;
            }

            if (_grid.TryGetValue(cellZ * _gridW + cellX, out var bucket))
            {
                foreach (var colliderIndex in bucket)
                {
                    if (_visited[colliderIndex] == stamp)
                    {
                        continue;
                    }

                    _visited[colliderIndex] = stamp;
                    var collider = _colliders[colliderIndex];
                    if ((collider.Layer & filter.Layers) == 0)
                    {
                        continue;
                    }

                    var distance = RayCollider(origin, direction, best, collider, _worldNormal);
                    if (distance >= 0d && distance < best)
                    {
                        best = distance;
                        output.Hit = true;
                        output.Distance = distance;
                        output.BrushIndex = collider.BrushIndex;
                        output.Surface = collider.Surface;
                        output.Layer = collider.Layer;
                        output.Entity = 0;
                        MathEx.Copy(output.Normal, _worldNormal);
                        output.Thickness = MeasureThickness(origin, direction, distance, collider);
                    }
                }
            }

            // The TypeScript walker advances Z on an exact boundary tie.
            if (nextX < nextZ)
            {
                travelled = nextX;
                nextX += deltaX;
                cellX += stepX;
            }
            else
            {
                travelled = nextZ;
                nextZ += deltaZ;
                cellZ += stepZ;
            }

            if (!double.IsFinite(travelled))
            {
                break;
            }
        }

        foreach (var dynamicCollider in _dynamics)
        {
            if (!dynamicCollider.Active ||
                (dynamicCollider.Layer & filter.Layers) == 0 ||
                !filter.IncludesEntity(dynamicCollider.Id))
            {
                continue;
            }

            var distance = RayDynamic(origin, direction, best, dynamicCollider, _worldNormal);
            if (distance >= 0d && distance < best)
            {
                best = distance;
                output.Hit = true;
                output.Distance = distance;
                output.BrushIndex = -1;
                output.Surface = dynamicCollider.Kind == DynamicColliderKind.Capsule
                    ? SurfaceType.Flesh
                    : SurfaceType.Metal;
                output.Layer = dynamicCollider.Layer;
                output.Entity = dynamicCollider.Id;
                output.Thickness = dynamicCollider.Kind == DynamicColliderKind.Capsule
                    ? dynamicCollider.Radius * 2d
                    : 0.4d;
                MathEx.Copy(output.Normal, _worldNormal);
            }
        }

        if (output.Hit)
        {
            output.Point.X = origin.X + direction.X * output.Distance;
            output.Point.Y = origin.Y + direction.Y * output.Distance;
            output.Point.Z = origin.Z + direction.Z * output.Distance;
        }

        return output;
    }

    public int RaycastAll(
        Vec3 origin,
        Vec3 direction,
        double maxDistance,
        QueryFilter filter,
        IList<RaycastHit> output,
        int maxHits)
    {
        var count = 0;
        var travelled = 0d;
        MathEx.Copy(_probeA, origin);

        while (count < maxHits && count < output.Count && travelled < maxDistance)
        {
            var hit = output[count];
            Raycast(_probeA, direction, maxDistance - travelled, filter, hit);
            if (!hit.Hit)
            {
                break;
            }

            hit.Distance += travelled;
            count++;
            var step = Math.Max(hit.Thickness, 0.02d) + 0.01d;
            travelled = hit.Distance + step;
            _probeA.X = origin.X + direction.X * travelled;
            _probeA.Y = origin.Y + direction.Y * travelled;
            _probeA.Z = origin.Z + direction.Z * travelled;
        }

        return count;
    }

    public bool IsVisible(Vec3 from, Vec3 to, QueryFilter filter)
    {
        var dx = to.X - from.X;
        var dy = to.Y - from.Y;
        var dz = to.Z - from.Z;
        var distance = Math.Sqrt(dx * dx + dy * dy + dz * dz);
        if (distance < MathEx.Epsilon)
        {
            return true;
        }

        MathEx.Set(_localDir, dx / distance, dy / distance, dz / distance);
        return !Raycast(from, _localDir, distance - 0.02d, filter, _sharedRay).Hit;
    }

    public double GroundHeightAt(double x, double z, double fromY, double maxDrop)
    {
        MathEx.Set(_probeB, x, fromY, z);
        MathEx.Set(_localDir, 0d, -1d, 0d);
        var hit = Raycast(_probeB, _localDir, maxDrop, GroundFilter, _sharedRay);
        return hit.Hit ? fromY - hit.Distance : double.NegativeInfinity;
    }

    public SweepHit SweepCapsule(
        Vec3 start,
        double height,
        double radius,
        Vec3 delta,
        QueryFilter filter,
        SweepHit output)
    {
        ResetSweep(output);
        var length = Math.Sqrt(delta.X * delta.X + delta.Y * delta.Y + delta.Z * delta.Z);
        if (length < MathEx.Epsilon)
        {
            output.StartedSolid = CapsuleOverlaps(start, height, radius, filter);
            if (output.StartedSolid)
            {
                output.Fraction = 0d;
            }

            return output;
        }

        MathEx.Set(
            _sweptMin,
            Math.Min(start.X, start.X + delta.X) - radius,
            Math.Min(start.Y, start.Y + delta.Y),
            Math.Min(start.Z, start.Z + delta.Z) - radius);
        MathEx.Set(
            _sweptMax,
            Math.Max(start.X, start.X + delta.X) + radius,
            Math.Max(start.Y, start.Y + delta.Y) + height,
            Math.Max(start.Z, start.Z + delta.Z) + radius);

        if (CapsuleOverlaps(start, height, radius, filter))
        {
            output.StartedSolid = true;
            output.Fraction = 0d;
            output.Hit = true;
            if (ComputePushOut(start, height, radius, filter, _pushOut))
            {
                MathEx.Copy(output.Normal, _pushOut);
                MathEx.Normalize(output.Normal, output.Normal);
            }

            MathEx.Copy(output.Point, start);
            return output;
        }

        var maximumStep = Math.Max(radius * 0.65d, 0.05d);
        var steps = Math.Min(64, Math.Max(1, (int)Math.Ceiling(length / maximumStep)));
        var lastFree = 0d;
        var firstHit = -1d;

        for (var step = 1; step <= steps; step++)
        {
            var fraction = (double)step / steps;
            _probeA.X = start.X + delta.X * fraction;
            _probeA.Y = start.Y + delta.Y * fraction;
            _probeA.Z = start.Z + delta.Z * fraction;
            if (CapsuleOverlaps(_probeA, height, radius, filter))
            {
                firstHit = fraction;
                break;
            }

            lastFree = fraction;
        }

        if (firstHit < 0d)
        {
            output.Fraction = 1d;
            return output;
        }

        var low = lastFree;
        var high = firstHit;
        for (var iteration = 0; iteration < 8; iteration++)
        {
            var middle = (low + high) * 0.5d;
            _probeA.X = start.X + delta.X * middle;
            _probeA.Y = start.Y + delta.Y * middle;
            _probeA.Z = start.Z + delta.Z * middle;
            if (CapsuleOverlaps(_probeA, height, radius, filter))
            {
                high = middle;
            }
            else
            {
                low = middle;
            }
        }

        output.Hit = true;
        output.Fraction = MathEx.Clamp(low, 0d, 1d);
        MathEx.Set(
            output.Point,
            start.X + delta.X * output.Fraction,
            start.Y + delta.Y * output.Fraction,
            start.Z + delta.Z * output.Fraction);

        _probeA.X = start.X + delta.X * high;
        _probeA.Y = start.Y + delta.Y * high;
        _probeA.Z = start.Z + delta.Z * high;
        if (ComputePushOut(_probeA, height, radius, filter, _pushOut))
        {
            MathEx.Normalize(output.Normal, _pushOut);
        }
        else
        {
            MathEx.Set(
                output.Normal,
                -delta.X / length,
                -delta.Y / length,
                -delta.Z / length);
        }

        return output;
    }

    public bool ResolvePenetration(
        Vec3 position,
        double height,
        double radius,
        QueryFilter filter,
        Vec3 output)
    {
        MathEx.Copy(output, position);
        var moved = false;
        for (var pass = 0; pass < 4; pass++)
        {
            if (!ComputePushOut(output, height, radius, filter, _pushOut))
            {
                break;
            }

            var magnitude = Math.Sqrt(
                _pushOut.X * _pushOut.X +
                _pushOut.Y * _pushOut.Y +
                _pushOut.Z * _pushOut.Z);
            if (magnitude < 1e-4d)
            {
                break;
            }

            output.X += _pushOut.X;
            output.Y += _pushOut.Y;
            output.Z += _pushOut.Z;
            moved = true;
            if (!CapsuleOverlaps(output, height, radius, filter))
            {
                break;
            }
        }

        return moved;
    }

    public bool IsCapsuleFree(
        Vec3 position,
        double height,
        double radius,
        QueryFilter filter) =>
        !CapsuleOverlaps(position, height, radius, filter);

    private bool CapsuleOverlaps(
        Vec3 position,
        double height,
        double radius,
        QueryFilter filter)
    {
        SetExpandedCapsuleBounds(position, height, radius);
        var x0 = CellX(_expandedMin.X);
        var x1 = CellX(_expandedMax.X);
        var z0 = CellZ(_expandedMin.Z);
        var z1 = CellZ(_expandedMax.Z);
        var stamp = NewQuery();

        for (var z = z0; z <= z1; z++)
        {
            for (var x = x0; x <= x1; x++)
            {
                if (!_grid.TryGetValue(z * _gridW + x, out var bucket))
                {
                    continue;
                }

                foreach (var colliderIndex in bucket)
                {
                    if (_visited[colliderIndex] == stamp)
                    {
                        continue;
                    }

                    _visited[colliderIndex] = stamp;
                    var collider = _colliders[colliderIndex];
                    if ((collider.Layer & filter.Layers) == 0 ||
                        !OverlapsExpanded(collider.Bounds) ||
                        !ColliderOverlapsCapsule(collider, position, height, radius, null))
                    {
                        continue;
                    }

                    return true;
                }
            }
        }

        foreach (var dynamicCollider in _dynamics)
        {
            if (dynamicCollider.Active &&
                (dynamicCollider.Layer & filter.Layers) != 0 &&
                filter.IncludesEntity(dynamicCollider.Id) &&
                DynamicOverlapsCapsule(dynamicCollider, position, height, radius, null))
            {
                return true;
            }
        }

        return false;
    }

    private bool ComputePushOut(
        Vec3 position,
        double height,
        double radius,
        QueryFilter filter,
        Vec3 output)
    {
        MathEx.Set(output, 0d, 0d, 0d);
        var any = false;
        SetExpandedCapsuleBounds(position, height, radius);
        var x0 = CellX(_expandedMin.X);
        var x1 = CellX(_expandedMax.X);
        var z0 = CellZ(_expandedMin.Z);
        var z1 = CellZ(_expandedMax.Z);
        var stamp = NewQuery();

        for (var z = z0; z <= z1; z++)
        {
            for (var x = x0; x <= x1; x++)
            {
                if (!_grid.TryGetValue(z * _gridW + x, out var bucket))
                {
                    continue;
                }

                foreach (var colliderIndex in bucket)
                {
                    if (_visited[colliderIndex] == stamp)
                    {
                        continue;
                    }

                    _visited[colliderIndex] = stamp;
                    var collider = _colliders[colliderIndex];
                    if ((collider.Layer & filter.Layers) == 0 ||
                        !OverlapsExpanded(collider.Bounds) ||
                        !ColliderOverlapsCapsule(collider, position, height, radius, _mtv))
                    {
                        continue;
                    }

                    output.X += _mtv.X;
                    output.Y += _mtv.Y;
                    output.Z += _mtv.Z;
                    any = true;
                }
            }
        }

        foreach (var dynamicCollider in _dynamics)
        {
            if (!dynamicCollider.Active ||
                (dynamicCollider.Layer & filter.Layers) == 0 ||
                !filter.IncludesEntity(dynamicCollider.Id) ||
                !DynamicOverlapsCapsule(dynamicCollider, position, height, radius, _mtv))
            {
                continue;
            }

            output.X += _mtv.X;
            output.Y += _mtv.Y;
            output.Z += _mtv.Z;
            any = true;
        }

        return any;
    }

    private void SetExpandedCapsuleBounds(Vec3 position, double height, double radius)
    {
        MathEx.Set(
            _expandedMin,
            position.X - radius,
            position.Y,
            position.Z - radius);
        MathEx.Set(
            _expandedMax,
            position.X + radius,
            position.Y + height,
            position.Z + radius);
    }

    private bool OverlapsExpanded(Aabb bounds) =>
        bounds.Min.X <= _expandedMax.X && bounds.Max.X >= _expandedMin.X &&
        bounds.Min.Y <= _expandedMax.Y && bounds.Max.Y >= _expandedMin.Y &&
        bounds.Min.Z <= _expandedMax.Z && bounds.Max.Z >= _expandedMin.Z;

    private int CellX(double x) =>
        Math.Clamp((int)Math.Floor(x / CellSize) - _gridMinX, 0, _gridW - 1);

    private int CellZ(double z) =>
        Math.Clamp((int)Math.Floor(z / CellSize) - _gridMinZ, 0, _gridH - 1);

    private int NewQuery()
    {
        _queryStamp++;
        if (_queryStamp == int.MaxValue)
        {
            Array.Clear(_visited);
            _queryStamp = 1;
        }

        return _queryStamp;
    }

    private static void ResetSweep(SweepHit output)
    {
        output.Hit = false;
        output.Fraction = 1d;
        output.StartedSolid = false;
        output.Entity = 0;
        output.BrushIndex = -1;
        output.Surface = SurfaceType.Concrete;
        MathEx.Set(output.Normal, 0d, 1d, 0d);
        MathEx.Set(output.Point, 0d, 0d, 0d);
    }

    private static void ResetRay(RaycastHit output)
    {
        output.Hit = false;
        output.Distance = 0d;
        output.Entity = 0;
        output.BrushIndex = -1;
        output.Surface = SurfaceType.Concrete;
        output.Thickness = 0d;
        output.Layer = CollisionLayer.None;
        MathEx.Set(output.Normal, 0d, 1d, 0d);
        MathEx.Set(output.Point, 0d, 0d, 0d);
    }
}
