using Raylib_cs;

namespace OperationVanguard.Game.Input;

/// <summary>
/// The canonical keyboard and mouse actions shared by profile persistence,
/// native input polling, and the key-binding screen.
/// </summary>
public static class InputActions
{
    public const string Forward = "forward";
    public const string Back = "back";
    public const string Left = "left";
    public const string Right = "right";
    public const string Jump = "jump";
    public const string Crouch = "crouch";
    public const string Prone = "prone";
    public const string Sprint = "sprint";
    public const string Fire = "fire";
    public const string Ads = "ads";
    public const string Reload = "reload";
    public const string Melee = "melee";
    public const string Use = "use";
    public const string Lethal = "lethal";
    public const string Tactical = "tactical";
    public const string Swap = "swap";
    public const string LeanLeft = "leanLeft";
    public const string LeanRight = "leanRight";
    public const string FieldUpgrade = "fieldUpgrade";
    public const string Scoreboard = "scoreboard";
    public const string Pause = "pause";
    public const string Killstreak1 = "killstreak1";
    public const string Killstreak2 = "killstreak2";
    public const string Killstreak3 = "killstreak3";
}

public sealed record InputBindingDefinition(string Action, string Label, params string[] Defaults);

/// <summary>
/// Uses the same action names, order, two-slot model, and persisted key codes as
/// the web client. Browser-style codes are translated only at the Raylib edge.
/// </summary>
public static class InputBindingCatalog
{
    public static IReadOnlyList<InputBindingDefinition> All { get; } =
    [
        new(InputActions.Forward, "前進", "KeyW", "ArrowUp"),
        new(InputActions.Back, "後退", "KeyS", "ArrowDown"),
        new(InputActions.Left, "向左", "KeyA", "ArrowLeft"),
        new(InputActions.Right, "向右", "KeyD", "ArrowRight"),
        new(InputActions.Jump, "跳躍／翻越", "Space"),
        new(InputActions.Crouch, "蹲下／滑鏟", "ControlLeft", "KeyC"),
        new(InputActions.Prone, "趴下", "KeyZ"),
        new(InputActions.Sprint, "衝刺", "ShiftLeft"),
        new(InputActions.Fire, "開火", "Mouse0"),
        new(InputActions.Ads, "瞄準", "Mouse2"),
        new(InputActions.Reload, "裝填", "KeyR"),
        new(InputActions.Melee, "近戰", "KeyV", "Mouse1"),
        new(InputActions.Use, "互動／購買", "KeyF", "KeyE"),
        new(InputActions.Lethal, "致命裝備", "KeyG"),
        new(InputActions.Tactical, "戰術裝備", "KeyQ"),
        new(InputActions.Swap, "切換武器", "Digit1", "Digit2"),
        new(InputActions.LeanLeft, "向左傾身", "KeyQ"),
        new(InputActions.LeanRight, "向右傾身", "KeyE"),
        new(InputActions.FieldUpgrade, "戰地升級", "KeyX"),
        new(InputActions.Scoreboard, "計分板", "Tab"),
        new(InputActions.Pause, "暫停", "Escape"),
        new(InputActions.Killstreak1, "連殺獎勵 1", "Digit3"),
        new(InputActions.Killstreak2, "連殺獎勵 2", "Digit4"),
        new(InputActions.Killstreak3, "連殺獎勵 3", "Digit5"),
    ];

    private static readonly IReadOnlyDictionary<string, InputBindingDefinition> ByAction =
        All.ToDictionary(definition => definition.Action, StringComparer.Ordinal);

    private static readonly IReadOnlyDictionary<string, KeyboardKey> NamedKeys =
        new Dictionary<string, KeyboardKey>(StringComparer.Ordinal)
        {
            ["Space"] = KeyboardKey.Space,
            ["Escape"] = KeyboardKey.Escape,
            ["Enter"] = KeyboardKey.Enter,
            ["Tab"] = KeyboardKey.Tab,
            ["Backspace"] = KeyboardKey.Backspace,
            ["Insert"] = KeyboardKey.Insert,
            ["Delete"] = KeyboardKey.Delete,
            ["ArrowRight"] = KeyboardKey.Right,
            ["ArrowLeft"] = KeyboardKey.Left,
            ["ArrowDown"] = KeyboardKey.Down,
            ["ArrowUp"] = KeyboardKey.Up,
            ["PageUp"] = KeyboardKey.PageUp,
            ["PageDown"] = KeyboardKey.PageDown,
            ["Home"] = KeyboardKey.Home,
            ["End"] = KeyboardKey.End,
            ["CapsLock"] = KeyboardKey.CapsLock,
            ["ScrollLock"] = KeyboardKey.ScrollLock,
            ["NumLock"] = KeyboardKey.NumLock,
            ["PrintScreen"] = KeyboardKey.PrintScreen,
            ["Pause"] = KeyboardKey.Pause,
            ["ShiftLeft"] = KeyboardKey.LeftShift,
            ["ControlLeft"] = KeyboardKey.LeftControl,
            ["AltLeft"] = KeyboardKey.LeftAlt,
            ["MetaLeft"] = KeyboardKey.LeftSuper,
            ["ShiftRight"] = KeyboardKey.RightShift,
            ["ControlRight"] = KeyboardKey.RightControl,
            ["AltRight"] = KeyboardKey.RightAlt,
            ["MetaRight"] = KeyboardKey.RightSuper,
            ["ContextMenu"] = KeyboardKey.KeyboardMenu,
            ["Quote"] = KeyboardKey.Apostrophe,
            ["Comma"] = KeyboardKey.Comma,
            ["Minus"] = KeyboardKey.Minus,
            ["Period"] = KeyboardKey.Period,
            ["Slash"] = KeyboardKey.Slash,
            ["Semicolon"] = KeyboardKey.Semicolon,
            ["Equal"] = KeyboardKey.Equal,
            ["BracketLeft"] = KeyboardKey.LeftBracket,
            ["Backslash"] = KeyboardKey.Backslash,
            ["BracketRight"] = KeyboardKey.RightBracket,
            ["Backquote"] = KeyboardKey.Grave,
            ["NumpadDecimal"] = KeyboardKey.KpDecimal,
            ["NumpadDivide"] = KeyboardKey.KpDivide,
            ["NumpadMultiply"] = KeyboardKey.KpMultiply,
            ["NumpadSubtract"] = KeyboardKey.KpSubtract,
            ["NumpadAdd"] = KeyboardKey.KpAdd,
            ["NumpadEnter"] = KeyboardKey.KpEnter,
            ["NumpadEqual"] = KeyboardKey.KpEqual,
            ["AudioVolumeUp"] = KeyboardKey.VolumeUp,
            ["AudioVolumeDown"] = KeyboardKey.VolumeDown,
        };

    private static readonly IReadOnlyDictionary<KeyboardKey, string> NamedCodes =
        NamedKeys.ToDictionary(pair => pair.Value, pair => pair.Key);

    private static readonly string[] NumberNames =
        ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];

    public static Dictionary<string, List<string>> CreateDefaults() =>
        All.ToDictionary(
            definition => definition.Action,
            definition => definition.Defaults.ToList(),
            StringComparer.Ordinal);

    /// <summary>
    /// Merges an older or partially-written profile over defaults. An explicit
    /// empty list remains empty, which lets players intentionally unbind an action.
    /// </summary>
    public static Dictionary<string, List<string>> Sanitize(
        IReadOnlyDictionary<string, List<string>>? bindings)
    {
        var result = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var definition in All)
        {
            if (bindings is null || !bindings.TryGetValue(definition.Action, out var stored) || stored is null)
            {
                result[definition.Action] = definition.Defaults.ToList();
                continue;
            }

            result[definition.Action] = stored
                .Where(code => !string.IsNullOrWhiteSpace(code) && IsSupportedCode(code))
                .Distinct(StringComparer.Ordinal)
                .Take(2)
                .ToList();
        }
        return result;
    }

    public static void Assign(IDictionary<string, List<string>> bindings, string action, int slot, string code)
    {
        if (!ByAction.ContainsKey(action)) throw new ArgumentOutOfRangeException(nameof(action));
        if (slot is < 0 or > 1) throw new ArgumentOutOfRangeException(nameof(slot));
        if (!IsSupportedCode(code)) throw new ArgumentException($"Unsupported input code '{code}'.", nameof(code));

        foreach (var definition in All)
        {
            if (!bindings.TryGetValue(definition.Action, out var list) || list is null)
            {
                list = [];
                bindings[definition.Action] = list;
            }

            for (var index = list.Count - 1; index >= 0; index--)
            {
                if (list[index] == code && !(definition.Action == action && index == slot))
                    list.RemoveAt(index);
            }
        }

        var target = bindings[action];
        while (target.Count <= slot) target.Add(string.Empty);
        target[slot] = code;
        bindings[action] = target.Where(value => !string.IsNullOrEmpty(value)).Take(2).ToList();
    }

    public static void Reset(IDictionary<string, List<string>> bindings)
    {
        bindings.Clear();
        foreach (var definition in All)
            bindings[definition.Action] = definition.Defaults.ToList();
    }

    public static string KeyLabel(string? code)
    {
        if (string.IsNullOrEmpty(code)) return "—";
        if (code == "Mouse0") return "滑鼠左鍵";
        if (code == "Mouse1") return "滑鼠中鍵";
        if (code == "Mouse2") return "滑鼠右鍵";
        if (code.StartsWith("Mouse", StringComparison.Ordinal)) return $"滑鼠按鍵{code[5..]}";
        if (code.StartsWith("Key", StringComparison.Ordinal)) return code[3..];
        if (code.StartsWith("Digit", StringComparison.Ordinal)) return code[5..];
        if (code.StartsWith("Arrow", StringComparison.Ordinal)) return $"方向鍵{code[5..]}";
        if (code == "Space") return "空白鍵";
        if (code.EndsWith("Left", StringComparison.Ordinal)) return $"左{code[..^4]}";
        if (code.EndsWith("Right", StringComparison.Ordinal)) return $"右{code[..^5]}";
        if (code.StartsWith("Raylib:", StringComparison.Ordinal)) return code[7..];
        return code;
    }

    public static bool IsSupportedCode(string code) =>
        TryGetKeyboardKey(code, out _) || TryGetMouseButton(code, out _);

    public static bool TryGetKeyboardKey(string code, out KeyboardKey key)
    {
        if (NamedKeys.TryGetValue(code, out key)) return true;

        if (code.Length == 4 && code.StartsWith("Key", StringComparison.Ordinal) &&
            code[3] is >= 'A' and <= 'Z' && Enum.TryParse(code[3..], out key))
            return true;

        if (code.Length == 6 && code.StartsWith("Digit", StringComparison.Ordinal) &&
            code[5] is >= '0' and <= '9' && Enum.TryParse(NumberNames[code[5] - '0'], out key))
            return true;

        if (code.Length is 2 or 3 && code[0] == 'F' &&
            int.TryParse(code[1..], out var function) && function is >= 1 and <= 12 &&
            Enum.TryParse(code, out key))
            return true;

        if (code.Length == 7 && code.StartsWith("Numpad", StringComparison.Ordinal) &&
            code[6] is >= '0' and <= '9' && Enum.TryParse($"Kp{code[6]}", out key))
            return true;

        if (code.StartsWith("Raylib:", StringComparison.Ordinal) &&
            Enum.TryParse(code[7..], out key) && key != KeyboardKey.Null)
            return true;

        key = KeyboardKey.Null;
        return false;
    }

    public static bool TryGetMouseButton(string code, out MouseButton button)
    {
        button = code switch
        {
            "Mouse0" => MouseButton.Left,
            "Mouse1" => MouseButton.Middle,
            "Mouse2" => MouseButton.Right,
            "Mouse3" => MouseButton.Side,
            "Mouse4" => MouseButton.Extra,
            "Mouse5" => MouseButton.Forward,
            "Mouse6" => MouseButton.Back,
            _ => (MouseButton)(-1),
        };
        return (int)button >= 0;
    }

    public static string CodeForKey(KeyboardKey key)
    {
        if (NamedCodes.TryGetValue(key, out var named)) return named;
        var name = key.ToString();
        if (name.Length == 1 && name[0] is >= 'A' and <= 'Z') return $"Key{name}";
        var number = Array.IndexOf(NumberNames, name);
        if (number >= 0) return $"Digit{number}";
        if (name.StartsWith('F') && int.TryParse(name[1..], out var function) && function is >= 1 and <= 12)
            return name;
        if (name.Length == 3 && name.StartsWith("Kp", StringComparison.Ordinal) && char.IsDigit(name[2]))
            return $"Numpad{name[2]}";
        return $"Raylib:{name}";
    }

    public static string CodeForMouseButton(MouseButton button) => button switch
    {
        MouseButton.Left => "Mouse0",
        MouseButton.Middle => "Mouse1",
        MouseButton.Right => "Mouse2",
        MouseButton.Side => "Mouse3",
        MouseButton.Extra => "Mouse4",
        MouseButton.Forward => "Mouse5",
        MouseButton.Back => "Mouse6",
        _ => throw new ArgumentOutOfRangeException(nameof(button)),
    };
}
