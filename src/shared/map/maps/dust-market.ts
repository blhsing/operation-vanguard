/**
 * Dust Market — a desert bazaar at noon.
 *
 * The brightest map in the set, and the one built around a single readable idea:
 * the market itself is a maze of stalls and awnings at chest height, so the
 * middle of the map is dense, low and constantly broken, while the two flanking
 * streets are long and clean.
 *
 *      AXIS (north, -z)
 *   ┌────────┬──────────┬────────┐
 *   │  WEST  │  BAZAAR  │  EAST  │  west  = colonnade, pillars, medium range
 *   │ COLON- │  (stalls,│ STREET │  mid   = the market: dense, chaotic, short
 *   │  NADE  │  awnings)│ + ROOF │  east  = open street with a roof terrace
 *   └────────┴──────────┴────────┘
 *      ALLIES (south, +z)
 *
 * The awnings matter more than they look: they block sight from the roof
 * terrace and from any air support, which is what stops the east side's height
 * advantage from covering the whole map.
 */

import { SurfaceType, Team } from '../../types.js';
import { vec3 } from '../../math.js';
import {
  box,
  cylinder,
  type Brush,
  type CoverPoint,
  type MapDef,
  type NavLink,
  type SpawnPoint,
} from '../map-types.js';
import { ObjectiveKind } from '../map-types.js';
import {
  barrelCluster,
  barrier,
  building,
  car,
  catwalk,
  crate,
  crateStack,
  ground,
  lowWall,
  marketStall,
  perimeter,
  sandbags,
  stairs,
  tree,
  truck,
} from '../props.js';

const BOUNDS = { min: vec3(-46, -3, -44), max: vec3(46, 26, 44) };

const FACE_N = 0;
const FACE_S = Math.PI;
const FACE_E = -Math.PI / 2;
const FACE_W = Math.PI / 2;

function cover(x: number, z: number, facing: number, exposure: number, value = 1, crouch = false, y = 0): CoverPoint {
  return { position: vec3(x, y, z), facing, crouch, exposure, value };
}

function spawnCluster(
  cx: number,
  cz: number,
  team: Team,
  group: string,
  yaw: number,
  count: number,
  spread = 3.0,
  y = 0,
): SpawnPoint[] {
  const lattice: Array<[number, number]> = [
    [0, 0], [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [-1, 1], [1, -1], [-1, -1], [2, 0], [-2, 0], [0, 2],
  ];
  return lattice.slice(0, count).map(([ox, oz], i) => ({
    position: vec3(cx + ox * spread, y + 0.1, cz + oz * spread),
    yaw: yaw + (i % 3) * 0.16 - 0.16,
    team,
    group,
    priority: 1 - (Math.abs(ox) + Math.abs(oz)) * 0.06,
  }));
}

/** A stone arch: the west colonnade is built from these. */
function arch(x: number, z: number, yaw = 0): Brush[] {
  return [
    cylinder(vec3(x - 1.8, 2.1, z), 0.5, 4.2, SurfaceType.Sand, { color: 0xc7b283, segments: 10, castShadow: true }),
    cylinder(vec3(x + 1.8, 2.1, z), 0.5, 4.2, SurfaceType.Sand, { color: 0xc7b283, segments: 10, castShadow: true }),
    box(vec3(x, 4.5, z), vec3(4.8, 0.6, 1.2), SurfaceType.Sand, { yaw, color: 0xc7b283, castShadow: true }),
  ];
}

// ---------------------------------------------------------------------------

function buildGeometry(): Brush[] {
  const b: Brush[] = [];

  b.push(ground(vec3(0, 0, 0), 94, 90, SurfaceType.Sand, 0xcbb890));
  // Packed-earth roadway through the middle, so the lanes read from the ground up.
  b.push(
    box(vec3(0, -0.02, 0), vec3(24, 0.04, 76), SurfaceType.Dirt, {
      color: 0xa08a63, textureScale: 16, solid: false, castShadow: false,
    }),
  );
  b.push(...perimeter(vec3(-42, 0, -40), vec3(42, 0, 40), 13, SurfaceType.Brick, 0xb09873));

  // --- west: the colonnade -------------------------------------------------
  // Pillars every eight metres. Sightlines exist but every one of them is
  // interrupted, which makes this the map's medium-range lane.
  for (let z = -26; z <= 26; z += 8) {
    b.push(...arch(-28, z));
  }
  b.push(lowWall(vec3(-35, 0, -10), 22, FACE_E, 1.9, SurfaceType.Brick));
  b.push(lowWall(vec3(-35, 0, 16), 16, FACE_E, 1.9, SurfaceType.Brick));
  b.push(...crateStack(vec3(-33, 0, 2)));
  b.push(...barrelCluster(vec3(-24, 0, -18), 4, 0x8a6a3a));
  b.push(crate(vec3(-31, 0, -24), 1.4));
  b.push(crate(vec3(-25, 0, 20), 1.2));
  b.push(sandbags(vec3(-30, 0, 30), 6, 0));
  b.push(sandbags(vec3(-29, 0, -31), 6, 0));
  b.push(...tree(vec3(-38, 0, 8), 5.5, 2.4));

  // --- mid: the bazaar -----------------------------------------------------
  // Dense and low. Nothing here is taller than a person except the awnings, so
  // the whole zone is a knife fight you cannot see across.
  const stallGrid: Array<[number, number, number, number]> = [
    [-7, -22, 0.1, 0xa8483a], [6, -20, -0.15, 0x3a6aa8], [-5, -13, 0.2, 0x4a8a5a],
    [7, -11, 0.05, 0xa88a3a], [-8, -4, -0.1, 0x8a3a6a], [5, -2, 0.18, 0x3a8a8a],
    [-6, 5, 0.05, 0xa8683a], [8, 7, -0.2, 0x6a3a8a], [-4, 14, 0.12, 0x8aa83a],
    [6, 16, -0.08, 0xa83a5a], [-7, 23, 0.15, 0x3a8a4a], [5, 25, 0.0, 0xa8a83a],
  ];
  for (const [x, z, yaw, colour] of stallGrid) {
    b.push(...marketStall(vec3(x, 0, z), yaw, colour));
  }

  // Awnings between the stall rows: they read as shade and they break the roof
  // terrace's line onto the market.
  for (const z of [-18, -8, 2, 12, 22]) {
    b.push(
      box(vec3(0, 3.1, z), vec3(20, 0.12, 4.5), SurfaceType.Plastic, {
        color: 0xb8763a, solid: false, castShadow: true,
      }),
    );
  }

  b.push(...car(vec3(-10, 0, 30), 0.3, 0x9a8a5a));
  b.push(...car(vec3(9, 0, -30), 2.85, 0x7a6a4a));
  b.push(...truck(vec3(0, 0, -36), 1.58, 0x8a7a4a));
  b.push(barrier(vec3(-3, 0, 19), 4, 0));
  b.push(barrier(vec3(4, 0, -19), 4, 0.08));
  b.push(...barrelCluster(vec3(-11, 0, 0), 5, 0x9a5a2a));
  b.push(...barrelCluster(vec3(11, 0, -6), 4, 0x5a7a9a));
  b.push(crate(vec3(2, 0, 9), 1.6));
  b.push(crate(vec3(-2, 0, -9), 1.4));

  // --- east: street and roof terrace ---------------------------------------
  b.push(
    ...building(vec3(28, 3.2, 6), vec3(18, 6.4, 26), {
      surface: SurfaceType.Brick,
      color: 0xbfa87c,
      floorSurface: SurfaceType.Tile,
      doors: { '-x': [-9, 8], '+z': [-4], '-z': [4] },
      windows: { '-x': [0], '+x': [-9, 9] },
      doorWidth: 2.4,
      doorHeight: 2.6,
    }),
  );
  // Roof terrace: strong, but the awnings deny it the market.
  b.push(...catwalk(vec3(28, 6.6, 6), vec3(18, 0.2, 26), 0, ['-x', '+x']));
  b.push(lowWall(vec3(19.2, 6.7, 6), 26, FACE_E, 1.0, SurfaceType.Brick));
  // Climbs northward and arrives at the terrace's open south edge. Run the other
  // way and the flight tops out eight metres short of the roof it serves.
  b.push(...stairs(vec3(34, 0, -14), 6.75, 7.0, 3.0, '+z', SurfaceType.Sand));

  b.push(
    ...building(vec3(30, 2.6, -24), vec3(14, 5.2, 10), {
      surface: SurfaceType.Brick, color: 0xb59e74,
      doors: { '-x': [0], '+z': [0] }, windows: { '-x': [-4] },
    }),
  );
  b.push(...crateStack(vec3(20, 0, -14)));
  b.push(crate(vec3(24, 0, 24), 1.4));
  b.push(sandbags(vec3(32, 0, 30), 6, 0));
  b.push(sandbags(vec3(31, 0, -32), 6, 0.05));
  b.push(...barrelCluster(vec3(22, 0, 18), 3, 0x8a4a2a));

  // --- staging areas -------------------------------------------------------
  b.push(
    ...building(vec3(-28, 2.4, 34), vec3(13, 4.8, 8), {
      surface: SurfaceType.Brick, color: 0xb59e74,
      doors: { '-z': [0] }, windows: { '+x': [0] },
    }),
  );
  b.push(
    ...building(vec3(28, 2.4, 35), vec3(13, 4.8, 8), {
      surface: SurfaceType.Brick, color: 0xb59e74,
      doors: { '-z': [2] }, windows: { '-x': [0] },
    }),
  );
  b.push(
    ...building(vec3(-28, 2.4, -35), vec3(13, 4.8, 8), {
      surface: SurfaceType.Brick, color: 0xb59e74,
      doors: { '+z': [0] }, windows: { '+x': [0] },
    }),
  );
  b.push(barrier(vec3(-8, 0, 32), 5, 0));
  b.push(barrier(vec3(8, 0, 32), 5, 0));
  b.push(barrier(vec3(-8, 0, -32), 5, 0));
  b.push(barrier(vec3(8, 0, -32), 5, 0));

  return b;
}

// ---------------------------------------------------------------------------

function buildSpawns(): SpawnPoint[] {
  return [
    ...spawnCluster(0, 34, Team.Allies, 'allies_home', FACE_N, 7, 3.0),
    ...spawnCluster(-18, 29, Team.Allies, 'allies_west', FACE_N, 5, 2.8),
    ...spawnCluster(20, 30, Team.Allies, 'allies_east', FACE_N, 5, 2.8),
    ...spawnCluster(-36, 22, Team.Allies, 'allies_mid_west', FACE_N, 4, 2.6),
    ...spawnCluster(38, 23, Team.Allies, 'allies_mid_east', FACE_N, 4, 2.6),

    ...spawnCluster(0, -28, Team.Axis, 'axis_home', FACE_S, 7, 3.0),
    ...spawnCluster(-20, -30, Team.Axis, 'axis_west', FACE_S, 5, 2.8),
    ...spawnCluster(20, -34, Team.Axis, 'axis_east', FACE_S, 5, 2.8),
    ...spawnCluster(-38, -22, Team.Axis, 'axis_mid_west', FACE_S, 4, 2.6),
    ...spawnCluster(39, -12, Team.Axis, 'axis_mid_east', FACE_S, 4, 2.4),

    // The roof terrace, deliberately spawned on. Height that nobody starts on
    // never gets contested — bots go where the enemies they can see are, so an
    // empty roof stays an empty roof.
    ...spawnCluster(28, 12, Team.Allies, 'allies_terrace', FACE_N, 3, 2.6, 6.75),
    ...spawnCluster(28, -2, Team.None, 'ffa_terrace', FACE_S, 3, 2.6, 6.75),

    ...spawnCluster(-38, 0, Team.None, 'ffa_west', FACE_N, 4, 3.0),
    ...spawnCluster(38, 6, Team.None, 'ffa_east', FACE_S, 4, 3.0),
    ...spawnCluster(-16, 12, Team.None, 'ffa_south', FACE_N, 4, 3.0),
    ...spawnCluster(16, -18, Team.None, 'ffa_north', FACE_S, 4, 3.0),
  ];
}

function buildCoverPoints(): CoverPoint[] {
  const out: CoverPoint[] = [];

  // Bazaar stalls — the densest cover on the map, all short range.
  const stalls: Array<[number, number]> = [
    [-7, -22], [6, -20], [-5, -13], [7, -11], [-8, -4], [5, -2],
    [-6, 5], [8, 7], [-4, 14], [6, 16], [-7, 23], [5, 25],
  ];
  for (const [x, z] of stalls) {
    out.push(cover(x, z + 1.4, FACE_S, 0.35, 1.4, true));
    out.push(cover(x, z - 1.4, FACE_N, 0.35, 1.4, true));
  }

  // West colonnade: one hold per pillar pair.
  for (let z = -26; z <= 26; z += 8) {
    out.push(cover(-28, z, z < 0 ? FACE_N : FACE_S, 0.3, 1.5));
  }
  out.push(cover(-35, -10, FACE_E, 0.25, 1.3, true));
  out.push(cover(-35, 16, FACE_E, 0.25, 1.3, true));
  out.push(cover(-33, 2, FACE_E, 0.3, 1.2));
  out.push(cover(-24, -18, FACE_N, 0.3, 1.1, true));
  out.push(cover(-30, 30, FACE_N, 0.35, 0.8, true));
  out.push(cover(-29, -31, FACE_S, 0.35, 0.8, true));

  // East street and terrace.
  out.push(cover(28, -6, FACE_N, 0.3, 1.6, true));
  out.push(cover(28, 18, FACE_S, 0.3, 1.6, true));
  out.push(cover(20, -14, FACE_W, 0.3, 1.4));
  out.push(cover(24, 24, FACE_N, 0.3, 1.2, true));
  out.push(cover(30, -22, FACE_S, 0.3, 1.4, true));
  out.push(cover(22, 18, FACE_W, 0.3, 1.1, true));
  out.push(cover(32, 30, FACE_N, 0.35, 0.8, true));
  out.push(cover(31, -32, FACE_S, 0.35, 0.8, true));

  // The terrace: strong, but the awnings deny it the market.
  //
  // Kept under six metres apart. The nav graph links only nodes it can sweep a
  // capsule between and cannot chain a staircase, so a thinly-covered roof forms
  // its own island and is pruned — leaving a terrace that renders beautifully
  // and that no bot has ever stood on.
  out.push(cover(21, -4, FACE_S, 0.55, 1.8, true, 6.8));
  out.push(cover(21, 1, FACE_W, 0.6, 2.1, true, 6.8));
  out.push(cover(21, 6, FACE_W, 0.6, 2.1, true, 6.8));
  out.push(cover(21, 11, FACE_W, 0.55, 1.9, true, 6.8));
  out.push(cover(21, 16, FACE_N, 0.5, 1.6, true, 6.8));
  out.push(cover(27, 16, FACE_N, 0.55, 1.8, true, 6.8));
  out.push(cover(33, 14, FACE_N, 0.5, 1.6, true, 6.8));
  out.push(cover(34, 8, FACE_E, 0.45, 1.5, true, 6.8));
  out.push(cover(34, 2, FACE_E, 0.45, 1.5, true, 6.8));
  out.push(cover(33, -4, FACE_S, 0.5, 1.7, true, 6.8));

  // Mid props.
  out.push(cover(-11, 0, FACE_E, 0.45, 1.2, true));
  out.push(cover(11, -6, FACE_W, 0.45, 1.2, true));
  out.push(cover(-3, 20, FACE_N, 0.45, 1.1, true));
  out.push(cover(4, -20, FACE_S, 0.45, 1.1, true));

  return out;
}

function buildNavLinks(): NavLink[] {
  return [
    // The staircase, both ways. A roof that can only be jumped off is a roof the
    // connectivity pass never reaches from the ground, and an unreachable
    // component is a pruned one.
    { from: vec3(34, 0, -17), to: vec3(34, 6.8, -6), kind: 'ladder', cost: 1.4, bidirectional: true },

    { from: vec3(20.5, 6.8, 0), to: vec3(17.5, 0, 0), kind: 'drop', cost: 1.0, bidirectional: false },
    { from: vec3(20.5, 6.8, 14), to: vec3(17.5, 0, 14), kind: 'drop', cost: 1.0, bidirectional: false },
    { from: vec3(20, 0, -12), to: vec3(20, 1.4, -14), kind: 'mantle', cost: 1.6, bidirectional: false },
    { from: vec3(-33, 0, 0), to: vec3(-33, 1.4, 2), kind: 'mantle', cost: 1.6, bidirectional: false },
    { from: vec3(-35, 0, -8), to: vec3(-35, 0, -12), kind: 'mantle', cost: 2.0, bidirectional: true },
  ];
}

// ---------------------------------------------------------------------------

export const DUST_MARKET: MapDef = {
  id: 'dust_market',
  name: 'Dust Market',
  tagline: 'Everything is for sale and none of it is cover.',
  description:
    'A bazaar at noon. The market in the middle is a maze of stalls and awnings where ' +
    'nothing is more than a second away; the colonnade and the street either side are ' +
    'long, bright and unforgiving.',
  playerCount: [6, 18],

  bounds: BOUNDS,
  outOfBoundsGrace: 7,

  brushes: buildGeometry(),

  lighting: {
    // Near-overhead noon sun. Short hard shadows, and a warm bounce off the sand
    // that keeps the shaded stall interiors readable.
    sunDirection: vec3(0.18, -0.94, 0.28),
    sunColor: 0xfff4dc,
    sunIntensity: 3.5,
    ambientColor: 0xd4bd94,
    ambientIntensity: 1.9,
    skyTop: 0x7ba8d8,
    skyBottom: 0xe0d6bc,
    fogColor: 0xdcceb0,
    fogNear: 65,
    fogFar: 190,
    exposure: 1.0,
    lights: [
      { position: vec3(28, 5.4, 0), color: 0xffe0b0, intensity: 10, distance: 16 },
      { position: vec3(28, 5.4, 12), color: 0xffe0b0, intensity: 10, distance: 16 },
      { position: vec3(30, 4.6, -22), color: 0xffe0b0, intensity: 10, distance: 15 },
    ],
  },

  spawns: buildSpawns(),

  objectives: [
    { kind: ObjectiveKind.DominationFlag, label: 'A', position: vec3(-28, 0, 14), size: vec3(7, 4, 7), initialOwner: Team.Allies },
    { kind: ObjectiveKind.DominationFlag, label: 'B', position: vec3(0, 0, 0), size: vec3(9, 4, 9), initialOwner: Team.None },
    { kind: ObjectiveKind.DominationFlag, label: 'C', position: vec3(28, 0, -14), size: vec3(7, 4, 7), initialOwner: Team.Axis },

    { kind: ObjectiveKind.BombSite, label: 'A', position: vec3(-28, 0, -14), size: vec3(8, 4, 8) },
    { kind: ObjectiveKind.BombSite, label: 'B', position: vec3(28, 0, 10), size: vec3(8, 4, 8) },

    { kind: ObjectiveKind.Hardpoint, label: 'P1', position: vec3(0, 0, 0), size: vec3(10, 5, 10), order: 0 },
    { kind: ObjectiveKind.Hardpoint, label: 'P2', position: vec3(-28, 0, 8), size: vec3(9, 5, 9), order: 1 },
    { kind: ObjectiveKind.Hardpoint, label: 'P3', position: vec3(0, 0, -24), size: vec3(10, 5, 10), order: 2 },
    { kind: ObjectiveKind.Hardpoint, label: 'P4', position: vec3(28, 0, 2), size: vec3(9, 5, 9), order: 3 },
    { kind: ObjectiveKind.Hardpoint, label: 'P5', position: vec3(0, 0, 24), size: vec3(10, 5, 10), order: 4 },

    { kind: ObjectiveKind.Headquarters, label: 'HQ1', position: vec3(0, 0, 0), size: vec3(10, 5, 10), order: 0 },
    { kind: ObjectiveKind.Headquarters, label: 'HQ2', position: vec3(-28, 0, -6), size: vec3(9, 5, 9), order: 1 },
    { kind: ObjectiveKind.Headquarters, label: 'HQ3', position: vec3(28, 0, 14), size: vec3(9, 5, 9), order: 2 },
    { kind: ObjectiveKind.Headquarters, label: 'HQ4', position: vec3(0, 0, 26), size: vec3(10, 5, 10), order: 3 },
  ],

  navLinks: buildNavLinks(),
  coverPoints: buildCoverPoints(),

  lanes: [
    { name: 'colonnade', width: 14, path: [vec3(-30, 0, 32), vec3(-28, 0, 16), vec3(-28, 0, 0), vec3(-28, 0, -16), vec3(-28, 0, -30)] },
    { name: 'bazaar', width: 22, path: [vec3(0, 0, 32), vec3(-3, 0, 16), vec3(2, 0, 0), vec3(-2, 0, -16), vec3(0, 0, -30)] },
    { name: 'street', width: 16, path: [vec3(30, 0, 32), vec3(28, 0, 16), vec3(26, 0, 0), vec3(28, 0, -16), vec3(30, 0, -30)] },
  ],

  ambience: {
    reverbTime: 1.2,
    reverbMix: 0.16,
    wind: 0.55,
    mood: 'desert',
  },
};
