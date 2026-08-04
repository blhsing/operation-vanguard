using OperationVanguard.Core;

namespace OperationVanguard.Game;

/// <summary>
/// Owns the same simulation/director stack used by the web client for a campaign
/// mission. Presentation reads this adapter; all gameplay remains in Core.
/// </summary>
public sealed class LocalSession
{
    private static readonly string[] BotNames =
    [
        "Reyes", "Vasquez", "Kovac", "Mori", "Hale", "Dunn", "Bergman", "Ives",
        "Cortez", "Novak", "Rhodes", "Sato", "Ferrari", "Okonkwo", "Lindqvist",
        "Petrov", "Nakamura", "Ackerman", "Bauer", "Mercer", "Fontaine", "Sokolov",
        "Delgado", "Whitlock",
    ];

    public LocalSession(
        MissionDef mission,
        string playerName,
        Loadout loadout,
        CampaignSaveSnapshot? save = null)
    {
        Mission = mission;
        Simulation = new GameSimulation(new GameOptions
        {
            MapId = mission.MapId,
            ModeId = "campaign",
        });
        Navigation = new NavGraph(Simulation.Map, Simulation.Collision);
        Bots = new BotController(Simulation, Navigation, new Rng(Rng.HashString(mission.MapId)));
        Campaign = new CampaignDirector(
            Simulation,
            Navigation,
            Bots,
            new Rng(Rng.HashString($"{mission.Id}:cmp")),
            mission);

        Player = Simulation.AddPlayer(new AddPlayerOptions
        {
            Name = playerName,
            Team = Team.Allies,
            Loadout = loadout,
        });
        Campaign.Begin(Player);
        if (save is not null) Campaign.RestoreSave(Player, save);
    }

    public LocalSession(
        string mapId,
        string modeId,
        int botCount,
        DifficultyId difficulty,
        string playerName,
        Loadout loadout)
    {
        Simulation = new GameSimulation(new GameOptions { MapId = mapId, ModeId = modeId });
        Navigation = new NavGraph(Simulation.Map, Simulation.Collision);
        Bots = new BotController(Simulation, Navigation, new Rng(Rng.HashString(mapId)));
        Player = Simulation.AddPlayer(new AddPlayerOptions
        {
            Name = playerName,
            Team = Simulation.Mode.TeamBased ? Team.Allies : Team.None,
            Loadout = loadout,
        });

        var botDifficulty = BotData.Get(difficulty);
        for (var index = 0; index < Math.Clamp(botCount, 0, GameConstants.MaxPlayers - 1); index++)
        {
            var archetype = LoadoutSystem.BotArchetypes[index % LoadoutSystem.BotArchetypes.Count];
            var team = Simulation.Mode.TeamBased
                ? index % 2 == 0 ? Team.Axis : Team.Allies
                : Team.None;
            var bot = Simulation.AddPlayer(new AddPlayerOptions
            {
                Name = BotNames[index % BotNames.Length],
                Team = team,
                IsBot = true,
                BotSkill = .5,
                Loadout = LoadoutSystem.BotLoadout(archetype, index),
            });
            var enemy = SimulationTypes.IsEnemyTeam(Player.Team, team);
            Bots.Register(bot.Id, archetype, botDifficulty,
                enemy ? BotData.EnemyMovementScale : 1d,
                enemy ? BotData.EnemyAggressionScale : 1d);
            if (enemy)
                Simulation.SetOutgoingDamageScale(bot.Id, BotData.EnemyDamageScale);
        }
    }

    public MissionDef? Mission { get; }
    public GameSimulation Simulation { get; }
    public NavGraph Navigation { get; }
    public BotController Bots { get; }
    public CampaignDirector? Campaign { get; }
    public MapDef Map => Simulation.Map;
    public BrushCollisionWorld Collision => Simulation.Collision;
    public WorldState World => Simulation.World;
    public PlayerState Player { get; }
    public InputCommand LastInput { get; private set; } = new();
    public IReadOnlyList<SimEvent> LastEvents { get; private set; } = [];

    public void Tick(InputCommand input, double deltaTime)
    {
        LastInput = input;
        if (!Player.Alive && Player.RespawnTimer <= 0d &&
            SimulationTypes.HasFlag(input.Buttons, InputFlag.Fire))
        {
            Simulation.RequestRespawn(Player.Id);
        }
        Simulation.SetInput(Player.Id, input);
        Campaign?.SetUsing(Player.Id, SimulationTypes.HasFlag(input.Buttons, InputFlag.Use));
        Bots.Update(deltaTime);

        var events = Simulation.Step(deltaTime);
        if (Campaign is not null)
        {
            var campaignEvents = Campaign.Step(deltaTime, events);
            if (campaignEvents.Length > 0) events.AddRange(campaignEvents);
        }
        LastEvents = events;
    }
}
