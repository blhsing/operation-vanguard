/**
 * Deployables: everything a player puts down rather than throws.
 *
 * Claymores, C4, proximity mines, trophy systems, ammo boxes, deployable cover,
 * tactical insertions, sentry guns and care packages. They were previously
 * launched as grenades — a claymore arcing across the map and exploding on a
 * fuse — which is worse than not having them, because the loadout screen
 * promised something the game did not do.
 *
 * The rule that makes placed equipment fair rather than infuriating: **anything
 * that kills you must be visible and destructible before it does.** Mines arm
 * with a delay, blink, only trigger in front of themselves, and can be shot.
 * Nothing here kills through a wall or without warning.
 */

import { anglesToForward, inCone, v3distance, v3set, v3sub, vec3, type Vec3 } from '../math.js';
import type { Rng } from '../rng.js';
import {
  DeployableKind,
  ProjectileKind,
  SimEventType,
  isEnemyTeam,
  type DeployableState,
  type EntityId,
  type PlayerId,
  type PlayerState,
  type ProjectileState,
  type SimEvent,
  type WorldState,
} from '../types.js';
import { CollisionLayer, type CollisionWorld, type QueryFilter } from '../collision/collision-types.js';
import { KILLSTREAKS } from '../data/killstreaks.js';

const SIGHT: QueryFilter = { layers: CollisionLayer.Sight };
const GROUND: QueryFilter = { layers: CollisionLayer.World | CollisionLayer.Breakable };

const _eye = vec3();
const _aim = vec3();
const _toTarget = vec3();
const _tmp = vec3();

/**
 * Behaviour per deployable kind.
 *
 * Held as one table rather than scattered through the step function, so the
 * balance of "how dangerous is this thing" is legible in one place.
 */
interface DeployableSpec {
  /** Seconds before it becomes dangerous. Nothing arms instantly. */
  armTime: number;
  health: number;
  /** Trigger radius for proximity weapons. */
  triggerRadius: number;
  /** Half-angle of the trigger arc. Claymores only face one way. */
  triggerArc: number;
  damage: number;
  blastRadius: number;
  /** How long it survives before removing itself, 0 = until destroyed. */
  lifetime: number;
  /** Uses before it is spent (ammo boxes, trophy systems). */
  charges: number;
  /** Does it physically block movement? */
  solid: boolean;
  size: Vec3;
}

const SPECS: Record<DeployableKind, DeployableSpec> = {
  [DeployableKind.Claymore]: {
    // A second and a half to arm, and it only watches its own front arc — you
    // can walk behind one, and a player who spots it can shoot it.
    armTime: 1.5, health: 30, triggerRadius: 4.5, triggerArc: 0.9,
    damage: 160, blastRadius: 5.0, lifetime: 0, charges: 1, solid: false,
    size: vec3(0.4, 0.3, 0.15),
  },
  [DeployableKind.ProximityMine]: {
    armTime: 2.0, health: 25, triggerRadius: 3.2, triggerArc: Math.PI,
    damage: 140, blastRadius: 4.5, lifetime: 0, charges: 1, solid: false,
    size: vec3(0.3, 0.12, 0.3),
  },
  [DeployableKind.C4Placed]: {
    // No proximity trigger at all — C4 is entirely under the owner's control,
    // which is what makes it a trap rather than a hazard.
    armTime: 0.4, health: 25, triggerRadius: 0, triggerArc: 0,
    damage: 190, blastRadius: 6.5, lifetime: 0, charges: 1, solid: false,
    size: vec3(0.25, 0.12, 0.2),
  },
  [DeployableKind.TrophySystem]: {
    armTime: 1.0, health: 60, triggerRadius: 8.0, triggerArc: Math.PI,
    damage: 0, blastRadius: 0, lifetime: 0, charges: 3, solid: false,
    size: vec3(0.4, 0.5, 0.4),
  },
  [DeployableKind.AmmoBox]: {
    armTime: 0.5, health: 80, triggerRadius: 2.5, triggerArc: Math.PI,
    damage: 0, blastRadius: 0, lifetime: 90, charges: 8, solid: false,
    size: vec3(0.7, 0.5, 0.5),
  },
  [DeployableKind.DeployableCover]: {
    armTime: 0.8, health: 250, triggerRadius: 0, triggerArc: 0,
    damage: 0, blastRadius: 0, lifetime: 0, charges: 0, solid: true,
    size: vec3(1.9, 1.15, 0.35),
  },
  [DeployableKind.TacticalInsertion]: {
    armTime: 1.0, health: 15, triggerRadius: 0, triggerArc: 0,
    damage: 0, blastRadius: 0, lifetime: 0, charges: 1, solid: false,
    size: vec3(0.2, 0.4, 0.2),
  },
  [DeployableKind.SentryGun]: {
    armTime: 2.5, health: 220, triggerRadius: 32, triggerArc: 1.4,
    damage: 22, blastRadius: 0, lifetime: 60, charges: 0, solid: true,
    size: vec3(0.7, 1.0, 0.7),
  },
  [DeployableKind.CarePackage]: {
    // Three seconds to fall and settle. With no delay the caller collected it on
    // the same tick they called it in, which removes the entire point of a care
    // package: that it lands in the open and has to be contested.
    armTime: 3.0, health: 200, triggerRadius: 2.0, triggerArc: Math.PI,
    damage: 0, blastRadius: 0, lifetime: 120, charges: 1, solid: true,
    size: vec3(1.2, 1.0, 1.2),
  },
};

export function deployableSpec(kind: DeployableKind): DeployableSpec {
  return SPECS[kind] ?? SPECS[DeployableKind.Claymore];
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/**
 * Where a placed item ends up.
 *
 * Traced onto the surface the player is looking at, within arm's reach, and
 * falling back to their feet. Placing at the feet unconditionally would make it
 * impossible to stick a claymore to a wall, which is most of what claymores are
 * for.
 */
export function placementPoint(
  collision: CollisionWorld,
  player: PlayerState,
  reach: number,
  out: Vec3,
): { position: Vec3; yaw: number; onWall: boolean } {
  v3set(_eye, player.position.x, player.position.y + 1.6, player.position.z);
  anglesToForward(_aim, player.yaw, player.pitch);

  const hit = collision.raycast(_eye, _aim, reach, GROUND, placeScratch);
  if (hit.hit) {
    // Nudge off the surface so it is not embedded in it.
    v3set(
      out,
      hit.point.x + hit.normal.x * 0.08,
      hit.point.y + hit.normal.y * 0.08,
      hit.point.z + hit.normal.z * 0.08,
    );
    const onWall = Math.abs(hit.normal.y) < 0.5;
    // A wall-mounted item faces out of the wall; a floor one faces where the
    // player was looking.
    const yaw = onWall ? Math.atan2(-hit.normal.x, -hit.normal.z) : player.yaw;
    return { position: out, yaw, onWall };
  }

  // Nothing in reach: drop it at the player's feet, facing their heading.
  const groundY = collision.groundHeightAt(player.position.x, player.position.z, player.position.y + 2, 6);
  v3set(
    out,
    player.position.x,
    Number.isFinite(groundY) ? groundY + 0.05 : player.position.y,
    player.position.z,
  );
  return { position: out, yaw: player.yaw, onWall: false };
}

const placeScratch = {
  hit: false, distance: 0, point: vec3(), normal: vec3(0, 1, 0),
  surface: 0 as never, entity: 0 as EntityId, brushIndex: -1, thickness: 0,
  layer: CollisionLayer.None,
};

/** Create a deployable in the world. Returns it so the caller can emit events. */
export function place(
  world: WorldState,
  kind: DeployableKind,
  owner: PlayerState,
  position: Vec3,
  yaw: number,
  allocId: () => EntityId,
  payload = '',
): DeployableState {
  const spec = deployableSpec(kind);
  const state: DeployableState = {
    id: allocId(),
    kind,
    owner: owner.id,
    team: owner.team,
    position: vec3(position.x, position.y, position.z),
    yaw,
    health: spec.health,
    armTime: spec.armTime,
    charges: spec.charges,
    age: 0,
    payload,
  };
  world.deployables.set(state.id, state);
  return state;
}

// ---------------------------------------------------------------------------
// Per-tick
// ---------------------------------------------------------------------------

export interface DeployableTickResult {
  events: SimEvent[];
  explosions: Array<{ position: Vec3; radius: number; damage: number; owner: PlayerId }>;
  /** Direct fire from sentry guns. */
  hits: Array<{ victim: PlayerId; attacker: PlayerId; damage: number; position: Vec3 }>;
  /** Players who should be resupplied from an ammo box this tick. */
  resupply: PlayerId[];
  /** Killstreaks granted by a collected care package. */
  grants: Array<{ player: PlayerId; killstreakId: string }>;
  /** Projectiles a trophy system destroyed. */
  intercepted: EntityId[];
}

const _tick: DeployableTickResult = {
  events: [], explosions: [], hits: [], resupply: [], grants: [], intercepted: [],
};

/** Last fire time per sentry, so they respect a rate of fire. */
const sentryFireTimes = new Map<EntityId, number>();
/** Which players have been resupplied recently, so a box isn't drained instantly. */
const resupplyTimes = new Map<string, number>();

export function stepDeployables(
  world: WorldState,
  collision: CollisionWorld,
  dt: number,
  rng: Rng,
): DeployableTickResult {
  _tick.events = [];
  _tick.explosions = [];
  _tick.hits = [];
  _tick.resupply = [];
  _tick.grants = [];
  _tick.intercepted = [];

  for (const dep of Array.from(world.deployables.values())) {
    dep.age += dt;
    if (dep.armTime > 0) dep.armTime = Math.max(0, dep.armTime - dt);

    const spec = deployableSpec(dep.kind);

    if (dep.health <= 0) {
      destroy(world, dep, spec, true);
      continue;
    }
    if (spec.lifetime > 0 && dep.age > spec.lifetime) {
      destroy(world, dep, spec, false);
      continue;
    }
    if (dep.armTime > 0) continue;

    switch (dep.kind) {
      case DeployableKind.Claymore:
      case DeployableKind.ProximityMine:
        stepMine(world, collision, dep, spec);
        break;
      case DeployableKind.TrophySystem:
        stepTrophy(world, dep, spec);
        break;
      case DeployableKind.AmmoBox:
        stepAmmoBox(world, dep, spec);
        break;
      case DeployableKind.SentryGun:
        stepSentry(world, collision, dep, spec, rng);
        break;
      case DeployableKind.CarePackage:
        stepCarePackage(world, dep, spec, rng);
        break;
      default:
        break;
    }
  }

  return _tick;
}

function destroy(
  world: WorldState,
  dep: DeployableState,
  spec: DeployableSpec,
  violent: boolean,
): void {
  world.deployables.delete(dep.id);
  sentryFireTimes.delete(dep.id);

  _tick.events.push({
    type: SimEventType.DeployableDestroyed,
    tick: world.tick,
    player: dep.owner,
    team: dep.team,
    position: { ...dep.position },
    data: { kind: dep.kind },
  } as SimEvent);

  // Shooting a mine sets it off — which is the reward for spotting it, and the
  // reason walking past one you have seen is still a decision.
  if (violent && spec.damage > 0) {
    _tick.explosions.push({
      position: dep.position,
      radius: spec.blastRadius,
      damage: spec.damage,
      owner: dep.owner,
    });
  }
}

function stepMine(
  world: WorldState,
  collision: CollisionWorld,
  dep: DeployableState,
  spec: DeployableSpec,
): void {
  anglesToForward(_aim, dep.yaw, 0);

  for (const player of world.players.values()) {
    if (!player.alive) continue;
    if (!isEnemyTeam(dep.team, player.team)) continue;

    v3set(_toTarget, player.position.x, player.position.y + 0.9, player.position.z);
    if (!inCone(dep.position, _aim, _toTarget, spec.triggerArc, spec.triggerRadius)) continue;
    // Cover blocks the trigger, so a mine cannot kill through a wall.
    if (!collision.isVisible(dep.position, _toTarget, SIGHT)) continue;

    _tick.explosions.push({
      position: dep.position,
      radius: spec.blastRadius,
      damage: spec.damage,
      owner: dep.owner,
    });
    _tick.events.push({
      type: SimEventType.Explosion,
      tick: world.tick,
      position: { ...dep.position },
      radius: spec.blastRadius,
      owner: dep.owner,
      kind: ProjectileKind.ClaymoreProjectile,
    } as SimEvent);
    world.deployables.delete(dep.id);
    return;
  }
}

/**
 * Trophy systems shoot down incoming explosives.
 *
 * They intercept projectiles rather than blocking damage, so a grenade thrown at
 * a trophy is genuinely wasted — and once its charges are spent the position is
 * open again, which keeps a defended room from being permanently sealed.
 */
function stepTrophy(world: WorldState, dep: DeployableState, spec: DeployableSpec): void {
  if (dep.charges <= 0) return;

  for (const proj of world.projectiles.values()) {
    if (!isEnemyTeam(dep.team, proj.team)) continue;
    if (v3distance(dep.position, proj.position) > spec.triggerRadius) continue;

    _tick.intercepted.push(proj.id);
    dep.charges--;

    _tick.events.push({
      type: SimEventType.Explosion,
      tick: world.tick,
      position: { ...proj.position },
      radius: 1.2,
      owner: dep.owner,
      kind: 'killstreak',
    } as SimEvent);

    if (dep.charges <= 0) return;
  }
}

function stepAmmoBox(world: WorldState, dep: DeployableState, spec: DeployableSpec): void {
  if (dep.charges <= 0) return;

  for (const player of world.players.values()) {
    if (!player.alive) continue;
    // Friendly-only, so an ammo box is not a gift to whoever pushes you off it.
    if (isEnemyTeam(dep.team, player.team)) continue;
    if (v3distance(dep.position, player.position) > spec.triggerRadius) continue;

    const key = `${dep.id}:${player.id}`;
    const last = resupplyTimes.get(key) ?? -999;
    if (world.time - last < 8) continue;

    resupplyTimes.set(key, world.time);
    dep.charges--;
    _tick.resupply.push(player.id);
    if (dep.charges <= 0) return;
  }
}

function stepSentry(
  world: WorldState,
  collision: CollisionWorld,
  dep: DeployableState,
  spec: DeployableSpec,
  rng: Rng,
): void {
  // Find the nearest enemy inside the arc with line of sight.
  anglesToForward(_aim, dep.yaw, 0);
  let best: PlayerState | null = null;
  let bestDist = spec.triggerRadius;

  v3set(_tmp, dep.position.x, dep.position.y + 0.7, dep.position.z);

  for (const player of world.players.values()) {
    if (!player.alive || !isEnemyTeam(dep.team, player.team)) continue;
    const d = v3distance(_tmp, player.position);
    if (d >= bestDist) continue;
    v3set(_toTarget, player.position.x, player.position.y + 1.0, player.position.z);
    if (!inCone(_tmp, _aim, _toTarget, spec.triggerArc, spec.triggerRadius)) continue;
    if (!collision.isVisible(_tmp, _toTarget, SIGHT)) continue;
    best = player;
    bestDist = d;
  }

  if (!best) return;

  // Track toward the target rather than snapping, so it can be outflanked.
  v3sub(_toTarget, best.position, dep.position);
  const desired = Math.atan2(-_toTarget.x, -_toTarget.z);
  let delta = desired - dep.yaw;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  const maxTurn = 2.2 * (1 / 64);
  dep.yaw += Math.max(-maxTurn, Math.min(maxTurn, delta));

  // Only fire once actually pointed at them.
  if (Math.abs(delta) > 0.25) return;

  const last = sentryFireTimes.get(dep.id) ?? -999;
  if (world.time - last < 0.12) return;
  sentryFireTimes.set(dep.id, world.time);

  // Deliberately imperfect: a turret that never misses is not a fight.
  if (!rng.chance(0.55)) return;

  _tick.hits.push({
    victim: best.id,
    attacker: dep.owner,
    damage: spec.damage,
    position: { ...best.position },
  });
}

/**
 * Care packages.
 *
 * Either team can take one, which is the whole point — a package landing near
 * the enemy is a fight worth having rather than a guaranteed reward.
 */
function stepCarePackage(
  world: WorldState,
  dep: DeployableState,
  spec: DeployableSpec,
  rng: Rng,
): void {
  if (dep.charges <= 0) return;

  for (const player of world.players.values()) {
    if (!player.alive) continue;
    if (v3distance(dep.position, player.position) > spec.triggerRadius) continue;

    const streak = dep.payload || rollCarePackage(rng);
    dep.charges = 0;
    _tick.grants.push({ player: player.id, killstreakId: streak });
    _tick.events.push({
      type: SimEventType.KillstreakEarned,
      tick: world.tick,
      player: player.id,
      team: player.team,
      data: { killstreakId: streak, fromCarePackage: true },
    } as SimEvent);
    world.deployables.delete(dep.id);
    return;
  }
}

/**
 * What a care package contains.
 *
 * Weighted toward the mid tier. A package that is usually a UAV is not worth
 * contesting; one that is often a Gunship makes the streak that dropped it the
 * only one worth running.
 */
export function rollCarePackage(rng: Rng): string {
  const table: Array<[string, number]> = [
    ['uav', 14],
    ['counter_uav', 8],
    ['precision_airstrike', 14],
    ['cluster_strike', 12],
    ['sentry_gun', 11],
    ['cruise_missile', 9],
    ['attack_chopper', 8],
    ['vtol_jet', 5],
    ['chopper_gunner', 4],
    ['juggernaut', 2],
  ];
  const available = table.filter(([id]) => KILLSTREAKS[id]);
  if (available.length === 0) return 'uav';
  return rng.pickWeighted(
    available.map(([id]) => id),
    available.map(([, w]) => w),
  );
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Solid deployables, so the collision world can include them. */
export function solidDeployables(world: WorldState): DeployableState[] {
  const out: DeployableState[] = [];
  for (const dep of world.deployables.values()) {
    if (deployableSpec(dep.kind).solid) out.push(dep);
  }
  return out;
}

/** A player's tactical insertion, if they have a live one. */
export function findInsertion(world: WorldState, playerId: PlayerId): DeployableState | null {
  for (const dep of world.deployables.values()) {
    if (dep.kind === DeployableKind.TacticalInsertion && dep.owner === playerId) return dep;
  }
  return null;
}

/** Detonate every C4 a player owns. Called when they press the lethal key again. */
export function detonateC4(world: WorldState, playerId: PlayerId): Array<{ position: Vec3; radius: number; damage: number; owner: PlayerId }> {
  const out: Array<{ position: Vec3; radius: number; damage: number; owner: PlayerId }> = [];
  for (const dep of Array.from(world.deployables.values())) {
    if (dep.kind !== DeployableKind.C4Placed || dep.owner !== playerId) continue;
    if (dep.armTime > 0) continue;
    const spec = deployableSpec(dep.kind);
    out.push({
      position: vec3(dep.position.x, dep.position.y, dep.position.z),
      radius: spec.blastRadius,
      damage: spec.damage,
      owner: playerId,
    });
    world.deployables.delete(dep.id);
  }
  return out;
}

/** Remove everything a player owns. Used on disconnect and round reset. */
export function clearOwned(world: WorldState, playerId: PlayerId): void {
  for (const [id, dep] of Array.from(world.deployables)) {
    if (dep.owner === playerId) {
      world.deployables.delete(id);
      sentryFireTimes.delete(id);
    }
  }
}

export function resetDeployables(world: WorldState): void {
  world.deployables.clear();
  sentryFireTimes.clear();
  resupplyTimes.clear();
}

/**
 * Apply bullet damage to a deployable. Returns true if it was destroyed.
 * Exposed so ballistics can route hits here without knowing the specs.
 */
export function damageDeployable(
  world: WorldState,
  id: EntityId,
  amount: number,
): boolean {
  const dep = world.deployables.get(id);
  if (!dep) return false;
  dep.health -= amount;
  return dep.health <= 0;
}

/** Is a projectile inside a live trophy system's intercept radius? */
export function isInterceptable(world: WorldState, proj: ProjectileState): boolean {
  for (const dep of world.deployables.values()) {
    if (dep.kind !== DeployableKind.TrophySystem || dep.charges <= 0 || dep.armTime > 0) continue;
    if (!isEnemyTeam(dep.team, proj.team)) continue;
    if (v3distance(dep.position, proj.position) <= deployableSpec(dep.kind).triggerRadius) return true;
  }
  return false;
}

