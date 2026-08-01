/**
 * Character movement.
 *
 * This is the file that decides whether the game feels like Call of Duty or like
 * a physics demo. The design goals, in priority order:
 *
 *   1. Instant response. Input-to-motion latency of one tick, no acceleration
 *      ramp you can perceive. COD players expect to stop dead when they release
 *      the stick, so ground friction is enormous.
 *   2. Predictable. Every branch here is deterministic and depends only on the
 *      player state plus the input command, because the client predicts this and
 *      the server replays it. A single divergent branch produces rubber-banding.
 *   3. Expressive. Slide-cancelling, mantling, tactical sprint and jump-shotting
 *      are the movement skill ceiling; they all live here.
 *
 * The controller is a *stateless function* over (player, input, world) so it can
 * be replayed any number of times during reconciliation.
 */

import {
  MOVE,
  SLIDE,
  MANTLE,
  LEAN,
  PLAYER_RADIUS,
  STANCE_HEIGHT,
  STANCE_TRANSITION,
  EYE_HEIGHT,
} from '../constants.js';
import {
  clamp,
  clamp01,
  damp,
  moveTowards,
  v3add,
  v3addScaled,
  v3copy,
  v3dot,
  v3length,
  v3lengthSq,
  v3normalize,
  v3projectOnPlane,
  v3scale,
  v3set,
  v3sub,
  vec3,
  anglesToForwardFlat,
  anglesToRight,
  lerp,
  type Vec3,
} from '../math.js';
import {
  InputFlag,
  MoveState,
  Stance,
  hasFlag,
  type InputCommand,
  type PlayerState,
} from '../types.js';
import {
  CollisionLayer,
  createSweepHit,
  type CollisionWorld,
  type QueryFilter,
  type SweepHit,
} from '../collision/collision-types.js';

// Scratch state. Movement runs on one player at a time within a tick, so module
// scope is safe here and saves thousands of allocations per second.
const _wishDir = vec3();
const _forward = vec3();
const _right = vec3();
const _delta = vec3();
const _remaining = vec3();
const _planeNormal = vec3();
const _probeStart = vec3();
const _probeDelta = vec3();
const _tmp = vec3();
const _sweep: SweepHit = createSweepHit();
const _sweep2: SweepHit = createSweepHit();
const _stepUp: SweepHit = createSweepHit();

const MOVEMENT_FILTER: QueryFilter = { layers: CollisionLayer.Movement };

/** Per-tick modifiers a caller folds in from perks, weapon weight and status effects. */
export interface MovementModifiers {
  /** Multiplier on top speed from perks and the equipped weapon. */
  speedMultiplier: number;
  /** Multiplier while aiming down sights. */
  adsSpeedMultiplier: number;
  /** 0..1 — how far into the ADS transition the player is. */
  adsProgress: number;
  /** True when the player may not sprint (reloading a launcher, riot shield up, etc). */
  sprintBlocked: boolean;
  /** True when the player cannot slide (already mantling, in a scripted sequence). */
  slideBlocked: boolean;
  /** Concussion and stun slow the player. */
  slowMultiplier: number;
  /** Perk that removes fall damage. */
  fallDamageImmune: boolean;
}

export const DEFAULT_MODIFIERS: MovementModifiers = {
  speedMultiplier: 1,
  adsSpeedMultiplier: 1,
  adsProgress: 0,
  sprintBlocked: false,
  slideBlocked: false,
  slowMultiplier: 1,
  fallDamageImmune: false,
};

/** Everything the caller needs to know about what happened this tick. */
export interface MovementResult {
  /** True on the tick the player left the ground under their own power. */
  jumped: boolean;
  /** True on the tick the player touched down. */
  landed: boolean;
  /** Fall damage to apply, 0 if none. */
  fallDamage: number;
  /** True on the tick a slide began. */
  startedSlide: boolean;
  /** True on the tick a mantle began. */
  startedMantle: boolean;
  /** Distance travelled this tick, used to drive the footstep cadence. */
  distanceMoved: number;
  /** True if a footstep should be emitted this tick. */
  footstep: boolean;
  /** Whether the footstep is loud enough for enemies to hear. */
  footstepLoud: boolean;
}

const _result: MovementResult = {
  jumped: false,
  landed: false,
  fallDamage: 0,
  startedSlide: false,
  startedMantle: false,
  distanceMoved: 0,
  footstep: false,
  footstepLoud: false,
};

// Footstep cadence is distance-based rather than time-based so it stays in sync
// with the animation at any speed.
const FOOTSTEP_STRIDE = {
  walk: 2.05,
  sprint: 2.45,
  crouch: 2.4,
  prone: 3.2,
} as const;

/** Accumulated stride distance, keyed by player. Cleared on death/respawn. */
const strideAccumulator = new Map<number, number>();

export function resetStride(playerId: number): void {
  strideAccumulator.delete(playerId);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Current collision height for a player, accounting for the stance transition. */
export function currentHeight(player: PlayerState): number {
  const target = stanceHeight(player.stance);
  // stanceProgress runs 0..1 from the previous stance to the current one.
  if (player.stanceProgress >= 1) return target;
  const from = stanceHeight(player.previousStance ?? player.stance);
  return lerp(from, target, player.stanceProgress);
}

/** Current eye height above the feet, used by the camera and by every trace origin. */
export function currentEyeHeight(player: PlayerState): number {
  const target = eyeHeight(player.stance);
  if (player.stanceProgress >= 1) return target;
  const from = eyeHeight(player.previousStance ?? player.stance);
  return lerp(from, target, player.stanceProgress);
}

/** Eye position in world space — the origin of every shot the player fires. */
export function eyePosition(out: Vec3, player: PlayerState): Vec3 {
  out.x = player.position.x;
  out.y = player.position.y + currentEyeHeight(player);
  out.z = player.position.z;

  // Leaning shifts the eye laterally, which is the whole point of leaning.
  if (player.lean !== 0) {
    anglesToRight(_tmp, player.yaw);
    out.x += _tmp.x * player.lean * LEAN.maxOffset;
    out.z += _tmp.z * player.lean * LEAN.maxOffset;
  }
  return out;
}

export function stanceHeight(stance: Stance): number {
  switch (stance) {
    case Stance.Crouch:
      return STANCE_HEIGHT.crouch;
    case Stance.Prone:
      return STANCE_HEIGHT.prone;
    default:
      return STANCE_HEIGHT.stand;
  }
}

export function eyeHeight(stance: Stance): number {
  switch (stance) {
    case Stance.Crouch:
      return EYE_HEIGHT.crouch;
    case Stance.Prone:
      return EYE_HEIGHT.prone;
    default:
      return EYE_HEIGHT.stand;
  }
}

/**
 * Advance one player by one tick.
 *
 * Mutates `player` in place and returns a description of the notable things that
 * happened, which the caller turns into events (footsteps, landing thumps, fall
 * damage). Returning a shared object is deliberate — the caller must consume it
 * before the next call.
 */
export function stepMovement(
  player: PlayerState,
  input: InputCommand,
  world: CollisionWorld,
  dt: number,
  mods: MovementModifiers = DEFAULT_MODIFIERS,
): MovementResult {
  _result.jumped = false;
  _result.landed = false;
  _result.fallDamage = 0;
  _result.startedSlide = false;
  _result.startedMantle = false;
  _result.distanceMoved = 0;
  _result.footstep = false;
  _result.footstepLoud = false;

  if (!player.alive) {
    // Dead players still fall, so the corpse settles instead of hovering.
    applyGravityOnly(player, world, dt);
    return _result;
  }

  applyViewAngles(player, input);

  // A mantle is a scripted animation: it owns the transform until it finishes.
  if (player.mantleTime > 0) {
    stepMantle(player, dt);
    return _result;
  }

  tickTimers(player, dt);
  updateStance(player, input, world, dt);
  updateLean(player, input, dt);

  const wasOnGround = player.onGround;
  const filter = MOVEMENT_FILTER;

  buildWishDirection(player, input, _wishDir);

  updateSprint(player, input, mods);
  updateSlide(player, input, world, dt, mods);

  if (player.moveState === MoveState.Slide) {
    applySlideFriction(player, dt);
  } else if (player.onGround) {
    applyGroundMovement(player, input, dt, mods);
  } else {
    applyAirMovement(player, dt);
  }

  const jumped = tryJump(player, input, world, dt);
  if (jumped) _result.jumped = true;

  applyGravity(player, dt);

  const startY = player.position.y;
  const preMoveX = player.position.x;
  const preMoveZ = player.position.z;

  moveWithCollision(player, world, filter, dt);

  // Ground detection after the move so state reflects where we actually ended up.
  const wasAirborne = !wasOnGround;
  updateGrounded(player, world, filter, dt);

  if (wasAirborne && player.onGround) {
    _result.landed = true;
    const fallDistance = player.fallPeakY - player.position.y;
    if (!mods.fallDamageImmune && fallDistance > MOVE.safeFallHeight) {
      const t = clamp01(
        (fallDistance - MOVE.safeFallHeight) / (MOVE.lethalFallHeight - MOVE.safeFallHeight),
      );
      _result.fallDamage = t * MOVE.maxFallDamage;
    }
    player.fallPeakY = player.position.y;
  }

  if (!player.onGround) {
    player.fallPeakY = Math.max(player.fallPeakY, player.position.y);
  } else {
    player.fallPeakY = player.position.y;
  }

  if (!tryMantle(player, input, world, filter)) {
    // No mantle: fine, most ticks don't have one.
  } else {
    _result.startedMantle = true;
  }

  const dx = player.position.x - preMoveX;
  const dz = player.position.z - preMoveZ;
  const dyAbs = Math.abs(player.position.y - startY);
  _result.distanceMoved = Math.sqrt(dx * dx + dz * dz + dyAbs * dyAbs * 0.25);

  updateMoveState(player);
  updateFootsteps(player, _result);

  return _result;
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

function applyViewAngles(player: PlayerState, input: InputCommand): void {
  // The client is authoritative over its own aim — the server accepts the angles
  // rather than integrating mouse deltas, because any disagreement in angle
  // integration would make every shot mispredict. Anti-cheat validates the rate
  // of change separately rather than clamping here.
  player.yaw = input.yaw;
  player.pitch = clamp(input.pitch, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
}

// ---------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------

function tickTimers(player: PlayerState, dt: number): void {
  player.slideCooldown = Math.max(0, player.slideCooldown - dt);
  player.jumpCooldown = Math.max(0, player.jumpCooldown - dt);
  player.groundLockout = Math.max(0, player.groundLockout - dt);
  player.tacSprintCooldown = Math.max(0, player.tacSprintCooldown - dt);
  player.sprintOutTime = Math.max(0, player.sprintOutTime - dt);

  if (player.onGround) {
    player.airTime = 0;
  } else {
    player.airTime += dt;
  }
}

// ---------------------------------------------------------------------------
// Stance
// ---------------------------------------------------------------------------

function updateStance(
  player: PlayerState,
  input: InputCommand,
  world: CollisionWorld,
  dt: number,
): void {
  const wantsProne = hasFlag(input.buttons, InputFlag.Prone);
  const wantsCrouch = hasFlag(input.buttons, InputFlag.Crouch);

  let desired: Stance;
  if (wantsProne) desired = Stance.Prone;
  else if (wantsCrouch) desired = Stance.Crouch;
  else desired = Stance.Stand;

  // Sliding forces crouch, and you can't stand up under a low ceiling.
  if (player.moveState === MoveState.Slide) desired = Stance.Crouch;

  if (desired !== player.stance) {
    if (isTallerStance(desired, player.stance) && !hasHeadroom(player, desired, world)) {
      // Blocked by geometry — stay where we are. This is what stops players
      // popping through crawlspace ceilings.
      desired = player.stance;
    }
  }

  if (desired !== player.stance) {
    player.previousStance = player.stance;
    player.stance = desired;
    player.stanceProgress = 0;
  }

  const duration = stanceTransitionTime(player.previousStance ?? player.stance, player.stance);
  if (duration <= 0) {
    player.stanceProgress = 1;
  } else {
    player.stanceProgress = clamp01(player.stanceProgress + dt / duration);
  }
}

function isTallerStance(a: Stance, b: Stance): boolean {
  return stanceHeight(a) > stanceHeight(b);
}

function hasHeadroom(player: PlayerState, target: Stance, world: CollisionWorld): boolean {
  const targetHeight = stanceHeight(target);
  const currentH = currentHeight(player);
  const growth = targetHeight - currentH;
  if (growth <= 0) return true;

  // Sweep the *current* capsule upward by the growth amount. If it clears, the
  // taller capsule fits.
  v3copy(_probeStart, player.position);
  v3set(_probeDelta, 0, growth + 0.02, 0);
  world.sweepCapsule(_probeStart, currentH, PLAYER_RADIUS, _probeDelta, MOVEMENT_FILTER, _sweep2);
  return !_sweep2.hit || _sweep2.fraction >= 0.99;
}

function stanceTransitionTime(from: Stance, to: Stance): number {
  if (from === to) return 0;
  if (from === Stance.Stand && to === Stance.Crouch) return STANCE_TRANSITION.standToCrouch;
  if (from === Stance.Crouch && to === Stance.Stand) return STANCE_TRANSITION.crouchToStand;
  if (from === Stance.Crouch && to === Stance.Prone) return STANCE_TRANSITION.crouchToProne;
  if (from === Stance.Prone && to === Stance.Crouch) return STANCE_TRANSITION.proneToCrouch;
  if (from === Stance.Stand && to === Stance.Prone) return STANCE_TRANSITION.standToProne;
  return STANCE_TRANSITION.proneToStand;
}

// ---------------------------------------------------------------------------
// Lean
// ---------------------------------------------------------------------------

function updateLean(player: PlayerState, input: InputCommand, dt: number): void {
  let target = 0;
  if (hasFlag(input.buttons, InputFlag.LeanLeft)) target -= 1;
  if (hasFlag(input.buttons, InputFlag.LeanRight)) target += 1;

  // Leaning is only available while aiming or standing still — you can't lean
  // around a corner at a sprint.
  if (player.moveState === MoveState.Sprint || player.moveState === MoveState.TacticalSprint) {
    target = 0;
  }

  player.lean = moveTowards(player.lean, target, LEAN.speed * dt);
}

// ---------------------------------------------------------------------------
// Wish direction and speed
// ---------------------------------------------------------------------------

function buildWishDirection(player: PlayerState, input: InputCommand, out: Vec3): Vec3 {
  anglesToForwardFlat(_forward, player.yaw);
  anglesToRight(_right, player.yaw);

  const f = clamp(input.moveForward, -1, 1);
  const r = clamp(input.moveRight, -1, 1);

  out.x = _forward.x * f + _right.x * r;
  out.y = 0;
  out.z = _forward.z * f + _right.z * r;

  const lenSq = v3lengthSq(out);
  if (lenSq > 1) {
    // Normalise so diagonal movement isn't faster — the classic bug.
    const inv = 1 / Math.sqrt(lenSq);
    out.x *= inv;
    out.z *= inv;
  }
  return out;
}

/**
 * Top speed for the current state. Directional multipliers are applied against
 * the *dominant* axis of intent rather than blended, which is what makes
 * strafing feel snappy instead of mushy.
 */
function computeMaxSpeed(
  player: PlayerState,
  input: InputCommand,
  mods: MovementModifiers,
): number {
  let speed = MOVE.baseSpeed * mods.speedMultiplier * mods.slowMultiplier;

  switch (player.stance) {
    case Stance.Crouch:
      speed *= MOVE.crouchMult;
      break;
    case Stance.Prone:
      speed *= MOVE.proneMult;
      break;
    default:
      break;
  }

  if (player.moveState === MoveState.TacticalSprint) {
    speed *= MOVE.tacSprintMult;
  } else if (player.moveState === MoveState.Sprint) {
    speed *= MOVE.sprintMult;
  } else {
    // Directional penalties only apply when not sprinting, because sprinting is
    // forward-only anyway.
    const f = input.moveForward;
    const r = input.moveRight;
    if (f < -0.1 && Math.abs(f) >= Math.abs(r)) {
      speed *= MOVE.backMult;
    } else if (Math.abs(r) > Math.abs(f)) {
      speed *= MOVE.strafeMult;
    }
  }

  if (mods.adsProgress > 0) {
    // Blend rather than switch, so the slowdown tracks the ADS animation.
    const adsFactor = lerp(1, MOVE.adsMult * mods.adsSpeedMultiplier, mods.adsProgress);
    speed *= adsFactor;
  }

  return speed;
}

// ---------------------------------------------------------------------------
// Sprint
// ---------------------------------------------------------------------------

function updateSprint(player: PlayerState, input: InputCommand, mods: MovementModifiers): void {
  const wantsSprint = hasFlag(input.buttons, InputFlag.Sprint);
  const wantsTac = hasFlag(input.buttons, InputFlag.TacticalSprint);
  const movingForward = input.moveForward > 0.35;

  const canSprint =
    wantsSprint &&
    movingForward &&
    !mods.sprintBlocked &&
    player.stance === Stance.Stand &&
    mods.adsProgress < 0.2 &&
    player.moveState !== MoveState.Slide;

  if (!canSprint) {
    if (player.moveState === MoveState.Sprint || player.moveState === MoveState.TacticalSprint) {
      // Sprint-out: the delay before the weapon can fire again. Set by the
      // weapon system via `sprintOutTime`; movement just records the trigger.
      player.sprintOutPending = true;
    }
    player.tacSprintTime = 0;
    return;
  }

  if (wantsTac && player.tacSprintCooldown <= 0 && player.tacSprintTime < MOVE.tacSprintDuration) {
    player.moveState = MoveState.TacticalSprint;
  } else {
    player.moveState = MoveState.Sprint;
    if (player.tacSprintTime > 0) {
      // Dropping out of tac sprint starts its cooldown.
      player.tacSprintCooldown = MOVE.tacSprintCooldown;
      player.tacSprintTime = 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Slide
// ---------------------------------------------------------------------------

function updateSlide(
  player: PlayerState,
  input: InputCommand,
  world: CollisionWorld,
  dt: number,
  mods: MovementModifiers,
): void {
  if (player.moveState === MoveState.Slide) {
    player.slideTime += dt;
    const speed = Math.sqrt(
      player.velocity.x * player.velocity.x + player.velocity.z * player.velocity.z,
    );
    // A slide ends on its timer, when it runs out of speed, or when the player
    // releases crouch — that last one is slide-cancelling, and it must be
    // instant to preserve the tech.
    const releasedCrouch = !hasFlag(input.buttons, InputFlag.Crouch);
    if (player.slideTime >= SLIDE.duration || speed < MOVE.baseSpeed * 0.55 || releasedCrouch) {
      endSlide(player);
    }
    return;
  }

  if (mods.slideBlocked || player.slideCooldown > 0 || !player.onGround) return;
  if (!hasFlag(input.buttons, InputFlag.Crouch)) return;

  const wasSprinting =
    player.moveState === MoveState.Sprint || player.moveState === MoveState.TacticalSprint;
  if (!wasSprinting) return;

  const speed = Math.sqrt(
    player.velocity.x * player.velocity.x + player.velocity.z * player.velocity.z,
  );
  if (speed < SLIDE.minSpeed) return;

  // Commit to the slide: snap to the boost speed along the current heading.
  v3set(_tmp, player.velocity.x, 0, player.velocity.z);
  v3normalize(_tmp, _tmp);
  player.velocity.x = _tmp.x * SLIDE.boostSpeed;
  player.velocity.z = _tmp.z * SLIDE.boostSpeed;

  player.moveState = MoveState.Slide;
  player.slideTime = 0;
  player.previousStance = player.stance;
  player.stance = Stance.Crouch;
  player.stanceProgress = 0;
  _result.startedSlide = true;
}

function endSlide(player: PlayerState): void {
  player.moveState = MoveState.Walk;
  player.slideTime = 0;
  player.slideCooldown = SLIDE.cooldown;
}

function applySlideFriction(player: PlayerState, dt: number): void {
  const speed = Math.sqrt(
    player.velocity.x * player.velocity.x + player.velocity.z * player.velocity.z,
  );
  if (speed <= 0) return;

  // Downhill slides accelerate — rewarding players who read the terrain.
  const slopeBoost = -player.groundNormal.y < -0.999 ? 0 : player.groundNormal.y;
  const downhill = v3dot(player.velocity, player.groundNormal) < 0 ? SLIDE.slopeAccel : 0;
  void slopeBoost;

  const drop = Math.max(0, SLIDE.friction * dt - downhill * dt);
  const newSpeed = Math.max(0, speed - drop);
  const scale = newSpeed / speed;
  player.velocity.x *= scale;
  player.velocity.z *= scale;
}

// ---------------------------------------------------------------------------
// Ground and air acceleration
// ---------------------------------------------------------------------------

function applyGroundMovement(
  player: PlayerState,
  input: InputCommand,
  dt: number,
  mods: MovementModifiers,
): void {
  const maxSpeed = computeMaxSpeed(player, input, mods);
  const wishSpeed = v3length(_wishDir) * maxSpeed;

  // Friction first, so releasing the stick decelerates even while a residual
  // wish direction is present.
  const speed = Math.sqrt(
    player.velocity.x * player.velocity.x + player.velocity.z * player.velocity.z,
  );
  if (speed > 0) {
    // A speed floor keeps friction from taking forever to reach zero.
    const control = Math.max(speed, MOVE.baseSpeed * 0.25);
    const drop = control * MOVE.groundFriction * dt * (wishSpeed > 0.01 ? 0.35 : 1);
    const newSpeed = Math.max(0, speed - drop);
    const scale = newSpeed / speed;
    player.velocity.x *= scale;
    player.velocity.z *= scale;
  }

  if (wishSpeed < 0.01) return;

  // Quake-style accelerate: only add the component we're missing, which caps
  // speed naturally without a hard clamp.
  const currentSpeedAlongWish =
    player.velocity.x * _wishDir.x + player.velocity.z * _wishDir.z;
  const addSpeed = wishSpeed - currentSpeedAlongWish;
  if (addSpeed <= 0) return;

  let accel = MOVE.groundAccel * wishSpeed * dt;
  if (accel > addSpeed) accel = addSpeed;

  player.velocity.x += _wishDir.x * accel;
  player.velocity.z += _wishDir.z * accel;
}

function applyAirMovement(player: PlayerState, dt: number): void {
  const lenSq = v3lengthSq(_wishDir);
  if (lenSq < 0.0001) return;

  // Air control is deliberately capped: you can steer a jump, not gain speed
  // from it. Without `maxAirSpeedGain` this becomes a strafe-jumping game.
  const currentAlongWish = player.velocity.x * _wishDir.x + player.velocity.z * _wishDir.z;
  const addSpeed = MOVE.maxAirSpeedGain - currentAlongWish;
  if (addSpeed <= 0) return;

  let accel = MOVE.airAccel * dt;
  if (accel > addSpeed) accel = addSpeed;

  player.velocity.x += _wishDir.x * accel;
  player.velocity.z += _wishDir.z * accel;
}

// ---------------------------------------------------------------------------
// Jump
// ---------------------------------------------------------------------------

function tryJump(
  player: PlayerState,
  input: InputCommand,
  world: CollisionWorld,
  dt: number,
): boolean {
  const pressed = hasFlag(input.buttons, InputFlag.Jump);

  // Buffer a jump pressed slightly before landing, and honour a jump pressed
  // slightly after walking off a ledge. Both make the controls feel forgiving
  // without making them floaty.
  if (pressed) {
    player.jumpBuffer = MOVE.jumpBufferTime;
  } else {
    player.jumpBuffer = Math.max(0, (player.jumpBuffer ?? 0) - dt);
  }

  if ((player.jumpBuffer ?? 0) <= 0) return false;
  if (player.jumpCooldown > 0) return false;

  const grounded = player.onGround || player.airTime <= MOVE.coyoteTime;
  if (!grounded) return false;

  if (player.stance !== Stance.Stand) {
    // Jumping out of crouch stands you up instead — matches COD.
    if (hasHeadroom(player, Stance.Stand, world)) {
      player.previousStance = player.stance;
      player.stance = Stance.Stand;
      player.stanceProgress = 0;
    }
    return false;
  }

  if (player.moveState === MoveState.Slide) endSlide(player);

  player.velocity.y = MOVE.jumpVelocity;
  player.onGround = false;
  player.jumpCooldown = MOVE.jumpCooldown;
  player.jumpBuffer = 0;
  // Long enough to clear the ground-snap probe, short enough that landing on a
  // ledge immediately below still registers.
  player.groundLockout = 0.14;
  player.airTime = MOVE.coyoteTime + 0.001; // Consume coyote time immediately.
  player.fallPeakY = player.position.y;
  return true;
}

// ---------------------------------------------------------------------------
// Gravity and integration
// ---------------------------------------------------------------------------

function applyGravity(player: PlayerState, dt: number): void {
  if (player.onGround && player.velocity.y <= 0) {
    // Hold a small downward bias so the player stays glued to ramps.
    player.velocity.y = -2;
    return;
  }
  player.velocity.y -= MOVE.gravity * dt;
  if (player.velocity.y < -MOVE.maxFallSpeed) player.velocity.y = -MOVE.maxFallSpeed;
}

function applyGravityOnly(player: PlayerState, world: CollisionWorld, dt: number): void {
  player.velocity.y -= MOVE.gravity * dt;
  if (player.velocity.y < -MOVE.maxFallSpeed) player.velocity.y = -MOVE.maxFallSpeed;
  v3scale(_delta, player.velocity, dt);
  const h = currentHeight(player);
  world.sweepCapsule(player.position, h, PLAYER_RADIUS, _delta, MOVEMENT_FILTER, _sweep);
  v3addScaled(player.position, player.position, _delta, _sweep.fraction);
  if (_sweep.hit && _sweep.normal.y > 0.5) {
    player.velocity.y = 0;
    player.onGround = true;
  }
}

/**
 * Collide-and-slide integration.
 *
 * Four iterations is enough to resolve a corner without the "sticky wall" feel
 * you get from stopping at first contact. Each iteration removes the velocity
 * component pointing into the surface and retries with what's left.
 */
function moveWithCollision(
  player: PlayerState,
  world: CollisionWorld,
  filter: QueryFilter,
  dt: number,
): void {
  const height = currentHeight(player);
  v3scale(_remaining, player.velocity, dt);

  for (let iter = 0; iter < 4; iter++) {
    if (v3lengthSq(_remaining) < 1e-8) break;

    world.sweepCapsule(player.position, height, PLAYER_RADIUS, _remaining, filter, _sweep);

    if (_sweep.startedSolid) {
      // Wedged. Depenetrate and try again next tick rather than tunnelling.
      if (world.resolvePenetration(player.position, height, PLAYER_RADIUS, filter, _tmp)) {
        v3copy(player.position, _tmp);
      }
      break;
    }

    // Advance to just before contact.
    v3addScaled(player.position, player.position, _remaining, _sweep.fraction);

    if (!_sweep.hit) break;

    // Try to step up over a low obstruction before sliding along it. Without
    // this, curbs and door thresholds stop the player dead.
    if (
      player.onGround &&
      _sweep.normal.y < 0.2 &&
      tryStepUp(player, world, filter, height, _remaining, _sweep.fraction)
    ) {
      continue;
    }

    v3copy(_planeNormal, _sweep.normal);
    v3scale(_remaining, _remaining, 1 - _sweep.fraction);
    v3projectOnPlane(_remaining, _remaining, _planeNormal);
    v3projectOnPlane(player.velocity, player.velocity, _planeNormal);
  }

  if (!Number.isFinite(player.position.x + player.position.y + player.position.z)) {
    // Defensive: a NaN here would desync the client permanently. Snap to origin
    // and let the spawn system recover.
    v3set(player.position, 0, 0, 0);
    v3set(player.velocity, 0, 0, 0);
  }
}

/**
 * Attempt to step over an obstacle up to MOVE.stepHeight tall.
 * Returns true if the step succeeded and `_remaining` was preserved.
 */
function tryStepUp(
  player: PlayerState,
  world: CollisionWorld,
  filter: QueryFilter,
  height: number,
  remaining: Vec3,
  usedFraction: number,
): boolean {
  const leftover = 1 - usedFraction;
  if (leftover < 0.01) return false;

  // 1. Lift.
  v3copy(_probeStart, player.position);
  v3set(_probeDelta, 0, MOVE.stepHeight, 0);
  world.sweepCapsule(_probeStart, height, PLAYER_RADIUS, _probeDelta, filter, _stepUp);
  const lift = MOVE.stepHeight * _stepUp.fraction;
  if (lift < 0.02) return false;
  _probeStart.y += lift;

  // 2. Move forward at the raised height.
  v3scale(_probeDelta, remaining, leftover);
  _probeDelta.y = 0;
  world.sweepCapsule(_probeStart, height, PLAYER_RADIUS, _probeDelta, filter, _stepUp);
  if (_stepUp.fraction < 0.15) return false; // Not actually a step, it's a wall.
  v3addScaled(_probeStart, _probeStart, _probeDelta, _stepUp.fraction);

  // 3. Drop back down onto the step.
  v3set(_probeDelta, 0, -(lift + 0.02), 0);
  world.sweepCapsule(_probeStart, height, PLAYER_RADIUS, _probeDelta, filter, _stepUp);
  if (!_stepUp.hit) return false; // Nothing to land on — this was a ledge, not a step.
  v3addScaled(_probeStart, _probeStart, _probeDelta, _stepUp.fraction);

  // Only accept the step if the surface we landed on is walkable.
  if (_stepUp.normal.y < Math.cos(MOVE.maxSlopeAngle)) return false;

  v3copy(player.position, _probeStart);
  v3scale(remaining, remaining, 0); // The step consumed the remaining motion.
  return true;
}

// ---------------------------------------------------------------------------
// Ground detection
// ---------------------------------------------------------------------------

function updateGrounded(
  player: PlayerState,
  world: CollisionWorld,
  filter: QueryFilter,
  dt: number,
): void {
  void dt;
  const height = currentHeight(player);

  if (player.groundLockout > 0) {
    // Deliberately airborne (we just jumped). Don't let the probe re-ground us.
    player.onGround = false;
    v3set(player.groundNormal, 0, 1, 0);
    return;
  }

  // Probe further than gravity could have moved us in a tick, so walking down
  // stairs keeps contact instead of turning into a series of little hops.
  const probe = MOVE.groundSnapDistance;
  v3set(_probeDelta, 0, -probe, 0);
  world.sweepCapsule(player.position, height, PLAYER_RADIUS, _probeDelta, filter, _sweep2);

  const walkable = _sweep2.hit && _sweep2.normal.y >= Math.cos(MOVE.maxSlopeAngle);

  if (walkable) {
    player.onGround = true;
    v3copy(player.groundNormal, _sweep2.normal);
    // Snap down to the surface so we don't hover a few millimetres above it.
    if (_sweep2.fraction > 0 && _sweep2.fraction < 1) {
      player.position.y -= probe * _sweep2.fraction;
    }
    // Zero the vertical component entirely. On a slope the upward motion is
    // re-derived each tick by projecting the ground bias onto the slope plane,
    // so keeping a residual here would compound into a launch.
    player.velocity.y = 0;
  } else {
    player.onGround = false;
    v3set(player.groundNormal, 0, 1, 0);
  }
}

// ---------------------------------------------------------------------------
// Mantle
// ---------------------------------------------------------------------------

/**
 * Detect a mantleable ledge in front of the player and start the animation.
 *
 * The probe is: cast forward at chest height to find a wall; if there is one,
 * cast down from above and in front of it to find the ledge top; verify there's
 * standing room up there.
 */
function tryMantle(
  player: PlayerState,
  input: InputCommand,
  world: CollisionWorld,
  filter: QueryFilter,
): boolean {
  if (player.mantleTime > 0) return false;
  if (player.stance === Stance.Prone) return false;

  // Mantling is intentional: it needs forward input plus either a jump press or
  // contact with the obstacle. Auto-mantling on every wall touch feels twitchy.
  const wantsUp = hasFlag(input.buttons, InputFlag.Jump) || hasFlag(input.buttons, InputFlag.Use);
  if (!wantsUp || input.moveForward < 0.3) return false;

  anglesToForwardFlat(_forward, player.yaw);

  // Find the wall.
  v3copy(_probeStart, player.position);
  _probeStart.y += MOVE.stepHeight + 0.1;
  v3scale(_probeDelta, _forward, MANTLE.reach);
  world.sweepCapsule(_probeStart, 0.4, PLAYER_RADIUS * 0.9, _probeDelta, filter, _sweep2);
  if (!_sweep2.hit || _sweep2.fraction > 0.85) return false;

  // Probe down for the ledge top, starting above the maximum mantle height.
  v3addScaled(_probeStart, _probeStart, _forward, MANTLE.reach * 0.95);
  _probeStart.y = player.position.y + MANTLE.maxHeight + 0.4;
  const ledgeY = world.groundHeightAt(
    _probeStart.x,
    _probeStart.z,
    _probeStart.y,
    MANTLE.maxHeight + 0.6,
  );
  if (!Number.isFinite(ledgeY)) return false;

  const climb = ledgeY - player.position.y;
  if (climb < MANTLE.minHeight || climb > MANTLE.maxHeight) return false;

  // Verify the player will fit on top.
  v3set(_tmp, _probeStart.x, ledgeY + 0.03, _probeStart.z);
  if (!world.isCapsuleFree(_tmp, MANTLE.clearance, PLAYER_RADIUS * 0.95, filter)) return false;

  player.mantleTime = 0.0001;
  player.mantleDuration = lerp(
    MANTLE.minDuration,
    MANTLE.maxDuration,
    clamp01((climb - MANTLE.minHeight) / (MANTLE.maxHeight - MANTLE.minHeight)),
  );
  v3copy(player.mantleStart, player.position);
  v3copy(player.mantleEnd, _tmp);
  player.moveState = MoveState.Mantle;
  v3set(player.velocity, 0, 0, 0);
  return true;
}

function stepMantle(player: PlayerState, dt: number): void {
  player.mantleTime += dt;
  const t = clamp01(player.mantleTime / player.mantleDuration);

  // Ease the vertical component ahead of the horizontal one, so the player pulls
  // up over the ledge rather than clipping diagonally through its corner.
  const vertical = Math.sin(t * Math.PI * 0.5);
  const horizontal = t * t * (3 - 2 * t);

  player.position.x = lerp(player.mantleStart.x, player.mantleEnd.x, horizontal);
  player.position.z = lerp(player.mantleStart.z, player.mantleEnd.z, horizontal);
  player.position.y = lerp(player.mantleStart.y, player.mantleEnd.y, vertical);

  if (t >= 1) {
    player.mantleTime = 0;
    player.moveState = MoveState.Walk;
    player.onGround = true;
    v3set(player.velocity, 0, 0, 0);
  }
}

// ---------------------------------------------------------------------------
// Derived state
// ---------------------------------------------------------------------------

function updateMoveState(player: PlayerState): void {
  if (player.moveState === MoveState.Slide || player.moveState === MoveState.Mantle) return;

  if (!player.onGround) {
    player.moveState = MoveState.Air;
    return;
  }
  if (player.moveState === MoveState.Sprint || player.moveState === MoveState.TacticalSprint) {
    return;
  }

  const speedSq =
    player.velocity.x * player.velocity.x + player.velocity.z * player.velocity.z;
  player.moveState = speedSq > 0.35 ? MoveState.Walk : MoveState.Idle;
}

function updateFootsteps(player: PlayerState, result: MovementResult): void {
  if (!player.onGround || player.moveState === MoveState.Slide) return;

  const stride =
    player.moveState === MoveState.Sprint || player.moveState === MoveState.TacticalSprint
      ? FOOTSTEP_STRIDE.sprint
      : player.stance === Stance.Prone
        ? FOOTSTEP_STRIDE.prone
        : player.stance === Stance.Crouch
          ? FOOTSTEP_STRIDE.crouch
          : FOOTSTEP_STRIDE.walk;

  const acc = (strideAccumulator.get(player.id) ?? 0) + result.distanceMoved;
  if (acc >= stride) {
    strideAccumulator.set(player.id, acc - stride);
    result.footstep = true;
    result.footstepLoud =
      player.stance === Stance.Stand &&
      (player.moveState === MoveState.Sprint || player.moveState === MoveState.TacticalSprint);
  } else {
    strideAccumulator.set(player.id, acc);
  }
}

/** Horizontal speed, exposed for the HUD, animation blending and AI. */
export function horizontalSpeed(player: PlayerState): number {
  return Math.sqrt(
    player.velocity.x * player.velocity.x + player.velocity.z * player.velocity.z,
  );
}

/** Smooth camera height, used to damp the crouch transition visually. */
export function smoothedEyeHeight(player: PlayerState, previous: number, dt: number): number {
  return damp(previous, currentEyeHeight(player), 18, dt);
}

/** Roll applied to the camera while sliding and strafing, in radians. */
export function cameraRoll(player: PlayerState, input: InputCommand): number {
  if (player.moveState === MoveState.Slide) return SLIDE.cameraRoll;
  const strafe = clamp(input.moveRight, -1, 1);
  return -strafe * 0.018 + player.lean * LEAN.maxAngle;
}

/** True while the player is committed to a scripted movement and can't shoot. */
export function isMovementLocked(player: PlayerState): boolean {
  return player.mantleTime > 0;
}
