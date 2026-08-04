namespace OperationVanguard.Core;

public sealed class GameOptions
{
    public string MapId { get; set; } = string.Empty;
    public string ModeId { get; set; } = string.Empty;
    public string? Seed { get; set; }
    public bool? FriendlyFire { get; set; }
}

public sealed class AddPlayerOptions
{
    public string Name { get; set; } = string.Empty;
    public Team Team { get; set; }
    public bool IsBot { get; set; }
    public double BotSkill { get; set; } = 0.5d;
    public Loadout? Loadout { get; set; }
    public int? Id { get; set; }
}

public readonly record struct PlayerDamageResult(double Applied, bool Killed);

/// <summary>
/// Canonical deterministic game orchestrator shared by offline, server, campaign,
/// zombies, and bot control surfaces.
/// </summary>
public sealed class GameSimulation : IBotSimulation
{
    private sealed class PlayerRuntime
    {
        public Loadout Loadout { get; set; } = new();
        public ResolvedLoadout Resolved { get; set; } = new();
        public InputCommand Input { get; set; } = new();
        public bool WantsRespawn { get; set; }
        public double ObjectiveTickAccum { get; set; }
        public int LastKillstreakSlot { get; set; } = -1;
    }

    private sealed class ProjectileEffect
    {
        public double Damage { get; init; }
        public double Radius { get; init; }
        public double Flash { get; init; }
        public double Stun { get; init; }
    }

    private static readonly Vec3 Eye = new();
    private static readonly Vec3 Direction = new();
    private static readonly Vec3 SpreadDirection = new();
    private static readonly Vec3 AimAssistDirection = new();
    private static readonly Vec3 AimAssistTarget = new();
    private static readonly Vec3 Temporary = new();
    private static readonly Vec3 DamageDirection = new();
    private static readonly TraceResult SharedTrace = Combat.CreateTraceResult();
    private static readonly List<ExplosionTarget> ExplosionTargets = [];
    private static readonly Vec3 PlacementTemporary = new();
    private static readonly QueryFilter SightFilter = new(CollisionLayer.Sight);
    private static readonly QueryFilter GroundQuery =
        new(CollisionLayer.World | CollisionLayer.Breakable);
    private static readonly RaycastHit ProjectileHit = new();

    private static readonly IReadOnlyDictionary<ProjectileKind, ProjectileEffect> ProjectileEffects =
        new Dictionary<ProjectileKind, ProjectileEffect>
        {
            [ProjectileKind.Frag] = Effect(130d, 5.5d, 0d, 0d),
            [ProjectileKind.Semtex] = Effect(130d, 4.8d, 0d, 0d),
            [ProjectileKind.C4] = Effect(190d, 6.5d, 0d, 0d),
            [ProjectileKind.Molotov] = Effect(25d, 4d, 0d, 0d),
            [ProjectileKind.ThermiteStick] = Effect(30d, 3.2d, 0d, 0d),
            [ProjectileKind.Rocket] = Effect(160d, 6d, 0d, 0d),
            [ProjectileKind.GrenadeLauncher] = Effect(130d, 5d, 0d, 0d),
            [ProjectileKind.ThrowingKnife] = Effect(150d, 0.6d, 0d, 0d),
            [ProjectileKind.Flashbang] = Effect(0d, 12d, 1d, 0.25d),
            [ProjectileKind.StunGrenade] = Effect(0d, 9d, 0.15d, 1d),
            [ProjectileKind.SmokeGrenade] = Effect(0d, 8d, 0d, 0d),
            [ProjectileKind.ClaymoreProjectile] = Effect(150d, 4.5d, 0d, 0d),
        };

    private static readonly IReadOnlyDictionary<string, (int Cost, int ScoreCost)> KillstreakCosts =
        KillstreakData.Killstreaks.ToDictionary(
            pair => pair.Key,
            pair => (pair.Value.Cost, pair.Value.ScoreCost),
            StringComparer.Ordinal);

    private List<SimEvent> _events = [];
    private readonly Dictionary<int, PlayerRuntime> _runtimes = [];
    private readonly Dictionary<int, double> _outgoingDamageScales = [];
    private readonly List<DynamicCollider> _dynamicColliders = [];
    private int _nextPlayerId = 1;

    public GameSimulation(GameOptions options)
    {
        Map = Maps.Get(options.MapId);
        Mode = ModeData.GetMode(options.ModeId);
        World = WorldFactory.CreateWorld(new CreateWorldOptions
        {
            MapId = options.MapId,
            ModeId = options.ModeId,
            Seed = options.Seed,
        });
        Collision = new BrushCollisionWorld(Map.Brushes, Map.Bounds);
        Rng = new Rng(World.RngState);
        SpawnContext = SpawnSystem.CreateSpawnContext();
        FriendlyFire = options.FriendlyFire ?? false;
        Objectives = ObjectiveSystem.CreateObjectiveState(Map, Mode);
        Killstreaks = KillstreakRuntimeSystem.CreateKillstreakRuntime();
        DeployableSystem.ResetDeployables(World);

        World.Match.Phase = MatchPhase.Warmup;
        World.Match.TimeRemaining = GameConstants.Match.WarmupDuration;
    }

    public WorldState World { get; }
    public MapDef Map { get; }
    public GameModeDef Mode { get; }
    public BrushCollisionWorld Collision { get; }
    public Rng Rng { get; }
    public SpawnContext SpawnContext { get; }
    public bool FriendlyFire { get; }
    public ModeObjectiveState Objectives { get; }
    public KillstreakRuntime Killstreaks { get; }

    public Action<PlayerState, MovementModifiers, WeaponModifiers>? ModifierHook { get; set; }

    public Func<int, string, double>? DamageMultiplierHook { get; set; }

    public PlayerState AddPlayer(AddPlayerOptions options)
    {
        var id = options.Id ?? _nextPlayerId++;
        if (id >= _nextPlayerId)
        {
            _nextPlayerId = id + 1;
        }

        var player = WorldFactory.CreatePlayer(new CreatePlayerOptions
        {
            Id = id,
            Name = options.Name,
            Team = options.Team,
            IsBot = options.IsBot,
            BotSkill = options.BotSkill,
        });
        WorldFactory.AddPlayer(World, player);

        var loadout = options.Loadout ?? LoadoutSystem.DefaultLoadout();
        _runtimes[id] = new PlayerRuntime
        {
            Loadout = loadout,
            Resolved = LoadoutSystem.ResolveLoadout(loadout),
            Input = SimulationTypes.CreateEmptyInput(),
            WantsRespawn = true,
            ObjectiveTickAccum = 0d,
            LastKillstreakSlot = -1,
        };

        player.Alive = false;
        player.RespawnTimer = 0d;
        return player;
    }

    public void RemovePlayer(int id)
    {
        WorldFactory.RemovePlayer(World, id);
        DeployableSystem.ClearOwned(World, id);
        _runtimes.Remove(id);
        _outgoingDamageScales.Remove(id);
        WeaponSystem.ResetWeaponRuntime(id);
        Movement.ResetStride(id);
    }

    public void SetLoadout(int id, Loadout loadout)
    {
        if (!_runtimes.TryGetValue(id, out var runtime))
        {
            return;
        }

        runtime.Loadout = loadout;
        runtime.Resolved = LoadoutSystem.ResolveLoadout(loadout);
    }

    public void SetInput(int playerId, InputCommand input)
    {
        if (!_runtimes.TryGetValue(playerId, out var runtime))
        {
            return;
        }

        runtime.Input = input;
        if (World.Players.TryGetValue(playerId, out var player))
        {
            player.LastProcessedInput = input.Seq;
        }
    }

    public void SetOutgoingDamageScale(int playerId, double scale)
    {
        _outgoingDamageScales[playerId] = Math.Clamp(scale, 0d, 1d);
    }

    public void RequestRespawn(int id)
    {
        if (_runtimes.TryGetValue(id, out var runtime))
        {
            runtime.WantsRespawn = true;
        }
    }

    public ResolvedLoadout? GetResolvedLoadout(int id) =>
        _runtimes.TryGetValue(id, out var runtime) ? runtime.Resolved : null;

    public WeaponDef ActiveWeaponDef(PlayerState player)
    {
        var state = WeaponSystem.ActiveWeapon(player);
        if (state is null)
        {
            return WeaponData.GetWeapon("p226");
        }

        if (_runtimes.TryGetValue(player.Id, out var runtime))
        {
            if (runtime.Resolved.Primary.Id == state.DefId)
            {
                return runtime.Resolved.Primary;
            }

            if (runtime.Resolved.Secondary.Id == state.DefId)
            {
                return runtime.Resolved.Secondary;
            }
        }

        return WeaponData.TryGetWeapon(state.DefId) ?? WeaponData.GetWeapon("p226");
    }

    /// <summary>Advance the simulation by one deterministic fixed step.</summary>
    public List<SimEvent> Step(double deltaTime = GameConstants.TickDt)
    {
        World.Tick++;
        World.Time += deltaTime;
        Rng.SetState(World.RngState);

        UpdateDynamicColliders();
        SpawnSystem.TickSpawnContext(SpawnContext, deltaTime, World.Time);
        StepMatchPhase(deltaTime);

        var live = World.Match.Phase is MatchPhase.Live or MatchPhase.Warmup or MatchPhase.Overtime;
        foreach (var player in World.Players.Values)
        {
            if (!_runtimes.TryGetValue(player.Id, out var runtime))
            {
                continue;
            }

            if (!player.Alive)
            {
                StepDeadPlayer(player, runtime, deltaTime, live);
                continue;
            }

            StepAlivePlayer(player, runtime, deltaTime, live);
        }

        StepProjectiles(deltaTime);
        StepStatusEffects(deltaTime);
        StepObjectiveMode(deltaTime);
        StepKillstreakRuntime(deltaTime);
        StepDeployableRuntime(deltaTime);

        World.RngState = Rng.GetState();

        var produced = _events;
        _events = [];
        return produced;
    }

    private void StepKillstreakRuntime(double deltaTime)
    {
        var result = KillstreakRuntimeSystem.StepKillstreaks(
            World,
            Collision,
            Killstreaks,
            deltaTime,
            Rng);

        foreach (var simEvent in result.Events)
        {
            simEvent.Tick = World.Tick;
            Emit(simEvent);
        }

        foreach (var explosion in result.Explosions)
        {
            Combat.ResolveExplosion(
                World,
                Collision,
                explosion.Position,
                explosion.Radius,
                explosion.Damage,
                explosion.Owner,
                FriendlyFire,
                ExplosionTargets);
            foreach (var target in ExplosionTargets)
            {
                DamagePlayer(target.Player, new DamageInfo
                {
                    Amount = target.Damage,
                    Attacker = explosion.Owner,
                    Victim = target.Player.Id,
                    Cause = DamageCause.Killstreak,
                    WeaponId = "killstreak",
                    Location = HitLocation.Chest,
                    Position = MathEx.Clone(explosion.Position),
                    Direction = MathEx.Clone(target.Direction),
                    Distance = target.Distance,
                    IgnoreArmor = false,
                });
            }

            SpawnSystem.AddDangerZone(SpawnContext, explosion.Position, explosion.Radius * 2.5d, 8d);
        }

        foreach (var hit in result.Hits)
        {
            if (!World.Players.TryGetValue(hit.Victim, out var victim))
            {
                continue;
            }

            MathEx.Subtract(DamageDirection, victim.Position, hit.Position);
            MathEx.Normalize(DamageDirection, DamageDirection);
            DamagePlayer(victim, new DamageInfo
            {
                Amount = hit.Damage,
                Attacker = hit.Attacker,
                Victim = victim.Id,
                Cause = DamageCause.Killstreak,
                WeaponId = "killstreak",
                Location = HitLocation.Chest,
                Position = MathEx.Clone(victim.Position),
                Direction = MathEx.Clone(DamageDirection),
                Distance = 0d,
                IgnoreArmor = false,
            });
        }
    }

    private void StepDeployableRuntime(double deltaTime)
    {
        var result = DeployableSystem.StepDeployables(World, Collision, deltaTime, Rng);

        foreach (var simEvent in result.Events)
        {
            simEvent.Tick = World.Tick;
            Emit(simEvent);
        }

        foreach (var explosion in result.Explosions)
        {
            ApplyExplosion(explosion.Position, explosion.Radius, explosion.Damage, explosion.Owner);
        }

        foreach (var hit in result.Hits)
        {
            if (!World.Players.TryGetValue(hit.Victim, out var victim))
            {
                continue;
            }

            MathEx.Subtract(DamageDirection, victim.Position, hit.Position);
            MathEx.Normalize(DamageDirection, DamageDirection);
            DamagePlayer(victim, new DamageInfo
            {
                Amount = hit.Damage,
                Attacker = hit.Attacker,
                Victim = victim.Id,
                Cause = DamageCause.Sentry,
                WeaponId = "sentry",
                Location = HitLocation.Chest,
                Position = MathEx.Clone(victim.Position),
                Direction = MathEx.Clone(DamageDirection),
                Distance = 0d,
                IgnoreArmor = false,
            });
        }

        foreach (var id in result.Intercepted)
        {
            World.Projectiles.Remove(id);
        }

        foreach (var id in result.Resupply)
        {
            if (!World.Players.TryGetValue(id, out var player))
            {
                continue;
            }

            foreach (var state in player.Weapons)
            {
                if (state is null)
                {
                    continue;
                }

                var definition = ResolveWeaponState(player, state.DefId);
                state.AmmoReserve = Math.Min(
                    definition.MaxReserve,
                    state.AmmoReserve + definition.MagSize * 2);
            }

            player.LethalCount = Math.Max(player.LethalCount, 1);
            player.TacticalCount = Math.Max(player.TacticalCount, 1);
        }

        foreach (var grant in result.Grants)
        {
            if (World.Players.TryGetValue(grant.Player, out var player) &&
                !player.KillstreakInventory.Contains(grant.KillstreakId))
            {
                player.KillstreakInventory.Add(grant.KillstreakId);
            }
        }

        UpdateDynamicColliders();
    }

    private void ApplyExplosion(Vec3 position, double radius, double damage, int owner)
    {
        Combat.ResolveExplosion(
            World,
            Collision,
            position,
            radius,
            damage,
            owner,
            FriendlyFire,
            ExplosionTargets);
        foreach (var target in ExplosionTargets)
        {
            var resistance = _runtimes.TryGetValue(target.Player.Id, out var runtime)
                ? runtime.Resolved.Perks.ExplosiveResistMult
                : 1d;
            DamagePlayer(target.Player, new DamageInfo
            {
                Amount = target.Damage * resistance,
                Attacker = owner,
                Victim = target.Player.Id,
                Cause = DamageCause.Explosion,
                WeaponId = "explosive",
                Location = HitLocation.Chest,
                Position = MathEx.Clone(position),
                Direction = MathEx.Clone(target.Direction),
                Distance = target.Distance,
                IgnoreArmor = false,
            });
        }

        SpawnSystem.AddDangerZone(SpawnContext, position, radius * 2d, 6d);
    }

    public double RadarTime(Team team) =>
        KillstreakRuntimeSystem.RadarTimeRemaining(Killstreaks, team);

    public bool TeamHasRadar(Team team) =>
        KillstreakRuntimeSystem.HasRadar(Killstreaks, team);

    public bool TeamIsJammed(Team team) =>
        KillstreakRuntimeSystem.TeamEffects(Killstreaks, team).Emp > 0d;

    private void StepObjectiveMode(double deltaTime)
    {
        var result = ObjectiveSystem.StepObjectives(World, Map, Mode, Objectives, deltaTime);

        foreach (var pair in result.TeamScore)
        {
            if (pair.Value != 0d)
            {
                WorldFactory.AddTeamScore(World, pair.Key, pair.Value);
            }
        }

        foreach (var award in result.PlayerScore)
        {
            if (World.Players.TryGetValue(award.Player, out var player))
            {
                AwardScore(player, award.Amount, award.Reason);
            }
        }

        foreach (var simEvent in result.Events)
        {
            simEvent.Tick = World.Tick;
            Emit(simEvent);
        }

        if (result.SpawnWeights is not null)
        {
            SpawnSystem.SetGroupWeights(SpawnContext, result.SpawnWeights);
        }

        if (result.RoundWinner is not null)
        {
            EndRound(result.RoundWinner.Value);
        }
    }

    private void EndRound(Team winner)
    {
        var entry = World.Match.Scores.FirstOrDefault(score => score.Team == winner);
        if (entry is not null)
        {
            entry.RoundsWon++;
        }

        Emit(new GenericSimEvent(SimEventType.RoundEnd)
        {
            Tick = World.Tick,
            Team = winner,
            Data = new Dictionary<string, object?>
            {
                ["round"] = World.Match.Round,
            },
        });

        if ((entry?.RoundsWon ?? 0) >= Mode.RoundsToWin)
        {
            EndMatch(winner);
            return;
        }

        World.Match.Round++;
        World.Match.TimeRemaining = Mode.RoundTime;
        ObjectiveSystem.ResetRound(Objectives, Mode, World.Match.Round);
        KillstreakRuntimeSystem.ResetKillstreakRuntime(Killstreaks);
        DeployableSystem.ResetDeployables(World);

        foreach (var player in World.Players.Values)
        {
            if (!_runtimes.TryGetValue(player.Id, out var runtime))
            {
                continue;
            }

            runtime.WantsRespawn = true;
            player.RespawnTimer = 0d;
            if (player.Alive)
            {
                WorldFactory.KillPlayer(player, 0d);
            }
        }
    }

    public IReadOnlyList<ObjectiveSummaryEntry> ObjectiveStatus() =>
        ObjectiveSystem.ObjectiveSummary(Objectives);

    private void StepMatchPhase(double deltaTime)
    {
        var match = World.Match;
        match.TimeRemaining -= deltaTime;

        switch (match.Phase)
        {
            case MatchPhase.Warmup:
                if (match.TimeRemaining <= 0d)
                {
                    match.Phase = MatchPhase.Live;
                    match.TimeRemaining = Mode.TimeLimit > 0d ? Mode.TimeLimit : Mode.RoundTime;
                    match.Round = 1;
                    Emit(new GenericSimEvent(SimEventType.MatchStateChanged)
                    {
                        Tick = World.Tick,
                        Data = new Dictionary<string, object?>
                        {
                            ["phase"] = MatchPhase.Live,
                        },
                    });
                    Emit(new AnnounceEvent
                    {
                        Tick = World.Tick,
                        Team = Team.None,
                        Line = Mode.IntroLine,
                    });
                }
                break;

            case MatchPhase.Live:
            case MatchPhase.Overtime:
                if (Mode.ScoreLimit > 0d)
                {
                    foreach (var score in match.Scores)
                    {
                        if (score.Score >= Mode.ScoreLimit)
                        {
                            EndMatch(score.Team);
                            return;
                        }
                    }

                    if (!Mode.TeamBased)
                    {
                        foreach (var player in World.Players.Values)
                        {
                            if (player.Kills >= Mode.ScoreLimit)
                            {
                                EndMatch(Team.None);
                                return;
                            }
                        }
                    }
                }

                if (Mode.TimeLimit > 0d && match.TimeRemaining <= 0d)
                {
                    EndMatch(LeadingTeam());
                }
                break;

            case MatchPhase.MatchEnd:
                if (match.TimeRemaining <= 0d)
                {
                    match.TimeRemaining = 0d;
                }
                break;
        }
    }

    private Team? LeadingTeam()
    {
        if (!Mode.TeamBased)
        {
            return Team.None;
        }

        var allies = World.Match.Scores.FirstOrDefault(score => score.Team == Team.Allies)?.Score ?? 0d;
        var axis = World.Match.Scores.FirstOrDefault(score => score.Team == Team.Axis)?.Score ?? 0d;
        if (allies == axis)
        {
            return null;
        }

        return allies > axis ? Team.Allies : Team.Axis;
    }

    private void EndMatch(Team? winner)
    {
        var match = World.Match;
        if (match.Phase == MatchPhase.MatchEnd)
        {
            return;
        }

        match.Phase = MatchPhase.MatchEnd;
        match.Winner = winner;
        match.TimeRemaining = GameConstants.Match.OutroDuration;
        Emit(new GenericSimEvent(SimEventType.MatchStateChanged)
        {
            Tick = World.Tick,
            Data = new Dictionary<string, object?>
            {
                ["phase"] = MatchPhase.MatchEnd,
                ["winner"] = winner,
            },
        });
    }

    private void StepDeadPlayer(
        PlayerState player,
        PlayerRuntime runtime,
        double deltaTime,
        bool live)
    {
        if (!live)
        {
            return;
        }

        if (!Mode.Respawn && World.Match.Phase == MatchPhase.Live)
        {
            return;
        }

        player.RespawnTimer -= deltaTime;
        if (player.RespawnTimer > 0d || !runtime.WantsRespawn)
        {
            return;
        }

        if (!ObjectiveSystem.RespawnAllowed(Mode, Objectives, player))
        {
            return;
        }

        SpawnPlayer(player, runtime);
    }

    public void SpawnPlayer(PlayerState player)
    {
        _runtimes.TryGetValue(player.Id, out var runtime);
        SpawnPlayer(player, runtime);
    }

    private void SpawnPlayer(PlayerState player, PlayerRuntime? runtime)
    {
        if (runtime is null)
        {
            return;
        }

        var choice = SpawnSystem.SelectSpawn(World, Map, Collision, SpawnContext, player, Rng);
        if (choice is null)
        {
            return;
        }

        WorldFactory.RespawnPlayer(player, choice.Position, choice.Yaw);
        LoadoutSystem.ApplyLoadout(player, runtime.Resolved);
        WeaponSystem.ResetWeaponRuntime(player.Id);
        Movement.ResetStride(player.Id);
        runtime.WantsRespawn = player.IsBot;

        Emit(new GenericSimEvent(SimEventType.Spawn)
        {
            Tick = World.Tick,
            Player = player.Id,
            Team = player.Team,
            Position = MathEx.Clone(choice.Position),
        });
    }

    private void StepAlivePlayer(
        PlayerState player,
        PlayerRuntime runtime,
        double deltaTime,
        bool live)
    {
        var input = runtime.Input;
        var weaponDefinition = ActiveWeaponDef(player);
        var perks = runtime.Resolved.Perks;

        var movementModifiers = new MovementModifiers
        {
            SpeedMultiplier = weaponDefinition.Handling.MovementSpeedMultiplier * perks.MovementSpeedMult,
            AdsSpeedMultiplier = weaponDefinition.Handling.AdsSpeedMultiplier,
            AdsProgress = player.AdsProgress,
            SprintBlocked = player.Action == WeaponAction.Reloading &&
                            weaponDefinition.Class == WeaponClass.Launcher,
            SlideBlocked = false,
            SlowMultiplier = 1d - MathEx.Clamp01(player.ConcussionAmount) * 0.45d,
            FallDamageImmune = perks.FallDamageImmune,
        };

        var weaponModifiers = new WeaponModifiers
        {
            ReloadSpeedMult = 1d / perks.ReloadSpeedMult,
            AdsSpeedMult = 1d / perks.AdsSpeedMult,
            SwapSpeedMult = 1d / perks.SwapSpeedMult,
            SprintOutMult = 1d / perks.SprintOutMult,
            HipSpreadMult = player.IsBot ? 1d : .35d,
            FireBlocked = !live || World.Match.Phase == MatchPhase.MatchEnd,
        };

        ModifierHook?.Invoke(player, movementModifiers, weaponModifiers);

        var movement = Movement.StepMovement(player, input, Collision, deltaTime, movementModifiers);
        if (movement.Jumped)
        {
            EmitPlayerPosition(SimEventType.Jump, player);
        }

        if (movement.Landed)
        {
            EmitPlayerPosition(SimEventType.Land, player);
            if (movement.FallDamage > 0d)
            {
                DamagePlayer(player, new DamageInfo
                {
                    Amount = movement.FallDamage,
                    Attacker = player.Id,
                    Victim = player.Id,
                    Cause = DamageCause.Fall,
                    WeaponId = string.Empty,
                    Location = HitLocation.LowerLeg,
                    Position = MathEx.Clone(player.Position),
                    Direction = new Vec3(0d, 1d, 0d),
                    Distance = 0d,
                    IgnoreArmor = true,
                });
            }
        }

        if (movement.StartedSlide)
        {
            EmitPlayerPosition(SimEventType.Slide, player);
        }

        if (movement.StartedMantle)
        {
            EmitPlayerPosition(SimEventType.Mantle, player);
        }

        if (movement.Footstep)
        {
            var surface = SurfaceUnder(player.Position);
            Emit(new FootstepEvent
            {
                Tick = World.Tick,
                Player = player.Id,
                Position = MathEx.Clone(player.Position),
                Surface = surface,
                Loud = movement.FootstepLoud && !perks.SilentMovement,
            });
        }

        if (WorldFactory.ClampToBounds(player.Position, Map.Bounds) &&
            player.Position.Y > Map.Bounds.Max.Y - 1d)
        {
            KillPlayerWith(player, player.Id, DamageCause.OutOfBounds, string.Empty);
            return;
        }

        WeaponSystem.SetTrigger(player, input);
        var weaponResult = WeaponSystem.StepWeapon(
            player,
            input,
            World.Time,
            deltaTime,
            Rng,
            state => ResolveWeaponState(player, state.DefId),
            weaponModifiers);

        if (weaponResult.ReloadStarted)
        {
            EmitPlayerPosition(SimEventType.Reload, player);
        }

        if (weaponResult.ReloadFinished)
        {
            Emit(new GenericSimEvent(SimEventType.ReloadComplete)
            {
                Tick = World.Tick,
                Player = player.Id,
            });
        }

        if (weaponResult.SwapFinished)
        {
            Emit(new GenericSimEvent(SimEventType.WeaponSwap)
            {
                Tick = World.Tick,
                Player = player.Id,
            });
        }

        if (weaponResult.MeleeSwing)
        {
            ResolveMelee(player);
        }

        if (weaponResult.ShotsFired > 0)
        {
            FireShots(
                player,
                weaponDefinition,
                weaponResult.ShotsFired,
                weaponResult.PelletsPerShot,
                weaponResult.Spread,
                weaponResult.ShotIndexBase);
        }

        HandleEquipment(player, runtime, input, deltaTime);
        HandleKillstreakInput(player, runtime, input, live);

        player.TimeSinceDamage += deltaTime;
        var regenerationDelay = GameConstants.Health.RegenerationDelay * perks.HealthRegenDelayMult;
        if (player.Health < player.MaxHealth && player.TimeSinceDamage >= regenerationDelay)
        {
            var rate = GameConstants.Health.RegenerationRate * perks.HealthRegenRateMult;
            player.Health = Math.Min(player.MaxHealth, player.Health + rate * deltaTime);
        }

        UpdateKillstreaks(player, runtime);
    }

    private WeaponDef ResolveWeaponState(PlayerState player, string definitionId)
    {
        if (_runtimes.TryGetValue(player.Id, out var runtime))
        {
            if (runtime.Resolved.Primary.Id == definitionId)
            {
                return runtime.Resolved.Primary;
            }

            if (runtime.Resolved.Secondary.Id == definitionId)
            {
                return runtime.Resolved.Secondary;
            }
        }

        return WeaponData.TryGetWeapon(definitionId) ?? WeaponData.GetWeapon("p226");
    }

    private void FireShots(
        PlayerState player,
        WeaponDef weapon,
        int shots,
        int pellets,
        double spread,
        int shotIndexBase)
    {
        Movement.EyePosition(Eye, player);

        for (var shot = 0; shot < shots; shot++)
        {
            MathEx.AnglesToForward(Direction, player.Yaw, player.Pitch);
            if (!player.IsBot && !weapon.Traits.Contains(WeaponTrait.Explosive))
            {
                ApplyHumanAimAssist(player, Direction);
            }
            Emit(new ShotEvent
            {
                Tick = World.Tick,
                Player = player.Id,
                WeaponId = weapon.Id,
                Origin = MathEx.Clone(Eye),
                Direction = MathEx.Clone(Direction),
                Suppressed = WeaponSystem.IsSuppressed(weapon),
                ShotIndex = shotIndexBase + shot,
            });

            if (weapon.Traits.Contains(WeaponTrait.Explosive))
            {
                LaunchWeaponProjectile(player, weapon, Eye, Direction);
                continue;
            }

            for (var pellet = 0; pellet < pellets; pellet++)
            {
                Combat.ApplySpread(SpreadDirection, Direction, spread, Rng);
                Combat.TraceShot(World, Collision, player, weapon, Eye, SpreadDirection, SharedTrace);
                ApplyTraceResult(player, weapon, SharedTrace);
            }
        }
    }

    private void ApplyHumanAimAssist(PlayerState shooter, Vec3 direction)
    {
        var coneDegrees = MathEx.Lerp(9d, 6d, shooter.AdsProgress);
        var minimumDot = Math.Cos(coneDegrees * Math.PI / 180d);
        var bestDot = minimumDot;
        var found = false;

        foreach (var target in World.Players.Values)
        {
            if (target.Id == shooter.Id || !target.Alive ||
                !SimulationTypes.IsEnemyTeam(shooter.Team, target.Team))
            {
                continue;
            }

            Combat.HitboxCenter(AimAssistTarget, target, HitLocation.Chest);
            if (!Collision.IsVisible(Eye, AimAssistTarget, SightFilter)) continue;

            AimAssistDirection.X = AimAssistTarget.X - Eye.X;
            AimAssistDirection.Y = AimAssistTarget.Y - Eye.Y;
            AimAssistDirection.Z = AimAssistTarget.Z - Eye.Z;
            var distanceSquared = MathEx.LengthSquared(AimAssistDirection);
            if (distanceSquared < 1d || distanceSquared > 14_400d) continue;
            MathEx.Normalize(AimAssistDirection, AimAssistDirection);

            var dot = MathEx.Dot(direction, AimAssistDirection);
            if (dot <= bestDot) continue;
            bestDot = dot;
            found = true;
            MathEx.Copy(Temporary, AimAssistDirection);
        }

        if (!found) return;
        MathEx.Lerp(direction, direction, Temporary, .9d);
        MathEx.Normalize(direction, direction);
    }

    private void ApplyTraceResult(PlayerState shooter, WeaponDef weapon, TraceResult trace)
    {
        if (trace.HitAnything && !trace.HitPlayer)
        {
            Emit(new ImpactEvent
            {
                Tick = World.Tick,
                Position = MathEx.Clone(trace.Point),
                Normal = MathEx.Clone(trace.Normal),
                Surface = trace.Surface,
                Shooter = shooter.Id,
                Penetrated = trace.Penetrations > 0,
            });
            return;
        }

        if (!trace.HitPlayer)
        {
            Emit(new ImpactEvent
            {
                Tick = World.Tick,
                Position = MathEx.Clone(trace.Point),
                Normal = MathEx.Clone(trace.Normal),
                Surface = SurfaceType.Concrete,
                Shooter = shooter.Id,
                Penetrated = false,
            });
            return;
        }

        if (!World.Players.TryGetValue(trace.Victim, out var victim) || !victim.Alive)
        {
            return;
        }

        MathEx.Subtract(DamageDirection, victim.Position, shooter.Position);
        MathEx.Normalize(DamageDirection, DamageDirection);

        var multiplier = DamageMultiplierHook?.Invoke(shooter.Id, weapon.Id) ?? 1d;
        var result = DamagePlayer(victim, new DamageInfo
        {
            Amount = trace.Damage * multiplier,
            Attacker = shooter.Id,
            Victim = victim.Id,
            Cause = DamageCause.Bullet,
            WeaponId = weapon.Id,
            Location = trace.Location,
            Position = MathEx.Clone(trace.Point),
            Direction = MathEx.Clone(DamageDirection),
            Distance = trace.Distance,
            IgnoreArmor = false,
        });

        Emit(new HitEvent
        {
            Tick = World.Tick,
            Attacker = shooter.Id,
            Victim = victim.Id,
            Location = trace.Location,
            Damage = result.Applied,
            Lethal = result.Killed,
            Position = MathEx.Clone(trace.Point),
            WeaponId = weapon.Id,
        });

        if (trace.Location == HitLocation.Head)
        {
            shooter.Headshots++;
        }
    }

    private void LaunchWeaponProjectile(
        PlayerState player,
        WeaponDef weapon,
        Vec3 origin,
        Vec3 direction)
    {
        var kind = weapon.Id == "gl40"
            ? ProjectileKind.GrenadeLauncher
            : ProjectileKind.Rocket;
        var speed = double.IsFinite(weapon.MuzzleVelocity) ? weapon.MuzzleVelocity : 60d;
        MathEx.Scale(Temporary, direction, speed);
        Temporary.X += player.Velocity.X;
        Temporary.Z += player.Velocity.Z;

        var id = WorldFactory.AllocateEntityId(World);
        var projectile = WorldFactory.CreateProjectile(
            id,
            kind,
            player.Id,
            player.Team,
            origin,
            Temporary,
            12d);
        projectile.Armed = true;
        World.Projectiles[id] = projectile;
    }

    private void ResolveMelee(PlayerState player)
    {
        var target = Combat.FindMeleeTarget(World, Collision, player);
        EmitPlayerPosition(SimEventType.Melee, player);
        if (target is null)
        {
            return;
        }

        var weapon = ActiveWeaponDef(player);
        var backstab = Combat.IsBehind(player, target);
        var damage = backstab ? 200d : weapon.MeleeDamage;

        MathEx.Subtract(DamageDirection, target.Position, player.Position);
        MathEx.Normalize(DamageDirection, DamageDirection);
        DamagePlayer(target, new DamageInfo
        {
            Amount = damage,
            Attacker = player.Id,
            Victim = target.Id,
            Cause = DamageCause.Melee,
            WeaponId = weapon.Id,
            Location = HitLocation.Chest,
            Position = MathEx.Clone(target.Position),
            Direction = MathEx.Clone(DamageDirection),
            Distance = MathEx.Distance(player.Position, target.Position),
            IgnoreArmor = backstab,
        });
    }

    private void HandleEquipment(
        PlayerState player,
        PlayerRuntime runtime,
        InputCommand input,
        double deltaTime)
    {
        if (SimulationTypes.HasFlag(input.Buttons, InputFlag.Lethal))
        {
            var definition = runtime.Resolved.Lethal;
            var detonations = definition?.Id == "c4"
                ? DeployableSystem.DetonateC4(World, player.Id)
                : [];
            if (detonations.Count > 0)
            {
                foreach (var explosion in detonations)
                {
                    ApplyExplosion(explosion.Position, explosion.Radius, explosion.Damage, explosion.Owner);
                    Emit(new ExplosionEvent
                    {
                        Tick = World.Tick,
                        Position = MathEx.Clone(explosion.Position),
                        Radius = explosion.Radius,
                        Owner = explosion.Owner,
                        Kind = ProjectileKind.C4,
                    });
                }
            }
            else if (definition is not null && player.LethalCount > 0)
            {
                UseEquipment(player, definition);
                player.LethalCount--;
            }
        }

        if (SimulationTypes.HasFlag(input.Buttons, InputFlag.Tactical) && player.TacticalCount > 0)
        {
            var definition = runtime.Resolved.Tactical;
            if (definition is not null)
            {
                UseEquipment(player, definition);
                player.TacticalCount--;
            }
        }

        if (!string.IsNullOrEmpty(runtime.Resolved.FieldUpgrade))
        {
            var upgrade = EquipmentData.GetEquipment(runtime.Resolved.FieldUpgrade);
            var chargeTime = upgrade.ChargeTime ?? 120d;
            player.FieldUpgradeCharge = Math.Min(
                1d,
                player.FieldUpgradeCharge + deltaTime / chargeTime);

            if (SimulationTypes.HasFlag(input.Buttons, InputFlag.FieldUpgrade) &&
                player.FieldUpgradeCharge >= 1d)
            {
                UseEquipment(player, upgrade);
                player.FieldUpgradeCharge = 0d;
            }
        }
    }

    private void UseEquipment(PlayerState player, EquipmentDef definition)
    {
        if (definition.DeployableKind is not null)
        {
            var placement = DeployableSystem.PlacementPoint(Collision, player, 2.2d, PlacementTemporary);
            var payload = definition.DeployableKind == DeployableKind.CarePackage
                ? DeployableSystem.RollCarePackage(Rng)
                : string.Empty;
            var deployable = DeployableSystem.Place(
                World,
                definition.DeployableKind.Value,
                player,
                placement.Position,
                placement.Yaw,
                () => WorldFactory.AllocateEntityId(World),
                payload);
            Emit(new GenericSimEvent(SimEventType.DeployablePlaced)
            {
                Tick = World.Tick,
                Player = player.Id,
                Team = player.Team,
                Position = MathEx.Clone(deployable.Position),
                Data = new Dictionary<string, object?>
                {
                    ["kind"] = deployable.Kind,
                    ["equipmentId"] = definition.Id,
                },
            });
            UpdateDynamicColliders();
            return;
        }

        ThrowEquipment(player, definition);
    }

    private void ThrowEquipment(PlayerState player, EquipmentDef definition)
    {
        Movement.EyePosition(Eye, player);
        MathEx.AnglesToForward(Direction, player.Yaw, player.Pitch);

        var speed = definition.ThrowSpeed ?? 18d;
        MathEx.Scale(Temporary, Direction, speed);
        Temporary.Y += 2.2d;
        Temporary.X += player.Velocity.X * 0.5d;
        Temporary.Z += player.Velocity.Z * 0.5d;

        var id = WorldFactory.AllocateEntityId(World);
        var kind = definition.ProjectileKind ?? ProjectileKind.Frag;
        var projectile = WorldFactory.CreateProjectile(
            id,
            kind,
            player.Id,
            player.Team,
            Eye,
            Temporary,
            definition.Fuse ?? 3.5d);
        projectile.Armed = true;
        World.Projectiles[id] = projectile;

        Emit(new GenericSimEvent(SimEventType.ProjectileThrown)
        {
            Tick = World.Tick,
            Player = player.Id,
            Position = MathEx.Clone(Eye),
            Data = new Dictionary<string, object?>
            {
                ["equipmentId"] = definition.Id,
                ["kind"] = kind,
            },
        });
    }

    private void HandleKillstreakInput(
        PlayerState player,
        PlayerRuntime runtime,
        InputCommand input,
        bool live)
    {
        var pressed = input.KillstreakSlot >= 0 && runtime.LastKillstreakSlot < 0;
        runtime.LastKillstreakSlot = input.KillstreakSlot;
        if (!pressed || !live)
        {
            return;
        }

        var slot = input.KillstreakSlot;
        var streakId = slot >= 0 && slot < player.KillstreakInventory.Count
            ? player.KillstreakInventory[slot]
            : null;
        if (streakId is null)
        {
            return;
        }

        var result = KillstreakRuntimeSystem.CallKillstreak(
            World,
            Collision,
            Killstreaks,
            player,
            streakId,
            Rng);
        foreach (var simEvent in result.Events)
        {
            simEvent.Tick = World.Tick;
            Emit(simEvent);
        }

        foreach (var entity in result.Spawned)
        {
            World.KillstreakEntities[entity.Id] = entity;
        }

        if (streakId is "sentry_gun" or "care_package")
        {
            var placement = DeployableSystem.PlacementPoint(Collision, player, 3d, PlacementTemporary);
            var kind = streakId == "sentry_gun"
                ? DeployableKind.SentryGun
                : DeployableKind.CarePackage;
            var deployable = DeployableSystem.Place(
                World,
                kind,
                player,
                placement.Position,
                placement.Yaw,
                () => WorldFactory.AllocateEntityId(World),
                kind == DeployableKind.CarePackage
                    ? DeployableSystem.RollCarePackage(Rng)
                    : string.Empty);
            Emit(new GenericSimEvent(SimEventType.DeployablePlaced)
            {
                Tick = World.Tick,
                Player = player.Id,
                Team = player.Team,
                Position = MathEx.Clone(deployable.Position),
                Data = new Dictionary<string, object?>
                {
                    ["kind"] = kind,
                    ["killstreakId"] = streakId,
                },
            });
            UpdateDynamicColliders();
        }

        if (result.EndsMatch)
        {
            EndMatch(player.Team);
        }
    }

    private void StepProjectiles(double deltaTime)
    {
        const double gravity = 21.5d;

        foreach (var projectile in World.Projectiles.Values.ToArray())
        {
            projectile.Age += deltaTime;

            if (!projectile.Stuck)
            {
                projectile.Velocity.Y -= gravity * deltaTime;
                MathEx.Scale(Temporary, projectile.Velocity, deltaTime);
                var distance = Math.Sqrt(MathEx.LengthSquared(Temporary));

                if (distance > 1e-5d)
                {
                    MathEx.Normalize(Direction, Temporary);
                    var hit = Collision.Raycast(
                        projectile.Position,
                        Direction,
                        distance,
                        new QueryFilter(CollisionLayer.Projectile)
                        {
                            IgnoreEntities = [projectile.Owner],
                        },
                        ProjectileHit);

                    if (hit.Hit)
                    {
                        if (DetonatesOnImpact(projectile.Kind))
                        {
                            MathEx.Copy(projectile.Position, hit.Point);
                            DetonateProjectile(projectile);
                            continue;
                        }

                        if (SticksOnImpact(projectile.Kind))
                        {
                            MathEx.AddScaled(projectile.Position, hit.Point, hit.Normal, 0.04d);
                            projectile.Stuck = true;
                            MathEx.Set(projectile.Velocity, 0d, 0d, 0d);
                        }
                        else
                        {
                            MathEx.AddScaled(projectile.Position, hit.Point, hit.Normal, 0.03d);
                            var dot = projectile.Velocity.X * hit.Normal.X +
                                      projectile.Velocity.Y * hit.Normal.Y +
                                      projectile.Velocity.Z * hit.Normal.Z;
                            projectile.Velocity.X =
                                (projectile.Velocity.X - 2d * dot * hit.Normal.X) * 0.42d;
                            projectile.Velocity.Y =
                                (projectile.Velocity.Y - 2d * dot * hit.Normal.Y) * 0.42d;
                            projectile.Velocity.Z =
                                (projectile.Velocity.Z - 2d * dot * hit.Normal.Z) * 0.42d;
                            projectile.Bounces++;
                        }
                    }
                    else
                    {
                        MathEx.AddScaled(projectile.Position, projectile.Position, Temporary, 1d);
                    }
                }
            }

            projectile.Fuse -= deltaTime;
            if (projectile.Fuse <= 0d || projectile.Age > 20d)
            {
                DetonateProjectile(projectile);
            }
        }
    }

    private static bool DetonatesOnImpact(ProjectileKind kind) =>
        kind is ProjectileKind.Rocket or
            ProjectileKind.GrenadeLauncher or
            ProjectileKind.ThrowingKnife;

    private static bool SticksOnImpact(ProjectileKind kind) =>
        kind is ProjectileKind.Semtex or ProjectileKind.ThermiteStick or ProjectileKind.C4;

    private void DetonateProjectile(ProjectileState projectile)
    {
        World.Projectiles.Remove(projectile.Id);
        var effect = ProjectileEffects.TryGetValue(projectile.Kind, out var found)
            ? found
            : ProjectileEffects[ProjectileKind.Frag];

        if (effect.Damage > 0d)
        {
            Emit(new ExplosionEvent
            {
                Tick = World.Tick,
                Position = MathEx.Clone(projectile.Position),
                Radius = effect.Radius,
                Owner = projectile.Owner,
                Kind = projectile.Kind,
            });

            Combat.ResolveExplosion(
                World,
                Collision,
                projectile.Position,
                effect.Radius,
                effect.Damage,
                projectile.Owner,
                FriendlyFire || projectile.Owner == 0,
                ExplosionTargets);

            foreach (var target in ExplosionTargets)
            {
                World.Players.TryGetValue(projectile.Owner, out var owner);
                if (owner is not null && target.Player.Id != projectile.Owner && !FriendlyFire &&
                    !SimulationTypes.IsEnemyTeam(owner.Team, target.Player.Team))
                {
                    continue;
                }

                var resistance = _runtimes.TryGetValue(target.Player.Id, out var runtime)
                    ? runtime.Resolved.Perks.ExplosiveResistMult
                    : 1d;
                DamagePlayer(target.Player, new DamageInfo
                {
                    Amount = target.Damage * resistance,
                    Attacker = projectile.Owner,
                    Victim = target.Player.Id,
                    Cause = DamageCause.Explosion,
                    WeaponId = string.Empty,
                    Location = HitLocation.Chest,
                    Position = MathEx.Clone(projectile.Position),
                    Direction = MathEx.Clone(target.Direction),
                    Distance = target.Distance,
                    IgnoreArmor = false,
                });
            }

            SpawnSystem.AddDangerZone(SpawnContext, projectile.Position, effect.Radius * 2d, 6d);
        }

        if (effect.Flash > 0d)
        {
            ApplyFlash(projectile, effect);
        }
    }

    private void ApplyFlash(ProjectileState projectile, ProjectileEffect effect)
    {
        Emit(new GenericSimEvent(SimEventType.Flash)
        {
            Tick = World.Tick,
            Position = MathEx.Clone(projectile.Position),
            Data = new Dictionary<string, object?>
            {
                ["radius"] = effect.Radius,
            },
        });

        foreach (var target in World.Players.Values)
        {
            if (!target.Alive)
            {
                continue;
            }

            World.Players.TryGetValue(projectile.Owner, out var owner);
            if (owner is not null && target.Id != projectile.Owner && !FriendlyFire &&
                !SimulationTypes.IsEnemyTeam(owner.Team, target.Team))
            {
                continue;
            }

            if (_runtimes.TryGetValue(target.Id, out var runtime) && runtime.Resolved.Perks.FlashImmune)
            {
                continue;
            }

            var intensity = ComputeFlashFor(target, projectile.Position, effect.Radius);
            if (intensity <= 0d)
            {
                continue;
            }

            if (effect.Flash > 0d)
            {
                target.FlashAmount = Math.Max(target.FlashAmount, intensity * effect.Flash);
            }

            if (effect.Stun > 0d)
            {
                target.ConcussionAmount = Math.Max(target.ConcussionAmount, intensity * effect.Stun);
            }
        }
    }

    public PlayerDamageResult DamagePlayer(PlayerState victim, DamageInfo info)
    {
        if (!victim.Alive)
        {
            return new PlayerDamageResult(0d, false);
        }

        if (info.Attacker != victim.Id && !FriendlyFire &&
            World.Players.TryGetValue(info.Attacker, out var friendlyAttacker) &&
            !SimulationTypes.IsEnemyTeam(friendlyAttacker.Team, victim.Team))
        {
            return new PlayerDamageResult(0d, false);
        }

        if (info.Attacker != victim.Id &&
            _outgoingDamageScales.TryGetValue(info.Attacker, out var outgoingScale))
        {
            info.Amount *= outgoingScale;
        }

        var result = Combat.ApplyDamage(victim, info);
        if (result.Applied <= 0d)
        {
            return new PlayerDamageResult(0d, false);
        }

        if (World.Players.TryGetValue(info.Attacker, out var attacker) && attacker.Id != victim.Id)
        {
            attacker.DamageDealt += result.Applied;
        }

        Emit(new DamageEvent
        {
            Tick = World.Tick,
            Victim = victim.Id,
            Attacker = info.Attacker,
            Amount = result.Applied,
            Direction = MathEx.Clone(info.Direction),
            Cause = info.Cause,
        });

        if (result.Killed)
        {
            KillPlayerWith(victim, info.Attacker, info.Cause, info.WeaponId, info.Location);
        }

        return new PlayerDamageResult(result.Applied, result.Killed);
    }

    private void KillPlayerWith(
        PlayerState victim,
        int killerId,
        DamageCause cause,
        string weaponId,
        HitLocation location = HitLocation.Chest)
    {
        World.Players.TryGetValue(killerId, out var killer);
        var assists = Combat.ComputeAssists(victim, killerId);
        var distance = killer is not null
            ? MathEx.Distance(killer.Position, victim.Position)
            : 0d;

        victim.Deaths++;
        victim.DeathStreak++;

        var delay = SpawnSystem.RespawnDelayFor(
            victim,
            Mode.RespawnDelay,
            GameConstants.Match.MaximumRespawnDelay);
        WorldFactory.KillPlayer(victim, delay);
        SpawnSystem.NoteDeath(SpawnContext, victim.Position, World.Time);

        if (_runtimes.TryGetValue(victim.Id, out var runtime))
        {
            runtime.WantsRespawn = victim.IsBot;
        }

        var suicide = killer is null || killer.Id == victim.Id;
        var teamKill = killer is not null && killer.Id != victim.Id &&
                       !SimulationTypes.IsEnemyTeam(killer.Team, victim.Team);

        if (suicide)
        {
            victim.Score = Math.Max(0d, victim.Score - GameConstants.Score.Kill);
        }
        else if (teamKill)
        {
            killer!.Score = Math.Max(0d, killer.Score - GameConstants.Score.Kill);
        }
        else if (killer is not null)
        {
            killer.Kills++;
            killer.Killstreak++;
            killer.DeathStreak = 0;
            killer.BestKillstreak = Math.Max(killer.BestKillstreak, killer.Killstreak);

            var award = Mode.Scoring.Kill;
            if (location == HitLocation.Head)
            {
                award += GameConstants.Score.HeadshotBonus;
            }

            if (distance > 45d)
            {
                award += GameConstants.Score.LongshotBonus;
            }

            AwardScore(killer, award, "kill");
            if (Mode.TeamScoresOnKill && Mode.TeamBased)
            {
                WorldFactory.AddTeamScore(World, killer.Team, 1d);
            }

            foreach (var assistId in assists)
            {
                if (World.Players.TryGetValue(assistId, out var assister) &&
                    SimulationTypes.IsEnemyTeam(assister.Team, victim.Team))
                {
                    assister.Assists++;
                    AwardScore(assister, Mode.Scoring.Assist, "assist");
                }
            }
        }

        if (Mode.Id == "kc")
        {
            var lifetime = Mode.NumberParam("tagLifetime", 30d);
            ObjectiveSystem.DropTag(Objectives, victim, killerId, lifetime);
        }

        Emit(new KillEvent
        {
            Tick = World.Tick,
            Killer = killerId,
            Victim = victim.Id,
            Assists = assists,
            WeaponId = weaponId,
            Headshot = location == HitLocation.Head,
            Cause = cause,
            Distance = distance,
            KillerWasLowHealth = killer is not null && killer.Health < 35d,
            VictimPosition = MathEx.Clone(victim.Position),
            KillerPosition = killer is not null
                ? MathEx.Clone(killer.Position)
                : MathEx.Clone(victim.Position),
        });
    }

    private void AwardScore(PlayerState player, double amount, string reason)
    {
        if (amount == 0d)
        {
            return;
        }

        player.Score += amount;
        player.StreakScore += amount;
        Emit(new ScoreEvent
        {
            Tick = World.Tick,
            Player = player.Id,
            Amount = amount,
            Reason = reason,
        });
    }

    private void UpdateKillstreaks(PlayerState player, PlayerRuntime runtime)
    {
        if (!Mode.KillstreaksEnabled)
        {
            return;
        }

        foreach (var id in player.Killstreaks)
        {
            if (player.KillstreakInventory.Contains(id) ||
                !KillstreakCosts.TryGetValue(id, out var definition))
            {
                continue;
            }

            var discount = runtime.Resolved.Perks.KillstreakCostMult;
            var earned = Mode.ScorestreaksOnly
                ? player.StreakScore >= definition.ScoreCost * discount
                : player.Killstreak >= Math.Max(1, JsRoundToInt(definition.Cost * discount));
            if (!earned)
            {
                continue;
            }

            player.KillstreakInventory.Add(id);
            Emit(new GenericSimEvent(SimEventType.KillstreakEarned)
            {
                Tick = World.Tick,
                Player = player.Id,
                Team = player.Team,
                Data = new Dictionary<string, object?>
                {
                    ["killstreakId"] = id,
                },
            });
        }
    }

    private void StepStatusEffects(double deltaTime)
    {
        foreach (var player in World.Players.Values)
        {
            if (player.FlashAmount > 0d)
            {
                player.FlashAmount = Math.Max(
                    0d,
                    player.FlashAmount - deltaTime * (0.35d + player.FlashAmount * 0.6d));
            }

            if (player.ConcussionAmount > 0d)
            {
                player.ConcussionAmount = Math.Max(0d, player.ConcussionAmount - deltaTime * 0.4d);
            }

            if (player.EmpTime > 0d)
            {
                player.EmpTime = Math.Max(0d, player.EmpTime - deltaTime);
            }
        }
    }

    private void UpdateDynamicColliders()
    {
        _dynamicColliders.Clear();
        foreach (var player in World.Players.Values)
        {
            if (!player.Alive)
            {
                continue;
            }

            var capsule = WorldFactory.PlayerCapsule(player);
            _dynamicColliders.Add(new DynamicCollider
            {
                Id = player.EntityId,
                Layer = CollisionLayer.Player,
                Position = player.Position,
                Kind = DynamicColliderKind.Capsule,
                Height = capsule.Height,
                Radius = capsule.Radius,
                Active = true,
            });
        }

        foreach (var deployable in DeployableSystem.SolidDeployables(World))
        {
            var specification = DeployableSystem.DeployableSpec(deployable.Kind);
            _dynamicColliders.Add(new DynamicCollider
            {
                Id = deployable.Id,
                Layer = CollisionLayer.Deployable,
                Position = deployable.Position,
                Kind = DynamicColliderKind.Box,
                Height = specification.Size.Y,
                Radius = Math.Max(specification.Size.X, specification.Size.Z) / 2d,
                Size = specification.Size,
                Yaw = deployable.Yaw,
                Active = true,
            });
        }

        Collision.SetDynamicColliders(_dynamicColliders);
    }

    private SurfaceType SurfaceUnder(Vec3 position)
    {
        MathEx.Set(Temporary, position.X, position.Y + 0.4d, position.Z);
        MathEx.Set(Direction, 0d, -1d, 0d);
        var hit = Collision.Raycast(Temporary, Direction, 1.2d, GroundQuery, ProjectileHit);
        return hit.Hit ? hit.Surface : SurfaceType.Concrete;
    }

    public bool CanSee(PlayerState observer, PlayerState target)
    {
        MathEx.Set(
            Eye,
            observer.Position.X,
            observer.Position.Y + Movement.CurrentEyeHeight(observer),
            observer.Position.Z);
        MathEx.Set(
            Temporary,
            target.Position.X,
            target.Position.Y + Movement.CurrentEyeHeight(target) * 0.8d,
            target.Position.Z);
        return Collision.IsVisible(Eye, Temporary, SightFilter);
    }

    public double GunshotRadius(WeaponDef weapon) =>
        WeaponSystem.IsSuppressed(weapon)
            ? GameConstants.Perception.SuppressedGunshotRadius
            : GameConstants.Perception.GunshotRadius;

    public List<PlayerState> Scoreboard()
    {
        var output = World.Players.Values
            .Where(player => player.Team != Team.Hostile)
            .OrderByDescending(player => player.Score)
            .ThenByDescending(player => player.Kills)
            .ThenBy(player => player.Deaths)
            .ThenBy(player => player.Id)
            .ToList();
        return output;
    }

    private double ComputeFlashFor(PlayerState target, Vec3 flashPosition, double radius)
    {
        MathEx.Set(
            Temporary,
            target.Position.X,
            target.Position.Y + Movement.CurrentEyeHeight(target),
            target.Position.Z);
        var distance = MathEx.Distance(flashPosition, Temporary);
        if (distance > radius || !Collision.IsVisible(flashPosition, Temporary, SightFilter))
        {
            return 0d;
        }

        MathEx.Subtract(Direction, flashPosition, Temporary);
        MathEx.Normalize(Direction, Direction);
        MathEx.AnglesToForward(Eye, target.Yaw, target.Pitch);
        var facing = Direction.X * Eye.X + Direction.Y * Eye.Y + Direction.Z * Eye.Z;
        var angleFactor = Math.Pow(MathEx.Clamp01(facing * 0.5d + 0.5d), 1.6d) * 0.9d + 0.1d;
        var distanceFactor = 1d - MathEx.Clamp01(distance / radius);
        return MathEx.Clamp01(angleFactor * distanceFactor);
    }

    private void Emit(SimEvent simEvent) => _events.Add(simEvent);

    private void EmitPlayerPosition(SimEventType type, PlayerState player)
    {
        Emit(new GenericSimEvent(type)
        {
            Tick = World.Tick,
            Player = player.Id,
            Position = MathEx.Clone(player.Position),
        });
    }

    private static ProjectileEffect Effect(
        double damage,
        double radius,
        double flash,
        double stun) =>
        new()
        {
            Damage = damage,
            Radius = radius,
            Flash = flash,
            Stun = stun,
        };

    private static int JsRoundToInt(double value) => checked((int)Math.Floor(value + 0.5d));
}
