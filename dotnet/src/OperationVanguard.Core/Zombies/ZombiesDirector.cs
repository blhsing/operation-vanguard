using System.Text.Json.Serialization;

namespace OperationVanguard.Core;

[JsonConverter(typeof(JsonStringEnumConverter<RoundPhase>))]
public enum RoundPhase
{
    [JsonStringEnumMemberName("intermission")]
    Intermission,
    [JsonStringEnumMemberName("active")]
    Active,
    [JsonStringEnumMemberName("game_over")]
    GameOver,
}

public sealed class ZombiePlayerState
{
    public int Points { get; set; }

    public int TotalEarned { get; set; }

    public List<string> Perks { get; set; } = [];

    public bool Downed { get; set; }

    public double BleedOut { get; set; }

    public double ReviveProgress { get; set; }

    public int Reviver { get; set; }

    public bool SelfReviveUsed { get; set; }

    public bool BledOut { get; set; }

    public int Kills { get; set; }

    public int Downs { get; set; }

    public int Revives { get; set; }

    public HashSet<string> OwnedWallWeapons { get; set; } = new(StringComparer.Ordinal);

    public HashSet<string> Upgraded { get; set; } = new(StringComparer.Ordinal);
}

public sealed class ZombiesState
{
    public int Round { get; set; }

    public RoundPhase Phase { get; set; }

    public int RemainingToSpawn { get; set; }

    public double SpawnTimer { get; set; }

    public double IntermissionTimer { get; set; }

    public bool PowerOn { get; set; }

    public HashSet<string> OpenZones { get; set; } = new(StringComparer.Ordinal);

    public int HighestRound { get; set; }
}

public sealed class ZombieInteractable
{
    public ZombieInteractableDef Def { get; set; } = new();

    public bool Usable { get; set; }

    public string Reason { get; set; } = string.Empty;

    public int Cost { get; set; }
}

public sealed class ZombieInteractionResult
{
    public bool Ok { get; set; }

    public string Message { get; set; } = string.Empty;
}

/// <summary>
/// Round, economy, interaction, down/revive, and game-over director for Zombies.
/// Zombies remain ordinary hostile players driven by <see cref="ZombieDirectorAi"/>.
/// </summary>
public sealed class ZombiesDirector : IDisposable
{
    public const double PapDamageMultiplier = 2.4d;
    public const int PapMagazineMultiplier = 2;

    private static readonly Vec3 SpawnPosition = new();

    private readonly GameSimulation _simulation;
    private readonly Rng _rng;
    private readonly ZombiesMapData _data;
    private readonly ZombieDirectorAi _ai;
    private readonly HashSet<int> _zombieIds = [];
    private readonly List<SimEvent> _events = [];
    private int _nextZombieName = 1;

    public ZombiesDirector(
        GameSimulation simulation,
        NavGraph navigation,
        Rng rng,
        ZombiesMapData data)
    {
        _simulation = simulation;
        _rng = rng;
        _data = data;
        _ai = new ZombieDirectorAi(navigation, rng);

        State = new ZombiesState
        {
            Round = 0,
            Phase = RoundPhase.Intermission,
            RemainingToSpawn = 0,
            SpawnTimer = 0d,
            IntermissionTimer = 5d,
            PowerOn = false,
            OpenZones = new HashSet<string>(
                data.Zones.Where(zone => zone.StartingZone).Select(zone => zone.Id),
                StringComparer.Ordinal),
            HighestRound = 0,
        };

        simulation.World.Match.Phase = MatchPhase.Live;
        simulation.World.Match.TimeRemaining = 0d;
        simulation.ModifierHook = ApplyModifiers;
        simulation.DamageMultiplierHook = DamageMultiplier;
    }

    public ZombiesState State { get; }

    public Dictionary<int, ZombiePlayerState> Players { get; } = [];

    public List<PlayerState> Survivors
    {
        get
        {
            var output = new List<PlayerState>();
            foreach (var id in Players.Keys)
            {
                if (_simulation.World.Players.TryGetValue(id, out var player))
                {
                    output.Add(player);
                }
            }

            return output;
        }
    }

    public List<PlayerState> Standing => Survivors
        .Where(player =>
            player.Alive &&
            Players.TryGetValue(player.Id, out var state) &&
            !state.Downed)
        .ToList();

    /// <summary>Register a human or bot survivor.</summary>
    public void AddSurvivor(PlayerState player)
    {
        Players[player.Id] = new ZombiePlayerState
        {
            Points = _data.StartingPoints,
            TotalEarned = _data.StartingPoints,
            Perks = [],
            Downed = false,
            BleedOut = 0d,
            ReviveProgress = 0d,
            Reviver = SimulationTypes.NullEntity,
            SelfReviveUsed = false,
            BledOut = false,
            Kills = 0,
            Downs = 0,
            Revives = 0,
            OwnedWallWeapons = new HashSet<string>(StringComparer.Ordinal),
            Upgraded = new HashSet<string>(StringComparer.Ordinal),
        };
        EquipStartingLoadout(player);
    }

    public List<SimEvent> Step(double deltaTime, IReadOnlyList<SimEvent> simulationEvents)
    {
        _events.Clear();

        ConsumeSimulationEvents(simulationEvents);
        ReconcileDowns();
        StepDowned(deltaTime);

        if (State.Phase == RoundPhase.GameOver)
        {
            return _events;
        }

        var hits = _ai.Update(
            _simulation.World,
            deltaTime,
            (id, command) => _simulation.SetInput(id, command));
        foreach (var hit in hits)
        {
            ApplyZombieMelee(hit.Zombie, hit.Victim);
        }

        StepRound(deltaTime);
        ReconcileDowns();
        CheckGameOver();
        return _events;
    }

    public double FireRateMultiplier(int playerId)
    {
        if (!Players.TryGetValue(playerId, out var state))
        {
            return 1d;
        }

        var multiplier = 1d;
        foreach (var perkId in state.Perks)
        {
            if (ZombieData.Perks.TryGetValue(perkId, out var perk) &&
                perk.FireRateMultiplier is { } value &&
                value != 0d)
            {
                multiplier *= value;
            }
        }

        return multiplier;
    }

    public int Points(int playerId) =>
        Players.TryGetValue(playerId, out var state) ? state.Points : 0;

    public ZombieInteractable? InteractableNear(int playerId)
    {
        if (!_simulation.World.Players.TryGetValue(playerId, out var player) ||
            !Players.TryGetValue(playerId, out var playerState) ||
            playerState.Downed)
        {
            return null;
        }

        ZombieInteractableDef? best = null;
        var bestDistance = 3d;
        foreach (var definition in _data.Interactables)
        {
            var distance = MathEx.Distance(player.Position, definition.Position);
            if (distance < bestDistance)
            {
                bestDistance = distance;
                best = definition;
            }
        }

        if (best is null)
        {
            return null;
        }

        var cost = CostOf(best, playerId);
        var reason = BlockedReason(best, playerId, cost);
        return new ZombieInteractable
        {
            Def = best,
            Usable = reason.Length == 0,
            Reason = reason,
            Cost = cost,
        };
    }

    public ZombieInteractionResult Interact(int playerId)
    {
        var near = InteractableNear(playerId);
        if (near is null)
        {
            return Interaction(false, string.Empty);
        }

        if (!near.Usable)
        {
            return Interaction(false, near.Reason);
        }

        if (!_simulation.World.Players.TryGetValue(playerId, out var player) ||
            !Players.TryGetValue(playerId, out var playerState))
        {
            return Interaction(false, string.Empty);
        }

        var definition = near.Def;
        var cost = near.Cost;
        if (cost > 0 && !Spend(playerId, cost))
        {
            return Interaction(false, "not enough points");
        }

        ZombieInteractionResult RefundOnFailure(ZombieInteractionResult result)
        {
            if (!result.Ok && cost > 0)
            {
                Award(playerId, cost, "refund");
            }

            return result;
        }

        switch (definition.Kind)
        {
            case InteractKind.Door:
                if (!string.IsNullOrEmpty(definition.OpensZone))
                {
                    State.OpenZones.Add(definition.OpensZone);
                    Emit(
                        SimEventType.ObjectiveCaptured,
                        new Dictionary<string, object?> { ["zone"] = definition.OpensZone });
                    EmitAnnounce($"{ZoneName(definition.OpensZone)}已開啟");
                }

                return Interaction(true, "opened");

            case InteractKind.Power:
                State.PowerOn = true;
                EmitAnnounce("電力已啟動");
                return Interaction(true, "power on");

            case InteractKind.WallBuy:
                return RefundOnFailure(BuyWallWeapon(player, playerState, definition));

            case InteractKind.MysteryBox:
                return RefundOnFailure(RollMysteryBox(player, playerState));

            case InteractKind.PackAPunch:
                return RefundOnFailure(PackAPunch(player, playerState));

            case InteractKind.PerkMachine:
                if (!string.IsNullOrEmpty(definition.PerkId))
                {
                    playerState.Perks.Add(definition.PerkId);
                    ApplyPerkOnPurchase(player, definition.PerkId);
                    Emit(
                        SimEventType.MedalEarned,
                        new Dictionary<string, object?>
                        {
                            ["player"] = playerId,
                            ["perk"] = definition.PerkId,
                        });
                    var name = ZombieData.Perks.TryGetValue(definition.PerkId, out var perk)
                        ? perk.Name
                        : "perk";
                    return Interaction(true, name);
                }

                return Interaction(false, string.Empty);

            default:
                return Interaction(false, string.Empty);
        }
    }

    /// <summary>Damage multiplier for a weapon upgraded by Pack-a-Punch.</summary>
    public double DamageMultiplier(int playerId, string weaponId) =>
        Players.TryGetValue(playerId, out var state) && state.Upgraded.Contains(weaponId)
            ? PapDamageMultiplier
            : 1d;

    public void Dispose()
    {
        _ai.Clear();
        _zombieIds.Clear();
        Players.Clear();
        _simulation.ModifierHook = null;
        _simulation.DamageMultiplierHook = null;
    }

    private void EquipStartingLoadout(PlayerState player)
    {
        var pistol = WeaponData.TryGetWeapon(_data.StartingPistol) ?? WeaponData.GetWeapon("p226");
        player.Weapons.Clear();
        player.Weapons.Add(WorldFactory.CreateWeaponState(
            pistol.Id,
            pistol.MagSize,
            pistol.StartingReserve));
        player.ActiveSlot = WeaponSlot.Primary;
        player.MaxHealth = GameConstants.Health.Maximum;
        player.Health = GameConstants.Health.Maximum;
    }

    private void StepRound(double deltaTime)
    {
        if (State.Phase == RoundPhase.Intermission)
        {
            State.IntermissionTimer -= deltaTime;
            if (State.IntermissionTimer <= 0d)
            {
                BeginRound();
            }

            return;
        }

        if (State.RemainingToSpawn > 0)
        {
            State.SpawnTimer -= deltaTime;
            if (State.SpawnTimer <= 0d && _zombieIds.Count < ZombieData.RoundCurve.MaximumAlive)
            {
                SpawnZombie();
                State.RemainingToSpawn--;
                State.SpawnTimer = ZombieData.SpawnIntervalForRound(State.Round);
            }
        }

        if (State.RemainingToSpawn <= 0 && AliveZombies == 0)
        {
            EndRound();
        }
    }

    private void BeginRound()
    {
        State.Round++;
        State.HighestRound = Math.Max(State.HighestRound, State.Round);
        State.Phase = RoundPhase.Active;
        State.RemainingToSpawn = ZombieData.CountForRound(
            State.Round,
            Math.Max(1, Survivors.Count));
        State.SpawnTimer = 0d;

        Emit(
            SimEventType.RoundStart,
            new Dictionary<string, object?>
            {
                ["round"] = State.Round,
                ["zombies"] = State.RemainingToSpawn,
                ["health"] = ZombieData.HealthForRound(State.Round),
            });
        EmitAnnounce($"第{State.Round}回合");
    }

    private void EndRound()
    {
        State.Phase = RoundPhase.Intermission;
        State.IntermissionTimer = ZombieData.RoundCurve.Intermission;

        foreach (var player in Survivors)
        {
            Award(player.Id, ZombieData.Points.RoundBonus, "round_survived");

            if (Players.TryGetValue(player.Id, out var state) && state.BledOut)
            {
                state.BledOut = false;
                ReviveNow(player, state);
                EquipStartingLoadout(player);
            }
        }

        Emit(
            SimEventType.RoundEnd,
            new Dictionary<string, object?> { ["round"] = State.Round });
    }

    private int AliveZombies
    {
        get
        {
            var count = 0;
            foreach (var id in _zombieIds)
            {
                if (_simulation.World.Players.TryGetValue(id, out var zombie) && zombie.Alive)
                {
                    count++;
                }
            }

            return count;
        }
    }

    private void SpawnZombie()
    {
        var candidates = new List<Vec3>();
        foreach (var zone in _data.Zones)
        {
            if (!State.OpenZones.Contains(zone.Id))
            {
                continue;
            }

            candidates.AddRange(zone.SpawnPoints);
        }

        if (candidates.Count == 0)
        {
            return;
        }

        var standing = Standing;
        Vec3? best = null;
        var bestScore = double.NegativeInfinity;
        foreach (var point in candidates)
        {
            var nearest = double.PositiveInfinity;
            foreach (var player in standing)
            {
                nearest = Math.Min(nearest, MathEx.Distance(point, player.Position));
            }

            var score = nearest < 8d
                ? -100d + nearest
                : -Math.Abs(nearest - 22d) + _rng.Range(0d, 6d);
            if (score > bestScore)
            {
                bestScore = score;
                best = point;
            }
        }

        if (best is null)
        {
            return;
        }

        var ground = _simulation.Collision.GroundHeightAt(
            best.X,
            best.Z,
            best.Y + 4d,
            12d);
        SpawnPosition.X = best.X;
        SpawnPosition.Y = double.IsFinite(ground) ? ground + 0.05d : best.Y;
        SpawnPosition.Z = best.Z;

        var zombie = _simulation.AddPlayer(new AddPlayerOptions
        {
            Name = $"Zombie {_nextZombieName++}",
            Team = Team.Hostile,
            IsBot = true,
        });
        _simulation.SpawnPlayer(zombie);
        MathEx.Copy(zombie.Position, SpawnPosition);

        var health = ZombieData.HealthForRound(State.Round);
        zombie.MaxHealth = health;
        zombie.Health = health;
        zombie.Weapons.Clear();

        _zombieIds.Add(zombie.Id);
        _ai.Register(zombie.Id, zombie.Position);
    }

    private void ApplyZombieMelee(int zombieId, int victimId)
    {
        if (!_simulation.World.Players.TryGetValue(victimId, out var victim) ||
            !_simulation.World.Players.TryGetValue(zombieId, out var zombie) ||
            !victim.Alive)
        {
            return;
        }

        if (Players.TryGetValue(victimId, out var state) && state.Downed)
        {
            return;
        }

        _simulation.DamagePlayer(victim, new DamageInfo
        {
            Amount = ZombieDirectorAi.MeleeDamage,
            Attacker = zombie.Id,
            Victim = victim.Id,
            Cause = DamageCause.Zombie,
            WeaponId = "zombie",
            Location = HitLocation.Chest,
            Position = new Vec3(victim.Position.X, victim.Position.Y + 1d, victim.Position.Z),
            Direction = new Vec3(0d, 0d, 1d),
            Distance = MathEx.Distance(zombie.Position, victim.Position),
            IgnoreArmor = false,
        });
    }

    private void ConsumeSimulationEvents(IReadOnlyList<SimEvent> simulationEvents)
    {
        foreach (var simulationEvent in simulationEvents)
        {
            if (simulationEvent.Type == SimEventType.Damage && simulationEvent is DamageEvent damage)
            {
                if (!_simulation.World.Players.TryGetValue(damage.Victim, out var victim) ||
                    victim.Team != Team.Hostile ||
                    !Players.ContainsKey(damage.Attacker))
                {
                    continue;
                }

                if (victim.Alive)
                {
                    Award(damage.Attacker, ZombieData.Points.Hit, "hit");
                }

                continue;
            }

            if (simulationEvent.Type != SimEventType.Kill || simulationEvent is not KillEvent kill)
            {
                continue;
            }

            if (!_simulation.World.Players.TryGetValue(kill.Victim, out var killedPlayer))
            {
                continue;
            }

            if (killedPlayer.Team == Team.Hostile)
            {
                OnZombieKilled(killedPlayer, kill.Killer, kill.Headshot, kill.Cause);
            }
            else if (Players.ContainsKey(killedPlayer.Id))
            {
                OnSurvivorDown(killedPlayer);
            }
        }
    }

    private void OnZombieKilled(
        PlayerState zombie,
        int killerId,
        bool headshot,
        DamageCause cause)
    {
        _zombieIds.Remove(zombie.Id);
        _ai.Unregister(zombie.Id);

        if (Players.TryGetValue(killerId, out var playerState))
        {
            var amount = cause == DamageCause.Melee
                ? ZombieData.Points.MeleeKill
                : headshot
                    ? ZombieData.Points.HeadshotKill
                    : ZombieData.Points.Kill;
            Award(killerId, amount, headshot ? "headshot_kill" : "kill");
            playerState.Kills++;
        }

        _simulation.RemovePlayer(zombie.Id);
    }

    private void OnSurvivorDown(PlayerState player)
    {
        if (!Players.TryGetValue(player.Id, out var state) || state.Downed)
        {
            return;
        }

        if (state.Perks.Contains("quick_revive", StringComparer.Ordinal) &&
            !state.SelfReviveUsed &&
            Standing.Count == 0)
        {
            state.SelfReviveUsed = true;
            ReviveNow(player, state);
            EmitAnnounce("快速復活");
            return;
        }

        state.Downed = true;
        state.Downs++;
        state.BleedOut = ZombieData.Down.BleedOutTime;
        state.ReviveProgress = 0d;
        state.Reviver = SimulationTypes.NullEntity;
        state.Perks = [];

        player.Alive = true;
        player.Health = 1d;
        player.MaxHealth = GameConstants.Health.Maximum;
        player.RespawnTimer = 0d;
        player.Stance = Stance.Prone;
        player.PreviousStance = Stance.Prone;
        player.StanceProgress = 1d;
        EquipStartingLoadout(player);
        player.Health = 1d;

        Emit(
            SimEventType.Death,
            new Dictionary<string, object?>
            {
                ["player"] = player.Id,
                ["downed"] = true,
            });
        EmitAnnounce($"{player.Name}倒地");
    }

    private void ReconcileDowns()
    {
        foreach (var pair in Players)
        {
            if (!_simulation.World.Players.TryGetValue(pair.Key, out var player) ||
                player.Alive ||
                pair.Value.Downed ||
                pair.Value.BledOut)
            {
                continue;
            }

            OnSurvivorDown(player);
        }
    }

    private void StepDowned(double deltaTime)
    {
        foreach (var pair in Players)
        {
            var id = pair.Key;
            var state = pair.Value;
            if (!state.Downed || !_simulation.World.Players.TryGetValue(id, out var player))
            {
                continue;
            }

            state.BleedOut -= deltaTime;
            if (state.BleedOut <= 0d)
            {
                state.Downed = false;
                state.BledOut = true;
                player.Alive = false;
                player.Health = 0d;
                player.RespawnTimer = double.PositiveInfinity;
                Emit(
                    SimEventType.Death,
                    new Dictionary<string, object?>
                    {
                        ["player"] = id,
                        ["bledOut"] = true,
                    });
                continue;
            }

            PlayerState? reviver = null;
            foreach (var other in Standing)
            {
                if (other.Id == id)
                {
                    continue;
                }

                if (MathEx.Distance(other.Position, player.Position) <= ZombieData.Down.ReviveRadius)
                {
                    reviver = other;
                    break;
                }
            }

            if (reviver is null)
            {
                state.ReviveProgress = 0d;
                state.Reviver = SimulationTypes.NullEntity;
                continue;
            }

            var speed = 1d;
            if (Players.TryGetValue(reviver.Id, out var reviverState) &&
                reviverState.Perks.Contains("quick_revive", StringComparer.Ordinal))
            {
                var multiplier = ZombieData.Perks["quick_revive"].ReviveMultiplier ?? 0.45d;
                speed = 1d / multiplier;
            }

            state.Reviver = reviver.Id;
            state.ReviveProgress = MathEx.Clamp01(
                state.ReviveProgress +
                deltaTime / ZombieData.Down.ReviveTime * speed);

            if (state.ReviveProgress >= 1d)
            {
                ReviveNow(player, state);
                Award(reviver.Id, ZombieData.Points.Revive, "revive");
                if (Players.TryGetValue(reviver.Id, out var reviverZombieState))
                {
                    reviverZombieState.Revives++;
                }

                EmitAnnounce($"{player.Name}已救起");
            }
        }
    }

    private static void ReviveNow(PlayerState player, ZombiePlayerState state)
    {
        state.Downed = false;
        state.BledOut = false;
        state.BleedOut = 0d;
        state.ReviveProgress = 0d;
        state.Reviver = SimulationTypes.NullEntity;
        player.Alive = true;
        player.Health = ZombieData.Down.ReviveHealth;
        player.MaxHealth = GameConstants.Health.Maximum;
        player.Stance = Stance.Stand;
        player.PreviousStance = Stance.Stand;
        player.StanceProgress = 1d;
    }

    private void CheckGameOver()
    {
        if (State.Phase == RoundPhase.GameOver || Players.Count == 0)
        {
            return;
        }

        foreach (var pair in Players)
        {
            if (!_simulation.World.Players.TryGetValue(pair.Key, out var player))
            {
                continue;
            }

            if (pair.Value.Downed || (player.Alive && !pair.Value.Downed))
            {
                return;
            }
        }

        State.Phase = RoundPhase.GameOver;
        Emit(
            SimEventType.MatchStateChanged,
            new Dictionary<string, object?>
            {
                ["gameOver"] = true,
                ["round"] = State.Round,
            });
        EmitAnnounce($"撐過{State.HighestRound}回合");
    }

    private void ApplyModifiers(
        PlayerState player,
        MovementModifiers movement,
        WeaponModifiers weapon)
    {
        if (player.Team == Team.Hostile)
        {
            var baseSpeed = ZombieData.SpeedForRound(State.Round) / 4.6d;
            movement.SpeedMultiplier = baseSpeed * _ai.SpeedMultiplier(player.Id) * 0.78d;
            movement.SprintBlocked = false;
            weapon.FireBlocked = true;
            return;
        }

        if (!Players.TryGetValue(player.Id, out var state))
        {
            return;
        }

        if (state.Downed)
        {
            movement.SpeedMultiplier *= ZombieData.Down.CrawlSpeedMultiplier;
            movement.SlideBlocked = true;
            movement.SprintBlocked = true;
            return;
        }

        foreach (var perkId in state.Perks)
        {
            if (!ZombieData.Perks.TryGetValue(perkId, out var perk))
            {
                continue;
            }

            if (perk.SpeedMultiplier is { } speed && speed != 0d)
            {
                movement.SpeedMultiplier *= speed;
            }

            if (perk.ReloadMultiplier is { } reload && reload != 0d)
            {
                weapon.ReloadSpeedMult *= reload;
            }
        }
    }

    private void Award(int playerId, int amount, string reason)
    {
        if (!Players.TryGetValue(playerId, out var state) || amount <= 0)
        {
            return;
        }

        state.Points += amount;
        state.TotalEarned += amount;
        Emit(
            SimEventType.ScoreAwarded,
            new Dictionary<string, object?>
            {
                ["player"] = playerId,
                ["amount"] = amount,
                ["reason"] = reason,
            });
    }

    private bool Spend(int playerId, int amount)
    {
        if (!Players.TryGetValue(playerId, out var state) || state.Points < amount)
        {
            return false;
        }

        state.Points -= amount;
        return true;
    }

    private int CostOf(ZombieInteractableDef definition, int playerId)
    {
        Players.TryGetValue(playerId, out var state);
        switch (definition.Kind)
        {
            case InteractKind.MysteryBox:
                return ZombieData.MysteryBoxCost;
            case InteractKind.PackAPunch:
                return ZombieData.PackAPunchCost;
            case InteractKind.PerkMachine:
                return !string.IsNullOrEmpty(definition.PerkId) &&
                       ZombieData.Perks.TryGetValue(definition.PerkId, out var perk)
                    ? perk.Cost
                    : 0;
            case InteractKind.WallBuy:
                return state is not null &&
                       state.OwnedWallWeapons.Contains(definition.WeaponId ?? string.Empty)
                    ? definition.AmmoCost ?? JsRound(definition.Cost * 0.4d)
                    : definition.Cost;
            default:
                return definition.Cost;
        }
    }

    private string BlockedReason(
        ZombieInteractableDef definition,
        int playerId,
        int cost)
    {
        if (!Players.TryGetValue(playerId, out var state))
        {
            return "unavailable";
        }

        if (!State.OpenZones.Contains(definition.Zone))
        {
            return "area locked";
        }

        if (definition.RequiresPower && !State.PowerOn)
        {
            return "needs power";
        }

        if (definition.Kind == InteractKind.Door &&
            State.OpenZones.Contains(definition.OpensZone ?? string.Empty))
        {
            return "already open";
        }

        if (definition.Kind == InteractKind.Power && State.PowerOn)
        {
            return "already on";
        }

        if (definition.Kind == InteractKind.PerkMachine)
        {
            if (state.Perks.Contains(definition.PerkId ?? string.Empty, StringComparer.Ordinal))
            {
                return "already owned";
            }

            if (state.Perks.Count >= ZombieData.MaximumPerks)
            {
                return "no perk slots";
            }
        }

        if (definition.Kind == InteractKind.PackAPunch &&
            _simulation.World.Players.TryGetValue(playerId, out var player))
        {
            var slot = (int)player.ActiveSlot;
            var held = slot >= 0 && slot < player.Weapons.Count ? player.Weapons[slot] : null;
            if (held is not null && state.Upgraded.Contains(held.DefId))
            {
                return "already upgraded";
            }
        }

        if (cost > 0 && state.Points < cost)
        {
            return $"need {cost}";
        }

        return string.Empty;
    }

    private static void ApplyPerkOnPurchase(PlayerState player, string perkId)
    {
        if (!ZombieData.Perks.TryGetValue(perkId, out var perk))
        {
            return;
        }

        if (perk.HealthMultiplier is { } multiplier && multiplier != 0d)
        {
            player.MaxHealth = JsRound(GameConstants.Health.Maximum * multiplier);
            player.Health = player.MaxHealth;
        }
    }

    private static ZombieInteractionResult BuyWallWeapon(
        PlayerState player,
        ZombiePlayerState state,
        ZombieInteractableDef definition)
    {
        var weapon = WeaponData.TryGetWeapon(definition.WeaponId ?? string.Empty);
        if (weapon is null)
        {
            return Interaction(false, string.Empty);
        }

        var owned = state.OwnedWallWeapons.Contains(weapon.Id);
        var existing = player.Weapons.FirstOrDefault(candidate => candidate.DefId == weapon.Id);
        if (owned && existing is not null)
        {
            existing.AmmoReserve = Math.Min(
                weapon.MaxReserve,
                existing.AmmoReserve + weapon.MagSize * ZombieData.WallAmmoMagazines);
            return Interaction(true, "ammo");
        }

        var slot = player.Weapons.Count < 2 ? player.Weapons.Count : (int)player.ActiveSlot;
        SetWeaponSlot(
            player,
            slot,
            WorldFactory.CreateWeaponState(weapon.Id, weapon.MagSize, weapon.StartingReserve));
        player.ActiveSlot = (WeaponSlot)slot;
        state.OwnedWallWeapons.Add(weapon.Id);
        return Interaction(true, weapon.Name);
    }

    private ZombieInteractionResult RollMysteryBox(
        PlayerState player,
        ZombiePlayerState state)
    {
        var pool = new List<WeaponDef>();
        pool.AddRange(WeaponData.WeaponsByClass[WeaponClass.AssaultRifle]);
        pool.AddRange(WeaponData.WeaponsByClass[WeaponClass.SubmachineGun]);
        pool.AddRange(WeaponData.WeaponsByClass[WeaponClass.LightMachineGun]);
        pool.AddRange(WeaponData.WeaponsByClass[WeaponClass.Shotgun]);
        pool.AddRange(WeaponData.WeaponsByClass[WeaponClass.SniperRifle]);
        pool.AddRange(WeaponData.WeaponsByClass[WeaponClass.MarksmanRifle]);
        pool.AddRange(WeaponData.WeaponsByClass[WeaponClass.Launcher]);
        if (pool.Count == 0)
        {
            return Interaction(false, string.Empty);
        }

        var weights = new List<double>(pool.Count);
        foreach (var weapon in pool)
        {
            weights.Add(weapon.Class switch
            {
                WeaponClass.LightMachineGun => 14d,
                WeaponClass.Launcher => 4d,
                WeaponClass.SniperRifle => 6d,
                _ => 10d,
            });
        }

        var selected = _rng.PickWeighted(pool, weights);
        var slot = player.Weapons.Count < 2 ? player.Weapons.Count : (int)player.ActiveSlot;
        SetWeaponSlot(
            player,
            slot,
            WorldFactory.CreateWeaponState(
                selected.Id,
                selected.MagSize,
                selected.StartingReserve));
        player.ActiveSlot = (WeaponSlot)slot;

        Emit(
            SimEventType.MedalEarned,
            new Dictionary<string, object?>
            {
                ["player"] = player.Id,
                ["box"] = selected.Id,
            });
        _ = state;
        return Interaction(true, selected.Name);
    }

    private ZombieInteractionResult PackAPunch(
        PlayerState player,
        ZombiePlayerState state)
    {
        var slot = (int)player.ActiveSlot;
        if (slot < 0 || slot >= player.Weapons.Count)
        {
            return Interaction(false, string.Empty);
        }

        var weaponState = player.Weapons[slot];
        if (state.Upgraded.Contains(weaponState.DefId))
        {
            return Interaction(false, "already upgraded");
        }

        state.Upgraded.Add(weaponState.DefId);
        var definition = WeaponData.TryGetWeapon(weaponState.DefId);
        if (definition is not null)
        {
            weaponState.AmmoInMag = JsRound(definition.MagSize * PapMagazineMultiplier);
            weaponState.AmmoReserve = Math.Min(
                definition.MaxReserve * 2,
                JsRound(definition.StartingReserve * PapMagazineMultiplier));
        }

        Emit(
            SimEventType.MedalEarned,
            new Dictionary<string, object?>
            {
                ["player"] = player.Id,
                ["packAPunch"] = weaponState.DefId,
            });
        return Interaction(true, "upgraded");
    }

    private string ZoneName(string zoneId) =>
        _data.Zones.FirstOrDefault(zone => zone.Id == zoneId)?.Name ?? zoneId;

    private void Emit(SimEventType type, Dictionary<string, object?> data)
    {
        _events.Add(new GenericSimEvent(type)
        {
            Tick = _simulation.World.Tick,
            Data = data,
        });
    }

    private void EmitAnnounce(string line)
    {
        _events.Add(new AnnounceEvent
        {
            Tick = _simulation.World.Tick,
            Team = Team.Allies,
            Line = line,
        });
    }

    private static ZombieInteractionResult Interaction(bool ok, string message) =>
        new() { Ok = ok, Message = message };

    private static void SetWeaponSlot(PlayerState player, int slot, WeaponState weapon)
    {
        if (slot < player.Weapons.Count)
        {
            player.Weapons[slot] = weapon;
            return;
        }

        if (slot == player.Weapons.Count)
        {
            player.Weapons.Add(weapon);
            return;
        }

        while (player.Weapons.Count < slot)
        {
            player.Weapons.Add(new WeaponState());
        }

        player.Weapons.Add(weapon);
    }

    private static int JsRound(double value) => (int)Math.Floor(value + 0.5d);
}
