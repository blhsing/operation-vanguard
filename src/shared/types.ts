/**
 * Core simulation types.
 *
 * These are the contract between the sim, the renderer, the AI and the network
 * layer. Keep them plain-data: no methods, no class instances, nothing that can't
 * be structurally cloned or serialised.
 */

import type { Vec3 } from './math.js';
import type { HitLocation } from './constants.js';

export type EntityId = number;
export type PlayerId = number;
export type Tick = number;

/** 0 is reserved to mean "no entity". */
export const NULL_ENTITY: EntityId = 0;

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

export enum Team {
  /** Used by spectators and by free-for-all players before assignment. */
  None = 0,
  Allies = 1,
  Axis = 2,
  /** Zombies / campaign hostiles. Always hostile to everyone else. */
  Hostile = 3,
}

export function isEnemyTeam(a: Team, b: Team): boolean {
  if (a === Team.Hostile || b === Team.Hostile) return a !== b;
  if (a === Team.None || b === Team.None) return true; // FFA: everyone is an enemy
  return a !== b;
}

export function opposingTeam(t: Team): Team {
  return t === Team.Allies ? Team.Axis : Team.Allies;
}

// ---------------------------------------------------------------------------
// Player input
// ---------------------------------------------------------------------------

/**
 * Bit flags for a single tick of player intent.
 * Packed into a Uint16 on the wire, so there is room for 16 flags total.
 */
export enum InputFlag {
  None = 0,
  Jump = 1 << 0,
  Crouch = 1 << 1,
  Prone = 1 << 2,
  Sprint = 1 << 3,
  TacticalSprint = 1 << 4,
  Fire = 1 << 5,
  Ads = 1 << 6,
  Reload = 1 << 7,
  Melee = 1 << 8,
  Use = 1 << 9,
  Lethal = 1 << 10,
  Tactical = 1 << 11,
  SwapWeapon = 1 << 12,
  LeanLeft = 1 << 13,
  LeanRight = 1 << 14,
  FieldUpgrade = 1 << 15,
}

/**
 * One tick of input. The client sends these; the server replays them verbatim.
 * `seq` lets the server acknowledge progress and the client discard replayed input.
 */
export interface InputCommand {
  seq: number;
  tick: Tick;
  /** Seconds this command covers. Normally TICK_DT; clamped server-side. */
  dt: number;
  /** Movement intent in local space, each in [-1, 1]. */
  moveForward: number;
  moveRight: number;
  yaw: number;
  pitch: number;
  buttons: number;
  /** Which killstreak slot the player is trying to trigger, or -1. */
  killstreakSlot: number;
}

export function hasFlag(buttons: number, flag: InputFlag): boolean {
  return (buttons & flag) !== 0;
}

export function createEmptyInput(): InputCommand {
  return {
    seq: 0,
    tick: 0,
    dt: 0,
    moveForward: 0,
    moveRight: 0,
    yaw: 0,
    pitch: 0,
    buttons: 0,
    killstreakSlot: -1,
  };
}

// ---------------------------------------------------------------------------
// Stance and movement state
// ---------------------------------------------------------------------------

export enum Stance {
  Stand = 0,
  Crouch = 1,
  Prone = 2,
}

export enum MoveState {
  Idle = 0,
  Walk = 1,
  Sprint = 2,
  TacticalSprint = 3,
  Slide = 4,
  Air = 5,
  Mantle = 6,
}

// ---------------------------------------------------------------------------
// Weapon runtime state
// ---------------------------------------------------------------------------

export enum WeaponSlot {
  Primary = 0,
  Secondary = 1,
  Lethal = 2,
  Tactical = 3,
  Melee = 4,
}

export enum WeaponAction {
  Ready = 0,
  Firing = 1,
  Reloading = 2,
  Swapping = 3,
  Melee = 4,
  ThrowingGrenade = 5,
  Mantling = 6,
  Sprinting = 7,
}

/** Per-weapon mutable state carried across a life. */
export interface WeaponState {
  /** Key into the weapon table. */
  defId: string;
  ammoInMag: number;
  ammoReserve: number;
  /** Attachment ids, indexed by attachment slot. Empty string = none. */
  attachments: string[];
  /** Rounds fired without releasing the trigger — drives recoil pattern index. */
  shotsInBurst: number;
  /** Accumulated recoil, applied to view angles and decayed each tick. */
  recoilYaw: number;
  recoilPitch: number;
  /** Current bullet spread cone half-angle in radians. */
  spread: number;
  /** Seconds until the weapon can fire again. */
  nextFireTime: number;
  /** Heat 0..1 for weapons that overheat, and for barrel-glow VFX. */
  heat: number;
}

// ---------------------------------------------------------------------------
// Player entity
// ---------------------------------------------------------------------------

export interface PlayerState {
  id: PlayerId;
  entityId: EntityId;
  name: string;
  team: Team;
  isBot: boolean;
  /** Difficulty tier for bots; ignored for humans. */
  botSkill: number;

  // --- transform -----------------------------------------------------------
  /** Feet position. */
  position: Vec3;
  velocity: Vec3;
  yaw: number;
  pitch: number;
  /** Lean amount in [-1, 1]. */
  lean: number;

  // --- movement ------------------------------------------------------------
  stance: Stance;
  /** Interpolates toward the target stance height for smooth crouch/prone. */
  stanceProgress: number;
  moveState: MoveState;
  onGround: boolean;
  groundNormal: Vec3;
  /** Time since the player last touched ground — drives coyote time. */
  airTime: number;
  /** Highest Y reached since leaving the ground, for fall damage. */
  fallPeakY: number;
  slideTime: number;
  slideCooldown: number;
  tacSprintTime: number;
  tacSprintCooldown: number;
  jumpCooldown: number;
  mantleTime: number;
  mantleDuration: number;
  mantleStart: Vec3;
  mantleEnd: Vec3;
  /** Seconds since the player stopped sprinting — gates firing (sprint-out time). */
  sprintOutTime: number;

  // --- combat --------------------------------------------------------------
  health: number;
  maxHealth: number;
  armor: number;
  alive: boolean;
  /** Time until respawn when dead. */
  respawnTimer: number;
  timeSinceDamage: number;
  lastAttacker: PlayerId;
  /** Everyone who damaged this player this life, for assist credit. */
  damagers: Map<PlayerId, number>;

  activeSlot: WeaponSlot;
  weapons: WeaponState[];
  /** 0 = hipfire, 1 = fully aimed. */
  adsProgress: number;
  isAds: boolean;
  action: WeaponAction;
  /** Seconds remaining in the current action. */
  actionTimer: number;
  /** True while the trigger is held, for full-auto and burst tracking. */
  triggerHeld: boolean;

  lethalCount: number;
  tacticalCount: number;
  /** Cooked-grenade fuse, negative when not cooking. */
  cookTime: number;

  // --- loadout -------------------------------------------------------------
  perks: string[];
  fieldUpgrade: string;
  fieldUpgradeCharge: number;
  killstreaks: string[];
  /** Killstreaks earned and awaiting use. */
  killstreakInventory: string[];

  // --- status effects ------------------------------------------------------
  /** 0..1 flash blindness. */
  flashAmount: number;
  /** 0..1 concussion — slows movement and blurs view. */
  concussionAmount: number;
  /** Remaining seconds of EMP / tactical jamming. */
  empTime: number;
  /** True while the player has been marked by a UAV/recon effect. */
  markedUntil: number;

  // --- scoring -------------------------------------------------------------
  kills: number;
  deaths: number;
  assists: number;
  score: number;
  /** Kills without dying — drives killstreak awards. */
  killstreak: number;
  bestKillstreak: number;
  /** Score accumulated toward the next scorestreak reward. */
  streakScore: number;
  captures: number;
  defends: number;
  plants: number;
  defuses: number;
  damageDealt: number;
  headshots: number;
  /** Consecutive deaths, used to escalate respawn delay. */
  deathStreak: number;

  // --- bookkeeping ---------------------------------------------------------
  /** Last input sequence the sim has consumed, echoed back for reconciliation. */
  lastProcessedInput: number;
  /** Round-trip latency estimate in seconds, used for lag compensation. */
  ping: number;
  connected: boolean;
  spectating: boolean;
  spectateTarget: PlayerId;
}

// ---------------------------------------------------------------------------
// Non-player entities
// ---------------------------------------------------------------------------

export enum ProjectileKind {
  Frag = 0,
  Semtex = 1,
  Molotov = 2,
  ThermiteStick = 3,
  Flashbang = 4,
  StunGrenade = 5,
  SmokeGrenade = 6,
  Rocket = 7,
  GrenadeLauncher = 8,
  C4 = 9,
  ClaymoreProjectile = 10,
  ThrowingKnife = 11,
}

export interface ProjectileState {
  id: EntityId;
  kind: ProjectileKind;
  owner: PlayerId;
  team: Team;
  position: Vec3;
  velocity: Vec3;
  /** Seconds until detonation; <= 0 means it has gone off. */
  fuse: number;
  /** Sticky projectiles latch to whatever they hit. */
  stuck: boolean;
  stuckTo: EntityId;
  /** How many surfaces it has bounced off — some grenades die after N bounces. */
  bounces: number;
  /** Total lifetime so far, for despawn safety. */
  age: number;
  armed: boolean;
}

export enum DeployableKind {
  Claymore = 0,
  ProximityMine = 1,
  C4Placed = 2,
  TacticalInsertion = 3,
  TrophySystem = 4,
  DeployableCover = 5,
  AmmoBox = 6,
  SentryGun = 7,
  CarePackage = 8,
}

export interface DeployableState {
  id: EntityId;
  kind: DeployableKind;
  owner: PlayerId;
  team: Team;
  position: Vec3;
  yaw: number;
  health: number;
  /** Time until it becomes active (arming delay). */
  armTime: number;
  /** Remaining uses/charges — trophy systems and ammo boxes are limited. */
  charges: number;
  age: number;
  /** Killstreak id for care packages. */
  payload: string;
}

export enum KillstreakVehicleKind {
  UAV = 0,
  CounterUAV = 1,
  Chopper = 2,
  VTOL = 3,
  AC130 = 4,
  PredatorMissile = 5,
  Airstrike = 6,
  ClusterStrike = 7,
}

export interface KillstreakEntityState {
  id: EntityId;
  kind: KillstreakVehicleKind;
  owner: PlayerId;
  team: Team;
  position: Vec3;
  velocity: Vec3;
  yaw: number;
  pitch: number;
  health: number;
  timeRemaining: number;
  /** True while a human is actively controlling it. */
  controlled: boolean;
  /** Waypoint index for scripted flight paths. */
  pathIndex: number;
}

// ---------------------------------------------------------------------------
// Events
//
// The sim emits events instead of calling into presentation code directly. The
// renderer, audio engine, HUD and network layer all consume the same stream, so
// offline and online behave identically.
// ---------------------------------------------------------------------------

export enum SimEventType {
  Shot = 'shot',
  Impact = 'impact',
  Hit = 'hit',
  Kill = 'kill',
  Damage = 'damage',
  Reload = 'reload',
  ReloadComplete = 'reload_complete',
  WeaponSwap = 'weapon_swap',
  Melee = 'melee',
  Footstep = 'footstep',
  Jump = 'jump',
  Land = 'land',
  Slide = 'slide',
  Mantle = 'mantle',
  Spawn = 'spawn',
  Death = 'death',
  ProjectileThrown = 'projectile_thrown',
  Explosion = 'explosion',
  Flash = 'flash',
  ObjectiveCaptured = 'objective_captured',
  ObjectiveContested = 'objective_contested',
  ObjectiveNeutralized = 'objective_neutralized',
  BombPlanted = 'bomb_planted',
  BombDefused = 'bomb_defused',
  KillstreakEarned = 'killstreak_earned',
  KillstreakCalled = 'killstreak_called',
  KillstreakDestroyed = 'killstreak_destroyed',
  ScoreAwarded = 'score_awarded',
  MedalEarned = 'medal_earned',
  MatchStateChanged = 'match_state_changed',
  RoundStart = 'round_start',
  RoundEnd = 'round_end',
  Chat = 'chat',
  Announce = 'announce',
  TagCollected = 'tag_collected',
  DeployablePlaced = 'deployable_placed',
  DeployableDestroyed = 'deployable_destroyed',
}

export interface SimEventBase {
  type: SimEventType;
  tick: Tick;
}

export interface ShotEvent extends SimEventBase {
  type: SimEventType.Shot;
  player: PlayerId;
  weaponId: string;
  origin: Vec3;
  direction: Vec3;
  suppressed: boolean;
  /** Index within the current trigger pull — drives shell ejection and recoil VFX. */
  shotIndex: number;
}

export interface ImpactEvent extends SimEventBase {
  type: SimEventType.Impact;
  position: Vec3;
  normal: Vec3;
  surface: SurfaceType;
  /** Who fired the shot, for friendly-fire filtering of VFX. */
  shooter: PlayerId;
  penetrated: boolean;
}

export interface HitEvent extends SimEventBase {
  type: SimEventType.Hit;
  attacker: PlayerId;
  victim: PlayerId;
  location: HitLocation;
  damage: number;
  lethal: boolean;
  position: Vec3;
  weaponId: string;
}

export interface DamageEvent extends SimEventBase {
  type: SimEventType.Damage;
  victim: PlayerId;
  attacker: PlayerId;
  amount: number;
  /** Unit vector from victim toward the damage source, for the HUD indicator. */
  direction: Vec3;
  cause: DamageCause;
}

export interface KillEvent extends SimEventBase {
  type: SimEventType.Kill;
  killer: PlayerId;
  victim: PlayerId;
  assists: PlayerId[];
  weaponId: string;
  headshot: boolean;
  cause: DamageCause;
  distance: number;
  /** True when the killer was themselves killed moments later — "revenge" feed. */
  killerWasLowHealth: boolean;
  victimPosition: Vec3;
  killerPosition: Vec3;
}

export interface ExplosionEvent extends SimEventBase {
  type: SimEventType.Explosion;
  position: Vec3;
  radius: number;
  owner: PlayerId;
  kind: ProjectileKind | 'killstreak';
}

export interface FootstepEvent extends SimEventBase {
  type: SimEventType.Footstep;
  player: PlayerId;
  position: Vec3;
  surface: SurfaceType;
  loud: boolean;
}

export interface ScoreEvent extends SimEventBase {
  type: SimEventType.ScoreAwarded;
  player: PlayerId;
  amount: number;
  reason: string;
}

export interface AnnounceEvent extends SimEventBase {
  type: SimEventType.Announce;
  team: Team;
  line: string;
}

export interface GenericSimEvent extends SimEventBase {
  type: Exclude<
    SimEventType,
    | SimEventType.Shot
    | SimEventType.Impact
    | SimEventType.Hit
    | SimEventType.Damage
    | SimEventType.Kill
    | SimEventType.Explosion
    | SimEventType.Footstep
    | SimEventType.ScoreAwarded
    | SimEventType.Announce
  >;
  player?: PlayerId;
  team?: Team;
  position?: Vec3;
  /** Free-form payload — objective index, weapon id, chat text, etc. */
  data?: Record<string, unknown>;
}

export type SimEvent =
  | ShotEvent
  | ImpactEvent
  | HitEvent
  | DamageEvent
  | KillEvent
  | ExplosionEvent
  | FootstepEvent
  | ScoreEvent
  | AnnounceEvent
  | GenericSimEvent;

// ---------------------------------------------------------------------------
// Damage
// ---------------------------------------------------------------------------

export enum DamageCause {
  Bullet = 0,
  Explosion = 1,
  Melee = 2,
  Fall = 3,
  Fire = 4,
  Killstreak = 5,
  Vehicle = 6,
  Zombie = 7,
  Suicide = 8,
  OutOfBounds = 9,
  Sentry = 10,
  Environment = 11,
}

export interface DamageInfo {
  amount: number;
  attacker: PlayerId;
  victim: PlayerId;
  cause: DamageCause;
  weaponId: string;
  location: HitLocation;
  /** World position of the hit, for blood VFX and directional indicators. */
  position: Vec3;
  direction: Vec3;
  distance: number;
  /** True when this damage bypasses armour (headshots from snipers, execution melee). */
  ignoreArmor: boolean;
}

// ---------------------------------------------------------------------------
// Surfaces — drive impact VFX, footstep audio, penetration and AI hearing
// ---------------------------------------------------------------------------

export enum SurfaceType {
  Concrete = 0,
  Metal = 1,
  Wood = 2,
  Dirt = 3,
  Grass = 4,
  Sand = 5,
  Water = 6,
  Glass = 7,
  Foliage = 8,
  Flesh = 9,
  Carpet = 10,
  Gravel = 11,
  Snow = 12,
  Tile = 13,
  Plastic = 14,
  Brick = 15,
}

/**
 * How much of a bullet's energy survives passing through 1 metre of a surface,
 * and whether a bullet can pass at all. Drives wallbang mechanics.
 */
export interface SurfaceProperties {
  /** 0 = impenetrable, 1 = free passage. */
  penetration: number;
  /** Damage retained per metre of material traversed. */
  damageRetention: number;
  /** How loud footsteps are, 0..1. */
  footstepVolume: number;
  /** Whether the surface shatters (glass) when shot. */
  breakable: boolean;
}

// ---------------------------------------------------------------------------
// Match state
// ---------------------------------------------------------------------------

export enum MatchPhase {
  Warmup = 0,
  Countdown = 1,
  Live = 2,
  RoundEnd = 3,
  Overtime = 4,
  MatchEnd = 5,
}

export interface TeamScore {
  team: Team;
  score: number;
  roundsWon: number;
}

export interface MatchState {
  phase: MatchPhase;
  /** Seconds remaining in the current phase. */
  timeRemaining: number;
  round: number;
  scores: TeamScore[];
  /** Mode-specific state, e.g. flag ownership or bomb status. */
  modeState: Record<string, unknown>;
  winner: Team | null;
}

// ---------------------------------------------------------------------------
// The full world snapshot the sim operates on
// ---------------------------------------------------------------------------

export interface WorldState {
  tick: Tick;
  /** Simulation time in seconds since match start. */
  time: number;
  players: Map<PlayerId, PlayerState>;
  projectiles: Map<EntityId, ProjectileState>;
  deployables: Map<EntityId, DeployableState>;
  killstreakEntities: Map<EntityId, KillstreakEntityState>;
  match: MatchState;
  mapId: string;
  modeId: string;
  /** Monotonic id allocator for non-player entities. */
  nextEntityId: EntityId;
  /** Deterministic RNG state — must be replicated for prediction to agree. */
  rngState: number;
}
