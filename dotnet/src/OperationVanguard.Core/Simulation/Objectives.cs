namespace OperationVanguard.Core;

public sealed class ZoneState
{
    public required ObjectiveDef Def { get; init; }

    public Team Owner { get; set; }

    public double Progress { get; set; }

    public Team CapturingTeam { get; set; }

    public bool Contested { get; set; }

    public bool Active { get; set; }

    public List<int> Occupants { get; } = [];

    public double ActiveTime { get; set; }

    public double TickAccum { get; set; }

    public HashSet<int> Contributors { get; } = [];
}

public sealed class BombState
{
    public bool Planted { get; set; }

    public int Site { get; set; } = -1;

    public double Timer { get; set; }

    public double Progress { get; set; }

    public int Actor { get; set; }

    public bool Defusing { get; set; }

    public bool Resolved { get; set; }

    public Team Attackers { get; set; } = Team.Allies;
}

public sealed class TagState
{
    public int Id { get; set; }

    public Team Team { get; set; }

    public Vec3 Position { get; set; } = new();

    public double Life { get; set; }

    public int Victim { get; set; }

    public int Killer { get; set; }
}

/// <summary>
/// Competitive objective aggregate. The Mode prefix disambiguates it from the
/// campaign's per-objective state DTO.
/// </summary>
public sealed class ModeObjectiveState
{
    public List<ZoneState> Zones { get; set; } = [];

    public BombState Bomb { get; set; } = new();

    public List<TagState> Tags { get; } = [];

    public int NextTagId { get; set; } = 1;

    public int LiveZone { get; set; } = -1;

    public double RotationTimer { get; set; }

    public int TotalTicks { get; set; }
}

public sealed record PlayerScoreAward(int Player, double Amount, string Reason);

public sealed class ObjectiveTickResult
{
    public List<SimEvent> Events { get; set; } = [];

    public Dictionary<Team, double> TeamScore { get; } = [];

    public List<PlayerScoreAward> PlayerScore { get; } = [];

    public Team? RoundWinner { get; set; }

    public Dictionary<string, double>? SpawnWeights { get; set; }
}

public sealed record ObjectiveSummaryEntry(
    string Label,
    Team Owner,
    double Progress,
    bool Contested,
    bool Active);

/// <summary>Runtime shared by all competitive objective modes.</summary>
public static class ObjectiveSystem
{
    private static readonly ObjectiveTickResult Result = new();

    public static ModeObjectiveState CreateObjectiveState(MapDef map, GameModeDef mode)
    {
        var kind = mode.ObjectiveKind;
        var definitions = kind is null
            ? []
            : map.Objectives
                .Where(objective => objective.Kind == kind.Value)
                .OrderBy(objective => objective.Order ?? 0)
                .ToList();

        var zones = definitions.Select(definition => new ZoneState
        {
            Def = definition,
            Owner = definition.InitialOwner ?? Team.None,
            Progress = 0d,
            CapturingTeam = Team.None,
            Contested = false,
            Active = kind == ObjectiveKind.DominationFlag,
            ActiveTime = 0d,
            TickAccum = 0d,
        }).ToList();

        var rotating = kind is ObjectiveKind.Hardpoint or ObjectiveKind.Headquarters;
        if (rotating && zones.Count > 0)
        {
            zones[0].Active = true;
        }

        return new ModeObjectiveState
        {
            Zones = zones,
            Bomb = new BombState
            {
                Planted = false,
                Site = -1,
                Timer = 0d,
                Progress = 0d,
                Actor = 0,
                Defusing = false,
                Resolved = false,
                Attackers = Team.Allies,
            },
            LiveZone = rotating && zones.Count > 0 ? 0 : -1,
            RotationTimer = rotating ? mode.NumberParam("rotationTime", 60d) : 0d,
            TotalTicks = 0,
        };
    }

    public static ObjectiveTickResult StepObjectives(
        WorldState world,
        MapDef map,
        GameModeDef mode,
        ModeObjectiveState state,
        double deltaTime)
    {
        Result.Events = [];
        Result.TeamScore.Clear();
        Result.PlayerScore.Clear();
        Result.RoundWinner = null;
        Result.SpawnWeights = null;

        if (world.Match.Phase is not (MatchPhase.Live or MatchPhase.Overtime))
        {
            return Result;
        }

        switch (mode.ObjectiveKind)
        {
            case ObjectiveKind.DominationFlag:
                StepDomination(world, mode, state, deltaTime);
                break;
            case ObjectiveKind.Hardpoint:
                StepHardpoint(world, mode, state, deltaTime);
                break;
            case ObjectiveKind.Headquarters:
                StepHeadquarters(world, mode, state, deltaTime);
                break;
            case ObjectiveKind.BombSite:
                StepSearchAndDestroy(world, map, mode, state, deltaTime);
                break;
        }

        if (mode.Id == "kc")
        {
            StepKillConfirmed(world, mode, state, deltaTime);
        }

        return Result;
    }

    public static bool RespawnAllowed(
        GameModeDef mode,
        ModeObjectiveState state,
        PlayerState player)
    {
        if (mode.ObjectiveKind != ObjectiveKind.Headquarters)
        {
            return true;
        }

        if (mode.NumberParam("ownerRespawnDisabled", 1d) == 0d)
        {
            return true;
        }

        if (state.LiveZone < 0)
        {
            return true;
        }

        var zone = state.Zones[state.LiveZone];
        return zone.Owner != player.Team;
    }

    public static void ResetRound(ModeObjectiveState state, GameModeDef mode, int round)
    {
        var swapAfter = mode.NumberParam("swapSidesAfterRound", 6d);
        state.Bomb = new BombState
        {
            Planted = false,
            Site = -1,
            Timer = 0d,
            Progress = 0d,
            Actor = 0,
            Defusing = false,
            Resolved = false,
            Attackers = round > swapAfter ? Team.Axis : Team.Allies,
        };

        foreach (var zone in state.Zones)
        {
            zone.Owner = zone.Def.InitialOwner ?? Team.None;
            zone.Progress = 0d;
            zone.CapturingTeam = Team.None;
            zone.Contested = false;
            zone.Occupants.Clear();
            zone.TickAccum = 0d;
            zone.ActiveTime = 0d;
            zone.Contributors.Clear();
        }

        state.Tags.Clear();
    }

    public static void DropTag(
        ModeObjectiveState state,
        PlayerState victim,
        int killer,
        double lifetime)
    {
        state.Tags.Add(new TagState
        {
            Id = state.NextTagId++,
            Team = victim.Team,
            Position = new Vec3(victim.Position.X, victim.Position.Y + 0.3d, victim.Position.Z),
            Life = lifetime,
            Victim = victim.Id,
            Killer = killer,
        });
    }

    public static IReadOnlyList<ZoneState> ContestableZones(ModeObjectiveState state, Team team) =>
        state.Zones.Where(zone => zone.Active && zone.Owner != team).ToArray();

    public static IReadOnlyList<ZoneState> OwnedZones(ModeObjectiveState state, Team team) =>
        state.Zones.Where(zone => zone.Active && zone.Owner == team).ToArray();

    public static IReadOnlyList<ObjectiveSummaryEntry> ObjectiveSummary(ModeObjectiveState state) =>
        state.Zones.Select(zone => new ObjectiveSummaryEntry(
            zone.Def.Label,
            zone.Owner,
            zone.Progress,
            zone.Contested,
            zone.Active)).ToArray();

    private static bool IsInside(PlayerState player, ObjectiveDef definition)
    {
        var position = player.Position;
        var center = definition.Position;
        var size = definition.Size;
        return Math.Abs(position.X - center.X) <= size.X / 2d &&
               Math.Abs(position.Z - center.Z) <= size.Z / 2d &&
               position.Y >= center.Y - 2d &&
               position.Y <= center.Y + size.Y;
    }

    private static (int Allies, int Axis) RefreshOccupants(WorldState world, ZoneState zone)
    {
        zone.Occupants.Clear();
        var allies = 0;
        var axis = 0;

        foreach (var player in world.Players.Values)
        {
            if (!player.Alive || !IsInside(player, zone.Def))
            {
                continue;
            }

            zone.Occupants.Add(player.Id);
            if (player.Team == Team.Allies)
            {
                allies++;
            }
            else if (player.Team == Team.Axis)
            {
                axis++;
            }
        }

        zone.Contested = allies > 0 && axis > 0;
        return (allies, axis);
    }

    private static void AddTeamScore(Team team, double amount)
    {
        Result.TeamScore[team] = Result.TeamScore.GetValueOrDefault(team) + amount;
    }

    private static void AddPlayerScore(int player, double amount, string reason)
    {
        Result.PlayerScore.Add(new PlayerScoreAward(player, amount, reason));
    }

    private static void StepDomination(
        WorldState world,
        GameModeDef mode,
        ModeObjectiveState state,
        double deltaTime)
    {
        var captureTime = mode.NumberParam("captureTime", 10d);
        var perExtra = mode.NumberParam("captureSpeedPerExtraPlayer", 0.5d);
        var decayRate = mode.NumberParam("captureDecayRate", 0.5d);

        foreach (var zone in state.Zones)
        {
            var (allies, axis) = RefreshOccupants(world, zone);
            if (zone.Contested)
            {
                Emit(SimEventType.ObjectiveContested, new Dictionary<string, object?>
                {
                    ["label"] = zone.Def.Label,
                });
                continue;
            }

            var presentTeam = allies > 0
                ? Team.Allies
                : axis > 0
                    ? Team.Axis
                    : Team.None;
            var count = Math.Max(allies, axis);

            if (presentTeam != Team.None && presentTeam != zone.Owner)
            {
                var rate = (1d + (count - 1d) * perExtra) / captureTime;
                if (zone.CapturingTeam != presentTeam)
                {
                    zone.CapturingTeam = presentTeam;
                    zone.Progress = 0d;
                    zone.Contributors.Clear();
                }

                foreach (var id in zone.Occupants)
                {
                    zone.Contributors.Add(id);
                }

                zone.Progress = MathEx.Clamp01(zone.Progress + rate * deltaTime);
                if (zone.Progress >= 1d)
                {
                    var previous = zone.Owner;
                    zone.Owner = presentTeam;
                    zone.Progress = 0d;
                    zone.CapturingTeam = Team.None;

                    foreach (var id in zone.Contributors)
                    {
                        if (world.Players.TryGetValue(id, out var player) && player.Team == presentTeam)
                        {
                            player.Captures++;
                            AddPlayerScore(id, mode.Scoring.Capture, "capture");
                        }
                    }

                    zone.Contributors.Clear();
                    Emit(SimEventType.ObjectiveCaptured, new Dictionary<string, object?>
                    {
                        ["label"] = zone.Def.Label,
                        ["team"] = presentTeam,
                        ["previousOwner"] = previous,
                    });
                    Result.SpawnWeights = DominationSpawnWeights(state);
                }
            }
            else if (presentTeam == Team.None && zone.Progress > 0d)
            {
                zone.Progress = Math.Max(0d, zone.Progress - decayRate / captureTime * deltaTime);
                if (zone.Progress <= 0d)
                {
                    zone.CapturingTeam = Team.None;
                }
            }
            else if (presentTeam == zone.Owner)
            {
                if (zone.CapturingTeam != Team.None && zone.CapturingTeam != zone.Owner)
                {
                    zone.Progress = Math.Max(
                        0d,
                        zone.Progress - 2d / captureTime * deltaTime * count);
                    if (zone.Progress <= 0d)
                    {
                        zone.CapturingTeam = Team.None;
                    }
                }
            }

            if (zone.Owner != Team.None && !zone.Contested)
            {
                zone.TickAccum += deltaTime;
                if (zone.TickAccum >= mode.Scoring.ObjectiveTickInterval)
                {
                    zone.TickAccum -= mode.Scoring.ObjectiveTickInterval;
                    AddTeamScore(zone.Owner, mode.Scoring.ObjectiveTick);
                    state.TotalTicks++;

                    foreach (var id in zone.Occupants)
                    {
                        if (world.Players.TryGetValue(id, out var player) && player.Team == zone.Owner)
                        {
                            player.Defends++;
                            AddPlayerScore(id, mode.Scoring.Defend, "defend");
                        }
                    }
                }
            }
        }
    }

    private static Dictionary<string, double> DominationSpawnWeights(ModeObjectiveState state)
    {
        var weights = new Dictionary<string, double>(StringComparer.Ordinal);
        foreach (var zone in state.Zones)
        {
            var label = zone.Def.Label.ToLowerInvariant();
            if (zone.Owner == Team.Allies)
            {
                weights[$"allies_{label}"] = 1d;
                weights[$"contested_{label}"] = 0.6d;
            }
            else if (zone.Owner == Team.Axis)
            {
                weights[$"axis_{label}"] = 1d;
                weights[$"contested_{label}"] = 0.6d;
            }
        }

        return weights;
    }

    private static void StepHardpoint(
        WorldState world,
        GameModeDef mode,
        ModeObjectiveState state,
        double deltaTime)
    {
        if (state.Zones.Count == 0)
        {
            return;
        }

        var rotationTime = mode.NumberParam("rotationTime", 60d);
        var rotationGap = mode.NumberParam("rotationGap", 5d);
        state.RotationTimer -= deltaTime;

        if (state.RotationTimer <= 0d)
        {
            if (state.LiveZone >= 0)
            {
                state.Zones[state.LiveZone].Active = false;
                state.Zones[state.LiveZone].Owner = Team.None;
                state.LiveZone = -1;
                state.RotationTimer = rotationGap;
                Emit(SimEventType.ObjectiveNeutralized, []);
            }
            else
            {
                var next = (FindLastIndex(state.Zones) + 1) % state.Zones.Count;
                state.LiveZone = next;
                state.Zones[next].Active = true;
                state.Zones[next].Owner = Team.None;
                state.Zones[next].TickAccum = 0d;
                state.Zones[next].ActiveTime = 0d;
                state.RotationTimer = rotationTime;
                Emit(SimEventType.RoundStart, new Dictionary<string, object?>
                {
                    ["hardpoint"] = state.Zones[next].Def.Label,
                });
            }

            return;
        }

        if (state.LiveZone < 0)
        {
            return;
        }

        var zone = state.Zones[state.LiveZone];
        zone.ActiveTime += deltaTime;
        var (allies, axis) = RefreshOccupants(world, zone);
        if (zone.Contested)
        {
            Emit(SimEventType.ObjectiveContested, new Dictionary<string, object?>
            {
                ["label"] = zone.Def.Label,
            });
            return;
        }

        var holder = allies > 0 ? Team.Allies : axis > 0 ? Team.Axis : Team.None;
        if (holder != Team.None && holder != zone.Owner)
        {
            zone.Owner = holder;
            foreach (var id in zone.Occupants)
            {
                AddPlayerScore(id, mode.Scoring.Capture, "capture");
            }

            Emit(SimEventType.ObjectiveCaptured, new Dictionary<string, object?>
            {
                ["label"] = zone.Def.Label,
                ["team"] = holder,
            });
        }

        if (zone.Owner != Team.None && holder == zone.Owner)
        {
            zone.TickAccum += deltaTime;
            while (zone.TickAccum >= mode.Scoring.ObjectiveTickInterval)
            {
                zone.TickAccum -= mode.Scoring.ObjectiveTickInterval;
                AddTeamScore(zone.Owner, mode.Scoring.ObjectiveTick);
                state.TotalTicks++;
                foreach (var id in zone.Occupants)
                {
                    AddPlayerScore(id, mode.Scoring.Defend, "hold");
                }
            }
        }
    }

    private static int FindLastIndex(IReadOnlyList<ZoneState> zones)
    {
        for (var index = zones.Count - 1; index >= 0; index--)
        {
            if (zones[index].ActiveTime > 0d)
            {
                return index;
            }
        }

        return -1;
    }

    private static void StepHeadquarters(
        WorldState world,
        GameModeDef mode,
        ModeObjectiveState state,
        double deltaTime)
    {
        if (state.Zones.Count == 0)
        {
            return;
        }

        var captureTime = mode.NumberParam("captureTime", 8d);
        var holdTime = mode.NumberParam("holdTime", 60d);
        var respawnGap = mode.NumberParam("respawnGap", 8d);

        if (state.LiveZone < 0)
        {
            state.RotationTimer -= deltaTime;
            if (state.RotationTimer <= 0d)
            {
                var next = (FindLastIndex(state.Zones) + 1) % state.Zones.Count;
                state.LiveZone = next;
                var nextZone = state.Zones[next];
                nextZone.Active = true;
                nextZone.Owner = Team.None;
                nextZone.Progress = 0d;
                nextZone.ActiveTime = 0d;
                nextZone.TickAccum = 0d;
                Emit(SimEventType.RoundStart, new Dictionary<string, object?>
                {
                    ["hq"] = nextZone.Def.Label,
                });
            }

            return;
        }

        var zone = state.Zones[state.LiveZone];
        zone.ActiveTime += deltaTime;
        var (allies, axis) = RefreshOccupants(world, zone);

        if (zone.Owner == Team.None)
        {
            if (!zone.Contested)
            {
                var taker = allies > 0 ? Team.Allies : axis > 0 ? Team.Axis : Team.None;
                if (taker != Team.None)
                {
                    var count = Math.Max(allies, axis);
                    zone.CapturingTeam = taker;
                    zone.Progress = MathEx.Clamp01(
                        zone.Progress + deltaTime / captureTime * (1d + (count - 1d) * 0.5d));
                    foreach (var id in zone.Occupants)
                    {
                        zone.Contributors.Add(id);
                    }

                    if (zone.Progress >= 1d)
                    {
                        zone.Owner = taker;
                        zone.Progress = 0d;
                        zone.TickAccum = 0d;
                        foreach (var id in zone.Contributors)
                        {
                            AddPlayerScore(id, mode.Scoring.Capture, "capture");
                            if (world.Players.TryGetValue(id, out var player))
                            {
                                player.Captures++;
                            }
                        }

                        zone.Contributors.Clear();
                        Emit(SimEventType.ObjectiveCaptured, new Dictionary<string, object?>
                        {
                            ["label"] = zone.Def.Label,
                            ["team"] = taker,
                        });
                    }
                }
                else
                {
                    zone.Progress = Math.Max(0d, zone.Progress - deltaTime / captureTime);
                }
            }

            return;
        }

        zone.TickAccum += deltaTime;
        while (zone.TickAccum >= mode.Scoring.ObjectiveTickInterval)
        {
            zone.TickAccum -= mode.Scoring.ObjectiveTickInterval;
            AddTeamScore(zone.Owner, mode.Scoring.ObjectiveTick);
            state.TotalTicks++;
        }

        if (zone.ActiveTime > holdTime)
        {
            zone.Active = false;
            zone.Owner = Team.None;
            state.LiveZone = -1;
            state.RotationTimer = respawnGap;
            Emit(SimEventType.ObjectiveNeutralized, new Dictionary<string, object?>
            {
                ["label"] = zone.Def.Label,
            });
        }
    }

    private static void StepSearchAndDestroy(
        WorldState world,
        MapDef map,
        GameModeDef mode,
        ModeObjectiveState state,
        double deltaTime)
    {
        var bomb = state.Bomb;
        var plantTime = mode.NumberParam("plantTime", 5d);
        var defuseTime = mode.NumberParam("defuseTime", 7.5d);

        if (bomb.Resolved)
        {
            return;
        }

        if (bomb.Planted)
        {
            bomb.Timer -= deltaTime;
            if (bomb.Timer <= 0d)
            {
                bomb.Resolved = true;
                Result.RoundWinner = bomb.Attackers;
                Emit(SimEventType.Explosion, new Dictionary<string, object?>
                {
                    ["bomb"] = true,
                });
                return;
            }

            var site = bomb.Site >= 0 && bomb.Site < state.Zones.Count
                ? state.Zones[bomb.Site]
                : null;
            if (site is not null)
            {
                RefreshOccupants(world, site);
                var defenders = site.Occupants
                    .Select(id => world.Players.GetValueOrDefault(id))
                    .Where(player => player is not null && player.Team != bomb.Attackers)
                    .Cast<PlayerState>()
                    .ToArray();

                if (defenders.Length > 0)
                {
                    bomb.Defusing = true;
                    bomb.Actor = defenders[0].Id;
                    bomb.Progress = MathEx.Clamp01(bomb.Progress + deltaTime / defuseTime);
                    if (bomb.Progress >= 1d)
                    {
                        bomb.Resolved = true;
                        bomb.Planted = false;
                        Result.RoundWinner = SimulationTypes.OpposingTeam(bomb.Attackers);
                        if (world.Players.TryGetValue(bomb.Actor, out var player))
                        {
                            player.Defuses++;
                            AddPlayerScore(player.Id, mode.Scoring.Defuse, "defuse");
                        }

                        Emit(SimEventType.BombDefused, new Dictionary<string, object?>
                        {
                            ["player"] = bomb.Actor,
                        });
                    }
                }
                else
                {
                    bomb.Defusing = false;
                    bomb.Progress = 0d;
                }
            }

            return;
        }

        var planting = false;
        for (var index = 0; index < state.Zones.Count; index++)
        {
            var site = state.Zones[index];
            RefreshOccupants(world, site);
            var attackers = site.Occupants
                .Select(id => world.Players.GetValueOrDefault(id))
                .Where(player => player is not null && player.Team == bomb.Attackers)
                .Cast<PlayerState>()
                .ToArray();

            if (attackers.Length == 0)
            {
                continue;
            }

            planting = true;
            bomb.Actor = attackers[0].Id;
            bomb.Progress = MathEx.Clamp01(bomb.Progress + deltaTime / plantTime);
            if (bomb.Progress >= 1d)
            {
                bomb.Planted = true;
                bomb.Site = index;
                bomb.Timer = mode.NumberParam("bombTimer", 45d);
                bomb.Progress = 0d;
                if (world.Players.TryGetValue(bomb.Actor, out var player))
                {
                    player.Plants++;
                    AddPlayerScore(player.Id, mode.Scoring.Plant, "plant");
                }

                Emit(SimEventType.BombPlanted, new Dictionary<string, object?>
                {
                    ["site"] = site.Def.Label,
                    ["player"] = bomb.Actor,
                });
            }

            break;
        }

        if (!planting)
        {
            bomb.Progress = 0d;
        }

        var attackersAlive = 0;
        var defendersAlive = 0;
        foreach (var player in world.Players.Values)
        {
            if (!player.Alive)
            {
                continue;
            }

            if (player.Team == bomb.Attackers)
            {
                attackersAlive++;
            }
            else
            {
                defendersAlive++;
            }
        }

        if (attackersAlive == 0 && !bomb.Planted)
        {
            bomb.Resolved = true;
            Result.RoundWinner = SimulationTypes.OpposingTeam(bomb.Attackers);
        }
        else if (defendersAlive == 0)
        {
            bomb.Resolved = true;
            Result.RoundWinner = bomb.Attackers;
        }

        _ = map;
    }

    private static void StepKillConfirmed(
        WorldState world,
        GameModeDef mode,
        ModeObjectiveState state,
        double deltaTime)
    {
        var radius = mode.NumberParam("tagPickupRadius", 1.6d);
        for (var index = state.Tags.Count - 1; index >= 0; index--)
        {
            var tag = state.Tags[index];
            tag.Life -= deltaTime;
            if (tag.Life <= 0d)
            {
                state.Tags.RemoveAt(index);
                continue;
            }

            foreach (var player in world.Players.Values)
            {
                if (!player.Alive || MathEx.Distance(player.Position, tag.Position) > radius)
                {
                    continue;
                }

                var enemyTag = SimulationTypes.IsEnemyTeam(player.Team, tag.Team);
                if (enemyTag)
                {
                    AddTeamScore(player.Team, 1d);
                    AddPlayerScore(player.Id, mode.Scoring.Confirm, "confirm");
                    if (tag.Killer != player.Id)
                    {
                        AddPlayerScore(tag.Killer, JsRound(mode.Scoring.Confirm * 0.5d), "confirmed");
                    }

                    Emit(SimEventType.TagCollected, new Dictionary<string, object?>
                    {
                        ["player"] = player.Id,
                        ["denied"] = false,
                    });
                }
                else
                {
                    AddPlayerScore(player.Id, mode.Scoring.Deny, "deny");
                    Emit(SimEventType.TagCollected, new Dictionary<string, object?>
                    {
                        ["player"] = player.Id,
                        ["denied"] = true,
                    });
                }

                state.Tags.RemoveAt(index);
                break;
            }
        }
    }

    private static double JsRound(double value) => Math.Floor(value + 0.5d);

    private static void Emit(SimEventType type, Dictionary<string, object?> data)
    {
        Result.Events.Add(new GenericSimEvent(type)
        {
            Tick = 0,
            Data = data,
        });
    }
}
