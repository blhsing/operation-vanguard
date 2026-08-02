/**
 * Collision query interface.
 *
 * The movement controller, ballistics, AI line-of-sight and grenade physics all
 * talk to the world through this interface and nothing else. That keeps the
 * broadphase implementation swappable and — critically — keeps the simulation
 * free of any three.js dependency so it can run on the server.
 *
 * Convention: all directions passed in are unit length; all distances are metres.
 */

import type { Vec3 } from '../math.js';
import type { EntityId, SurfaceType } from '../types.js';

/** Bit mask selecting which categories of geometry a query should consider. */
export enum CollisionLayer {
  None = 0,
  /** Static level geometry. */
  World = 1 << 0,
  /** Brushes that stop players but let bullets through (railings, chain fence). */
  PlayerClip = 1 << 1,
  /** Brushes that stop bullets but not players (invisible bullet blockers). */
  BulletClip = 1 << 2,
  /** Player capsules. */
  Player = 1 << 3,
  /** Deployables, care packages, sentry guns. */
  Deployable = 1 << 4,
  /** Killstreak vehicles. */
  Vehicle = 1 << 5,
  /** Destructible props. */
  Breakable = 1 << 6,
  /** Water volumes — no collision, but changes movement and audio. */
  Water = 1 << 7,

  /** Everything a walking player collides with. */
  Movement = World | PlayerClip | Breakable | Deployable | Vehicle,
  /** Everything a bullet can hit. */
  Bullet = World | BulletClip | Player | Breakable | Deployable | Vehicle,
  /** Everything that blocks line of sight. */
  Sight = World | Breakable,
  /** Everything a thrown grenade bounces off. */
  Projectile = World | PlayerClip | Breakable | Deployable | Vehicle,
}

export interface RaycastHit {
  /** True if anything was hit. Check this before reading any other field. */
  hit: boolean;
  /** Distance along the ray to the impact point. */
  distance: number;
  point: Vec3;
  normal: Vec3;
  surface: SurfaceType;
  /** Set when the hit was against an entity rather than static geometry. */
  entity: EntityId;
  /** Index of the brush that was hit, or -1 for entities. */
  brushIndex: number;
  /** How much material the ray would have to pass through to continue, in metres. */
  thickness: number;
  /** Which layer the hit belongs to. */
  layer: CollisionLayer;
}

export function createRaycastHit(): RaycastHit {
  return {
    hit: false,
    distance: 0,
    point: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 1, z: 0 },
    surface: 0 as SurfaceType,
    entity: 0,
    brushIndex: -1,
    thickness: 0,
    layer: CollisionLayer.None,
  };
}

export interface SweepHit {
  hit: boolean;
  /** Fraction of the requested motion completed before contact, in [0, 1]. */
  fraction: number;
  point: Vec3;
  normal: Vec3;
  surface: SurfaceType;
  entity: EntityId;
  brushIndex: number;
  /** True when the capsule started already overlapping geometry. */
  startedSolid: boolean;
}

export function createSweepHit(): SweepHit {
  return {
    hit: false,
    fraction: 1,
    point: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 1, z: 0 },
    surface: 0 as SurfaceType,
    entity: 0,
    brushIndex: -1,
    startedSolid: false,
  };
}

/** Optional filter so a query can ignore the shooter's own capsule, teammates, etc. */
export interface QueryFilter {
  layers: CollisionLayer;
  /** Entity ids to skip. */
  ignoreEntities?: readonly EntityId[];
  /** Return false to skip a candidate entity. */
  entityPredicate?: (id: EntityId) => boolean;
}

/**
 * The queries every collision backend must provide.
 *
 * Implementations must be deterministic: given the same world state and the same
 * arguments they must return bit-identical results on client and server, because
 * prediction replays them.
 */
export interface CollisionWorld {
  /**
   * Cast a ray and return the nearest hit.
   * `out` is filled in and returned so hot loops don't allocate.
   */
  raycast(
    origin: Vec3,
    direction: Vec3,
    maxDistance: number,
    filter: QueryFilter,
    out: RaycastHit,
  ): RaycastHit;

  /**
   * Cast a ray and report every hit along it, nearest first. Used for bullet
   * penetration, where a round may pass through several surfaces.
   * Returns the number of hits written into `out`.
   */
  raycastAll(
    origin: Vec3,
    direction: Vec3,
    maxDistance: number,
    filter: QueryFilter,
    out: RaycastHit[],
    maxHits: number,
  ): number;

  /**
   * Sweep a vertical capsule (feet at `start`, given height and radius) along
   * `delta` and report first contact.
   */
  sweepCapsule(
    start: Vec3,
    height: number,
    radius: number,
    delta: Vec3,
    filter: QueryFilter,
    out: SweepHit,
  ): SweepHit;

  /**
   * Push a capsule out of any geometry it currently overlaps.
   * Writes the corrected feet position into `out` and returns true if it moved.
   */
  resolvePenetration(
    position: Vec3,
    height: number,
    radius: number,
    filter: QueryFilter,
    out: Vec3,
  ): boolean;

  /** Cheap "is this capsule position free?" test used by spawn selection. */
  isCapsuleFree(position: Vec3, height: number, radius: number, filter: QueryFilter): boolean;

  /**
   * Unobstructed line of sight between two points. Separate from `raycast`
   * because AI calls it thousands of times per second and it can short-circuit.
   */
  isVisible(from: Vec3, to: Vec3, filter: QueryFilter): boolean;

  /** Ground height directly beneath a point, or -Infinity if there is none. */
  groundHeightAt(x: number, z: number, fromY: number, maxDrop: number): number;
}

// ---------------------------------------------------------------------------
// Surface behaviour table
//
// Lives here rather than in types.ts because it is consumed almost exclusively
// by collision-adjacent code: penetration, footsteps, impact VFX.
// ---------------------------------------------------------------------------

import type { SurfaceProperties } from '../types.js';
import { SurfaceType as ST } from '../types.js';

export const SURFACE_PROPERTIES: Record<SurfaceType, SurfaceProperties> = {
  [ST.Concrete]: { penetration: 0.25, damageRetention: 0.35, footstepVolume: 0.85, breakable: false },
  [ST.Metal]: { penetration: 0.15, damageRetention: 0.2, footstepVolume: 1.0, breakable: false },
  [ST.Wood]: { penetration: 0.7, damageRetention: 0.75, footstepVolume: 0.8, breakable: true },
  [ST.Dirt]: { penetration: 0.4, damageRetention: 0.45, footstepVolume: 0.55, breakable: false },
  [ST.Grass]: { penetration: 0.5, damageRetention: 0.55, footstepVolume: 0.4, breakable: false },
  [ST.Sand]: { penetration: 0.35, damageRetention: 0.4, footstepVolume: 0.45, breakable: false },
  [ST.Water]: { penetration: 0.9, damageRetention: 0.6, footstepVolume: 0.9, breakable: false },
  [ST.Glass]: { penetration: 0.95, damageRetention: 0.92, footstepVolume: 0.9, breakable: true },
  [ST.Foliage]: { penetration: 1.0, damageRetention: 0.98, footstepVolume: 0.6, breakable: false },
  [ST.Flesh]: { penetration: 0.8, damageRetention: 0.7, footstepVolume: 0.3, breakable: false },
  [ST.Carpet]: { penetration: 0.6, damageRetention: 0.7, footstepVolume: 0.3, breakable: false },
  [ST.Gravel]: { penetration: 0.3, damageRetention: 0.4, footstepVolume: 1.0, breakable: false },
  [ST.Snow]: { penetration: 0.6, damageRetention: 0.6, footstepVolume: 0.5, breakable: false },
  [ST.Tile]: { penetration: 0.45, damageRetention: 0.5, footstepVolume: 0.95, breakable: true },
  [ST.Plastic]: { penetration: 0.8, damageRetention: 0.85, footstepVolume: 0.7, breakable: true },
  [ST.Brick]: { penetration: 0.3, damageRetention: 0.4, footstepVolume: 0.85, breakable: false },
};

/** Default albedo per surface, used when a brush doesn't override it. */
export const SURFACE_COLORS: Record<SurfaceType, number> = {
  [ST.Concrete]: 0x8a8a86,
  [ST.Metal]: 0x6e747a,
  [ST.Wood]: 0x8a6440,
  [ST.Dirt]: 0x6b5a45,
  [ST.Grass]: 0x5c7a44,
  [ST.Sand]: 0xc2ab7f,
  [ST.Water]: 0x2b5a72,
  [ST.Glass]: 0xa8c4cc,
  [ST.Foliage]: 0x40632f,
  [ST.Flesh]: 0x9c5a52,
  [ST.Carpet]: 0x6a4a48,
  [ST.Gravel]: 0x7d7a72,
  [ST.Snow]: 0xe4eaf0,
  [ST.Tile]: 0xb8b4ac,
  [ST.Plastic]: 0x585c62,
  [ST.Brick]: 0x91564a,
};

/** Default PBR roughness per surface. */
export const SURFACE_ROUGHNESS: Record<SurfaceType, number> = {
  [ST.Concrete]: 0.92,
  [ST.Metal]: 0.42,
  [ST.Wood]: 0.78,
  [ST.Dirt]: 0.98,
  [ST.Grass]: 0.95,
  [ST.Sand]: 0.96,
  [ST.Water]: 0.08,
  [ST.Glass]: 0.05,
  [ST.Foliage]: 0.88,
  [ST.Flesh]: 0.7,
  [ST.Carpet]: 0.99,
  [ST.Gravel]: 0.96,
  [ST.Snow]: 0.85,
  [ST.Tile]: 0.35,
  [ST.Plastic]: 0.55,
  [ST.Brick]: 0.9,
};

/**
 * Metalness per surface, for the physical shader.
 *
 * `Metal` is deliberately far below the ~0.9 a real metal would take. A metal
 * has no diffuse response: under a physical shader it is only what it reflects,
 * and this game ships zero binary assets and therefore has no environment map.
 * At a physically honest value every metal surface the sun does not directly
 * strike renders pure black — a shaded steel warehouse becomes a hole cut in the
 * world, and an underground station's rolling stock becomes a silhouette. A
 * painted, weathered value is the correct trade for a game with nothing to
 * reflect.
 */
export const SURFACE_METALNESS: Record<SurfaceType, number> = {
  [ST.Concrete]: 0,
  [ST.Metal]: 0.3,
  [ST.Wood]: 0,
  [ST.Dirt]: 0,
  [ST.Grass]: 0,
  [ST.Sand]: 0,
  [ST.Water]: 0.1,
  [ST.Glass]: 0,
  [ST.Foliage]: 0,
  [ST.Flesh]: 0,
  [ST.Carpet]: 0,
  [ST.Gravel]: 0,
  [ST.Snow]: 0,
  [ST.Tile]: 0.05,
  [ST.Plastic]: 0,
  [ST.Brick]: 0,
};
