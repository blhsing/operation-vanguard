namespace OperationVanguard.Core;

/// <summary>
/// Lightweight, framework-free probes for the two contact-normal regressions
/// that can make campaign navigation stall. An empty result means all probes pass.
/// </summary>
public static class CollisionSelfCheck
{
    public static IReadOnlyList<string> Run()
    {
        List<string> failures = [];
        CheckCornerNormal(failures);
        CheckCylinderTopNormal(failures);
        return failures;
    }

    private static void CheckCornerNormal(List<string> failures)
    {
        const double radius = 0.35d;
        var crate = new Brush
        {
            Kind = BrushKind.Box,
            Position = new Vec3(-9.5d, 0.5d, 9.5d),
            Size = new Vec3(1d, 1d, 1d),
            Surface = SurfaceType.Wood,
        };
        var world = new BrushCollisionWorld(
            [crate],
            new MapBounds
            {
                Min = new Vec3(-30d, -5d, -30d),
                Max = new Vec3(30d, 20d, 30d),
            });
        var inset = (radius - 0.01d) / Math.Sqrt(2d);
        var hit = world.SweepCapsule(
            new Vec3(-10d - inset, 0d, 10d + inset),
            1.8d,
            radius,
            new Vec3(0d, 0d, -0.1d),
            new QueryFilter(CollisionLayer.Movement),
            new SweepHit());

        // A face-normal regression reports one horizontal component as zero.
        if (!hit.Hit || hit.Normal.X >= -0.5d || hit.Normal.Z <= 0.5d)
        {
            failures.Add(
                $"crate corner normal was ({hit.Normal.X:R}, {hit.Normal.Y:R}, {hit.Normal.Z:R})");
        }
    }

    private static void CheckCylinderTopNormal(List<string> failures)
    {
        var cylinder = new Brush
        {
            Kind = BrushKind.Cylinder,
            Position = new Vec3(0d, 0.15d, 0d),
            Radius = 6d,
            Height = 0.3d,
            Surface = SurfaceType.Concrete,
        };
        var world = new BrushCollisionWorld(
            [cylinder],
            new MapBounds
            {
                Min = new Vec3(-30d, -5d, -30d),
                Max = new Vec3(30d, 20d, 30d),
            });
        var hit = world.SweepCapsule(
            new Vec3(0d, 0.6d, 5.8d),
            1.8d,
            0.35d,
            new Vec3(0d, -0.6d, 0d),
            new QueryFilter(CollisionLayer.Movement),
            new SweepHit());

        if (!hit.Hit || hit.StartedSolid || hit.Normal.Y < 0.99d)
        {
            failures.Add(
                $"cylinder top sweep returned hit={hit.Hit}, startedSolid={hit.StartedSolid}, " +
                $"normal=({hit.Normal.X:R}, {hit.Normal.Y:R}, {hit.Normal.Z:R})");
        }
    }
}
