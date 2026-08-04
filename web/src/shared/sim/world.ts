/**
 * World construction and entity lifecycle.
 *
 * Everything the simulation touches is created here, so there is exactly one
 * place that decides what a "fresh" player or world looks like. That matters more
 * than it sounds: the client creates a predicted world and the server creates an
 * authoritative one, and any field either side forgets to initialise becomes a
 * desync that only shows up under load.
 */

import { HEALTH, MOVE, PLAYER_RADIUS } from '../constants.js';
import { vec3, v3set, v3copy, type Vec3 } from '../math.js';
import { hashString } from '../rng.js';
import {
  MatchPhase,
  MoveState,
  NULL_ENTITY,
  Stance,
  Team,
  WeaponAction,
  WeaponSlot,
  type DeployableState,
  type EntityId,
  type KillstreakEntityState,
  type MatchState,
  type PlayerId,
  type PlayerState,
  type ProjectileState,
  type WeaponState,
  type WorldState,
} from '../types.js';

// ---------------------------------------------------------------------------
// Weapons
// ---------------------------------------------------------------------------

export function createWeaponState(
  defId: string,
  magSize: number,
  reserve: number,
  attachments: string[] = [],
): WeaponState {
  return {
    defId,
    ammoInMag: magSize,
    ammoReserve: reserve,
    attachments: attachments.slice(),
    shotsInBurst: 0,
    recoilYaw: 0,
    recoilPitch: 0,
    spread: 0,
    nextFireTime: 0,
    heat: 0,
  };
}

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

export interface CreatePlayerOptions {
  id: PlayerId;
  name: string;
  team: Team;
  isBot?: boolean;
  botSkill?: number;
  position?: Vec3;
  yaw?: number;
}

export function createPlayer(opts: CreatePlayerOptions): PlayerState {
  const position = opts.position ? v3copy(vec3(), opts.position) : vec3();
  return {
    id: opts.id,
    entityId: opts.id,
    name: opts.name,
    team: opts.team,
    isBot: opts.isBot ?? false,
    botSkill: opts.botSkill ?? 0.5,

    position,
    velocity: vec3(),
    yaw: opts.yaw ?? 0,
    pitch: 0,
    lean: 0,

    stance: Stance.Stand,
    previousStance: Stance.Stand,
    stanceProgress: 1,
    moveState: MoveState.Idle,
    onGround: false,
    groundNormal: vec3(0, 1, 0),
    airTime: 0,
    fallPeakY: position.y,
    slideTime: 0,
    slideCooldown: 0,
    tacSprintTime: 0,
    tacSprintCooldown: 0,
    jumpCooldown: 0,
    jumpBuffer: 0,
    groundLockout: 0,
    mantleTime: 0,
    mantleDuration: 0,
    mantleStart: vec3(),
    mantleEnd: vec3(),
    sprintOutTime: 0,
    sprintOutPending: false,

    health: HEALTH.max,
    maxHealth: HEALTH.max,
    armor: 0,
    alive: false,
    respawnTimer: 0,
    timeSinceDamage: HEALTH.regenDelay,
    lastAttacker: 0,
    damagers: new Map(),

    activeSlot: WeaponSlot.Primary,
    weapons: [],
    adsProgress: 0,
    isAds: false,
    action: WeaponAction.Ready,
    actionTimer: 0,
    triggerHeld: false,

    lethalCount: 0,
    tacticalCount: 0,
    cookTime: -1,

    perks: [],
    fieldUpgrade: '',
    fieldUpgradeCharge: 0,
    killstreaks: [],
    killstreakInventory: [],

    flashAmount: 0,
    concussionAmount: 0,
    empTime: 0,
    markedUntil: 0,

    kills: 0,
    deaths: 0,
    assists: 0,
    score: 0,
    killstreak: 0,
    bestKillstreak: 0,
    streakScore: 0,
    captures: 0,
    defends: 0,
    plants: 0,
    defuses: 0,
    damageDealt: 0,
    headshots: 0,
    deathStreak: 0,

    lastProcessedInput: 0,
    ping: 0,
    connected: true,
    spectating: false,
    spectateTarget: 0,
  };
}

/**
 * Reset a player for a fresh life. Deliberately does NOT touch match-long stats
 * (kills, score) or connection state — only per-life state.
 */
export function respawnPlayer(player: PlayerState, position: Vec3, yaw: number): void {
  v3copy(player.position, position);
  v3set(player.velocity, 0, 0, 0);
  player.yaw = yaw;
  player.pitch = 0;
  player.lean = 0;

  player.stance = Stance.Stand;
  player.previousStance = Stance.Stand;
  player.stanceProgress = 1;
  player.moveState = MoveState.Idle;
  player.onGround = false;
  v3set(player.groundNormal, 0, 1, 0);
  player.airTime = 0;
  player.fallPeakY = position.y;
  player.slideTime = 0;
  player.slideCooldown = 0;
  player.tacSprintTime = 0;
  player.tacSprintCooldown = 0;
  player.jumpCooldown = 0;
  player.jumpBuffer = 0;
  player.groundLockout = 0;
  player.mantleTime = 0;
  player.sprintOutTime = 0;
  player.sprintOutPending = false;

  player.health = player.maxHealth;
  player.alive = true;
  player.respawnTimer = 0;
  player.timeSinceDamage = HEALTH.regenDelay;
  player.lastAttacker = 0;
  player.damagers.clear();

  player.activeSlot = WeaponSlot.Primary;
  player.adsProgress = 0;
  player.isAds = false;
  player.action = WeaponAction.Ready;
  player.actionTimer = 0;
  player.triggerHeld = false;
  player.cookTime = -1;

  player.flashAmount = 0;
  player.concussionAmount = 0;
  player.empTime = 0;

  player.spectating = false;
  player.spectateTarget = 0;
}

/** Kill a player without awarding anything — scoring is the caller's job. */
export function killPlayer(player: PlayerState, respawnDelay: number): void {
  player.alive = false;
  player.health = 0;
  player.respawnTimer = respawnDelay;
  player.killstreak = 0;
  player.triggerHeld = false;
  player.isAds = false;
  player.adsProgress = 0;
  player.action = WeaponAction.Ready;
  player.actionTimer = 0;
  player.mantleTime = 0;
  player.moveState = MoveState.Idle;
  player.cookTime = -1;
}

// ---------------------------------------------------------------------------
// Non-player entities
// ---------------------------------------------------------------------------

export function createProjectile(
  id: EntityId,
  kind: ProjectileState['kind'],
  owner: PlayerId,
  team: Team,
  position: Vec3,
  velocity: Vec3,
  fuse: number,
): ProjectileState {
  return {
    id,
    kind,
    owner,
    team,
    position: v3copy(vec3(), position),
    velocity: v3copy(vec3(), velocity),
    fuse,
    stuck: false,
    stuckTo: NULL_ENTITY,
    bounces: 0,
    age: 0,
    armed: false,
  };
}

export function createDeployable(
  id: EntityId,
  kind: DeployableState['kind'],
  owner: PlayerId,
  team: Team,
  position: Vec3,
  yaw: number,
  health: number,
  armTime: number,
  charges: number,
): DeployableState {
  return {
    id,
    kind,
    owner,
    team,
    position: v3copy(vec3(), position),
    yaw,
    health,
    armTime,
    charges,
    age: 0,
    payload: '',
  };
}

export function createKillstreakEntity(
  id: EntityId,
  kind: KillstreakEntityState['kind'],
  owner: PlayerId,
  team: Team,
  position: Vec3,
  health: number,
  duration: number,
): KillstreakEntityState {
  return {
    id,
    kind,
    owner,
    team,
    position: v3copy(vec3(), position),
    velocity: vec3(),
    yaw: 0,
    pitch: 0,
    health,
    timeRemaining: duration,
    controlled: false,
    pathIndex: 0,
  };
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

export interface CreateWorldOptions {
  mapId: string;
  modeId: string;
  /** Any string; hashed into the RNG seed so a match id reproduces a match. */
  seed?: string;
}

export function createWorld(opts: CreateWorldOptions): WorldState {
  return {
    tick: 0,
    time: 0,
    players: new Map(),
    projectiles: new Map(),
    deployables: new Map(),
    killstreakEntities: new Map(),
    match: createMatchState(),
    mapId: opts.mapId,
    modeId: opts.modeId,
    // Entity ids for non-players start well above the player id range so a
    // projectile can never be confused with a player in a filter list.
    nextEntityId: 1000,
    rngState: hashString(opts.seed ?? `${opts.mapId}:${opts.modeId}`),
  };
}

export function createMatchState(): MatchState {
  return {
    phase: MatchPhase.Warmup,
    timeRemaining: 0,
    round: 0,
    scores: [
      { team: Team.Allies, score: 0, roundsWon: 0 },
      { team: Team.Axis, score: 0, roundsWon: 0 },
    ],
    modeState: {},
    winner: null,
  };
}

export function allocEntityId(world: WorldState): EntityId {
  return world.nextEntityId++;
}

export function addPlayer(world: WorldState, player: PlayerState): PlayerState {
  world.players.set(player.id, player);
  return player;
}

export function removePlayer(world: WorldState, id: PlayerId): void {
  world.players.delete(id);
  // Orphaned equipment stays in the world — removing it on disconnect would let
  // players erase their own claymores by rage-quitting.
}

export function teamScore(world: WorldState, team: Team): number {
  return world.match.scores.find((s) => s.team === team)?.score ?? 0;
}

export function addTeamScore(world: WorldState, team: Team, amount: number): number {
  let entry = world.match.scores.find((s) => s.team === team);
  if (!entry) {
    entry = { team, score: 0, roundsWon: 0 };
    world.match.scores.push(entry);
  }
  entry.score += amount;
  return entry.score;
}

/** Live players on a team, written into `out` to avoid allocating each tick. */
export function playersOnTeam(
  world: WorldState,
  team: Team,
  out: PlayerState[],
  aliveOnly = false,
): PlayerState[] {
  out.length = 0;
  for (const p of world.players.values()) {
    if (p.team !== team) continue;
    if (aliveOnly && !p.alive) continue;
    out.push(p);
  }
  return out;
}

export function countAlive(world: WorldState, team: Team): number {
  let n = 0;
  for (const p of world.players.values()) {
    if (p.team === team && p.alive) n++;
  }
  return n;
}

/**
 * Player capsule dimensions for the collision registry. Kept here so the sim and
 * the collision layer can never disagree about how big a player is.
 */
export function playerCapsule(player: PlayerState): { height: number; radius: number } {
  const from = stanceHeightOf(player.previousStance);
  const to = stanceHeightOf(player.stance);
  const height = player.stanceProgress >= 1 ? to : from + (to - from) * player.stanceProgress;
  return { height, radius: PLAYER_RADIUS };
}

function stanceHeightOf(stance: Stance): number {
  switch (stance) {
    case Stance.Crouch:
      return 1.15;
    case Stance.Prone:
      return 0.55;
    default:
      return 1.8;
  }
}

/** Clamp a position back inside the map bounds — last-resort anti-fall-through. */
export function clampToBounds(position: Vec3, bounds: { min: Vec3; max: Vec3 }): boolean {
  let clamped = false;
  if (position.x < bounds.min.x) {
    position.x = bounds.min.x;
    clamped = true;
  } else if (position.x > bounds.max.x) {
    position.x = bounds.max.x;
    clamped = true;
  }
  if (position.z < bounds.min.z) {
    position.z = bounds.min.z;
    clamped = true;
  } else if (position.z > bounds.max.z) {
    position.z = bounds.max.z;
    clamped = true;
  }
  // Falling below the world is unrecoverable, so we catch it well below the floor.
  if (position.y < bounds.min.y - 20) {
    position.y = bounds.max.y;
    clamped = true;
  }
  return clamped;
}

/** Terminal-velocity check used by the anti-cheat and by the fall-damage system. */
export function isPlausibleVelocity(v: Vec3): boolean {
  const maxHoriz = MOVE.baseSpeed * MOVE.tacSprintMult * 2.5;
  return (
    Math.abs(v.x) <= maxHoriz &&
    Math.abs(v.z) <= maxHoriz &&
    v.y <= MOVE.jumpVelocity * 2 &&
    v.y >= -MOVE.maxFallSpeed * 1.2
  );
}
