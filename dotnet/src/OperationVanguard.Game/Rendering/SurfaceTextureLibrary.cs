using OperationVanguard.Core;
using Raylib_cs;

namespace OperationVanguard.Game.Rendering;

/// <summary>
/// The canonical bitmap surfaces exported from the web renderer. These files are
/// the actual CanvasTexture/DataTexture pixels used by the browser client.
/// </summary>
internal sealed class SurfaceTextureLibrary : IDisposable
{
    private readonly Texture2D[] _albedo = new Texture2D[16];
    private readonly Texture2D[] _normal = new Texture2D[16];
    private bool _disposed;

    public SurfaceTextureLibrary()
    {
        var root = Path.Combine(AppContext.BaseDirectory, "Assets", "Textures");
        foreach (var surface in Enum.GetValues<SurfaceType>())
        {
            var name = surface.ToString().ToLowerInvariant();
            _albedo[(int)surface] = Load(Path.Combine(root, $"{name}-albedo.png"));
            _normal[(int)surface] = Load(Path.Combine(root, $"{name}-normal.png"));
        }
    }

    public Texture2D Albedo(SurfaceType surface) => _albedo[(int)surface];
    public Texture2D Normal(SurfaceType surface) => _normal[(int)surface];

    public void Dispose()
    {
        if (_disposed) return;
        foreach (var texture in _albedo) Raylib.UnloadTexture(texture);
        foreach (var texture in _normal) Raylib.UnloadTexture(texture);
        _disposed = true;
        GC.SuppressFinalize(this);
    }

    private static Texture2D Load(string path)
    {
        var texture = Raylib.LoadTexture(path);
        if (!Raylib.IsTextureValid(texture))
            throw new InvalidOperationException($"Could not load canonical texture: {path}");
        Raylib.GenTextureMipmaps(ref texture);
        Raylib.SetTextureFilter(texture, TextureFilter.Trilinear);
        Raylib.SetTextureWrap(texture, TextureWrap.Repeat);
        return texture;
    }
}
