using OperationVanguard.Core;
using OperationVanguard.Game;

namespace OperationVanguard.Tests;

[CollectionDefinition("Zombies session serial", DisableParallelization = true)]
public sealed class ZombiesSessionSerialCollection
{
}

[Collection("Zombies session serial")]
public sealed class ZombiesSessionAdapterTests
{
    public static TheoryData<int, int> PartnerCounts => new()
    {
        { -2, 0 },
        { 0, 0 },
        { 2, 2 },
        { 8, 3 },
    };

    [Theory]
    [MemberData(nameof(PartnerCounts))]
    public void PopulationMatchesWebCoopRules(int requested, int expected)
    {
        using var session = Create(requested);

        Assert.Equal(expected, session.Teammates.Count);
        Assert.Equal(expected + 1, session.Director.Players.Count);
        Assert.Equal(Team.Allies, session.Player.Team);
        Assert.False(session.Player.IsBot);
        AssertPosition(ZombieMaps.Crossfire.PlayerSpawns[0], session.Player.Position);

        var expectedNames = new[] { "Reyes", "Vasquez", "Kovac" }.Take(expected);
        Assert.Equal(expectedNames, session.Teammates.Select(player => player.Name));

        for (var index = 0; index < session.Teammates.Count; index++)
        {
            var teammate = session.Teammates[index];
            Assert.True(teammate.IsBot);
            Assert.Equal(Team.Allies, teammate.Team);
            Assert.Equal(0.6d, teammate.BotSkill);
            AssertPosition(
                ZombieMaps.Crossfire.PlayerSpawns[(index + 1) % ZombieMaps.Crossfire.PlayerSpawns.Count],
                teammate.Position);

            var brain = Assert.IsType<BotBrain>(session.Bots.GetBrain(teammate.Id));
            Assert.Equal(
                LoadoutSystem.BotArchetypes[index % LoadoutSystem.BotArchetypes.Count],
                brain.Archetype);
            Assert.Same(BotData.Get(DifficultyId.Regular), brain.Difficulty);
        }

        var hud = session.CaptureHud();
        Assert.Equal(0, hud.Round);
        Assert.Equal(RoundPhase.Intermission, hud.Phase);
        Assert.Equal(ZombieMaps.Crossfire.StartingPoints, hud.Points);
        Assert.Empty(hud.Perks);
        Assert.False(hud.Downed);
        Assert.Equal(0, hud.ZombiesAlive);

        var runtime = session.CaptureRuntime();
        Assert.Equal(expected + 1, runtime.Survivors.Count);
        Assert.Contains("start", runtime.OpenZones);
        Assert.False(runtime.PowerOn);
    }

    [Fact]
    public void TickUsesRisingEdgeAndExposesPurchaseForHud()
    {
        using var session = Create(0);
        var quickRevive = ZombieMaps.Crossfire.Interactables.Single(
            interactable => interactable.Id == "perk_revive");
        MathEx.Copy(session.Player.Position, quickRevive.Position);
        session.Director.Players[session.Player.Id].Points = 2_000;

        var prompt = Assert.IsType<ZombiesPromptSnapshot>(session.CaptureHud().Prompt);
        Assert.Equal(quickRevive.Label, prompt.Label);
        Assert.Equal(ZombieData.Perks["quick_revive"].Cost, prompt.Cost);
        Assert.True(prompt.Usable);

        var use = new InputCommand { Buttons = (int)InputFlag.Use };
        session.Tick(use);

        var purchase = Assert.IsType<ZombieInteractionResult>(session.LastInteraction);
        Assert.True(purchase.Ok);
        Assert.Contains("quick_revive", session.CaptureHud().Perks);
        Assert.Equal(500, session.Director.Points(session.Player.Id));

        session.Tick(use);
        Assert.Null(session.LastInteraction);

        session.Tick(new InputCommand());
        Assert.Null(session.LastInteraction);

        session.Tick(use);
        Assert.NotNull(session.LastInteraction);
        Assert.False(session.LastInteraction!.Ok);
    }

    [Fact]
    public void TickAppendsDirectorEventsAfterSimulationEvents()
    {
        using var session = Create(0);

        session.Tick(new InputCommand(), 5d);

        Assert.Equal(1, session.World.Tick);
        Assert.Equal(1, session.State.Round);
        Assert.Equal(RoundPhase.Active, session.State.Phase);
        Assert.Contains(session.LastEvents, simulationEvent => simulationEvent.Type == SimEventType.RoundStart);
    }

    [Fact]
    public void RuntimeCaptureIsFrozenFromLaterDirectorChanges()
    {
        using var session = Create(1);
        var snapshot = session.CaptureRuntime();
        var originalPoints = snapshot.Survivors[0].Points;

        session.Director.Players[session.Player.Id].Points += 1_000;
        session.State.OpenZones.Add("later-zone");

        Assert.Equal(originalPoints, snapshot.Survivors[0].Points);
        Assert.DoesNotContain("later-zone", snapshot.OpenZones);
    }

    private static ZombiesSession Create(int partners) => new(
        "crossfire",
        partners,
        DifficultyId.Regular,
        "Player",
        LoadoutSystem.DefaultLoadout(),
        "adapter-test");

    private static void AssertPosition(Vec3 expected, Vec3 actual)
    {
        Assert.Equal(expected.X, actual.X);
        Assert.Equal(expected.Y, actual.Y);
        Assert.Equal(expected.Z, actual.Z);
    }
}
