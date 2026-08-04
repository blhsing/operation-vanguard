using OperationVanguard.Core;
using Raylib_cs;

namespace OperationVanguard.Game.Input;

/// <summary>
/// Converts native keyboard, mouse, and gamepad state into the same tick command
/// consumed by the deterministic web simulation.
/// </summary>
public sealed class NativeInput
{
    private const double MouseRadiansPerCount = 0.0022d;

    private double _yaw;
    private double _pitch;
    private double _mouseX;
    private double _mouseY;
    private int _sequence;
    private bool _swapLatched;
    private int _killstreakLatched = -1;
    private bool _sprintPressed;
    private bool _adsToggled;
    private bool _crouchToggled;
    private double _gamepadMoveX;
    private double _gamepadMoveY;
    private double _gamepadLookX;
    private double _gamepadLookY;
    private int _gamepadButtons;
    private IReadOnlyDictionary<string, List<string>> _bindings = InputBindingCatalog.CreateDefaults();

    public double Sensitivity { get; set; } = 1d;
    public double AdsSensitivityScale { get; set; } = 0.8d;
    public bool InvertY { get; set; }
    public bool AutoSprint { get; set; }
    public bool ToggleAds { get; set; }
    public bool ToggleCrouch { get; set; }
    public double GamepadDeadzone { get; set; } = .14d;
    public double GamepadSensitivity { get; set; } = 2.4d;

    public bool ScoreboardHeld => IsActionDown(InputActions.Scoreboard);

    public void SetBindings(IReadOnlyDictionary<string, List<string>> bindings) =>
        _bindings = InputBindingCatalog.Sanitize(bindings);

    public bool IsActionPressed(string action) => TestAction(action, pressed: true);

    public void Reset(double yaw, double pitch = 0)
    {
        _yaw = yaw;
        _pitch = pitch;
        _mouseX = 0;
        _mouseY = 0;
        _swapLatched = false;
        _killstreakLatched = -1;
        _sprintPressed = false;
        _adsToggled = false;
        _crouchToggled = false;
    }

    public void SetViewAngles(double yaw, double pitch)
    {
        _yaw = yaw;
        _pitch = Math.Clamp(pitch, -Math.PI / 2d + .02d, Math.PI / 2d - .02d);
        _mouseX = 0;
        _mouseY = 0;
    }

    public void ApplyRecoil(double pitchKick, double yawKick)
    {
        _pitch = Math.Clamp(_pitch - pitchKick, -Math.PI / 2d + .02d, Math.PI / 2d - .02d);
        _yaw += yawKick;
    }

    /// <summary>Collects frame-rate input. Latches survive until the next simulation tick.</summary>
    public void PollFrame()
    {
        var delta = Raylib.GetMouseDelta();
        _mouseX += delta.X;
        _mouseY += delta.Y;
        _swapLatched |= IsActionPressed(InputActions.Swap);
        _sprintPressed |= IsActionPressed(InputActions.Sprint);
        if (ToggleAds && IsActionPressed(InputActions.Ads)) _adsToggled = !_adsToggled;
        if (ToggleCrouch && IsActionPressed(InputActions.Crouch)) _crouchToggled = !_crouchToggled;
        if (IsActionPressed(InputActions.Killstreak1)) _killstreakLatched = 0;
        if (IsActionPressed(InputActions.Killstreak2)) _killstreakLatched = 1;
        if (IsActionPressed(InputActions.Killstreak3)) _killstreakLatched = 2;
        PollGamepad();
    }

    public InputCommand BuildCommand(double deltaTime, double adsProgress, int tick)
    {
        var sensitivity = Sensitivity * (1d + (AdsSensitivityScale - 1d) * adsProgress);
        _yaw -= _mouseX * MouseRadiansPerCount * sensitivity;
        var pitchDelta = _mouseY * MouseRadiansPerCount * sensitivity;
        _pitch += InvertY ? -pitchDelta : pitchDelta;
        _pitch = Math.Clamp(_pitch, -Math.PI / 2d + 0.02d, Math.PI / 2d - 0.02d);
        _mouseX = 0;
        _mouseY = 0;

        if (Raylib.IsGamepadAvailable(0))
        {
            var gamepadScale = GamepadSensitivity * sensitivity * deltaTime;
            _yaw -= _gamepadLookX * gamepadScale;
            var gamepadPitch = _gamepadLookY * gamepadScale;
            _pitch += InvertY ? -gamepadPitch : gamepadPitch;
            _pitch = Math.Clamp(_pitch, -Math.PI / 2d + .02d, Math.PI / 2d - .02d);
        }

        var forward = (IsActionDown(InputActions.Forward) ? 1d : 0d) -
                      (IsActionDown(InputActions.Back) ? 1d : 0d);
        var right = (IsActionDown(InputActions.Right) ? 1d : 0d) -
                    (IsActionDown(InputActions.Left) ? 1d : 0d);
        forward -= _gamepadMoveY;
        right += _gamepadMoveX;

        var buttons = (InputFlag)_gamepadButtons;
        if (IsActionDown(InputActions.Jump)) buttons |= InputFlag.Jump;
        if (ToggleCrouch ? _crouchToggled : IsActionDown(InputActions.Crouch))
            buttons |= InputFlag.Crouch;
        if (IsActionDown(InputActions.Prone)) buttons |= InputFlag.Prone;

        var sprinting = IsActionDown(InputActions.Sprint) || AutoSprint && forward > 0.5d;
        if (sprinting) buttons |= InputFlag.Sprint;
        if (sprinting && forward > 0.5d && _sprintPressed) buttons |= InputFlag.TacticalSprint;

        if (IsActionDown(InputActions.Fire)) buttons |= InputFlag.Fire;
        if (ToggleAds ? _adsToggled : IsActionDown(InputActions.Ads)) buttons |= InputFlag.Ads;
        if (IsActionDown(InputActions.Reload)) buttons |= InputFlag.Reload;
        if (IsActionDown(InputActions.Melee)) buttons |= InputFlag.Melee;
        if (IsActionDown(InputActions.Use)) buttons |= InputFlag.Use;
        if (IsActionDown(InputActions.Lethal)) buttons |= InputFlag.Lethal;
        if (IsActionDown(InputActions.Tactical)) buttons |= InputFlag.Tactical;
        if (IsActionDown(InputActions.FieldUpgrade)) buttons |= InputFlag.FieldUpgrade;
        if (IsActionDown(InputActions.LeanLeft)) buttons |= InputFlag.LeanLeft;
        if (IsActionDown(InputActions.LeanRight)) buttons |= InputFlag.LeanRight;
        if (_swapLatched) buttons |= InputFlag.SwapWeapon;

        var command = new InputCommand
        {
            Seq = ++_sequence,
            Tick = tick,
            Dt = deltaTime,
            MoveForward = Math.Clamp(forward, -1d, 1d),
            MoveRight = Math.Clamp(right, -1d, 1d),
            Yaw = _yaw,
            Pitch = _pitch,
            Buttons = (int)buttons,
            KillstreakSlot = _killstreakLatched,
        };

        _swapLatched = false;
        _killstreakLatched = -1;
        _sprintPressed = false;
        return command;
    }

    private bool IsActionDown(string action) => TestAction(action, pressed: false);

    private bool TestAction(string action, bool pressed)
    {
        if (!_bindings.TryGetValue(action, out var codes)) return false;
        foreach (var code in codes)
        {
            if (InputBindingCatalog.TryGetKeyboardKey(code, out var key) &&
                (pressed ? Raylib.IsKeyPressed(key) : Raylib.IsKeyDown(key)))
                return true;
            if (InputBindingCatalog.TryGetMouseButton(code, out var button) &&
                (pressed ? Raylib.IsMouseButtonPressed(button) : Raylib.IsMouseButtonDown(button)))
                return true;
        }
        return false;
    }

    private void PollGamepad()
    {
        if (!Raylib.IsGamepadAvailable(0))
        {
            _gamepadMoveX = _gamepadMoveY = _gamepadLookX = _gamepadLookY = 0;
            _gamepadButtons = 0;
            return;
        }

        _gamepadMoveX = ApplyDeadzone(Raylib.GetGamepadAxisMovement(0, GamepadAxis.LeftX));
        _gamepadMoveY = ApplyDeadzone(Raylib.GetGamepadAxisMovement(0, GamepadAxis.LeftY));
        _gamepadLookX = ApplyDeadzone(Raylib.GetGamepadAxisMovement(0, GamepadAxis.RightX));
        _gamepadLookY = ApplyDeadzone(Raylib.GetGamepadAxisMovement(0, GamepadAxis.RightY));

        var buttons = InputFlag.None;
        if (Pressed(GamepadButton.RightTrigger2)) buttons |= InputFlag.Fire;
        if (Pressed(GamepadButton.LeftTrigger2)) buttons |= InputFlag.Ads;
        if (Pressed(GamepadButton.RightFaceDown)) buttons |= InputFlag.Jump;
        if (Pressed(GamepadButton.RightFaceRight)) buttons |= InputFlag.Crouch;
        if (Pressed(GamepadButton.RightFaceLeft)) buttons |= InputFlag.Reload;
        if (Pressed(GamepadButton.RightFaceUp)) buttons |= InputFlag.SwapWeapon;
        if (Pressed(GamepadButton.LeftTrigger1)) buttons |= InputFlag.Tactical;
        if (Pressed(GamepadButton.RightTrigger1)) buttons |= InputFlag.Lethal;
        if (Pressed(GamepadButton.LeftThumb)) buttons |= InputFlag.Sprint;
        if (Pressed(GamepadButton.RightThumb)) buttons |= InputFlag.Melee;
        _gamepadButtons = (int)buttons;
    }

    private double ApplyDeadzone(double value)
    {
        var magnitude = Math.Abs(value);
        if (magnitude < GamepadDeadzone) return 0;
        var scaled = (magnitude - GamepadDeadzone) / Math.Max(.001d, 1d - GamepadDeadzone);
        return Math.Sign(value) * scaled * scaled;
    }

    private static bool Pressed(GamepadButton button) => Raylib.IsGamepadButtonDown(0, button);
}
