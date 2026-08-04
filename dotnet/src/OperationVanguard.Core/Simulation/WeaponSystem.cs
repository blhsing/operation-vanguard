namespace OperationVanguard.Core;

/// <summary>Resolved per-tick modifiers from perks and field upgrades.</summary>
public sealed class WeaponModifiers
{
    public double ReloadSpeedMult { get; set; } = 1d;
    public double AdsSpeedMult { get; set; } = 1d;
    public double SwapSpeedMult { get; set; } = 1d;
    public double SprintOutMult { get; set; } = 1d;
    public double HipSpreadMult { get; set; } = 1d;
    public bool FireBlocked { get; set; }
}

/// <summary>Actions the weapon state machine asks the caller to resolve this tick.</summary>
public sealed class WeaponTickResult
{
    public int ShotsFired { get; set; }
    public int PelletsPerShot { get; set; } = 1;
    public double RecoilPitch { get; set; }
    public double RecoilYaw { get; set; }
    public double Spread { get; set; }
    public bool ReloadFinished { get; set; }
    public bool ReloadStarted { get; set; }
    public bool SwapFinished { get; set; }
    public bool MeleeSwing { get; set; }
    public bool DryFire { get; set; }
    public int ShotIndexBase { get; set; }
}

/// <summary>Firing, reload, swap, ADS, sprint-out, melee, recoil, and spread state.</summary>
public static class WeaponSystem
{
    private const double MeleeSwingTime = 0.55d;
    private const double MeleeHitTime = 0.18d;

    private sealed class WeaponRuntime
    {
        public WeaponSlot PendingSlot { get; set; } = WeaponSlot.Primary;
        public bool AmmoInserted { get; set; }
        public bool ShellReloadActive { get; set; }
        public double MeleeElapsed { get; set; }
        public bool MeleeResolved { get; set; }
        public bool TriggerWasDown { get; set; }
        public int BurstFired { get; set; }
        public double BurstCooldown { get; set; }
    }

    private static readonly Dictionary<int, WeaponRuntime> Runtimes = [];
    private static readonly WeaponTickResult SharedResult = new();
    private static readonly RecoilImpulse Recoil = new();

    public static WeaponModifiers DefaultWeaponModifiers { get; } = new();

    public static void ResetWeaponRuntime(int playerId) => Runtimes.Remove(playerId);

    /// <summary>The weapon currently held, or null when the indexed slot is empty.</summary>
    public static WeaponState? ActiveWeapon(PlayerState player) => WeaponAt(player, player.ActiveSlot);

    /// <summary>Advance one player's weapon state machine by one simulation tick.</summary>
    public static WeaponTickResult StepWeapon(
        PlayerState player,
        InputCommand input,
        double worldTime,
        double deltaTime,
        Rng rng,
        Func<WeaponState, WeaponDef> resolve,
        WeaponModifiers? modifiers = null)
    {
        var mods = modifiers ?? DefaultWeaponModifiers;
        ResetResult(SharedResult);

        if (!player.Alive)
        {
            return SharedResult;
        }

        var runtime = RuntimeFor(player.Id);
        var state = ActiveWeapon(player);
        if (state is null)
        {
            return SharedResult;
        }

        var definition = resolve(state);
        runtime.BurstCooldown = Math.Max(0d, runtime.BurstCooldown - deltaTime);

        HandleSprintOut(player, definition, mods, deltaTime);
        UpdateAds(player, input, definition, mods, deltaTime);
        DecayRecoilAndSpread(player, state, definition, deltaTime);

        if (player.ActionTimer > 0d)
        {
            player.ActionTimer = Math.Max(0d, player.ActionTimer - deltaTime);
        }

        switch (player.Action)
        {
            case WeaponAction.Reloading:
                StepReload(player, state, definition, runtime, input, mods, SharedResult);
                break;
            case WeaponAction.Swapping:
                StepSwap(player, runtime, SharedResult, resolve);
                break;
            case WeaponAction.Melee:
                StepMelee(player, runtime, deltaTime, SharedResult);
                break;
        }

        if (SimulationTypes.HasFlag(input.Buttons, InputFlag.Melee) &&
            player.Action != WeaponAction.Melee &&
            !Movement.IsMovementLocked(player))
        {
            StartMelee(player, runtime);
        }

        HandleSwapRequest(player, input, runtime, definition, mods);
        HandleReloadRequest(player, state, definition, input, runtime, mods, SharedResult);

        if (CanFire(player, state, definition, worldTime, mods, runtime))
        {
            Fire(player, state, definition, worldTime, rng, runtime, mods, SharedResult);
        }

        runtime.TriggerWasDown = player.TriggerHeld;
        return SharedResult;
    }

    /// <summary>Cancel an active reload without changing ammo already inserted.</summary>
    public static void CancelReload(PlayerState player)
    {
        if (player.Action != WeaponAction.Reloading)
        {
            return;
        }

        player.Action = WeaponAction.Ready;
        player.ActionTimer = 0d;
        if (Runtimes.TryGetValue(player.Id, out var runtime))
        {
            runtime.ShellReloadActive = false;
        }
    }

    /// <summary>Immediately equip a specific populated slot.</summary>
    public static void ForceSwap(PlayerState player, WeaponSlot slot)
    {
        if (WeaponAt(player, slot) is null)
        {
            return;
        }

        var runtime = RuntimeFor(player.Id);
        CancelReload(player);
        player.ActiveSlot = slot;
        runtime.PendingSlot = slot;
        player.Action = WeaponAction.Ready;
        player.ActionTimer = 0d;
        player.AdsProgress = 0d;
        player.IsAds = false;
    }

    /// <summary>Latch the current fire button before calling <see cref="StepWeapon"/>.</summary>
    public static void SetTrigger(PlayerState player, InputCommand input) =>
        player.TriggerHeld = SimulationTypes.HasFlag(input.Buttons, InputFlag.Fire);

    /// <summary>Refill reserve ammo by a number of full magazines.</summary>
    public static void Resupply(WeaponState state, WeaponDef definition, int magazines)
    {
        var magazineSize = EffectiveMagSize(definition);
        state.AmmoReserve = Math.Min(
            definition.MaxReserve,
            state.AmmoReserve + magazineSize * magazines);
    }

    public static int TotalAmmo(WeaponState state) => state.AmmoInMag + state.AmmoReserve;

    public static double AdsFovScale(WeaponDef definition, double adsProgress)
    {
        var zoom = definition.Scoped ? Math.Min(definition.AdsZoom, 1.6d) : definition.AdsZoom;
        return 1d / (1d + (zoom - 1d) * adsProgress);
    }

    public static bool ShowScopeOverlay(WeaponDef definition, double adsProgress) =>
        definition.Scoped && adsProgress > 0.82d;

    public static bool IsSuppressed(WeaponDef definition) =>
        definition.Audio.Suppressed || definition.Traits.Contains(WeaponTrait.AlwaysSuppressed);

    public static double WeaponSpeedMultiplier(WeaponDef definition) =>
        definition.Handling.MovementSpeedMultiplier;

    public static bool AllowsSlide(WeaponDef definition) =>
        definition.Class != WeaponClass.Melee || definition.Id != "riot_shield";

    private static WeaponRuntime RuntimeFor(int playerId)
    {
        if (Runtimes.TryGetValue(playerId, out var runtime))
        {
            return runtime;
        }

        runtime = new WeaponRuntime();
        Runtimes[playerId] = runtime;
        return runtime;
    }

    private static void ResetResult(WeaponTickResult output)
    {
        output.ShotsFired = 0;
        output.PelletsPerShot = 1;
        output.RecoilPitch = 0d;
        output.RecoilYaw = 0d;
        output.Spread = 0d;
        output.ReloadFinished = false;
        output.ReloadStarted = false;
        output.SwapFinished = false;
        output.MeleeSwing = false;
        output.DryFire = false;
        output.ShotIndexBase = 0;
    }

    private static void HandleSprintOut(
        PlayerState player,
        WeaponDef definition,
        WeaponModifiers modifiers,
        double deltaTime)
    {
        var duration = definition.Handling.SprintOutTime * modifiers.SprintOutMult;

        if (player.SprintOutPending)
        {
            player.SprintOutPending = false;
            player.SprintOutTime = duration;
        }

        if (player.MoveState is MoveState.Sprint or MoveState.TacticalSprint)
        {
            player.SprintOutTime = duration;
        }
        else
        {
            player.SprintOutTime = Math.Max(0d, player.SprintOutTime - deltaTime);
        }
    }

    private static void UpdateAds(
        PlayerState player,
        InputCommand input,
        WeaponDef definition,
        WeaponModifiers modifiers,
        double deltaTime)
    {
        var wantsAds =
            SimulationTypes.HasFlag(input.Buttons, InputFlag.Ads) &&
            player.MoveState != MoveState.Sprint &&
            player.MoveState != MoveState.TacticalSprint &&
            player.MoveState != MoveState.Slide &&
            player.Action != WeaponAction.Swapping &&
            player.Action != WeaponAction.Melee &&
            !Movement.IsMovementLocked(player);

        player.IsAds = wantsAds;

        var adsTime = Math.Max(0.02d, definition.Handling.AdsTime * modifiers.AdsSpeedMult);
        var rate = wantsAds ? 1d / adsTime : 1d / (adsTime * 0.72d);
        player.AdsProgress = MathEx.MoveTowards(
            player.AdsProgress,
            wantsAds ? 1d : 0d,
            rate * deltaTime);
        player.AdsProgress = MathEx.Clamp01(player.AdsProgress);
    }

    private static void DecayRecoilAndSpread(
        PlayerState player,
        WeaponState state,
        WeaponDef definition,
        double deltaTime)
    {
        var recoil = definition.Recoil;
        const double target = 0d;
        var decay = recoil.RecoverySpeed * deltaTime;
        state.RecoilPitch = MathEx.Damp(state.RecoilPitch, target, recoil.RecoverySpeed, deltaTime);
        state.RecoilYaw = MathEx.Damp(state.RecoilYaw, target, recoil.RecoverySpeed, deltaTime);
        _ = decay;

        state.Spread = Math.Max(0d, state.Spread - definition.Spread.Recovery * deltaTime);

        if (!player.TriggerHeld && Math.Abs(state.RecoilPitch) < 0.0015d)
        {
            state.ShotsInBurst = 0;
        }

        state.Heat = Math.Max(0d, state.Heat - deltaTime * 0.35d);
    }

    private static void HandleReloadRequest(
        PlayerState player,
        WeaponState state,
        WeaponDef definition,
        InputCommand input,
        WeaponRuntime runtime,
        WeaponModifiers modifiers,
        WeaponTickResult output)
    {
        if (player.Action == WeaponAction.Reloading)
        {
            return;
        }

        if (player.Action is WeaponAction.Swapping or WeaponAction.Melee)
        {
            return;
        }

        if (state.AmmoReserve <= 0 || state.AmmoInMag >= EffectiveMagSize(definition))
        {
            return;
        }

        var manual = SimulationTypes.HasFlag(input.Buttons, InputFlag.Reload);
        var automatic = state.AmmoInMag <= 0 && player.TriggerHeld;
        if (!manual && !automatic)
        {
            return;
        }

        StartReload(player, state, definition, runtime, modifiers, output);
    }

    private static void StartReload(
        PlayerState player,
        WeaponState state,
        WeaponDef definition,
        WeaponRuntime runtime,
        WeaponModifiers modifiers,
        WeaponTickResult output)
    {
        var empty = state.AmmoInMag <= 0;
        var shellByShell = definition.Traits.Contains(WeaponTrait.ShellReload);
        var baseDuration = shellByShell
            ? definition.Handling.ReloadTime
            : empty
                ? definition.Handling.ReloadEmptyTime
                : definition.Handling.ReloadTime;

        player.Action = WeaponAction.Reloading;
        player.ActionTimer = baseDuration * modifiers.ReloadSpeedMult;
        player.IsAds = false;
        runtime.AmmoInserted = false;
        runtime.ShellReloadActive = shellByShell;
        output.ReloadStarted = true;
    }

    private static void StepReload(
        PlayerState player,
        WeaponState state,
        WeaponDef definition,
        WeaponRuntime runtime,
        InputCommand input,
        WeaponModifiers modifiers,
        WeaponTickResult output)
    {
        var magazineSize = EffectiveMagSize(definition);
        var empty = state.AmmoInMag <= 0;
        var shellByShell = runtime.ShellReloadActive;

        var total = shellByShell
            ? definition.Handling.ReloadTime * modifiers.ReloadSpeedMult
            : (empty ? definition.Handling.ReloadEmptyTime : definition.Handling.ReloadTime) *
              modifiers.ReloadSpeedMult;
        var insertAt = shellByShell
            ? total * 0.6d
            : (empty
                ? definition.Handling.ReloadEmptyAmmoTime
                : definition.Handling.ReloadAmmoTime) * modifiers.ReloadSpeedMult;

        var elapsed = total - player.ActionTimer;
        if (!runtime.AmmoInserted && elapsed >= insertAt)
        {
            runtime.AmmoInserted = true;
            if (shellByShell)
            {
                var take = Math.Min(1, Math.Min(state.AmmoReserve, magazineSize - state.AmmoInMag));
                state.AmmoInMag += take;
                state.AmmoReserve -= take;
            }
            else
            {
                var wanted = magazineSize - state.AmmoInMag;
                var take = Math.Min(wanted, state.AmmoReserve);
                state.AmmoInMag += take;
                state.AmmoReserve -= take;
            }
        }

        if (player.ActionTimer > 0d)
        {
            return;
        }

        if (shellByShell && state.AmmoInMag < magazineSize && state.AmmoReserve > 0)
        {
            var wantsCancel =
                SimulationTypes.HasFlag(input.Buttons, InputFlag.Fire) ||
                SimulationTypes.HasFlag(input.Buttons, InputFlag.Sprint);
            if (!wantsCancel)
            {
                player.ActionTimer = definition.Handling.ReloadTime * modifiers.ReloadSpeedMult;
                runtime.AmmoInserted = false;
                return;
            }
        }

        player.Action = WeaponAction.Ready;
        runtime.ShellReloadActive = false;
        output.ReloadFinished = true;
    }

    private static void HandleSwapRequest(
        PlayerState player,
        InputCommand input,
        WeaponRuntime runtime,
        WeaponDef definition,
        WeaponModifiers modifiers)
    {
        if (!SimulationTypes.HasFlag(input.Buttons, InputFlag.SwapWeapon))
        {
            return;
        }

        if (player.Action is WeaponAction.Swapping or WeaponAction.Melee)
        {
            return;
        }

        var next = player.ActiveSlot == WeaponSlot.Primary
            ? WeaponSlot.Secondary
            : WeaponSlot.Primary;
        if (WeaponAt(player, next) is null)
        {
            return;
        }

        CancelReload(player);
        player.Action = WeaponAction.Swapping;
        player.ActionTimer = definition.Handling.HolsterTime * modifiers.SwapSpeedMult;
        player.IsAds = false;
        player.AdsProgress = 0d;
        runtime.PendingSlot = next;
    }

    private static void StepSwap(
        PlayerState player,
        WeaponRuntime runtime,
        WeaponTickResult output,
        Func<WeaponState, WeaponDef> resolve)
    {
        if (player.ActionTimer > 0d)
        {
            return;
        }

        if (player.ActiveSlot != runtime.PendingSlot)
        {
            player.ActiveSlot = runtime.PendingSlot;
            var next = ActiveWeapon(player);
            if (next is not null)
            {
                player.ActionTimer = resolve(next).Handling.DrawTime;
                return;
            }
        }

        player.Action = WeaponAction.Ready;
        output.SwapFinished = true;
    }

    private static void StartMelee(PlayerState player, WeaponRuntime runtime)
    {
        CancelReload(player);
        player.Action = WeaponAction.Melee;
        player.ActionTimer = MeleeSwingTime;
        player.IsAds = false;
        player.AdsProgress = 0d;
        runtime.MeleeElapsed = 0d;
        runtime.MeleeResolved = false;
    }

    private static void StepMelee(
        PlayerState player,
        WeaponRuntime runtime,
        double deltaTime,
        WeaponTickResult output)
    {
        runtime.MeleeElapsed += deltaTime;
        if (!runtime.MeleeResolved && runtime.MeleeElapsed >= MeleeHitTime)
        {
            runtime.MeleeResolved = true;
            output.MeleeSwing = true;
        }

        if (player.ActionTimer <= 0d)
        {
            player.Action = WeaponAction.Ready;
        }
    }

    private static int EffectiveMagSize(WeaponDef definition) => Math.Max(1, definition.MagSize);

    private static bool CanFire(
        PlayerState player,
        WeaponState state,
        WeaponDef definition,
        double worldTime,
        WeaponModifiers modifiers,
        WeaponRuntime runtime)
    {
        if (modifiers.FireBlocked || player.Action != WeaponAction.Ready ||
            Movement.IsMovementLocked(player))
        {
            return false;
        }

        if (player.MoveState is MoveState.Sprint or MoveState.TacticalSprint)
        {
            return false;
        }

        if (player.SprintOutTime > 0d || worldTime < state.NextFireTime)
        {
            return false;
        }

        if (definition.FireMode == FireMode.Burst &&
            runtime.BurstCooldown > 0d && runtime.BurstFired == 0)
        {
            return false;
        }

        return true;
    }

    private static void Fire(
        PlayerState player,
        WeaponState state,
        WeaponDef definition,
        double worldTime,
        Rng rng,
        WeaponRuntime runtime,
        WeaponModifiers modifiers,
        WeaponTickResult output)
    {
        var triggerDown = player.TriggerHeld;
        _ = triggerDown;
        var wantsFire = ShouldFireThisTick(player, definition, runtime);
        if (!wantsFire)
        {
            runtime.BurstFired = 0;
            return;
        }

        if (state.AmmoInMag <= 0)
        {
            output.DryFire = true;
            return;
        }

        var interval = WeaponMath.FireInterval(definition);
        output.ShotIndexBase = state.ShotsInBurst;

        var shots = 0;
        var maxShotsPerTick = Math.Max(
            1,
            (int)Math.Ceiling(GameConstants.TickDt / Math.Max(interval, 1e-4d)) + 1);

        while (shots < maxShotsPerTick && state.AmmoInMag > 0 && worldTime >= state.NextFireTime)
        {
            state.AmmoInMag--;
            shots++;

            Combat.ComputeRecoil(definition, state.ShotsInBurst, rng, Recoil);
            state.RecoilPitch += Recoil.Pitch;
            state.RecoilYaw += Recoil.Yaw;
            output.RecoilPitch += Recoil.Pitch;
            output.RecoilYaw += Recoil.Yaw;

            state.ShotsInBurst++;
            state.Spread = Math.Min(
                definition.Spread.HipMax,
                state.Spread + definition.Spread.PerShot);
            state.Heat = Math.Min(1d, state.Heat + 0.06d);

            state.NextFireTime = Math.Max(
                state.NextFireTime + interval,
                worldTime + interval * 0.5d);

            if (definition.FireMode == FireMode.Burst)
            {
                runtime.BurstFired++;
                if (runtime.BurstFired >= definition.BurstCount)
                {
                    runtime.BurstFired = 0;
                    runtime.BurstCooldown = definition.BurstDelay;
                    state.NextFireTime = worldTime + definition.BurstDelay;
                    break;
                }
            }

            if (definition.FireMode is FireMode.Semi or FireMode.BoltAction)
            {
                break;
            }
        }

        if (shots == 0)
        {
            return;
        }

        output.ShotsFired = shots;
        output.PelletsPerShot = Math.Max(1, definition.Pellets);
        output.Spread = Math.Max(
            Combat.ComputeSpread(
                definition,
                player,
                state.ShotsInBurst,
                Movement.HorizontalSpeed(player)) *
            (player.AdsProgress > 0.9d ? 1d : modifiers.HipSpreadMult),
            0d);

        if (definition.FireMode == FireMode.BoltAction &&
            definition.Traits.Contains(WeaponTrait.Rechamber))
        {
            state.NextFireTime = worldTime + interval;
        }
    }

    private static bool ShouldFireThisTick(
        PlayerState player,
        WeaponDef definition,
        WeaponRuntime runtime)
    {
        var down = player.TriggerHeld;
        return definition.FireMode switch
        {
            FireMode.Auto => down,
            FireMode.Semi or FireMode.BoltAction => down && !runtime.TriggerWasDown,
            FireMode.Burst => runtime.BurstFired > 0 || down && !runtime.TriggerWasDown,
            FireMode.Swing => false,
            _ => false,
        };
    }

    private static WeaponState? WeaponAt(PlayerState player, WeaponSlot slot)
    {
        var index = (int)slot;
        return index >= 0 && index < player.Weapons.Count ? player.Weapons[index] : null;
    }
}
