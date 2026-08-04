namespace OperationVanguard.Core;

/// <summary>
/// Interprets a campaign mission's objective graph, waves, squad, checkpoints,
/// failure state, and HUD-facing state through the ordinary game simulation.
/// </summary>
public sealed class CampaignDirector
{
    private sealed class PendingWave
    {
        public required string ObjectiveId { get; init; }
        public required Wave Wave { get; init; }
        public int Remaining { get; set; }
        public double Timer { get; set; }
    }

    private sealed class Checkpoint
    {
        public required List<string> Completed { get; init; }
        public required Vec3 Position { get; init; }
        public double Yaw { get; init; }
        public double Elapsed { get; init; }
    }

    private sealed class StallMark
    {
        public double Mark { get; init; }
        public double Time { get; set; }
    }

    private static readonly SimEvent[] EmptyEvents = [];

    private readonly GameSimulation _simulation;
    private readonly NavGraph _navigation;
    private readonly BotController _bots;
    private readonly Rng _rng;
    private readonly HashSet<int> _hostiles = [];
    private readonly Dictionary<int, string> _hostileOwner = [];
    private readonly Dictionary<string, int> _allies = new(StringComparer.Ordinal);
    private readonly List<PendingWave> _pending = [];
    private readonly List<SimEvent> _events = [];
    private readonly HashSet<int> _using = [];
    private readonly Dictionary<int, double> _corpses = [];
    private readonly Dictionary<string, StallMark> _stallProgress = new(StringComparer.Ordinal);

    private int _playerId = SimulationTypes.NullEntity;
    private Checkpoint? _checkpoint;
    private int _nextHostileName = 1;

    public CampaignDirector(
        GameSimulation simulation,
        NavGraph navigation,
        BotController bots,
        Rng rng,
        MissionDef mission)
    {
        _simulation = simulation;
        _navigation = navigation;
        _bots = bots;
        _rng = rng;
        Mission = mission;

        var objectiveStates = new Dictionary<string, ObjectiveState>(StringComparer.Ordinal);
        foreach (var objective in mission.Objectives)
        {
            objectiveStates.Add(
                objective.Id,
                new ObjectiveState
                {
                    Id = objective.Id,
                    Active = false,
                    Complete = false,
                    Elapsed = 0d,
                    Progress = 0d,
                    Kills = 0,
                });
        }

        State = new MissionState
        {
            Phase = MissionPhase.Briefing,
            Failure = FailureReason.None,
            Elapsed = 0d,
            TransitionTimer = CampaignTuning.BriefingTime,
            Objectives = objectiveStates,
            Restarts = 0,
            LastLine = string.Empty,
        };

        // Campaign has no match clock or score ending; the objective graph owns its end.
        simulation.World.Match.Phase = MatchPhase.Live;
        simulation.World.Match.TimeRemaining = 0d;
    }

    public MissionState State { get; }

    public MissionDef Mission { get; }

    public CampaignSaveSnapshot CaptureSave(PlayerState player) => new()
    {
        MissionId = Mission.Id,
        Elapsed = State.Elapsed,
        Restarts = State.Restarts,
        LastLine = State.LastLine,
        Position = MathEx.Clone(player.Position),
        Yaw = player.Yaw,
        Pitch = player.Pitch,
        Health = player.Health,
        Armor = player.Armor,
        ActiveSlot = player.ActiveSlot,
        LethalCount = player.LethalCount,
        TacticalCount = player.TacticalCount,
        FieldUpgradeCharge = player.FieldUpgradeCharge,
        Weapons = player.Weapons.Select(weapon => new CampaignWeaponSave
        {
            DefId = weapon.DefId,
            AmmoInMag = weapon.AmmoInMag,
            AmmoReserve = weapon.AmmoReserve,
            Attachments = weapon.Attachments.ToArray(),
        }).ToArray(),
        Objectives = State.Objectives.ToDictionary(
            pair => pair.Key,
            pair => new CampaignObjectiveSave
            {
                Id = pair.Value.Id,
                Active = pair.Value.Active,
                Complete = pair.Value.Complete,
                Elapsed = pair.Value.Elapsed,
                Progress = pair.Value.Progress,
                Kills = pair.Value.Kills,
            },
            StringComparer.Ordinal),
    };

    /// <summary>Restores durable progress into a freshly-created campaign session.</summary>
    public void RestoreSave(PlayerState player, CampaignSaveSnapshot save)
    {
        if (!string.Equals(save.MissionId, Mission.Id, StringComparison.Ordinal))
            throw new ArgumentException("The save belongs to a different mission.", nameof(save));

        foreach (var id in _hostiles.Concat(_corpses.Keys).Distinct().ToArray())
        {
            _bots.Unregister(id);
            _simulation.RemovePlayer(id);
        }
        _hostiles.Clear();
        _hostileOwner.Clear();
        _corpses.Clear();
        _pending.Clear();
        _stallProgress.Clear();
        _nextHostileName = 1;

        foreach (var pair in State.Objectives)
        {
            var objective = pair.Value;
            if (save.Objectives.TryGetValue(pair.Key, out var saved))
            {
                objective.Active = saved.Active;
                objective.Complete = saved.Complete;
                objective.Elapsed = Math.Max(0d, saved.Elapsed);
                objective.Progress = MathEx.Clamp01(saved.Progress);
                objective.Kills = Math.Max(0, saved.Kills);
            }
            else
            {
                objective.Active = false;
                objective.Complete = false;
                objective.Elapsed = 0d;
                objective.Progress = 0d;
                objective.Kills = 0;
            }
        }

        _simulation.SpawnPlayer(player);
        PlaceAt(player, save.Position, save.Yaw);
        player.Pitch = save.Pitch;
        player.Health = Math.Clamp(save.Health, 1d, player.MaxHealth);
        player.Armor = Math.Max(0d, save.Armor);
        player.ActiveSlot = save.ActiveSlot;
        player.LethalCount = Math.Max(0, save.LethalCount);
        player.TacticalCount = Math.Max(0, save.TacticalCount);
        player.FieldUpgradeCharge = MathEx.Clamp01(save.FieldUpgradeCharge);
        player.Action = WeaponAction.Ready;
        player.ActionTimer = 0d;
        player.AdsProgress = 0d;
        player.IsAds = false;
        player.Weapons = save.Weapons.Select(weapon => new WeaponState
        {
            DefId = weapon.DefId,
            AmmoInMag = Math.Max(0, weapon.AmmoInMag),
            AmmoReserve = Math.Max(0, weapon.AmmoReserve),
            Attachments = weapon.Attachments.ToList(),
        }).ToList();

        foreach (var spec in Mission.Allies)
        {
            if (!_allies.TryGetValue(spec.Id, out var allyId) ||
                !_simulation.World.Players.TryGetValue(allyId, out var ally)) continue;
            if (!ally.Alive) _simulation.SpawnPlayer(ally);
            PlaceAt(ally, save.Position, save.Yaw);
        }

        State.Elapsed = Math.Max(0d, save.Elapsed);
        State.Restarts = Math.Max(0, save.Restarts);
        State.LastLine = save.LastLine ?? string.Empty;
        State.Failure = FailureReason.None;
        State.TransitionTimer = 0d;
        State.Phase = MissionPhase.Active;
        _checkpoint = new Checkpoint
        {
            Completed = State.Objectives.Values
                .Where(objective => objective.Complete)
                .Select(objective => objective.Id)
                .ToList(),
            Position = MathEx.Clone(save.Position),
            Yaw = save.Yaw,
            Elapsed = State.Elapsed,
        };

        var anyActive = false;
        foreach (var definition in Mission.Objectives)
        {
            var objective = State.Objectives[definition.Id];
            if (!objective.Active || objective.Complete) continue;
            anyActive = true;
            if (definition.Trigger is EscortTrigger escort && _allies.TryGetValue(escort.Ally, out var allyId))
                _bots.OrderTo(allyId, escort.Zone.Center);
            foreach (var wave in definition.Waves ?? [])
            {
                _pending.Add(new PendingWave
                {
                    ObjectiveId = definition.Id,
                    Wave = wave,
                    Remaining = wave.Count,
                    Timer = wave.Delay ?? 0d,
                });
            }
        }
        if (!anyActive) ActivateReady();
    }

    /// <summary>Places the player at insertion and creates the authored squad and garrison.</summary>
    public void Begin(PlayerState player)
    {
        _playerId = player.Id;
        _simulation.SpawnPlayer(player);
        PlaceAt(player, Mission.Insertion.Position, Mission.Insertion.Yaw);

        var difficulty = BotData.ById.TryGetValue(Mission.Difficulty, out var selected)
            ? selected
            : BotData.Difficulties["regular"];

        foreach (var spec in Mission.Allies)
        {
            var bot = _simulation.AddPlayer(new AddPlayerOptions
            {
                Name = spec.Name,
                Team = Team.Allies,
                IsBot = true,
                BotSkill = 0.65d,
                Loadout = LoadoutSystem.BotLoadout(spec.Archetype, _allies.Count),
            });
            _simulation.SpawnPlayer(bot);
            PlaceAt(bot, spec.Spawn, Mission.Insertion.Yaw);
            _bots.Register(bot.Id, spec.Archetype, difficulty);
            _bots.SetLeader(bot.Id, player.Id);
            _allies.Add(spec.Id, bot.Id);
        }

        foreach (var wave in Mission.Garrison ?? [])
        {
            _pending.Add(new PendingWave
            {
                ObjectiveId = string.Empty,
                Wave = wave,
                Remaining = wave.Count,
                Timer = wave.Delay ?? 0d,
            });
        }
    }

    /// <summary>Advances the mission once after the simulation has produced its tick events.</summary>
    public SimEvent[] Step(double deltaTime, IReadOnlyList<SimEvent> incoming)
    {
        _events.Clear();

        if (State.Phase == MissionPhase.Briefing)
        {
            State.TransitionTimer -= deltaTime;
            if (State.TransitionTimer <= 0d)
            {
                State.Phase = MissionPhase.Active;
                ActivateReady();
            }

            return Drain();
        }

        if (State.Phase == MissionPhase.Failed)
        {
            State.TransitionTimer -= deltaTime;
            if (State.TransitionTimer <= 0d)
            {
                RestoreCheckpoint();
            }

            return Drain();
        }

        if (State.Phase == MissionPhase.Complete)
        {
            return Drain();
        }

        State.Elapsed += deltaTime;
        Consume(incoming);
        ReapCorpses(deltaTime);
        StepWaves(deltaTime);
        BreakStalemates(deltaTime);
        StepObjectives(deltaTime);
        CheckFailure();
        return Drain();
    }

    private void Consume(IReadOnlyList<SimEvent> incoming)
    {
        foreach (var simEvent in incoming)
        {
            if (simEvent.Type != SimEventType.Kill || simEvent is not KillEvent kill)
            {
                continue;
            }

            if (!_simulation.World.Players.TryGetValue(kill.Victim, out var victim))
            {
                continue;
            }

            if (victim.Team != Team.Hostile)
            {
                continue;
            }

            _hostiles.Remove(kill.Victim);
            _corpses[kill.Victim] = CampaignTuning.CorpseLinger;
            foreach (var objectiveState in State.Objectives.Values)
            {
                if (objectiveState.Active && !objectiveState.Complete)
                {
                    objectiveState.Kills++;
                }
            }
        }
    }

    private void ReapCorpses(double deltaTime)
    {
        // JavaScript permits updating/deleting the current Map entry while iterating.
        // Snapshotting retains its insertion order without invalidating a .NET enumerator.
        foreach (var entry in _corpses.ToArray())
        {
            var left = entry.Value - deltaTime;
            if (left > 0d)
            {
                _corpses[entry.Key] = left;
                continue;
            }

            _corpses.Remove(entry.Key);
            _bots.Unregister(entry.Key);
            _simulation.RemovePlayer(entry.Key);
        }
    }

    private void ReapObjectiveHostiles(string objectiveId)
    {
        foreach (var id in _hostiles.ToArray())
        {
            if (!_hostileOwner.TryGetValue(id, out var owner) || owner != objectiveId)
            {
                continue;
            }

            _hostiles.Remove(id);
            _hostileOwner.Remove(id);
            _bots.Unregister(id);
            _simulation.RemovePlayer(id);
        }

        for (var index = _pending.Count - 1; index >= 0; index--)
        {
            if (_pending[index].ObjectiveId == objectiveId)
            {
                _pending.RemoveAt(index);
            }
        }
    }

    private void BreakStalemates(double deltaTime)
    {
        foreach (var objectiveState in State.Objectives.Values)
        {
            if (!objectiveState.Active || objectiveState.Complete)
            {
                _stallProgress.Remove(objectiveState.Id);
                continue;
            }

            var mark = objectiveState.Progress + objectiveState.Kills;
            if (!_stallProgress.TryGetValue(objectiveState.Id, out var seen) || seen.Mark != mark)
            {
                _stallProgress[objectiveState.Id] = new StallMark { Mark = mark, Time = 0d };
                continue;
            }

            seen.Time += deltaTime;
            if (seen.Time < CampaignTuning.StalemateRelease)
            {
                continue;
            }

            seen.Time = 0d;
            foreach (var id in _hostiles)
            {
                if (_hostileOwner.TryGetValue(id, out var owner) && owner == objectiveState.Id)
                {
                    _bots.OrderTo(id, null);
                }
            }
        }
    }

    private void StepWaves(double deltaTime)
    {
        for (var index = _pending.Count - 1; index >= 0; index--)
        {
            var pending = _pending[index];
            if (pending.ObjectiveId.Length > 0)
            {
                if (!State.Objectives.TryGetValue(pending.ObjectiveId, out var objectiveState) ||
                    !objectiveState.Active ||
                    objectiveState.Complete)
                {
                    _pending.RemoveAt(index);
                    continue;
                }
            }

            pending.Timer -= deltaTime;
            if (pending.Timer > 0d)
            {
                continue;
            }

            if (_hostiles.Count >= CampaignTuning.MaxConcurrentHostiles)
            {
                pending.Timer = 0.5d;
                continue;
            }

            SpawnHostile(pending.Wave, pending.ObjectiveId);
            pending.Timer = pending.Wave.Interval;

            if (!pending.Wave.Endless)
            {
                pending.Remaining--;
                if (pending.Remaining <= 0)
                {
                    _pending.RemoveAt(index);
                }
            }
        }
    }

    private void StepObjectives(double deltaTime)
    {
        var anyIncomplete = false;
        foreach (var definition in Mission.Objectives)
        {
            var objectiveState = State.Objectives[definition.Id];
            if (objectiveState.Complete)
            {
                continue;
            }

            anyIncomplete = true;
            if (!objectiveState.Active)
            {
                continue;
            }

            objectiveState.Elapsed += deltaTime;
            if (definition.TimeLimit is > 0d && objectiveState.Elapsed > definition.TimeLimit.Value)
            {
                Fail(FailureReason.OutOfTime);
                return;
            }

            if (!Evaluate(definition, objectiveState, deltaTime))
            {
                continue;
            }

            objectiveState.Complete = true;
            objectiveState.Active = false;
            objectiveState.Progress = 1d;

            if (definition.Trigger is EscortTrigger escort &&
                _allies.TryGetValue(escort.Ally, out var escortedId))
            {
                _bots.OrderTo(escortedId, null);
            }

            if (definition.ReapOnComplete)
            {
                ReapObjectiveHostiles(definition.Id);
            }

            Emit(
                SimEventType.ObjectiveCaptured,
                new Dictionary<string, object?>
                {
                    ["objective"] = definition.Id,
                    ["label"] = definition.Label,
                });

            if (definition.Checkpoint)
            {
                SaveCheckpoint();
            }

            ActivateReady();
        }

        // Deliberately completes on the tick after the final objective flips.
        if (!anyIncomplete)
        {
            Complete();
        }
    }

    private bool Evaluate(Objective definition, ObjectiveState objectiveState, double deltaTime)
    {
        _simulation.World.Players.TryGetValue(_playerId, out var player);

        switch (definition.Trigger)
        {
            case ReachTrigger reach:
                if (player is null || !player.Alive)
                {
                    return false;
                }

                objectiveState.Progress = InZone(player.Position, reach.Zone) ? 1d : 0d;
                return objectiveState.Progress == 1d;

            case EliminateTrigger eliminate:
                objectiveState.Progress = Math.Min(
                    1d,
                    (double)objectiveState.Kills / Math.Max(1, eliminate.Count));
                return objectiveState.Kills >= eliminate.Count;

            case ClearTrigger:
            {
                var queued = _pending.Any(pending => pending.ObjectiveId == definition.Id);
                objectiveState.Progress = _hostiles.Count == 0 && !queued ? 1d : 0d;
                return objectiveState.Progress == 1d;
            }

            case SurviveTrigger survive:
                objectiveState.Progress = Math.Min(1d, objectiveState.Elapsed / survive.Seconds);
                return objectiveState.Elapsed >= survive.Seconds;

            case HoldTrigger hold:
                if (player is not null && player.Alive && InZone(player.Position, hold.Zone))
                {
                    objectiveState.Progress = Math.Min(
                        1d,
                        objectiveState.Progress + deltaTime / hold.Seconds);
                }

                return objectiveState.Progress >= 1d;

            case InteractTrigger interact:
                var inside = player is not null && player.Alive && InZone(player.Position, interact.Zone);
                if (inside && _using.Contains(_playerId))
                {
                    objectiveState.Progress = Math.Min(
                        1d,
                        objectiveState.Progress + deltaTime / interact.Seconds);
                }

                return objectiveState.Progress >= 1d;

            case EscortTrigger escort:
                if (!_allies.TryGetValue(escort.Ally, out var allyId) ||
                    allyId == SimulationTypes.NullEntity ||
                    !_simulation.World.Players.TryGetValue(allyId, out var ally) ||
                    !ally.Alive)
                {
                    return false;
                }

                objectiveState.Progress = InZone(ally.Position, escort.Zone) ? 1d : 0d;
                return objectiveState.Progress == 1d;

            default:
                return false;
        }
    }

    private void ActivateReady()
    {
        foreach (var definition in Mission.Objectives)
        {
            var objectiveState = State.Objectives[definition.Id];
            if (objectiveState.Active || objectiveState.Complete)
            {
                continue;
            }

            var ready = true;
            foreach (var dependency in definition.After ?? [])
            {
                if (!State.Objectives.TryGetValue(dependency, out var required) || !required.Complete)
                {
                    ready = false;
                    break;
                }
            }

            if (!ready)
            {
                continue;
            }

            objectiveState.Active = true;
            objectiveState.Elapsed = 0d;
            objectiveState.Kills = 0;
            objectiveState.Progress = 0d;

            if (definition.Trigger is EscortTrigger escort &&
                _allies.TryGetValue(escort.Ally, out var allyId))
            {
                _bots.OrderTo(allyId, escort.Zone.Center);
            }

            foreach (var wave in definition.Waves ?? [])
            {
                _pending.Add(new PendingWave
                {
                    ObjectiveId = definition.Id,
                    Wave = wave,
                    Remaining = wave.Count,
                    Timer = wave.Delay ?? 0d,
                });
            }

            Emit(
                SimEventType.ObjectiveContested,
                new Dictionary<string, object?>
                {
                    ["objective"] = definition.Id,
                    ["label"] = definition.Label,
                });
            if (definition.Line is not null)
            {
                Say(definition.Line);
            }
        }
    }

    private void CheckFailure()
    {
        if (!_simulation.World.Players.TryGetValue(_playerId, out var player) ||
            !player.Alive && player.RespawnTimer <= 0d)
        {
            Fail(FailureReason.PlayerDown);
            return;
        }

        foreach (var spec in Mission.Allies)
        {
            if (!spec.Essential)
            {
                continue;
            }

            if (!_allies.TryGetValue(spec.Id, out var allyId) ||
                allyId == SimulationTypes.NullEntity ||
                !_simulation.World.Players.TryGetValue(allyId, out var ally) ||
                !ally.Alive)
            {
                Fail(FailureReason.AllyLost);
                return;
            }
        }
    }

    private void Fail(FailureReason reason)
    {
        if (State.Phase != MissionPhase.Active)
        {
            return;
        }

        State.Phase = MissionPhase.Failed;
        State.Failure = reason;
        State.TransitionTimer = CampaignTuning.RestartDelay;
        Emit(
            SimEventType.RoundEnd,
            new Dictionary<string, object?>
            {
                ["failed"] = true,
                ["reason"] = reason,
            });
    }

    private void Complete()
    {
        State.Phase = MissionPhase.Complete;
        Emit(
            SimEventType.MatchStateChanged,
            new Dictionary<string, object?>
            {
                ["mission"] = Mission.Id,
                ["complete"] = true,
            });
        Say(Mission.Outro);
    }

    private void SaveCheckpoint()
    {
        if (!_simulation.World.Players.TryGetValue(_playerId, out var player))
        {
            return;
        }

        _checkpoint = new Checkpoint
        {
            Completed = State.Objectives.Values
                .Where(objective => objective.Complete)
                .Select(objective => objective.Id)
                .ToList(),
            Position = MathEx.Clone(player.Position),
            Yaw = player.Yaw,
            Elapsed = State.Elapsed,
        };
        Emit(
            SimEventType.RoundStart,
            new Dictionary<string, object?> { ["checkpoint"] = true });
    }

    private void RestoreCheckpoint()
    {
        foreach (var id in _hostiles)
        {
            _bots.Unregister(id);
            _simulation.RemovePlayer(id);
        }

        foreach (var id in _corpses.Keys)
        {
            _bots.Unregister(id);
            _simulation.RemovePlayer(id);
        }

        _hostiles.Clear();
        _hostileOwner.Clear();
        _corpses.Clear();
        _pending.Clear();

        var done = new HashSet<string>(_checkpoint?.Completed ?? [], StringComparer.Ordinal);
        foreach (var objectiveState in State.Objectives.Values)
        {
            objectiveState.Complete = done.Contains(objectiveState.Id);
            objectiveState.Active = false;
            objectiveState.Elapsed = 0d;
            objectiveState.Progress = 0d;
            objectiveState.Kills = 0;
        }

        if (_simulation.World.Players.TryGetValue(_playerId, out var player))
        {
            _simulation.SpawnPlayer(player);
            if (_checkpoint is not null)
            {
                PlaceAt(player, _checkpoint.Position, _checkpoint.Yaw);
            }
            else
            {
                PlaceAt(player, Mission.Insertion.Position, Mission.Insertion.Yaw);
            }
        }

        foreach (var spec in Mission.Allies)
        {
            if (!_allies.TryGetValue(spec.Id, out var allyId) ||
                allyId == SimulationTypes.NullEntity ||
                !_simulation.World.Players.TryGetValue(allyId, out var ally))
            {
                continue;
            }

            if (!ally.Alive)
            {
                _simulation.SpawnPlayer(ally);
            }

            PlaceAt(
                ally,
                _checkpoint?.Position ?? spec.Spawn,
                _checkpoint?.Yaw ?? Mission.Insertion.Yaw);
        }

        State.Elapsed = _checkpoint?.Elapsed ?? 0d;
        State.Restarts++;
        State.Failure = FailureReason.None;
        State.Phase = MissionPhase.Active;

        if (_checkpoint is null)
        {
            foreach (var wave in Mission.Garrison ?? [])
            {
                _pending.Add(new PendingWave
                {
                    ObjectiveId = string.Empty,
                    Wave = wave,
                    Remaining = wave.Count,
                    Timer = wave.Delay ?? 0d,
                });
            }
        }

        ActivateReady();
    }

    private void SpawnHostile(Wave wave, string objectiveId)
    {
        var archetypes = wave.Archetypes ?? LoadoutSystem.BotArchetypes;
        var archetype = archetypes[_rng.Int(0, archetypes.Count - 1)];
        var difficulty = BotData.ById.TryGetValue(Mission.Difficulty, out var selected)
            ? selected
            : BotData.Difficulties["regular"];

        var hostileNumber = _nextHostileName++;
        var bot = _simulation.AddPlayer(new AddPlayerOptions
        {
            Name = $"Hostile{hostileNumber}",
            Team = Team.Hostile,
            IsBot = true,
            BotSkill = 0.5d,
            // TypeScript increments in the template literal before evaluating this field.
            Loadout = LoadoutSystem.BotLoadout(archetype, _nextHostileName),
        });
        _simulation.SpawnPlayer(bot);

        const double spread = 1.6d;
        var x = wave.Spawn.X + _rng.Range(-spread, spread);
        var z = wave.Spawn.Z + _rng.Range(-spread, spread);
        var groundY = _simulation.Collision.GroundHeightAt(
            x,
            z,
            wave.Spawn.Y + 2d,
            8d);
        PlaceAt(
            bot,
            new Vec3(x, double.IsFinite(groundY) ? groundY + 0.05d : wave.Spawn.Y, z),
            0d);

        _bots.Register(bot.Id, archetype, difficulty, BotData.EnemyMovementScale);
        _simulation.SetOutgoingDamageScale(bot.Id, BotData.EnemyDamageScale);
        _bots.OrderTo(bot.Id, wave.Post ?? wave.Spawn);
        _hostiles.Add(bot.Id);
        _hostileOwner[bot.Id] = objectiveId;
    }

    private static void PlaceAt(PlayerState player, Vec3 position, double yaw)
    {
        MathEx.Copy(player.Position, position);
        MathEx.Set(player.Velocity, 0d, 0d, 0d);
        player.Yaw = yaw;
    }

    /// <summary>Tells the director whether a player is holding use this tick.</summary>
    public void SetUsing(int playerId, bool held)
    {
        if (held)
        {
            _using.Add(playerId);
        }
        else
        {
            _using.Remove(playerId);
        }
    }

    /// <summary>Active HUD objectives in authored order.</summary>
    public List<CampaignHudObjective> ActiveObjectives()
    {
        var output = new List<CampaignHudObjective>();
        foreach (var definition in Mission.Objectives)
        {
            var objectiveState = State.Objectives[definition.Id];
            if (!objectiveState.Active || objectiveState.Complete)
            {
                continue;
            }

            output.Add(new CampaignHudObjective(
                definition.Label,
                objectiveState.Progress,
                TriggerPosition(definition)));
        }

        return output;
    }

    /// <summary>Maximum living ally distance from the player.</summary>
    public double SquadSpread()
    {
        if (!_simulation.World.Players.TryGetValue(_playerId, out var player))
        {
            return double.PositiveInfinity;
        }

        var worst = 0d;
        foreach (var id in _allies.Values)
        {
            if (!_simulation.World.Players.TryGetValue(id, out var ally) || !ally.Alive)
            {
                continue;
            }

            worst = Math.Max(worst, MathEx.DistanceXz(player.Position, ally.Position));
        }

        return worst;
    }

    public int HostileCount => _hostiles.Count;

    public int[] AllyIds => _allies.Values.ToArray();

    private void Emit(SimEventType type, Dictionary<string, object?> data)
    {
        _events.Add(new GenericSimEvent(type)
        {
            Tick = _simulation.World.Tick,
            Data = data,
        });
    }

    private void Say(string line)
    {
        State.LastLine = line;
        _events.Add(new AnnounceEvent
        {
            Tick = _simulation.World.Tick,
            Team = Team.Allies,
            Line = line,
        });
    }

    private SimEvent[] Drain() => _events.Count > 0 ? _events.ToArray() : EmptyEvents;

    private static bool InZone(Vec3 position, Zone zone) =>
        Math.Abs(position.X - zone.Center.X) <= zone.Size.X / 2d &&
        Math.Abs(position.Y - zone.Center.Y) <= zone.Size.Y / 2d &&
        Math.Abs(position.Z - zone.Center.Z) <= zone.Size.Z / 2d;

    private static Vec3? TriggerPosition(Objective definition) => definition.Trigger switch
    {
        ReachTrigger reach => reach.Zone.Center,
        HoldTrigger hold => hold.Zone.Center,
        InteractTrigger interact => interact.Zone.Center,
        EscortTrigger escort => escort.Zone.Center,
        _ => null,
    };
}
