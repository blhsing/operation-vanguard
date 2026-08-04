namespace OperationVanguard.Core;

public sealed class CreatePlayerOptions
{
    public int Id { get; set; }
    public string Name { get; set; } = string.Empty;
    public Team Team { get; set; }
    public bool IsBot { get; set; }
    public double BotSkill { get; set; } = 0.5d;
    public Vec3? Position { get; set; }
    public double Yaw { get; set; }
}

public sealed class CreateWorldOptions
{
    public string MapId { get; set; } = string.Empty;
    public string ModeId { get; set; } = string.Empty;
    public string? Seed { get; set; }
}

public readonly record struct PlayerCapsuleDimensions(double Height, double Radius);

/// <summary>World construction and entity lifecycle.</summary>
public static class WorldFactory
{
    public static WeaponState CreateWeaponState(
        string definitionId,
        int magazineSize,
        int reserve,
        IEnumerable<string>? attachments = null) =>
        new()
        {
            DefId = definitionId,
            AmmoInMag = magazineSize,
            AmmoReserve = reserve,
            Attachments = attachments?.ToList() ?? [],
            ShotsInBurst = 0,
            RecoilYaw = 0d,
            RecoilPitch = 0d,
            Spread = 0d,
            NextFireTime = 0d,
            Heat = 0d,
        };

    public static PlayerState CreatePlayer(CreatePlayerOptions options)
    {
        var position = options.Position is null ? new Vec3() : MathEx.Clone(options.Position);
        return new PlayerState
        {
            Id = options.Id,
            EntityId = options.Id,
            Name = options.Name,
            Team = options.Team,
            IsBot = options.IsBot,
            BotSkill = options.BotSkill,

            Position = position,
            Velocity = new Vec3(),
            Yaw = options.Yaw,
            Pitch = 0d,
            Lean = 0d,

            Stance = Stance.Stand,
            PreviousStance = Stance.Stand,
            StanceProgress = 1d,
            MoveState = MoveState.Idle,
            OnGround = false,
            GroundNormal = new Vec3(0d, 1d, 0d),
            AirTime = 0d,
            FallPeakY = position.Y,
            SlideTime = 0d,
            SlideCooldown = 0d,
            TacticalSprintTime = 0d,
            TacticalSprintCooldown = 0d,
            JumpCooldown = 0d,
            JumpBuffer = 0d,
            GroundLockout = 0d,
            MantleTime = 0d,
            MantleDuration = 0d,
            MantleStart = new Vec3(),
            MantleEnd = new Vec3(),
            SprintOutTime = 0d,
            SprintOutPending = false,

            Health = GameConstants.Health.Maximum,
            MaxHealth = GameConstants.Health.Maximum,
            Armor = 0d,
            Alive = false,
            RespawnTimer = 0d,
            TimeSinceDamage = GameConstants.Health.RegenerationDelay,
            LastAttacker = SimulationTypes.NullEntity,
            Damagers = [],

            ActiveSlot = WeaponSlot.Primary,
            Weapons = [],
            AdsProgress = 0d,
            IsAds = false,
            Action = WeaponAction.Ready,
            ActionTimer = 0d,
            TriggerHeld = false,

            LethalCount = 0,
            TacticalCount = 0,
            CookTime = -1d,

            Perks = [],
            FieldUpgrade = string.Empty,
            FieldUpgradeCharge = 0d,
            Killstreaks = [],
            KillstreakInventory = [],

            FlashAmount = 0d,
            ConcussionAmount = 0d,
            EmpTime = 0d,
            MarkedUntil = 0d,

            Kills = 0,
            Deaths = 0,
            Assists = 0,
            Score = 0d,
            Killstreak = 0,
            BestKillstreak = 0,
            StreakScore = 0d,
            Captures = 0,
            Defends = 0,
            Plants = 0,
            Defuses = 0,
            DamageDealt = 0d,
            Headshots = 0,
            DeathStreak = 0,

            LastProcessedInput = 0,
            Ping = 0d,
            Connected = true,
            Spectating = false,
            SpectateTarget = SimulationTypes.NullEntity,
        };
    }

    /// <summary>Reset per-life state without touching match-long statistics or connection state.</summary>
    public static void RespawnPlayer(PlayerState player, Vec3 position, double yaw)
    {
        MathEx.Copy(player.Position, position);
        MathEx.Set(player.Velocity, 0d, 0d, 0d);
        player.Yaw = yaw;
        player.Pitch = 0d;
        player.Lean = 0d;

        player.Stance = Stance.Stand;
        player.PreviousStance = Stance.Stand;
        player.StanceProgress = 1d;
        player.MoveState = MoveState.Idle;
        player.OnGround = false;
        MathEx.Set(player.GroundNormal, 0d, 1d, 0d);
        player.AirTime = 0d;
        player.FallPeakY = position.Y;
        player.SlideTime = 0d;
        player.SlideCooldown = 0d;
        player.TacticalSprintTime = 0d;
        player.TacticalSprintCooldown = 0d;
        player.JumpCooldown = 0d;
        player.JumpBuffer = 0d;
        player.GroundLockout = 0d;
        player.MantleTime = 0d;
        player.SprintOutTime = 0d;
        player.SprintOutPending = false;

        player.Health = player.MaxHealth;
        player.Alive = true;
        player.RespawnTimer = 0d;
        player.TimeSinceDamage = GameConstants.Health.RegenerationDelay;
        player.LastAttacker = SimulationTypes.NullEntity;
        player.Damagers.Clear();

        player.ActiveSlot = WeaponSlot.Primary;
        player.AdsProgress = 0d;
        player.IsAds = false;
        player.Action = WeaponAction.Ready;
        player.ActionTimer = 0d;
        player.TriggerHeld = false;
        player.CookTime = -1d;

        player.FlashAmount = 0d;
        player.ConcussionAmount = 0d;
        player.EmpTime = 0d;

        player.Spectating = false;
        player.SpectateTarget = SimulationTypes.NullEntity;
    }

    public static void KillPlayer(PlayerState player, double respawnDelay)
    {
        player.Alive = false;
        player.Health = 0d;
        player.RespawnTimer = respawnDelay;
        player.Killstreak = 0;
        player.TriggerHeld = false;
        player.IsAds = false;
        player.AdsProgress = 0d;
        player.Action = WeaponAction.Ready;
        player.ActionTimer = 0d;
        player.MantleTime = 0d;
        player.MoveState = MoveState.Idle;
        player.CookTime = -1d;
    }

    public static ProjectileState CreateProjectile(
        int id,
        ProjectileKind kind,
        int owner,
        Team team,
        Vec3 position,
        Vec3 velocity,
        double fuse) =>
        new()
        {
            Id = id,
            Kind = kind,
            Owner = owner,
            Team = team,
            Position = MathEx.Clone(position),
            Velocity = MathEx.Clone(velocity),
            Fuse = fuse,
            Stuck = false,
            StuckTo = SimulationTypes.NullEntity,
            Bounces = 0,
            Age = 0d,
            Armed = false,
        };

    public static DeployableState CreateDeployable(
        int id,
        DeployableKind kind,
        int owner,
        Team team,
        Vec3 position,
        double yaw,
        double health,
        double armTime,
        int charges) =>
        new()
        {
            Id = id,
            Kind = kind,
            Owner = owner,
            Team = team,
            Position = MathEx.Clone(position),
            Yaw = yaw,
            Health = health,
            ArmTime = armTime,
            Charges = charges,
            Age = 0d,
            Payload = string.Empty,
        };

    public static KillstreakEntityState CreateKillstreakEntity(
        int id,
        KillstreakVehicleKind kind,
        int owner,
        Team team,
        Vec3 position,
        double health,
        double duration) =>
        new()
        {
            Id = id,
            Kind = kind,
            Owner = owner,
            Team = team,
            Position = MathEx.Clone(position),
            Velocity = new Vec3(),
            Yaw = 0d,
            Pitch = 0d,
            Health = health,
            TimeRemaining = duration,
            Controlled = false,
            PathIndex = 0,
        };

    public static WorldState CreateWorld(CreateWorldOptions options)
    {
        var seed = options.Seed ?? $"{options.MapId}:{options.ModeId}";
        return new WorldState
        {
            Tick = 0,
            Time = 0d,
            Players = [],
            Projectiles = [],
            Deployables = [],
            KillstreakEntities = [],
            Match = CreateMatchState(),
            MapId = options.MapId,
            ModeId = options.ModeId,
            NextEntityId = 1000,
            RngState = Rng.HashString(seed),
        };
    }

    public static MatchState CreateMatchState() =>
        new()
        {
            Phase = MatchPhase.Warmup,
            TimeRemaining = 0d,
            Round = 0,
            Scores =
            [
                new TeamScore { Team = Team.Allies, Score = 0d, RoundsWon = 0 },
                new TeamScore { Team = Team.Axis, Score = 0d, RoundsWon = 0 },
            ],
            ModeState = [],
            Winner = null,
        };

    public static int AllocateEntityId(WorldState world) => world.NextEntityId++;

    public static PlayerState AddPlayer(WorldState world, PlayerState player)
    {
        world.Players[player.Id] = player;
        return player;
    }

    public static void RemovePlayer(WorldState world, int id) => world.Players.Remove(id);

    public static double TeamScore(WorldState world, Team team) =>
        world.Match.Scores.FirstOrDefault(score => score.Team == team)?.Score ?? 0d;

    public static double AddTeamScore(WorldState world, Team team, double amount)
    {
        var entry = world.Match.Scores.FirstOrDefault(score => score.Team == team);
        if (entry is null)
        {
            entry = new TeamScore { Team = team, Score = 0d, RoundsWon = 0 };
            world.Match.Scores.Add(entry);
        }

        entry.Score += amount;
        return entry.Score;
    }

    public static List<PlayerState> PlayersOnTeam(
        WorldState world,
        Team team,
        List<PlayerState> output,
        bool aliveOnly = false)
    {
        output.Clear();
        foreach (var player in world.Players.Values)
        {
            if (player.Team != team || aliveOnly && !player.Alive)
            {
                continue;
            }

            output.Add(player);
        }

        return output;
    }

    public static int CountAlive(WorldState world, Team team)
    {
        var count = 0;
        foreach (var player in world.Players.Values)
        {
            if (player.Team == team && player.Alive)
            {
                count++;
            }
        }

        return count;
    }

    public static PlayerCapsuleDimensions PlayerCapsule(PlayerState player)
    {
        var from = StanceHeightOf(player.PreviousStance);
        var to = StanceHeightOf(player.Stance);
        var height = player.StanceProgress >= 1d
            ? to
            : from + (to - from) * player.StanceProgress;
        return new PlayerCapsuleDimensions(height, GameConstants.PlayerRadius);
    }

    public static bool ClampToBounds(Vec3 position, MapBounds bounds)
    {
        var clamped = false;
        if (position.X < bounds.Min.X)
        {
            position.X = bounds.Min.X;
            clamped = true;
        }
        else if (position.X > bounds.Max.X)
        {
            position.X = bounds.Max.X;
            clamped = true;
        }

        if (position.Z < bounds.Min.Z)
        {
            position.Z = bounds.Min.Z;
            clamped = true;
        }
        else if (position.Z > bounds.Max.Z)
        {
            position.Z = bounds.Max.Z;
            clamped = true;
        }

        if (position.Y < bounds.Min.Y - 20d)
        {
            position.Y = bounds.Max.Y;
            clamped = true;
        }

        return clamped;
    }

    public static bool IsPlausibleVelocity(Vec3 velocity)
    {
        var maximumHorizontal =
            GameConstants.Move.BaseSpeed * GameConstants.Move.TacticalSprintMultiplier * 2.5d;
        return
            Math.Abs(velocity.X) <= maximumHorizontal &&
            Math.Abs(velocity.Z) <= maximumHorizontal &&
            velocity.Y <= GameConstants.Move.JumpVelocity * 2d &&
            velocity.Y >= -GameConstants.Move.MaximumFallSpeed * 1.2d;
    }

    private static double StanceHeightOf(Stance stance) => stance switch
    {
        Stance.Crouch => GameConstants.StanceHeight.Crouch,
        Stance.Prone => GameConstants.StanceHeight.Prone,
        _ => GameConstants.StanceHeight.Stand,
    };
}
