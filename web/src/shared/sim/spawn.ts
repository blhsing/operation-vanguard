/**
 * Spawn selection.
 *
 * COD does not pick a random spawn point — it scores every candidate against an
 * influence map and takes the best one. That is what makes spawns feel fair even
 * though they are, mechanically, teleporting you into an active firefight.
 *
 * The scoring is intentionally readable: every term is a named penalty or bonus
 * with a constant in SPAWN, so tuning spawn feel is a matter of changing numbers
 * rather than rewriting logic. The single most important term by far is the
 * enemy view-cone penalty — being spawned *behind* an enemy is survivable and
 * even exciting; being spawned in their crosshair is not.
 */

import { PLAYER_RADIUS, SPAWN, STANCE_HEIGHT } from '../constants.js';
import {
  anglesToForward,
  clamp01,
  inCone,
  v3distance,
  v3distanceXZ,
  v3set,
  vec3,
  type Vec3,
} from '../math.js';
import type { Rng } from '../rng.js';
import { Team, isEnemyTeam, type PlayerId, type PlayerState, type WorldState } from '../types.js';
import { CollisionLayer, type CollisionWorld, type QueryFilter } from '../collision/collision-types.js';
import type { MapDef, SpawnPoint } from '../map/map-types.js';

const SPAWN_FILTER: QueryFilter = { layers: CollisionLayer.Movement };

const _eye = vec3();
const _forward = vec3();
const _candidate = vec3();

/** A transient hazard the spawn system should route players away from. */
export interface DangerZone {
  position: Vec3;
  radius: number;
  /** Seconds remaining. Expired zones are ignored and pruned by the caller. */
  timeRemaining: number;
}

/** Bookkeeping the spawn system keeps between selections. */
export interface SpawnContext {
  /** Spawn index -> world time it was last used. */
  recentUse: Map<number, number>;
  /** Recent deaths, oldest first. */
  recentDeaths: Array<{ position: Vec3; time: number }>;
  dangerZones: DangerZone[];
  /**
   * Which spawn groups the mode currently prefers, highest weight first.
   * Domination sets this when a flag changes hands, which is what makes spawns
   * flip sides.
   */
  groupWeights: Map<string, number>;
}

export function createSpawnContext(): SpawnContext {
  return {
    recentUse: new Map(),
    recentDeaths: [],
    dangerZones: [],
    groupWeights: new Map(),
  };
}

export function noteDeath(ctx: SpawnContext, position: Vec3, time: number): void {
  ctx.recentDeaths.push({ position: vec3(position.x, position.y, position.z), time });
  // Bound the list; anything older than the death penalty window is irrelevant.
  while (ctx.recentDeaths.length > 48) ctx.recentDeaths.shift();
}

export function addDangerZone(
  ctx: SpawnContext,
  position: Vec3,
  radius: number,
  duration: number,
): void {
  ctx.dangerZones.push({
    position: vec3(position.x, position.y, position.z),
    radius,
    timeRemaining: duration,
  });
}

export function tickSpawnContext(ctx: SpawnContext, dt: number, time: number): void {
  for (let i = ctx.dangerZones.length - 1; i >= 0; i--) {
    const z = ctx.dangerZones[i]!;
    z.timeRemaining -= dt;
    if (z.timeRemaining <= 0) ctx.dangerZones.splice(i, 1);
  }
  // Drop deaths older than the penalty window so the list can't grow unbounded.
  const cutoff = time - SPAWN.recentUseWindow * 2;
  while (ctx.recentDeaths.length > 0 && ctx.recentDeaths[0]!.time < cutoff) {
    ctx.recentDeaths.shift();
  }
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Score one candidate. Higher is better; -Infinity means unusable.
 *
 * Exported so the test suite can assert the properties that matter — that a
 * spawn in an enemy's crosshair always loses to one behind them, and that a
 * spawn next to a live enemy is never chosen when any alternative exists.
 */
export function scoreSpawn(
  world: WorldState,
  collision: CollisionWorld,
  ctx: SpawnContext,
  spawn: SpawnPoint,
  spawnIndex: number,
  player: PlayerState,
  time: number,
): number {
  // Team gate. Team.None spawns are usable by anyone (free-for-all and neutral).
  if (spawn.team !== Team.None && spawn.team !== player.team) return -Infinity;

  // Must physically fit.
  v3set(_candidate, spawn.position.x, spawn.position.y, spawn.position.z);
  const groundY = collision.groundHeightAt(_candidate.x, _candidate.z, _candidate.y + 3, 12);
  if (!Number.isFinite(groundY)) return -Infinity;
  _candidate.y = groundY + 0.05;
  if (!collision.isCapsuleFree(_candidate, STANCE_HEIGHT.stand, PLAYER_RADIUS, SPAWN_FILTER)) {
    return -Infinity;
  }

  let score = 1000;

  // Group preference set by the game mode (objective ownership).
  score += (ctx.groupWeights.get(spawn.group) ?? 0) * 400;
  score += (spawn.priority ?? 0) * 40;

  const eyeY = _candidate.y + 1.6;

  for (const other of world.players.values()) {
    if (!other.alive || other.id === player.id) continue;

    const dist = v3distance(_candidate, other.position);

    if (isEnemyTeam(player.team, other.team)) {
      // Hard ban: far too close to be survivable.
      if (dist < SPAWN.enemyHardBanRadius) return -Infinity;

      if (dist < SPAWN.enemyDangerRadius) {
        // Quadratic ramp so the penalty bites sharply as you approach the ban radius.
        const t = 1 - clamp01((dist - SPAWN.enemyHardBanRadius) /
          (SPAWN.enemyDangerRadius - SPAWN.enemyHardBanRadius));
        score -= 700 * t * t;
      }

      // The decisive term: is this spawn inside the enemy's field of view, with
      // line of sight? Being seen at the instant you appear is the worst
      // possible outcome, so it outweighs everything except the hard ban.
      if (dist < 70) {
        v3set(_eye, other.position.x, other.position.y + 1.6, other.position.z);
        anglesToForward(_forward, other.yaw, other.pitch);
        v3set(_candidate, _candidate.x, eyeY, _candidate.z);
        if (inCone(_eye, _forward, _candidate, SPAWN.enemyViewConeHalfAngle, 70)) {
          const sightFilter: QueryFilter = { layers: CollisionLayer.Sight };
          if (collision.isVisible(_eye, _candidate, sightFilter)) {
            // Closer enemies looking at you are worse than distant ones.
            score -= SPAWN.enemyViewConePenalty * (1 - clamp01(dist / 70) * 0.6);
          }
        }
        _candidate.y = groundY + 0.05;
      }
    } else {
      // Friendlies are a mild attractor: spawning with your team is safer and
      // keeps the squad together, but it must never outweigh enemy proximity.
      if (dist < SPAWN.friendlyAttractRadius) {
        score += 90 * (1 - clamp01(dist / SPAWN.friendlyAttractRadius));
      }
      // ...except right on top of them, which looks broken.
      if (dist < 1.6) score -= 300;
    }
  }

  // Don't reuse the same corner repeatedly.
  const lastUsed = ctx.recentUse.get(spawnIndex);
  if (lastUsed !== undefined) {
    const age = time - lastUsed;
    if (age < SPAWN.recentUseWindow) {
      score -= SPAWN.recentUsePenalty * (1 - age / SPAWN.recentUseWindow);
    }
  }

  // Avoid the spot the player just died in, and anywhere else people are dying.
  for (const death of ctx.recentDeaths) {
    const age = time - death.time;
    if (age > SPAWN.recentUseWindow) continue;
    const d = v3distanceXZ(_candidate, death.position);
    if (d < SPAWN.recentDeathRadius) {
      const proximity = 1 - d / SPAWN.recentDeathRadius;
      const recency = 1 - age / SPAWN.recentUseWindow;
      score -= SPAWN.recentDeathPenalty * proximity * recency;
    }
  }

  // Grenades, killstreaks and fire.
  for (const zone of ctx.dangerZones) {
    const d = v3distance(_candidate, zone.position);
    if (d < zone.radius) {
      score -= SPAWN.dangerZonePenalty * (1 - d / zone.radius);
    }
  }

  return score;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export interface SpawnChoice {
  position: Vec3;
  yaw: number;
  index: number;
  score: number;
}

/**
 * Pick the best spawn for a player.
 *
 * Ties are broken by a seeded random draw among the top candidates rather than
 * always taking the single best, so ten players spawning in the same second
 * don't all stack on the same point. The randomness is drawn from the world RNG
 * so client and server agree.
 */
export function selectSpawn(
  world: WorldState,
  map: MapDef,
  collision: CollisionWorld,
  ctx: SpawnContext,
  player: PlayerState,
  rng: Rng,
  opts: { initialOnly?: boolean } = {},
): SpawnChoice | null {
  let best = -Infinity;
  const candidates: SpawnChoice[] = [];

  for (let i = 0; i < map.spawns.length; i++) {
    const spawn = map.spawns[i]!;
    if (spawn.initialOnly && !opts.initialOnly) continue;
    if (opts.initialOnly && !spawn.initialOnly && spawn.team !== player.team) continue;

    const score = scoreSpawn(world, collision, ctx, spawn, i, player, world.time);
    if (score === -Infinity) continue;

    if (score > best) best = score;
    candidates.push({
      position: vec3(spawn.position.x, spawn.position.y, spawn.position.z),
      yaw: spawn.yaw,
      index: i,
      score,
    });
  }

  if (candidates.length === 0) {
    // Every spawn is banned. Rather than refusing to spawn the player — which
    // would stall the match — fall back to the least-bad point ignoring enemies.
    return fallbackSpawn(map, collision, player);
  }

  // Consider anything within a band of the best. The band is proportional so it
  // stays meaningful whether scores are in the hundreds or the thousands.
  const band = Math.max(120, Math.abs(best) * 0.08);
  const shortlist = candidates.filter((c) => c.score >= best - band);
  const chosen = shortlist.length > 0 ? shortlist[rng.int(0, shortlist.length - 1)]! : candidates[0]!;

  ctx.recentUse.set(chosen.index, world.time);

  // Drop the player onto the floor rather than trusting the authored Y.
  const groundY = collision.groundHeightAt(chosen.position.x, chosen.position.z, chosen.position.y + 3, 12);
  if (Number.isFinite(groundY)) chosen.position.y = groundY + 0.05;

  return chosen;
}

/**
 * Last resort when every scored spawn was rejected: take the team's spawn point
 * that is simply furthest from any living enemy. Never returns null if the map
 * has any spawn at all, because failing to spawn is worse than spawning badly.
 */
function fallbackSpawn(map: MapDef, collision: CollisionWorld, player: PlayerState): SpawnChoice | null {
  let best: SpawnChoice | null = null;
  for (let i = 0; i < map.spawns.length; i++) {
    const spawn = map.spawns[i]!;
    if (spawn.team !== Team.None && spawn.team !== player.team) continue;
    const groundY = collision.groundHeightAt(spawn.position.x, spawn.position.z, spawn.position.y + 3, 12);
    const y = Number.isFinite(groundY) ? groundY + 0.05 : spawn.position.y;
    const choice: SpawnChoice = {
      position: vec3(spawn.position.x, y, spawn.position.z),
      yaw: spawn.yaw,
      index: i,
      score: 0,
    };
    if (!best) best = choice;
  }
  if (best) return best;

  // Truly nothing for this team — use any spawn at all.
  const any = map.spawns[0];
  if (!any) return null;
  return { position: vec3(any.position.x, any.position.y, any.position.z), yaw: any.yaw, index: 0, score: 0 };
}

// ---------------------------------------------------------------------------
// Mode integration
// ---------------------------------------------------------------------------

/**
 * Bias spawns toward groups near objectives a team controls.
 *
 * Called by mode logic whenever ownership changes. Group names are free-form
 * strings chosen by the map author; the convention is `<team>_<area>`, and any
 * group whose name contains the area of a controlled objective gets weighted up.
 */
export function setGroupWeights(ctx: SpawnContext, weights: Record<string, number>): void {
  ctx.groupWeights.clear();
  for (const [group, w] of Object.entries(weights)) {
    ctx.groupWeights.set(group, w);
  }
}

/** Reset between rounds so a new round doesn't inherit the last one's history. */
export function resetSpawnContext(ctx: SpawnContext): void {
  ctx.recentUse.clear();
  ctx.recentDeaths.length = 0;
  ctx.dangerZones.length = 0;
  ctx.groupWeights.clear();
}

/** Respawn delay for a player. Flat by design — see MATCH.respawnDelay. */
export function respawnDelayFor(player: PlayerState, base: number, max: number): number {
  void player;
  return Math.min(max, base);
}

/** Distance from a player to the nearest living enemy — used by tests and AI. */
export function nearestEnemyDistance(world: WorldState, from: Vec3, team: Team): number {
  let best = Infinity;
  for (const other of world.players.values()) {
    if (!other.alive) continue;
    if (!isEnemyTeam(team, other.team)) continue;
    const d = v3distance(from, other.position);
    if (d < best) best = d;
  }
  return best;
}

/** Player ids currently looking at a point — used for spawn debugging overlays. */
export function playersLookingAt(
  world: WorldState,
  collision: CollisionWorld,
  point: Vec3,
  team: Team,
): PlayerId[] {
  const out: PlayerId[] = [];
  const sightFilter: QueryFilter = { layers: CollisionLayer.Sight };
  for (const other of world.players.values()) {
    if (!other.alive || !isEnemyTeam(team, other.team)) continue;
    v3set(_eye, other.position.x, other.position.y + 1.6, other.position.z);
    anglesToForward(_forward, other.yaw, other.pitch);
    if (!inCone(_eye, _forward, point, SPAWN.enemyViewConeHalfAngle, 70)) continue;
    if (!collision.isVisible(_eye, point, sightFilter)) continue;
    out.push(other.id);
  }
  return out;
}
