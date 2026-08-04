# 先鋒行動 Operation Vanguard

Operation Vanguard is maintained as two sibling implementations:

- [`dotnet/`](dotnet/) — the C#/.NET 10 implementation.
- [`web/`](web/) — the original TypeScript browser implementation and its standalone build.

Both implementations share the same gameplay contract: six maps, competitive multiplayer,
Zombies, and one six-mission campaign. The web implementation remains the executable parity
reference while the .NET implementation is verified against its deterministic data and
simulation fixtures.

## Quick start

### C#/.NET

```powershell
dotnet run --project dotnet/src/OperationVanguard.Game
```

### Web

```powershell
cd web
npm install
npm run dev
```

The prebuilt browser version can also be opened directly from
[`web/offline/index.html`](web/offline/index.html).

The native .NET campaign supports durable progress saves at any point: press `F5` to
quick-save and `F9` to quick-load, or click the corresponding rows in the pause menu.
See the .NET guide for the save location and complete desktop controls.

See [`dotnet/README.md`](dotnet/README.md) and [`web/README.md`](web/README.md) for
implementation-specific commands and architecture notes.

## License

MIT — see [`LICENSE`](LICENSE).
