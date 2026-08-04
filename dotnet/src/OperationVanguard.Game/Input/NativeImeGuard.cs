using System.Runtime.InteropServices;

namespace OperationVanguard.Game.Input;

/// <summary>Disables IME composition only for the game window while preserving every other app.</summary>
public sealed class NativeImeGuard : IDisposable
{
    private nint _window;
    private nint _previousContext;

    public NativeImeGuard()
    {
        if (!OperatingSystem.IsWindows()) return;
        _window = GetActiveWindow();
        if (_window == 0) return;
        _previousContext = ImmAssociateContext(_window, 0);
    }

    public void Dispose()
    {
        if (_window == 0) return;
        ImmAssociateContext(_window, _previousContext);
        _window = 0;
        _previousContext = 0;
        GC.SuppressFinalize(this);
    }

    [DllImport("user32.dll")]
    private static extern nint GetActiveWindow();

    [DllImport("imm32.dll")]
    private static extern nint ImmAssociateContext(nint window, nint inputContext);
}
