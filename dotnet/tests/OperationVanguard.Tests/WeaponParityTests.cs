using OperationVanguard.Core;

namespace OperationVanguard.Tests;

[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class SimulationParityCollection
{
    public const string Name = "Simulation parity";
}

[Collection(SimulationParityCollection.Name)]
public sealed class WeaponParityTests
{
    private static int _nextId = 1_000;

    [Fact]
    public void AutomaticWeaponKeepsFiringWhileTriggerIsHeld()
    {
        var (player, definition) = Armed("vk47");

        var fired = Run(player, definition, 1d, (_, _) => true);
        var expected = 1d / WeaponMath.FireInterval(definition);

        Assert.InRange(fired, (int)Math.Floor(expected) - 1, (int)Math.Ceiling(expected) + 1);
    }

    [Fact]
    public void AutomaticWeaponRespectsMagazineAndStartingReserve()
    {
        var (player, definition) = Armed("vk47");

        var fired = Run(player, definition, 10d, (_, _) => true);

        Assert.True(fired > definition.MagSize);
        Assert.True(fired <= definition.MagSize + definition.StartingReserve);
    }

    [Fact]
    public void AutomaticWeaponUsesAuthoredRpmRatherThanTickRate()
    {
        var fast = Armed("vector9");
        var slow = Armed("gr63");

        var fastShots = Run(fast.Player, fast.Definition, 1d, (_, _) => true);
        var slowShots = Run(slow.Player, slow.Definition, 1d, (_, _) => true);

        Assert.True(fastShots > slowShots * 2);
    }

    [Fact]
    public void SemiAutomaticWeaponFiresOnceWhenHeld()
    {
        var (player, definition) = Armed("sa58");

        Assert.Equal(FireMode.Semi, definition.FireMode);
        Assert.Equal(1, Run(player, definition, 2d, (_, _) => true));
    }

    [Fact]
    public void SemiAutomaticWeaponFiresAgainOnEverySubsequentClick()
    {
        var (player, definition) = Armed("sa58");
        var clickPeriod = JsRound(0.25d / GameConstants.TickDt);

        var fired = Run(
            player,
            definition,
            3d,
            (tick, _) => tick % clickPeriod < 2);

        Assert.True(fired >= 10);
    }

    [Fact]
    public void SemiAutomaticWeaponCannotBeClickedFasterThanItsCycle()
    {
        var (player, definition) = Armed("sa58");
        var interval = WeaponMath.FireInterval(definition);

        var fired = Run(player, definition, 1d, (tick, _) => tick % 2 == 0);
        var maximumPossible = (int)Math.Ceiling(1d / interval) + 1;

        Assert.True(fired <= maximumPossible);
    }

    [Fact]
    public void BoltActionWeaponRequiresClicksAndRechambersBetweenShots()
    {
        var (heldPlayer, heldDefinition) = Armed("r700t");

        Assert.Equal(FireMode.BoltAction, heldDefinition.FireMode);
        Assert.Equal(1, Run(heldPlayer, heldDefinition, 2d, (_, _) => true));

        var (clickedPlayer, clickedDefinition) = Armed("r700t");
        var clickPeriod = JsRound(0.6d / GameConstants.TickDt);
        var clicked = Run(
            clickedPlayer,
            clickedDefinition,
            4d,
            (tick, _) => tick % clickPeriod < 2);

        Assert.InRange(clicked, 2, 4);
    }

    [Fact]
    public void BurstWeaponCompletesBurstAfterShortTriggerPull()
    {
        var (player, definition) = Armed("fr55");

        Assert.Equal(FireMode.Burst, definition.FireMode);
        var fired = Run(player, definition, 1d, (tick, _) => tick < 2);

        Assert.Equal(definition.BurstCount, fired);
    }

    [Fact]
    public void BurstWeaponPausesBetweenBurstsWhenHeld()
    {
        var (player, definition) = Armed("fr55");

        var fired = Run(player, definition, 1d, (_, _) => true);
        var burstsPerSecond = 1d /
            ((definition.BurstCount - 1) * WeaponMath.FireInterval(definition) +
             definition.BurstDelay);
        var maximum = (int)Math.Ceiling(burstsPerSecond) * definition.BurstCount +
            definition.BurstCount;

        Assert.True(fired <= maximum);
    }

    [Fact]
    public void ReloadTakesTimeThenRefillsMagazine()
    {
        var (player, definition) = Armed("vk47");
        var state = Assert.IsType<WeaponState>(WeaponSystem.ActiveWeapon(player));
        state.AmmoInMag = 5;
        var rng = new Rng(1);
        var time = 0d;

        for (var tick = 0; tick < JsRound(0.1d / GameConstants.TickDt); tick++)
        {
            time += GameConstants.TickDt;
            var command = Input(tick == 0 ? InputFlag.Reload : InputFlag.None);
            WeaponSystem.SetTrigger(player, command);
            WeaponSystem.StepWeapon(
                player,
                command,
                time,
                GameConstants.TickDt,
                rng,
                _ => definition);
        }

        Assert.Equal(WeaponAction.Reloading, player.Action);
        Assert.Equal(5, state.AmmoInMag);

        for (var tick = 0; tick < JsRound(4d / GameConstants.TickDt); tick++)
        {
            time += GameConstants.TickDt;
            var command = Input();
            WeaponSystem.SetTrigger(player, command);
            WeaponSystem.StepWeapon(
                player,
                command,
                time,
                GameConstants.TickDt,
                rng,
                _ => definition);
        }

        Assert.Equal(WeaponAction.Ready, player.Action);
        Assert.Equal(definition.MagSize, state.AmmoInMag);
    }

    [Fact]
    public void ReloadConservesTotalAmmunition()
    {
        var (player, definition) = Armed("vk47");
        var state = Assert.IsType<WeaponState>(WeaponSystem.ActiveWeapon(player));
        var before = state.AmmoInMag + state.AmmoReserve;
        state.AmmoInMag = 0;
        var rng = new Rng(1);
        var time = 0d;

        for (var tick = 0; tick < JsRound(6d / GameConstants.TickDt); tick++)
        {
            time += GameConstants.TickDt;
            var command = Input(tick == 0 ? InputFlag.Reload : InputFlag.None);
            WeaponSystem.SetTrigger(player, command);
            WeaponSystem.StepWeapon(
                player,
                command,
                time,
                GameConstants.TickDt,
                rng,
                _ => definition);
        }

        Assert.True(state.AmmoInMag + state.AmmoReserve <= before);
        Assert.Equal(definition.MagSize, state.AmmoInMag);
    }

    [Fact]
    public void SprintOutBlocksFireBrieflyAfterSprintEnds()
    {
        var (player, definition) = Armed("vk47");
        player.MoveState = MoveState.Sprint;
        var rng = new Rng(1);
        var time = 0d;
        var fired = 0;

        for (var tick = 0; tick < 20; tick++)
        {
            time += GameConstants.TickDt;
            var command = Input(InputFlag.Fire);
            WeaponSystem.SetTrigger(player, command);
            fired += WeaponSystem.StepWeapon(
                player,
                command,
                time,
                GameConstants.TickDt,
                rng,
                _ => definition).ShotsFired;
        }

        Assert.Equal(0, fired);

        player.MoveState = MoveState.Walk;
        var firstShotAt = -1d;
        for (var tick = 0; tick < 40; tick++)
        {
            time += GameConstants.TickDt;
            var command = Input(InputFlag.Fire);
            WeaponSystem.SetTrigger(player, command);
            if (WeaponSystem.StepWeapon(
                    player,
                    command,
                    time,
                    GameConstants.TickDt,
                    rng,
                    _ => definition).ShotsFired > 0)
            {
                firstShotAt = tick * GameConstants.TickDt;
                break;
            }
        }

        Assert.True(firstShotAt > 0d);
        Assert.True(firstShotAt < definition.Handling.SprintOutTime + 0.1d);
    }

    [Fact]
    public void AdsReachesFullAimWithinAuthoredTime()
    {
        var (player, definition) = Armed("vk47");
        var rng = new Rng(1);
        var time = 0d;
        var ticks = JsRound(
            (definition.Handling.AdsTime + 0.05d) /
            GameConstants.TickDt);

        for (var tick = 0; tick < ticks; tick++)
        {
            time += GameConstants.TickDt;
            var command = Input(InputFlag.Ads);
            WeaponSystem.SetTrigger(player, command);
            WeaponSystem.StepWeapon(
                player,
                command,
                time,
                GameConstants.TickDt,
                rng,
                _ => definition);
        }

        Assert.True(player.AdsProgress > 0.98d);
    }

    [Fact]
    public void AdsReleaseIsFasterThanAdsEntry()
    {
        var (player, definition) = Armed("r700t");
        var rng = new Rng(1);
        var time = 0d;

        for (var tick = 0; tick < JsRound(1.5d / GameConstants.TickDt); tick++)
        {
            time += GameConstants.TickDt;
            var command = Input(InputFlag.Ads);
            WeaponSystem.SetTrigger(player, command);
            WeaponSystem.StepWeapon(
                player,
                command,
                time,
                GameConstants.TickDt,
                rng,
                _ => definition);
        }

        Assert.Equal(1d, player.AdsProgress);

        var ticksToRelease = 0;
        while (player.AdsProgress > 0d && ticksToRelease < 500)
        {
            time += GameConstants.TickDt;
            var command = Input();
            WeaponSystem.SetTrigger(player, command);
            WeaponSystem.StepWeapon(
                player,
                command,
                time,
                GameConstants.TickDt,
                rng,
                _ => definition);
            ticksToRelease++;
        }

        Assert.True(ticksToRelease * GameConstants.TickDt < definition.Handling.AdsTime);
    }

    private static (PlayerState Player, WeaponDef Definition) Armed(string weaponId)
    {
        var definition = WeaponData.GetWeapon(weaponId);
        var player = WorldFactory.CreatePlayer(new CreatePlayerOptions
        {
            Id = Interlocked.Increment(ref _nextId),
            Name = "T",
            Team = Team.Allies,
            Position = new Vec3(),
        });
        WorldFactory.RespawnPlayer(player, new Vec3(), 0d);
        player.Weapons =
        [
            WorldFactory.CreateWeaponState(
                definition.Id,
                definition.MagSize,
                definition.StartingReserve),
        ];
        player.ActiveSlot = WeaponSlot.Primary;
        player.MoveState = MoveState.Idle;
        player.SprintOutTime = 0d;
        WeaponSystem.ResetWeaponRuntime(player.Id);
        return (player, definition);
    }

    private static InputCommand Input(InputFlag flags = InputFlag.None) => new()
    {
        Dt = GameConstants.TickDt,
        Buttons = (int)flags,
    };

    private static int Run(
        PlayerState player,
        WeaponDef definition,
        double seconds,
        Func<int, double, bool> trigger,
        double startTime = 0d)
    {
        var rng = new Rng(42);
        var ticks = JsRound(seconds / GameConstants.TickDt);
        var fired = 0;
        var time = startTime;

        for (var tick = 0; tick < ticks; tick++)
        {
            time += GameConstants.TickDt;
            var command = Input(trigger(tick, time) ? InputFlag.Fire : InputFlag.None);
            WeaponSystem.SetTrigger(player, command);
            fired += WeaponSystem.StepWeapon(
                player,
                command,
                time,
                GameConstants.TickDt,
                rng,
                _ => definition).ShotsFired;
        }

        return fired;
    }

    private static int JsRound(double value) => (int)Math.Floor(value + 0.5d);
}
