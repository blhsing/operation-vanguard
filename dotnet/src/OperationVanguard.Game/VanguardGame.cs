using System.Globalization;
using System.Numerics;
using OperationVanguard.Core;
using OperationVanguard.Game.Audio;
using OperationVanguard.Game.Input;
using OperationVanguard.Game.Menus;
using OperationVanguard.Game.Profile;
using OperationVanguard.Game.Rendering;
using Raylib_cs;

namespace OperationVanguard.Game;

public sealed class VanguardGame : IDisposable
{
    private const double TickRate = 64d;
    private const double TickDelta = 1d / TickRate;
    private static readonly Color Background = new(9, 12, 15, 255);
    private static readonly Color Panel = new(15, 20, 25, 238);
    private static readonly Color Ink = new(230, 238, 244, 255);
    private static readonly Color DimInk = new(158, 173, 183, 255);
    private static readonly Color Accent = new(255, 122, 41, 255);
    private static readonly Color Friendly = new(245, 76, 68, 255);
    private static readonly Color Enemy = new(92, 230, 92, 255);
    private static readonly Color Health = new(70, 170, 255, 255);

    private readonly string[] _args;
    private readonly NativeInput _input = new();
    private readonly TransientEffectsRenderer _effectsRenderer = new();
    private readonly NativeProfile _profile;
    private readonly LoadoutEditorModel _loadoutEditor;
    private readonly string? _smokePath;
    private UiFont? _font;
    private NativeAudio? _audio;
    private NativeImeGuard? _imeGuard;
    private Texture2D _logoTexture;
    private bool _logoLoaded;
    private NativeSession? _session;
    private OnlineSession? _pendingOnline;
    private MapRenderer? _mapRenderer;
    private EntityRenderer? _entityRenderer;
    private MinimapRenderer? _minimapRenderer;
    private ZombiesWorldRenderer? _zombiesRenderer;
    private WeaponViewRenderer? _weaponRenderer;
    private AppScreen _screen = AppScreen.Main;
    private int _mainSelection;
    private int _missionSelection;
    private int _skirmishField;
    private int _mapSelection;
    private int _modeSelection;
    private int _botCount;
    private int _difficultySelection;
    private int _zombiesField;
    private int _onlineField;
    private int _zombieBotCount;
    private int _settingsSelection;
    private int _controlsSelection;
    private int _controlsSlot;
    private int _controlsScroll;
    private int _pauseSelection;
    private int _resultsSelection;
    private string? _capturingAction;
    private string _onlineUrl;
    private string _onlineMessage = string.Empty;
    private double _onlineElapsed;
    private bool _onlineReconfigured;
    private double _accumulator;
    private double _eyeHeight = GameConstants.EyeHeight.Stand;
    private int _smokeFrames;
    private bool _disposed;
    private bool _exitRequested;
    private bool _borderlessFullscreen;
    private bool _campaignSaveAvailable;
    private double _missionEndDelay;
    private bool _missionResultRecorded;
    private readonly List<FeedLine> _feed = [];
    private double _hitMarkerTime;
    private double _damageOverlayTime;
    private double _announcementTime;
    private double _scorePopupTime;
    private string _announcement = string.Empty;
    private string _scorePopup = string.Empty;
    private double _crosshairGap = 6d;

    public VanguardGame(string[] args)
    {
        _args = args;
        _smokePath = OptionValue("--smoke");
        _profile = ProfileStore.Load();
        _loadoutEditor = new LoadoutEditorModel(_profile);
        _missionSelection = Math.Max(0,
            CampaignCatalog.MissionIds.ToList().FindIndex(id => id == _profile.LastMatch.MissionId));
        _mapSelection = Math.Max(0, Maps.Ids.ToList().FindIndex(id => id == _profile.LastMatch.MapId));
        _modeSelection = Math.Max(0,
            ModeData.MultiplayerModeIds.ToList().FindIndex(id => id == _profile.LastMatch.ModeId));
        _botCount = _profile.LastMatch.BotCount;
        _zombieBotCount = Math.Clamp(_profile.LastMatch.BotCount, 0, 3);
        _onlineUrl = _profile.LastMatch.ServerUrl;
        _difficultySelection = Math.Max(0,
            BotData.DifficultyIds.ToList().FindIndex(id => id == _profile.LastMatch.Difficulty));
        _campaignSaveAvailable = CampaignSaveStore.Load() is not null;
    }

    public void Run()
    {
        var flags = ConfigFlags.ResizableWindow | ConfigFlags.Msaa4xHint | ConfigFlags.HighDpiWindow;
        var windowed = _args.Contains("--windowed", StringComparer.OrdinalIgnoreCase);
        if (!windowed) flags |= ConfigFlags.UndecoratedWindow;
        Raylib.SetConfigFlags(flags);
        Raylib.InitWindow(1600, 900, "先鋒行動 · Operation Vanguard (.NET)");
        if (!windowed) EnterBorderlessFullscreen();
        _imeGuard = new NativeImeGuard();
        LoadBranding();
        Raylib.SetExitKey(KeyboardKey.Null);
        Raylib.SetTargetFPS(144);
        _audio = new NativeAudio();
        _font = new UiFont();
        ApplyRuntimeSettings();

        var screenArgument = OptionValue("--screen");
        if (screenArgument is not null) _screen = ParseScreen(screenArgument);

        var onlineArgument = OptionValue("--online");
        var missionArgument = OptionValue("--mission");
        var modeArgument = OptionValue("--mode");
        if (onlineArgument is not null)
        {
            var mapArgument = OptionValue("--map");
            if (mapArgument is not null)
            {
                var mapIndex = Maps.Ids.ToList().FindIndex(id => id == mapArgument);
                if (mapIndex < 0) throw new ArgumentException($"Unknown map '{mapArgument}'.");
                _mapSelection = mapIndex;
            }
            if (modeArgument is not null)
            {
                var modeIndex = ModeData.MultiplayerModeIds.ToList().FindIndex(id => id == modeArgument);
                if (modeIndex < 0) throw new ArgumentException($"Unknown multiplayer mode '{modeArgument}'.");
                _modeSelection = modeIndex;
            }
            StartOnline(onlineArgument);
        }
        else if (missionArgument is not null)
        {
            var index = CampaignCatalog.MissionIds.ToList().FindIndex(id => id == missionArgument);
            if (index < 0) throw new ArgumentException($"Unknown campaign mission '{missionArgument}'.");
            _missionSelection = index;
            StartMission(CampaignCatalog.CampaignMissions[index]);
        }
        else if (modeArgument is not null)
        {
            if (modeArgument == ModeData.ZombiesModeId)
            {
                var zombieMap = OptionValue("--map") ?? ZombieMaps.Ids[0];
                if (!ZombieMaps.HasLayout(zombieMap))
                    throw new ArgumentException($"Map '{zombieMap}' has no Zombies layout.");
                if (int.TryParse(OptionValue("--bots"), CultureInfo.InvariantCulture, out var zombieBots))
                    _zombieBotCount = Math.Clamp(zombieBots, 0, 3);
                var zombieDifficulty = OptionValue("--difficulty");
                if (zombieDifficulty is not null)
                {
                    var difficultyIndex = BotData.DifficultyIds.ToList().FindIndex(id => id == zombieDifficulty);
                    if (difficultyIndex < 0) throw new ArgumentException($"Unknown bot difficulty '{zombieDifficulty}'.");
                    _difficultySelection = difficultyIndex;
                }
                StartZombies();
            }
            else
            {
                var modeIndex = ModeData.MultiplayerModeIds.ToList().FindIndex(id => id == modeArgument);
                if (modeIndex < 0) throw new ArgumentException($"Unknown multiplayer mode '{modeArgument}'.");
                _modeSelection = modeIndex;
                var mapArgument = OptionValue("--map");
                if (mapArgument is not null)
                {
                    var mapIndex = Maps.Ids.ToList().FindIndex(id => id == mapArgument);
                    if (mapIndex < 0) throw new ArgumentException($"Unknown map '{mapArgument}'.");
                    _mapSelection = mapIndex;
                }
                if (int.TryParse(OptionValue("--bots"), CultureInfo.InvariantCulture, out var bots))
                    _botCount = Math.Clamp(bots, 0, 17);
                var difficultyArgument = OptionValue("--difficulty");
                if (difficultyArgument is not null)
                {
                    var difficultyIndex = BotData.DifficultyIds.ToList().FindIndex(id => id == difficultyArgument);
                    if (difficultyIndex < 0) throw new ArgumentException($"Unknown bot difficulty '{difficultyArgument}'.");
                    _difficultySelection = difficultyIndex;
                }
                StartSkirmish();
            }
        }
        else if (_smokePath is not null && screenArgument is null)
        {
            StartMission(CampaignCatalog.CampaignMissions[0]);
        }

        while (!_exitRequested && !Raylib.WindowShouldClose())
        {
            var frameTime = Math.Min(Raylib.GetFrameTime(), 0.1f);
            Update(frameTime);
            Draw();

            if (_smokePath is not null && _screen != AppScreen.Connecting && ++_smokeFrames >= 24)
            {
                var fullPath = Path.GetFullPath(_smokePath);
                Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);
                // raylib's Windows screenshot path is interpreted relative to the
                // process directory even when it contains a drive prefix.
                var raylibPath = Path.GetRelativePath(Environment.CurrentDirectory, fullPath)
                    .Replace('\\', '/');
                Raylib.TakeScreenshot(raylibPath);
                _exitRequested = true;
            }
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _mapRenderer?.Dispose();
        _entityRenderer?.Dispose();
        _zombiesRenderer?.Dispose();
        _weaponRenderer?.Dispose();
        _pendingOnline?.Dispose();
        _session?.Dispose();
        _font?.Dispose();
        _audio?.Dispose();
        _imeGuard?.Dispose();
        if (_logoLoaded) Raylib.UnloadTexture(_logoTexture);
        ProfileStore.Save(_profile);
        if (Raylib.IsWindowReady()) Raylib.CloseWindow();
        _disposed = true;
        GC.SuppressFinalize(this);
    }

    private void Update(double frameTime)
    {
        if (_screen == AppScreen.Playing &&
            (Raylib.IsKeyPressed(KeyboardKey.LeftSuper) || Raylib.IsKeyPressed(KeyboardKey.RightSuper)))
        {
            Raylib.EnableCursor();
            _screen = AppScreen.Paused;
            return;
        }
        if ((Raylib.IsKeyDown(KeyboardKey.LeftAlt) || Raylib.IsKeyDown(KeyboardKey.RightAlt)) &&
            Raylib.IsKeyPressed(KeyboardKey.Tab))
        {
            Raylib.EnableCursor();
            Raylib.MinimizeWindow();
            if (_screen == AppScreen.Playing) _screen = AppScreen.Paused;
            return;
        }
        if (Raylib.IsKeyPressed(KeyboardKey.F11)) ToggleDisplayMode();
        if (Raylib.IsKeyPressed(KeyboardKey.F5) &&
            _screen is AppScreen.Playing or AppScreen.Paused &&
            _session?.Kind == NativeSessionKind.Campaign)
        {
            QuickSaveCampaign();
            return;
        }
        if (Raylib.IsKeyPressed(KeyboardKey.F9) &&
            _screen is AppScreen.Main or AppScreen.Campaign or AppScreen.Playing or AppScreen.Paused)
        {
            QuickLoadCampaign();
            return;
        }
        _audio?.Update();
        switch (_screen)
        {
            case AppScreen.Main:
                UpdateMainMenu();
                break;
            case AppScreen.Campaign:
                UpdateCampaignMenu();
                break;
            case AppScreen.Zombies:
                UpdateZombiesMenu();
                break;
            case AppScreen.Online:
                UpdateOnlineMenu();
                break;
            case AppScreen.Connecting:
                UpdateConnecting(frameTime);
                break;
            case AppScreen.Skirmish:
                UpdateSkirmishMenu();
                break;
            case AppScreen.Controls:
                UpdateControlsMenu();
                break;
            case AppScreen.Loadout:
                UpdateLoadoutMenu();
                break;
            case AppScreen.Settings:
                UpdateSettingsMenu();
                break;
            case AppScreen.Playing:
                UpdatePlaying(frameTime);
                break;
            case AppScreen.Paused:
                UpdatePauseMenu();
                break;
            case AppScreen.Results:
                UpdateResults();
                break;
        }
    }

    private void EnterBorderlessFullscreen()
    {
        var monitor = Raylib.GetCurrentMonitor();
        var position = Raylib.GetMonitorPosition(monitor);
        Raylib.ClearWindowState(ConfigFlags.FullscreenMode | ConfigFlags.BorderlessWindowMode);
        Raylib.SetWindowState(ConfigFlags.UndecoratedWindow);
        Raylib.SetWindowMonitor(monitor);
        Raylib.SetWindowPosition((int)position.X, (int)position.Y);
        Raylib.SetWindowSize(Raylib.GetMonitorWidth(monitor), Raylib.GetMonitorHeight(monitor));
        _borderlessFullscreen = true;
    }

    private void ToggleDisplayMode()
    {
        if (!_borderlessFullscreen)
        {
            EnterBorderlessFullscreen();
            return;
        }

        Raylib.ClearWindowState(ConfigFlags.UndecoratedWindow | ConfigFlags.MaximizedWindow);
        var monitor = Raylib.GetCurrentMonitor();
        const int width = 1600;
        const int height = 900;
        var position = Raylib.GetMonitorPosition(monitor);
        Raylib.SetWindowSize(width, height);
        Raylib.SetWindowPosition(
            (int)position.X + Math.Max(0, (Raylib.GetMonitorWidth(monitor) - width) / 2),
            (int)position.Y + Math.Max(0, (Raylib.GetMonitorHeight(monitor) - height) / 2));
        _borderlessFullscreen = false;
    }

    private void UpdateMainMenu()
    {
        const int itemCount = 8;
        var left = Math.Max(70, Raylib.GetScreenWidth() / 12);
        var mouseAction = UpdateMouseRows(ref _mainSelection, left, Raylib.GetScreenHeight() * .44f,
            330, 58, itemCount);
        if (Raylib.IsKeyPressed(KeyboardKey.Down) || Raylib.IsKeyPressed(KeyboardKey.S))
        {
            _mainSelection = (_mainSelection + 1) % itemCount;
            _audio?.Play(Cue.UiMove);
        }
        if (Raylib.IsKeyPressed(KeyboardKey.Up) || Raylib.IsKeyPressed(KeyboardKey.W))
        {
            _mainSelection = (_mainSelection + itemCount - 1) % itemCount;
            _audio?.Play(Cue.UiMove);
        }
        if (Raylib.IsKeyPressed(KeyboardKey.Enter) || Raylib.IsKeyPressed(KeyboardKey.Space) || mouseAction > 0)
        {
            _audio?.Play(Cue.UiAccept);
            ActivateMainSelection();
        }
    }

    private void ActivateMainSelection()
    {
        switch (_mainSelection)
        {
            case 0: _screen = AppScreen.Skirmish; break;
            case 1: _screen = AppScreen.Campaign; break;
            case 2: _screen = AppScreen.Zombies; break;
            case 3: _screen = AppScreen.Online; break;
            case 4: _screen = AppScreen.Loadout; break;
            case 5: _screen = AppScreen.Settings; break;
            case 6: _screen = AppScreen.Controls; break;
            case 7: _exitRequested = true; break;
        }
    }

    private void UpdateOnlineMenu()
    {
        const int fields = 4;
        var left = Math.Max(65, Raylib.GetScreenWidth() / 11);
        var mouseAction = UpdateMouseRows(ref _onlineField, left, 212, Math.Min(650, Raylib.GetScreenWidth() / 2f),
            74, fields, -10, 48);
        if (Raylib.IsKeyPressed(KeyboardKey.Down) ||
            _onlineField >= 2 && Raylib.IsKeyPressed(KeyboardKey.S))
        {
            _onlineField = Wrap(_onlineField + 1, fields);
            _audio?.Play(Cue.UiMove);
        }
        if (Raylib.IsKeyPressed(KeyboardKey.Up) ||
            _onlineField >= 2 && Raylib.IsKeyPressed(KeyboardKey.W))
        {
            _onlineField = Wrap(_onlineField - 1, fields);
            _audio?.Play(Cue.UiMove);
        }

        if (_onlineField is 0 or 1)
        {
            var character = Raylib.GetCharPressed();
            while (character > 0)
            {
                if (_onlineField == 0 && character is >= 32 and <= char.MaxValue &&
                    !char.IsControl((char)character) && _profile.Name.Length < 20)
                    _profile.Name += (char)character;
                else if (_onlineField == 1 && character is >= 33 and <= 126 && _onlineUrl.Length < 200)
                    _onlineUrl += (char)character;
                character = Raylib.GetCharPressed();
            }
            if (Raylib.IsKeyPressed(KeyboardKey.Backspace))
            {
                if (_onlineField == 0 && _profile.Name.Length > 0) _profile.Name = _profile.Name[..^1];
                if (_onlineField == 1 && _onlineUrl.Length > 0) _onlineUrl = _onlineUrl[..^1];
            }
        }

        if (Raylib.IsKeyPressed(KeyboardKey.Escape))
        {
            ProfileStore.Save(_profile);
            _screen = AppScreen.Main;
            return;
        }
        if (!Raylib.IsKeyPressed(KeyboardKey.Enter) && mouseAction <= 0) return;
        _audio?.Play(Cue.UiAccept);
        if (_onlineField < 2)
        {
            _onlineField++;
            ProfileStore.Save(_profile);
            return;
        }
        if (_onlineField == 2) StartOnline(_onlineUrl);
        else _screen = AppScreen.Main;
    }

    private void UpdateConnecting(double frameTime)
    {
        if (_pendingOnline is null)
        {
            _screen = AppScreen.Online;
            return;
        }
        var cancelClicked = Raylib.IsMouseButtonPressed(MouseButton.Left) &&
            Raylib.CheckCollisionPointRec(Raylib.GetMousePosition(),
                new Rectangle(Raylib.GetScreenWidth() / 2f - 120, Raylib.GetScreenHeight() - 90, 240, 52));
        if (Raylib.IsKeyPressed(KeyboardKey.Escape) || cancelClicked)
        {
            _pendingOnline.Dispose();
            _pendingOnline = null;
            _onlineMessage = "已取消連線";
            _screen = AppScreen.Online;
            return;
        }

        _onlineElapsed += frameTime;
        try
        {
            _pendingOnline.PumpNetwork();
        }
        catch (Exception exception) when (exception is InvalidDataException or InvalidOperationException)
        {
            FailOnline(exception.Message);
            return;
        }

        if (_pendingOnline.Status is NetStatus.Rejected or NetStatus.Disconnected)
        {
            FailOnline(string.IsNullOrWhiteSpace(_pendingOnline.StatusDetail)
                ? "無法連線到伺服器"
                : _pendingOnline.StatusDetail);
            return;
        }

        if (_pendingOnline.Welcome is { } welcome &&
            (welcome.MapId != _pendingOnline.Map.Id || welcome.ModeId != _pendingOnline.Mode.Id))
        {
            if (_onlineReconfigured || !Maps.Ids.Contains(welcome.MapId, StringComparer.Ordinal) ||
                !ModeData.MultiplayerModeIds.Contains(welcome.ModeId, StringComparer.Ordinal))
            {
                FailOnline($"伺服器回傳不支援的對戰：{welcome.MapId} / {welcome.ModeId}");
                return;
            }

            _pendingOnline.Dispose();
            _onlineReconfigured = true;
            _onlineElapsed = 0;
            _pendingOnline = CreateOnlineSession(_onlineUrl, welcome.MapId, welcome.ModeId, welcome.Seed);
            _onlineMessage = $"同步伺服器設定：{Maps.Get(welcome.MapId).Name} / {ModeData.GetMode(welcome.ModeId).Name}";
            return;
        }

        if (_pendingOnline.IsReady)
        {
            var ready = _pendingOnline;
            _pendingOnline = null;
            _profile.LastMatch.MapId = ready.Map.Id;
            _profile.LastMatch.ModeId = ready.Mode.Id;
            ProfileStore.Save(_profile);
            BeginSession(new NativeSession(ready), ready.Player?.Yaw ?? 0);
            return;
        }

        if (_onlineElapsed >= 15)
            FailOnline("連線逾時；請確認伺服器正在執行");
    }

    private void UpdateZombiesMenu()
    {
        const int fields = 4;
        var left = Math.Max(65, Raylib.GetScreenWidth() / 11);
        var mouseAction = UpdateMouseRows(ref _zombiesField, left, 207, 455, 67, fields, -9, 43);
        if (Raylib.IsKeyPressed(KeyboardKey.Down) || Raylib.IsKeyPressed(KeyboardKey.S))
        {
            _zombiesField = Wrap(_zombiesField + 1, fields);
            _audio?.Play(Cue.UiMove);
        }
        if (Raylib.IsKeyPressed(KeyboardKey.Up) || Raylib.IsKeyPressed(KeyboardKey.W))
        {
            _zombiesField = Wrap(_zombiesField - 1, fields);
            _audio?.Play(Cue.UiMove);
        }
        var direction = 0;
        if (Raylib.IsKeyPressed(KeyboardKey.Left) || Raylib.IsKeyPressed(KeyboardKey.A)) direction = -1;
        if (Raylib.IsKeyPressed(KeyboardKey.Right) || Raylib.IsKeyPressed(KeyboardKey.D)) direction = 1;
        if (direction != 0) AdjustZombies(direction);
        if (Raylib.IsKeyPressed(KeyboardKey.Escape) || Raylib.IsKeyPressed(KeyboardKey.Backspace))
            _screen = AppScreen.Main;
        if (!Raylib.IsKeyPressed(KeyboardKey.Enter) && !Raylib.IsKeyPressed(KeyboardKey.Space) &&
            mouseAction == 0) return;
        _audio?.Play(Cue.UiAccept);
        if (_zombiesField == 2) StartZombies();
        else if (_zombiesField == 3) _screen = AppScreen.Main;
        else AdjustZombies(mouseAction < 0 ? -1 : 1);
    }

    private void AdjustZombies(int direction)
    {
        if (_zombiesField == 0) _zombieBotCount = Math.Clamp(_zombieBotCount + direction, 0, 3);
        if (_zombiesField == 1)
            _difficultySelection = Wrap(_difficultySelection + direction, BotData.DifficultyIds.Count);
        _audio?.Play(Cue.UiMove);
    }

    private void UpdateLoadoutMenu()
    {
        const int visibleRows = 15;
        const float rowHeight = 39;
        const float top = 147;
        var left = Math.Max(42, Raylib.GetScreenWidth() / 20);
        var listWidth = Math.Min(650, Raylib.GetScreenWidth() * .51f);
        var mouseAction = 0;
        var mouse = Raylib.GetMousePosition();
        var rows = _loadoutEditor.Rows;
        var end = Math.Min(rows.Count, _loadoutEditor.Scroll + visibleRows);
        for (var index = _loadoutEditor.Scroll; index < end; index++)
        {
            var y = top + (index - _loadoutEditor.Scroll) * rowHeight;
            if (!Raylib.CheckCollisionPointRec(mouse, new Rectangle(left - 11, y - 7, listWidth, 32))) continue;
            if (_loadoutEditor.Selection != index) _audio?.Play(Cue.UiMove);
            _loadoutEditor.Select(index, visibleRows);
            if (Raylib.IsMouseButtonPressed(MouseButton.Left)) mouseAction = 1;
            if (Raylib.IsMouseButtonPressed(MouseButton.Right)) mouseAction = -1;
            break;
        }
        var wheel = Math.Sign(Raylib.GetMouseWheelMove());
        if (wheel != 0)
        {
            _loadoutEditor.Move(-wheel, visibleRows);
            _audio?.Play(Cue.UiMove);
        }
        if (Raylib.IsKeyPressed(KeyboardKey.Down) || Raylib.IsKeyPressed(KeyboardKey.S))
        {
            _loadoutEditor.Move(1, visibleRows);
            _audio?.Play(Cue.UiMove);
        }
        if (Raylib.IsKeyPressed(KeyboardKey.Up) || Raylib.IsKeyPressed(KeyboardKey.W))
        {
            _loadoutEditor.Move(-1, visibleRows);
            _audio?.Play(Cue.UiMove);
        }
        var direction = 0;
        if (Raylib.IsKeyPressed(KeyboardKey.Left) || Raylib.IsKeyPressed(KeyboardKey.A)) direction = -1;
        if (Raylib.IsKeyPressed(KeyboardKey.Right) || Raylib.IsKeyPressed(KeyboardKey.D) ||
            Raylib.IsKeyPressed(KeyboardKey.Enter) || Raylib.IsKeyPressed(KeyboardKey.Space)) direction = 1;
        if (mouseAction != 0) direction = mouseAction;
        if (direction != 0)
        {
            if (_loadoutEditor.Adjust(direction))
            {
                ProfileStore.Save(_profile);
                _audio?.Play(Cue.UiAccept);
            }
            else _audio?.Play(Cue.UiMove, .6f, .7f);
        }
        if (Raylib.IsKeyPressed(KeyboardKey.Escape) || Raylib.IsKeyPressed(KeyboardKey.Backspace))
        {
            ProfileStore.Save(_profile);
            _screen = AppScreen.Main;
        }
    }

    private void UpdateSettingsMenu()
    {
        const int count = 17;
        var left = Math.Max(55, Raylib.GetScreenWidth() / 10);
        var panelWidth = Math.Min(680, Raylib.GetScreenWidth() - left * 2);
        var mouseAction = UpdateMouseRows(ref _settingsSelection, left, 151, panelWidth, 37, count, -6, 30);
        if (Raylib.IsKeyPressed(KeyboardKey.Down) || Raylib.IsKeyPressed(KeyboardKey.S))
        {
            _settingsSelection = Wrap(_settingsSelection + 1, count);
            _audio?.Play(Cue.UiMove);
        }
        if (Raylib.IsKeyPressed(KeyboardKey.Up) || Raylib.IsKeyPressed(KeyboardKey.W))
        {
            _settingsSelection = Wrap(_settingsSelection - 1, count);
            _audio?.Play(Cue.UiMove);
        }
        var direction = 0;
        if (Raylib.IsKeyPressed(KeyboardKey.Left) || Raylib.IsKeyPressed(KeyboardKey.A)) direction = -1;
        if (Raylib.IsKeyPressed(KeyboardKey.Right) || Raylib.IsKeyPressed(KeyboardKey.D) ||
            Raylib.IsKeyPressed(KeyboardKey.Enter) || Raylib.IsKeyPressed(KeyboardKey.Space)) direction = 1;
        if (mouseAction != 0) direction = mouseAction;
        if (direction != 0) AdjustSetting(direction);
        if (Raylib.IsKeyPressed(KeyboardKey.Escape) || Raylib.IsKeyPressed(KeyboardKey.Backspace))
        {
            ProfileStore.Save(_profile);
            _screen = AppScreen.Main;
        }
    }

    private void AdjustSetting(int direction)
    {
        var settings = _profile.Settings;
        switch (_settingsSelection)
        {
            case 0: settings.FieldOfView = Math.Clamp(settings.FieldOfView + direction * 5, 65, 120); break;
            case 1: settings.MouseSensitivity = Math.Clamp(settings.MouseSensitivity + direction * .1, .1, 4); break;
            case 2: settings.AdsSensitivityScale = Math.Clamp(settings.AdsSensitivityScale + direction * .05, .2, 1.5); break;
            case 3: settings.InvertY = !settings.InvertY; break;
            case 4: settings.AutoSprint = !settings.AutoSprint; break;
            case 5: settings.ShowFps = !settings.ShowFps; break;
            case 6: settings.ShowCrosshair = !settings.ShowCrosshair; break;
            case 7: settings.ShowMinimap = !settings.ShowMinimap; break;
            case 8: settings.HudScale = Math.Clamp(settings.HudScale + direction * .05, .75, 1.5); break;
            case 9: settings.MasterVolume = Math.Clamp(settings.MasterVolume + direction * .05, 0, 1); break;
            case 10: settings.SfxVolume = Math.Clamp(settings.SfxVolume + direction * .05, 0, 1); break;
            case 11: settings.MusicVolume = Math.Clamp(settings.MusicVolume + direction * .05, 0, 1); break;
            case 12: settings.ToggleAds = !settings.ToggleAds; break;
            case 13: settings.ToggleCrouch = !settings.ToggleCrouch; break;
            case 14: settings.GamepadDeadzone = Math.Clamp(settings.GamepadDeadzone + direction * .01, 0, .5); break;
            case 15: settings.GamepadSensitivity = Math.Clamp(settings.GamepadSensitivity + direction * .1, .1, 8); break;
            case 16: settings.AimAssist = Math.Clamp(settings.AimAssist + direction * .05, 0, 1); break;
        }
        ApplyRuntimeSettings();
        ProfileStore.Save(_profile);
        _audio?.Play(Cue.UiAccept, .7f);
    }

    private void ApplyRuntimeSettings()
    {
        _input.Sensitivity = _profile.Settings.MouseSensitivity;
        _input.AdsSensitivityScale = _profile.Settings.AdsSensitivityScale;
        _input.InvertY = _profile.Settings.InvertY;
        _input.AutoSprint = _profile.Settings.AutoSprint;
        _input.ToggleAds = _profile.Settings.ToggleAds;
        _input.ToggleCrouch = _profile.Settings.ToggleCrouch;
        _input.GamepadDeadzone = _profile.Settings.GamepadDeadzone;
        _input.GamepadSensitivity = _profile.Settings.GamepadSensitivity;
        _input.SetBindings(_profile.Settings.Bindings);
        if (_audio is not null)
        {
            _audio.MasterVolume = (float)_profile.Settings.MasterVolume;
            _audio.SfxVolume = (float)_profile.Settings.SfxVolume;
            _audio.MusicVolume = (float)_profile.Settings.MusicVolume;
        }
    }

    private void UpdateSkirmishMenu()
    {
        const int fields = 6;
        var left = Math.Max(55, Raylib.GetScreenWidth() / 12);
        const float top = 182;
        const float rowHeight = 66;
        var mouseAction = UpdateMouseRows(ref _skirmishField, left, 182,
            Math.Min(505, Raylib.GetScreenWidth() / 2f - left), 66, fields, -10, 46);
        var mouse = Raylib.GetMousePosition();
        var startClicked = Raylib.IsMouseButtonPressed(MouseButton.Left) &&
            Raylib.CheckCollisionPointRec(mouse,
                new Rectangle(left - 13, top + 4 * rowHeight - 12, 540, 58));
        var backClicked = Raylib.IsMouseButtonPressed(MouseButton.Left) &&
            Raylib.CheckCollisionPointRec(mouse,
                new Rectangle(left - 13, top + 5 * rowHeight - 12, 540, 58));
        var footerBackClicked = Raylib.IsMouseButtonPressed(MouseButton.Left) &&
            Raylib.CheckCollisionPointRec(mouse,
                new Rectangle(left - 13, Raylib.GetScreenHeight() - 64, 190, 56));
        var footerConfirmClicked = Raylib.IsMouseButtonPressed(MouseButton.Left) &&
            Raylib.CheckCollisionPointRec(mouse,
                new Rectangle(Raylib.GetScreenWidth() - 390, Raylib.GetScreenHeight() - 64, 372, 56));
        if (startClicked)
        {
            _skirmishField = 4;
            _audio?.Play(Cue.UiAccept);
            StartSkirmish();
            return;
        }
        if (backClicked || footerBackClicked)
        {
            _skirmishField = 5;
            _audio?.Play(Cue.UiMove);
            _screen = AppScreen.Main;
            return;
        }
        if (Raylib.IsKeyPressed(KeyboardKey.Down) || Raylib.IsKeyPressed(KeyboardKey.S))
        {
            _skirmishField = (_skirmishField + 1) % fields;
            _audio?.Play(Cue.UiMove);
        }
        if (Raylib.IsKeyPressed(KeyboardKey.Up) || Raylib.IsKeyPressed(KeyboardKey.W))
        {
            _skirmishField = (_skirmishField + fields - 1) % fields;
            _audio?.Play(Cue.UiMove);
        }
        if (Raylib.IsKeyPressed(KeyboardKey.Left) || Raylib.IsKeyPressed(KeyboardKey.A))
            AdjustSkirmish(-1);
        if (Raylib.IsKeyPressed(KeyboardKey.Right) || Raylib.IsKeyPressed(KeyboardKey.D))
            AdjustSkirmish(1);
        if (Raylib.IsKeyPressed(KeyboardKey.Escape) || Raylib.IsKeyPressed(KeyboardKey.Backspace))
            _screen = AppScreen.Main;
        if (!Raylib.IsKeyPressed(KeyboardKey.Enter) && !Raylib.IsKeyPressed(KeyboardKey.Space) &&
            mouseAction == 0 && !footerConfirmClicked) return;
        _audio?.Play(Cue.UiAccept);
        if (_skirmishField == 4) StartSkirmish();
        else if (_skirmishField == 5) _screen = AppScreen.Main;
        else AdjustSkirmish(mouseAction < 0 ? -1 : 1);
    }

    private void AdjustSkirmish(int direction)
    {
        switch (_skirmishField)
        {
            case 0:
                _mapSelection = Wrap(_mapSelection + direction, Maps.Ids.Count);
                break;
            case 1:
                _modeSelection = Wrap(_modeSelection + direction, ModeData.MultiplayerModeIds.Count);
                break;
            case 2:
                _botCount = Math.Clamp(_botCount + direction, 0, 17);
                break;
            case 3:
                _difficultySelection = Wrap(_difficultySelection + direction, BotData.DifficultyIds.Count);
                break;
        }
        _audio?.Play(Cue.UiMove);
    }

    private void UpdateCampaignMenu()
    {
        var count = CampaignCatalog.CampaignMissions.Count;
        var left = Math.Max(45, Raylib.GetScreenWidth() / 15);
        var listTop = 174f;
        var rowHeight = Math.Min(72f, (Raylib.GetScreenHeight() - listTop - 55f) / 6f);
        var mouseAction = UpdateMouseRows(ref _missionSelection, left, listTop,
            Raylib.GetScreenWidth() * .47f, rowHeight, count, -5, rowHeight - 5);
        var mouse = Raylib.GetMousePosition();
        var backClicked = Raylib.IsMouseButtonPressed(MouseButton.Left) &&
            Raylib.CheckCollisionPointRec(mouse,
                new Rectangle(left - 12, Raylib.GetScreenHeight() - 64, 190, 56));
        var startClicked = Raylib.IsMouseButtonPressed(MouseButton.Left) &&
            Raylib.CheckCollisionPointRec(mouse,
                new Rectangle(Raylib.GetScreenWidth() - 300, Raylib.GetScreenHeight() - 64, 282, 56));
        if (Raylib.IsKeyPressed(KeyboardKey.Down) || Raylib.IsKeyPressed(KeyboardKey.S))
        {
            _missionSelection = (_missionSelection + 1) % count;
            _audio?.Play(Cue.UiMove);
        }
        if (Raylib.IsKeyPressed(KeyboardKey.Up) || Raylib.IsKeyPressed(KeyboardKey.W))
        {
            _missionSelection = (_missionSelection + count - 1) % count;
            _audio?.Play(Cue.UiMove);
        }
        if (Raylib.IsKeyPressed(KeyboardKey.Escape) || Raylib.IsKeyPressed(KeyboardKey.Backspace) || backClicked)
        {
            _screen = AppScreen.Main;
            _audio?.Play(Cue.UiMove);
            return;
        }
        if (Raylib.IsKeyPressed(KeyboardKey.Enter) || Raylib.IsKeyPressed(KeyboardKey.Space) ||
            mouseAction > 0 || startClicked)
        {
            _profile.LastMatch.MissionId = CampaignCatalog.MissionIds[_missionSelection];
            ProfileStore.Save(_profile);
            StartMission(CampaignCatalog.CampaignMissions[_missionSelection]);
        }
    }

    private void UpdateControlsMenu()
    {
        if (_capturingAction is not null)
        {
            if (Raylib.IsKeyPressed(KeyboardKey.Escape))
            {
                _capturingAction = null;
                _audio?.Play(Cue.UiMove, .65f);
                return;
            }

            var code = CapturePressedInputCode();
            if (code is null) return;
            InputBindingCatalog.Assign(_profile.Settings.Bindings, _capturingAction, _controlsSlot, code);
            _capturingAction = null;
            ApplyRuntimeSettings();
            ProfileStore.Save(_profile);
            _audio?.Play(Cue.UiAccept);
            return;
        }

        var actionCount = InputBindingCatalog.All.Count;
        var itemCount = actionCount + 2;
        var screenWidth = Raylib.GetScreenWidth();
        var screenHeight = Raylib.GetScreenHeight();
        var left = Math.Max(55, screenWidth / 10);
        var visibleRows = Math.Clamp((screenHeight - 330) / 40, 6, actionCount);
        var listWidth = Math.Min(820, screenWidth - left * 2 - 270);
        var slotWidth = Math.Clamp(listWidth * .25f, 125, 210);
        var primaryX = left + listWidth - slotWidth * 2 - 18;
        var alternateX = left + listWidth - slotWidth;
        var mouse = Raylib.GetMousePosition();
        var end = Math.Min(actionCount, _controlsScroll + visibleRows);
        for (var index = _controlsScroll; index < end; index++)
        {
            var y = 171 + (index - _controlsScroll) * 40;
            if (!Raylib.CheckCollisionPointRec(mouse, new Rectangle(left - 12, y - 5, listWidth, 31))) continue;
            if (_controlsSelection != index)
            {
                _controlsSelection = index;
                _audio?.Play(Cue.UiMove);
            }
            if (Raylib.CheckCollisionPointRec(mouse, new Rectangle(primaryX, y - 6, slotWidth - 8, 29)))
                _controlsSlot = 0;
            else if (Raylib.CheckCollisionPointRec(mouse,
                         new Rectangle(alternateX, y - 6, slotWidth - 8, 29)))
                _controlsSlot = 1;
            if (Raylib.IsMouseButtonPressed(MouseButton.Left) && mouse.X >= primaryX)
            {
                _capturingAction = InputBindingCatalog.All[index].Action;
                _audio?.Play(Cue.UiAccept);
                return;
            }
            break;
        }

        var resetBounds = new Rectangle(left - 13, screenHeight - 114, 273, 43);
        var backBounds = new Rectangle(left + 272, screenHeight - 114, 193, 43);
        if (Raylib.CheckCollisionPointRec(mouse, resetBounds)) _controlsSelection = actionCount;
        if (Raylib.CheckCollisionPointRec(mouse, backBounds)) _controlsSelection = actionCount + 1;
        if (Raylib.IsMouseButtonPressed(MouseButton.Left) && _controlsSelection >= actionCount)
        {
            _audio?.Play(Cue.UiAccept);
            if (_controlsSelection == actionCount)
            {
                InputBindingCatalog.Reset(_profile.Settings.Bindings);
                ApplyRuntimeSettings();
                ProfileStore.Save(_profile);
            }
            else
            {
                ProfileStore.Save(_profile);
                _screen = AppScreen.Main;
            }
            return;
        }
        var wheel = Math.Sign(Raylib.GetMouseWheelMove());
        if (wheel != 0)
        {
            _controlsSelection = Wrap(_controlsSelection - wheel, itemCount);
            _audio?.Play(Cue.UiMove);
        }
        if (Raylib.IsKeyPressed(KeyboardKey.Down) || Raylib.IsKeyPressed(KeyboardKey.S))
        {
            _controlsSelection = Wrap(_controlsSelection + 1, itemCount);
            _audio?.Play(Cue.UiMove);
        }
        if (Raylib.IsKeyPressed(KeyboardKey.Up) || Raylib.IsKeyPressed(KeyboardKey.W))
        {
            _controlsSelection = Wrap(_controlsSelection - 1, itemCount);
            _audio?.Play(Cue.UiMove);
        }
        if (_controlsSelection < actionCount)
        {
            if (Raylib.IsKeyPressed(KeyboardKey.Left) || Raylib.IsKeyPressed(KeyboardKey.A))
            {
                _controlsSlot = 0;
                _audio?.Play(Cue.UiMove);
            }
            if (Raylib.IsKeyPressed(KeyboardKey.Right) || Raylib.IsKeyPressed(KeyboardKey.D))
            {
                _controlsSlot = 1;
                _audio?.Play(Cue.UiMove);
            }
        }

        if (Raylib.IsKeyPressed(KeyboardKey.Escape) || Raylib.IsKeyPressed(KeyboardKey.Backspace))
        {
            ProfileStore.Save(_profile);
            _screen = AppScreen.Main;
            return;
        }
        if (!Raylib.IsKeyPressed(KeyboardKey.Enter) && !Raylib.IsKeyPressed(KeyboardKey.Space)) return;

        _audio?.Play(Cue.UiAccept);
        if (_controlsSelection < actionCount)
        {
            _capturingAction = InputBindingCatalog.All[_controlsSelection].Action;
            return;
        }
        if (_controlsSelection == actionCount)
        {
            InputBindingCatalog.Reset(_profile.Settings.Bindings);
            ApplyRuntimeSettings();
            ProfileStore.Save(_profile);
            return;
        }

        ProfileStore.Save(_profile);
        _screen = AppScreen.Main;
    }

    private static string? CapturePressedInputCode()
    {
        foreach (var button in Enum.GetValues<MouseButton>())
        {
            if (Raylib.IsMouseButtonPressed(button))
                return InputBindingCatalog.CodeForMouseButton(button);
        }
        foreach (var key in Enum.GetValues<KeyboardKey>())
        {
            if (key != KeyboardKey.Null && key != KeyboardKey.Escape && Raylib.IsKeyPressed(key))
                return InputBindingCatalog.CodeForKey(key);
        }
        return null;
    }

    private void UpdatePlaying(double frameTime)
    {
        if (_session is null) return;
        if (_smokePath is null && !Raylib.IsWindowFocused())
        {
            Raylib.EnableCursor();
            _screen = AppScreen.Paused;
            return;
        }
        if (_input.IsActionPressed(InputActions.Pause))
        {
            Raylib.EnableCursor();
            _screen = AppScreen.Paused;
            return;
        }

        _input.PollFrame();
        _accumulator = Math.Min(_accumulator + frameTime, TickDelta * 8d);
        while (_accumulator >= TickDelta)
        {
            var command = _input.BuildCommand(TickDelta, _session.Player.AdsProgress, _session.World.Tick + 1);
            _session.Tick(command, TickDelta);
            _minimapRenderer?.Observe(_session.LastEvents, _session.World, _session.Player);
            _effectsRenderer.Observe(_session.LastEvents, _session.World, _session.Player.Id);
            _weaponRenderer?.Observe(_session.LastEvents, _session.Player.Id);
            PlayTickAudio(_session);
            ObservePresentationEvents(_session);
            if (_session.LastInteraction is { } interaction)
            {
                _announcement = interaction.Message;
                _announcementTime = 2.25;
                _audio?.Play(interaction.Ok ? Cue.UiAccept : Cue.UiMove, .75f,
                    interaction.Ok ? 1.05f : .72f);
            }
            _accumulator -= TickDelta;
        }
        if (_session.Kind == NativeSessionKind.Online &&
            _session.NetworkStatus is NetStatus.Rejected or NetStatus.Disconnected)
        {
            _onlineMessage = string.IsNullOrWhiteSpace(_session.NetworkStatusDetail)
                ? "與伺服器的連線已中斷"
                : _session.NetworkStatusDetail;
            RecordAbandonedSession();
            _session.Dispose();
            _session = null;
            DisposeWorldPresentation();
            Raylib.EnableCursor();
            _screen = AppScreen.Online;
            return;
        }
        _eyeHeight = Movement.SmoothedEyeHeight(_session.Player, _eyeHeight, frameTime);
        if (_weaponRenderer is not null)
        {
            _weaponRenderer.Visible = _session.Player.Alive;
            _weaponRenderer.Update(
                _session.Player,
                _session.Simulation.ActiveWeaponDef(_session.Player),
                frameTime);
        }
        UpdateCrosshair(_session, frameTime);
        _minimapRenderer?.Update(frameTime);
        _effectsRenderer.Update(frameTime);
        AdvancePresentation(frameTime);
        if (_session.Kind == NativeSessionKind.Campaign && _session.IsComplete)
        {
            RecordMissionResult();
            _missionEndDelay += frameTime;
            if (_missionEndDelay >= 2.5)
            {
                Raylib.EnableCursor();
                _screen = AppScreen.Results;
            }
        }
        else if (_session.Kind == NativeSessionKind.Zombies && _session.IsComplete)
        {
            RecordZombiesResult();
            _missionEndDelay += frameTime;
            if (_missionEndDelay >= 2.5)
            {
                Raylib.EnableCursor();
                _screen = AppScreen.Results;
            }
        }
        else if (_session.Kind is NativeSessionKind.Skirmish or NativeSessionKind.Online && _session.IsComplete)
        {
            RecordSkirmishResult();
            _missionEndDelay += frameTime;
            if (_missionEndDelay >= 2.5)
            {
                Raylib.EnableCursor();
                _screen = AppScreen.Results;
            }
        }
    }

    private void UpdatePauseMenu()
    {
        var campaign = _session?.Kind == NativeSessionKind.Campaign;
        var itemCount = campaign ? 5 : 3;
        var panelWidth = Math.Min(520, Raylib.GetScreenWidth() - 80);
        var top = Raylib.GetScreenHeight() * (campaign ? .40f : .43f);
        var rowHeight = Raylib.GetScreenHeight() * (campaign ? .06f : .07f);
        var mouseAction = UpdateMouseRows(ref _pauseSelection,
            (Raylib.GetScreenWidth() - panelWidth) / 2f, top,
            panelWidth, rowHeight, itemCount, -10, 40);
        if (Raylib.IsKeyPressed(KeyboardKey.Down) || Raylib.IsKeyPressed(KeyboardKey.S))
        {
            _pauseSelection = Wrap(_pauseSelection + 1, itemCount);
            _audio?.Play(Cue.UiMove);
        }
        if (Raylib.IsKeyPressed(KeyboardKey.Up) || Raylib.IsKeyPressed(KeyboardKey.W))
        {
            _pauseSelection = Wrap(_pauseSelection - 1, itemCount);
            _audio?.Play(Cue.UiMove);
        }
        if (mouseAction > 0)
        {
            _audio?.Play(Cue.UiAccept);
            ActivatePauseSelection(campaign);
            return;
        }
        if (_input.IsActionPressed(InputActions.Pause) || Raylib.IsKeyPressed(KeyboardKey.Escape))
        {
            Resume();
            return;
        }
        if (Raylib.IsKeyPressed(KeyboardKey.Enter) || Raylib.IsKeyPressed(KeyboardKey.Space))
        {
            _audio?.Play(Cue.UiAccept);
            ActivatePauseSelection(campaign);
            return;
        }
        if (Raylib.IsKeyPressed(KeyboardKey.R) && _session is not null)
        {
            RestartCurrentSession();
            return;
        }
        if (Raylib.IsKeyPressed(KeyboardKey.Q) || Raylib.IsKeyPressed(KeyboardKey.Backspace))
            ReturnFromCurrentSession();
    }

    private void ActivatePauseSelection(bool campaign)
    {
        if (!campaign)
        {
            if (_pauseSelection == 0) Resume();
            else if (_pauseSelection == 1) RestartCurrentSession();
            else ReturnFromCurrentSession();
            return;
        }

        switch (_pauseSelection)
        {
            case 0: Resume(); break;
            case 1: QuickSaveCampaign(); break;
            case 2: QuickLoadCampaign(); break;
            case 3: RestartCurrentSession(); break;
            default: ReturnFromCurrentSession(); break;
        }
    }

    private void RestartCurrentSession()
    {
        if (_session is null) return;
        switch (_session.Kind)
        {
            case NativeSessionKind.Campaign when _session.Mission is not null: StartMission(_session.Mission); break;
            case NativeSessionKind.Zombies: StartZombies(); break;
            case NativeSessionKind.Online: StartOnline(_onlineUrl); break;
            default: StartSkirmish(); break;
        }
    }

    private void ReturnFromCurrentSession()
    {
        var returnTo = _session?.Kind switch
        {
            NativeSessionKind.Campaign => AppScreen.Campaign,
            NativeSessionKind.Zombies => AppScreen.Zombies,
            NativeSessionKind.Online => AppScreen.Online,
            _ => AppScreen.Skirmish,
        };
        RecordAbandonedSession();
        _session?.Dispose();
        _session = null;
        DisposeWorldPresentation();
        _screen = returnTo;
    }

    private void StartMission(MissionDef mission)
    {
        StartMission(mission, null);
    }

    private void StartMission(MissionDef mission, CampaignSaveSnapshot? save)
    {
        BeginSession(new NativeSession(
                new LocalSession(mission, _profile.Name, _profile.Loadouts[_profile.ActiveLoadout], save)),
            save?.Yaw ?? mission.Insertion.Yaw);
        if (save is not null) _input.SetViewAngles(save.Yaw, save.Pitch);
    }

    private bool QuickSaveCampaign()
    {
        var snapshot = _session?.CaptureCampaignSave();
        if (snapshot is null)
        {
            ShowSaveStatus("目前只能在戰役中快速存檔", false);
            return false;
        }

        var saved = CampaignSaveStore.Save(snapshot);
        _campaignSaveAvailable = saved;
        ShowSaveStatus(saved ? "快速存檔完成" : "快速存檔失敗", saved);
        return saved;
    }

    private bool QuickLoadCampaign()
    {
        var document = CampaignSaveStore.Load();
        if (document is null)
        {
            _campaignSaveAvailable = false;
            ShowSaveStatus("沒有可讀取的快速存檔", false);
            return false;
        }

        var index = CampaignCatalog.MissionIds.ToList().FindIndex(id => id == document.Snapshot.MissionId);
        if (index < 0)
        {
            ShowSaveStatus("快速存檔版本不相容", false);
            return false;
        }

        _campaignSaveAvailable = true;
        _missionSelection = index;
        _profile.LastMatch.MissionId = document.Snapshot.MissionId;
        ProfileStore.Save(_profile);
        StartMission(CampaignCatalog.CampaignMissions[index], document.Snapshot);
        ShowSaveStatus("快速讀檔完成", true);
        return true;
    }

    private void ShowSaveStatus(string message, bool accepted)
    {
        _announcement = message;
        _announcementTime = 3d;
        _audio?.Play(accepted ? Cue.UiAccept : Cue.UiMove, .8f, accepted ? 1.05f : .72f);
    }

    private void StartSkirmish()
    {
        var mapId = Maps.Ids[_mapSelection];
        var modeId = ModeData.MultiplayerModeIds[_modeSelection];
        var difficultyId = DifficultyIdFromIndex(_difficultySelection);
        _profile.LastMatch.MapId = mapId;
        _profile.LastMatch.ModeId = modeId;
        _profile.LastMatch.BotCount = _botCount;
        _profile.LastMatch.Difficulty = BotData.DifficultyIds[_difficultySelection];
        ProfileStore.Save(_profile);
        BeginSession(new NativeSession(new LocalSession(
            mapId, modeId, _botCount, difficultyId, _profile.Name,
            _profile.Loadouts[_profile.ActiveLoadout])), 0);
    }

    private void StartZombies()
    {
        var mapId = ZombieMaps.Ids[0];
        var difficultyId = DifficultyIdFromIndex(_difficultySelection);
        _profile.LastMatch.MapId = mapId;
        _profile.LastMatch.ModeId = ModeData.ZombiesModeId;
        _profile.LastMatch.BotCount = _zombieBotCount;
        _profile.LastMatch.Difficulty = BotData.DifficultyIds[_difficultySelection];
        ProfileStore.Save(_profile);
        BeginSession(new NativeSession(new ZombiesSession(
            mapId,
            _zombieBotCount,
            difficultyId,
            _profile.Name,
            _profile.Loadouts[_profile.ActiveLoadout])), 0);
    }

    private void StartOnline(string serverUrl)
    {
        serverUrl = serverUrl.Trim();
        if (!Uri.TryCreate(serverUrl, UriKind.Absolute, out var uri) ||
            (uri.Scheme != Uri.UriSchemeWs && uri.Scheme != Uri.UriSchemeWss))
        {
            _onlineMessage = "請輸入有效的 ws:// 或 wss:// 伺服器位址";
            _screen = AppScreen.Online;
            return;
        }

        EndCurrentSession();
        _pendingOnline?.Dispose();
        _pendingOnline = null;
        _onlineUrl = serverUrl;
        _profile.LastMatch.ServerUrl = serverUrl;
        _profile.LastMatch.Online = true;
        ProfileStore.Save(_profile);
        _onlineElapsed = 0;
        _onlineReconfigured = false;
        _onlineMessage = "正在建立安全的即時連線…";
        try
        {
            _pendingOnline = CreateOnlineSession(
                serverUrl,
                Maps.Ids[_mapSelection],
                ModeData.MultiplayerModeIds[_modeSelection],
                null);
            _screen = AppScreen.Connecting;
        }
        catch (Exception exception) when (exception is ArgumentException or InvalidOperationException)
        {
            _onlineMessage = exception.Message;
            _screen = AppScreen.Online;
        }
    }

    private OnlineSession CreateOnlineSession(string url, string mapId, string modeId, string? seed) =>
        new(new OnlineSessionOptions
        {
            ServerUrl = url,
            MapId = mapId,
            ModeId = modeId,
            Seed = seed,
            PlayerName = _profile.Name,
            Loadout = _profile.Loadouts[_profile.ActiveLoadout],
        });

    private void FailOnline(string message)
    {
        _pendingOnline?.Dispose();
        _pendingOnline = null;
        _onlineMessage = message;
        _audio?.Play(Cue.UiMove, .8f, .65f);
        _screen = AppScreen.Online;
    }

    private void BeginSession(NativeSession session, double yaw)
    {
        _session?.Dispose();
        _mapRenderer?.Dispose();
        _entityRenderer?.Dispose();
        _zombiesRenderer?.Dispose();
        _weaponRenderer?.Dispose();
        _effectsRenderer.Clear();
        _session = session;
        _mapRenderer = new MapRenderer();
        _entityRenderer = new EntityRenderer();
        _minimapRenderer = new MinimapRenderer();
        _zombiesRenderer = session.Kind == NativeSessionKind.Zombies ? new ZombiesWorldRenderer() : null;
        _weaponRenderer = new WeaponViewRenderer();
        _audio?.SetEnvironment(session.Map.Ambience);
        _input.Reset(yaw);
        _eyeHeight = GameConstants.EyeHeight.Stand;
        _accumulator = 0;
        _missionEndDelay = 0;
        _missionResultRecorded = false;
        _feed.Clear();
        _hitMarkerTime = 0;
        _damageOverlayTime = 0;
        _announcementTime = 0;
        _scorePopupTime = 0;
        _screen = AppScreen.Playing;
        Raylib.DisableCursor();
    }

    private void DisposeWorldPresentation()
    {
        _mapRenderer?.Dispose();
        _mapRenderer = null;
        _entityRenderer?.Dispose();
        _entityRenderer = null;
        _zombiesRenderer?.Dispose();
        _zombiesRenderer = null;
        _weaponRenderer?.Dispose();
        _weaponRenderer = null;
        _minimapRenderer = null;
        _effectsRenderer.Clear();
    }

    private void EndCurrentSession()
    {
        _session?.Dispose();
        _session = null;
        DisposeWorldPresentation();
        _accumulator = 0;
    }

    private void Resume()
    {
        if (_session is null) return;
        _input.Reset(_session.Player.Yaw, _session.Player.Pitch);
        _accumulator = 0;
        _screen = AppScreen.Playing;
        Raylib.DisableCursor();
    }

    private void UpdateResults()
    {
        if (_session is null)
        {
            _screen = AppScreen.Main;
            return;
        }
        var panelWidth = Math.Min(660, Raylib.GetScreenWidth() - 80);
        var mouseAction = UpdateMouseRows(ref _resultsSelection,
            (Raylib.GetScreenWidth() - panelWidth) / 2f, Raylib.GetScreenHeight() * .66f,
            panelWidth, Raylib.GetScreenHeight() * .05f, 2, -8, 34);
        if (Raylib.IsKeyPressed(KeyboardKey.Escape) || Raylib.IsKeyPressed(KeyboardKey.Backspace) ||
            mouseAction > 0 && _resultsSelection == 1)
        {
            var returnTo = _session.Kind switch
            {
                NativeSessionKind.Campaign => AppScreen.Campaign,
                NativeSessionKind.Zombies => AppScreen.Zombies,
                NativeSessionKind.Online => AppScreen.Online,
                _ => AppScreen.Skirmish,
            };
            EndCurrentSession();
            _screen = returnTo;
            return;
        }
        if (!Raylib.IsKeyPressed(KeyboardKey.Enter) && !Raylib.IsKeyPressed(KeyboardKey.Space) &&
            !(mouseAction > 0 && _resultsSelection == 0)) return;

        if (_session.Mission is null)
        {
            if (_session.Kind == NativeSessionKind.Zombies) StartZombies();
            else if (_session.Kind == NativeSessionKind.Online) StartOnline(_onlineUrl);
            else StartSkirmish();
            return;
        }

        var next = CampaignCatalog.NextMission(_session.Mission.Id);
        if (next is null)
        {
            EndCurrentSession();
            _screen = AppScreen.Campaign;
            return;
        }
        _missionSelection = CampaignCatalog.MissionIds.ToList().IndexOf(next.Id);
        _profile.LastMatch.MissionId = next.Id;
        ProfileStore.Save(_profile);
        StartMission(next);
    }

    private void Draw()
    {
        Raylib.BeginDrawing();
        Raylib.ClearBackground(Background);
        switch (_screen)
        {
            case AppScreen.Main: DrawMainMenu(); break;
            case AppScreen.Skirmish: DrawSkirmishMenu(); break;
            case AppScreen.Campaign: DrawCampaignMenu(); break;
            case AppScreen.Zombies: DrawZombiesMenu(); break;
            case AppScreen.Online: DrawOnlineMenu(); break;
            case AppScreen.Connecting: DrawConnecting(); break;
            case AppScreen.Controls: DrawControls(); break;
            case AppScreen.Loadout: DrawLoadoutMenu(); break;
            case AppScreen.Settings: DrawSettingsMenu(); break;
            case AppScreen.Playing: DrawWorld(false); break;
            case AppScreen.Paused: DrawWorld(true); break;
            case AppScreen.Results:
                DrawWorld(false);
                DrawResultsOverlay();
                break;
        }
        Raylib.EndDrawing();
    }

    private void DrawMainMenu()
    {
        DrawMenuBackdrop();
        var font = RequireFont();
        var width = Raylib.GetScreenWidth();
        var height = Raylib.GetScreenHeight();
        var left = Math.Max(70, width / 12);
        font.Draw("行動代號", left, height * 0.13f, 24, DimInk, 3);
        font.Draw("先鋒", left, height * 0.18f, Math.Clamp(height * 0.09f, 58, 90), Ink, 4);
        font.Draw("OPERATION VANGUARD", left + 4, height * 0.31f, 18, Accent, 4);
        font.Draw(".NET 10 native edition", left + 4, height * 0.35f, 15, DimInk, 1);

        if (_logoLoaded)
        {
            var panelWidth = Math.Max(420, width / 3);
            var logoSize = Math.Clamp(height * 0.47f, 280, 430);
            var logoLeft = width - panelWidth / 2f - logoSize / 2f;
            Raylib.DrawTexturePro(_logoTexture,
                new Rectangle(0, 0, _logoTexture.Width, _logoTexture.Height),
                new Rectangle(logoLeft, height * 0.18f, logoSize, logoSize),
                Vector2.Zero, 0, new Color(255, 255, 255, 255));
        }

        var items = new[] { "快速對戰", "開始戰役", "殭屍模式", "連線對戰", "配裝", "設定", "操作說明", "退出" };
        for (var index = 0; index < items.Length; index++)
            DrawMenuItem(items[index], left, height * 0.44f + index * 58, 330, index == _mainSelection);

        font.Draw("六個完整任務 · 程式生成地圖、模型與音效 · 64 Hz 決定性模擬",
            left, height - 60, 16, DimInk);
        font.Draw($"{_profile.Name} · 軍階 {_profile.Rank} · 生涯擊殺 {_profile.Stats.Kills}",
            width - 365, 38, 14, DimInk);
        font.Draw("滑鼠 / ↑↓ 選擇   左鍵 / ENTER 確認", width - 405, height - 46, 15, DimInk);
    }

    private void DrawCampaignMenu()
    {
        DrawMenuBackdrop();
        var font = RequireFont();
        var width = Raylib.GetScreenWidth();
        var height = Raylib.GetScreenHeight();
        var left = Math.Max(45, width / 15);
        font.Draw("戰役任務", left, 56, 40, Ink, 2);
        font.Draw("CAMPAIGN · 全六章", left + 3, 130, 15, Accent, 3);

        var listTop = 174f;
        var rowHeight = Math.Min(72f, (height - listTop - 55f) / 6f);
        for (var index = 0; index < CampaignCatalog.CampaignMissions.Count; index++)
        {
            var mission = CampaignCatalog.CampaignMissions[index];
            var selected = index == _missionSelection;
            var y = listTop + index * rowHeight;
            if (selected)
                Raylib.DrawRectangleRounded(new Rectangle(left - 12, y - 5, width * 0.47f, rowHeight - 5),
                    0.08f, 6, new Color(255, 122, 41, 35));
            font.Draw($"{index + 1:00}", left, y + 8, 19, selected ? Accent : DimInk, 2);
            font.Draw(mission.Name, left + 58, y, 22, selected ? Ink : new Color(175, 187, 195, 255));
            font.Draw(Maps.Get(mission.MapId).Name, left + 60, y + 41, 13, DimInk, 1);
            if (_profile.CompletedMissions.Contains(mission.Id))
                font.Draw("✓", left + width * .43f, y + 8, 20, new Color(86, 210, 126, 255));
        }

        var chosen = CampaignCatalog.CampaignMissions[_missionSelection];
        var panelX = width * 0.58f;
        var panelWidth = width - panelX - left;
        Raylib.DrawRectangleRounded(new Rectangle(panelX, 175, panelWidth, height - 248), 0.025f, 7, Panel);
        font.Draw($"第 {_missionSelection + 1} 章", panelX + 28, 203, 16, Accent, 2);
        font.Draw(chosen.Name, panelX + 28, 244, Math.Min(28, panelWidth / 14), Ink);
        font.Draw($"地點  {Maps.Get(chosen.MapId).Name}", panelX + 28, 305, 15, DimInk);
        font.Draw($"難度  {DifficultyName(chosen.Difficulty)}", panelX + 28, 339, 15, DimInk);
        DrawWrapped(chosen.Brief, panelX + 28, 394, panelWidth - 56, 20, 36, Ink);

        var pointer = Raylib.GetMousePosition();
        var backHovered = Raylib.CheckCollisionPointRec(pointer,
            new Rectangle(left - 12, height - 64, 190, 56));
        var startHovered = Raylib.CheckCollisionPointRec(pointer,
            new Rectangle(width - 300, height - 64, 282, 56));
        if (backHovered)
            Raylib.DrawRectangleRounded(new Rectangle(left - 12, height - 64, 190, 48), .15f, 6,
                new Color(255, 255, 255, 18));
        if (startHovered)
            Raylib.DrawRectangleRounded(new Rectangle(width - 300, height - 64, 282, 48), .15f, 6,
                new Color(255, 122, 41, 30));
        font.Draw("ENTER 開始任務", width - 275, height - 50, 15, startHovered ? Ink : Accent);
        font.Draw("ESC 返回", left, height - 50, 15, backHovered ? Ink : DimInk);
    }

    private void DrawZombiesMenu()
    {
        DrawMenuBackdrop();
        var font = RequireFont();
        var width = Raylib.GetScreenWidth();
        var height = Raylib.GetScreenHeight();
        var left = Math.Max(65, width / 11);
        var data = ZombieMaps.Get(ZombieMaps.Ids[0]);
        var map = Maps.Get(data.MapId);
        var difficulty = BotData.Difficulties[BotData.DifficultyIds[_difficultySelection]];
        font.Draw("殭屍模式", left, 58, 40, Ink, 2);
        font.Draw("ZOMBIES · 回合制合作生存", left + 3, 132, 15, Accent, 2);

        var labels = new[] { "合作隊友", "電腦兵難度", "開始生存", "返回" };
        var values = new[] { _zombieBotCount.ToString(CultureInfo.InvariantCulture), difficulty.Name, "ENTER", "ESC" };
        const float top = 207;
        const float rowHeight = 67;
        for (var index = 0; index < labels.Length; index++)
        {
            var y = top + index * rowHeight;
            var selected = index == _zombiesField;
            if (selected)
            {
                Raylib.DrawRectangle(left - 13, (int)y - 9, 4, 43, Accent);
                Raylib.DrawRectangleGradientH(left, (int)y - 9, 455, 43,
                    new Color(255, 122, 41, 34), new Color(255, 122, 41, 0));
            }
            font.Draw(labels[index], left + 8, y, 21, selected ? Ink : DimInk);
            font.Draw(index < 2 ? $"‹  {values[index]}  ›" : values[index], left + 250, y, 19,
                selected ? Accent : Ink);
        }

        var panelX = width * .56f;
        var panelWidth = width - panelX - left;
        Raylib.DrawRectangleRounded(new Rectangle(panelX, 184, panelWidth, Math.Min(470, height - 250)),
            .025f, 7, Panel);
        font.Draw(map.Name, panelX + 29, 218, 27, Ink);
        font.Draw("生存區域", panelX + 30, 278, 14, Accent, 2);
        DrawWrapped("抵擋不斷增強的屍潮，賺取點數、清除瓦礫、開啟電力，並利用牆上武器、神秘箱、特技販賣機與強化機活下去。",
            panelX + 29, 320, panelWidth - 58, 17, 32, DimInk);
        font.Draw($"起始點數  {data.StartingPoints}", panelX + 29, 448, 15, Ink);
        font.Draw($"區域  {data.Zones.Count}     互動點  {data.Interactables.Count}", panelX + 29, 482, 15, Ink);
        font.Draw("倒地的隊友可以救援；全隊倒下就會結束。", panelX + 29, 536, 14, DimInk);
        font.Draw("↑↓ 選擇   ←→ 調整   ENTER 確認", width - 355, height - 44, 15, DimInk);
        font.Draw("ESC 返回", left, height - 44, 15, Accent);
    }

    private void DrawOnlineMenu()
    {
        DrawMenuBackdrop();
        var font = RequireFont();
        var width = Raylib.GetScreenWidth();
        var height = Raylib.GetScreenHeight();
        var left = Math.Max(65, width / 11);
        font.Draw("連線對戰", left, 58, 40, Ink, 2);
        font.Draw("ONLINE MULTIPLAYER · WEBSOCKET", left + 3, 132, 15, Accent, 2);

        var shownUrl = _onlineUrl.Length > 43 ? "…" + _onlineUrl[^42..] : _onlineUrl;
        var labels = new[] { "呼號", "伺服器位址", "連線", "返回" };
        var values = new[] { _profile.Name, shownUrl, "ENTER", "ESC" };
        const float top = 212;
        const float rowHeight = 74;
        for (var index = 0; index < labels.Length; index++)
        {
            var y = top + index * rowHeight;
            var selected = index == _onlineField;
            if (selected)
            {
                Raylib.DrawRectangle(left - 13, (int)y - 10, 4, 48, Accent);
                Raylib.DrawRectangleGradientH(left, (int)y - 10, Math.Min(650, width / 2), 48,
                    new Color(255, 122, 41, 34), new Color(255, 122, 41, 0));
            }
            font.Draw(labels[index], left + 8, y, 21, selected ? Ink : DimInk);
            font.Draw(values[index], left + 220, y, index == 1 ? 16 : 19, selected ? Accent : Ink);
        }

        var panelX = width * .58f;
        var panelWidth = width - panelX - left;
        Raylib.DrawRectangleRounded(new Rectangle(panelX, 184, panelWidth, Math.Min(425, height - 250)),
            .025f, 7, Panel);
        font.Draw("專用伺服器", panelX + 29, 220, 27, Ink);
        font.Draw("SERVER AUTHORITATIVE", panelX + 30, 280, 14, Accent, 2);
        DrawWrapped("地圖、模式、種子與所有戰鬥結果都由伺服器決定。連線後用戶端只預測自己的移動，並以快照校正。",
            panelX + 29, 320, panelWidth - 58, 17, 32, DimInk);
        font.Draw($"協定版本  {GameConstants.Network.ProtocolVersion}", panelX + 29, 448, 15, Ink);
        font.Draw("預設伺服器可從 dotnet/ 目錄啟動。", panelX + 29, 486, 14, DimInk);
        if (!string.IsNullOrWhiteSpace(_onlineMessage))
            DrawWrapped(_onlineMessage, panelX + 29, 536, panelWidth - 58, 15, 28, Accent);
        font.Draw("輸入位址後按 ENTER 連線", width - 298, height - 44, 15, DimInk);
        font.Draw("ESC 返回", left, height - 44, 15, Accent);
    }

    private void DrawConnecting()
    {
        DrawMenuBackdrop();
        var font = RequireFont();
        var width = Raylib.GetScreenWidth();
        var height = Raylib.GetScreenHeight();
        var pulse = .5f + .5f * MathF.Sin((float)Raylib.GetTime() * 4f);
        var color = new Color(255, 122, 41, (int)(155 + pulse * 100));
        font.DrawCentered("正在連線", height * .30f, 52, Ink);
        font.DrawCentered(_onlineUrl, height * .40f, 18, color);
        var dots = new string('.', 1 + (int)(Raylib.GetTime() * 2) % 3);
        font.DrawCentered($"等待伺服器回應{dots}", height * .49f, 21, DimInk);
        if (!string.IsNullOrWhiteSpace(_onlineMessage))
            font.DrawCentered(_onlineMessage, height * .57f, 15, Accent);
        font.DrawCentered($"{_onlineElapsed:0.0} 秒", height * .64f, 14, DimInk);
        font.DrawCentered("ESC 取消", height - 72, 15, DimInk);
    }

    private void DrawLoadoutMenu()
    {
        DrawMenuBackdrop();
        var font = RequireFont();
        var width = Raylib.GetScreenWidth();
        var height = Raylib.GetScreenHeight();
        var left = Math.Max(42, width / 20);
        font.Draw("配裝", left, 43, 38, Ink);
        font.Draw("CREATE-A-CLASS · 即時使用核心武器資料", left + 2, 113, 14, Accent, 2);

        const int visibleRows = 15;
        const float rowHeight = 39;
        const float top = 147;
        var rows = _loadoutEditor.Rows;
        var end = Math.Min(rows.Count, _loadoutEditor.Scroll + visibleRows);
        var listWidth = Math.Min(650, width * .51f);
        for (var index = _loadoutEditor.Scroll; index < end; index++)
        {
            var row = rows[index];
            var y = top + (index - _loadoutEditor.Scroll) * rowHeight;
            var selected = index == _loadoutEditor.Selection;
            if (selected)
            {
                Raylib.DrawRectangle(left - 11, (int)y - 7, 4, 32, Accent);
                Raylib.DrawRectangleGradientH(left, (int)y - 7, (int)listWidth, 32,
                    new Color(255, 122, 41, 34), new Color(255, 122, 41, 0));
            }
            font.Draw(row.Label, left + 8, y, 16, selected ? Ink : DimInk);
            var valueWidth = font.Measure(row.Value, 15).X;
            font.Draw(row.Value, left + listWidth - valueWidth - 16, y, 15, selected ? Accent : Ink);
        }

        if (rows.Count > visibleRows)
            font.Draw($"{_loadoutEditor.Selection + 1} / {rows.Count}", left + listWidth - 65, height - 61, 13, DimInk);

        var panelX = left + listWidth + 42;
        var panelWidth = width - panelX - left;
        Raylib.DrawRectangleRounded(new Rectangle(panelX, top - 8, panelWidth, Math.Min(520, height - 220)),
            .025f, 7, Panel);
        var selectedRow = rows[Math.Clamp(_loadoutEditor.Selection, 0, rows.Count - 1)];
        font.Draw(selectedRow.Label.Trim(), panelX + 27, top + 18, 27, Ink);
        font.Draw(selectedRow.Value, panelX + 28, top + 79, 21, Accent);
        DrawWrapped(selectedRow.Description, panelX + 28, top + 132, panelWidth - 56, 16, 30, DimInk);

        var current = _profile.Loadouts[_profile.ActiveLoadout];
        font.Draw($"{current.PrimaryAttachments.Count} / {AttachmentData.MaxEquippedAttachments} 主武器配件",
            panelX + 28, top + 275, 14, Ink);
        font.Draw($"{current.SecondaryAttachments.Count} / {AttachmentData.MaxEquippedAttachments} 副武器配件",
            panelX + 28, top + 305, 14, Ink);
        font.Draw($"軍階 {_profile.Rank} · 鎖定項目會隨軍階解鎖", panelX + 28, top + 370, 13, DimInk);
        font.Draw("↑↓ 選擇   ←→ 更換", width - 245, height - 43, 15, DimInk);
        font.Draw("ESC 儲存並返回", left, height - 43, 15, Accent);
    }

    private void DrawSettingsMenu()
    {
        DrawMenuBackdrop();
        var font = RequireFont();
        var width = Raylib.GetScreenWidth();
        var height = Raylib.GetScreenHeight();
        var left = Math.Max(55, width / 10);
        var settings = _profile.Settings;
        font.Draw("設定", left, 52, 40, Ink);
        font.Draw("影像、輸入、介面與音效", left + 3, 126, 15, Accent, 2);
        var labels = new[]
        {
            "視野", "滑鼠靈敏度", "瞄準靈敏度", "反轉垂直視角", "自動衝刺", "顯示 FPS",
            "顯示準星", "顯示小地圖", "介面比例", "主音量", "效果音量", "音樂音量",
            "切換式瞄準", "切換式蹲下", "控制器死區", "控制器靈敏度", "瞄準輔助",
        };
        var values = new[]
        {
            $"{settings.FieldOfView}°", $"{settings.MouseSensitivity:0.0}",
            $"{settings.AdsSensitivityScale:0.00}", OnOff(settings.InvertY), OnOff(settings.AutoSprint),
            OnOff(settings.ShowFps), OnOff(settings.ShowCrosshair), OnOff(settings.ShowMinimap),
            $"{settings.HudScale * 100:0}%", $"{settings.MasterVolume * 100:0}%",
            $"{settings.SfxVolume * 100:0}%", $"{settings.MusicVolume * 100:0}%",
            OnOff(settings.ToggleAds), OnOff(settings.ToggleCrouch), $"{settings.GamepadDeadzone * 100:0}%",
            $"{settings.GamepadSensitivity:0.0}", $"{settings.AimAssist * 100:0}%",
        };
        const float top = 164;
        const float rowHeight = 37;
        var panelWidth = Math.Min(680, width - left * 2);
        for (var index = 0; index < labels.Length; index++)
        {
            var y = top + index * rowHeight;
            var selected = index == _settingsSelection;
            if (selected)
            {
                Raylib.DrawRectangle(left - 12, (int)y - 6, 4, 30, Accent);
                Raylib.DrawRectangleGradientH(left, (int)y - 6, (int)panelWidth, 30,
                    new Color(255, 122, 41, 34), new Color(255, 122, 41, 0));
            }
            font.Draw(labels[index], left + 8, y, 15, selected ? Ink : DimInk);
            var valueWidth = font.Measure(values[index], 15).X;
            font.Draw($"‹  {values[index]}  ›", left + panelWidth - valueWidth - 72, y, 15,
                selected ? Accent : Ink);
        }
        font.Draw("所有變更即時套用並自動保存。", left + panelWidth + 50, top + 12, 16, DimInk);
        DrawWrapped("介面比例、十字準星、小地圖與幀率顯示可以獨立調整；輸入設定會立即傳給固定更新率控制器。",
            left + panelWidth + 50, top + 58, width - left * 2 - panelWidth - 50, 16, 27, Ink);
        font.Draw("↑↓ 選擇   ←→ 調整", width - 245, height - 43, 15, DimInk);
        font.Draw("ESC 返回", left, height - 43, 15, Accent);
    }

    private void DrawSkirmishMenu()
    {
        DrawMenuBackdrop();
        var font = RequireFont();
        var width = Raylib.GetScreenWidth();
        var height = Raylib.GetScreenHeight();
        var left = Math.Max(55, width / 12);
        var map = Maps.Get(Maps.Ids[_mapSelection]);
        var mode = ModeData.GetMode(ModeData.MultiplayerModeIds[_modeSelection]);
        var difficulty = BotData.Difficulties[BotData.DifficultyIds[_difficultySelection]];

        font.Draw("快速對戰", left, 56, 40, Ink, 2);
        font.Draw("LOCAL SKIRMISH · 64 Hz AUTHORITATIVE SIMULATION", left + 3, 130, 14, Accent, 2);

        var labels = new[] { "地圖", "模式", "電腦兵", "難度", "開始對戰", "返回" };
        var values = new[]
        {
            map.Name,
            mode.Name,
            _botCount.ToString(CultureInfo.InvariantCulture),
            difficulty.Name,
            "ENTER",
            "ESC",
        };
        const float top = 182;
        const float rowHeight = 66;
        for (var index = 0; index < labels.Length; index++)
        {
            var selected = index == _skirmishField;
            var y = top + index * rowHeight;
            if (selected)
            {
                Raylib.DrawRectangle(left - 14, (int)y - 10, 4, 46, Accent);
                Raylib.DrawRectangleGradientH(left, (int)y - 10, Math.Min(505, width / 2 - left), 46,
                    new Color(255, 122, 41, 34), new Color(255, 122, 41, 0));
            }
            font.Draw(labels[index], left + 8, y, 20, selected ? Ink : DimInk);
            var valueColor = selected ? Accent : new Color(180, 192, 201, 255);
            font.Draw(index < 4 ? $"‹  {values[index]}  ›" : values[index], left + 235, y, 19, valueColor);
        }

        var panelX = Math.Max(width * .57f, left + 555);
        var panelWidth = width - panelX - left;
        Raylib.DrawRectangleRounded(new Rectangle(panelX, 178, panelWidth, Math.Min(480, height - 250)),
            .025f, 7, Panel);
        font.Draw(map.Name, panelX + 28, 210, 27, Ink);
        font.Draw(map.Tagline, panelX + 29, 270, 14, Accent, 1);
        DrawWrapped(map.Description, panelX + 28, 310, panelWidth - 56, 17, 32, DimInk);
        font.Draw(mode.Name, panelX + 28, 420, 23, Ink);
        DrawWrapped(mode.Description, panelX + 28, 467, panelWidth - 56, 16, 30, DimInk);
        font.Draw($"人數  1 + {_botCount}     目標  {mode.ScoreLimit:0}     時限  {mode.TimeLimit / 60:0} 分鐘",
            panelX + 28, 575, 14, new Color(190, 204, 212, 255));
        font.Draw("↑↓ 選擇   ←→ 調整   ENTER 確認", width - 355, height - 44, 15, DimInk);
        font.Draw("ESC 返回", left, height - 44, 15, DimInk);
    }

    private void DrawControls()
    {
        DrawMenuBackdrop();
        var font = RequireFont();
        var width = Raylib.GetScreenWidth();
        var height = Raylib.GetScreenHeight();
        var left = Math.Max(55, width / 10);
        font.Draw("按鍵配置", left, 46, 38, Ink);
        font.Draw("每個動作可設定主要與備用按鍵", left + 3, 116, 15, Accent, 2);

        var actions = InputBindingCatalog.All;
        var visibleRows = Math.Clamp((height - 330) / 40, 6, actions.Count);
        if (_controlsSelection < actions.Count)
        {
            if (_controlsSelection < _controlsScroll) _controlsScroll = _controlsSelection;
            if (_controlsSelection >= _controlsScroll + visibleRows)
                _controlsScroll = _controlsSelection - visibleRows + 1;
        }
        _controlsScroll = Math.Clamp(_controlsScroll, 0, Math.Max(0, actions.Count - visibleRows));

        var listWidth = Math.Min(820, width - left * 2 - 270);
        var slotWidth = Math.Clamp(listWidth * .25f, 125, 210);
        var primaryX = left + listWidth - slotWidth * 2 - 18;
        var alternateX = left + listWidth - slotWidth;
        font.Draw("動作", left + 8, 158, 13, DimInk, 1);
        font.Draw("主要", primaryX + 8, 158, 13, DimInk, 1);
        font.Draw("備用", alternateX + 8, 158, 13, DimInk, 1);

        const float top = 188;
        const float rowHeight = 40;
        var end = Math.Min(actions.Count, _controlsScroll + visibleRows);
        for (var index = _controlsScroll; index < end; index++)
        {
            var definition = actions[index];
            var y = top + (index - _controlsScroll) * rowHeight;
            var selected = index == _controlsSelection;
            if (selected)
            {
                Raylib.DrawRectangle(left - 12, (int)y - 5, 4, 31, Accent);
                Raylib.DrawRectangleGradientH(left, (int)y - 5, (int)listWidth, 31,
                    new Color(255, 122, 41, 30), new Color(255, 122, 41, 0));
            }
            font.Draw(definition.Label, left + 8, y, 15, selected ? Ink : DimInk);

            _profile.Settings.Bindings.TryGetValue(definition.Action, out var bindings);
            for (var slot = 0; slot < 2; slot++)
            {
                var x = slot == 0 ? primaryX : alternateX;
                var slotSelected = selected && slot == _controlsSlot;
                var capturing = slotSelected && _capturingAction == definition.Action;
                var fill = slotSelected ? new Color(255, 122, 41, 42) : new Color(35, 44, 50, 210);
                Raylib.DrawRectangleRounded(new Rectangle(x, y - 6, slotWidth - 8, 29), .15f, 5, fill);
                if (slotSelected)
                    Raylib.DrawRectangleLinesEx(new Rectangle(x, y - 6, slotWidth - 8, 29), 1.2f, Accent);
                var code = bindings is not null && slot < bindings.Count ? bindings[slot] : null;
                var value = capturing ? "按下按鍵…" : InputBindingCatalog.KeyLabel(code);
                var valueWidth = font.Measure(value, 13).X;
                font.Draw(value, x + (slotWidth - 8 - valueWidth) / 2, y + 1, 13,
                    slotSelected ? Accent : Ink);
            }
        }

        var panelX = left + listWidth + 35;
        var panelWidth = width - panelX - left;
        Raylib.DrawRectangleRounded(new Rectangle(panelX, 156, panelWidth, Math.Min(365, height - 260)),
            .025f, 7, Panel);
        font.Draw("重新綁定", panelX + 24, 184, 25, Ink);
        DrawWrapped("選擇一個欄位並按 ENTER，接著按下鍵盤按鍵或滑鼠按鈕。新的按鍵會自動從其他動作移除。",
            panelX + 24, 228, panelWidth - 48, 15, 25, DimInk);
        font.Draw("ESC 取消捕捉", panelX + 24, 344, 14, Accent);
        font.Draw($"{Math.Min(_controlsSelection + 1, actions.Count)} / {actions.Count}",
            panelX + 24, 390, 13, DimInk);

        var resetSelected = _controlsSelection == actions.Count;
        var backSelected = _controlsSelection == actions.Count + 1;
        DrawMenuItem("恢復預設按鍵", left, height - 104, 260, resetSelected);
        DrawMenuItem("返回", left + 285, height - 104, 180, backSelected);
        font.Draw(_capturingAction is null
                ? "↑↓ 選擇   ←→ 欄位   ENTER 重新綁定"
                : "正在捕捉輸入…   ESC 取消",
            width - 385, height - 42, 14, _capturingAction is null ? DimInk : Accent);
        font.Draw("ESC 儲存並返回", left, height - 42, 14, DimInk);
    }

    private void DrawWorld(bool paused)
    {
        if (_session is null || _mapRenderer is null || _entityRenderer is null) return;
        var player = _session.Player;
        var eye = new Vector3((float)player.Position.X, (float)(player.Position.Y + _eyeHeight),
            (float)player.Position.Z);
        var cp = Math.Cos(player.Pitch);
        var forward = new Vector3(
            (float)(-Math.Sin(player.Yaw) * cp),
            (float)-Math.Sin(player.Pitch),
            (float)(-Math.Cos(player.Yaw) * cp));
        var camera = new Camera3D
        {
            Position = eye,
            Target = eye + forward,
            Up = Vector3.UnitY,
            FovY = (float)(_profile.Settings.FieldOfView *
                (player.MoveState is MoveState.Sprint or MoveState.TacticalSprint ? 1.09 : 1d) *
                WeaponSystem.AdsFovScale(
                _session.Simulation.ActiveWeaponDef(player),
                player.AdsProgress)),
            Projection = CameraProjection.Perspective,
        };

        var fog = FromHex(_session.Map.Lighting.FogColor);
        Raylib.ClearBackground(fog);
        Raylib.BeginMode3D(camera);
        _mapRenderer.Draw(_session.Map);
        if (_session.Campaign is not null) DrawCampaignMarkers(_session.Campaign.ActiveObjectives());
        else _mapRenderer.DrawObjectiveHints(_session.Map, _session.Simulation.Mode);
        if (_session.Zombies is not null)
            _zombiesRenderer?.Draw(ZombieMaps.Get(_session.Map.Id), _session.Zombies, player, _session.World.Time);
        _entityRenderer.Draw(_session.World, player.Id);
        _effectsRenderer.Draw();
        Raylib.EndMode3D();

        if (_session.Zombies is not null)
            _zombiesRenderer?.DrawOverlay(_session.Zombies, player, camera, RequireFont());
        if (_weaponRenderer is not null) _weaponRenderer.Draw();
        else DrawWeaponSilhouette(player);
        if (WeaponSystem.ShowScopeOverlay(
                _session.Simulation.ActiveWeaponDef(player),
                player.AdsProgress))
            DrawScopeOverlay();
        DrawScaledHud(_session);
        if (paused) DrawPauseOverlay();
    }

    private void DrawScaledHud(NativeSession session)
    {
        var scale = (float)_profile.Settings.HudScale;
        if (Math.Abs(scale - 1f) < .001f)
        {
            DrawHud(session);
            return;
        }

        var center = new Vector2(Raylib.GetScreenWidth() / 2f, Raylib.GetScreenHeight() / 2f);
        Raylib.BeginMode2D(new Camera2D
        {
            Offset = center,
            Target = center,
            Rotation = 0,
            Zoom = scale,
        });
        DrawHud(session);
        Raylib.EndMode2D();
    }

    private static void DrawCampaignMarkers(IReadOnlyList<CampaignHudObjective> objectives)
    {
        foreach (var objective in objectives)
        {
            if (objective.Position is null) continue;
            var position = ToNumerics(objective.Position);
            var color = new Color(255, 192, 72, 185);
            Raylib.DrawCylinderEx(position, position + Vector3.UnitY * .08f, .72f, .72f, 24,
                new Color(color.R, color.G, color.B, (byte)75));
            Raylib.DrawLine3D(position, position + Vector3.UnitY * 3.2f, color);
        }
    }

    private void DrawHud(NativeSession session)
    {
        var font = RequireFont();
        var width = Raylib.GetScreenWidth();
        var height = Raylib.GetScreenHeight();
        var player = session.Player;

        // Crosshair.
        var cx = width / 2;
        var cy = height / 2;
        var gap = Math.Max(3, (int)Math.Round(_crosshairGap));
        const int line = 7;
        var crosshairHidden = player.AdsProgress > .85 ||
                              player.MoveState is MoveState.Sprint or MoveState.TacticalSprint;
        if (_profile.Settings.ShowCrosshair && !crosshairHidden)
        {
            var outline = new Color(0, 0, 0, 245);
            var crosshair = new Color(200, 255, 53, 255);

            void DrawSegment(int x1, int y1, int x2, int y2)
            {
                var start = new Vector2(x1, y1);
                var end = new Vector2(x2, y2);
                Raylib.DrawLineEx(start, end, 5f, outline);
                Raylib.DrawLineEx(start, end, 2f, crosshair);
            }

            DrawSegment(cx - gap - line, cy, cx - gap, cy);
            DrawSegment(cx + gap, cy, cx + gap + line, cy);
            DrawSegment(cx, cy - gap - line, cx, cy - gap);
            DrawSegment(cx, cy + gap, cx, cy + gap + line);
            Raylib.DrawCircle(cx, cy, 3f, outline);
            Raylib.DrawCircle(cx, cy, 1.5f, crosshair);
        }

        if (_hitMarkerTime > 0)
        {
            var marker = _hitMarkerTime > .15 ? new Color(245, 72, 62, 245) : new Color(240, 245, 248, 235);
            const int inner = 10;
            const int outer = 18;
            Raylib.DrawLine(cx - outer, cy - outer, cx - inner, cy - inner, marker);
            Raylib.DrawLine(cx + inner, cy + inner, cx + outer, cy + outer, marker);
            Raylib.DrawLine(cx + inner, cy - inner, cx + outer, cy - outer, marker);
            Raylib.DrawLine(cx - outer, cy + outer, cx - inner, cy + inner, marker);
        }

        if (session.Kind == NativeSessionKind.Zombies)
            DrawZombiesHud(session, font, width, height);
        else if (session.Mission is not null && session.Campaign is not null)
            DrawCampaignHud(session, font, width, height);
        else
            DrawSkirmishHud(session, font, width, height);

        // Health and movement diagnostics.
        var healthWidth = 230f;
        Raylib.DrawRectangleRounded(new Rectangle(30, height - 86, healthWidth, 51), 0.08f, 5, new Color(8, 12, 15, 215));
        font.Draw("生命", 46, height - 73, 14, DimInk);
        Raylib.DrawRectangle(100, height - 68, 140, 10, new Color(58, 64, 67, 255));
        Raylib.DrawRectangle(100, height - 68, (int)(140 * Math.Clamp(player.Health / player.MaxHealth, 0, 1)), 10, Health);
        font.Draw(Math.Ceiling(player.Health).ToString(CultureInfo.InvariantCulture), 199, height - 52, 13, Ink);

        var speed = Movement.HorizontalSpeed(player);
        font.Draw($"{player.MoveState}  {speed:0.0} m/s", 30, height - 112, 13, DimInk);
        DrawCombatStatus(session, font, width, height);
        if (_profile.Settings.ShowFps || _smokePath is not null)
            font.Draw($"{session.World.Tick} tick · {Raylib.GetFPS()} FPS", width - 180, 24, 13, DimInk);
        if (session.NetworkStats is { } network)
            font.Draw($"{network.Ping} ms · {network.Snapshots} snaps · {network.Pending} pending",
                width - 300, 74, 13, DimInk);
        if (_profile.Settings.ShowMinimap) _minimapRenderer?.Draw(session, font, width);
        font.Draw("ESC 暫停", width - 105, height - 31, 13, DimInk);
    }

    private void DrawCombatStatus(NativeSession session, UiFont font, int width, int height)
    {
        var player = session.Player;
        var weapon = WeaponSystem.ActiveWeapon(player);
        if (weapon is not null)
        {
            var weaponName = WeaponData.GetWeapon(weapon.DefId).Name;
            Raylib.DrawRectangleRounded(new Rectangle(width - 375, height - 112, 345, 77), .05f, 5,
                new Color(8, 12, 15, 215));
            font.Draw(weaponName, width - 352, height - 96, 17, DimInk);
            font.Draw($"{weapon.AmmoInMag}", width - 198, height - 89, 34, Ink);
            font.Draw($"/ {weapon.AmmoReserve}", width - 127, height - 77, 17, DimInk);
            font.Draw($"G  {player.LethalCount}     Q  {player.TacticalCount}", width - 350, height - 55,
                13, new Color(200, 211, 218, 255));
        }

        if (player.KillstreakInventory.Count > 0)
        {
            var y = height - 156f;
            for (var index = 0; index < player.KillstreakInventory.Count; index++)
            {
                var definition = KillstreakData.GetKillstreak(player.KillstreakInventory[index]);
                font.Draw($"{index + 1}  {definition.Name}", width - 260, y, 13, Accent);
                y -= 21;
            }
        }

        var feedY = 270f;
        foreach (var line in _feed)
        {
            var alpha = (int)(255 * Math.Clamp(line.Remaining / .7, 0, 1));
            font.Draw(line.Text, width - 385, feedY, 14, new Color(line.Color.R, line.Color.G, line.Color.B, alpha));
            feedY += 23;
        }
        if (_announcementTime > 0 && !string.IsNullOrEmpty(_announcement))
            DrawCaptionCentered(_announcement, height * .22f, 21, new Color(255, 225, 150, 245));
        if (_scorePopupTime > 0 && !string.IsNullOrEmpty(_scorePopup))
            font.DrawOutlined(_scorePopup, width / 2f + 30, height / 2f + 35, 15, Accent);

        if (!player.Alive)
        {
            Raylib.DrawRectangle(0, 0, width, height, new Color(65, 4, 2, 70));
            font.DrawCentered("陣亡", height * .37f, 45, new Color(245, 92, 77, 245));
            if (session.Simulation.Mode.Respawn)
                font.DrawCentered($"{Math.Max(0, player.RespawnTimer):0.0}", height * .44f, 20, Ink);
        }
        if (_damageOverlayTime > 0)
        {
            var alpha = (int)(105 * Math.Clamp(_damageOverlayTime / .8, 0, 1));
            var damage = new Color(150, 8, 4, alpha);
            Raylib.DrawRectangle(0, 0, width, 22, damage);
            Raylib.DrawRectangle(0, height - 22, width, 22, damage);
            Raylib.DrawRectangle(0, 0, 22, height, damage);
            Raylib.DrawRectangle(width - 22, 0, 22, height, damage);
        }
        if (player.FlashAmount > 0)
            Raylib.DrawRectangle(0, 0, width, height,
                new Color(255, 255, 245, (int)(235 * Math.Clamp(player.FlashAmount, 0, 1))));
    }

    private void DrawCampaignHud(NativeSession session, UiFont font, int width, int height)
    {
        var mission = session.Mission!;
        var campaign = session.Campaign!;
        Raylib.DrawRectangleRounded(new Rectangle(25, 24, Math.Min(475, width * .34f),
                72 + mission.Objectives.Count * 24), .04f, 5, new Color(8, 12, 15, 205));
        font.Draw($"第 {_missionSelection + 1} 章 · {mission.Name}", 43, 39, 19, Ink);
        font.Draw(session.Map.Name, 43, 67, 13, Accent, 1);
        var objectiveY = 95f;
        foreach (var objective in campaign.ActiveObjectives())
        {
            font.Draw("◇", 44, objectiveY, 15, new Color(255, 192, 72, 255));
            font.Draw(objective.Label, 68, objectiveY, 14, new Color(205, 215, 222, 255));
            if (objective.Progress > 0)
                font.Draw($"{Math.Round(objective.Progress * 100):0}%", 410, objectiveY, 13, Accent);
            objectiveY += 24;
        }

        if (!string.IsNullOrEmpty(campaign.State.LastLine))
        {
            var captionBounds = new Rectangle(width * .19f, height - 205, width * .62f, 98);
            Raylib.DrawRectangleRounded(captionBounds, .14f, 8, new Color(0, 0, 0, 180));
            DrawWrappedOutlined(campaign.State.LastLine, width * .22f, height - 186, width * .56f,
                17, 31, new Color(242, 244, 232, 255));
        }
        if (campaign.State.Phase == MissionPhase.Briefing)
        {
            var seconds = Math.Max(0, Math.Ceiling(campaign.State.TransitionTimer));
            var briefingBounds = new Rectangle(width * .13f, height * .68f, width * .74f, 96);
            Raylib.DrawRectangleRounded(briefingBounds, .12f, 8, new Color(0, 0, 0, 188));
            DrawWrappedOutlined(mission.Brief, width * .16f, height * .705f, width * .68f,
                18, 34, Ink);
            font.DrawCentered($"{seconds:0}", height * .79f, 34, Accent);
        }
        else if (campaign.State.Phase == MissionPhase.Failed)
        {
            font.DrawCentered("任務失敗", height * .35f, 44, new Color(235, 70, 55, 255));
            font.DrawCentered(FailureName(campaign.State.Failure), height * .42f, 18, Ink);
            font.DrawCentered("從檢查點重新部署…", height * .47f, 15, DimInk);
        }
    }

    private void DrawZombiesHud(NativeSession session, UiFont font, int width, int height)
    {
        var hud = session.CaptureZombiesHud();
        if (hud is null) return;
        Raylib.DrawRectangleRounded(new Rectangle(25, 24, Math.Min(385, width * .29f), 121),
            .04f, 5, new Color(8, 12, 15, 215));
        font.Draw($"回合  {hud.Round}", 43, 39, 25, hud.Phase == RoundPhase.GameOver
            ? new Color(235, 70, 55, 255)
            : Accent);
        font.Draw(ZombiePhaseName(hud.Phase), 43, 75, 13, DimInk, 1);
        font.Draw($"點數  {hud.Points}", 43, 103, 19, Ink);
        font.Draw($"殭屍  {hud.ZombiesAlive}", 205, 105, 16, new Color(225, 91, 68, 255));

        var perkX = 43f;
        foreach (var perkId in hud.Perks)
        {
            if (!ZombieData.Perks.TryGetValue(perkId, out var perk)) continue;
            font.Draw(perk.Name, perkX, 157, 13, new Color(255, 220, 120, 245));
            perkX += font.Measure(perk.Name, 13).X + 18;
        }

        if (hud.Prompt is { } prompt)
        {
            var text = prompt.Cost > 0 ? $"按 F — {prompt.Label}  ({prompt.Cost})" : $"按 F — {prompt.Label}";
            if (!prompt.Usable && !string.IsNullOrEmpty(prompt.Reason)) text += $"  · {prompt.Reason}";
            var color = prompt.Usable ? new Color(255, 225, 145, 250) : new Color(190, 190, 190, 225);
            DrawCaptionCentered(text, height - 173, 18, color);
        }
        if (hud.Downed)
        {
            Raylib.DrawRectangle(0, 0, width, height, new Color(85, 4, 2, 80));
            font.DrawCentered("倒地", height * .34f, 45, new Color(245, 92, 77, 245));
            font.DrawCentered($"流血倒數  {Math.Max(0, hud.BleedOut):0.0}", height * .42f, 18, Ink);
            if (hud.ReviveProgress > 0)
                font.DrawCentered($"救援  {hud.ReviveProgress * 100:0}%", height * .47f, 16, Accent);
        }
        if (_input.ScoreboardHeld) DrawScoreboard(session, font, width, height);
    }

    private void DrawSkirmishHud(NativeSession session, UiFont font, int width, int height)
    {
        var match = session.World.Match;
        var mode = session.Simulation.Mode;
        Raylib.DrawRectangleRounded(new Rectangle(25, 24, Math.Min(450, width * .32f), 103),
            .04f, 5, new Color(8, 12, 15, 205));
        font.Draw($"{mode.Name} · {session.Map.Name}", 43, 39, 19, Ink);
        font.Draw(MatchPhaseName(match.Phase), 43, 68, 13, Accent, 1);
        var minutes = Math.Max(0, (int)Math.Ceiling(match.TimeRemaining)) / 60;
        var seconds = Math.Max(0, (int)Math.Ceiling(match.TimeRemaining)) % 60;
        font.Draw($"{minutes:00}:{seconds:00}", 43, 92, 18, Ink);

        var scoreX = 150f;
        foreach (var score in match.Scores)
        {
            var scoreColor = score.Team == session.Player.Team
                ? Friendly
                : SimulationTypes.IsEnemyTeam(session.Player.Team, score.Team) ? Enemy : Ink;
            font.Draw($"{TeamName(score.Team)}  {score.Score:0}", scoreX, 93, 15,
                scoreColor);
            scoreX += 110;
        }
        var objectives = session.ObjectiveStatus();
        var objectiveY = 139f;
        foreach (var objective in objectives.Where(value => value.Active))
        {
            font.Draw($"{objective.Label}  {TeamName(objective.Owner)}  {objective.Progress * 100:0}%",
                43, objectiveY, 14, objective.Contested ? Accent : Ink);
            objectiveY += 23;
        }
        if (_input.ScoreboardHeld || match.Phase == MatchPhase.MatchEnd)
            DrawScoreboard(session, font, width, height);
        else
            font.Draw("TAB 計分板", width - 118, 48, 13, DimInk);
    }

    private static void DrawScoreboard(NativeSession session, UiFont font, int width, int height)
    {
        var board = session.Simulation.Scoreboard();
        var panelWidth = Math.Min(670, width - 80);
        var x = (width - panelWidth) / 2f;
        var y = Math.Max(72, height * .12f);
        var visible = Math.Min(board.Count, 18);
        Raylib.DrawRectangleRounded(new Rectangle(x, y, panelWidth, 73 + visible * 26), .025f, 7,
            new Color(7, 10, 13, 235));
        font.Draw("計分板", x + 24, y + 19, 22, Ink);
        font.Draw("玩家", x + 25, y + 53, 13, DimInk);
        font.Draw("分數   擊殺   死亡   助攻", x + panelWidth - 265, y + 53, 13, DimInk);
        for (var index = 0; index < visible; index++)
        {
            var row = board[index];
            var rowY = y + 77 + index * 26;
            var rowEnemy = SimulationTypes.IsEnemyTeam(session.Player.Team, row.Team);
            var rowColor = rowEnemy ? Enemy : Friendly;
            if (row.Id == session.Player.Id)
                Raylib.DrawRectangle((int)x + 11, (int)rowY - 3, panelWidth - 22, 23,
                    new Color(Friendly.R, Friendly.G, Friendly.B, (byte)30));
            font.Draw(row.Name, x + 25, rowY, 14, rowColor);
            font.Draw($"{row.Score,5:0}   {row.Kills,4}   {row.Deaths,4}   {row.Assists,4}",
                x + panelWidth - 280, rowY, 14, Ink);
        }
    }

    private static void DrawWeaponSilhouette(PlayerState player)
    {
        var width = Raylib.GetScreenWidth();
        var height = Raylib.GetScreenHeight();
        var ads = (float)Math.Clamp(player.AdsProgress, 0, 1);
        var x = (int)MathEx.Lerp(width - 410, width / 2d - 78, ads);
        var y = (int)MathEx.Lerp(height - 172, height - 145, ads);
        var gun = new Color(34, 39, 41, 255);
        var edge = new Color(86, 93, 95, 255);
        Raylib.DrawRectangleRounded(new Rectangle(x, y, 260, 62), 0.16f, 8, gun);
        Raylib.DrawRectangleLinesEx(new Rectangle(x, y, 260, 62), 2, edge);
        Raylib.DrawRectangle(x + 206, y - 13, 145, 18, gun);
        Raylib.DrawRectangle(x + 57, y + 54, 38, 95, gun);
        Raylib.DrawTriangle(new Vector2(x + 122, y + 56), new Vector2(x + 198, y + 56),
            new Vector2(x + 183, y + 112), gun);
        Raylib.DrawCircle(x + 155, y + 3, 14, new Color(20, 23, 25, 255));
    }

    private void UpdateCrosshair(NativeSession session, double deltaTime)
    {
        var state = WeaponSystem.ActiveWeapon(session.Player);
        var spread = state?.Spread ?? 0d;
        var definition = session.Simulation.ActiveWeaponDef(session.Player);
        var fov = _profile.Settings.FieldOfView * WeaponSystem.AdsFovScale(
            definition,
            session.Player.AdsProgress);
        var halfHeight = Raylib.GetScreenHeight() * .5d;
        var focal = halfHeight / Math.Tan(fov * Math.PI / 360d);
        var target = Math.Max(3d, Math.Tan(spread) * focal);
        var rate = target > _crosshairGap ? 30d : 9d;
        _crosshairGap = MathEx.Lerp(_crosshairGap, target, Math.Clamp(rate * deltaTime, 0d, 1d));
    }

    private static void DrawScopeOverlay()
    {
        var width = Raylib.GetScreenWidth();
        var height = Raylib.GetScreenHeight();
        var center = new Vector2(width / 2f, height / 2f);
        var radius = MathF.Min(width, height) * .42f;
        var outer = MathF.Sqrt(width * width + height * height);
        var black = new Color(2, 3, 4, 255);
        const int segments = 96;
        for (var index = 0; index < segments; index++)
        {
            var angleA = index * MathF.Tau / segments;
            var angleB = (index + 1) * MathF.Tau / segments;
            var innerA = center + new Vector2(MathF.Cos(angleA), MathF.Sin(angleA)) * radius;
            var innerB = center + new Vector2(MathF.Cos(angleB), MathF.Sin(angleB)) * radius;
            var outerA = center + new Vector2(MathF.Cos(angleA), MathF.Sin(angleA)) * outer;
            var outerB = center + new Vector2(MathF.Cos(angleB), MathF.Sin(angleB)) * outer;
            Raylib.DrawTriangle(innerA, outerA, outerB, black);
            Raylib.DrawTriangle(innerA, outerB, innerB, black);
        }
        Raylib.DrawCircleLines((int)center.X, (int)center.Y, radius, new Color(25, 25, 25, 255));
        Raylib.DrawLine((int)(center.X - radius), (int)center.Y, (int)(center.X + radius),
            (int)center.Y, new Color(15, 15, 15, 220));
        Raylib.DrawLine((int)center.X, (int)(center.Y - radius), (int)center.X,
            (int)(center.Y + radius), new Color(15, 15, 15, 220));
        Raylib.DrawCircle((int)center.X, (int)center.Y, 2, new Color(220, 55, 45, 245));
    }

    private void DrawPauseOverlay()
    {
        var font = RequireFont();
        var width = Raylib.GetScreenWidth();
        var height = Raylib.GetScreenHeight();
        Raylib.DrawRectangle(0, 0, width, height, new Color(4, 6, 8, 190));
        var panelWidth = Math.Min(520, width - 80);
        var campaign = _session?.Kind == NativeSessionKind.Campaign;
        Raylib.DrawRectangleRounded(new Rectangle(
                (width - panelWidth) / 2f,
                height * (campaign ? .19f : .23f),
                panelWidth,
                campaign ? 500 : 360),
            0.035f, 7, Panel);
        var restart = _session?.Kind switch
        {
            NativeSessionKind.Campaign => "R   重新開始任務",
            NativeSessionKind.Zombies => "R   重新開始生存",
            NativeSessionKind.Online => "R   重新連線",
            _ => "R   重新開始對戰",
        };
        var back = _session?.Kind switch
        {
            NativeSessionKind.Campaign => "Q / BACKSPACE   返回任務選擇",
            NativeSessionKind.Zombies => "Q / BACKSPACE   返回殭屍模式",
            NativeSessionKind.Online => "Q / BACKSPACE   離開伺服器",
            _ => "Q / BACKSPACE   返回快速對戰",
        };
        font.DrawCentered("暫停", height * 0.29f, 46, Ink);
        if (campaign)
        {
            DrawCenteredMenuItem("ENTER / ESC   繼續", height * .40f, panelWidth - 36, _pauseSelection == 0);
            DrawCenteredMenuItem("F5   快速存檔", height * .46f, panelWidth - 36, _pauseSelection == 1);
            DrawCenteredMenuItem(_campaignSaveAvailable ? "F9   快速讀檔" : "F9   尚無快速存檔",
                height * .52f, panelWidth - 36, _pauseSelection == 2);
            DrawCenteredMenuItem(restart, height * .58f, panelWidth - 36, _pauseSelection == 3);
            DrawCenteredMenuItem(back, height * .64f, panelWidth - 36, _pauseSelection == 4);
            if (!string.IsNullOrWhiteSpace(_announcement) && _announcementTime > 0)
                font.DrawCenteredOutlined(_announcement, height * .71f, 14,
                    _campaignSaveAvailable ? new Color(120, 235, 145, 255) : Accent);
        }
        else
        {
            DrawCenteredMenuItem("ENTER / ESC   繼續", height * .43f, panelWidth - 36, _pauseSelection == 0);
            DrawCenteredMenuItem(restart, height * .50f, panelWidth - 36, _pauseSelection == 1);
            DrawCenteredMenuItem(back, height * .57f, panelWidth - 36, _pauseSelection == 2);
        }
    }

    private void DrawResultsOverlay()
    {
        if (_session is null) return;
        var font = RequireFont();
        var width = Raylib.GetScreenWidth();
        var height = Raylib.GetScreenHeight();
        Raylib.DrawRectangle(0, 0, width, height, new Color(4, 6, 8, 205));
        var panelWidth = Math.Min(660, width - 80);
        Raylib.DrawRectangleRounded(new Rectangle((width - panelWidth) / 2f, height * .18f, panelWidth, 470),
            .03f, 7, Panel);
        var mission = _session.Mission;
        var campaign = _session.Campaign;
        var zombieRuntime = _session.CaptureZombiesRuntime();
        var isCampaign = mission is not null && campaign is not null;
        var isZombies = zombieRuntime is not null;
        var winner = _session.World.Match.Winner;
        var draw = !isCampaign && !isZombies && winner is null;
        var victory = !draw && (winner == Team.None || winner == _session.Player.Team);
        var heading = isCampaign ? "任務完成" : isZombies ? "生存結束" : draw ? "平手" : victory ? "勝利" : "落敗";
        font.DrawCentered(heading, height * .24f, 50,
            isZombies || draw ? Accent : victory ? new Color(86, 210, 126, 255) : new Color(235, 70, 55, 255));
        font.DrawCentered(isCampaign ? mission!.Name : isZombies ? $"最高回合  {zombieRuntime!.HighestRound}" :
            _session.Simulation.Mode.Name, height * .34f, 30, Ink);
        font.DrawCentered(isCampaign ? mission!.Outro : _session.Map.Name, height * .42f, 17, DimInk);
        if (campaign is not null)
            font.DrawCentered($"時間  {campaign.State.Elapsed / 60:0}:{campaign.State.Elapsed % 60:00}",
                height * .51f, 17, Ink);
        else
            font.DrawCentered($"時間  {_session.Elapsed / 60:0}:{_session.Elapsed % 60:00}", height * .51f, 17, Ink);
        var localZombie = zombieRuntime?.Survivors.FirstOrDefault(value => value.PlayerId == _session.Player.Id);
        font.DrawCentered(isZombies
                ? $"擊殺  {localZombie?.Kills ?? 0}     倒地  {localZombie?.Downs ?? 0}     點數  {localZombie?.TotalEarned ?? 0}"
                : $"擊殺  {_session.Player.Kills}     死亡  {_session.Player.Deaths}     得分  {_session.Player.Score:0}",
            height * .56f, 17, Ink);
        var hasNext = mission is not null && CampaignCatalog.NextMission(mission.Id) is not null;
        var primary = isCampaign ? hasNext ? "ENTER  下一章" : "ENTER  返回戰役選擇" : "ENTER  再來一場";
        DrawCenteredMenuItem(primary, height * .66f, panelWidth - 36, _resultsSelection == 0);
        DrawCenteredMenuItem(isCampaign ? "ESC  返回任務選擇" : isZombies ? "ESC  返回殭屍模式" :
                _session.Kind == NativeSessionKind.Online ? "ESC  返回連線對戰" : "ESC  返回快速對戰",
            height * .71f, panelWidth - 36, _resultsSelection == 1, 14);
    }

    private void DrawMenuBackdrop()
    {
        var width = Raylib.GetScreenWidth();
        var height = Raylib.GetScreenHeight();
        Raylib.DrawRectangleGradientV(0, 0, width, height, new Color(20, 26, 31, 255), Background);
        for (var x = -height; x < width + height; x += 92)
            Raylib.DrawLine(x, height, x + height, 0, new Color(255, 122, 41, 10));
        Raylib.DrawRectangle(width - Math.Max(420, width / 3), 0, Math.Max(420, width / 3), height,
            new Color(0, 0, 0, 55));
    }

    private void LoadBranding()
    {
        var logoPath = Path.Combine(AppContext.BaseDirectory, "Assets", "operation-vanguard-logo.png");
        if (!File.Exists(logoPath)) return;

        var image = Raylib.LoadImage(logoPath);
        if (!Raylib.IsImageValid(image)) return;

        Raylib.SetWindowIcon(image);
        _logoTexture = Raylib.LoadTextureFromImage(image);
        _logoLoaded = Raylib.IsTextureValid(_logoTexture);
        Raylib.UnloadImage(image);
    }

    /// <summary>
    /// Tracks a vertical menu with the pointer. Returns 1 for a left click,
    /// -1 for a right click, and 0 when the hovered row was not activated.
    /// </summary>
    private int UpdateMouseRows(ref int selection, float x, float top, float width, float rowHeight,
        int count, float yOffset = -10, float hitHeight = 43)
    {
        var mouse = Raylib.GetMousePosition();
        for (var index = 0; index < count; index++)
        {
            var bounds = new Rectangle(x - 13, top + index * rowHeight + yOffset, width, hitHeight);
            if (!Raylib.CheckCollisionPointRec(mouse, bounds)) continue;
            if (selection != index)
            {
                selection = index;
                _audio?.Play(Cue.UiMove);
            }
            if (Raylib.IsMouseButtonPressed(MouseButton.Left)) return 1;
            if (Raylib.IsMouseButtonPressed(MouseButton.Right)) return -1;
            return 0;
        }
        return 0;
    }

    private void DrawMenuItem(string label, int x, float y, int width, bool selected)
    {
        var font = RequireFont();
        if (selected)
        {
            Raylib.DrawRectangle(x - 13, (int)y - 10, 4, 43, Accent);
            Raylib.DrawRectangleGradientH(x, (int)y - 10, width, 43,
                new Color(255, 122, 41, 34), new Color(255, 122, 41, 0));
        }
        font.Draw(label, x + 8, y, 24, selected ? Ink : DimInk, 1);
    }

    private void DrawCenteredMenuItem(string label, float y, float width, bool selected, float size = 18)
    {
        var x = (Raylib.GetScreenWidth() - width) / 2f;
        if (selected)
        {
            Raylib.DrawRectangleGradientH((int)x, (int)y - 8, (int)width, 34,
                new Color(255, 122, 41, 0), new Color(255, 122, 41, 32));
            Raylib.DrawRectangleGradientH((int)(x + width / 2), (int)y - 8, (int)(width / 2), 34,
                new Color(255, 122, 41, 32), new Color(255, 122, 41, 0));
        }
        var font = RequireFont();
        var textWidth = font.Measure(label, size).X;
        font.Draw(label, (Raylib.GetScreenWidth() - textWidth) / 2f, y, size, selected ? Accent : Ink);
    }

    private void DrawWrapped(string text, float x, float y, float width, float size, float lineHeight, Color color)
    {
        var font = RequireFont();
        var line = new List<string>();
        var cursorY = y;
        var effectiveLineHeight = Math.Max(lineHeight, font.Measure("國", size).Y + 3);
        foreach (var rune in text.EnumerateRunes())
        {
            var candidate = string.Concat(line) + rune;
            if (line.Count > 0 && font.Measure(candidate, size).X > width)
            {
                font.Draw(string.Concat(line), x, cursorY, size, color);
                line.Clear();
                cursorY += effectiveLineHeight;
            }
            line.Add(rune.ToString());
        }
        if (line.Count > 0) font.Draw(string.Concat(line), x, cursorY, size, color);
    }

    private void DrawWrappedOutlined(
        string text,
        float x,
        float y,
        float width,
        float size,
        float lineHeight,
        Color color)
    {
        var font = RequireFont();
        var line = new List<string>();
        var cursorY = y;
        var effectiveLineHeight = Math.Max(lineHeight, font.Measure("國", size).Y + 3);
        foreach (var rune in text.EnumerateRunes())
        {
            var candidate = string.Concat(line) + rune;
            if (line.Count > 0 && font.Measure(candidate, size).X > width)
            {
                font.DrawOutlined(string.Concat(line), x, cursorY, size, color);
                line.Clear();
                cursorY += effectiveLineHeight;
            }
            line.Add(rune.ToString());
        }
        if (line.Count > 0) font.DrawOutlined(string.Concat(line), x, cursorY, size, color);
    }

    private void DrawCaptionCentered(string text, float y, float size, Color color)
    {
        var font = RequireFont();
        var measured = font.Measure(text, size);
        var x = (Raylib.GetScreenWidth() - measured.X) / 2f;
        Raylib.DrawRectangleRounded(new Rectangle(x - 18, y - 9, measured.X + 36, measured.Y + 18),
            .16f, 7, new Color(0, 0, 0, 188));
        font.DrawOutlined(text, x, y, size, color);
    }

    private UiFont RequireFont() => _font ?? throw new InvalidOperationException("UI font is not initialized.");

    private string? OptionValue(string option)
    {
        var index = Array.FindIndex(_args, value => string.Equals(value, option, StringComparison.OrdinalIgnoreCase));
        return index >= 0 && index + 1 < _args.Length ? _args[index + 1] : null;
    }

    private static AppScreen ParseScreen(string value) => value.ToLowerInvariant() switch
    {
        "main" => AppScreen.Main,
        "skirmish" => AppScreen.Skirmish,
        "campaign" => AppScreen.Campaign,
        "zombies" => AppScreen.Zombies,
        "online" => AppScreen.Online,
        "loadout" => AppScreen.Loadout,
        "settings" => AppScreen.Settings,
        "controls" => AppScreen.Controls,
        _ => throw new ArgumentException($"Unknown native screen '{value}'."),
    };

    private static string DifficultyName(DifficultyId difficulty) => difficulty switch
    {
        DifficultyId.Recruit => "新兵",
        DifficultyId.Regular => "正規",
        DifficultyId.Hardened => "老兵",
        DifficultyId.Veteran => "專家",
        _ => difficulty.ToString(),
    };

    private static string FailureName(FailureReason reason) => reason switch
    {
        FailureReason.PlayerDown => "先鋒陣亡",
        FailureReason.AllyLost => "關鍵盟軍陣亡",
        FailureReason.OutOfTime => "超過時限",
        _ => "任務中止",
    };

    private static string MatchPhaseName(MatchPhase phase) => phase switch
    {
        MatchPhase.Warmup => "準備中",
        MatchPhase.Live => "交戰中",
        MatchPhase.Overtime => "延長賽",
        MatchPhase.RoundEnd => "回合結束",
        MatchPhase.MatchEnd => "對戰結束",
        _ => phase.ToString(),
    };

    private static string ZombiePhaseName(RoundPhase phase) => phase switch
    {
        RoundPhase.Intermission => "回合間歇",
        RoundPhase.Active => "屍潮進行中",
        RoundPhase.GameOver => "全隊倒下",
        _ => phase.ToString(),
    };

    private static string TeamName(Team team) => team switch
    {
        Team.Allies => "盟軍",
        Team.Axis => "軸心",
        Team.Hostile => "敵軍",
        _ => "個人",
    };

    private static string OnOff(bool value) => value ? "開" : "關";

    private void RecordMissionResult()
    {
        if (_missionResultRecorded || _session?.Mission is null || _session.Campaign is null) return;
        _missionResultRecorded = true;
        _profile.CompletedMissions.Add(_session.Mission.Id);
        _profile.Stats.Matches++;
        _profile.Stats.Wins++;
        _profile.Stats.Kills += _session.Player.Kills;
        _profile.Stats.Deaths += _session.Player.Deaths;
        _profile.Stats.Assists += _session.Player.Assists;
        _profile.Stats.Headshots += _session.Player.Headshots;
        _profile.Stats.Score += _session.Player.Score;
        _profile.Stats.TimePlayed += _session.Campaign.State.Elapsed;
        _profile.Xp += _session.Player.Score * GameConstants.XpPerScore;
        ApplyRankProgression();
        ProfileStore.Save(_profile);
    }

    private void RecordSkirmishResult()
    {
        if (_missionResultRecorded || _session is null) return;
        _missionResultRecorded = true;
        var winner = _session.World.Match.Winner;
        _profile.Stats.Matches++;
        if (winner == Team.None || winner == _session.Player.Team) _profile.Stats.Wins++;
        _profile.Stats.Kills += _session.Player.Kills;
        _profile.Stats.Deaths += _session.Player.Deaths;
        _profile.Stats.Assists += _session.Player.Assists;
        _profile.Stats.Headshots += _session.Player.Headshots;
        _profile.Stats.Score += _session.Player.Score;
        _profile.Stats.TimePlayed += _session.World.Time;
        _profile.Xp += _session.Player.Score * GameConstants.XpPerScore;
        ApplyRankProgression();
        ProfileStore.Save(_profile);
    }

    private void RecordZombiesResult()
    {
        if (_missionResultRecorded || _session?.Zombies is null) return;
        _missionResultRecorded = true;
        var state = _session.Zombies.Players.GetValueOrDefault(_session.Player.Id);
        _profile.Stats.Matches++;
        _profile.Stats.Kills += state?.Kills ?? _session.Player.Kills;
        _profile.Stats.Deaths += _session.Player.Deaths;
        _profile.Stats.Assists += _session.Player.Assists;
        _profile.Stats.Headshots += _session.Player.Headshots;
        _profile.Stats.Score += _session.Player.Score;
        _profile.Stats.TimePlayed += _session.Elapsed;
        _profile.Stats.HighestZombieRound = Math.Max(
            _profile.Stats.HighestZombieRound,
            _session.Zombies.State.HighestRound);
        _profile.Xp += _session.Player.Score * GameConstants.XpPerScore;
        ApplyRankProgression();
        ProfileStore.Save(_profile);
    }

    private void ApplyRankProgression()
    {
        var rankedUp = false;
        while (_profile.Rank < GameConstants.MaxRank &&
               _profile.Xp >= ProfileStore.XpForRank(_profile.Rank + 1))
        {
            _profile.Rank++;
            rankedUp = true;
        }
        if (rankedUp) _audio?.Play(Cue.UiAccept, 1, 1.3f);
    }

    private void RecordAbandonedSession()
    {
        if (_missionResultRecorded || _session is null) return;
        if (_session.Kind == NativeSessionKind.Zombies)
        {
            RecordZombiesResult();
            return;
        }
        _missionResultRecorded = true;
        _profile.Stats.Matches++;
        _profile.Stats.Kills += _session.Player.Kills;
        _profile.Stats.Deaths += _session.Player.Deaths;
        _profile.Stats.Assists += _session.Player.Assists;
        _profile.Stats.Headshots += _session.Player.Headshots;
        _profile.Stats.Score += _session.Player.Score;
        _profile.Stats.TimePlayed += _session.Campaign?.State.Elapsed ?? _session.World.Time;
        _profile.Xp += _session.Player.Score * GameConstants.XpPerScore;
        ApplyRankProgression();
        ProfileStore.Save(_profile);
    }

    private static int Wrap(int value, int count) => count <= 0 ? 0 : (value % count + count) % count;

    private static DifficultyId DifficultyIdFromIndex(int index) => index switch
    {
        0 => DifficultyId.Recruit,
        2 => DifficultyId.Hardened,
        3 => DifficultyId.Veteran,
        _ => DifficultyId.Regular,
    };

    private static Color FromHex(int value) => new((value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff, 255);
    private static Vector3 ToNumerics(Vec3 value) => new((float)value.X, (float)value.Y, (float)value.Z);

    private void PlayTickAudio(NativeSession session)
    {
        foreach (var simEvent in session.LastEvents)
        {
            switch (simEvent)
            {
                case FootstepEvent footstep:
                    {
                        var spatial = SpatialAudio(session.Player, footstep.Position, footstep.Player == session.Player.Id
                            ? 1d
                            : footstep.Loud ? 32d : 18d);
                        _audio?.PlayFootstep(footstep.Surface, footstep.Loud,
                            .72f * spatial.Volume, spatial.Pan);
                        break;
                    }
                case ShotEvent shot:
                    {
                        var weapon = WeaponData.TryGetWeapon(shot.WeaponId);
                        if (weapon is null) break;
                        var spatial = SpatialAudio(session.Player, shot.Origin,
                            shot.Player == session.Player.Id ? 1d : 90d);
                        _audio?.PlayWeapon(weapon, .82f * spatial.Volume, spatial.Pan);
                        break;
                    }
                case HitEvent hit when hit.Attacker == session.Player.Id:
                    _audio?.Play(Cue.Hit, hit.Lethal ? .8f : .5f,
                        hit.Location == HitLocation.Head ? 1.25f : 1f);
                    break;
                case ExplosionEvent explosion:
                    {
                        var spatial = SpatialAudio(session.Player, explosion.Position,
                            Math.Max(35d, explosion.Radius * 8d));
                        _audio?.Play(Cue.Explosion, .9f * spatial.Volume, 1f, spatial.Pan);
                        break;
                    }
                case GenericSimEvent generic when generic.Player == session.Player.Id &&
                                                  generic.Type == SimEventType.Jump:
                    _audio?.Play(Cue.Jump, .65f);
                    break;
                case GenericSimEvent generic when generic.Player == session.Player.Id &&
                                                  generic.Type == SimEventType.Land:
                    _audio?.Play(Cue.Land, .7f);
                    break;
            }
        }
    }

    private static (float Volume, float Pan) SpatialAudio(PlayerState listener, Vec3 position, double range)
    {
        var dx = position.X - listener.Position.X;
        var dy = position.Y - listener.Position.Y;
        var dz = position.Z - listener.Position.Z;
        var distance = Math.Sqrt(dx * dx + dy * dy + dz * dz);
        var volume = (float)Math.Clamp(1d - distance / Math.Max(1d, range), 0d, 1d);
        if (distance < .001d) return (volume, .5f);
        var rightX = Math.Cos(listener.Yaw);
        var rightZ = -Math.Sin(listener.Yaw);
        var side = (dx * rightX + dz * rightZ) / distance;
        return (volume, (float)Math.Clamp(.5d + side * .45d, 0d, 1d));
    }

    private void ObservePresentationEvents(NativeSession session)
    {
        foreach (var simEvent in session.LastEvents)
        {
            switch (simEvent)
            {
                case ShotEvent shot when shot.Player == session.Player.Id:
                    {
                        var weapon = WeaponData.TryGetWeapon(shot.WeaponId) ??
                                     session.Simulation.ActiveWeaponDef(session.Player);
                        if (weapon.Recoil.Pattern.Count > 0)
                        {
                            var recoil = weapon.Recoil.Pattern[Math.Clamp(
                                shot.ShotIndex,
                                0,
                                weapon.Recoil.Pattern.Count - 1)];
                            _input.ApplyRecoil(recoil.Pitch, recoil.Yaw);
                        }
                        break;
                    }
                case GenericSimEvent { Type: SimEventType.Spawn, Player: { } playerId }
                    when playerId == session.Player.Id:
                    _input.SetViewAngles(session.Player.Yaw, 0);
                    _eyeHeight = Movement.CurrentHeight(session.Player);
                    break;
                case HitEvent hit when hit.Attacker == session.Player.Id:
                    _hitMarkerTime = hit.Lethal ? .24 : .12;
                    break;
                case DamageEvent damage when damage.Victim == session.Player.Id:
                    _damageOverlayTime = Math.Max(_damageOverlayTime, .85);
                    break;
                case KillEvent kill:
                    {
                        var killer = PlayerName(session.World, kill.Killer);
                        var victim = PlayerName(session.World, kill.Victim);
                        var headshot = kill.Headshot ? "  ◇" : string.Empty;
                        AddFeed($"{killer}  ›  {victim}{headshot}",
                            kill.Killer == session.Player.Id ? Accent : Ink);
                        break;
                    }
                case AnnounceEvent announce when announce.Team is Team.None ||
                                                  announce.Team == session.Player.Team:
                    _announcement = announce.Line;
                    _announcementTime = 3;
                    break;
                case ScoreEvent score when score.Player == session.Player.Id:
                    _scorePopup = $"+{score.Amount:0}  {score.Reason}";
                    _scorePopupTime = 1.4;
                    break;
                case GenericSimEvent generic when generic.Type is SimEventType.ObjectiveCaptured or
                    SimEventType.ObjectiveNeutralized or SimEventType.BombPlanted or SimEventType.BombDefused:
                    AddFeed(EventName(generic.Type), Accent);
                    break;
            }
        }
    }

    private void AdvancePresentation(double deltaTime)
    {
        _hitMarkerTime = Math.Max(0, _hitMarkerTime - deltaTime);
        _damageOverlayTime = Math.Max(0, _damageOverlayTime - deltaTime);
        _announcementTime = Math.Max(0, _announcementTime - deltaTime);
        _scorePopupTime = Math.Max(0, _scorePopupTime - deltaTime);
        foreach (var line in _feed) line.Remaining -= deltaTime;
        _feed.RemoveAll(line => line.Remaining <= 0);
    }

    private void AddFeed(string value, Color color)
    {
        _feed.Insert(0, new FeedLine(value, color, 4.5));
        if (_feed.Count > 6) _feed.RemoveRange(6, _feed.Count - 6);
    }

    private static string PlayerName(WorldState world, int id) =>
        world.Players.TryGetValue(id, out var player) ? player.Name : id == 0 ? "環境" : $"#{id}";

    private static string EventName(SimEventType type) => type switch
    {
        SimEventType.ObjectiveCaptured => "目標已佔領",
        SimEventType.ObjectiveNeutralized => "目標已中立化",
        SimEventType.BombPlanted => "炸彈已安裝",
        SimEventType.BombDefused => "炸彈已拆除",
        _ => type.ToString(),
    };

    private sealed class FeedLine(string text, Color color, double remaining)
    {
        public string Text { get; } = text;
        public Color Color { get; } = color;
        public double Remaining { get; set; } = remaining;
    }

    private enum AppScreen
    {
        Main,
        Skirmish,
        Campaign,
        Zombies,
        Online,
        Connecting,
        Loadout,
        Settings,
        Controls,
        Playing,
        Paused,
        Results,
    }
}
