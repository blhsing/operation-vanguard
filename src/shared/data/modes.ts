/**
 * Game mode rules, as data.
 *
 * The match engine is one generic loop driven by these definitions plus a small
 * per-mode hook, rather than a switch statement with nine arms. Everything a
 * mode changes about scoring, timing, respawn and objectives lives here, so
 * adding a playlist variant is a data edit.
 *
 * The numbers are the ones players already know — Domination is 200 to win at a
 * point per flag per five seconds, Search & Destroy is 1:45 rounds with a 45
 * second bomb. Getting these wrong is immediately obvious to anyone who has
 * played the genre, so they are treated as spec rather than as tuning.
 */

import { ObjectiveKind } from '../map/map-types.js';
import { WeaponClass } from './weapon-types.js';
import { WEAPONS_BY_CLASS } from './weapons.js';

export interface ModeScoring {
  kill: number;
  assist: number;
  capture: number;
  defend: number;
  /** Points awarded per tick while holding an objective. */
  objectiveTick: number;
  /** Seconds between objective ticks. */
  objectiveTickInterval: number;
  plant: number;
  defuse: number;
  confirm: number;
  deny: number;
}

export interface GameModeDef {
  id: string;
  name: string;
  shortName: string;
  description: string;
  teamBased: boolean;
  /** Score needed to win. 0 = the mode ends on the timer alone. */
  scoreLimit: number;
  timeLimit: number;
  /** Rounds a team must win to take the match. 1 for continuous modes. */
  roundsToWin: number;
  roundTime: number;
  respawn: boolean;
  respawnDelay: number;
  objectiveKind: ObjectiveKind | null;
  scoring: ModeScoring;
  /** Mode-specific tuning read by that mode's hook. */
  params: Record<string, number | boolean | string>;
  killstreaksEnabled: boolean;
  scorestreaksOnly: boolean;
  teamSize: [number, number];
  introLine: string;
}

function scoring(o: Partial<ModeScoring> = {}): ModeScoring {
  return {
    kill: 100,
    assist: 50,
    capture: 200,
    defend: 100,
    objectiveTick: 0,
    objectiveTickInterval: 1,
    plant: 250,
    defuse: 250,
    confirm: 50,
    deny: 50,
    ...o,
  };
}

// ---------------------------------------------------------------------------

const TEAM_DEATHMATCH: GameModeDef = {
  id: 'tdm',
  name: 'Team Deathmatch',
  shortName: 'TDM',
  description: 'Two teams. Most kills wins. Nothing else to think about.',
  teamBased: true,
  scoreLimit: 75,
  timeLimit: 600,
  roundsToWin: 1,
  roundTime: 600,
  respawn: true,
  respawnDelay: 4,
  objectiveKind: null,
  scoring: scoring(),
  params: {},
  killstreaksEnabled: true,
  scorestreaksOnly: false,
  teamSize: [4, 9],
  introLine: 'Eliminate the enemy team.',
};

const FREE_FOR_ALL: GameModeDef = {
  id: 'ffa',
  name: 'Free-For-All',
  shortName: 'FFA',
  description: 'Everyone against everyone. First to thirty kills.',
  teamBased: false,
  scoreLimit: 30,
  timeLimit: 600,
  roundsToWin: 1,
  roundTime: 600,
  respawn: true,
  respawnDelay: 3,
  objectiveKind: null,
  scoring: scoring({ kill: 100, assist: 0 }),
  params: {},
  killstreaksEnabled: true,
  scorestreaksOnly: false,
  teamSize: [4, 12],
  introLine: 'Every player for themselves.',
};

const DOMINATION: GameModeDef = {
  id: 'domination',
  name: 'Domination',
  shortName: 'DOM',
  description: 'Capture and hold three positions. Points tick for every flag you own.',
  teamBased: true,
  scoreLimit: 200,
  timeLimit: 900,
  roundsToWin: 1,
  roundTime: 900,
  respawn: true,
  respawnDelay: 5,
  objectiveKind: ObjectiveKind.DominationFlag,
  scoring: scoring({
    capture: 200,
    defend: 100,
    // One point per flag every five seconds is the rate that makes 200 take
    // roughly a full match with two flags held.
    objectiveTick: 1,
    objectiveTickInterval: 5,
  }),
  params: {
    /** Seconds for a single player to capture a neutral or enemy flag. */
    captureTime: 10,
    /**
     * Each additional player on the point adds this fraction of the base rate.
     * Sub-linear, so stacking five people on a flag is wasteful.
     */
    captureSpeedPerExtraPlayer: 0.5,
    /** Capture progress decays this fast when nobody is on the point. */
    captureDecayRate: 0.5,
    /** Contested flags neither capture nor tick. */
    contestedStopsCapture: true,
  },
  killstreaksEnabled: true,
  scorestreaksOnly: false,
  teamSize: [4, 12],
  introLine: 'Capture and hold the objectives.',
};

const SEARCH_AND_DESTROY: GameModeDef = {
  id: 'snd',
  name: 'Search & Destroy',
  shortName: 'S&D',
  description: 'One life a round. Plant the bomb, or stop it being planted.',
  teamBased: true,
  scoreLimit: 0,
  timeLimit: 0,
  roundsToWin: 6,
  roundTime: 105,
  respawn: false,
  respawnDelay: 0,
  objectiveKind: ObjectiveKind.BombSite,
  scoring: scoring({
    kill: 100,
    assist: 50,
    plant: 250,
    defuse: 250,
  }),
  params: {
    bombTimer: 45,
    plantTime: 5,
    defuseTime: 7.5,
    /** Teams swap attack and defence at the halfway point. */
    swapSidesAfterRound: 6,
    /** Seconds of frozen prep at the start of each round. */
    prepTime: 5,
  },
  killstreaksEnabled: true,
  // Scorestreaks only: with no respawns, kill-based streaks would compound an
  // already decisive advantage.
  scorestreaksOnly: true,
  teamSize: [4, 6],
  introLine: 'Search and destroy. One life.',
};

const KILL_CONFIRMED: GameModeDef = {
  id: 'kc',
  name: 'Kill Confirmed',
  shortName: 'KC',
  description: 'Kills only count when you collect the tag. Deny the enemy theirs.',
  teamBased: true,
  scoreLimit: 65,
  timeLimit: 600,
  roundsToWin: 1,
  roundTime: 600,
  respawn: true,
  respawnDelay: 4,
  objectiveKind: null,
  scoring: scoring({
    // The kill itself is worth less than the confirm — that is the whole point.
    kill: 50,
    confirm: 50,
    deny: 50,
  }),
  params: {
    /** Seconds a tag stays on the ground before it despawns. */
    tagLifetime: 30,
    /** Radius within which a tag is picked up. */
    tagPickupRadius: 1.6,
  },
  killstreaksEnabled: true,
  scorestreaksOnly: false,
  teamSize: [4, 9],
  introLine: 'Collect the tags. Confirm your kills.',
};

const HARDPOINT: GameModeDef = {
  id: 'hardpoint',
  name: 'Hardpoint',
  shortName: 'HP',
  description: 'Hold the rotating zone. A point a second, and it moves every minute.',
  teamBased: true,
  scoreLimit: 250,
  timeLimit: 600,
  roundsToWin: 1,
  roundTime: 600,
  respawn: true,
  respawnDelay: 5,
  objectiveKind: ObjectiveKind.Hardpoint,
  scoring: scoring({
    objectiveTick: 1,
    objectiveTickInterval: 1,
    capture: 100,
    defend: 50,
  }),
  params: {
    rotationTime: 60,
    /** Seconds of no-zone between rotations, so the fight resets. */
    rotationGap: 5,
    contestedStopsScoring: true,
  },
  killstreaksEnabled: true,
  scorestreaksOnly: false,
  teamSize: [4, 6],
  introLine: 'Secure the hardpoint.',
};

const HEADQUARTERS: GameModeDef = {
  id: 'hq',
  name: 'Headquarters',
  shortName: 'HQ',
  description: 'Capture the HQ. Hold it — but while you hold it, you do not respawn.',
  teamBased: true,
  scoreLimit: 200,
  timeLimit: 720,
  roundsToWin: 1,
  roundTime: 720,
  respawn: true,
  respawnDelay: 5,
  objectiveKind: ObjectiveKind.Headquarters,
  scoring: scoring({
    objectiveTick: 5,
    objectiveTickInterval: 5,
    capture: 250,
    defend: 100,
  }),
  params: {
    captureTime: 8,
    /** Seconds the HQ stays live once captured. */
    holdTime: 60,
    /** Seconds before a new HQ appears after one expires or is destroyed. */
    respawnGap: 8,
    /** The defining rule: owning the HQ disables your respawns. */
    ownerRespawnDisabled: true,
  },
  killstreaksEnabled: true,
  scorestreaksOnly: false,
  teamSize: [4, 9],
  introLine: 'Secure the headquarters.',
};

const GUN_GAME: GameModeDef = {
  id: 'gungame',
  name: 'Gun Game',
  shortName: 'GG',
  description: 'Everyone starts on the same gun. Every kill promotes you. Finish the ladder.',
  teamBased: false,
  scoreLimit: 0,
  timeLimit: 900,
  roundsToWin: 1,
  roundTime: 900,
  respawn: true,
  respawnDelay: 2.5,
  objectiveKind: null,
  scoring: scoring({ kill: 100, assist: 0 }),
  params: {
    /** A melee kill knocks the victim back one rung. */
    meleeDemotes: true,
    /** Rungs in the ladder. Resolved to concrete weapons at runtime. */
    ladderLength: 20,
  },
  killstreaksEnabled: false,
  scorestreaksOnly: false,
  teamSize: [4, 12],
  introLine: 'Gun Game. Work the ladder.',
};

const ZOMBIES: GameModeDef = {
  id: 'zombies',
  name: 'Zombies',
  shortName: 'ZM',
  description: 'Survive. They get faster, tougher and more numerous every round.',
  teamBased: true,
  scoreLimit: 0,
  timeLimit: 0,
  roundsToWin: 0,
  roundTime: 0,
  respawn: true,
  // Downed players come back at the start of the next round, not on a timer.
  respawnDelay: 0,
  objectiveKind: null,
  scoring: scoring({ kill: 60, assist: 10 }),
  params: {
    /** Zombies in round 1; scales up from here. */
    baseZombieCount: 6,
    zombieCountGrowth: 1.18,
    /** Health multiplier applied per round after the first. */
    healthGrowth: 1.11,
    /** Speed ramps until it caps, or the mode becomes unplayable rather than hard. */
    speedGrowth: 1.035,
    maxSpeedMultiplier: 1.9,
    /** Rounds between which a free perk drop appears. */
    dropInterval: 4,
    /** Points awarded per hit and per kill. */
    pointsPerHit: 10,
    pointsPerKill: 60,
  },
  killstreaksEnabled: false,
  scorestreaksOnly: false,
  teamSize: [1, 4],
  introLine: 'Survive.',
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const ALL_MODES: GameModeDef[] = [
  TEAM_DEATHMATCH,
  FREE_FOR_ALL,
  DOMINATION,
  SEARCH_AND_DESTROY,
  KILL_CONFIRMED,
  HARDPOINT,
  HEADQUARTERS,
  GUN_GAME,
  ZOMBIES,
];

export const GAME_MODES: Record<string, GameModeDef> = Object.fromEntries(
  ALL_MODES.map((m) => [m.id, m]),
);

export const MODE_IDS: string[] = ALL_MODES.map((m) => m.id);

/** Modes offered in the standard multiplayer playlist (excludes Zombies). */
export const MULTIPLAYER_MODE_IDS: string[] = ALL_MODES.filter((m) => m.id !== 'zombies').map(
  (m) => m.id,
);

export const DEFAULT_MODE = TEAM_DEATHMATCH.id;

export function getMode(id: string): GameModeDef {
  const m = GAME_MODES[id];
  if (!m) throw new Error(`Unknown game mode id: ${id}`);
  return m;
}

export function tryGetMode(id: string): GameModeDef | undefined {
  return GAME_MODES[id];
}

/** Team size the lobby should use for a mode at a given population. */
export function defaultTeamSizeFor(mode: GameModeDef, playerCount: number): number {
  if (!mode.teamBased) return playerCount;
  const perTeam = Math.ceil(playerCount / 2);
  return Math.max(mode.teamSize[0], Math.min(mode.teamSize[1], perTeam));
}

// ---------------------------------------------------------------------------
// Gun Game ladder
// ---------------------------------------------------------------------------

/**
 * The ladder is expressed as class preferences rather than weapon ids, and
 * resolved against the live arsenal at runtime. That way the ladder can never
 * reference a weapon that has been renamed or removed — it degrades to a shorter
 * ladder instead of crashing the match.
 *
 * The shape is deliberate: it opens on pistols, runs through SMGs and rifles as
 * the player warms up, spikes to a sniper as a difficulty wall in the middle,
 * and finishes on a launcher and then the knife, so the last rung is a test of
 * nerve rather than of aim.
 */
const LADDER_PREFERENCES: WeaponClass[] = [
  WeaponClass.Pistol,
  WeaponClass.Pistol,
  WeaponClass.SubmachineGun,
  WeaponClass.SubmachineGun,
  WeaponClass.Shotgun,
  WeaponClass.AssaultRifle,
  WeaponClass.AssaultRifle,
  WeaponClass.SubmachineGun,
  WeaponClass.MarksmanRifle,
  WeaponClass.LightMachineGun,
  WeaponClass.AssaultRifle,
  WeaponClass.SniperRifle,
  WeaponClass.Shotgun,
  WeaponClass.SubmachineGun,
  WeaponClass.MarksmanRifle,
  WeaponClass.AssaultRifle,
  WeaponClass.LightMachineGun,
  WeaponClass.SniperRifle,
  WeaponClass.Launcher,
  WeaponClass.Melee,
];

/**
 * Resolve the ladder against the current arsenal.
 *
 * Synchronous: weapons.ts imports nothing from modes.ts, so there is no cycle
 * to work around, and a mode definition that can only be read from an async
 * context is a trap for every caller.
 */
export function gunGameLadder(): string[] {
  return resolveLadder(WEAPONS_BY_CLASS);
}

/**
 * Synchronous ladder resolution for callers that already hold the arsenal.
 * Walks each class in turn and takes the next unused weapon from it, so the
 * ladder never repeats a gun while alternatives remain.
 */
export function resolveLadder(
  weaponsByClass: Record<WeaponClass, Array<{ id: string }>>,
): string[] {
  const used = new Set<string>();
  const cursor = new Map<WeaponClass, number>();
  const out: string[] = [];

  for (const cls of LADDER_PREFERENCES) {
    const pool = weaponsByClass[cls] ?? [];
    if (pool.length === 0) continue;

    let idx = cursor.get(cls) ?? 0;
    let picked: string | undefined;
    for (let i = 0; i < pool.length; i++) {
      const candidate = pool[(idx + i) % pool.length];
      if (candidate && !used.has(candidate.id)) {
        picked = candidate.id;
        idx = (idx + i + 1) % pool.length;
        break;
      }
    }
    // Every weapon in this class is already on the ladder — reuse the first.
    if (!picked) picked = pool[0]!.id;

    cursor.set(cls, idx);
    used.add(picked);
    out.push(picked);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Queries used by the match engine
// ---------------------------------------------------------------------------

export function isRoundBased(mode: GameModeDef): boolean {
  return mode.roundsToWin > 1;
}

export function usesObjectives(mode: GameModeDef): boolean {
  return mode.objectiveKind !== null;
}

/** Whether a mode's score limit has been reached. */
export function hasReachedScoreLimit(mode: GameModeDef, score: number): boolean {
  return mode.scoreLimit > 0 && score >= mode.scoreLimit;
}

/**
 * Effective streak cost for a player, honouring the mode's scorestreak rule and
 * any perk discount.
 */
export function streakCost(
  mode: GameModeDef,
  killCost: number,
  scoreCost: number,
  discount: number,
): number {
  const base = mode.scorestreaksOnly ? scoreCost : killCost;
  return Math.max(1, Math.round(base * discount));
}
