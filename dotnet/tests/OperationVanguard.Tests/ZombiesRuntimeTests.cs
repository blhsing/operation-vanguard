using OperationVanguard.Core;

namespace OperationVanguard.Tests;

public sealed class ZombiesRuntimeTests
{
    [Fact]
    public void RoundCurveEscalatesHealthWithoutAHealthCap()
    {
        var previous = 0;
        foreach (var round in new[] { 1, 5, 10, 15, 20, 30 })
        {
            var health = ZombieData.HealthForRound(round);
            Assert.True(health > previous, $"round {round}");
            previous = health;
        }

        Assert.True(ZombieData.HealthForRound(30) > ZombieData.HealthForRound(10) * 3);
    }

    [Fact]
    public void RoundCurveCapsSpeedAndScalesCountWithRoundAndPlayers()
    {
        Assert.True(ZombieData.SpeedForRound(1) < ZombieData.SpeedForRound(10));
        Assert.Equal(ZombieData.RoundCurve.MaximumSpeed, ZombieData.SpeedForRound(50));
        Assert.True(ZombieData.RoundCurve.MaximumSpeed < 7);
        Assert.True(ZombieData.CountForRound(5, 4) > ZombieData.CountForRound(5, 1));
        Assert.True(ZombieData.CountForRound(10, 1) > ZombieData.CountForRound(1, 1));
    }

    [Fact]
    public void GameStartsInIntermissionThenBeginsRoundOneWithEvents()
    {
        using var harness = CreateGame();
        Assert.Equal(RoundPhase.Intermission, harness.Director.State.Phase);
        Assert.Equal(0, harness.Director.State.Round);

        harness.Run(6);

        Assert.Equal(RoundPhase.Active, harness.Director.State.Phase);
        Assert.Equal(1, harness.Director.State.Round);
        var roundStart = Assert.Single(
            harness.Events.OfType<GenericSimEvent>(),
            value => value.Type == SimEventType.RoundStart);
        Assert.Equal(1, roundStart.Data!["round"]);
        Assert.Equal(ZombieData.CountForRound(1, 1), roundStart.Data["zombies"]);
        Assert.Equal(ZombieData.HealthForRound(1), roundStart.Data["health"]);
    }

    [Fact]
    public void HordeSpawnsGraduallyAndRespectsConcurrentBudget()
    {
        using var harness = CreateGame();
        harness.Run(6.5);
        var early = Zombies(harness).Count;
        harness.Run(6);
        var later = Zombies(harness).Count;

        Assert.True(early > 0, "some should be out immediately");
        Assert.True(later > early, "more should arrive over the round");

        using var fourPlayer = CreateGame(4);
        fourPlayer.Director.State.Round = 14;
        fourPlayer.Run(60);
        Assert.True(Zombies(fourPlayer).Count <= ZombieData.RoundCurve.MaximumAlive);
    }

    [Fact]
    public void FirstSpawnAndDirectorRngMatchTheTypeScriptSnapshot()
    {
        using var harness = CreateGame();

        harness.Run(6.5);

        Assert.Equal(1, harness.Director.State.Round);
        Assert.Equal(5, harness.Director.State.RemainingToSpawn);
        Assert.Equal(1.115625, harness.Director.State.SpawnTimer, 12);
        Assert.Equal(2_399_460_385u, harness.DirectorRng.GetState());
        var zombie = Assert.Single(Zombies(harness));
        Assert.Equal(2, zombie.Id);
        Assert.Equal("Zombie 1", zombie.Name);
        Assert.Equal(15.026306341894708, zombie.Position.X, 10);
        Assert.Equal(0.000009765625000004996, zombie.Position.Y, 10);
        Assert.Equal(27.990226548492242, zombie.Position.Z, 10);
        Assert.Equal(150, zombie.Health);
        Assert.Equal(150, zombie.MaxHealth);
    }

    [Fact]
    public void FreshZombiesDoNotSpawnOnTopOfSurvivors()
    {
        using var harness = CreateGame();
        harness.Run(8);

        foreach (var zombie in Zombies(harness))
        {
            var nearest = harness.Players.Min(player =>
                MathEx.DistanceXz(zombie.Position, player.Position));
            if (zombie.Health == zombie.MaxHealth)
            {
                Assert.True(nearest > 3, "a zombie should never appear in your face");
            }
        }
    }

    [Fact]
    public void ZombieAiClosesDistanceAndZombiesStayOffScoreboard()
    {
        using var harness = CreateGame(2);
        harness.Run(8);
        var before = Zombies(harness).ToDictionary(
            zombie => zombie.Id,
            zombie => MathEx.DistanceXz(zombie.Position, harness.Players[0].Position));

        harness.Run(6);

        var closed = Zombies(harness).Count(zombie =>
            before.TryGetValue(zombie.Id, out var prior) &&
            MathEx.DistanceXz(zombie.Position, harness.Players[0].Position) < prior - 1d);
        Assert.True(closed > 0, "zombies should be closing the distance");
        Assert.NotEmpty(Zombies(harness));
        Assert.All(harness.Simulation.Scoreboard(), player => Assert.NotEqual(Team.Hostile, player.Team));
        Assert.Equal(2, harness.Simulation.Scoreboard().Count);
    }

    [Fact]
    public void ZombiesMatchHasNoTimerBasedGameOver()
    {
        using var harness = CreateGame();
        harness.Run(30);
        Assert.NotEqual(RoundPhase.GameOver, harness.Director.State.Phase);
    }

    [Fact]
    public void RoundEndAwardsBonusAndReturnsBledOutSurvivorOnlyThen()
    {
        using var harness = CreateGame(2);
        var player = harness.Players[0];
        var playerState = harness.State(0);
        var teammateState = harness.State(1);
        var playerPoints = playerState.Points;
        var teammatePoints = teammateState.Points;
        harness.Director.State.Round = 3;
        harness.Director.State.Phase = RoundPhase.Active;
        harness.Director.State.RemainingToSpawn = 0;
        playerState.BledOut = true;
        player.Alive = false;
        player.Health = 0;
        player.RespawnTimer = double.PositiveInfinity;

        var events = harness.Director.Step(0, []);

        Assert.Equal(RoundPhase.Intermission, harness.Director.State.Phase);
        Assert.Equal(ZombieData.RoundCurve.Intermission,
            harness.Director.State.IntermissionTimer);
        Assert.False(playerState.BledOut);
        Assert.True(player.Alive);
        Assert.Equal(ZombieData.Down.ReviveHealth, player.Health);
        Assert.Equal("p226", Assert.Single(player.Weapons).DefId);
        Assert.Equal(playerPoints + ZombieData.Points.RoundBonus, playerState.Points);
        Assert.Equal(teammatePoints + ZombieData.Points.RoundBonus, teammateState.Points);
        Assert.Contains(events, value => value.Type == SimEventType.RoundEnd);
    }

    [Fact]
    public void NonLethalDamagePaysHitPoints()
    {
        using var harness = CreateGame();
        var player = harness.Players[0];
        var startingPoints = harness.Director.Points(player.Id);
        harness.Run(8);
        var zombie = Assert.IsType<PlayerState>(Zombies(harness).FirstOrDefault());

        harness.Simulation.DamagePlayer(zombie, Damage(
            amount: 10,
            attacker: player.Id,
            victim: zombie.Id,
            cause: DamageCause.Bullet,
            weaponId: "p226",
            ignoreArmor: false));
        harness.Run(GameConstants.TickDt * 2);

        Assert.Equal(startingPoints + ZombieData.Points.Hit, harness.Director.Points(player.Id));
        Assert.Contains(harness.Events.OfType<GenericSimEvent>(), value =>
            value.Type == SimEventType.ScoreAwarded &&
            Equals(value.Data!["reason"], "hit"));
    }

    [Fact]
    public void KillAwardsPointsAndRemovesCorpseWithoutPersistentRespawn()
    {
        using var harness = CreateGame();
        var player = harness.Players[0];
        harness.Run(8);
        var zombie = Zombies(harness)[0];
        var id = zombie.Id;
        var countBefore = Zombies(harness).Count;
        var pointsBefore = harness.Director.Points(player.Id);

        harness.Simulation.DamagePlayer(zombie, Damage(
            amount: 99_999,
            attacker: player.Id,
            victim: zombie.Id,
            cause: DamageCause.Bullet,
            weaponId: "p226",
            ignoreArmor: true));
        harness.Run(GameConstants.TickDt * 2);

        Assert.True(harness.Director.Points(player.Id) >= pointsBefore + ZombieData.Points.Kill);
        Assert.Equal(countBefore - 1, Zombies(harness).Count);
        Assert.False(harness.Simulation.World.Players.ContainsKey(id));

        harness.Run(1);
        Assert.False(harness.Simulation.World.Players.ContainsKey(id));
    }

    [Fact]
    public void KillAwardHierarchyFavorsHeadshotsAndMelee()
    {
        Assert.True(ZombieData.Points.Kill > ZombieData.Points.Hit);
        Assert.True(ZombieData.Points.HeadshotKill > ZombieData.Points.Kill);
        Assert.True(ZombieData.Points.MeleeKill > ZombieData.Points.HeadshotKill);
    }

    [Fact]
    public void DoorsRejectPoorPlayersThenOpenAndChargeAffordablePurchase()
    {
        using var harness = CreateGame();
        harness.MoveTo("door_mid");
        var state = harness.State(0);
        state.Points = 100;

        var denied = harness.Director.Interact(harness.Players[0].Id);
        Assert.False(denied.Ok);
        Assert.Equal("need 750", denied.Message);
        Assert.DoesNotContain("mid", harness.Director.State.OpenZones);

        state.Points = 5_000;
        var before = state.Points;
        var opened = harness.Director.Interact(harness.Players[0].Id);
        Assert.True(opened.Ok);
        Assert.Equal("opened", opened.Message);
        Assert.Contains("mid", harness.Director.State.OpenZones);
        Assert.Equal(before - 750, state.Points);
    }

    [Fact]
    public void LockedZonesAndPowerRequirementsReportExactReasons()
    {
        using var harness = CreateGame();
        var state = harness.State(0);
        state.Points = 99_999;

        harness.MoveTo("wall_ar");
        var locked = harness.Director.Interact(harness.Players[0].Id);
        Assert.False(locked.Ok);
        Assert.Equal("area locked", locked.Message);

        harness.MoveTo("door_warehouse");
        Assert.True(harness.Director.Interact(harness.Players[0].Id).Ok);
        harness.MoveTo("perk_jugg");
        Assert.Equal("needs power", harness.Director.Interact(harness.Players[0].Id).Message);

        harness.MoveTo("power");
        Assert.True(harness.Director.Interact(harness.Players[0].Id).Ok);
        Assert.True(harness.Director.State.PowerOn);
        harness.MoveTo("perk_jugg");
        Assert.True(harness.Director.Interact(harness.Players[0].Id).Ok);
    }

    [Fact]
    public void WallBuyGivesWeaponThenRefillsAmmoAtReducedCost()
    {
        using var harness = CreateGame();
        harness.MoveTo("wall_smg");
        var state = harness.State(0);
        state.Points = 99_999;

        var bought = harness.Director.Interact(harness.Players[0].Id);
        Assert.True(bought.Ok);
        var weapon = Assert.Single(
            harness.Players[0].Weapons,
            value => value.DefId == "mp9k");
        Assert.Contains("mp9k", state.OwnedWallWeapons);

        weapon.AmmoReserve = 0;
        var before = state.Points;
        var ammunition = harness.Director.Interact(harness.Players[0].Id);
        Assert.True(ammunition.Ok);
        Assert.Equal("ammo", ammunition.Message);
        Assert.True(weapon.AmmoReserve > 0);
        Assert.Equal(before - 450, state.Points);
    }

    [Fact]
    public void JuggernogRaisesHealthAndPerkSlotsAreCapped()
    {
        using var harness = CreateGame();
        var player = harness.Players[0];
        var state = harness.State(0);
        state.Points = 99_999;
        harness.Director.State.OpenZones.Add("warehouse");
        harness.Director.State.PowerOn = true;
        var before = player.MaxHealth;

        harness.MoveTo("perk_jugg");
        Assert.True(harness.Director.Interact(player.Id).Ok);
        Assert.True(player.MaxHealth > before);
        Assert.Equal(player.MaxHealth, player.Health);
        Assert.Contains("juggernog", state.Perks);

        state.Perks = ["juggernog", "speed_cola", "double_tap", "stamin_up"];
        harness.MoveTo("perk_revive");
        Assert.Equal("no perk slots", harness.Director.Interact(player.Id).Message);
    }

    [Fact]
    public void MysteryBoxUsesPointsAndReturnsAWeightedPoolWeapon()
    {
        using var harness = CreateGame();
        var state = harness.State(0);
        state.Points = ZombieData.MysteryBoxCost + 100;
        harness.Director.State.OpenZones.Add("warehouse");
        harness.MoveTo("box");

        var result = harness.Director.Interact(harness.Players[0].Id);

        Assert.True(result.Ok);
        Assert.Equal("MP9-K", result.Message);
        Assert.Equal(100, state.Points);
        Assert.Equal(2, harness.Players[0].Weapons.Count);
        Assert.Equal("mp9k", harness.Players[0].Weapons[1].DefId);
        Assert.Equal(1_831_565_912u, harness.DirectorRng.GetState());
    }

    [Fact]
    public void PackAPunchUpgradesDamageAndAmmoExactlyOnceWithoutDoubleCharge()
    {
        using var harness = CreateGame();
        var player = harness.Players[0];
        var state = harness.State(0);
        state.Points = ZombieData.PackAPunchCost * 3;
        harness.Director.State.OpenZones.Add("north");
        harness.Director.State.PowerOn = true;
        var weapon = player.Weapons[(int)player.ActiveSlot];
        var definition = WeaponData.GetWeapon(weapon.DefId);
        Assert.Equal(1, harness.Director.DamageMultiplier(player.Id, weapon.DefId));

        harness.MoveTo("pap");
        Assert.True(harness.Director.Interact(player.Id).Ok);
        Assert.Equal(ZombiesDirector.PapDamageMultiplier,
            harness.Director.DamageMultiplier(player.Id, weapon.DefId));
        Assert.Equal(definition.MagSize * ZombiesDirector.PapMagazineMultiplier, weapon.AmmoInMag);
        Assert.Equal(
            Math.Min(definition.MaxReserve * 2, definition.StartingReserve * ZombiesDirector.PapMagazineMultiplier),
            weapon.AmmoReserve);

        var after = state.Points;
        var duplicate = harness.Director.Interact(player.Id);
        Assert.False(duplicate.Ok);
        Assert.Equal("already upgraded", duplicate.Message);
        Assert.Equal(after, state.Points);
    }

    [Fact]
    public void LethalDamageDownsSurvivorAndStripsPerks()
    {
        using var harness = CreateGame(2);
        harness.Run(6);
        var state = harness.State(0);
        state.Perks = ["juggernog", "speed_cola"];

        harness.Down(0);

        Assert.True(state.Downed);
        Assert.True(harness.Players[0].Alive);
        Assert.Equal(1, state.Downs);
        Assert.Empty(state.Perks);
        Assert.Equal(1, harness.Players[0].Health);
        Assert.Equal("p226", Assert.Single(harness.Players[0].Weapons).DefId);
    }

    [Fact]
    public void NearbyTeammateRevivesAndReceivesPoints()
    {
        using var harness = CreateGame(2);
        harness.Run(6);
        harness.Down(0);
        var downedState = harness.State(0);
        var reviverState = harness.State(1);
        var pointsBefore = reviverState.Points;

        harness.RunPinned(
            ZombieData.Down.ReviveTime + 1,
            harness.Players[1],
            harness.Players[0].Position);

        Assert.False(downedState.Downed);
        Assert.True(harness.Players[0].Health > 1);
        Assert.Equal(1, reviverState.Revives);
        Assert.Equal(pointsBefore + ZombieData.Points.Revive, reviverState.Points);
    }

    [Fact]
    public void InterruptedReviveLosesAllProgress()
    {
        using var harness = CreateGame(2);
        harness.Run(6);
        harness.Down(0);
        var state = harness.State(0);

        harness.RunPinned(
            ZombieData.Down.ReviveTime * 0.5,
            harness.Players[1],
            harness.Players[0].Position);
        Assert.True(state.ReviveProgress > 0);

        var far = new Vec3(
            harness.Players[0].Position.X + 20,
            harness.Players[0].Position.Y,
            harness.Players[0].Position.Z + 20);
        harness.RunPinned(GameConstants.TickDt * 20, harness.Players[1], far);
        Assert.Equal(0, state.ReviveProgress);
        Assert.Equal(SimulationTypes.NullEntity, state.Reviver);
    }

    [Fact]
    public void UnreachedPlayerBleedsOutAndDoesNotAutoRespawn()
    {
        using var harness = CreateGame(2);
        harness.Run(6);
        harness.Down(0);
        var far = new Vec3(30, harness.Players[1].Position.Y, 30);

        harness.RunPinned(
            ZombieData.Down.BleedOutTime + 2,
            harness.Players[1],
            far);

        var state = harness.State(0);
        Assert.False(state.Downed);
        Assert.True(state.BledOut);
        Assert.False(harness.Players[0].Alive);
        Assert.Equal(double.PositiveInfinity, harness.Players[0].RespawnTimer);

        harness.RunPinned(2, harness.Players[1], far);
        Assert.False(harness.Players[0].Alive);
        Assert.True(state.BledOut);
    }

    [Fact]
    public void GameEndsOnlyAfterLastCrawlingSurvivorBleedsOut()
    {
        using var harness = CreateGame();
        harness.Run(6);
        harness.Down(0);
        Assert.Equal(RoundPhase.Active, harness.Director.State.Phase);

        harness.Run(ZombieData.Down.BleedOutTime + 3);

        Assert.Equal(RoundPhase.GameOver, harness.Director.State.Phase);
        Assert.Contains(harness.Events.OfType<GenericSimEvent>(), value =>
            value.Type == SimEventType.MatchStateChanged &&
            Equals(value.Data!["gameOver"], true));
    }

    [Fact]
    public void QuickReviveSelfRevivesSoloPlayerExactlyOnce()
    {
        using var harness = CreateGame();
        harness.Run(6);
        var state = harness.State(0);
        state.Perks = ["quick_revive"];

        harness.Down(0);
        Assert.False(state.Downed);
        Assert.True(state.SelfReviveUsed);

        state.Perks = ["quick_revive"];
        harness.Down(0);
        Assert.True(state.Downed);
    }

    [Fact]
    public void PerkAndDownedModifiersApplyExactlyOnceThroughSimulationHook()
    {
        using var harness = CreateGame();
        var player = harness.Players[0];
        var state = harness.State(0);
        state.Perks = ["stamin_up", "speed_cola", "double_tap"];
        var movement = new MovementModifiers();
        var weapon = new WeaponModifiers();

        harness.Simulation.ModifierHook?.Invoke(player, movement, weapon);

        Assert.Equal(ZombieData.Perks["stamin_up"].SpeedMultiplier!.Value,
            movement.SpeedMultiplier, 12);
        Assert.Equal(ZombieData.Perks["speed_cola"].ReloadMultiplier!.Value,
            weapon.ReloadSpeedMult, 12);
        Assert.Equal(ZombieData.Perks["double_tap"].FireRateMultiplier!.Value,
            harness.Director.FireRateMultiplier(player.Id), 12);

        state.Downed = true;
        movement = new MovementModifiers();
        weapon = new WeaponModifiers();
        harness.Simulation.ModifierHook?.Invoke(player, movement, weapon);
        Assert.Equal(ZombieData.Down.CrawlSpeedMultiplier, movement.SpeedMultiplier, 12);
        Assert.True(movement.SprintBlocked);
        Assert.True(movement.SlideBlocked);
    }

    [Fact]
    public void ZombiesCarryNoWeaponsAndModifierBlocksFiring()
    {
        using var harness = CreateGame();
        harness.Run(10);
        foreach (var zombie in Zombies(harness))
        {
            Assert.Empty(zombie.Weapons);
            var movement = new MovementModifiers();
            var weapon = new WeaponModifiers();
            harness.Simulation.ModifierHook?.Invoke(zombie, movement, weapon);
            Assert.True(weapon.FireBlocked);
            Assert.False(movement.SprintBlocked);
        }
    }

    [Fact]
    public void DisposeClearsDirectorStateAndSimulationHooks()
    {
        var harness = CreateGame(2);
        harness.Director.Dispose();

        Assert.Empty(harness.Director.Players);
        Assert.Null(harness.Simulation.ModifierHook);
        Assert.Null(harness.Simulation.DamageMultiplierHook);
    }

    private static Harness CreateGame(int playerCount = 1) => new(playerCount);

    private static List<PlayerState> Zombies(Harness harness) => harness.Simulation.World.Players.Values
        .Where(player => player.Team == Team.Hostile)
        .ToList();

    private static DamageInfo Damage(
        double amount,
        int attacker,
        int victim,
        DamageCause cause,
        string weaponId,
        bool ignoreArmor) =>
        new()
        {
            Amount = amount,
            Attacker = attacker,
            Victim = victim,
            Cause = cause,
            WeaponId = weaponId,
            Location = HitLocation.Chest,
            Position = new Vec3(),
            Direction = new Vec3(0, 0, 1),
            Distance = 5,
            IgnoreArmor = ignoreArmor,
        };

    private sealed class Harness : IDisposable
    {
        public Harness(int playerCount)
        {
            Simulation = new GameSimulation(new GameOptions
            {
                MapId = "crossfire",
                ModeId = "zombies",
                Seed = "zm",
            });
            Data = ZombieMaps.Get("crossfire");
            DirectorRng = new Rng(99);
            Director = new ZombiesDirector(
                Simulation,
                new NavGraph(Simulation.Map, Simulation.Collision),
                DirectorRng,
                Data);

            for (var index = 0; index < playerCount; index++)
            {
                var player = Simulation.AddPlayer(new AddPlayerOptions
                {
                    Name = $"Survivor{index}",
                    Team = Team.Allies,
                });
                Simulation.SpawnPlayer(player);
                var spawn = Data.PlayerSpawns[index % Data.PlayerSpawns.Count];
                MathEx.Copy(player.Position, spawn);
                Director.AddSurvivor(player);
                Players.Add(player);
            }
        }

        public GameSimulation Simulation { get; }

        public ZombiesDirector Director { get; }

        public Rng DirectorRng { get; }

        public ZombiesMapData Data { get; }

        public List<PlayerState> Players { get; } = [];

        public List<SimEvent> Events { get; } = [];

        public ZombiePlayerState State(int playerIndex) => Director.Players[Players[playerIndex].Id];

        public void Run(double seconds)
        {
            var ticks = JsRound(seconds / GameConstants.TickDt);
            for (var index = 0; index < ticks; index++)
            {
                Tick();
            }
        }

        public void RunPinned(double seconds, PlayerState player, Vec3 position)
        {
            var ticks = JsRound(seconds / GameConstants.TickDt);
            for (var index = 0; index < ticks; index++)
            {
                MathEx.Copy(player.Position, position);
                Tick();
            }
        }

        public void Down(int playerIndex)
        {
            var player = Players[playerIndex];
            Simulation.DamagePlayer(player, Damage(
                amount: 99_999,
                attacker: SimulationTypes.NullEntity,
                victim: player.Id,
                cause: DamageCause.Zombie,
                weaponId: "zombie",
                ignoreArmor: true));
            Run(GameConstants.TickDt * 2);
        }

        public void MoveTo(string interactableId)
        {
            var definition = Data.Interactables.Single(value => value.Id == interactableId);
            MathEx.Copy(Players[0].Position, definition.Position);
        }

        public void Dispose() => Director.Dispose();

        private void Tick()
        {
            var simulationEvents = Simulation.Step(GameConstants.TickDt);
            Events.AddRange(simulationEvents);
            Events.AddRange(Director.Step(GameConstants.TickDt, simulationEvents));
        }

        private static int JsRound(double value) => (int)Math.Floor(value + 0.5d);
    }
}
