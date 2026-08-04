# Operation Vanguard for C#/.NET

This directory contains the native .NET 10 implementation of Operation Vanguard.
The deterministic game rules live in `OperationVanguard.Core`; the renderer and local
game loop live in `OperationVanguard.Game`; and the authoritative WebSocket host lives
in `OperationVanguard.Server`.

The implementation intentionally uses `double` for gameplay state and explicit 32-bit
overflow in the random/hash code. Those choices match JavaScript's numeric behavior and
allow golden traces from the original implementation in [`../web/`](../web/) to serve as
cross-language parity fixtures.

## Requirements

- .NET 10 SDK
- A desktop with OpenGL support to run the graphical client

The game uses Raylib-cs for cross-platform rendering, input, and audio. Tests and the
dedicated server do not initialize graphics and can run headlessly.

## Commands

```powershell
# From dotnet/
dotnet restore OperationVanguard.sln
dotnet build OperationVanguard.sln -c Release
dotnet test OperationVanguard.sln -c Release
dotnet run --project src/OperationVanguard.Game
dotnet run --project src/OperationVanguard.Game -- --validate
dotnet run --project src/OperationVanguard.Server -- --map crossfire --mode tdm --bots 6
dotnet run --project src/OperationVanguard.Game -- --online ws://localhost:8790
```

Run these commands from this directory, or prefix the paths with `dotnet/` from the
repository root.

To publish a self-contained Windows build for the current user and add it to the
Start Menu, run:

```powershell
.\install-start-menu.ps1
```

The installer publishes to `%LOCALAPPDATA%\Programs\Operation Vanguard` and creates
`Operation Vanguard.lnk` in the current user's Start Menu Programs folder.

The graphical client also accepts deterministic launch options used by the smoke
suite. For example:

```powershell
dotnet run --project src/OperationVanguard.Game -- --mission cold_open --smoke screenshots/cold-open.png
dotnet run --project src/OperationVanguard.Game -- --mode zombies --map crossfire --bots 3
dotnet run --project src/OperationVanguard.Game -- --mode domination --map refinery --bots 8
```

The desktop client starts fullscreen. Press `F11` to toggle fullscreen at runtime,
or pass `--windowed` when launching it for development. Menus support pointer hover,
left-click activation, right-click reverse adjustment, and mouse-wheel navigation;
gameplay uses captured mouse-look and the configured mouse-button bindings.

## Campaign saves

The native campaign has one durable quick-save slot that can be used at any point:

- Press `F5` during a campaign to save the current mission progress.
- Press `F9` to load that progress immediately.
- Press `Esc` to pause; the **Quick Save** and **Quick Load** rows can also be clicked.

The save retains the current mission and objectives, player position and view, health,
armor, weapons, ammunition, equipment, and field-upgrade charge. Loading reconstructs
the active encounter and establishes a checkpoint at the restored position. The file is
stored at `%LOCALAPPDATA%\OperationVanguard\campaign-quicksave.json`, so it survives
closing, updating, or reinstalling the game. Quick saves apply to the offline campaign;
competitive, online, and Zombies sessions continue to use their normal match lifecycle.

## Refreshing parity data

Canonical data and golden traces are generated from the web implementation. After
changing shared web rules, regenerate them before building .NET:

```powershell
cd ../web
npm ci
npm run export:dotnet
cd ../dotnet
dotnet run --project src/OperationVanguard.Game -- --validate
dotnet test OperationVanguard.sln -c Release
```

CI rejects modified or newly generated parity files, stale `web/offline/` output,
content-validation failures, protocol regressions, or a build that cannot start a
real browser and WebSocket match.
