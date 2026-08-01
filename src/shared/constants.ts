/**
 * Tuning constants shared by client prediction and server authority.
 *
 * Anything here that affects movement or combat MUST be identical on both sides,
 * otherwise prediction diverges and players get rubber-banded. Treat this file as
 * part of the network protocol: changing a value is a protocol change.
 *
 * Units: metres, seconds, radians. One "unit" in the world is one metre.
 */

// ---------------------------------------------------------------------------
// Simulation timing
// ---------------------------------------------------------------------------

/** Server/simulation tick rate. 64 Hz matches modern COD dedicated servers. */
export const TICK_RATE = 64;
export const TICK_DT = 1 / TICK_RATE;
export const TICK_MS = 1000 / TICK_RATE;

/** Rate at which the server broadcasts snapshots. Lower than tick to save bandwidth. */
export const SNAPSHOT_RATE = 32;
export const SNAPSHOT_DT = 1 / SNAPSHOT_RATE;

/**
 * How far behind real time the client renders remote entities. Two snapshot
 * intervals gives us one spare packet of jitter tolerance before we have to
 * extrapolate.
 */
export const INTERP_DELAY = SNAPSHOT_DT * 2;

/** Hard cap on catch-up ticks in one frame, so a stalled tab can't freeze on resume. */
export const MAX_TICKS_PER_FRAME = 8;

/** Client keeps this many unacknowledged inputs for reconciliation replay. */
export const INPUT_BUFFER_SIZE = 128;

/** Server rewinds hitboxes at most this far for lag compensation (250 ms, COD-like). */
export const MAX_LAG_COMPENSATION = 0.25;

/** Ring buffer of historical positions the server keeps for rewinding. */
export const LAG_COMP_HISTORY_TICKS = Math.ceil(MAX_LAG_COMPENSATION * TICK_RATE) + 4;

// ---------------------------------------------------------------------------
// Player dimensions
// ---------------------------------------------------------------------------

export const PLAYER_RADIUS = 0.36;

export const STANCE_HEIGHT = {
  stand: 1.8,
  crouch: 1.15,
  prone: 0.55,
} as const;

/** Eye height as a fraction of the stance height. */
export const EYE_HEIGHT = {
  stand: 1.62,
  crouch: 1.0,
  prone: 0.42,
} as const;

/** Seconds to transition between stances. Prone is deliberately slow (COD's "prone delay"). */
export const STANCE_TRANSITION = {
  standToCrouch: 0.2,
  crouchToStand: 0.22,
  crouchToProne: 0.35,
  proneToCrouch: 0.45,
  standToProne: 0.5,
  proneToStand: 0.6,
} as const;

// ---------------------------------------------------------------------------
// Movement
//
// Tuned to feel like Modern Warfare: fast acceleration, near-instant stop,
// meaningful sprint payoff, and a slide that trades control for distance.
// ---------------------------------------------------------------------------

export const MOVE = {
  /** Base forward speed while walking (weapon-modified at runtime). */
  baseSpeed: 4.6,
  /** Multipliers applied to base speed. */
  strafeMult: 0.88,
  backMult: 0.76,
  sprintMult: 1.52,
  /** Tactical sprint: a short burst well above normal sprint. */
  tacSprintMult: 1.92,
  tacSprintDuration: 2.4,
  tacSprintCooldown: 6.0,
  crouchMult: 0.52,
  proneMult: 0.22,
  adsMult: 0.42,

  /** Ground acceleration in m/s². High = snappy, COD-like. */
  groundAccel: 62,
  groundFriction: 52,
  /** Air control is deliberately weak — no bunny-hopping across the map. */
  airAccel: 11,
  airFriction: 0.2,
  maxAirSpeedGain: 1.4,

  gravity: 21.5,
  jumpVelocity: 6.1,
  /** Grace period after leaving a ledge where a jump still registers. */
  coyoteTime: 0.09,
  /** A jump pressed this long before landing still fires on touchdown. */
  jumpBufferTime: 0.12,
  jumpCooldown: 0.28,

  /** Steepest slope (radians) that counts as walkable ground. */
  maxSlopeAngle: 48 * (Math.PI / 180),
  /** Max ledge height auto-stepped without a mantle. */
  stepHeight: 0.42,
  /** Downward probe distance used to stay glued to stairs when descending. */
  groundSnapDistance: 0.32,

  /** Terminal velocity, so long falls stay predictable. */
  maxFallSpeed: 55,

  /** Fall damage begins past this drop height and maxes out at lethalFall. */
  safeFallHeight: 4.2,
  lethalFallHeight: 13.0,
  maxFallDamage: 100,
} as const;

export const SLIDE = {
  /** Minimum speed required to initiate a slide. */
  minSpeed: 5.2,
  /** Instant speed boost on slide start. */
  boostSpeed: 8.4,
  duration: 0.85,
  friction: 6.4,
  /** Slides can't be spammed. */
  cooldown: 0.55,
  /** Extra acceleration when sliding downhill. */
  slopeAccel: 9.0,
  /** Camera roll during a slide, radians. */
  cameraRoll: 0.12,
} as const;

export const MANTLE = {
  /** Ledge heights inside this band can be mantled. */
  minHeight: 0.42,
  maxHeight: 2.05,
  /** How far ahead we probe for a ledge. */
  reach: 0.85,
  /** Clear space needed above the ledge to land on it. */
  clearance: 0.95,
  /** Duration scales with ledge height between these bounds. */
  minDuration: 0.34,
  maxDuration: 0.78,
} as const;

export const LEAN = {
  maxAngle: 22 * (Math.PI / 180),
  /** Lateral eye offset at full lean. */
  maxOffset: 0.42,
  speed: 7.5,
} as const;

// ---------------------------------------------------------------------------
// Combat
// ---------------------------------------------------------------------------

export const HEALTH = {
  max: 100,
  /** Seconds without taking damage before regeneration starts. */
  regenDelay: 5.0,
  /** HP per second once regeneration kicks in. */
  regenRate: 40,
  /** Regen delay after being hit while already regenerating. */
  regenInterruptDelay: 2.5,
} as const;

export const ARMOR = {
  /** Juggernaut and heavy-armour field upgrades. */
  maxPlates: 3,
  perPlate: 50,
  plateApplyTime: 1.6,
} as const;

/** Damage multipliers by hit location. Matches COD's headshot-forward TTK. */
export const HIT_MULTIPLIER = {
  head: 1.8,
  neck: 1.5,
  chest: 1.0,
  stomach: 1.05,
  upperArm: 0.9,
  lowerArm: 0.85,
  upperLeg: 0.9,
  lowerLeg: 0.8,
  foot: 0.75,
} as const;

export type HitLocation = keyof typeof HIT_MULTIPLIER;

/** Maximum distance any hitscan trace travels. */
export const MAX_TRACE_DISTANCE = 400;

/** How long impact decals and blood splatter persist, in seconds. */
export const DECAL_LIFETIME = 22;
export const MAX_DECALS = 256;

// ---------------------------------------------------------------------------
// Scoring and progression
// ---------------------------------------------------------------------------

export const SCORE = {
  kill: 100,
  assist: 50,
  headshotBonus: 25,
  longshotBonus: 50,
  killstreakKill: 25,
  objectiveCapture: 200,
  objectiveDefend: 100,
  objectiveAssist: 75,
  plantBomb: 250,
  defuseBomb: 250,
  confirmKill: 50,
  denyKill: 50,
  revenge: 50,
  firstBlood: 100,
  destroyKillstreak: 150,
  saveTeammate: 75,
} as const;

/** XP awarded is score multiplied by this, then modified by playlist bonuses. */
export const XP_PER_SCORE = 1.0;

export const MAX_RANK = 55;
export const MAX_PRESTIGE = 10;
export const MAX_WEAPON_LEVEL = 30;

// ---------------------------------------------------------------------------
// Match structure
// ---------------------------------------------------------------------------

export const MATCH = {
  /** Countdown before a match goes live. */
  warmupDuration: 8,
  /** Post-match scoreboard duration before returning to lobby. */
  outroDuration: 14,
  /** Killcam length. */
  killcamDuration: 4.0,
  /** Seconds between death and respawn for standard modes. */
  respawnDelay: 4.0,
  /** Extra delay per consecutive death, to soften spawn-trapping death spirals. */
  respawnDelayEscalation: 0.35,
  maxRespawnDelay: 8.0,
} as const;

export const MAX_PLAYERS = 24;
export const DEFAULT_TEAM_SIZE = 6;

// ---------------------------------------------------------------------------
// Spawn selection
//
// COD picks spawns with a weighted influence map rather than fixed points. These
// weights are what make spawns feel "fair" instead of random.
// ---------------------------------------------------------------------------

export const SPAWN = {
  /** A spawn point closer than this to any live enemy is effectively banned. */
  enemyDangerRadius: 18,
  /** Full ban radius — never spawn here. */
  enemyHardBanRadius: 8,
  /** Bonus for spawning near friendlies. */
  friendlyAttractRadius: 22,
  /** Spawns inside an enemy's view cone are penalised heavily. */
  enemyViewConeHalfAngle: 55 * (Math.PI / 180),
  enemyViewConePenalty: 900,
  /** Recently used spawns are penalised so players don't loop the same corner. */
  recentUseWindow: 12,
  recentUsePenalty: 320,
  /** Avoid spawning where someone just died. */
  recentDeathRadius: 10,
  recentDeathPenalty: 260,
  /** Grenades and killstreaks make an area unsafe. */
  dangerZonePenalty: 1400,
} as const;

// ---------------------------------------------------------------------------
// Audio / perception ranges — shared because AI hearing uses the same numbers
// ---------------------------------------------------------------------------

export const PERCEPTION = {
  /** Unsuppressed gunfire is audible this far by AI. */
  gunshotRadius: 90,
  suppressedGunshotRadius: 28,
  footstepRadiusWalk: 16,
  footstepRadiusSprint: 26,
  footstepRadiusCrouch: 6,
  reloadRadius: 9,
  explosionRadius: 140,
} as const;

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------

export const NET = {
  protocolVersion: 7,
  defaultPort: 8790,
  /** Drop a client that hasn't sent anything in this long. */
  timeoutSeconds: 20,
  heartbeatInterval: 3,
  /** Reject inputs claiming a dt outside this band — basic speed-hack guard. */
  maxInputDt: TICK_DT * 3,
  /** Max inputs a client may batch into one packet. */
  maxInputsPerPacket: 16,
  /** Entities beyond this range may be culled from a client's snapshot. */
  interestRadius: 160,
  maxNameLength: 20,
  maxChatLength: 160,
} as const;

// ---------------------------------------------------------------------------
// Rendering defaults (client-only, but kept here so quality tiers are one source)
// ---------------------------------------------------------------------------

export const RENDER = {
  defaultFov: 80,
  minFov: 65,
  maxFov: 120,
  /** ADS narrows FOV by this fraction of the weapon's own zoom factor. */
  nearPlane: 0.05,
  farPlane: 800,
  /** Viewmodel renders in a separate pass with its own FOV to avoid clipping. */
  viewmodelFov: 62,
  viewmodelNear: 0.01,
  viewmodelFar: 12,
  shadowMapSize: 2048,
  maxParticles: 4000,
} as const;

export const TEAM_COLORS = {
  allies: 0x4a9eff,
  axis: 0xff5a4a,
  neutral: 0xc8c8c8,
  friendly: 0x5ce65c,
  enemy: 0xff3b30,
} as const;
