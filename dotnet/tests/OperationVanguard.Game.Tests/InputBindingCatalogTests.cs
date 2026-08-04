using OperationVanguard.Game.Input;
using OperationVanguard.Game.Profile;
using Raylib_cs;
using System.Text.Json;

namespace OperationVanguard.Game.Tests;

public sealed class InputBindingCatalogTests
{
    [Fact]
    public void DefaultsMatchWebActionsAndUseIndependentLists()
    {
        var first = InputBindingCatalog.CreateDefaults();
        var second = InputBindingCatalog.CreateDefaults();

        Assert.Equal(24, first.Count);
        Assert.Equal(["KeyW", "ArrowUp"], first[InputActions.Forward]);
        Assert.Equal(["Mouse0"], first[InputActions.Fire]);
        Assert.Equal(["Escape"], first[InputActions.Pause]);

        first[InputActions.Forward][0] = "KeyI";
        Assert.Equal("KeyW", second[InputActions.Forward][0]);
    }

    [Fact]
    public void AssignUsesTwoSlotsAndRemovesConflicts()
    {
        var bindings = InputBindingCatalog.CreateDefaults();

        InputBindingCatalog.Assign(bindings, InputActions.Forward, 1, "KeyE");

        Assert.Equal(["KeyW", "KeyE"], bindings[InputActions.Forward]);
        Assert.DoesNotContain("KeyE", bindings[InputActions.Use]);
        Assert.DoesNotContain("KeyE", bindings[InputActions.LeanRight]);
    }

    [Fact]
    public void SanitizeMergesMissingActionsButPreservesExplicitUnboundAction()
    {
        var stored = new Dictionary<string, List<string>>(StringComparer.Ordinal)
        {
            [InputActions.Fire] = [],
            [InputActions.Forward] = ["KeyI", "not-a-key", "KeyI", "KeyO"],
            ["removedAction"] = ["KeyP"],
        };

        var sanitized = InputBindingCatalog.Sanitize(stored);

        Assert.Empty(sanitized[InputActions.Fire]);
        Assert.Equal(["KeyI", "KeyO"], sanitized[InputActions.Forward]);
        Assert.Equal(["KeyS", "ArrowDown"], sanitized[InputActions.Back]);
        Assert.DoesNotContain("removedAction", sanitized.Keys);
    }

    [Fact]
    public void EveryRaylibKeyboardAndMouseCodeRoundTrips()
    {
        foreach (var key in Enum.GetValues<KeyboardKey>().Where(key => key != KeyboardKey.Null))
        {
            var code = InputBindingCatalog.CodeForKey(key);
            Assert.True(InputBindingCatalog.TryGetKeyboardKey(code, out var decoded), code);
            Assert.Equal(key, decoded);
        }

        foreach (var button in Enum.GetValues<MouseButton>())
        {
            var code = InputBindingCatalog.CodeForMouseButton(button);
            Assert.True(InputBindingCatalog.TryGetMouseButton(code, out var decoded), code);
            Assert.Equal(button, decoded);
        }
    }

    [Fact]
    public void ResetRestoresEveryCanonicalDefault()
    {
        var bindings = InputBindingCatalog.CreateDefaults();
        InputBindingCatalog.Assign(bindings, InputActions.Fire, 0, "KeyP");

        InputBindingCatalog.Reset(bindings);

        var expected = InputBindingCatalog.CreateDefaults();
        Assert.Equal(expected.Keys, bindings.Keys);
        foreach (var action in expected.Keys)
            Assert.Equal(expected[action], bindings[action]);
    }

    [Fact]
    public void NativeSettingsPersistBindingsAndOldProfilesReceiveDefaults()
    {
        var settings = new NativeSettings();
        InputBindingCatalog.Assign(settings.Bindings, InputActions.Forward, 0, "KeyI");
        var options = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

        var restored = JsonSerializer.Deserialize<NativeSettings>(JsonSerializer.Serialize(settings, options), options);
        var migrated = JsonSerializer.Deserialize<NativeSettings>("{}", options);

        Assert.NotNull(restored);
        Assert.Equal("KeyI", restored.Bindings[InputActions.Forward][0]);
        Assert.NotNull(migrated);
        Assert.Equal(["KeyW", "ArrowUp"], migrated.Bindings[InputActions.Forward]);
    }
}
