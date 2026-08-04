/**
 * The weapon state machine: firing, reloading, swapping, aiming.
 *
 * This is where "gunfeel" is decided. The rules that matter:
 *
 * - **Every action has a duration and can be interrupted only where COD allows
 *   it.** Reload cancelling by sprinting or swapping is deliberate tech and is
 *   preserved; cancelling by ADS is not.
 * - **Firing is gated by a timestamp, not a countdown.** `nextFireTime` is
 *   compared against world time so the rate of fire is exact regardless of tick
 *   alignment; a countdown would quantise RPM to the tick rate and make a
 *   900-RPM gun and an 850-RPM gun behave identically.
 * - **The first shot out of a sprint is delayed.** Sprint-out time is the main
 *   balancing lever against permanently-sprinting players.
 */

import { TICK_DT } from '../constants.js';
import { clamp01, damp, moveTowards } from '../math.js';
import type { Rng } from '../rng.js';
import {
  InputFlag,
  MoveState,
  WeaponAction,
  WeaponSlot,
  hasFlag,
  type InputCommand,
  type PlayerState,
  type WeaponState,
} from '../types.js';
import {
  FireMode,
  WeaponClass,
  WeaponTrait,
  fireInterval,
  type WeaponDef,
} from '../data/weapon-types.js';
import { computeRecoil, computeSpread } from './combat.js';
import { horizontalSpeed, isMovementLocked } from './movement.js';

/** Resolved per-tick modifiers from perks and field upgrades. */
export interface WeaponModifiers {
  reloadSpeedMult: number;
  adsSpeedMult: number;
  swapSpeedMult: number;
  sprintOutMult: number;
  /** Steady-aim style bonus applied to hipfire spread. */
  hipSpreadMult: number;
  /** True while the player is in a state that forbids firing entirely. */
  fireBlocked: boolean;
}

export const DEFAULT_WEAPON_MODIFIERS: WeaponModifiers = {
  reloadSpeedMult: 1,
  adsSpeedMult: 1,
  swapSpeedMult: 1,
  sprintOutMult: 1,
  hipSpreadMult: 1,
  fireBlocked: false,
};

/** What the weapon system wants the caller to do this tick. */
export interface WeaponTickResult {
  /** Number of rounds that left the barrel this tick (0, 1, or more for shotguns). */
  shotsFired: number;
  /** Pellets per shot for the caller to trace. */
  pelletsPerShot: number;
  /** Recoil to add to the player's view this tick. */
  recoilPitch: number;
  recoilYaw: number;
  /** Spread cone half-angle to use for this tick's shots. */
  spread: number;
  /** True on the tick a reload completed. */
  reloadFinished: boolean;
  /** True on the tick a reload started. */
  reloadStarted: boolean;
  /** True on the tick a weapon swap completed. */
  swapFinished: boolean;
  /** True on the tick the player swung melee. */
  meleeSwing: boolean;
  /** True when the trigger was pulled but the magazine was empty. */
  dryFire: boolean;
  /** Index of the first shot in this tick within the current trigger pull. */
  shotIndexBase: number;
}

const _result: WeaponTickResult = {
  shotsFired: 0,
  pelletsPerShot: 1,
  recoilPitch: 0,
  recoilYaw: 0,
  spread: 0,
  reloadFinished: false,
  reloadStarted: false,
  swapFinished: false,
  meleeSwing: false,
  dryFire: false,
  shotIndexBase: 0,
};

const _recoil = { pitch: 0, yaw: 0 };

/** Melee swing duration — long enough to be a commitment, short enough to use. */
const MELEE_SWING_TIME = 0.55;
const MELEE_HIT_TIME = 0.18;

/** Per-player transient flags the state machine needs but that don't belong on the wire. */
interface WeaponRuntime {
  /** Slot we are swapping to, once the holster completes. */
  pendingSlot: WeaponSlot;
  /** True once the current reload has already inserted ammo. */
  ammoInserted: boolean;
  /** For shell-by-shell reloads: whether another shell is queued. */
  shellReloadActive: boolean;
  /** Time within the current melee swing. */
  meleeElapsed: number;
  /** Whether the melee hit has already been resolved this swing. */
  meleeResolved: boolean;
  /** Whether the trigger was down last tick, for semi-auto edge detection. */
  triggerWasDown: boolean;
  /** Rounds fired in the current burst. */
  burstFired: number;
  /** Time until the next burst may begin. */
  burstCooldown: number;
}

const runtimes = new Map<number, WeaponRuntime>();

function runtimeFor(playerId: number): WeaponRuntime {
  let rt = runtimes.get(playerId);
  if (!rt) {
    rt = {
      pendingSlot: WeaponSlot.Primary,
      ammoInserted: false,
      shellReloadActive: false,
      meleeElapsed: 0,
      meleeResolved: false,
      triggerWasDown: false,
      burstFired: 0,
      burstCooldown: 0,
    };
    runtimes.set(playerId, rt);
  }
  return rt;
}

export function resetWeaponRuntime(playerId: number): void {
  runtimes.delete(playerId);
}

/** The weapon a player is currently holding, or undefined if they have none. */
export function activeWeapon(player: PlayerState): WeaponState | undefined {
  return player.weapons[player.activeSlot];
}

// ---------------------------------------------------------------------------
// Main tick
// ---------------------------------------------------------------------------

export function stepWeapon(
  player: PlayerState,
  input: InputCommand,
  worldTime: number,
  dt: number,
  rng: Rng,
  resolve: (state: WeaponState) => WeaponDef,
  mods: WeaponModifiers = DEFAULT_WEAPON_MODIFIERS,
): WeaponTickResult {
  _result.shotsFired = 0;
  _result.pelletsPerShot = 1;
  _result.recoilPitch = 0;
  _result.recoilYaw = 0;
  _result.spread = 0;
  _result.reloadFinished = false;
  _result.reloadStarted = false;
  _result.swapFinished = false;
  _result.meleeSwing = false;
  _result.dryFire = false;
  _result.shotIndexBase = 0;

  if (!player.alive) return _result;

  const rt = runtimeFor(player.id);
  const state = activeWeapon(player);
  if (!state) return _result;
  const def = resolve(state);

  rt.burstCooldown = Math.max(0, rt.burstCooldown - dt);

  handleSprintOut(player, def, mods, dt);
  updateAds(player, input, def, mods, dt);
  decayRecoilAndSpread(player, state, def, dt);

  // Actions are mutually exclusive and advance on their own timers.
  if (player.actionTimer > 0) {
    player.actionTimer = Math.max(0, player.actionTimer - dt);
  }

  switch (player.action) {
    case WeaponAction.Reloading:
      stepReload(player, state, def, rt, input, mods, _result);
      break;
    case WeaponAction.Swapping:
      stepSwap(player, rt, _result, resolve);
      break;
    case WeaponAction.Melee:
      stepMelee(player, rt, dt, _result);
      break;
    default:
      break;
  }

  // Melee interrupts almost everything — it is the panic button.
  if (
    hasFlag(input.buttons, InputFlag.Melee) &&
    player.action !== WeaponAction.Melee &&
    !isMovementLocked(player)
  ) {
    startMelee(player, rt);
  }

  handleSwapRequest(player, input, rt, def, mods);
  handleReloadRequest(player, state, def, input, rt, mods, _result);

  if (canFire(player, state, def, worldTime, mods, rt)) {
    fire(player, state, def, worldTime, rng, rt, mods, _result);
  }

  // Latch the trigger edge unconditionally, at the end of the tick.
  //
  // Doing this inside the firing branches leaves paths that never latch — most
  // damagingly, releasing the trigger while the weapon is Ready falls straight
  // through `fire()`'s early return, so `triggerWasDown` stays true forever and
  // every semi-automatic and bolt-action weapon fires exactly once per life.
  rt.triggerWasDown = player.triggerHeld;

  return _result;
}

// ---------------------------------------------------------------------------
// Sprint-out
// ---------------------------------------------------------------------------

function handleSprintOut(
  player: PlayerState,
  def: WeaponDef,
  mods: WeaponModifiers,
  dt: number,
): void {
  const duration = def.handling.sprintOutTime * mods.sprintOutMult;

  if (player.sprintOutPending) {
    player.sprintOutPending = false;
    player.sprintOutTime = duration;
  }

  // While actually sprinting the weapon is down, so the timer is held at full;
  // it only starts running once the player stops.
  if (player.moveState === MoveState.Sprint || player.moveState === MoveState.TacticalSprint) {
    player.sprintOutTime = duration;
  } else {
    player.sprintOutTime = Math.max(0, player.sprintOutTime - dt);
  }
}

// ---------------------------------------------------------------------------
// ADS
// ---------------------------------------------------------------------------

function updateAds(
  player: PlayerState,
  input: InputCommand,
  def: WeaponDef,
  mods: WeaponModifiers,
  dt: number,
): void {
  const wantsAds =
    hasFlag(input.buttons, InputFlag.Ads) &&
    player.moveState !== MoveState.Sprint &&
    player.moveState !== MoveState.TacticalSprint &&
    player.moveState !== MoveState.Slide &&
    player.action !== WeaponAction.Swapping &&
    player.action !== WeaponAction.Melee &&
    !isMovementLocked(player);

  player.isAds = wantsAds;

  const adsTime = Math.max(0.02, def.handling.adsTime * mods.adsSpeedMult);
  // Coming out of ADS is faster than going in — matches COD and keeps
  // strafe-peeking responsive.
  const rate = wantsAds ? 1 / adsTime : 1 / (adsTime * 0.72);
  player.adsProgress = moveTowards(player.adsProgress, wantsAds ? 1 : 0, rate * dt);
  player.adsProgress = clamp01(player.adsProgress);
}

// ---------------------------------------------------------------------------
// Recoil and spread decay
// ---------------------------------------------------------------------------

function decayRecoilAndSpread(
  player: PlayerState,
  state: WeaponState,
  def: WeaponDef,
  dt: number,
): void {
  const r = def.recoil;
  // Recoil recovers toward zero. `recoveryFraction` below 1 leaves residual kick
  // the player must pull down themselves, which is the skill in recoil control.
  const target = 0;
  const decay = r.recoverySpeed * dt;
  state.recoilPitch = damp(state.recoilPitch, target, r.recoverySpeed, dt);
  state.recoilYaw = damp(state.recoilYaw, target, r.recoverySpeed, dt);
  void decay;

  state.spread = Math.max(0, state.spread - def.spread.recovery * dt);

  // Burst counter resets once the player has stopped shooting long enough for
  // the recoil pattern to have visibly recovered.
  if (!player.triggerHeld && Math.abs(state.recoilPitch) < 0.0015) {
    state.shotsInBurst = 0;
  }

  state.heat = Math.max(0, state.heat - dt * 0.35);
}

// ---------------------------------------------------------------------------
// Reload
// ---------------------------------------------------------------------------

function handleReloadRequest(
  player: PlayerState,
  state: WeaponState,
  def: WeaponDef,
  input: InputCommand,
  rt: WeaponRuntime,
  mods: WeaponModifiers,
  out: WeaponTickResult,
): void {
  if (player.action === WeaponAction.Reloading) return;
  if (player.action === WeaponAction.Swapping || player.action === WeaponAction.Melee) return;
  if (state.ammoReserve <= 0 || state.ammoInMag >= effectiveMagSize(def)) return;

  const manual = hasFlag(input.buttons, InputFlag.Reload);
  // Auto-reload on empty is the modern convention and removes a pure-annoyance
  // failure mode without changing balance.
  const auto = state.ammoInMag <= 0 && player.triggerHeld;

  if (!manual && !auto) return;

  startReload(player, state, def, rt, mods, out);
}

function startReload(
  player: PlayerState,
  state: WeaponState,
  def: WeaponDef,
  rt: WeaponRuntime,
  mods: WeaponModifiers,
  out: WeaponTickResult,
): void {
  const empty = state.ammoInMag <= 0;
  const shellByShell = def.traits.includes(WeaponTrait.ShellReload);

  const base = shellByShell
    ? def.handling.reloadTime
    : empty
      ? def.handling.reloadEmptyTime
      : def.handling.reloadTime;

  player.action = WeaponAction.Reloading;
  player.actionTimer = base * mods.reloadSpeedMult;
  player.isAds = false;
  rt.ammoInserted = false;
  rt.shellReloadActive = shellByShell;
  out.reloadStarted = true;
}

function stepReload(
  player: PlayerState,
  state: WeaponState,
  def: WeaponDef,
  rt: WeaponRuntime,
  input: InputCommand,
  mods: WeaponModifiers,
  out: WeaponTickResult,
): void {
  const magSize = effectiveMagSize(def);
  const empty = state.ammoInMag <= 0;
  const shellByShell = rt.shellReloadActive;

  const total = shellByShell
    ? def.handling.reloadTime * mods.reloadSpeedMult
    : (empty ? def.handling.reloadEmptyTime : def.handling.reloadTime) * mods.reloadSpeedMult;
  const insertAt = shellByShell
    ? total * 0.6
    : (empty ? def.handling.reloadEmptyAmmoTime : def.handling.reloadAmmoTime) *
      mods.reloadSpeedMult;

  const elapsed = total - player.actionTimer;

  // Ammo lands partway through, which is what makes reload cancelling work:
  // cancel after this point and you keep the rounds.
  if (!rt.ammoInserted && elapsed >= insertAt) {
    rt.ammoInserted = true;
    if (shellByShell) {
      const take = Math.min(1, state.ammoReserve, magSize - state.ammoInMag);
      state.ammoInMag += take;
      state.ammoReserve -= take;
    } else {
      const want = magSize - state.ammoInMag;
      const take = Math.min(want, state.ammoReserve);
      state.ammoInMag += take;
      state.ammoReserve -= take;
    }
  }

  if (player.actionTimer > 0) return;

  if (shellByShell && state.ammoInMag < magSize && state.ammoReserve > 0) {
    // Another shell, unless the player cancels by firing or sprinting.
    const wantsCancel =
      hasFlag(input.buttons, InputFlag.Fire) || hasFlag(input.buttons, InputFlag.Sprint);
    if (!wantsCancel) {
      player.actionTimer = def.handling.reloadTime * mods.reloadSpeedMult;
      rt.ammoInserted = false;
      return;
    }
  }

  player.action = WeaponAction.Ready;
  rt.shellReloadActive = false;
  out.reloadFinished = true;
}

/** Cancel a reload without refunding time. Called on sprint and on swap. */
export function cancelReload(player: PlayerState): void {
  if (player.action !== WeaponAction.Reloading) return;
  player.action = WeaponAction.Ready;
  player.actionTimer = 0;
  const rt = runtimes.get(player.id);
  if (rt) rt.shellReloadActive = false;
}

// ---------------------------------------------------------------------------
// Weapon swap
// ---------------------------------------------------------------------------

function handleSwapRequest(
  player: PlayerState,
  input: InputCommand,
  rt: WeaponRuntime,
  def: WeaponDef,
  mods: WeaponModifiers,
): void {
  if (!hasFlag(input.buttons, InputFlag.SwapWeapon)) return;
  if (player.action === WeaponAction.Swapping || player.action === WeaponAction.Melee) return;

  const next = player.activeSlot === WeaponSlot.Primary ? WeaponSlot.Secondary : WeaponSlot.Primary;
  if (!player.weapons[next]) return;

  // Swapping out of a reload is the fastest way to cancel it — preserved tech.
  cancelReload(player);

  player.action = WeaponAction.Swapping;
  player.actionTimer = def.handling.holsterTime * mods.swapSpeedMult;
  player.isAds = false;
  player.adsProgress = 0;
  rt.pendingSlot = next;
}

function stepSwap(
  player: PlayerState,
  rt: WeaponRuntime,
  out: WeaponTickResult,
  resolve: (state: WeaponState) => WeaponDef,
): void {
  if (player.actionTimer > 0) return;

  if (player.activeSlot !== rt.pendingSlot) {
    // Holster finished — switch and start the draw.
    player.activeSlot = rt.pendingSlot;
    const next = activeWeapon(player);
    if (next) {
      player.actionTimer = resolve(next).handling.drawTime;
      return;
    }
  }

  player.action = WeaponAction.Ready;
  out.swapFinished = true;
}

/** Force a swap to a specific slot, used by killstreaks and Gun Game. */
export function forceSwap(player: PlayerState, slot: WeaponSlot): void {
  if (!player.weapons[slot]) return;
  const rt = runtimeFor(player.id);
  cancelReload(player);
  player.activeSlot = slot;
  rt.pendingSlot = slot;
  player.action = WeaponAction.Ready;
  player.actionTimer = 0;
  player.adsProgress = 0;
  player.isAds = false;
}

// ---------------------------------------------------------------------------
// Melee
// ---------------------------------------------------------------------------

function startMelee(player: PlayerState, rt: WeaponRuntime): void {
  cancelReload(player);
  player.action = WeaponAction.Melee;
  player.actionTimer = MELEE_SWING_TIME;
  player.isAds = false;
  player.adsProgress = 0;
  rt.meleeElapsed = 0;
  rt.meleeResolved = false;
}

function stepMelee(
  player: PlayerState,
  rt: WeaponRuntime,
  dt: number,
  out: WeaponTickResult,
): void {
  rt.meleeElapsed += dt;

  // The hit lands partway through the swing, not at the start or the end.
  if (!rt.meleeResolved && rt.meleeElapsed >= MELEE_HIT_TIME) {
    rt.meleeResolved = true;
    out.meleeSwing = true;
  }

  if (player.actionTimer <= 0) {
    player.action = WeaponAction.Ready;
  }
}

// ---------------------------------------------------------------------------
// Firing
// ---------------------------------------------------------------------------

function effectiveMagSize(def: WeaponDef): number {
  return Math.max(1, def.magSize);
}

function canFire(
  player: PlayerState,
  state: WeaponState,
  def: WeaponDef,
  worldTime: number,
  mods: WeaponModifiers,
  rt: WeaponRuntime,
): boolean {
  if (mods.fireBlocked) return false;
  if (player.action !== WeaponAction.Ready) return false;
  if (isMovementLocked(player)) return false;
  if (player.moveState === MoveState.Sprint || player.moveState === MoveState.TacticalSprint) {
    return false;
  }
  if (player.sprintOutTime > 0) return false;
  if (worldTime < state.nextFireTime) return false;
  if (def.fireMode === FireMode.Burst && rt.burstCooldown > 0 && rt.burstFired === 0) return false;
  return true;
}

function fire(
  player: PlayerState,
  state: WeaponState,
  def: WeaponDef,
  worldTime: number,
  rng: Rng,
  rt: WeaponRuntime,
  mods: WeaponModifiers,
  out: WeaponTickResult,
): void {
  const triggerDown = player.triggerHeld;
  void triggerDown;
  const wantsFire = shouldFireThisTick(player, def, rt);

  if (!wantsFire) {
    rt.burstFired = 0;
    return;
  }

  if (state.ammoInMag <= 0) {
    out.dryFire = true;
    return;
  }

  const interval = fireInterval(def);
  out.shotIndexBase = state.shotsInBurst;

  // Catch up if more than one shot's worth of time has elapsed, so a high-RPM
  // weapon isn't rate-limited by the tick rate.
  let shots = 0;
  const maxShotsPerTick = Math.max(1, Math.ceil(TICK_DT / Math.max(interval, 1e-4)) + 1);

  while (shots < maxShotsPerTick && state.ammoInMag > 0 && worldTime >= state.nextFireTime) {
    state.ammoInMag--;
    shots++;

    computeRecoil(def, state.shotsInBurst, rng, _recoil);
    state.recoilPitch += _recoil.pitch;
    state.recoilYaw += _recoil.yaw;
    out.recoilPitch += _recoil.pitch;
    out.recoilYaw += _recoil.yaw;

    state.shotsInBurst++;
    state.spread = Math.min(
      def.spread.hipMax,
      state.spread + def.spread.perShot,
    );
    state.heat = Math.min(1, state.heat + 0.06);

    state.nextFireTime = Math.max(state.nextFireTime + interval, worldTime + interval * 0.5);

    if (def.fireMode === FireMode.Burst) {
      rt.burstFired++;
      if (rt.burstFired >= def.burstCount) {
        rt.burstFired = 0;
        rt.burstCooldown = def.burstDelay;
        state.nextFireTime = worldTime + def.burstDelay;
        break;
      }
    }

    if (def.fireMode === FireMode.Semi || def.fireMode === FireMode.BoltAction) {
      break;
    }
  }

  if (shots === 0) return;

  out.shotsFired = shots;
  out.pelletsPerShot = Math.max(1, def.pellets);
  out.spread = Math.max(
    computeSpread(def, player, state.shotsInBurst, horizontalSpeed(player)) *
      (player.adsProgress > 0.9 ? 1 : mods.hipSpreadMult),
    0,
  );

  // Bolt-actions rechamber: block firing and force a brief animation lockout.
  if (def.fireMode === FireMode.BoltAction && def.traits.includes(WeaponTrait.Rechamber)) {
    state.nextFireTime = worldTime + interval;
  }
}

/**
 * Semi-auto and burst weapons fire on the trigger's rising edge; automatics fire
 * while it is held. Getting this wrong is the difference between a pistol that
 * feels crisp and one that feels broken.
 */
function shouldFireThisTick(player: PlayerState, def: WeaponDef, rt: WeaponRuntime): boolean {
  const down = player.triggerHeld;

  switch (def.fireMode) {
    case FireMode.Auto:
      return down;
    case FireMode.Semi:
    case FireMode.BoltAction:
      return down && !rt.triggerWasDown;
    case FireMode.Burst:
      // Mid-burst the weapon keeps firing regardless of the trigger.
      if (rt.burstFired > 0) return true;
      return down && !rt.triggerWasDown;
    case FireMode.Swing:
      return false;
    default:
      return false;
  }
}

/** Called by the sim before stepWeapon so the trigger edge is correct. */
export function setTrigger(player: PlayerState, input: InputCommand): void {
  player.triggerHeld = hasFlag(input.buttons, InputFlag.Fire);
}

// ---------------------------------------------------------------------------
// Ammo
// ---------------------------------------------------------------------------

/** Refill a weapon from an ammo box or the Scavenger perk. */
export function resupply(state: WeaponState, def: WeaponDef, magazines: number): void {
  const magSize = effectiveMagSize(def);
  state.ammoReserve = Math.min(def.maxReserve, state.ammoReserve + magSize * magazines);
}

/** Total rounds a player is carrying for a weapon, for the HUD. */
export function totalAmmo(state: WeaponState): number {
  return state.ammoInMag + state.ammoReserve;
}

/**
 * FOV multiplier for the current ADS state. Scoped weapons swap to an overlay
 * instead, so their viewmodel zoom is capped to avoid a jarring double-zoom.
 */
export function adsFovScale(def: WeaponDef, adsProgress: number): number {
  const zoom = def.scoped ? Math.min(def.adsZoom, 1.6) : def.adsZoom;
  return 1 / (1 + (zoom - 1) * adsProgress);
}

/** True when the player should see a scope overlay rather than the viewmodel. */
export function showScopeOverlay(def: WeaponDef, adsProgress: number): boolean {
  return def.scoped && adsProgress > 0.82;
}

/** Weapons that hide the player from the minimap when fired. */
export function isSuppressed(def: WeaponDef): boolean {
  return def.audio.suppressed || def.traits.includes(WeaponTrait.AlwaysSuppressed);
}

/** Movement penalty from the equipped weapon, folded into MovementModifiers. */
export function weaponSpeedMultiplier(def: WeaponDef): number {
  return def.handling.movementSpeedMultiplier;
}

/** Whether a weapon class may sprint-slide (riot shields cannot). */
export function allowsSlide(def: WeaponDef): boolean {
  return def.class !== WeaponClass.Melee || def.id !== 'riot_shield';
}
