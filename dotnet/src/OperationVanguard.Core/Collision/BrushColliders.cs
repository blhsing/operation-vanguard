namespace OperationVanguard.Core;

/// <summary>The exact convex primitive generated for an authored map brush.</summary>
public enum ColliderShape
{
    Box = 0,
    Cylinder = 1,
}

/// <summary>
/// Cached collision representation of one brush. Boxes are oriented about Y;
/// cylinders are vertical. A ramp is a box with a sloped top plane.
/// </summary>
public sealed class BrushCollider
{
    public ColliderShape Shape { get; set; }
    public int BrushIndex { get; set; }
    public Vec3 Center { get; set; } = new();
    public Vec3 Half { get; set; } = new();
    public double Yaw { get; set; }
    public double CosYaw { get; set; } = 1d;
    public double SinYaw { get; set; }
    public SurfaceType Surface { get; set; }
    public CollisionLayer Layer { get; set; }
    public Aabb Bounds { get; set; } = new();
    public Vec3? SlopeNormal { get; set; }
    public double SlopeD { get; set; }
}

public enum DynamicColliderKind
{
    Capsule = 0,
    Box = 1,
}

/// <summary>Collision proxy for an entity; capsule positions are at the feet.</summary>
public sealed class DynamicCollider
{
    public int Id { get; set; }
    public CollisionLayer Layer { get; set; }
    public Vec3 Position { get; set; } = new();
    public DynamicColliderKind Kind { get; set; }
    public double Height { get; set; }
    public double Radius { get; set; }
    public Vec3? Size { get; set; }
    public double? Yaw { get; set; }
    public bool Active { get; set; }
}

/// <summary>Stable brush-to-primitive conversion shared with rendering/debug tools.</summary>
public static class BrushCollision
{
    public static IReadOnlyList<BrushCollider> BrushToColliders(Brush brush, int brushIndex)
    {
        var layer = LayersForBrush(brush);
        if (layer == CollisionLayer.None)
        {
            return Array.Empty<BrushCollider>();
        }

        var yaw = brush.Yaw ?? 0d;
        switch (brush.Kind)
        {
            case BrushKind.Box:
            {
                var size = RequireSize(brush);
                return
                [
                    MakeBox(
                        brushIndex,
                        brush.Position,
                        new Vec3(size.X / 2d, size.Y / 2d, size.Z / 2d),
                        yaw,
                        brush.Surface,
                        layer),
                ];
            }

            case BrushKind.Ramp:
            {
                var size = RequireSize(brush);
                var half = new Vec3(size.X / 2d, size.Y / 2d, size.Z / 2d);
                var collider = MakeBox(
                    brushIndex,
                    brush.Position,
                    half,
                    yaw,
                    brush.Surface,
                    layer);

                var nx = 0d;
                var nz = 0d;
                double run;
                switch (brush.Rise ?? RiseDirection.NegativeZ)
                {
                    case RiseDirection.PositiveX:
                        run = size.X;
                        nx = -size.Y;
                        break;
                    case RiseDirection.NegativeX:
                        run = size.X;
                        nx = size.Y;
                        break;
                    case RiseDirection.PositiveZ:
                        run = size.Z;
                        nz = -size.Y;
                        break;
                    default:
                        run = size.Z;
                        nz = size.Y;
                        break;
                }

                var length = Math.Sqrt(nx * nx + run * run + nz * nz);
                if (length == 0d)
                {
                    length = 1d;
                }

                var localX = nx / length;
                var localY = run / length;
                var localZ = nz / length;
                var worldNormal = new Vec3(
                    localX * collider.CosYaw + localZ * collider.SinYaw,
                    localY,
                    -localX * collider.SinYaw + localZ * collider.CosYaw);
                MathEx.Normalize(worldNormal, worldNormal);
                collider.SlopeNormal = worldNormal;
                // This deliberately mirrors the web implementation's final assignment:
                // the ramp plane is anchored at the brush centre.
                collider.SlopeD = MathEx.Dot(worldNormal, brush.Position);
                return [collider];
            }

            case BrushKind.Cylinder:
            {
                var radius = brush.Radius
                    ?? throw new InvalidOperationException("A cylinder brush requires Radius.");
                var height = brush.Height
                    ?? throw new InvalidOperationException("A cylinder brush requires Height.");
                var half = new Vec3(radius, height / 2d, radius);
                var position = brush.Position;
                return
                [
                    new BrushCollider
                    {
                        Shape = ColliderShape.Cylinder,
                        BrushIndex = brushIndex,
                        Center = new Vec3(position.X, position.Y, position.Z),
                        Half = half,
                        Yaw = 0d,
                        CosYaw = 1d,
                        SinYaw = 0d,
                        Surface = brush.Surface,
                        Layer = layer,
                        Bounds = new Aabb(
                            new Vec3(position.X - radius, position.Y - half.Y, position.Z - radius),
                            new Vec3(position.X + radius, position.Y + half.Y, position.Z + radius)),
                    },
                ];
            }

            case BrushKind.Plane:
            default:
                return Array.Empty<BrushCollider>();
        }
    }

    private static CollisionLayer LayersForBrush(Brush brush)
    {
        if (brush.Solid is false)
        {
            return CollisionLayer.None;
        }

        var layer = brush.BulletPassthrough is true
            ? CollisionLayer.PlayerClip
            : CollisionLayer.World;
        if (brush.Visible is false && brush.BulletPassthrough is not true)
        {
            layer = CollisionLayer.World;
        }

        if (brush.Breakable is true)
        {
            layer |= CollisionLayer.Breakable;
        }

        return layer;
    }

    private static BrushCollider MakeBox(
        int brushIndex,
        Vec3 center,
        Vec3 half,
        double yaw,
        SurfaceType surface,
        CollisionLayer layer)
    {
        var cosine = Math.Cos(yaw);
        var sine = Math.Sin(yaw);
        return new BrushCollider
        {
            Shape = ColliderShape.Box,
            BrushIndex = brushIndex,
            Center = new Vec3(center.X, center.Y, center.Z),
            Half = new Vec3(half.X, half.Y, half.Z),
            Yaw = yaw,
            CosYaw = cosine,
            SinYaw = sine,
            Surface = surface,
            Layer = layer,
            Bounds = BoundsOf(center, half, yaw),
        };
    }

    private static Aabb BoundsOf(Vec3 center, Vec3 half, double yaw)
    {
        var cosine = Math.Abs(Math.Cos(yaw));
        var sine = Math.Abs(Math.Sin(yaw));
        var extentX = cosine * half.X + sine * half.Z;
        var extentZ = sine * half.X + cosine * half.Z;
        return new Aabb(
            new Vec3(center.X - extentX, center.Y - half.Y, center.Z - extentZ),
            new Vec3(center.X + extentX, center.Y + half.Y, center.Z + extentZ));
    }

    private static Vec3 RequireSize(Brush brush) =>
        brush.Size ?? throw new InvalidOperationException($"A {brush.Kind} brush requires Size.");
}
