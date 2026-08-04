/**
 * Killstreaks, made real.
 *
 * The definitions in data/killstreaks.ts describe what a streak costs and what
 * it claims to do; this is what actually happens when someone calls one in.
 *
 * The design rule throughout: **a killstreak must be counterable.** Anything
 * that puts damage on the map has a warning, a delay, and a way to be shot down
 * or avoided — a reward that simply deletes the enemy team stops being exciting
 * the second time you are on the receiving end. So the airstrike paints its
 * target and takes four seconds to arrive, the chopper can be shot out of the
 * sky, and the UAV gives away that it is up.
 */

import { anglesToForward, v3distance, v3set, vec3, type Vec3 } from '../math.js';
import type { Rng } from '../rng.js';
import {
  KillstreakVehicleKind,
  SimEventType,
  Team,
  isEnemyTeam,
  type EntityId,
  type KillstreakEntityState,
  type PlayerId,
  type PlayerState,
  type SimEvent,
  type WorldState,
} from '../types.js';
import { KILLSTREAKS, type KillstreakDef } from '../data/killstreaks.js';
import type { CollisionWorld } from '../collision/collision-types.js';
import { CollisionLayer, type QueryFilter } from '../collision/collision-types.js';

// ---------------------------------------------------------------------------
// Team-wide effects
// ---------------------------------------------------------------------------

/**
 * Effects that apply to a whole team rather than to an entity in the world.
 * Kept separate because they have no position, cannot be shot down, and every
 * consumer (minimap, HUD, AI) asks "is this active for my team" rather than
 * looking for an entity.
 */
export interface TeamEffects {
  /** Seconds of UAV coverage remaining — reveals enemies on the minimap. */
  uav: number;
  /** Advanced UAV also shows facing direction. */
  advancedUav: number;
  /** Counter-UAV jams the ENEMY minimap for this long. */
  counterUav: number;
  /** EMP disables enemy HUD and equipment. */
  emp: number;
}

function emptyEffects(): TeamEffects {
  return { uav: 0, advancedUav: 0, counterUav: 0, emp: 0 };
}

export interface KillstreakRuntime {
  effects: Map<Team, TeamEffects>;
  /** Scripted strikes in flight, resolved when their delay expires. */
  pendingStrikes: PendingStrike[];
  /** Next id for entities this system spawns. */
  nextId: number;
}

interface PendingStrike {
  kind: 'airstrike' | 'cluster' | 'cruise';
  owner: PlayerId;
  team: Team;
  target: Vec3;
  /** Seconds until impact. */
  delay: number;
  damage: number;
  radius: number;
  /** How many separate explosions this strike delivers. */
  bombs: number;
  /** Seconds between successive explosions in a run. */
  spacing: number;
  /** Which bomb we are up to. */
  fired: number;
  /** Direction the run travels, so bombs walk across the target. */
  heading: Vec3;
}

export function createKillstreakRuntime(): KillstreakRuntime {
  return {
    effects: new Map([
      [Team.Allies, emptyEffects()],
      [Team.Axis, emptyEffects()],
      [Team.None, emptyEffects()],
    ]),
    pendingStrikes: [],
    nextId: 50000,
  };
}

export function teamEffects(rt: KillstreakRuntime, team: Team): TeamEffects {
  let e = rt.effects.get(team);
  if (!e) {
    e = emptyEffects();
    rt.effects.set(team, e);
  }
  return e;
}

/**
 * Whether a team's minimap currently reveals enemies.
 *
 * Counter-UAV beats UAV: jamming is the direct counter to reconnaissance, and
 * making the newer or more expensive streak win instead would mean the counter
 * only works when you are already ahead.
 */
export function hasRadar(rt: KillstreakRuntime, team: Team): boolean {
  const own = teamEffects(rt, team);
  if (own.uav <= 0 && own.advancedUav <= 0) return false;
  for (const [other, effects] of rt.effects) {
    if (other === team || !isEnemyTeam(team, other)) continue;
    if (effects.counterUav > 0) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Calling one in
// ---------------------------------------------------------------------------

export interface KillstreakResult {
  events: SimEvent[];
  /** Entities to add to the world. */
  spawned: KillstreakEntityState[];
  /** True if the streak was consumed. */
  used: boolean;
  /** Set when the streak ends the match outright (the nuke). */
  endsMatch: boolean;
}

const _result: KillstreakResult = { events: [], spawned: [], used: false, endsMatch: false };
const _aim = vec3();
const _eye = vec3();

const STRIKE_FILTER: QueryFilter = { layers: CollisionLayer.World | CollisionLayer.Breakable };

/**
 * Call in a killstreak on behalf of a player.
 *
 * Offensive streaks are aimed: the target is wherever the player is looking,
 * traced onto the world. That is deliberate — it makes calling one a decision
 * rather than a button, and it means a badly-placed airstrike is the caller's
 * fault rather than the game's.
 */
export function callKillstreak(
  world: WorldState,
  collision: CollisionWorld,
  rt: KillstreakRuntime,
  player: PlayerState,
  streakId: string,
  rng: Rng,
): KillstreakResult {
  _result.events = [];
  _result.spawned = [];
  _result.used = false;
  _result.endsMatch = false;

  const def = KILLSTREAKS[streakId];
  if (!def) return _result;

  const idx = player.killstreakInventory.indexOf(streakId);
  if (idx < 0) return _result;

  // Where is the player pointing?
  v3set(_eye, player.position.x, player.position.y + 1.6, player.position.z);
  anglesToForward(_aim, player.yaw, player.pitch);
  const target = traceToGround(collision, _eye, _aim);

  switch (streakId) {
    case 'uav':
      teamEffects(rt, player.team).uav = def.duration;
      break;

    case 'advanced_uav':
      teamEffects(rt, player.team).advancedUav = def.duration;
      teamEffects(rt, player.team).uav = def.duration;
      break;

    case 'counter_uav':
      teamEffects(rt, player.team).counterUav = def.duration;
      break;

    case 'emp_burst':
      // EMP hits every enemy team.
      for (const [team, effects] of rt.effects) {
        if (isEnemyTeam(player.team, team)) effects.emp = def.duration;
      }
      break;

    case 'precision_airstrike':
      rt.pendingStrikes.push({
        kind: 'airstrike',
        owner: player.id,
        team: player.team,
        target,
        // Long enough that the warning is actionable. A strike that lands
        // before anyone can move is not a killstreak, it is a cutscene.
        delay: 4.0,
        damage: def.damage ?? 180,
        radius: def.radius ?? 7,
        bombs: 6,
        spacing: 0.18,
        fired: 0,
        heading: strikeHeading(player),
      });
      break;

    case 'cluster_strike':
      rt.pendingStrikes.push({
        kind: 'cluster',
        owner: player.id,
        team: player.team,
        target,
        delay: 3.0,
        damage: def.damage ?? 130,
        radius: def.radius ?? 5,
        bombs: 9,
        spacing: 0.12,
        fired: 0,
        heading: strikeHeading(player),
      });
      break;

    case 'cruise_missile':
      rt.pendingStrikes.push({
        kind: 'cruise',
        owner: player.id,
        team: player.team,
        target,
        delay: 2.5,
        damage: def.damage ?? 220,
        radius: def.radius ?? 9,
        bombs: 1,
        spacing: 0,
        fired: 0,
        heading: strikeHeading(player),
      });
      break;

    case 'sentry_gun':
    case 'care_package':
      // Deployables are placed at the player's feet by the caller; this system
      // only needs to record that the streak was spent.
      break;

    case 'attack_chopper':
    case 'chopper_gunner':
    case 'vtol_jet':
    case 'gunship': {
      const entity = spawnAirVehicle(rt, def, player, world);
      _result.spawned.push(entity);
      break;
    }

    case 'juggernaut':
      // Armour is applied to the caller directly and is the whole reward.
      player.maxHealth = 400;
      player.health = 400;
      break;

    case 'tactical_nuke':
      _result.endsMatch = true;
      break;

    default:
      break;
  }

  player.killstreakInventory.splice(idx, 1);
  _result.used = true;

  _result.events.push({
    type: SimEventType.KillstreakCalled,
    tick: world.tick,
    player: player.id,
    team: player.team,
    data: { killstreakId: streakId, target: { ...target } },
  } as SimEvent);

  // Both teams hear about it, but they hear different things.
  _result.events.push({
    type: SimEventType.Announce,
    tick: world.tick,
    team: player.team,
    line: def.friendlyAnnounce,
  } as SimEvent);
  if (def.enemyAnnounce) {
    _result.events.push({
      type: SimEventType.Announce,
      tick: world.tick,
      team: opposing(player.team),
      line: def.enemyAnnounce,
    } as SimEvent);
  }

  void rng;
  return _result;
}

function opposing(team: Team): Team {
  return team === Team.Allies ? Team.Axis : Team.Allies;
}

/** The direction a bombing run travels, so bombs walk away from the caller. */
function strikeHeading(player: PlayerState): Vec3 {
  const h = vec3();
  anglesToForward(h, player.yaw, 0);
  return h;
}

/** Trace the player's aim onto the world; falls back to a point ahead of them. */
function traceToGround(collision: CollisionWorld, origin: Vec3, dir: Vec3): Vec3 {
  const hit = collision.raycast(origin, dir, 300, STRIKE_FILTER, _traceHit);
  if (hit.hit) return vec3(hit.point.x, hit.point.y, hit.point.z);

  // Looking at the sky: drop the strike 60m ahead at ground level.
  const x = origin.x + dir.x * 60;
  const z = origin.z + dir.z * 60;
  const ground = collision.groundHeightAt(x, z, origin.y + 50, 200);
  return vec3(x, Number.isFinite(ground) ? ground : origin.y, z);
}

const _traceHit = {
  hit: false,
  distance: 0,
  point: vec3(),
  normal: vec3(0, 1, 0),
  surface: 0 as never,
  entity: 0 as EntityId,
  brushIndex: -1,
  thickness: 0,
  layer: CollisionLayer.None,
};

function spawnAirVehicle(
  rt: KillstreakRuntime,
  def: KillstreakDef,
  player: PlayerState,
  world: WorldState,
): KillstreakEntityState {
  const kind = def.vehicle ?? KillstreakVehicleKind.Chopper;
  // Enter from the caller's side of the map, high up.
  const entry = vec3(player.position.x * 0.4, 42, player.position.z * 1.4);
  return {
    id: rt.nextId++,
    kind,
    owner: player.id,
    team: player.team,
    position: entry,
    velocity: vec3(),
    yaw: player.yaw,
    pitch: 0,
    health: def.health ?? 900,
    timeRemaining: def.duration,
    controlled: def.kind === 'controlled',
    pathIndex: 0,
  };
  void world;
}

// ---------------------------------------------------------------------------
// Per-tick
// ---------------------------------------------------------------------------

export interface KillstreakTickResult {
  events: SimEvent[];
  /** Explosions to resolve, in world space. */
  explosions: Array<{ position: Vec3; radius: number; damage: number; owner: PlayerId }>;
  /** Direct damage from vehicle weapons. */
  hits: Array<{ victim: PlayerId; attacker: PlayerId; damage: number; position: Vec3 }>;
}

const _tick: KillstreakTickResult = { events: [], explosions: [], hits: [] };
const _toTarget = vec3();

export function stepKillstreaks(
  world: WorldState,
  collision: CollisionWorld,
  rt: KillstreakRuntime,
  dt: number,
  rng: Rng,
): KillstreakTickResult {
  _tick.events = [];
  _tick.explosions = [];
  _tick.hits = [];

  // --- team effects --------------------------------------------------------
  for (const effects of rt.effects.values()) {
    effects.uav = Math.max(0, effects.uav - dt);
    effects.advancedUav = Math.max(0, effects.advancedUav - dt);
    effects.counterUav = Math.max(0, effects.counterUav - dt);
    effects.emp = Math.max(0, effects.emp - dt);
  }

  // --- pending strikes -----------------------------------------------------
  for (let i = rt.pendingStrikes.length - 1; i >= 0; i--) {
    const strike = rt.pendingStrikes[i]!;
    strike.delay -= dt;
    if (strike.delay > 0) continue;

    // Bombs land in sequence, walking along the run's heading. The walk is what
    // makes an airstrike feel like aircraft passing over rather than a single
    // instant deletion of a circle.
    const spread = strike.kind === 'cluster' ? 9 : 7;
    const offset = (strike.fired - (strike.bombs - 1) / 2) * (spread / Math.max(1, strike.bombs - 1)) * 2;

    const lateral = strike.kind === 'cluster' ? rng.signed(spread) : 0;
    const pos = vec3(
      strike.target.x + strike.heading.x * offset - strike.heading.z * lateral,
      strike.target.y + 0.4,
      strike.target.z + strike.heading.z * offset + strike.heading.x * lateral,
    );

    _tick.explosions.push({
      position: pos,
      radius: strike.radius,
      damage: strike.damage,
      owner: strike.owner,
    });
    _tick.events.push({
      type: SimEventType.Explosion,
      tick: world.tick,
      position: pos,
      radius: strike.radius,
      owner: strike.owner,
      kind: 'killstreak',
    } as SimEvent);

    strike.fired++;
    if (strike.fired >= strike.bombs) {
      rt.pendingStrikes.splice(i, 1);
    } else {
      strike.delay = strike.spacing;
    }
  }

  // --- vehicles ------------------------------------------------------------
  for (const vehicle of Array.from(world.killstreakEntities.values())) {
    vehicle.timeRemaining -= dt;

    if (vehicle.timeRemaining <= 0 || vehicle.health <= 0) {
      world.killstreakEntities.delete(vehicle.id);
      if (vehicle.health <= 0) {
        _tick.events.push({
          type: SimEventType.KillstreakDestroyed,
          tick: world.tick,
          player: vehicle.owner,
          team: vehicle.team,
          position: { ...vehicle.position },
          data: { kind: vehicle.kind },
        } as SimEvent);
        _tick.explosions.push({
          position: vehicle.position,
          radius: 6,
          damage: 100,
          owner: 0,
        });
      }
      continue;
    }

    stepVehicle(world, collision, vehicle, dt, rng);
  }

  return _tick;
}

/**
 * Fly a killstreak vehicle and let it shoot.
 *
 * Uncontrolled aircraft orbit the map centre rather than chasing players: an
 * autonomous gunship that tracks you perfectly is not a reward for the caller,
 * it is a punishment for everyone else with no counterplay except waiting.
 */
function stepVehicle(
  world: WorldState,
  collision: CollisionWorld,
  vehicle: KillstreakEntityState,
  dt: number,
  rng: Rng,
): void {
  const orbitRadius = 55;
  const orbitSpeed = 0.22;

  if (!vehicle.controlled) {
    vehicle.pathIndex += orbitSpeed * dt;
    vehicle.position.x = Math.cos(vehicle.pathIndex) * orbitRadius;
    vehicle.position.z = Math.sin(vehicle.pathIndex) * orbitRadius;
    vehicle.position.y = 38;
    vehicle.yaw = vehicle.pathIndex + Math.PI / 2;
  }

  // Fire on a visible enemy, with a deliberately mediocre hit rate.
  const cooldownKey = vehicle.id;
  const last = vehicleFireTimes.get(cooldownKey) ?? 0;
  const interval = vehicle.kind === KillstreakVehicleKind.Chopper ? 0.16 : 0.09;
  if (world.time - last < interval) return;

  const owner = world.players.get(vehicle.owner);
  const team = owner?.team ?? vehicle.team;

  let best: PlayerState | null = null;
  let bestDist = Infinity;
  for (const player of world.players.values()) {
    if (!player.alive || !isEnemyTeam(team, player.team)) continue;
    const d = v3distance(vehicle.position, player.position);
    if (d > 90 || d >= bestDist) continue;
    // Must actually be able to see them — indoors is safe from air support,
    // which is the whole reason indoor routes exist on these maps.
    v3set(_toTarget, player.position.x, player.position.y + 1.2, player.position.z);
    if (!collision.isVisible(vehicle.position, _toTarget, STRIKE_FILTER)) continue;
    best = player;
    bestDist = d;
  }

  if (!best) return;
  vehicleFireTimes.set(cooldownKey, world.time);

  // Aircraft cannons miss a lot; the threat is being forced into cover, not the
  // damage itself.
  if (!rng.chance(0.35)) {
    _tick.events.push({
      type: SimEventType.Impact,
      tick: world.tick,
      position: { x: best.position.x + rng.signed(2), y: best.position.y, z: best.position.z + rng.signed(2) },
      normal: { x: 0, y: 1, z: 0 },
      surface: 0 as never,
      shooter: vehicle.owner,
      penetrated: false,
    } as SimEvent);
    return;
  }

  _tick.hits.push({
    victim: best.id,
    attacker: vehicle.owner,
    damage: vehicle.kind === KillstreakVehicleKind.Chopper ? 28 : 45,
    position: { ...best.position },
  });
}

/** Last fire time per vehicle. Cleared when a match ends. */
const vehicleFireTimes = new Map<EntityId, number>();

export function resetKillstreakRuntime(rt: KillstreakRuntime): void {
  for (const effects of rt.effects.values()) {
    effects.uav = 0;
    effects.advancedUav = 0;
    effects.counterUav = 0;
    effects.emp = 0;
  }
  rt.pendingStrikes.length = 0;
  vehicleFireTimes.clear();
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Is an enemy visible on a team's minimap right now?
 *
 * Split out because three different systems need the same answer and they must
 * never disagree — the minimap showing someone the AI cannot see, or vice versa,
 * is the kind of inconsistency players notice immediately and cannot explain.
 */
export function isRevealedOnRadar(
  rt: KillstreakRuntime,
  viewerTeam: Team,
  target: PlayerState,
  suppressedRecently: boolean,
): boolean {
  if (!isEnemyTeam(viewerTeam, target.team)) return true;
  if (suppressedRecently) return true;
  return hasRadar(rt, viewerTeam);
}

/** Seconds of radar left, for the HUD's UAV sweep. */
export function radarTimeRemaining(rt: KillstreakRuntime, team: Team): number {
  if (!hasRadar(rt, team)) return 0;
  const e = teamEffects(rt, team);
  return Math.max(e.uav, e.advancedUav);
}

