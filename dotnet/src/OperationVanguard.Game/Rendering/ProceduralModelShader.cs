using System.Numerics;
using Raylib_cs;

namespace OperationVanguard.Game.Rendering;

/// <summary>Applies the web model materials and directional lighting to generated primitives.</summary>
public sealed class ProceduralModelShader : IDisposable
{
    private const string VertexSource = """
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

    private const string FragmentSource = """
        #version 330

        in vec3 fragPosition;
        in vec3 fragNormal;
        in vec4 fragColor;
        in vec2 fragTexCoord;

        uniform vec4 colDiffuse;
        uniform vec3 viewPos;
        uniform int detailKind;
        uniform float detailScale;
        uniform float roughness;
        uniform float metalness;
        uniform int useTexture;
        uniform sampler2D albedoMap;
        uniform sampler2D normalMap;

        out vec4 finalColor;

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

        void main()
        {
            vec3 normal = normalize(gl_FrontFacing ? fragNormal : -fragNormal);
            vec3 albedo = srgbToLinear(max((colDiffuse*fragColor).rgb, vec3(0.0)));
            float alpha = (colDiffuse*fragColor).a;
            if (useTexture != 0)
            {
                vec4 sampled = texture(albedoMap, fragTexCoord);
                albedo *= srgbToLinear(sampled.rgb);
                alpha *= sampled.a;
                vec3 sampledNormal = texture(normalMap, fragTexCoord).xyz*2.0 - 1.0;
                normal = perturbNormal(normal, sampledNormal, fragTexCoord);
            }
            vec3 lightDirection = normalize(vec3(-.45, .82, -.34));
            vec3 viewDirection = normalize(viewPos - fragPosition);
            vec3 halfDirection = normalize(lightDirection + viewDirection);
            float diffuse = max(dot(normal, lightDirection), 0.0);
            float shine = mix(90.0, 6.0, roughness);
            float specular = pow(max(dot(normal, halfDirection), 0.0), shine)*(.18 + metalness*.82);
            vec3 specularColor = mix(vec3(.04), albedo, metalness);
            vec3 lit = albedo*(.31 + diffuse*.78)*(1.0 - metalness*.30) + specularColor*specular;
            finalColor = vec4(pow(max(lit, vec3(0.0)), vec3(1.0/2.2)), alpha);
        }
        """;

    private readonly Shader _shader;
    private readonly bool _valid;
    private readonly int _viewLocation = -1;
    private readonly int _kindLocation = -1;
    private readonly int _scaleLocation = -1;
    private readonly int _roughnessLocation = -1;
    private readonly int _metalnessLocation = -1;
    private readonly int _useTextureLocation = -1;
    private readonly int _albedoMapLocation = -1;
    private readonly int _normalMapLocation = -1;
    private bool _disposed;

    public ProceduralModelShader()
    {
        _shader = Raylib.LoadShaderFromMemory(VertexSource, FragmentSource);
        _valid = Raylib.IsShaderValid(_shader);
        if (!_valid) return;
        _viewLocation = Raylib.GetShaderLocation(_shader, "viewPos");
        _kindLocation = Raylib.GetShaderLocation(_shader, "detailKind");
        _scaleLocation = Raylib.GetShaderLocation(_shader, "detailScale");
        _roughnessLocation = Raylib.GetShaderLocation(_shader, "roughness");
        _metalnessLocation = Raylib.GetShaderLocation(_shader, "metalness");
        _useTextureLocation = Raylib.GetShaderLocation(_shader, "useTexture");
        _albedoMapLocation = Raylib.GetShaderLocation(_shader, "albedoMap");
        _normalMapLocation = Raylib.GetShaderLocation(_shader, "normalMap");
    }

    public void Begin()
    {
        if (!_valid) return;
        var view = Rlgl.GetMatrixModelview();
        if (Matrix4x4.Invert(view, out var inverse))
            Set(_viewLocation, new Vector3(inverse.M41, inverse.M42, inverse.M43), ShaderUniformDataType.Vec3);
        Raylib.BeginShaderMode(_shader);
    }

    public void Configure(int kind, float roughness, float metalness, float scale = 18f)
    {
        if (!_valid) return;
        // Preserve per-part material settings across raylib's shared batch.
        Rlgl.DrawRenderBatchActive();
        Set(_useTextureLocation, 0, ShaderUniformDataType.Int);
        Set(_kindLocation, kind, ShaderUniformDataType.Int);
        Set(_scaleLocation, scale*.22f, ShaderUniformDataType.Float);
        Set(_roughnessLocation, roughness, ShaderUniformDataType.Float);
        Set(_metalnessLocation, metalness, ShaderUniformDataType.Float);
    }

    public void ConfigureTextured(
        Texture2D albedo, Texture2D normal, float roughness, float metalness)
    {
        if (!_valid) return;
        Rlgl.DrawRenderBatchActive();
        Set(_useTextureLocation, 1, ShaderUniformDataType.Int);
        Set(_roughnessLocation, roughness, ShaderUniformDataType.Float);
        Set(_metalnessLocation, metalness, ShaderUniformDataType.Float);
        if (_albedoMapLocation >= 0) Raylib.SetShaderValueTexture(_shader, _albedoMapLocation, albedo);
        if (_normalMapLocation >= 0) Raylib.SetShaderValueTexture(_shader, _normalMapLocation, normal);
    }

    public void End()
    {
        if (_valid) Raylib.EndShaderMode();
    }

    public void Dispose()
    {
        if (_disposed) return;
        if (_valid) Raylib.UnloadShader(_shader);
        _disposed = true;
        GC.SuppressFinalize(this);
    }

    private void Set<T>(int location, T value, ShaderUniformDataType type) where T : unmanaged
    {
        if (location >= 0) Raylib.SetShaderValue(_shader, location, value, type);
    }
}
