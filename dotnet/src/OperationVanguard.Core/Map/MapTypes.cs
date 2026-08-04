using System.Text.Json.Serialization;

namespace OperationVanguard.Core;

[JsonConverter(typeof(JsonStringEnumConverter<BrushKind>))]
public enum BrushKind
{
    [JsonStringEnumMemberName("box")] Box,
    [JsonStringEnumMemberName("ramp")] Ramp,
    [JsonStringEnumMemberName("cylinder")] Cylinder,
    [JsonStringEnumMemberName("plane")] Plane,
}

[JsonConverter(typeof(JsonStringEnumConverter<RiseDirection>))]
public enum RiseDirection
{
    [JsonStringEnumMemberName("+x")] PositiveX,
    [JsonStringEnumMemberName("-x")] NegativeX,
    [JsonStringEnumMemberName("+z")] PositiveZ,
    [JsonStringEnumMemberName("-z")] NegativeZ,
}

[JsonConverter(typeof(JsonStringEnumConverter<PlaneFacing>))]
public enum PlaneFacing
{
    [JsonStringEnumMemberName("+x")] PositiveX,
    [JsonStringEnumMemberName("-x")] NegativeX,
    [JsonStringEnumMemberName("+y")] PositiveY,
    [JsonStringEnumMemberName("-y")] NegativeY,
    [JsonStringEnumMemberName("+z")] PositiveZ,
    [JsonStringEnumMemberName("-z")] NegativeZ,
}

[JsonConverter(typeof(JsonStringEnumConverter<NavLinkKind>))]
public enum NavLinkKind
{
    [JsonStringEnumMemberName("mantle")] Mantle,
    [JsonStringEnumMemberName("jump")] Jump,
    [JsonStringEnumMemberName("drop")] Drop,
    [JsonStringEnumMemberName("ladder")] Ladder,
}

[JsonConverter(typeof(JsonStringEnumConverter<AmbienceMood>))]
public enum AmbienceMood
{
    [JsonStringEnumMemberName("urban")] Urban,
    [JsonStringEnumMemberName("desert")] Desert,
    [JsonStringEnumMemberName("industrial")] Industrial,
    [JsonStringEnumMemberName("forest")] Forest,
    [JsonStringEnumMemberName("arctic")] Arctic,
    [JsonStringEnumMemberName("interior")] Interior,
}

/// <summary>
/// A single authored convex brush. Fields that do not apply to its
/// <see cref="Kind"/> remain null; keeping one representation makes the JSON
/// payload and the stable source ordering identical to the web implementation.
/// </summary>
public sealed class Brush
{
    public BrushKind Kind { get; set; }
    public Vec3 Position { get; set; } = new();
    public double? Yaw { get; set; }
    public SurfaceType Surface { get; set; }
    public int? Color { get; set; }
    public double? Roughness { get; set; }
    public double? Metalness { get; set; }
    public double? Emissive { get; set; }
    public double? TextureScale { get; set; }
    public bool? Solid { get; set; }
    public bool? Visible { get; set; }
    public bool? BulletPassthrough { get; set; }
    public bool? Breakable { get; set; }
    public bool? CastShadow { get; set; }
    public string? Tag { get; set; }
    public Vec3? Size { get; set; }
    public RiseDirection? Rise { get; set; }
    public double? Radius { get; set; }
    public double? Height { get; set; }
    public int? Segments { get; set; }
    public PlaneFacing? Facing { get; set; }

    [JsonIgnore] public bool IsSolid => Solid is not false;
    [JsonIgnore] public bool IsVisible => Visible is not false;
    [JsonIgnore] public bool IsBulletPassthrough => BulletPassthrough is true;
    [JsonIgnore] public bool IsBreakable => Breakable is true;
    [JsonIgnore] public bool CastsShadow => CastShadow is not false;
}

public sealed class MapPointLight
{
    public Vec3 Position { get; set; } = new();
    public int Color { get; set; }
    public double Intensity { get; set; }
    public double Distance { get; set; }
    public bool? CastShadow { get; set; }
}

public sealed class MapLighting
{
    public Vec3 SunDirection { get; set; } = new();
    public int SunColor { get; set; }
    public double SunIntensity { get; set; }
    public int AmbientColor { get; set; }
    public double AmbientIntensity { get; set; }
    public int SkyTop { get; set; }
    public int SkyBottom { get; set; }
    public int FogColor { get; set; }
    public double FogNear { get; set; }
    public double FogFar { get; set; }
    public double Exposure { get; set; }
    public List<MapPointLight>? Lights { get; set; }
}

public sealed class SpawnPoint
{
    public Vec3 Position { get; set; } = new();
    public double Yaw { get; set; }
    public Team Team { get; set; }
    public string Group { get; set; } = "";
    public double? Priority { get; set; }
    public bool? InitialOnly { get; set; }
}

public sealed class ObjectiveDef
{
    public ObjectiveKind Kind { get; set; }
    public string Label { get; set; } = "";
    public Vec3 Position { get; set; } = new();
    public Vec3 Size { get; set; } = new();
    public int? Order { get; set; }
    public Team? InitialOwner { get; set; }
}

public sealed class NavLink
{
    public Vec3 From { get; set; } = new();
    public Vec3 To { get; set; } = new();
    public NavLinkKind Kind { get; set; }
    public double Cost { get; set; }
    public bool Bidirectional { get; set; }
}

public sealed class CoverPoint
{
    public Vec3 Position { get; set; } = new();
    public double Facing { get; set; }
    public bool Crouch { get; set; }
    public double Exposure { get; set; }
    public double Value { get; set; }
}

public sealed class LaneDef
{
    public string Name { get; set; } = "";
    public List<Vec3> Path { get; set; } = [];
    public double Width { get; set; }
}

public sealed class MapBounds
{
    public Vec3 Min { get; set; } = new();
    public Vec3 Max { get; set; } = new();
}

public sealed class MapAmbience
{
    public double ReverbTime { get; set; }
    public double ReverbMix { get; set; }
    public double Wind { get; set; }
    public AmbienceMood Mood { get; set; }
}

public sealed class MapDef
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Tagline { get; set; } = "";
    public string Description { get; set; } = "";
    public int[] PlayerCount { get; set; } = [1, 1];
    public MapBounds Bounds { get; set; } = new();
    public double OutOfBoundsGrace { get; set; }
    public List<Brush> Brushes { get; set; } = [];
    public MapLighting Lighting { get; set; } = new();
    public List<SpawnPoint> Spawns { get; set; } = [];
    public List<ObjectiveDef> Objectives { get; set; } = [];
    public List<NavLink> NavLinks { get; set; } = [];
    public List<CoverPoint> CoverPoints { get; set; } = [];
    public List<LaneDef> Lanes { get; set; } = [];
    public MapAmbience Ambience { get; set; } = new();
    public List<string>? SupportedModes { get; set; }
}
