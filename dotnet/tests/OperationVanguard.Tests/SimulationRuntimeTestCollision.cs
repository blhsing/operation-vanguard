using OperationVanguard.Core;

namespace OperationVanguard.Tests;

internal sealed class SimulationRuntimeTestCollision : ICollisionWorld
{
    public bool RayHits { get; set; }

    public Vec3 RayPoint { get; set; } = new();

    public Vec3 RayNormal { get; set; } = new(0d, 1d, 0d);

    public bool Visible { get; set; } = true;

    public double GroundHeight { get; set; }

    public RaycastHit Raycast(
        Vec3 origin,
        Vec3 direction,
        double maxDistance,
        QueryFilter filter,
        RaycastHit output)
    {
        output.Hit = RayHits;
        output.Distance = RayHits ? 1d : 0d;
        output.Point.X = RayPoint.X;
        output.Point.Y = RayPoint.Y;
        output.Point.Z = RayPoint.Z;
        output.Normal.X = RayNormal.X;
        output.Normal.Y = RayNormal.Y;
        output.Normal.Z = RayNormal.Z;
        output.Surface = SurfaceType.Concrete;
        output.Entity = 0;
        output.BrushIndex = RayHits ? 0 : -1;
        output.Thickness = 0d;
        output.Layer = RayHits ? filter.Layers : CollisionLayer.None;
        return output;
    }

    public int RaycastAll(
        Vec3 origin,
        Vec3 direction,
        double maxDistance,
        QueryFilter filter,
        IList<RaycastHit> output,
        int maxHits) => 0;

    public SweepHit SweepCapsule(
        Vec3 start,
        double height,
        double radius,
        Vec3 delta,
        QueryFilter filter,
        SweepHit output)
    {
        output.Hit = false;
        output.Fraction = 1d;
        output.StartedSolid = false;
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
        return false;
    }

    public bool IsCapsuleFree(
        Vec3 position,
        double height,
        double radius,
        QueryFilter filter) => true;

    public bool IsVisible(Vec3 from, Vec3 to, QueryFilter filter) => Visible;

    public double GroundHeightAt(double x, double z, double fromY, double maxDrop) => GroundHeight;
}
