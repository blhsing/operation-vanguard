using System.Collections.ObjectModel;
using System.Text.Json.Serialization;

namespace OperationVanguard.Core;

/// <summary>Perceptual and mechanical bot difficulty settings; damage is unchanged.</summary>
public sealed class BotDifficulty
{
    public string Name { get; set; } = string.Empty;
    public double ReactionTime { get; set; }
    public double AimError { get; set; }
    public double TurnSpeed { get; set; }
    public double LeadFactor { get; set; }
    public double ViewDistance { get; set; }
    public double Fov { get; set; }
    public double CoverInstinct { get; set; }
    public double GrenadeInstinct { get; set; }
    public double Persistence { get; set; }
    public double PreAim { get; set; }
    public double PanicSpray { get; set; }
}

/// <summary>Canonical bot difficulty table and exported brain factory.</summary>
public static class BotData
{
    public const double EnemyMovementScale = 0.78d;
    public const double EnemyDamageScale = 0.72d;
    public const double EnemyAggressionScale = 0.52d;

    public static IReadOnlyList<string> DifficultyIds { get; } =
        Array.AsReadOnly(["recruit", "regular", "hardened", "veteran"]);

    public static IReadOnlyDictionary<string, BotDifficulty> Difficulties { get; } =
        new ReadOnlyDictionary<string, BotDifficulty>(
            new Dictionary<string, BotDifficulty>(StringComparer.Ordinal)
            {
                ["recruit"] = new()
                {
                    Name = "新兵",
                    ReactionTime = 0.85d,
                    AimError = 0.11d,
                    TurnSpeed = 1.8d,
                    LeadFactor = 0.05d,
                    ViewDistance = 40d,
                    Fov = 1.05d,
                    CoverInstinct = 0.1d,
                    GrenadeInstinct = 0.01d,
                    Persistence = 0.35d,
                    PreAim = 0.02d,
                    PanicSpray = 0.58d,
                },
                ["regular"] = new()
                {
                    Name = "正規",
                    ReactionTime = 0.6d,
                    AimError = 0.065d,
                    TurnSpeed = 3.1d,
                    LeadFactor = 0.2d,
                    ViewDistance = 55d,
                    Fov = 1.2d,
                    CoverInstinct = 0.25d,
                    GrenadeInstinct = 0.035d,
                    Persistence = 0.62d,
                    PreAim = 0.1d,
                    PanicSpray = 0.38d,
                },
                ["hardened"] = new()
                {
                    Name = "精銳",
                    ReactionTime = 0.26d,
                    AimError = 0.022d,
                    TurnSpeed = 6.5d,
                    LeadFactor = 0.6d,
                    ViewDistance = 90d,
                    Fov = 1.45d,
                    CoverInstinct = 0.6d,
                    GrenadeInstinct = 0.12d,
                    Persistence = 1.1d,
                    PreAim = 0.45d,
                    PanicSpray = 0.12d,
                },
                ["veteran"] = new()
                {
                    Name = "老兵",
                    ReactionTime = 0.16d,
                    AimError = 0.011d,
                    TurnSpeed = 9d,
                    LeadFactor = 0.85d,
                    ViewDistance = 120d,
                    Fov = 1.6d,
                    CoverInstinct = 0.8d,
                    GrenadeInstinct = 0.18d,
                    Persistence = 1.4d,
                    PreAim = 0.7d,
                    PanicSpray = 0.05d,
                },
            });

    public static IReadOnlyDictionary<DifficultyId, BotDifficulty> ById { get; } =
        new ReadOnlyDictionary<DifficultyId, BotDifficulty>(
            new Dictionary<DifficultyId, BotDifficulty>
            {
                [DifficultyId.Recruit] = Difficulties["recruit"],
                [DifficultyId.Regular] = Difficulties["regular"],
                [DifficultyId.Hardened] = Difficulties["hardened"],
                [DifficultyId.Veteran] = Difficulties["veteran"],
            });

    public static BotDifficulty DifficultyFromSkill(double skill)
    {
        var index = (int)Math.Floor(skill * DifficultyIds.Count);
        index = Math.Clamp(index, 0, DifficultyIds.Count - 1);
        return Difficulties[DifficultyIds[index]];
    }

    public static BotDifficulty FromSkill(double skill) => DifficultyFromSkill(skill);

    public static BotDifficulty Get(DifficultyId id) => ById[id];

    /// <summary>
    /// Creates a brain while consuming exactly three RNG choices in web order:
    /// strafe direction, grenade delay, then personality offset.
    /// </summary>
    public static BotBrain CreateBrain(
        int playerId,
        BotArchetype archetype,
        BotDifficulty difficulty,
        Rng rng,
        double movementScale = 1d,
        double aggressionScale = 1d) =>
        new()
        {
            PlayerId = playerId,
            Archetype = archetype,
            Difficulty = difficulty,
            MovementScale = movementScale,
            AggressionScale = aggressionScale,
            Goal = BotGoal.Advance,
            GoalTime = 0d,
            TargetId = SimulationTypes.NullEntity,
            VisibleTime = 0d,
            LostTime = double.PositiveInfinity,
            LastKnownPosition = new Vec3(),
            Reacted = false,
            ReactionTimer = 0d,
            AimYaw = 0d,
            AimPitch = 0d,
            BiasYaw = 0d,
            BiasPitch = 0d,
            BiasTimer = 0d,
            Path = [],
            PathCursor = 0,
            Destination = -1,
            TravelGoal = -1,
            TravelAge = 0d,
            PathAge = 0d,
            PathCooldown = 0d,
            StuckTime = 0d,
            UnstickTimer = 0d,
            // Fixed deliberately: drawing here would shift every later bot decision.
            UnstickDir = 1,
            StrafeDir = rng.Chance(0.5d) ? 1 : -1,
            StrafeTimer = 0d,
            TriggerCooldown = 0d,
            GrenadeCooldown = rng.Range(2d, 8d),
            DecisionAccum = 0d,
            HoldNode = -1,
            LeaderId = SimulationTypes.NullEntity,
            OrderPosition = null,
            PersonalityOffset = rng.Range(0d, 1000d),
        };
}

[JsonConverter(typeof(JsonStringEnumConverter<BotGoal>))]
public enum BotGoal
{
    [JsonStringEnumMemberName("advance")] Advance,
    [JsonStringEnumMemberName("engage")] Engage,
    [JsonStringEnumMemberName("hunt")] Hunt,
    [JsonStringEnumMemberName("cover")] TakeCover,
    [JsonStringEnumMemberName("hold")] Hold,
    [JsonStringEnumMemberName("regroup")] Regroup,
}

/// <summary>All persistent decision state for one bot.</summary>
public sealed class BotBrain
{
    public int PlayerId { get; set; }
    public BotArchetype Archetype { get; set; }
    public BotDifficulty Difficulty { get; set; } = new();
    public double MovementScale { get; set; } = 1d;
    public double AggressionScale { get; set; } = 1d;

    public BotGoal Goal { get; set; }
    public double GoalTime { get; set; }

    public int TargetId { get; set; }
    public double VisibleTime { get; set; }
    public double LostTime { get; set; } = double.PositiveInfinity;
    public Vec3 LastKnownPosition { get; set; } = new();
    public bool Reacted { get; set; }
    public double ReactionTimer { get; set; }

    public double AimYaw { get; set; }
    public double AimPitch { get; set; }
    public double BiasYaw { get; set; }
    public double BiasPitch { get; set; }
    public double BiasTimer { get; set; }

    public List<int> Path { get; set; } = [];
    public int PathCursor { get; set; }
    public int Destination { get; set; } = -1;
    public int TravelGoal { get; set; } = -1;
    public double TravelAge { get; set; }
    public double PathAge { get; set; }
    public double PathCooldown { get; set; }

    public double StuckTime { get; set; }
    public double UnstickTimer { get; set; }
    public int UnstickDir { get; set; } = 1;

    public int StrafeDir { get; set; }
    public double StrafeTimer { get; set; }
    public double TriggerCooldown { get; set; }
    public double GrenadeCooldown { get; set; }
    public double DecisionAccum { get; set; }

    public int HoldNode { get; set; } = -1;
    public int LeaderId { get; set; }
    public Vec3? OrderPosition { get; set; }
    public double PersonalityOffset { get; set; }
}

/// <summary>
/// The structural GameSimulation surface consumed by bot.ts. The concrete simulation
/// implements this directly when it is composed; no alternate AI simulation path exists.
/// </summary>
public interface IBotSimulation
{
    WorldState World { get; }
    MapDef Map { get; }
    GameModeDef Mode { get; }

    WeaponDef ActiveWeaponDef(PlayerState player);
    bool CanSee(PlayerState observer, PlayerState target);
    void SetInput(int playerId, InputCommand input);
}

/// <summary>Deterministic bot controller that drives the same inputs as human players.</summary>
public sealed class BotController
{
    private const double OrderArrival = 1.8d;

    private static readonly Vec3 Eye = new();
    private static readonly Vec3 TargetPoint = new();
    private static readonly Vec3 ToTarget = new();
    private static readonly Vec3 Forward = new();
    private static readonly Vec3 Desired = new();

    private readonly IBotSimulation _simulation;
    private readonly NavGraph _navigation;
    private readonly Rng _rng;
    private readonly Dictionary<int, BotBrain> _brains = [];
    private readonly List<int> _brainOrder = [];

    public BotController(IBotSimulation simulation, NavGraph navigation, Rng rng)
    {
        _simulation = simulation;
        _navigation = navigation;
        _rng = rng;
    }

    public void Register(
        int playerId,
        BotArchetype archetype,
        BotDifficulty difficulty,
        double movementScale = 1d,
        double aggressionScale = 1d)
    {
        var brain = BotData.CreateBrain(
            playerId,
            archetype,
            difficulty,
            _rng,
            movementScale,
            aggressionScale);
        if (_brains.ContainsKey(playerId))
        {
            // Map.set on an existing key replaces the value without moving its slot.
            _brains[playerId] = brain;
            return;
        }

        _brains.Add(playerId, brain);
        _brainOrder.Add(playerId);
    }

    public void SetLeader(int playerId, int leaderId)
    {
        if (_brains.TryGetValue(playerId, out var brain))
        {
            brain.LeaderId = leaderId;
        }
    }

    public void OrderTo(int playerId, Vec3? position)
    {
        if (!_brains.TryGetValue(playerId, out var brain))
        {
            return;
        }

        if (position is not null &&
            brain.OrderPosition is not null &&
            MathEx.Distance(position, brain.OrderPosition) < 1d)
        {
            return;
        }

        brain.OrderPosition = position is null ? null : MathEx.Clone(position);
        brain.TravelGoal = -1;
    }

    public void Unregister(int playerId)
    {
        if (_brains.Remove(playerId))
        {
            _brainOrder.Remove(playerId);
        }
    }

    public BotBrain? GetBrain(int playerId) =>
        _brains.TryGetValue(playerId, out var brain) ? brain : null;

    /// <summary>Produces and submits one input tick for every registered bot.</summary>
    public void Update(double deltaTime)
    {
        foreach (var id in _brainOrder)
        {
            if (!_brains.TryGetValue(id, out var brain) ||
                !_simulation.World.Players.TryGetValue(id, out var player))
            {
                continue;
            }

            var input = SimulationTypes.CreateEmptyInput();
            input.Dt = deltaTime;
            input.Seq = _simulation.World.Tick;
            input.Tick = _simulation.World.Tick;

            if (player.Alive)
            {
                Think(player, brain, input, deltaTime);
                input.MoveForward *= brain.MovementScale;
                input.MoveRight *= brain.MovementScale;
            }
            else
            {
                input.Yaw = brain.AimYaw;
                input.Pitch = brain.AimPitch;
                brain.TravelGoal = -1;
            }

            _simulation.SetInput(id, input);
        }
    }

    private void Think(
        PlayerState player,
        BotBrain brain,
        InputCommand input,
        double deltaTime)
    {
        brain.GoalTime += deltaTime;
        brain.PathAge += deltaTime;
        brain.TravelAge += deltaTime;
        brain.GrenadeCooldown = Math.Max(0d, brain.GrenadeCooldown - deltaTime);
        brain.TriggerCooldown = Math.Max(0d, brain.TriggerCooldown - deltaTime);
        brain.PathCooldown = Math.Max(0d, brain.PathCooldown - deltaTime);
        brain.BiasTimer -= deltaTime;
        brain.StrafeTimer -= deltaTime;
        brain.DecisionAccum += deltaTime;

        var weapon = _simulation.ActiveWeaponDef(player);
        Perceive(player, brain, deltaTime);
        ChooseGoal(player, brain, weapon, deltaTime);
        Aim(player, brain, weapon, input, deltaTime);
        Move(player, brain, weapon, input, deltaTime);
        Act(player, brain, weapon, input);
    }

    private void Perceive(PlayerState player, BotBrain brain, double deltaTime)
    {
        var difficulty = brain.Difficulty;
        MathEx.Set(
            Eye,
            player.Position.X,
            player.Position.Y + Movement.CurrentEyeHeight(player),
            player.Position.Z);
        MathEx.AnglesToForward(Forward, brain.AimYaw, brain.AimPitch);

        var bestId = SimulationTypes.NullEntity;
        var bestScore = double.NegativeInfinity;

        foreach (var other in _simulation.World.Players.Values)
        {
            if (!other.Alive || other.Id == player.Id)
            {
                continue;
            }

            if (!SimulationTypes.IsEnemyTeam(player.Team, other.Team))
            {
                continue;
            }

            var distance = MathEx.Distance(player.Position, other.Position);
            if (distance > difficulty.ViewDistance)
            {
                continue;
            }

            MathEx.Subtract(ToTarget, other.Position, player.Position);
            MathEx.Normalize(ToTarget, ToTarget);
            var facing = ToTarget.X * Forward.X + ToTarget.Z * Forward.Z;
            var inFov = facing >= Math.Cos(difficulty.Fov);

            var audible =
                distance < GameConstants.Perception.FootstepRadiusSprint &&
                (other.MoveState == MoveState.Sprint || other.MoveState == MoveState.TacticalSprint);
            if (!inFov && !audible)
            {
                continue;
            }

            if (!_simulation.CanSee(player, other))
            {
                continue;
            }

            var score = 100d - distance * 0.8d + facing * 40d + (100d - other.Health) * 0.25d;
            if (score > bestScore)
            {
                bestScore = score;
                bestId = other.Id;
            }
        }

        if (bestId != SimulationTypes.NullEntity)
        {
            if (brain.TargetId != bestId)
            {
                brain.TargetId = bestId;
                brain.Reacted = false;
                brain.ReactionTimer =
                    difficulty.ReactionTime / Math.Max(0.35d, brain.AggressionScale) *
                    _rng.Range(0.75d, 1.3d);
                brain.VisibleTime = 0d;
                ResampleBias(brain);
            }

            brain.VisibleTime += deltaTime;
            brain.LostTime = 0d;

            if (_simulation.World.Players.TryGetValue(bestId, out var target))
            {
                MathEx.Copy(brain.LastKnownPosition, target.Position);
            }

            if (!brain.Reacted)
            {
                brain.ReactionTimer -= deltaTime;
                if (brain.ReactionTimer <= 0d)
                {
                    brain.Reacted = true;
                }
            }
        }
        else
        {
            brain.LostTime += deltaTime;
            brain.VisibleTime = 0d;
            if (brain.LostTime > 4d * difficulty.Persistence * brain.AggressionScale)
            {
                brain.TargetId = SimulationTypes.NullEntity;
                brain.Reacted = false;
            }
        }

        if (brain.BiasTimer <= 0d)
        {
            ResampleBias(brain);
        }
    }

    private void ResampleBias(BotBrain brain)
    {
        var difficulty = brain.Difficulty;
        brain.BiasYaw = _rng.Gaussian(0d, difficulty.AimError);
        brain.BiasPitch = _rng.Gaussian(0d, difficulty.AimError * 0.7d);
        brain.BiasTimer = _rng.Range(0.35d, 1.1d);
    }

    private void ChooseGoal(
        PlayerState player,
        BotBrain brain,
        WeaponDef weapon,
        double deltaTime)
    {
        _ = deltaTime;
        var difficulty = brain.Difficulty;
        var previous = brain.Goal;
        var hasTarget = brain.TargetId != SimulationTypes.NullEntity;
        var healthFraction = player.Health / Math.Max(1d, player.MaxHealth);
        var state = WeaponSystem.ActiveWeapon(player);
        var lowAmmo = state is not null &&
                      state.AmmoInMag <= Math.Max(1d, weapon.MagSize * 0.15d);

        if (state is not null && state.AmmoInMag == 0 && state.AmmoReserve > 0)
        {
            brain.Goal = hasTarget && brain.VisibleTime > 0d
                ? BotGoal.TakeCover
                : BotGoal.Regroup;
        }
        else if (hasTarget && brain.LostTime < 0.35d)
        {
            // Keep condition order: low-health bots consume the chance roll before
            // the goal-time gate, exactly as the JavaScript && expression does.
            var defensiveHealth = 0.4d + (1d - brain.AggressionScale) * 0.3d;
            var coverInstinct =
                difficulty.CoverInstinct + (1d - brain.AggressionScale) * 0.75d;
            var wantsCover =
                healthFraction < defensiveHealth &&
                Chance(brain, coverInstinct) &&
                brain.GoalTime > 0.8d;
            brain.Goal = wantsCover ? BotGoal.TakeCover : BotGoal.Engage;
        }
        else if (hasTarget)
        {
            brain.Goal = brain.AggressionScale < 0.75d
                ? BotGoal.TakeCover
                : BotGoal.Hunt;
        }
        else if (lowAmmo && player.Action != WeaponAction.Reloading)
        {
            brain.Goal = BotGoal.Regroup;
        }
        else if (
            brain.Archetype == BotArchetype.Sniper &&
            brain.GoalTime > 3d &&
            brain.HoldNode >= 0 &&
            _rng.Chance(0.6d))
        {
            brain.Goal = BotGoal.Hold;
        }
        else
        {
            brain.Goal = BotGoal.Advance;
        }

        if (brain.Goal != previous)
        {
            brain.GoalTime = 0d;
            brain.PathAge = 99d;
        }
    }

    private bool Chance(BotBrain brain, double perSecond)
    {
        _ = brain;
        return _rng.Next() < perSecond * GameConstants.TickDt;
    }

    private void Aim(
        PlayerState player,
        BotBrain brain,
        WeaponDef weapon,
        InputCommand input,
        double deltaTime)
    {
        var difficulty = brain.Difficulty;
        MathEx.Set(
            Eye,
            player.Position.X,
            player.Position.Y + Movement.CurrentEyeHeight(player),
            player.Position.Z);

        var desiredYaw = brain.AimYaw;
        var desiredPitch = brain.AimPitch;

        PlayerState? target = null;
        if (brain.TargetId != SimulationTypes.NullEntity)
        {
            _simulation.World.Players.TryGetValue(brain.TargetId, out target);
        }

        if (target is not null && target.Alive)
        {
            var settled = MathEx.Clamp01(brain.VisibleTime / 0.9d);
            var wantsHead =
                settled > 0.6d &&
                _rng.Next() < 0.35d + difficulty.LeadFactor * 0.4d;
            Combat.HitboxCenter(
                TargetPoint,
                target,
                wantsHead ? HitLocation.Head : HitLocation.Chest);

            var distance = MathEx.Distance(Eye, TargetPoint);
            var travel = double.IsFinite(weapon.MuzzleVelocity)
                ? distance / weapon.MuzzleVelocity
                : 0d;
            var leadTime = (travel + deltaTime) * difficulty.LeadFactor;
            TargetPoint.X += target.Velocity.X * leadTime;
            TargetPoint.Z += target.Velocity.Z * leadTime;

            MathEx.Subtract(ToTarget, TargetPoint, Eye);
            MathEx.Normalize(ToTarget, ToTarget);
            desiredYaw = MathEx.ForwardToYaw(ToTarget);
            desiredPitch = MathEx.ForwardToPitch(ToTarget);

            var targetSpeed = Math.Sqrt(
                target.Velocity.X * target.Velocity.X +
                target.Velocity.Z * target.Velocity.Z);
            var errorScale =
                (distance / 20d) *
                (1d + targetSpeed * 0.06d) *
                (1d - settled * 0.45d);
            desiredYaw += brain.BiasYaw * errorScale;
            desiredPitch += brain.BiasPitch * errorScale;
        }
        else if (brain.LostTime < 6d && brain.TargetId != SimulationTypes.NullEntity)
        {
            MathEx.Subtract(ToTarget, brain.LastKnownPosition, Eye);
            MathEx.Normalize(ToTarget, ToTarget);
            desiredYaw = MathEx.ForwardToYaw(ToTarget);
            desiredPitch = MathEx.ForwardToPitch(ToTarget);
        }
        else
        {
            var node = CurrentPathNode(brain);
            if (node is not null)
            {
                MathEx.Subtract(ToTarget, node.Position, player.Position);
                ToTarget.Y = 0d;
                var horizontal = Math.Sqrt(ToTarget.X * ToTarget.X + ToTarget.Z * ToTarget.Z);
                if (horizontal > 0.3d)
                {
                    MathEx.Normalize(ToTarget, ToTarget);
                    desiredYaw = MathEx.ForwardToYaw(ToTarget);
                }
            }

            desiredPitch = 0d;
            var time = _simulation.World.Time + brain.PersonalityOffset;
            desiredYaw += Math.Sin(time * 0.55d) * 0.28d;
        }

        // Deliberately tests target existence, not liveness, matching target && reacted.
        var maximumTurn =
            difficulty.TurnSpeed * deltaTime *
            (target is not null && brain.Reacted ? 1d : 0.6d);
        brain.AimYaw = MathEx.AngleApproach(brain.AimYaw, desiredYaw, maximumTurn);
        brain.AimPitch = MathEx.Clamp(
            MathEx.AngleApproach(brain.AimPitch, desiredPitch, maximumTurn),
            -1.2d,
            1.2d);

        input.Yaw = brain.AimYaw;
        input.Pitch = brain.AimPitch;
    }

    private void Move(
        PlayerState player,
        BotBrain brain,
        WeaponDef weapon,
        InputCommand input,
        double deltaTime)
    {
        EnsurePath(player, brain, weapon);

        var node = CurrentPathNode(brain);
        var wantX = 0d;
        var wantZ = 0d;
        var pathX = 0d;
        var pathZ = 0d;

        if (node is not null)
        {
            var distance = MathEx.DistanceXz(player.Position, node.Position);
            if (distance < 1.4d)
            {
                brain.PathCursor++;
            }
            else
            {
                MathEx.Subtract(Desired, node.Position, player.Position);
                Desired.Y = 0d;
                MathEx.Normalize(Desired, Desired);
                wantX = Desired.X;
                wantZ = Desired.Z;
                pathX = Desired.X;
                pathZ = Desired.Z;
            }
        }

        if (wantX == 0d &&
            wantZ == 0d &&
            brain.OrderPosition is not null &&
            CurrentPathNode(brain) is null)
        {
            if (MathEx.DistanceXz(player.Position, brain.OrderPosition) > OrderArrival &&
                _navigation.CanWalkBetween(player.Position, brain.OrderPosition))
            {
                MathEx.Subtract(Desired, brain.OrderPosition, player.Position);
                Desired.Y = 0d;
                MathEx.Normalize(Desired, Desired);
                wantX = Desired.X;
                wantZ = Desired.Z;
                pathX = Desired.X;
                pathZ = Desired.Z;
            }
        }

        if (brain.Goal == BotGoal.Engage && brain.TargetId != SimulationTypes.NullEntity)
        {
            if (_simulation.World.Players.TryGetValue(brain.TargetId, out var target))
            {
                var range = LoadoutSystem.ArchetypeRange(brain.Archetype);
                var distance = MathEx.DistanceXz(player.Position, target.Position);

                MathEx.Subtract(Desired, target.Position, player.Position);
                Desired.Y = 0d;
                MathEx.Normalize(Desired, Desired);

                var approach = 0d;
                if (distance > range.Max)
                {
                    approach = 1d;
                }
                else if (distance < range.Min * 0.6d)
                {
                    approach = -1d;
                }

                if (brain.StrafeTimer <= 0d)
                {
                    brain.StrafeDir = -brain.StrafeDir;
                    brain.StrafeTimer = _rng.Range(0.6d, 1.7d);
                }

                var strafeX = -Desired.Z * brain.StrafeDir;
                var strafeZ = Desired.X * brain.StrafeDir;
                wantX = Desired.X * approach + strafeX * 0.85d;
                wantZ = Desired.Z * approach + strafeZ * 0.85d;

                // The original tests pathX only, even if the path points exactly along Z.
                if (brain.OrderPosition is not null && pathX != 0d)
                {
                    wantX = pathX * 0.65d + strafeX * 0.5d;
                    wantZ = pathZ * 0.65d + strafeZ * 0.5d;
                }
            }
        }

        var cosineYaw = Math.Cos(brain.AimYaw);
        var sineYaw = Math.Sin(brain.AimYaw);
        var forwardAmount = wantX * -sineYaw + wantZ * -cosineYaw;
        var rightAmount = wantX * cosineYaw + wantZ * -sineYaw;

        input.MoveForward = MathEx.Clamp(forwardAmount, -1d, 1d);
        input.MoveRight = MathEx.Clamp(rightAmount, -1d, 1d);

        var shouldSprint =
            (brain.Goal == BotGoal.Advance ||
             brain.Goal == BotGoal.Regroup ||
             brain.Goal == BotGoal.Hunt) &&
            input.MoveForward > 0.6d &&
            brain.LostTime > 1.2d;
        if (shouldSprint)
        {
            input.Buttons |= (int)InputFlag.Sprint;
        }

        if (brain.Goal == BotGoal.Hold && node?.Crouch is true)
        {
            input.Buttons |= (int)InputFlag.Crouch;
        }

        var wantsToMove =
            Math.Abs(input.MoveForward) > 0.5d ||
            Math.Abs(input.MoveRight) > 0.5d;
        var speed = Math.Sqrt(
            player.Velocity.X * player.Velocity.X +
            player.Velocity.Z * player.Velocity.Z);
        var moving = speed >= 0.6d;

        if (wantsToMove &&
            !moving &&
            player.OnGround &&
            player.MoveState != MoveState.Mantle)
        {
            brain.StuckTime += deltaTime;
            if (brain.StuckTime > 0.25d)
            {
                input.Buttons |= (int)InputFlag.Jump;
            }

            if (brain.StuckTime > 1.4d &&
                brain.UnstickTimer <= 0d &&
                !Crowded(player, wantX, wantZ))
            {
                brain.UnstickTimer = 0.5d;
                brain.UnstickDir = -brain.UnstickDir;
            }

            if (brain.StuckTime > 2d)
            {
                brain.PathAge = 99d;
                brain.StuckTime = 0d;
            }
        }
        else if (moving)
        {
            brain.StuckTime = 0d;
        }

        if (brain.UnstickTimer > 0d)
        {
            brain.UnstickTimer -= deltaTime;
            input.MoveRight = MathEx.Clamp(
                input.MoveRight + brain.UnstickDir,
                -1d,
                1d);
        }
    }

    private void EnsurePath(PlayerState player, BotBrain brain, WeaponDef weapon)
    {
        var needsRefresh =
            brain.Path.Count == 0 ||
            brain.PathCursor >= brain.Path.Count ||
            brain.PathAge > 2.5d;
        if (!needsRefresh || brain.PathCooldown > 0d)
        {
            return;
        }

        var goalNode = ChooseDestination(player, brain, weapon);
        if (goalNode < 0)
        {
            brain.PathCooldown = 0.5d;
            return;
        }

        var start = _navigation.NearestReachableNode(player.Position, 14d);
        if (start < 0)
        {
            brain.PathCooldown = 0.5d;
            return;
        }

        _navigation.FindPath(start, goalNode, brain.Path);
        brain.PathCursor = brain.Path.Count > 1 ? 1 : 0;
        brain.PathAge = 0d;
        brain.Destination = goalNode;
        if (brain.Path.Count == 0)
        {
            brain.PathCooldown = 0.75d;
        }
    }

    private int ChooseDestination(PlayerState player, BotBrain brain, WeaponDef weapon)
    {
        if (brain.OrderPosition is not null && brain.Goal != BotGoal.TakeCover)
        {
            var node = _navigation.NearestNode(brain.OrderPosition, 24d);
            if (node >= 0)
            {
                if (!TravelGoalStands(player, brain) || brain.TravelGoal != node)
                {
                    brain.TravelGoal = node;
                    brain.TravelAge = 0d;
                }

                return node;
            }
        }

        switch (brain.Goal)
        {
            case BotGoal.TakeCover:
            {
                Vec3 threat;
                if (brain.TargetId != SimulationTypes.NullEntity &&
                    _simulation.World.Players.TryGetValue(brain.TargetId, out var target))
                {
                    threat = target.Position;
                }
                else
                {
                    threat = brain.LastKnownPosition;
                }

                var cover = _navigation.FindCover(player.Position, threat, 28d);
                if (cover is not null)
                {
                    brain.HoldNode = cover.Id;
                    return cover.Id;
                }

                return RoamDestination(player, brain);
            }

            case BotGoal.Hold:
            {
                if (brain.HoldNode >= 0 && brain.HoldNode < _navigation.Nodes.Count)
                {
                    return brain.HoldNode;
                }

                var cover = _navigation.FindCover(
                    player.Position,
                    brain.LastKnownPosition,
                    35d);
                if (cover is not null)
                {
                    brain.HoldNode = cover.Id;
                    return cover.Id;
                }

                return RoamDestination(player, brain);
            }

            case BotGoal.Hunt:
                return _navigation.NearestNode(brain.LastKnownPosition, 20d);

            case BotGoal.Engage:
            {
                if (brain.TargetId == SimulationTypes.NullEntity ||
                    !_simulation.World.Players.TryGetValue(brain.TargetId, out var target))
                {
                    return RoamDestination(player, brain);
                }

                var range = LoadoutSystem.ArchetypeRange(brain.Archetype);
                var distance = MathEx.DistanceXz(player.Position, target.Position);
                if (distance >= range.Min && distance <= range.Max)
                {
                    return _navigation.NearestNode(player.Position, 10d);
                }

                return _navigation.NearestNode(target.Position, 25d);
            }

            case BotGoal.Regroup:
            {
                var cover = _navigation.FindCover(
                    player.Position,
                    brain.LastKnownPosition,
                    22d);
                return cover?.Id ?? RoamDestination(player, brain);
            }

            default:
                _ = weapon;
                if (!TravelGoalStands(player, brain))
                {
                    brain.TravelGoal = RoamDestination(player, brain);
                    brain.TravelAge = 0d;
                }

                return brain.TravelGoal;
        }
    }

    private bool Crowded(PlayerState player, double wantX, double wantZ)
    {
        var length = Math.Sqrt(wantX * wantX + wantZ * wantZ);
        if (length < 0.01d)
        {
            return false;
        }

        var directionX = wantX / length;
        var directionZ = wantZ / length;
        foreach (var other in _simulation.World.Players.Values)
        {
            if (other.Id == player.Id || !other.Alive)
            {
                continue;
            }

            if (SimulationTypes.IsEnemyTeam(other.Team, player.Team))
            {
                continue;
            }

            var offsetX = other.Position.X - player.Position.X;
            var offsetZ = other.Position.Z - player.Position.Z;
            var distance = Math.Sqrt(offsetX * offsetX + offsetZ * offsetZ);
            if (distance > 1.4d || distance < 0.01d)
            {
                continue;
            }

            if ((offsetX / distance) * directionX + (offsetZ / distance) * directionZ > 0.5d)
            {
                return true;
            }
        }

        return false;
    }

    private bool TravelGoalStands(PlayerState player, BotBrain brain)
    {
        if (brain.TravelGoal < 0 || brain.TravelGoal >= _navigation.Nodes.Count)
        {
            return false;
        }

        if (MathEx.Distance(player.Position, _navigation.Nodes[brain.TravelGoal].Position) < 3d)
        {
            return false;
        }

        return brain.TravelAge < 25d;
    }

    private int RoamDestination(PlayerState player, BotBrain brain)
    {
        if (brain.OrderPosition is not null)
        {
            var ordered = _navigation.NearestNode(brain.OrderPosition, 24d);
            if (ordered >= 0)
            {
                return ordered;
            }
        }

        if (brain.LeaderId != SimulationTypes.NullEntity &&
            _simulation.World.Players.TryGetValue(brain.LeaderId, out var leader) &&
            leader.Alive &&
            MathEx.DistanceXz(player.Position, leader.Position) > 11d)
        {
            var leaderNode = _navigation.NearestNode(leader.Position, 20d);
            if (leaderNode >= 0)
            {
                return leaderNode;
            }
        }

        var objective = PickObjective(player);
        if (objective is not null)
        {
            var objectiveNode = _navigation.NearestNode(objective, 25d);
            if (objectiveNode >= 0)
            {
                return objectiveNode;
            }
        }

        var bucket =
            Math.Floor(_simulation.World.Time / 12d) +
            Math.Floor(brain.PersonalityOffset);
        var count = _navigation.Nodes.Count;
        if (count == 0)
        {
            return -1;
        }

        var best = -1;
        var bestScore = double.NegativeInfinity;
        for (var i = 0; i < 24; i++)
        {
            var index = (int)((bucket * 7919d + i * 104729d) % count);
            var node = _navigation.Nodes[index];
            var distance = MathEx.DistanceXz(node.Position, player.Position);
            var score = node.Value * 6d + distance * 0.35d - node.Exposure * 3d;
            if (score > bestScore)
            {
                bestScore = score;
                best = index;
            }
        }

        return best;
    }

    private Vec3? PickObjective(PlayerState player)
    {
        var objectiveKind = _simulation.Mode.ObjectiveKind;
        Vec3? best = null;
        var bestDistance = double.PositiveInfinity;
        foreach (var objective in _simulation.Map.Objectives)
        {
            if (objectiveKind is null || objective.Kind != objectiveKind.Value)
            {
                continue;
            }

            var distance = MathEx.DistanceXz(objective.Position, player.Position);
            if (distance < bestDistance)
            {
                bestDistance = distance;
                best = objective.Position;
            }
        }

        return best;
    }

    private NavNode? CurrentPathNode(BotBrain brain)
    {
        if (brain.PathCursor < 0 || brain.PathCursor >= brain.Path.Count)
        {
            return null;
        }

        var index = brain.Path[brain.PathCursor];
        return index >= 0 && index < _navigation.Nodes.Count
            ? _navigation.Nodes[index]
            : null;
    }

    private void Act(
        PlayerState player,
        BotBrain brain,
        WeaponDef weapon,
        InputCommand input)
    {
        if (player.KillstreakInventory.Count > 0 && brain.Goal != BotGoal.Engage)
        {
            if (Chance(brain, 0.35d))
            {
                input.KillstreakSlot = 0;
            }
        }

        var state = WeaponSystem.ActiveWeapon(player);
        if (state is not null)
        {
            var empty = state.AmmoInMag == 0;
            var low = state.AmmoInMag <= weapon.MagSize * 0.25d;
            var safe = brain.Goal != BotGoal.Engage || brain.LostTime > 1.5d;
            if (state.AmmoReserve > 0 && (empty || low && safe))
            {
                input.Buttons |= (int)InputFlag.Reload;
            }
        }

        if (brain.TargetId == SimulationTypes.NullEntity ||
            !_simulation.World.Players.TryGetValue(brain.TargetId, out var target) ||
            !target.Alive ||
            !brain.Reacted ||
            brain.LostTime > 0.25d)
        {
            return;
        }

        var distance = MathEx.Distance(player.Position, target.Position);
        var range = LoadoutSystem.ArchetypeRange(brain.Archetype);
        if (distance > 8d || weapon.Class == WeaponClass.SniperRifle)
        {
            input.Buttons |= (int)InputFlag.Ads;
        }

        MathEx.Set(
            Eye,
            player.Position.X,
            player.Position.Y + Movement.CurrentEyeHeight(player),
            player.Position.Z);
        Combat.HitboxCenter(TargetPoint, target, HitLocation.Chest);
        MathEx.Subtract(ToTarget, TargetPoint, Eye);
        MathEx.Normalize(ToTarget, ToTarget);
        var desiredYaw = MathEx.ForwardToYaw(ToTarget);
        var desiredPitch = MathEx.ForwardToPitch(ToTarget);

        var yawError = Math.Abs(MathEx.AngleDelta(brain.AimYaw, desiredYaw));
        var pitchError = Math.Abs(brain.AimPitch - desiredPitch);
        var tolerance = Math.Atan2(1d, Math.Max(2d, distance)) + 0.02d;

        var wantsFire = false;
        if (yawError < tolerance && pitchError < tolerance)
        {
            wantsFire = _rng.Next() > brain.Difficulty.PanicSpray * 0.35d;
        }
        else if (distance < 6d && _rng.Next() < brain.Difficulty.PanicSpray)
        {
            wantsFire = true;
        }

        if (wantsFire)
        {
            PullTrigger(brain, weapon, input);
        }

        if (distance < 2d && _rng.Chance(0.04d * brain.AggressionScale))
        {
            input.Buttons |= (int)InputFlag.Melee;
        }

        if (brain.GrenadeCooldown <= 0d &&
            player.LethalCount > 0 &&
            distance > 8d &&
            distance < 30d &&
            Chance(brain, brain.Difficulty.GrenadeInstinct * brain.AggressionScale))
        {
            input.Buttons |= (int)InputFlag.Lethal;
            brain.GrenadeCooldown = _rng.Range(8d, 20d);
        }

        _ = range;
    }

    private void PullTrigger(BotBrain brain, WeaponDef weapon, InputCommand input)
    {
        if (weapon.FireMode == FireMode.Auto)
        {
            if (brain.AggressionScale >= 0.999d)
            {
                input.Buttons |= (int)InputFlag.Fire;
                return;
            }

            if (brain.TriggerCooldown > 0d)
            {
                return;
            }

            input.Buttons |= (int)InputFlag.Fire;
            brain.TriggerCooldown =
                WeaponMath.FireInterval(weapon) +
                (1d - brain.AggressionScale) * 0.16d +
                GameConstants.TickDt;
            return;
        }

        if (brain.TriggerCooldown > 0d)
        {
            return;
        }

        input.Buttons |= (int)InputFlag.Fire;
        var skill = 1d - brain.Difficulty.AimError / 0.075d;
        var humanClickInterval = 0.34d - skill * 0.18d;
        brain.TriggerCooldown =
            Math.Max(WeaponMath.FireInterval(weapon), humanClickInterval) +
            GameConstants.TickDt;
    }
}
