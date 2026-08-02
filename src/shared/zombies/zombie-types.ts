/**
 * Zombies: types and per-map layout.
 *
 * The mode is a different game played with the same simulation. Zombies are
 * ordinary `PlayerState` entities on `Team.Hostile`, so they collide, take
 * damage, get shot in the head for extra damage and path around the map through
 * exactly the same code as everything else. Nothing about them is special-cased
 * in movement or combat, which is why they inherit wallbangs, explosions and
 * hitboxes for free.
 *
 * What *is* new is the economy. Every mechanic here — the box, the wall buys,
 * the perk machines, the doors — is a decision about how to spend points you
 * only earn by taking risks, and the round curve exists to make that decision
 * get harder every ninety seconds.
 *
 * Zombie layouts live here rather than in MapDef so that adding a zombies map is
 * opt-in and a multiplayer map does not carry data it never uses.
 */

import type { Vec3 } from '../math.js';

// ---------------------------------------------------------------------------
// Interactables
// ---------------------------------------------------------------------------

export enum InteractKind {
  /** A barred door or debris pile that opens a new area for points. */
  Door = 'door',
  /** A weapon bolted to a wall, bought once for the gun and again for ammo. */
  WallBuy = 'wall_buy',
  /** The Mystery Box: a random weapon for a fixed price. */
  MysteryBox = 'mystery_box',
  /** Pack-a-Punch: upgrades the weapon in your hands. */
  PackAPunch = 'pack_a_punch',
  /** A perk machine. */
  PerkMachine = 'perk_machine',
  /** The power switch. Several things stay inert until it is thrown. */
  Power = 'power',
}

export interface InteractableDef {
  id: string;
  kind: InteractKind;
  position: Vec3;
  /** Facing, for the model and for the prompt's placement. */
  yaw: number;
  /** Points required. Doors and wall buys use this; the box uses boxCost. */
  cost: number;
  /** Which zone this sits in — it is unusable until that zone is open. */
  zone: string;
  /** Doors only: the zone this door unlocks. */
  opensZone?: string;
  /** Wall buys only. */
  weaponId?: string;
  /** Ammo refill price once you already own the wall weapon. */
  ammoCost?: number;
  /** Perk machines only. */
  perkId?: string;
  /** True if it needs the power on. */
  requiresPower?: boolean;
  /** Prompt shown to the player. */
  label: string;
}

/** A zone is a region of the map that starts closed and is opened by a door. */
export interface ZoneDef {
  id: string;
  name: string;
  /** Zombie spawn points inside this zone. Only open zones spawn zombies. */
  spawnPoints: Vec3[];
  /** True for the area players start in. */
  startingZone?: boolean;
}

export interface ZombiesMapData {
  mapId: string;
  /** Where the players begin. */
  playerSpawns: Vec3[];
  zones: ZoneDef[];
  interactables: InteractableDef[];
  /** The weapon everyone starts with. Deliberately weak. */
  startingWeapon: string;
  startingPistol: string;
  /** Points every player starts with. */
  startingPoints: number;
}

// ---------------------------------------------------------------------------
// Perks
// ---------------------------------------------------------------------------

/**
 * Zombies perks are permanent for a life and stack, which makes them the main
 * thing points are for after the first few rounds. They are intentionally
 * transformative rather than incremental — Juggernog roughly triples how long
 * you survive a mistake, and that is the point.
 */
export interface ZombiePerkDef {
  id: string;
  name: string;
  cost: number;
  description: string;
  /** Multiplier on max health. */
  healthMult?: number;
  /** Multiplier on reload duration (below 1 is faster). */
  reloadMult?: number;
  /** Multiplier on rate of fire. */
  fireRateMult?: number;
  /** Multiplier on movement speed. */
  speedMult?: number;
  /** Faster revives, and self-revive when playing alone. */
  reviveMult?: number;
  selfRevive?: boolean;
  colour: number;
}

export const ZOMBIE_PERKS: Record<string, ZombiePerkDef> = {
  juggernog: {
    id: 'juggernog',
    name: 'Juggernog',
    cost: 2500,
    description: 'Take roughly three times as much punishment before you go down.',
    healthMult: 2.5,
    colour: 0xc03030,
  },
  speed_cola: {
    id: 'speed_cola',
    name: 'Speed Cola',
    cost: 3000,
    description: 'Reload in about half the time. The difference between a train and a death.',
    reloadMult: 0.5,
    colour: 0x30a040,
  },
  double_tap: {
    id: 'double_tap',
    name: 'Double Tap',
    cost: 2000,
    description: 'Fire a third faster. Burns ammo just as quickly.',
    fireRateMult: 1.33,
    colour: 0xd0a020,
  },
  stamin_up: {
    id: 'stamin_up',
    name: 'Stamin-Up',
    cost: 2000,
    description: 'Move noticeably faster. Space is the only resource that never runs out.',
    speedMult: 1.18,
    colour: 0x3060c0,
  },
  quick_revive: {
    id: 'quick_revive',
    name: 'Quick Revive',
    cost: 1500,
    description: 'Revive teammates faster. Alone, it will pick you up once.',
    reviveMult: 0.45,
    selfRevive: true,
    colour: 0x40c0d0,
  },
};

export const ZOMBIE_PERK_IDS = Object.keys(ZOMBIE_PERKS);

/** Perks a player may hold at once. Unlimited perks removes every decision. */
export const MAX_ZOMBIE_PERKS = 4;

// ---------------------------------------------------------------------------
// Round curve
// ---------------------------------------------------------------------------

/**
 * How a round scales.
 *
 * The shape matters more than the numbers: health grows without limit so there
 * is always an eventual wall, but SPEED is capped. An uncapped speed curve does
 * not make the game harder, it makes it unplayable at a specific round and
 * identical before that.
 */
export const ROUND_CURVE = {
  /** Zombies in round 1, per player. */
  baseCount: 6,
  countPerRound: 1.7,
  countPerPlayer: 0.9,
  /** Hard cap on how many can be alive at once, for frame budget. */
  maxAlive: 24,

  baseHealth: 150,
  /** Linear health growth to round 9, then exponential — the classic curve. */
  healthPerRound: 100,
  exponentialFromRound: 10,
  healthExponent: 1.14,

  baseSpeed: 1.6,
  speedPerRound: 0.09,
  maxSpeed: 4.4,

  /** Seconds between spawns, shrinking each round so later rounds crowd. */
  baseSpawnInterval: 2.6,
  minSpawnInterval: 0.35,
  spawnIntervalDecay: 0.93,

  /** Seconds of breathing room between rounds. */
  intermission: 9,
} as const;

export function zombieHealthForRound(round: number): number {
  if (round < ROUND_CURVE.exponentialFromRound) {
    return ROUND_CURVE.baseHealth + (round - 1) * ROUND_CURVE.healthPerRound;
  }
  const atTransition =
    ROUND_CURVE.baseHealth + (ROUND_CURVE.exponentialFromRound - 1) * ROUND_CURVE.healthPerRound;
  return Math.round(
    atTransition * ROUND_CURVE.healthExponent ** (round - ROUND_CURVE.exponentialFromRound + 1),
  );
}

export function zombieSpeedForRound(round: number): number {
  return Math.min(
    ROUND_CURVE.maxSpeed,
    ROUND_CURVE.baseSpeed + (round - 1) * ROUND_CURVE.speedPerRound,
  );
}

export function zombieCountForRound(round: number, players: number): number {
  const raw =
    ROUND_CURVE.baseCount +
    (round - 1) * ROUND_CURVE.countPerRound * (1 + (players - 1) * ROUND_CURVE.countPerPlayer);
  return Math.max(1, Math.round(raw));
}

export function spawnIntervalForRound(round: number): number {
  return Math.max(
    ROUND_CURVE.minSpawnInterval,
    ROUND_CURVE.baseSpawnInterval * ROUND_CURVE.spawnIntervalDecay ** (round - 1),
  );
}

// ---------------------------------------------------------------------------
// Points
// ---------------------------------------------------------------------------

/**
 * The economy.
 *
 * Hits pay, which is what makes a weak starting pistol survivable: you are paid
 * to shoot even when you cannot kill. Headshots pay a premium so that aiming
 * remains worth it once you can afford a gun that does not need it.
 */
export const POINTS = {
  hit: 10,
  kill: 60,
  headshotKill: 100,
  meleeKill: 130,
  /** Awarded to the reviver, so picking someone up is never a pure cost. */
  revive: 100,
  /** Every player gets this when a round ends. */
  roundBonus: 50,
} as const;

export const MYSTERY_BOX_COST = 950;
export const PACK_A_PUNCH_COST = 5000;

/** How much of a full magazine a wall-buy ammo purchase gives. */
export const WALL_AMMO_MAGS = 3;

// ---------------------------------------------------------------------------
// Downed state
// ---------------------------------------------------------------------------

export const DOWN = {
  /** Seconds a downed player survives before bleeding out. */
  bleedOutTime: 45,
  /** Seconds to revive a teammate. */
  reviveTime: 5,
  /** How close you must be. */
  reviveRadius: 2.2,
  /** Health a revived player comes back with. */
  reviveHealth: 100,
  /** Movement speed while crawling. */
  crawlSpeedMult: 0.35,
} as const;
