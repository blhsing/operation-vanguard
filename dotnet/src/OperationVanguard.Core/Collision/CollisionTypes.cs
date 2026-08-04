using System.Collections.ObjectModel;

namespace OperationVanguard.Core;

/// <summary>Bit mask selecting which categories of geometry a collision query considers.</summary>
[Flags]
public enum CollisionLayer
{
    None = 0,
    /// <summary>Static level geometry.</summary>
    World = 1 << 0,
    /// <summary>Brushes that stop players but let bullets through.</summary>
    PlayerClip = 1 << 1,
    /// <summary>Brushes that stop bullets but not players.</summary>
    BulletClip = 1 << 2,
    /// <summary>Player capsules.</summary>
    Player = 1 << 3,
    /// <summary>Deployables, care packages, and sentry guns.</summary>
    Deployable = 1 << 4,
    /// <summary>Killstreak vehicles.</summary>
    Vehicle = 1 << 5,
    /// <summary>Destructible props.</summary>
    Breakable = 1 << 6,
    /// <summary>Non-solid water volumes that affect movement and audio.</summary>
    Water = 1 << 7,

    /// <summary>Everything a walking player collides with.</summary>
    Movement = World | PlayerClip | Breakable | Deployable | Vehicle,
    /// <summary>Everything a bullet can hit.</summary>
    Bullet = World | BulletClip | Player | Breakable | Deployable | Vehicle,
    /// <summary>Everything that blocks line of sight.</summary>
    Sight = World | Breakable,
    /// <summary>Everything a thrown grenade bounces off.</summary>
    Projectile = World | PlayerClip | Breakable | Deployable | Vehicle,
}

/// <summary>The result of casting a ray through the collision world.</summary>
public sealed class RaycastHit
{
    /// <summary>True if anything was hit. Check this before reading the remaining fields.</summary>
    public bool Hit { get; set; }

    /// <summary>Distance along the ray to the impact point, in metres.</summary>
    public double Distance { get; set; }

    public Vec3 Point { get; set; } = new();

    public Vec3 Normal { get; set; } = new(0d, 1d, 0d);

    public SurfaceType Surface { get; set; } = SurfaceType.Concrete;

    /// <summary>Entity id for a dynamic hit, or zero for static geometry.</summary>
    public int Entity { get; set; }

    /// <summary>Index of the brush that was hit, or -1 for entities.</summary>
    public int BrushIndex { get; set; } = -1;

    /// <summary>Material thickness the ray must cross to continue, in metres.</summary>
    public double Thickness { get; set; }

    public CollisionLayer Layer { get; set; } = CollisionLayer.None;
}

/// <summary>The result of sweeping a vertical capsule through the collision world.</summary>
public sealed class SweepHit
{
    public bool Hit { get; set; }

    /// <summary>Fraction of the requested motion completed before contact, in [0, 1].</summary>
    public double Fraction { get; set; } = 1d;

    public Vec3 Point { get; set; } = new();

    public Vec3 Normal { get; set; } = new(0d, 1d, 0d);

    public SurfaceType Surface { get; set; } = SurfaceType.Concrete;

    public int Entity { get; set; }

    public int BrushIndex { get; set; } = -1;

    /// <summary>True when the capsule started already overlapping geometry.</summary>
    public bool StartedSolid { get; set; }
}

/// <summary>Optional entity filtering applied in addition to a collision layer mask.</summary>
public sealed class QueryFilter
{
    public QueryFilter()
    {
    }

    public QueryFilter(CollisionLayer layers)
    {
        Layers = layers;
    }

    public CollisionLayer Layers { get; set; }

    /// <summary>Entity ids to skip before evaluating <see cref="EntityPredicate"/>.</summary>
    public IReadOnlyCollection<int>? IgnoreEntities { get; set; }

    /// <summary>Return false to skip a candidate entity.</summary>
    public Func<int, bool>? EntityPredicate { get; set; }

    /// <summary>
    /// Returns whether a candidate entity passes this filter. Ignored ids short-circuit
    /// before the predicate, matching the TypeScript collision backend.
    /// </summary>
    public bool IncludesEntity(int id)
    {
        if (IgnoreEntities is not null && IgnoreEntities.Contains(id))
        {
            return false;
        }

        return EntityPredicate?.Invoke(id) is not false;
    }
}

/// <summary>
/// Deterministic collision queries shared by movement, ballistics, AI, spawning,
/// and projectile physics. Directions are unit length and distances are metres.
/// </summary>
public interface ICollisionWorld
{
    /// <summary>Fills and returns <paramref name="output"/> with the nearest ray hit.</summary>
    RaycastHit Raycast(
        Vec3 origin,
        Vec3 direction,
        double maxDistance,
        QueryFilter filter,
        RaycastHit output);

    /// <summary>
    /// Writes ray hits nearest-first and returns the number written, up to both
    /// <paramref name="maxHits"/> and the capacity of <paramref name="output"/>.
    /// </summary>
    int RaycastAll(
        Vec3 origin,
        Vec3 direction,
        double maxDistance,
        QueryFilter filter,
        IList<RaycastHit> output,
        int maxHits);

    /// <summary>
    /// Sweeps a vertical capsule, whose feet begin at <paramref name="start"/>,
    /// along <paramref name="delta"/> and returns the first contact.
    /// </summary>
    SweepHit SweepCapsule(
        Vec3 start,
        double height,
        double radius,
        Vec3 delta,
        QueryFilter filter,
        SweepHit output);

    /// <summary>
    /// Pushes a capsule out of overlapping geometry, writes the corrected feet
    /// position to <paramref name="output"/>, and returns true if it moved.
    /// </summary>
    bool ResolvePenetration(
        Vec3 position,
        double height,
        double radius,
        QueryFilter filter,
        Vec3 output);

    /// <summary>Cheap capsule occupancy test used by spawn selection.</summary>
    bool IsCapsuleFree(Vec3 position, double height, double radius, QueryFilter filter);

    /// <summary>Returns whether the line segment between two points is unobstructed.</summary>
    bool IsVisible(Vec3 from, Vec3 to, QueryFilter filter);

    /// <summary>Ground height below a point, or negative infinity if no ground is found.</summary>
    double GroundHeightAt(double x, double z, double fromY, double maxDrop);
}

/// <summary>Collision result factories and the canonical per-surface behaviour/render tables.</summary>
public static class CollisionTypes
{
    public static RaycastHit CreateRaycastHit() => new();

    public static SweepHit CreateSweepHit() => new();

    public static IReadOnlyDictionary<SurfaceType, SurfaceProperties> SurfaceProperties { get; } =
        ReadOnly(new Dictionary<SurfaceType, SurfaceProperties>
        {
            [SurfaceType.Concrete] = Properties(0.25d, 0.35d, 0.85d, false),
            [SurfaceType.Metal] = Properties(0.15d, 0.2d, 1d, false),
            [SurfaceType.Wood] = Properties(0.7d, 0.75d, 0.8d, true),
            [SurfaceType.Dirt] = Properties(0.4d, 0.45d, 0.55d, false),
            [SurfaceType.Grass] = Properties(0.5d, 0.55d, 0.4d, false),
            [SurfaceType.Sand] = Properties(0.35d, 0.4d, 0.45d, false),
            [SurfaceType.Water] = Properties(0.9d, 0.6d, 0.9d, false),
            [SurfaceType.Glass] = Properties(0.95d, 0.92d, 0.9d, true),
            [SurfaceType.Foliage] = Properties(1d, 0.98d, 0.6d, false),
            [SurfaceType.Flesh] = Properties(0.8d, 0.7d, 0.3d, false),
            [SurfaceType.Carpet] = Properties(0.6d, 0.7d, 0.3d, false),
            [SurfaceType.Gravel] = Properties(0.3d, 0.4d, 1d, false),
            [SurfaceType.Snow] = Properties(0.6d, 0.6d, 0.5d, false),
            [SurfaceType.Tile] = Properties(0.45d, 0.5d, 0.95d, true),
            [SurfaceType.Plastic] = Properties(0.8d, 0.85d, 0.7d, true),
            [SurfaceType.Brick] = Properties(0.3d, 0.4d, 0.85d, false),
        });

    /// <summary>Default 24-bit RGB albedo when a brush does not override it.</summary>
    public static IReadOnlyDictionary<SurfaceType, int> SurfaceColors { get; } =
        ReadOnly(new Dictionary<SurfaceType, int>
        {
            [SurfaceType.Concrete] = 0x8a8a86,
            [SurfaceType.Metal] = 0x6e747a,
            [SurfaceType.Wood] = 0x8a6440,
            [SurfaceType.Dirt] = 0x6b5a45,
            [SurfaceType.Grass] = 0x5c7a44,
            [SurfaceType.Sand] = 0xc2ab7f,
            [SurfaceType.Water] = 0x2b5a72,
            [SurfaceType.Glass] = 0xa8c4cc,
            [SurfaceType.Foliage] = 0x40632f,
            [SurfaceType.Flesh] = 0x9c5a52,
            [SurfaceType.Carpet] = 0x6a4a48,
            [SurfaceType.Gravel] = 0x7d7a72,
            [SurfaceType.Snow] = 0xe4eaf0,
            [SurfaceType.Tile] = 0xb8b4ac,
            [SurfaceType.Plastic] = 0x585c62,
            [SurfaceType.Brick] = 0x91564a,
        });

    /// <summary>Default physical-shader roughness by surface.</summary>
    public static IReadOnlyDictionary<SurfaceType, double> SurfaceRoughness { get; } =
        ReadOnly(new Dictionary<SurfaceType, double>
        {
            [SurfaceType.Concrete] = 0.92d,
            [SurfaceType.Metal] = 0.42d,
            [SurfaceType.Wood] = 0.78d,
            [SurfaceType.Dirt] = 0.98d,
            [SurfaceType.Grass] = 0.95d,
            [SurfaceType.Sand] = 0.96d,
            [SurfaceType.Water] = 0.08d,
            [SurfaceType.Glass] = 0.05d,
            [SurfaceType.Foliage] = 0.88d,
            [SurfaceType.Flesh] = 0.7d,
            [SurfaceType.Carpet] = 0.99d,
            [SurfaceType.Gravel] = 0.96d,
            [SurfaceType.Snow] = 0.85d,
            [SurfaceType.Tile] = 0.35d,
            [SurfaceType.Plastic] = 0.55d,
            [SurfaceType.Brick] = 0.9d,
        });

    /// <summary>
    /// Default physical-shader metalness by surface. Metal deliberately remains
    /// at 0.3 because the asset-free renderer has no environment map to reflect.
    /// </summary>
    public static IReadOnlyDictionary<SurfaceType, double> SurfaceMetalness { get; } =
        ReadOnly(new Dictionary<SurfaceType, double>
        {
            [SurfaceType.Concrete] = 0d,
            [SurfaceType.Metal] = 0.3d,
            [SurfaceType.Wood] = 0d,
            [SurfaceType.Dirt] = 0d,
            [SurfaceType.Grass] = 0d,
            [SurfaceType.Sand] = 0d,
            [SurfaceType.Water] = 0.1d,
            [SurfaceType.Glass] = 0d,
            [SurfaceType.Foliage] = 0d,
            [SurfaceType.Flesh] = 0d,
            [SurfaceType.Carpet] = 0d,
            [SurfaceType.Gravel] = 0d,
            [SurfaceType.Snow] = 0d,
            [SurfaceType.Tile] = 0.05d,
            [SurfaceType.Plastic] = 0d,
            [SurfaceType.Brick] = 0d,
        });

    private static SurfaceProperties Properties(
        double penetration,
        double damageRetention,
        double footstepVolume,
        bool breakable) =>
        new()
        {
            Penetration = penetration,
            DamageRetention = damageRetention,
            FootstepVolume = footstepVolume,
            Breakable = breakable,
        };

    private static IReadOnlyDictionary<TKey, TValue> ReadOnly<TKey, TValue>(
        Dictionary<TKey, TValue> values)
        where TKey : notnull => new ReadOnlyDictionary<TKey, TValue>(values);
}
