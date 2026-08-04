using System.Numerics;
using OperationVanguard.Core;
using Raylib_cs;

namespace OperationVanguard.Game.Rendering;

/// <summary>
/// Draws the same authored brush list used by collision and AI. Geometry stays
/// procedural, while albedo and normal maps are the canonical pixels exported
/// from the web renderer.
/// </summary>
public sealed class MapRenderer : IDisposable
{
    private const int MaximumPointLights = 16;

    private const string LightingVertexShader = """
        #version 330

        in vec3 vertexPosition;
        in vec2 vertexTexCoord;
        in vec3 vertexNormal;
        in vec4 vertexColor;

        uniform mat4 mvp;
        uniform mat4 matModel;
        uniform mat4 matNormal;

        out vec3 fragPosition;
        out vec3 fragNormal;
        out vec4 fragColor;
        out vec2 fragTexCoord;

        void main()
        {
            fragPosition = vec3(matModel*vec4(vertexPosition, 1.0));
            fragNormal = normalize(vec3(matNormal*vec4(vertexNormal, 0.0)));
            fragColor = vertexColor;
            fragTexCoord = vertexTexCoord;
            gl_Position = mvp*vec4(vertexPosition, 1.0);
        }
        """;

    private const string LightingFragmentShader = """
        #version 330

        #define MAX_POINT_LIGHTS 16

        in vec3 fragPosition;
        in vec3 fragNormal;
        in vec4 fragColor;
        in vec2 fragTexCoord;

        uniform vec4 colDiffuse;
        uniform vec3 viewPos;
        uniform vec3 sunDirection;
        uniform vec3 sunColor;
        uniform float sunIntensity;
        uniform vec3 ambientColor;
        uniform float ambientIntensity;
        uniform vec3 fogColor;
        uniform float fogNear;
        uniform float fogFar;
        uniform float exposure;
        uniform int pointCount;
        uniform vec3 pointPositions[MAX_POINT_LIGHTS];
        uniform vec3 pointColors[MAX_POINT_LIGHTS];
        uniform float pointIntensities[MAX_POINT_LIGHTS];
        uniform float pointDistances[MAX_POINT_LIGHTS];
        uniform float materialRoughness;
        uniform float materialMetalness;
        uniform float materialEmissive;
        uniform int surfaceKind;
        uniform sampler2D albedoMap;
        uniform sampler2D normalMap;
        uniform vec3 surfaceBaseColor;

        out vec4 finalColor;

        vec3 acesFilmic(vec3 value)
        {
            const float a = 2.51;
            const float b = 0.03;
            const float c = 2.43;
            const float d = 0.59;
            const float e = 0.14;
            return clamp((value*(a*value + b))/(value*(c*value + d) + e), 0.0, 1.0);
        }

        vec3 srgbToLinear(vec3 value)
        {
            bvec3 cutoff = lessThanEqual(value, vec3(0.04045));
            vec3 lower = value/12.92;
            vec3 higher = pow((value + 0.055)/1.055, vec3(2.4));
            return mix(higher, lower, cutoff);
        }

        vec3 perturbNormal(vec3 surfaceNormal, vec3 mapNormal, vec2 uv)
        {
            vec3 q0 = dFdx(fragPosition);
            vec3 q1 = dFdy(fragPosition);
            vec2 st0 = dFdx(uv);
            vec2 st1 = dFdy(uv);
            vec3 q1Perp = cross(q1, surfaceNormal);
            vec3 q0Perp = cross(surfaceNormal, q0);
            vec3 tangent = q1Perp*st0.x + q0Perp*st1.x;
            vec3 bitangent = q1Perp*st0.y + q0Perp*st1.y;
            float determinant = max(dot(tangent, tangent), dot(bitangent, bitangent));
            float scale = determinant <= 0.0 ? 0.0 : inversesqrt(determinant);
            return normalize(tangent*(mapNormal.x*scale) + bitangent*(mapNormal.y*scale) +
                surfaceNormal*mapNormal.z);
        }

        vec3 directLight(
            vec3 normal,
            vec3 viewDirection,
            vec3 lightDirection,
            vec3 radiance,
            vec3 albedo)
        {
            float nDotL = max(dot(normal, lightDirection), 0.0);
            if (nDotL <= 0.0) return vec3(0.0);

            vec3 halfDirection = normalize(lightDirection + viewDirection);
            float shininess = mix(128.0, 4.0, materialRoughness);
            float specularAmount = pow(max(dot(normal, halfDirection), 0.0), shininess);
            vec3 specularColor = mix(vec3(0.04), albedo, materialMetalness);
            vec3 diffuseColor = albedo*(1.0 - materialMetalness*0.72);
            return radiance*(diffuseColor*nDotL + specularColor*specularAmount*nDotL);
        }

        float hash21(vec2 point)
        {
            return fract(sin(dot(point, vec2(127.1, 311.7)))*43758.5453123);
        }

        float valueNoise(vec2 point)
        {
            vec2 cell = floor(point);
            vec2 local = fract(point);
            local = local*local*(3.0 - 2.0*local);
            return mix(
                mix(hash21(cell), hash21(cell + vec2(1.0, 0.0)), local.x),
                mix(hash21(cell + vec2(0.0, 1.0)), hash21(cell + vec2(1.0)), local.x),
                local.y);
        }

        float fbm(vec2 point)
        {
            float value = 0.0;
            float amplitude = 0.5;
            for (int octave = 0; octave < 3; octave++)
            {
                value += valueNoise(point)*amplitude;
                point = point*2.03 + vec2(17.1, 9.2);
                amplitude *= 0.5;
            }
            return value;
        }

        vec2 surfaceUv(vec3 position, vec3 normal)
        {
            vec3 axis = abs(normal);
            if (axis.y >= axis.x && axis.y >= axis.z) return position.xz;
            if (axis.x >= axis.z) return position.zy;
            return position.xy;
        }

        vec3 detailedSurface(vec3 base, vec2 uv, out float heightValue)
        {
            float coarse = fbm(uv*1.7);
            float fine = valueNoise(uv*3.2 + vec2(11.0, 4.0));
            float factor = 0.97 + fine*0.025;
            heightValue = coarse*0.7 + fine*0.3;

            if (surfaceKind == 0) // concrete: restrained fine aggregate
            {
                float aggregate = valueNoise(uv*14.0 + vec2(7.0, 19.0));
                factor = 0.965 + aggregate*0.018;
                heightValue = aggregate*0.12;
            }
            else if (surfaceKind == 1) // metal: panels, brushed grain and scratches
            {
                vec2 panel = abs(fract(uv/1.25) - 0.5);
                float seam = 1.0 - smoothstep(0.455, 0.49, max(panel.x, panel.y));
                float scratch = smoothstep(0.92, 0.985, valueNoise(vec2(uv.x*9.0, uv.y*92.0)));
                factor = 0.96 + seam*0.025 + scratch*0.018;
                heightValue = 0.62 + seam*.05;
            }
            else if (surfaceKind == 2) // wood: long grain with darker knots
            {
                float grain = sin(uv.x*12.0 + fbm(uv*1.4)*5.0)*0.5 + 0.5;
                float knots = smoothstep(.70, .93, fbm(uv*1.15 + vec2(31.0, 7.0)));
                factor = .72 + grain*.28 - knots*.22 + fine*.08;
                heightValue = grain*.5 + knots*.35;
            }
            else if (surfaceKind == 3 || surfaceKind == 4 || surfaceKind == 5 || surfaceKind == 11 || surfaceKind == 12)
            {
                float grains = valueNoise(uv*28.0);
                factor = .78 + coarse*.26 + grains*.10;
                if (surfaceKind == 4) factor += sin(uv.x*18.0 + fine*5.0)*.07;
                if (surfaceKind == 12) factor = .98;
                heightValue = coarse*.55 + grains*.45;
            }
            else if (surfaceKind == 6) // water
            {
                float waves = sin(uv.x*5.0 + uv.y*2.3) + sin(uv.y*7.0 - uv.x*1.7);
                factor = .82 + waves*.06 + fine*.08;
                heightValue = waves*.25 + fine*.2;
            }
            else if (surfaceKind == 7) // glass smudges
            {
                float streak = sin(uv.y*31.0 + coarse*4.0)*.025;
                factor = .93 + streak + fine*.04;
                heightValue = fine*.12;
            }
            else if (surfaceKind == 8) // foliage
            {
                float leaf = sin(uv.x*19.0 + coarse*8.0)*sin(uv.y*23.0 - fine*6.0);
                factor = .68 + coarse*.32 + leaf*.12;
                heightValue = coarse*.45 + leaf*.28;
            }
            else if (surfaceKind == 10) // carpet weave
            {
                float weave = sin(uv.x*16.0)*sin(uv.y*16.0);
                factor = .78 + coarse*.18 + weave*.08;
                heightValue = weave*.25 + fine*.15;
            }
            else if (surfaceKind == 13) // ceramic/stone tile with grout
            {
                vec2 tile = abs(fract(uv*1.15) - .5);
                float grout = smoothstep(.44, .485, max(tile.x, tile.y));
                factor = mix(.97, .55, grout);
                heightValue = .62 - grout*.55;
            }
            else if (surfaceKind == 14) // molded plastic
            {
                factor = .96 + fine*.02;
                heightValue = coarse*.12 + fine*.08;
            }
            else if (surfaceKind == 15) // staggered brick and mortar
            {
                float row = floor(uv.y*1.85);
                vec2 brick = fract(vec2(uv.x*1.15 + mod(row, 2.0)*.5, uv.y*1.85));
                float edge = min(min(brick.x, 1.0-brick.x), min(brick.y, 1.0-brick.y));
                float mortar = 1.0 - smoothstep(.025, .075, edge);
                float brickTone = .78 + coarse*.28 + fine*.08;
                factor = mix(brickTone, .40, mortar);
                heightValue = mix(.58 + fine*.16, .05, mortar);
            }
            return base*max(factor, .18);
        }

        void main()
        {
            vec4 tint = colDiffuse*fragColor;
            vec4 sampled = texture(albedoMap, fragTexCoord);
            vec3 authoredTint = srgbToLinear(max(tint.rgb, vec3(0.0)));
            vec3 baseTint = srgbToLinear(surfaceBaseColor);
            vec3 tintRatio = min(vec3(4.0), authoredTint/max(baseTint, vec3(0.0001)));
            vec3 albedo = srgbToLinear(sampled.rgb)*tintRatio;
            vec3 normal = normalize(fragNormal);
            if (!gl_FrontFacing) normal = -normal;
            vec3 sampledNormal = texture(normalMap, fragTexCoord).xyz*2.0 - 1.0;
            normal = perturbNormal(normal, sampledNormal, fragTexCoord);
            vec3 viewDirection = normalize(viewPos - fragPosition);

            float skyAmount = clamp(normal.y*0.5 + 0.5, 0.0, 1.0);
            float hemisphere = mix(0.35, 1.0, skyAmount);
            vec3 light = albedo*ambientColor*ambientIntensity*hemisphere;
            light += directLight(
                normal,
                viewDirection,
                -normalize(sunDirection),
                sunColor*sunIntensity,
                albedo);

            for (int index = 0; index < MAX_POINT_LIGHTS; index++)
            {
                if (index >= pointCount) break;
                vec3 offset = pointPositions[index] - fragPosition;
                float distanceToLight = length(offset);
                float range = max(pointDistances[index], 0.001);
                float rangeFade = clamp(1.0 - distanceToLight/range, 0.0, 1.0);
                float attenuation = pointIntensities[index]/max(distanceToLight*distanceToLight, 1.0);
                vec3 radiance = pointColors[index]*attenuation*rangeFade*rangeFade;
                light += directLight(normal, viewDirection, normalize(offset), radiance, albedo);
            }

            light += albedo*materialEmissive;
            vec3 mapped = acesFilmic(light*exposure);
            mapped = pow(mapped, vec3(1.0/2.2));

            float fogSpan = max(fogFar - fogNear, 0.001);
            float visibility = clamp((fogFar - length(viewPos - fragPosition))/fogSpan, 0.0, 1.0);
            mapped = mix(fogColor, mapped, visibility);
            finalColor = vec4(mapped, tint.a*sampled.a);
        }
        """;

    private readonly Shader _lightingShader;
    private readonly SurfaceTextureLibrary _textures;
    private readonly bool _shaderValid;
    private readonly int _viewPositionLocation = -1;
    private readonly int _sunDirectionLocation = -1;
    private readonly int _sunColorLocation = -1;
    private readonly int _sunIntensityLocation = -1;
    private readonly int _ambientColorLocation = -1;
    private readonly int _ambientIntensityLocation = -1;
    private readonly int _fogColorLocation = -1;
    private readonly int _fogNearLocation = -1;
    private readonly int _fogFarLocation = -1;
    private readonly int _exposureLocation = -1;
    private readonly int _pointCountLocation = -1;
    private readonly int _pointPositionsLocation = -1;
    private readonly int _pointColorsLocation = -1;
    private readonly int _pointIntensitiesLocation = -1;
    private readonly int _pointDistancesLocation = -1;
    private readonly int _roughnessLocation = -1;
    private readonly int _metalnessLocation = -1;
    private readonly int _emissiveLocation = -1;
    private readonly int _surfaceLocation = -1;
    private readonly int _albedoMapLocation = -1;
    private readonly int _normalMapLocation = -1;
    private readonly int _surfaceBaseLocation = -1;
    private MapDef? _configuredMap;
    private bool _disposed;

    public MapRenderer()
    {
        _textures = new SurfaceTextureLibrary();
        _lightingShader = Raylib.LoadShaderFromMemory(LightingVertexShader, LightingFragmentShader);
        _shaderValid = Raylib.IsShaderValid(_lightingShader);
        if (!_shaderValid) return;

        _viewPositionLocation = Location("viewPos");
        _sunDirectionLocation = Location("sunDirection");
        _sunColorLocation = Location("sunColor");
        _sunIntensityLocation = Location("sunIntensity");
        _ambientColorLocation = Location("ambientColor");
        _ambientIntensityLocation = Location("ambientIntensity");
        _fogColorLocation = Location("fogColor");
        _fogNearLocation = Location("fogNear");
        _fogFarLocation = Location("fogFar");
        _exposureLocation = Location("exposure");
        _pointCountLocation = Location("pointCount");
        _pointPositionsLocation = Location("pointPositions");
        _pointColorsLocation = Location("pointColors");
        _pointIntensitiesLocation = Location("pointIntensities");
        _pointDistancesLocation = Location("pointDistances");
        _roughnessLocation = Location("materialRoughness");
        _metalnessLocation = Location("materialMetalness");
        _emissiveLocation = Location("materialEmissive");
        _surfaceLocation = Location("surfaceKind");
        _albedoMapLocation = Location("albedoMap");
        _normalMapLocation = Location("normalMap");
        _surfaceBaseLocation = Location("surfaceBaseColor");
    }

    public void Draw(MapDef map)
    {
        ConfigureLighting(map);
        if (_shaderValid)
        {
            UpdateViewPosition();
            Raylib.BeginShaderMode(_lightingShader);
        }

        try
        {
            var groups = map.Brushes
                .Where(brush => brush.IsVisible)
                .GroupBy(brush => (
                    brush.Surface,
                    Roughness: brush.Roughness ?? CollisionTypes.SurfaceRoughness[brush.Surface],
                    Metalness: brush.Metalness ?? CollisionTypes.SurfaceMetalness[brush.Surface],
                    Emissive: brush.Emissive ?? 0));
            foreach (var group in groups)
            {
                if (_shaderValid) ConfigureMaterial(group.First());
                foreach (var brush in group) DrawBrush(brush);
            }
        }
        finally
        {
            if (_shaderValid) Raylib.EndShaderMode();
        }
    }

    public void DrawObjectiveHints(MapDef map, GameModeDef mode)
    {
        if (mode.ObjectiveKind is null) return;
        foreach (var objective in map.Objectives)
        {
            if (objective.Kind != mode.ObjectiveKind) continue;
            var color = objective.Kind switch
            {
                ObjectiveKind.DominationFlag => new Color(70, 170, 255, 180),
                ObjectiveKind.BombSite => new Color(255, 170, 55, 180),
                ObjectiveKind.Hardpoint => new Color(245, 75, 90, 180),
                ObjectiveKind.Headquarters => new Color(175, 95, 255, 180),
                _ => new Color(235, 235, 235, 180),
            };
            var centre = ToNumerics(objective.Position);
            var radius = (float)Math.Clamp(Math.Min(objective.Size.X, objective.Size.Z) * .35, .45, 2.25);
            var floor = centre - Vector3.UnitY * (float)Math.Max(0, objective.Size.Y / 2 - .06);
            Raylib.DrawCylinderEx(floor, floor + Vector3.UnitY * .08f, radius, radius, 24,
                new Color(color.R, color.G, color.B, (byte)75));
            Raylib.DrawLine3D(floor, floor + Vector3.UnitY * 2.4f, color);
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        if (_shaderValid) Raylib.UnloadShader(_lightingShader);
        _textures.Dispose();
        _disposed = true;
        GC.SuppressFinalize(this);
    }

    private void DrawBrush(Brush brush)
    {
        var tint = BrushTint(brush);
        var doubleSided = brush.Surface is SurfaceType.Glass or SurfaceType.Water;
        if (doubleSided) Rlgl.DisableBackfaceCulling();
        try
        {
            switch (brush.Kind)
            {
                case BrushKind.Box:
                    DrawBox(brush, tint);
                    break;
                case BrushKind.Ramp:
                    DrawRamp(brush, tint);
                    break;
                case BrushKind.Cylinder:
                    DrawCylinder(brush, tint);
                    break;
                case BrushKind.Plane:
                    DrawPlane(brush, tint);
                    break;
                default:
                    throw new ArgumentOutOfRangeException(nameof(brush.Kind), brush.Kind, null);
            }
        }
        finally
        {
            if (doubleSided) Rlgl.EnableBackfaceCulling();
        }
    }

    private static void DrawBox(Brush brush, Vector4 tint)
    {
        var size = brush.Size;
        if (size is null || size.X <= 0 || size.Y <= 0 || size.Z <= 0) return;
        var x = size.X / 2;
        var y = size.Y / 2;
        var z = size.Z / 2;
        var yaw = brush.Yaw ?? 0;
        var uvScale = (float)((brush.TextureScale ?? 1) / 2);
        var sx = (float)size.X * uvScale;
        var sy = (float)size.Y * uvScale;
        var sz = (float)size.Z * uvScale;

        Vector3 Point(double px, double py, double pz) =>
            Transform(new Vector3((float)px, (float)py, (float)pz), brush.Position, yaw);

        var p000 = Point(-x, -y, -z);
        var p100 = Point(x, -y, -z);
        var p110 = Point(x, y, -z);
        var p010 = Point(-x, y, -z);
        var p001 = Point(-x, -y, z);
        var p101 = Point(x, -y, z);
        var p111 = Point(x, y, z);
        var p011 = Point(-x, y, z);

        DrawQuad(p001, p101, p111, p011, tint,
            new(0, 0), new(sx, 0), new(sx, sy), new(0, sy));
        DrawQuad(p000, p010, p110, p100, tint,
            new(sx, 0), new(sx, sy), new(0, sy), new(0, 0));
        DrawQuad(p010, p011, p111, p110, tint,
            new(0, 0), new(0, sz), new(sx, sz), new(sx, 0));
        DrawQuad(p000, p100, p101, p001, tint,
            new(0, sz), new(sx, sz), new(sx, 0), new(0, 0));
        DrawQuad(p100, p110, p111, p101, tint,
            new(0, 0), new(0, sy), new(sz, sy), new(sz, 0));
        DrawQuad(p000, p001, p011, p010, tint,
            new(sz, 0), new(0, 0), new(0, sy), new(sz, sy));
    }

    private static void DrawCylinder(Brush brush, Vector4 tint)
    {
        var radius = brush.Radius ?? 0;
        var height = brush.Height ?? 0;
        if (radius <= 0 || height <= 0) return;
        var centre = ToNumerics(brush.Position);
        var halfHeight = (float)(height / 2);
        var segments = Math.Max(3, brush.Segments ?? 12);
        var uvScale = (float)((brush.TextureScale ?? 1) / 2);
        var wrapU = MathF.Tau * (float)radius * uvScale;
        var wrapV = (float)height * uvScale;
        var capSpan = 2 * (float)radius * uvScale;
        var topCentre = centre + Vector3.UnitY * halfHeight;
        var bottomCentre = centre - Vector3.UnitY * halfHeight;

        for (var index = 0; index < segments; index++)
        {
            var angle0 = MathF.Tau * index / segments;
            var angle1 = MathF.Tau * (index + 1) / segments;
            var radial0 = new Vector3(MathF.Sin(angle0), 0, MathF.Cos(angle0)) * (float)radius;
            var radial1 = new Vector3(MathF.Sin(angle1), 0, MathF.Cos(angle1)) * (float)radius;
            var bottom0 = bottomCentre + radial0;
            var bottom1 = bottomCentre + radial1;
            var top0 = topCentre + radial0;
            var top1 = topCentre + radial1;
            var u0 = wrapU * index / segments;
            var u1 = wrapU * (index + 1) / segments;
            DrawQuad(bottom0, bottom1, top1, top0, tint,
                new(u0, 0), new(u1, 0), new(u1, wrapV), new(u0, wrapV));
            Vector2 CapUv(Vector3 radial) => new(
                .5f + radial.X / (2 * (float)radius) * capSpan,
                .5f + radial.Z / (2 * (float)radius) * capSpan);
            DrawTriangle(topCentre, top0, top1, tint,
                new(.5f, .5f), CapUv(radial0), CapUv(radial1));
            DrawTriangle(bottomCentre, bottom1, bottom0, tint,
                new(.5f, .5f), CapUv(radial1), CapUv(radial0));
        }
    }

    private static void DrawRamp(Brush brush, Vector4 tint)
    {
        var size = brush.Size;
        if (size is null || brush.Rise is null || size.X <= 0 || size.Y <= 0 || size.Z <= 0) return;

        var alongZ = brush.Rise is RiseDirection.PositiveZ or RiseDirection.NegativeZ;
        var width = alongZ ? size.Z : size.X;
        var depth = alongZ ? size.X : size.Z;
        var halfWidth = width / 2;
        var halfHeight = size.Y / 2;
        var halfDepth = depth / 2;
        var yaw = (brush.Yaw ?? 0) + RampYaw(brush.Rise.Value);
        var uvScale = (float)((brush.TextureScale ?? 1) / 2);
        var su = (float)width * uvScale;
        var sv = (float)size.Y * uvScale;
        var sd = (float)depth * uvScale;
        var hyp = (float)Math.Sqrt(width * width + size.Y * size.Y) * uvScale;

        Vector3 Point(double x, double y, double z) =>
            Transform(new Vector3((float)x, (float)y, (float)z), brush.Position, yaw);

        var a0 = Point(-halfWidth, -halfHeight, -halfDepth);
        var b0 = Point(halfWidth, -halfHeight, -halfDepth);
        var c0 = Point(halfWidth, halfHeight, -halfDepth);
        var a1 = Point(-halfWidth, -halfHeight, halfDepth);
        var b1 = Point(halfWidth, -halfHeight, halfDepth);
        var c1 = Point(halfWidth, halfHeight, halfDepth);

        DrawQuad(a0, b0, b1, a1, tint,
            new(0, 0), new(su, 0), new(su, sd), new(0, sd));
        DrawQuad(a0, a1, c1, c0, tint,
            new(0, 0), new(sd, 0), new(sd, hyp), new(0, hyp));
        DrawQuad(b0, c0, c1, b1, tint,
            new(0, 0), new(0, sv), new(sd, sv), new(sd, 0));
        DrawTriangle(a0, c0, b0, tint, new(0, 0), new(su, sv), new(su, 0));
        DrawTriangle(a1, b1, c1, tint, new(0, 0), new(su, 0), new(su, sv));
    }

    private static void DrawPlane(Brush brush, Vector4 tint)
    {
        var size = brush.Size;
        if (size is null || brush.Facing is null) return;
        var hx = size.X / 2;
        var hy = size.Y / 2;
        var hz = size.Z / 2;
        var uvScale = (float)((brush.TextureScale ?? 1) / 2);
        var spanA = (float)(brush.Facing is PlaneFacing.PositiveX or PlaneFacing.NegativeX ? size.Z : size.X) * uvScale;
        var spanB = (float)(brush.Facing is PlaneFacing.PositiveY or PlaneFacing.NegativeY ? size.Z : size.Y) * uvScale;
        Vector3[] local = brush.Facing.Value switch
        {
            PlaneFacing.PositiveX or PlaneFacing.NegativeX =>
                [new(0, (float)-hy, (float)-hz), new(0, (float)hy, (float)-hz), new(0, (float)hy, (float)hz), new(0, (float)-hy, (float)hz)],
            PlaneFacing.PositiveY or PlaneFacing.NegativeY =>
                [new((float)-hx, 0, (float)-hz), new((float)-hx, 0, (float)hz), new((float)hx, 0, (float)hz), new((float)hx, 0, (float)-hz)],
            _ =>
                [new((float)-hx, (float)-hy, 0), new((float)hx, (float)-hy, 0), new((float)hx, (float)hy, 0), new((float)-hx, (float)hy, 0)],
        };
        if (brush.Facing is PlaneFacing.NegativeX or PlaneFacing.NegativeY or PlaneFacing.NegativeZ)
            Array.Reverse(local);
        var yaw = brush.Yaw ?? 0;
        for (var index = 0; index < local.Length; index++)
            local[index] = Transform(local[index], brush.Position, yaw);
        DrawQuad(local[0], local[1], local[2], local[3], tint,
            new(0, 0), new(0, spanB), new(spanA, spanB), new(spanA, 0));
    }

    private static void DrawQuad(
        Vector3 a, Vector3 b, Vector3 c, Vector3 d, Vector4 tint,
        Vector2 uvA, Vector2 uvB, Vector2 uvC, Vector2 uvD)
    {
        var normal = FaceNormal(a, b, c);
        Rlgl.Begin((int)DrawMode.Triangles);
        EmitVertex(a, normal, tint, uvA);
        EmitVertex(b, normal, tint, uvB);
        EmitVertex(c, normal, tint, uvC);
        EmitVertex(a, normal, tint, uvA);
        EmitVertex(c, normal, tint, uvC);
        EmitVertex(d, normal, tint, uvD);
        Rlgl.End();
    }

    private static void DrawTriangle(
        Vector3 a, Vector3 b, Vector3 c, Vector4 tint, Vector2 uvA, Vector2 uvB, Vector2 uvC)
    {
        var normal = FaceNormal(a, b, c);
        Rlgl.Begin((int)DrawMode.Triangles);
        EmitVertex(a, normal, tint, uvA);
        EmitVertex(b, normal, tint, uvB);
        EmitVertex(c, normal, tint, uvC);
        Rlgl.End();
    }

    private static void EmitVertex(Vector3 position, Vector3 normal, Vector4 tint, Vector2 uv)
    {
        Rlgl.Color4f(tint.X, tint.Y, tint.Z, tint.W);
        Rlgl.TexCoord2f(uv.X, uv.Y);
        Rlgl.Normal3f(normal.X, normal.Y, normal.Z);
        Rlgl.Vertex3f(position.X, position.Y, position.Z);
    }

    private static Vector3 FaceNormal(Vector3 a, Vector3 b, Vector3 c)
    {
        var normal = Vector3.Cross(b - a, c - a);
        return normal.LengthSquared() > 1e-10f ? Vector3.Normalize(normal) : Vector3.UnitY;
    }

    private void ConfigureLighting(MapDef map)
    {
        if (!_shaderValid || ReferenceEquals(_configuredMap, map)) return;
        _configuredMap = map;
        var lighting = map.Lighting;
        var sunDirection = ToNumerics(lighting.SunDirection);
        if (sunDirection.LengthSquared() > 1e-10f) sunDirection = Vector3.Normalize(sunDirection);
        else sunDirection = -Vector3.UnitY;

        Set(_sunDirectionLocation, sunDirection, ShaderUniformDataType.Vec3);
        Set(_sunColorLocation, LinearColor(lighting.SunColor), ShaderUniformDataType.Vec3);
        Set(_sunIntensityLocation, (float)lighting.SunIntensity, ShaderUniformDataType.Float);
        Set(_ambientColorLocation, LinearColor(lighting.AmbientColor), ShaderUniformDataType.Vec3);
        Set(_ambientIntensityLocation, (float)lighting.AmbientIntensity, ShaderUniformDataType.Float);
        Set(_fogColorLocation, SrgbColor(lighting.FogColor), ShaderUniformDataType.Vec3);
        Set(_fogNearLocation, (float)lighting.FogNear, ShaderUniformDataType.Float);
        Set(_fogFarLocation, (float)lighting.FogFar, ShaderUniformDataType.Float);
        Set(_exposureLocation, (float)lighting.Exposure, ShaderUniformDataType.Float);

        var lights = (lighting.Lights ?? []).Take(MaximumPointLights).ToArray();
        Set(_pointCountLocation, lights.Length, ShaderUniformDataType.Int);
        if (lights.Length == 0) return;

        var positions = lights.Select(light => ToNumerics(light.Position)).ToArray();
        var colors = lights.Select(light => LinearColor(light.Color)).ToArray();
        var intensities = lights.Select(light => (float)light.Intensity).ToArray();
        var distances = lights.Select(light => (float)light.Distance).ToArray();
        Raylib.SetShaderValueV(_lightingShader, _pointPositionsLocation, positions,
            ShaderUniformDataType.Vec3, lights.Length);
        Raylib.SetShaderValueV(_lightingShader, _pointColorsLocation, colors,
            ShaderUniformDataType.Vec3, lights.Length);
        Raylib.SetShaderValueV(_lightingShader, _pointIntensitiesLocation, intensities,
            ShaderUniformDataType.Float, lights.Length);
        Raylib.SetShaderValueV(_lightingShader, _pointDistancesLocation, distances,
            ShaderUniformDataType.Float, lights.Length);
    }

    private void ConfigureMaterial(Brush brush)
    {
        // Shader uniforms are not captured in raylib's render batch. Flush the
        // previous brush before changing them or the whole map inherits the
        // final brush's material settings.
        Rlgl.DrawRenderBatchActive();
        Set(_roughnessLocation,
            (float)(brush.Roughness ?? CollisionTypes.SurfaceRoughness[brush.Surface]),
            ShaderUniformDataType.Float);
        Set(_metalnessLocation,
            (float)(brush.Metalness ?? CollisionTypes.SurfaceMetalness[brush.Surface]),
            ShaderUniformDataType.Float);
        Set(_emissiveLocation, (float)(brush.Emissive ?? 0), ShaderUniformDataType.Float);
        Set(_surfaceLocation, (int)brush.Surface, ShaderUniformDataType.Int);
        Set(_surfaceBaseLocation, SrgbColor(CollisionTypes.SurfaceColors[brush.Surface]),
            ShaderUniformDataType.Vec3);
        if (_albedoMapLocation >= 0)
            Raylib.SetShaderValueTexture(_lightingShader, _albedoMapLocation, _textures.Albedo(brush.Surface));
        if (_normalMapLocation >= 0)
            Raylib.SetShaderValueTexture(_lightingShader, _normalMapLocation, _textures.Normal(brush.Surface));
    }

    private void UpdateViewPosition()
    {
        var view = Rlgl.GetMatrixModelview();
        if (!Matrix4x4.Invert(view, out var inverse)) return;
        Set(_viewPositionLocation, new Vector3(inverse.M41, inverse.M42, inverse.M43),
            ShaderUniformDataType.Vec3);
    }

    private int Location(string name) => Raylib.GetShaderLocation(_lightingShader, name);

    private void Set<T>(int location, T value, ShaderUniformDataType type) where T : unmanaged
    {
        if (location >= 0) Raylib.SetShaderValue(_lightingShader, location, value, type);
    }

    private static Vector3 Transform(Vector3 local, Vec3 translation, double yaw)
    {
        var cosine = (float)Math.Cos(yaw);
        var sine = (float)Math.Sin(yaw);
        return new Vector3(
            local.X * cosine + local.Z * sine + (float)translation.X,
            local.Y + (float)translation.Y,
            -local.X * sine + local.Z * cosine + (float)translation.Z);
    }

    private static double RampYaw(RiseDirection direction) => direction switch
    {
        RiseDirection.PositiveX => 0,
        RiseDirection.NegativeZ => Math.PI / 2,
        RiseDirection.NegativeX => Math.PI,
        RiseDirection.PositiveZ => -Math.PI / 2,
        _ => throw new ArgumentOutOfRangeException(nameof(direction), direction, null),
    };

    private static Vector4 BrushTint(Brush brush)
    {
        var tint = SrgbColor(brush.Color ?? CollisionTypes.SurfaceColors[brush.Surface]);
        var alpha = brush.Surface switch
        {
            SurfaceType.Glass => .34f,
            SurfaceType.Water => .62f,
            _ => 1,
        };
        return new Vector4(tint, alpha);
    }

    private static Vector3 SrgbColor(int value) => new(
        ((value >> 16) & 0xff) / 255f,
        ((value >> 8) & 0xff) / 255f,
        (value & 0xff) / 255f);

    private static Vector3 LinearColor(int value)
    {
        var color = SrgbColor(value);
        return new Vector3(
            MathF.Pow(color.X, 2.2f),
            MathF.Pow(color.Y, 2.2f),
            MathF.Pow(color.Z, 2.2f));
    }

    private static Vector3 ToNumerics(Vec3 value) => new((float)value.X, (float)value.Y, (float)value.Z);
}
