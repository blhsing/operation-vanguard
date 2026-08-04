using OperationVanguard.Core;
using OperationVanguard.Game;

namespace OperationVanguard.Game.Tests;

public sealed class LocalSessionTests
{
    [Fact]
    public void SkirmishUsesCanonicalDefaultSeedAndLobbyNames()
    {
        var session = new LocalSession(
            "shipment_yard",
            "tdm",
            3,
            DifficultyId.Regular,
            "Alice",
            LoadoutSystem.DefaultLoadout("Test"));

        Assert.Equal(Rng.HashString("shipment_yard:tdm"), session.World.RngState);
        Assert.Equal(
            ["Reyes", "Vasquez", "Kovac"],
            session.World.Players.Values.Where(player => player.IsBot).Select(player => player.Name));
    }

    [Fact]
    public void DeadHumanRequestsRespawnByPressingFire()
    {
        var session = new LocalSession(
            "shipment_yard",
            "tdm",
            0,
            DifficultyId.Regular,
            "Alice",
            LoadoutSystem.DefaultLoadout("Test"));

        session.Tick(Command(InputFlag.None, 1), GameConstants.TickDt);
        Assert.True(session.Player.Alive);
        session.Player.Alive = false;
        session.Player.RespawnTimer = 0;

        session.Tick(Command(InputFlag.None, 2), GameConstants.TickDt);
        Assert.False(session.Player.Alive);

        session.Tick(Command(InputFlag.Fire, 3), GameConstants.TickDt);
        Assert.True(session.Player.Alive);
    }

    [Fact]
    public void EnemyBotsUseReducedAggressionWithoutWeakeningFriendlyBots()
    {
        var session = new LocalSession(
            "shipment_yard",
            "tdm",
            2,
            DifficultyId.Regular,
            "Alice",
            LoadoutSystem.DefaultLoadout("Test"));
        var bots = session.World.Players.Values.Where(player => player.IsBot).ToArray();
        var enemy = Assert.Single(bots, player => player.Team == Team.Axis);
        var friendly = Assert.Single(bots, player => player.Team == Team.Allies);

        Assert.Equal(
            BotData.EnemyAggressionScale,
            Assert.IsType<BotBrain>(session.Bots.GetBrain(enemy.Id)).AggressionScale);
        Assert.Equal(
            1d,
            Assert.IsType<BotBrain>(session.Bots.GetBrain(friendly.Id)).AggressionScale);
    }

    private static InputCommand Command(InputFlag buttons, int tick) => new()
    {
        Tick = tick,
        Dt = GameConstants.TickDt,
        Buttons = (int)buttons,
        KillstreakSlot = -1,
    };
}
