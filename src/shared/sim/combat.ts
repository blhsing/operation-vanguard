/**
 * Ballistics, hit registration and damage.
 *
 * Two decisions shape this file:
 *
 * 1. **Hitscan by default, projectiles when it matters.** Almost every COD gun is
 *    hitscan because it makes hit registration feel honest at the latencies real
 *    players have. Weapons with a finite `muzzleVelocity` fall through to the
 *    projectile path instead, which is what makes launchers and the anti-materiel
 *    rifle feel different rather than just slower.
 *
 * 2. **Per-bone hitboxes, evaluated in one pass.** A player is nine boxes, not a
 *    capsule. That is what lets a headshot be a headshot and what makes limb
 *    damage a meaningful concept. The boxes are derived from the player's stance
 *    and view angles, so a prone sniper genuinely is a smaller target.
 */

import { HIT_MULTIPLIER, MAX_TRACE_DISTANCE, PLAYER_RADIUS, type HitLocation } from '../constants.js';
import {
  aabbFromCenterSize,
  anglesToForward,
  anglesToRight,
  clamp,
  clamp01,
  rayAABB,
  v3addScaled,
  v3copy,
  v3cross,
  v3distance,
  v3dot,
  v3normalize,
  v3scale,
  v3set,
  v3sub,
  vec3,
  type AABB,
  type Vec3,
} from '../math.js';
import type { Rng } from '../rng.js';
import {
  DamageCause,
  Stance,
  SurfaceType,
  isEnemyTeam,
  type DamageInfo,
  type EntityId,
  type PlayerId,
  type PlayerState,
  type WorldState,
} from '../types.js';
import {
  CollisionLayer,
  SURFACE_PROPERTIES,
  createRaycastHit,
  type CollisionWorld,
  type QueryFilter,
  type RaycastHit,
} from '../collision/collision-types.js';
import { damageAtRange, type WeaponDef } from '../data/weapon-types.js';
import { currentEyeHeight, currentHeight } from './movement.js';

// ---------------------------------------------------------------------------
// Hitboxes
// ---------------------------------------------------------------------------

/**
 * A hitbox is defined in the player's local frame: `offset` is (right, up,
 * forward) relative to the feet, scaled by the stance. Keeping them relative
 * means one table describes standing, crouching and prone.
 */
interface HitboxDef {
  location: HitLocation;
  /** Fractions of stance height for the vertical axis; metres for the others. */
  offset: { right: number; upFrac: number; forward: number };
  size: { x: number; yFrac: number; z: number };
}

/**
 * Nine boxes, ordered head-first. Order matters: we take the first hit at the
 * nearest distance, and testing the head early lets us short-circuit the common
 * "is this a headshot" question without evaluating the whole body.
 */
const HITBOXES: HitboxDef[] = [
  { location: 'head', offset: { right: 0, upFrac: 0.935, forward: 0.02 }, size: { x: 0.22, yFrac: 0.13, z: 0.24 } },
  { location: 'neck', offset: { right: 0, upFrac: 0.845, forward: 0 }, size: { x: 0.16, yFrac: 0.055, z: 0.16 } },
  { location: 'chest', offset: { right: 0, upFrac: 0.71, forward: 0 }, size: { x: 0.46, yFrac: 0.2, z: 0.28 } },
  { location: 'stomach', offset: { right: 0, upFrac: 0.545, forward: 0 }, size: { x: 0.4, yFrac: 0.14, z: 0.26 } },
  { location: 'upperArm', offset: { right: 0.3, upFrac: 0.72, forward: 0 }, size: { x: 0.16, yFrac: 0.18, z: 0.18 } },
  { location: 'upperArm', offset: { right: -0.3, upFrac: 0.72, forward: 0 }, size: { x: 0.16, yFrac: 0.18, z: 0.18 } },
  { location: 'lowerArm', offset: { right: 0.32, upFrac: 0.55, forward: 0.06 }, size: { x: 0.14, yFrac: 0.15, z: 0.16 } },
  { location: 'lowerArm', offset: { right: -0.32, upFrac: 0.55, forward: 0.06 }, size: { x: 0.14, yFrac: 0.15, z: 0.16 } },
  { location: 'upperLeg', offset: { right: 0.13, upFrac: 0.36, forward: 0 }, size: { x: 0.2, yFrac: 0.22, z: 0.22 } },
  { location: 'upperLeg', offset: { right: -0.13, upFrac: 0.36, forward: 0 }, size: { x: 0.2, yFrac: 0.22, z: 0.22 } },
  { location: 'lowerLeg', offset: { right: 0.13, upFrac: 0.14, forward: 0 }, size: { x: 0.17, yFrac: 0.2, z: 0.2 } },
  { location: 'lowerLeg', offset: { right: -0.13, upFrac: 0.14, forward: 0 }, size: { x: 0.17, yFrac: 0.2, z: 0.2 } },
];

/**
 * Prone reorients the body from vertical to horizontal, so the local frame is
 * rotated: what was "up" becomes "forward". Rather than a second table we apply
 * this transform, which keeps the two representations from drifting apart.
 */
const _hbRight = vec3();
const _hbForward = vec3();
const _hbCenter = vec3();
const _hbMin = vec3();
const _hbMax = vec3();
const _hbBox: AABB = { min: _hbMin, max: _hbMax };

function buildHitbox(player: PlayerState, def: HitboxDef, out: AABB): AABB {
  const height = currentHeight(player);
  anglesToRight(_hbRight, player.yaw);
  anglesToForward(_hbForward, player.yaw, 0);

  if (player.stance === Stance.Prone) {
    // Lying down: the body extends along `forward` at a low, constant height.
    const along = (def.offset.upFrac - 0.5) * 1.75;
    _hbCenter.x = player.position.x + _hbForward.x * along + _hbRight.x * def.offset.right;
    _hbCenter.z = player.position.z + _hbForward.z * along + _hbRight.z * def.offset.right;
    _hbCenter.y = player.position.y + height * 0.55;

    const len = def.size.yFrac * 1.75;
    out.min.x = _hbCenter.x - Math.max(def.size.x, len) * 0.5;
    out.max.x = _hbCenter.x + Math.max(def.size.x, len) * 0.5;
    out.min.z = _hbCenter.z - Math.max(def.size.z, len) * 0.5;
    out.max.z = _hbCenter.z + Math.max(def.size.z, len) * 0.5;
    out.min.y = _hbCenter.y - height * 0.45;
    out.max.y = _hbCenter.y + height * 0.45;
    return out;
  }

  _hbCenter.x =
    player.position.x + _hbRight.x * def.offset.right + _hbForward.x * def.offset.forward;
  _hbCenter.z =
    player.position.z + _hbRight.z * def.offset.right + _hbForward.z * def.offset.forward;
  _hbCenter.y = player.position.y + height * def.offset.upFrac;

  const sy = def.size.yFrac * height;
  // Axis-aligned boxes sized to the diagonal of the rotated box. Slightly
  // generous, but a hitbox that is too tight reads as "the game ate my shot",
  // which is far worse than one that is a couple of centimetres forgiving.
  const halfXZ = Math.max(def.size.x, def.size.z) * 0.5;
  out.min.x = _hbCenter.x - halfXZ;
  out.max.x = _hbCenter.x + halfXZ;
  out.min.z = _hbCenter.z - halfXZ;
  out.max.z = _hbCenter.z + halfXZ;
  out.min.y = _hbCenter.y - sy * 0.5;
  out.max.y = _hbCenter.y + sy * 0.5;
  return out;
}

export interface HitboxHit {
  hit: boolean;
  location: HitLocation;
  distance: number;
  point: Vec3;
}

const _hbResult: HitboxHit = { hit: false, location: 'chest', distance: 0, point: vec3() };

/** Trace a ray against one player's hitboxes. Returns the nearest hit, if any. */
export function raycastPlayer(
  origin: Vec3,
  direction: Vec3,
  maxDistance: number,
  player: PlayerState,
  out: HitboxHit = _hbResult,
): HitboxHit {
  out.hit = false;
  out.distance = maxDistance;

  if (!player.alive) return out;

  // Cheap reject: a sphere around the whole player. Skips 95% of the work.
  const height = currentHeight(player);
  const cx = player.position.x;
  const cy = player.position.y + height * 0.5;
  const cz = player.position.z;
  const bounding = height * 0.5 + PLAYER_RADIUS + 0.2;
  const ox = cx - origin.x;
  const oy = cy - origin.y;
  const oz = cz - origin.z;
  const along = ox * direction.x + oy * direction.y + oz * direction.z;
  if (along < -bounding || along > maxDistance + bounding) return out;
  const perpSq = ox * ox + oy * oy + oz * oz - along * along;
  if (perpSq > bounding * bounding) return out;

  for (const def of HITBOXES) {
    buildHitbox(player, def, _hbBox);
    const t = rayAABB(origin, direction, _hbBox, out.distance);
    if (t >= 0 && t < out.distance) {
      out.hit = true;
      out.distance = t;
      out.location = def.location;
    }
  }

  if (out.hit) {
    v3addScaled(out.point, origin, direction, out.distance);
  }
  return out;
}

/** All hitboxes for a player, for debug rendering and for the AI aim solver. */
export function playerHitboxes(player: PlayerState): Array<{ location: HitLocation; box: AABB }> {
  return HITBOXES.map((def) => {
    const box = aabbFromCenterSize(vec3(), vec3(1, 1, 1));
    buildHitbox(player, def, box);
    return { location: def.location, box };
  });
}

/** Centre of a named hitbox — where bots aim. */
export function hitboxCenter(out: Vec3, player: PlayerState, location: HitLocation): Vec3 {
  const def = HITBOXES.find((h) => h.location === location) ?? HITBOXES[2]!;
  buildHitbox(player, def, _hbBox);
  out.x = (_hbBox.min.x + _hbBox.max.x) * 0.5;
  out.y = (_hbBox.min.y + _hbBox.max.y) * 0.5;
  out.z = (_hbBox.min.z + _hbBox.max.z) * 0.5;
  return out;
}

// ---------------------------------------------------------------------------
// Spread and recoil
// ---------------------------------------------------------------------------

const _spreadRight = vec3();
const _spreadUp = vec3();
const _discPoint = { x: 0, y: 0 };

/**
 * Perturb a direction within a cone. Uses a uniform disc rather than two
 * independent gaussians, because a gaussian cone concentrates shots at the
 * centre and makes hipfire feel deceptively accurate at range.
 */
export function applySpread(
  out: Vec3,
  direction: Vec3,
  coneHalfAngle: number,
  rng: Rng,
): Vec3 {
  if (coneHalfAngle <= 0) return v3copy(out, direction);

  // Build an orthonormal basis around the direction.
  const up = Math.abs(direction.y) > 0.99 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  v3cross(_spreadRight, direction, up);
  v3normalize(_spreadRight, _spreadRight);
  v3cross(_spreadUp, _spreadRight, direction);

  rng.unitDisc(_discPoint);
  const tan = Math.tan(coneHalfAngle);

  out.x = direction.x + (_spreadRight.x * _discPoint.x + _spreadUp.x * _discPoint.y) * tan;
  out.y = direction.y + (_spreadRight.y * _discPoint.x + _spreadUp.y * _discPoint.y) * tan;
  out.z = direction.z + (_spreadRight.z * _discPoint.x + _spreadUp.z * _discPoint.y) * tan;
  return v3normalize(out, out);
}

/**
 * The current spread cone for a weapon, folding in stance, motion and how many
 * rounds have been sent downrange. This is what makes spraying from a sprint a
 * bad idea and holding an angle crouched a good one.
 */
export function computeSpread(
  weapon: WeaponDef,
  player: PlayerState,
  shotsFired: number,
  horizontalSpeed: number,
): number {
  const s = weapon.spread;
  const adsT = clamp01(player.adsProgress);

  const min = s.hipMin + (s.adsMin - s.hipMin) * adsT;
  const max = s.hipMax + (s.adsMax - s.hipMax) * adsT;

  let cone = Math.min(max, min + s.perShot * shotsFired);

  if (!player.onGround) {
    cone *= s.jumpingMultiplier;
  } else if (horizontalSpeed > 0.5) {
    // Scale the movement penalty with actual speed rather than switching on it,
    // so walking slowly is genuinely more accurate than sprinting.
    const t = clamp01(horizontalSpeed / 6);
    cone *= 1 + (s.movingMultiplier - 1) * t;
  }

  if (player.stance === Stance.Crouch) cone *= s.crouchMultiplier;
  else if (player.stance === Stance.Prone) cone *= s.proneMultiplier;

  return Math.max(0, cone);
}

/**
 * Per-shot recoil impulse. Returns the kick to add to the player's view.
 * The pattern is deterministic and repeats, so the gun can be learned; the random
 * component is small enough not to defeat that.
 */
export function computeRecoil(
  weapon: WeaponDef,
  shotIndex: number,
  rng: Rng,
  out: { pitch: number; yaw: number },
): { pitch: number; yaw: number } {
  const pattern = weapon.recoil.pattern;
  const step = pattern.length > 0 ? pattern[Math.min(shotIndex, pattern.length - 1)]! : { pitch: 0, yaw: 0 };

  out.pitch = step.pitch + rng.signed(weapon.recoil.randomPitch);
  out.yaw = step.yaw + rng.signed(weapon.recoil.randomYaw);
  return out;
}

// ---------------------------------------------------------------------------
// Firing a hitscan shot
// ---------------------------------------------------------------------------

export interface TraceResult {
  /** Did we hit a player? */
  hitPlayer: boolean;
  victim: PlayerId;
  location: HitLocation;
  /** Damage after range falloff, penetration loss and the hit multiplier. */
  damage: number;
  /** Where the trace terminated. */
  point: Vec3;
  normal: Vec3;
  surface: SurfaceType;
  distance: number;
  /** Number of surfaces punched through before the hit. */
  penetrations: number;
  /** Did the trace hit any geometry at all? */
  hitAnything: boolean;
  /** Non-player entity that was hit (deployable, killstreak), or 0. */
  hitEntity: EntityId;
}

function createTraceResult(): TraceResult {
  return {
    hitPlayer: false,
    victim: 0,
    location: 'chest',
    damage: 0,
    point: vec3(),
    normal: vec3(0, 1, 0),
    surface: SurfaceType.Concrete,
    distance: 0,
    penetrations: 0,
    hitAnything: false,
    hitEntity: 0,
  };
}

const _traceHits: RaycastHit[] = Array.from({ length: 8 }, createRaycastHit);
const _traceDir = vec3();
const _traceOrigin = vec3();
const _playerHit: HitboxHit = { hit: false, location: 'chest', distance: 0, point: vec3() };
const _bulletFilter: QueryFilter = { layers: CollisionLayer.Bullet };

/** Maximum surfaces one round may pass through, however thin they are. */
const MAX_PENETRATIONS = 3;

/**
 * Fire one hitscan round and resolve what it hits, including wallbangs.
 *
 * The algorithm walks the geometry hits in order. At each surface it decides
 * whether the round survives (based on the weapon's penetration power against
 * the surface's resistance and its thickness) and, if so, continues with reduced
 * damage. Players are tested against the *segment before* each geometry hit, so
 * shooting someone standing behind a thin wall works exactly as expected.
 */
export function traceShot(
  world: WorldState,
  collision: CollisionWorld,
  shooter: PlayerState,
  weapon: WeaponDef,
  origin: Vec3,
  direction: Vec3,
  out: TraceResult = createTraceResult(),
): TraceResult {
  out.hitPlayer = false;
  out.victim = 0;
  out.damage = 0;
  out.penetrations = 0;
  out.hitAnything = false;
  out.hitEntity = 0;
  out.distance = 0;

  v3copy(_traceOrigin, origin);
  v3normalize(_traceDir, direction);

  let remaining = MAX_TRACE_DISTANCE;
  let damageScale = 1;
  let travelled = 0;

  for (let pass = 0; pass <= MAX_PENETRATIONS; pass++) {
    const geoFilter: QueryFilter = {
      layers: CollisionLayer.Sight | CollisionLayer.BulletClip,
      ignoreEntities: [shooter.entityId],
    };
    const geo = collision.raycast(_traceOrigin, _traceDir, remaining, geoFilter, _traceHits[0]!);
    const geoDist = geo.hit ? geo.distance : remaining;

    // Players first, but only within the segment that isn't blocked by geometry.
    let nearestPlayerDist = geoDist;
    let nearestPlayer: PlayerState | null = null;
    let nearestLocation: HitLocation = 'chest';

    for (const target of world.players.values()) {
      if (target.id === shooter.id || !target.alive) continue;
      // Friendly fire is off, but friendly bodies still block bullets — that is
      // what makes stacking in a doorway a real cost.
      raycastPlayer(_traceOrigin, _traceDir, nearestPlayerDist, target, _playerHit);
      if (_playerHit.hit && _playerHit.distance < nearestPlayerDist) {
        nearestPlayerDist = _playerHit.distance;
        nearestPlayer = target;
        nearestLocation = _playerHit.location;
      }
    }

    if (nearestPlayer) {
      travelled += nearestPlayerDist;
      const isEnemy = isEnemyTeam(shooter.team, nearestPlayer.team);
      if (isEnemy) {
        const base = damageAtRange(weapon.damage, travelled);
        out.hitPlayer = true;
        out.victim = nearestPlayer.id;
        out.location = nearestLocation;
        out.damage = base * HIT_MULTIPLIER[nearestLocation] * damageScale;
        v3addScaled(out.point, _traceOrigin, _traceDir, nearestPlayerDist);
        v3scale(out.normal, _traceDir, -1);
        out.surface = SurfaceType.Flesh;
        out.distance = travelled;
        out.hitAnything = true;
        return out;
      }
      // A teammate soaked the round. It stops, and nobody takes damage.
      travelled += 0;
      v3addScaled(out.point, _traceOrigin, _traceDir, nearestPlayerDist);
      v3scale(out.normal, _traceDir, -1);
      out.surface = SurfaceType.Flesh;
      out.distance = travelled;
      out.hitAnything = true;
      return out;
    }

    if (!geo.hit) {
      // Nothing left to hit.
      travelled += remaining;
      v3addScaled(out.point, _traceOrigin, _traceDir, remaining);
      out.distance = travelled;
      return out;
    }

    travelled += geo.distance;
    out.hitAnything = true;
    v3copy(out.point, geo.point);
    v3copy(out.normal, geo.normal);
    out.surface = geo.surface;
    out.distance = travelled;
    out.hitEntity = geo.entity;

    // Can the round continue?
    const props = SURFACE_PROPERTIES[geo.surface];
    const thickness = Math.max(0.02, geo.thickness);
    const power = weapon.penetration * props.penetration;
    if (pass >= MAX_PENETRATIONS || power <= 0.02 || thickness > power * 2.5) {
      return out;
    }

    // Survived: lose damage proportional to how much material was traversed.
    const retained = props.damageRetention ** (thickness / 0.15);
    damageScale *= clamp(retained, 0, 1);
    if (damageScale < 0.05) return out;

    out.penetrations++;
    // Step just past the exit point to avoid re-hitting the same face.
    v3addScaled(_traceOrigin, geo.point, _traceDir, thickness + 0.01);
    remaining = MAX_TRACE_DISTANCE - travelled;
    if (remaining <= 0.1) return out;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Damage application
// ---------------------------------------------------------------------------

export interface DamageResult {
  applied: number;
  killed: boolean;
  /** Health remaining after the hit. */
  health: number;
  /** Armour absorbed this much of it. */
  absorbed: number;
}

/**
 * Apply damage to a player. Does not award score or emit events — the caller
 * owns those, because scoring rules differ per mode and the sim must stay
 * mode-agnostic.
 */
export function applyDamage(victim: PlayerState, info: DamageInfo): DamageResult {
  const result: DamageResult = { applied: 0, killed: false, health: victim.health, absorbed: 0 };
  if (!victim.alive || info.amount <= 0) return result;

  let remaining = info.amount;

  if (victim.armor > 0 && !info.ignoreArmor) {
    const absorbed = Math.min(victim.armor, remaining);
    victim.armor -= absorbed;
    remaining -= absorbed;
    result.absorbed = absorbed;
  }

  const before = victim.health;
  victim.health = Math.max(0, victim.health - remaining);
  result.applied = before - victim.health + result.absorbed;
  result.health = victim.health;

  victim.timeSinceDamage = 0;
  if (info.attacker !== victim.id && info.attacker !== 0) {
    victim.lastAttacker = info.attacker;
    victim.damagers.set(
      info.attacker,
      (victim.damagers.get(info.attacker) ?? 0) + result.applied,
    );
  }

  if (victim.health <= 0) {
    result.killed = true;
  }
  return result;
}

/**
 * Who assisted in a kill: anyone who dealt damage this life other than the
 * killer. COD awards an assist for any contribution, not a damage threshold,
 * because partial-credit thresholds feel arbitrary to players.
 */
export function computeAssists(victim: PlayerState, killer: PlayerId): PlayerId[] {
  const out: PlayerId[] = [];
  for (const [id, dmg] of victim.damagers) {
    if (id === killer || id === victim.id) continue;
    if (dmg > 0) out.push(id);
  }
  // Stable order — assists appear in the same sequence on every client.
  out.sort((a, b) => a - b);
  return out;
}

// ---------------------------------------------------------------------------
// Explosions
// ---------------------------------------------------------------------------

const _explDir = vec3();
const _explOrigin = vec3();
const _explTarget = vec3();

export interface ExplosionTarget {
  player: PlayerState;
  damage: number;
  direction: Vec3;
  distance: number;
}

/**
 * Resolve an explosion against every player, with line-of-sight checking so
 * cover actually protects. Falloff is quadratic near the centre and linear
 * further out, which keeps direct hits lethal without making the edge of the
 * radius a coin flip.
 */
export function resolveExplosion(
  world: WorldState,
  collision: CollisionWorld,
  center: Vec3,
  radius: number,
  maxDamage: number,
  owner: PlayerId,
  friendlyFire: boolean,
  out: ExplosionTarget[],
): ExplosionTarget[] {
  out.length = 0;
  v3copy(_explOrigin, center);

  const ownerPlayer = world.players.get(owner);

  for (const target of world.players.values()) {
    if (!target.alive) continue;
    if (!friendlyFire && ownerPlayer && target.id !== owner) {
      if (!isEnemyTeam(ownerPlayer.team, target.team)) continue;
    }

    // Measure to the centre of mass, not the feet, or crouching would be immune.
    v3set(
      _explTarget,
      target.position.x,
      target.position.y + currentEyeHeight(target) * 0.6,
      target.position.z,
    );

    const dist = v3distance(_explOrigin, _explTarget);
    if (dist > radius) continue;

    // Cover check. A single ray is enough: grenades that "should" have killed
    // through a gap are far less annoying than grenades that kill through walls.
    const sightFilter: QueryFilter = { layers: CollisionLayer.Sight };
    if (dist > 0.5 && !collision.isVisible(_explOrigin, _explTarget, sightFilter)) {
      continue;
    }

    const t = clamp01(dist / radius);
    // 1 at the centre, dropping off with a soft shoulder.
    const falloff = (1 - t) * (1 - t * 0.55);
    const damage = maxDamage * falloff;
    if (damage < 1) continue;

    v3sub(_explDir, _explTarget, _explOrigin);
    v3normalize(_explDir, _explDir);

    out.push({
      player: target,
      damage,
      direction: v3copy(vec3(), _explDir),
      distance: dist,
    });
  }

  return out;
}

/**
 * Flash intensity for a player given a flashbang position, accounting for how
 * directly they were looking at it. Looking away must genuinely help, or
 * flashbangs stop being a skill interaction.
 */
export function computeFlashIntensity(
  player: PlayerState,
  flashPos: Vec3,
  radius: number,
  collision: CollisionWorld,
): number {
  v3set(
    _explTarget,
    player.position.x,
    player.position.y + currentEyeHeight(player),
    player.position.z,
  );
  const dist = v3distance(flashPos, _explTarget);
  if (dist > radius) return 0;

  const sightFilter: QueryFilter = { layers: CollisionLayer.Sight };
  if (!collision.isVisible(flashPos, _explTarget, sightFilter)) return 0;

  v3sub(_explDir, flashPos, _explTarget);
  v3normalize(_explDir, _explDir);
  anglesToForward(_explOrigin, player.yaw, player.pitch);

  const facing = v3dot(_explDir, _explOrigin); // 1 = staring straight at it
  // Behind you it still registers a little — closed eyes aren't opaque.
  const angleFactor = clamp01(facing * 0.5 + 0.5) ** 1.6 * 0.9 + 0.1;
  const distFactor = 1 - clamp01(dist / radius);

  return clamp01(angleFactor * distFactor);
}

// ---------------------------------------------------------------------------
// Melee
// ---------------------------------------------------------------------------

const _meleeDir = vec3();
const _meleeOrigin = vec3();

/** Range of a melee swing. Generous, because whiffing a lunge feels terrible. */
export const MELEE_RANGE = 2.4;
export const MELEE_HALF_ANGLE = Math.cos(0.62); // ~35 degrees

/** Find the best melee target in front of a player, or null. */
export function findMeleeTarget(
  world: WorldState,
  collision: CollisionWorld,
  attacker: PlayerState,
): PlayerState | null {
  v3set(
    _meleeOrigin,
    attacker.position.x,
    attacker.position.y + currentEyeHeight(attacker),
    attacker.position.z,
  );
  anglesToForward(_meleeDir, attacker.yaw, attacker.pitch);

  let best: PlayerState | null = null;
  let bestDist = MELEE_RANGE;

  for (const target of world.players.values()) {
    if (target.id === attacker.id || !target.alive) continue;
    if (!isEnemyTeam(attacker.team, target.team)) continue;

    v3set(
      _explTarget,
      target.position.x,
      target.position.y + currentHeight(target) * 0.55,
      target.position.z,
    );
    v3sub(_explDir, _explTarget, _meleeOrigin);
    const dist = Math.sqrt(v3dot(_explDir, _explDir));
    if (dist > bestDist || dist < 1e-4) continue;

    v3scale(_explDir, _explDir, 1 / dist);
    if (v3dot(_explDir, _meleeDir) < MELEE_HALF_ANGLE) continue;

    const sightFilter: QueryFilter = { layers: CollisionLayer.Sight };
    if (!collision.isVisible(_meleeOrigin, _explTarget, sightFilter)) continue;

    best = target;
    bestDist = dist;
  }

  return best;
}

/**
 * True if `attacker` is behind `victim` — used for the instant-kill backstab.
 * The threshold is deliberately tight so it reads as a genuine flank.
 */
export function isBehind(attacker: PlayerState, victim: PlayerState): boolean {
  anglesToForward(_meleeDir, victim.yaw, 0);
  v3sub(_explDir, attacker.position, victim.position);
  _explDir.y = 0;
  v3normalize(_explDir, _explDir);
  return v3dot(_explDir, _meleeDir) < -0.55;
}

export { createTraceResult, DamageCause };
