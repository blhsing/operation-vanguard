using System.Collections.ObjectModel;
using OperationVanguard.Core;

namespace OperationVanguard.Game;

/// <summary>Presentation-neutral form of the buy prompt shown by the Zombies HUD.</summary>
public sealed record ZombiesPromptSnapshot(
    string Label,
    int Cost,
    bool Usable,
    string Reason);

/// <summary>The exact set of Zombies values consumed by the web HUD.</summary>
public sealed record ZombiesHudSnapshot(
    int Round,
    RoundPhase Phase,
    int Points,
    IReadOnlyList<string> Perks,
    bool Downed,
    double BleedOut,
    double ReviveProgress,
    int ZombiesAlive,
    ZombiesPromptSnapshot? Prompt);

/// <summary>A frozen view of one survivor's gameplay state for native presentation.</summary>
public sealed record ZombiesSurvivorSnapshot(
    int PlayerId,
    string Name,
    bool IsBot,
    bool Alive,
    double Health,
    double MaxHealth,
    int Points,
    int TotalEarned,
    IReadOnlyList<string> Perks,
    bool Downed,
    double BleedOut,
    double ReviveProgress,
    int Reviver,
    bool BledOut,
    int Kills,
    int Downs,
    int Revives,
    IReadOnlyList<string> OwnedWallWeapons,
    IReadOnlyList<string> UpgradedWeapons);

/// <summary>A frozen view of the director state used by menus, scoreboards, and results.</summary>
public sealed record ZombiesRuntimeSnapshot(
    int Round,
    RoundPhase Phase,
    int RemainingToSpawn,
    double SpawnTimer,
    double IntermissionTimer,
    bool PowerOn,
    int HighestRound,
    IReadOnlyList<string> OpenZones,
    IReadOnlyList<ZombiesSurvivorSnapshot> Survivors);

/// <summary>
/// Owns the native offline Zombies stack. Its setup and tick order mirror the
/// web client: local interaction edge, co-op bots, simulation, then director.
/// The class has no Raylib dependency; rendering only consumes its snapshots.
/// </summary>
public sealed class ZombiesSession : IDisposable
{
    private static readonly string[] BotNames =
    [
        "Reyes", "Vasquez", "Kovac", "Mori", "Hale", "Dunn", "Bergman", "Ives",
        "Cortez", "Novak", "Rhodes", "Sato", "Ferrari", "Okonkwo", "Lindqvist",
        "Petrov", "Nakamura", "Ackerman", "Bauer", "Mercer", "Fontaine", "Sokolov",
        "Delgado", "Whitlock",
    ];

    private readonly List<PlayerState> _teammates = [];
    private readonly ReadOnlyCollection<PlayerState> _readOnlyTeammates;
    private bool _usePressed;
    private bool _disposed;

    public ZombiesSession(
        string mapId,
        int botTeammates,
        DifficultyId difficulty,
        string playerName,
        Loadout loadout,
        string? seed = null)
    {
        Seed = seed;
        Difficulty = difficulty;
        Data = ZombieMaps.Get(mapId);

        Simulation = new GameSimulation(new GameOptions
        {
            MapId = mapId,
            ModeId = "zombies",
            Seed = seed,
        });
        Navigation = new NavGraph(Simulation.Map, Simulation.Collision);

        // These are deliberately independent streams, matching GameClient.
        var clientSeed = seed ?? mapId;
        Bots = new BotController(
            Simulation,
            Navigation,
            new Rng(Rng.HashString(clientSeed)));
        Director = new ZombiesDirector(
            Simulation,
            Navigation,
            new Rng(Rng.HashString($"{clientSeed}:zm")),
            Data);

        Player = Simulation.AddPlayer(new AddPlayerOptions
        {
            Name = playerName,
            Team = Team.Allies,
            Loadout = loadout,
        });
        PlaceAtZombieSpawn(Player, SpawnAt(0));
        Director.AddSurvivor(Player);

        var partnerCount = Math.Clamp(botTeammates, 0, 3);
        var botDifficulty = BotData.Get(difficulty);
        for (var index = 0; index < partnerCount; index++)
        {
            var archetype = LoadoutSystem.BotArchetypes[index % LoadoutSystem.BotArchetypes.Count];
            var bot = Simulation.AddPlayer(new AddPlayerOptions
            {
                Name = BotNames[index % BotNames.Length],
                Team = Team.Allies,
                IsBot = true,
                BotSkill = 0.6d,
                Loadout = loadout,
            });
            PlaceAtZombieSpawn(bot, SpawnAt(index + 1));
            Director.AddSurvivor(bot);
            Bots.Register(bot.Id, archetype, botDifficulty);
            _teammates.Add(bot);
        }

        _readOnlyTeammates = _teammates.AsReadOnly();
    }

    public string? Seed { get; }

    public DifficultyId Difficulty { get; }

    public ZombiesMapData Data { get; }

    public GameSimulation Simulation { get; }

    public NavGraph Navigation { get; }

    public BotController Bots { get; }

    public ZombiesDirector Director { get; }

    public ZombiesState State => Director.State;

    public IReadOnlyDictionary<int, ZombiePlayerState> Players => Director.Players;

    public MapDef Map => Simulation.Map;

    public BrushCollisionWorld Collision => Simulation.Collision;

    public WorldState World => Simulation.World;

    public PlayerState Player { get; }

    public IReadOnlyList<PlayerState> Teammates => _readOnlyTeammates;

    public InputCommand LastInput { get; private set; } = new();

    public IReadOnlyList<SimEvent> LastEvents { get; private set; } = [];

    /// <summary>
    /// Result of a Use-key rising edge in the most recent tick, or null when no
    /// purchase was attempted. This lets presentation play the matching UI cue.
    /// </summary>
    public ZombieInteractionResult? LastInteraction { get; private set; }

    public bool IsGameOver => State.Phase == RoundPhase.GameOver;

    /// <summary>Advance one canonical 64 Hz fixed step.</summary>
    public void Tick(InputCommand input) => Tick(input, GameConstants.TickDt);

    /// <summary>
    /// Advance one step in web order: input and Use edge, friendly bot inputs,
    /// simulation events, then Zombies consumption and director events.
    /// </summary>
    public void Tick(InputCommand input, double deltaTime)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);

        LastInput = input;
        Simulation.SetInput(Player.Id, input);

        LastInteraction = null;
        var usingInteract = SimulationTypes.HasFlag(input.Buttons, InputFlag.Use);
        if (usingInteract && !_usePressed)
        {
            LastInteraction = Director.Interact(Player.Id);
        }
        _usePressed = usingInteract;

        Bots.Update(deltaTime);

        var events = Simulation.Step(deltaTime);
        var zombieEvents = Director.Step(deltaTime, events);
        if (zombieEvents.Count > 0)
        {
            events.AddRange(zombieEvents);
        }
        LastEvents = events;
    }

    /// <summary>Create the exact local-player data contract consumed by the web HUD.</summary>
    public ZombiesHudSnapshot CaptureHud()
    {
        Director.Players.TryGetValue(Player.Id, out var localState);
        var near = Director.InteractableNear(Player.Id);
        var prompt = near is null
            ? null
            : new ZombiesPromptSnapshot(
                near.Def.Label,
                near.Cost,
                near.Usable,
                near.Reason);

        return new ZombiesHudSnapshot(
            State.Round,
            State.Phase,
            localState?.Points ?? 0,
            ReadOnly(localState?.Perks),
            localState?.Downed ?? false,
            localState?.BleedOut ?? 0d,
            localState?.ReviveProgress ?? 0d,
            World.Players.Values.Count(player => player.Team == Team.Hostile && player.Alive),
            prompt);
    }

    /// <summary>Create an immutable director/survivor snapshot for native UI and results.</summary>
    public ZombiesRuntimeSnapshot CaptureRuntime()
    {
        var survivors = new List<ZombiesSurvivorSnapshot>(Director.Players.Count);
        foreach (var (playerId, zombieState) in Director.Players)
        {
            if (!World.Players.TryGetValue(playerId, out var player))
            {
                continue;
            }

            survivors.Add(new ZombiesSurvivorSnapshot(
                player.Id,
                player.Name,
                player.IsBot,
                player.Alive,
                player.Health,
                player.MaxHealth,
                zombieState.Points,
                zombieState.TotalEarned,
                ReadOnly(zombieState.Perks),
                zombieState.Downed,
                zombieState.BleedOut,
                zombieState.ReviveProgress,
                zombieState.Reviver,
                zombieState.BledOut,
                zombieState.Kills,
                zombieState.Downs,
                zombieState.Revives,
                ReadOnly(zombieState.OwnedWallWeapons),
                ReadOnly(zombieState.Upgraded)));
        }

        return new ZombiesRuntimeSnapshot(
            State.Round,
            State.Phase,
            State.RemainingToSpawn,
            State.SpawnTimer,
            State.IntermissionTimer,
            State.PowerOn,
            State.HighestRound,
            ReadOnly(State.OpenZones),
            survivors.AsReadOnly());
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        foreach (var teammate in _teammates)
        {
            Bots.Unregister(teammate.Id);
        }
        Director.Dispose();
        _disposed = true;
    }

    private Vec3? SpawnAt(int index)
    {
        var spawns = Data.PlayerSpawns;
        return spawns.Count == 0 ? null : spawns[index % spawns.Count];
    }

    private void PlaceAtZombieSpawn(PlayerState player, Vec3? spawn)
    {
        // Spawning before overriding the authored position preserves web RNG use.
        Simulation.SpawnPlayer(player);
        if (spawn is not null)
        {
            MathEx.Copy(player.Position, spawn);
        }
    }

    private static IReadOnlyList<string> ReadOnly(IEnumerable<string>? values) =>
        Array.AsReadOnly(values?.ToArray() ?? []);
}
