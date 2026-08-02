/**
 * Highrise — two office towers and the roof between them.
 *
 * The map is about height and exposure. Almost everything happens on one big
 * open rooftop with hard sun and long shadows, and the two towers that bracket
 * it are the only real cover — so the question every fight asks is whether you
 * are willing to cross the open to get to the other side.
 *
 *      AXIS (north, -z)
 *   ┌────────┬──────────┬────────┐
 *   │ NORTH  │  HELIPAD │ SERVICE│  west  = enclosed office floor, tight
 *   │ TOWER  │   DECK   │  CORE  │  mid   = the open roof: fast, lethal
 *   │  ▲2F   │          │   ▲2F  │  east  = stairwell core with two levels
 *   └────────┴──────────┴────────┘
 *      ALLIES (south, +z)
 *
 * The helipad in the centre is deliberately raised: it dominates the deck, and
 * it has no cover at all. Standing on it is a statement.
 *
 * Everything is fenced at the perimeter rather than walled, so the map reads as
 * being high up — you can see out, you just cannot leave.
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
  barrier,
  building,
  catwalk,
  crate,
  crateStack,
  fence,
  ground,
  lowWall,
  perimeter,
  sandbags,
  solidContainer,
  stairs,
} from '../props.js';

const BOUNDS = { min: vec3(-46, -3, -42), max: vec3(46, 28, 42) };

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
): SpawnPoint[] {
  const lattice: Array<[number, number]> = [
    [0, 0], [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [-1, 1], [1, -1], [-1, -1], [2, 0], [-2, 0], [0, 2],
  ];
  return lattice.slice(0, count).map(([ox, oz], i) => ({
    position: vec3(cx + ox * spread, 0.1, cz + oz * spread),
    yaw: yaw + (i % 3) * 0.16 - 0.16,
    team,
    group,
    priority: 1 - (Math.abs(ox) + Math.abs(oz)) * 0.06,
  }));
}

/** A rooftop air-conditioning unit: the standard piece of cover up here. */
function acUnit(x: number, z: number, yaw = 0, wide = false): Brush[] {
  const w = wide ? 3.4 : 2.2;
  return [
    box(vec3(x, 0.75, z), vec3(w, 1.5, 1.8), SurfaceType.Metal, {
      yaw, color: 0x9aa0a6, castShadow: true,
    }),
    box(vec3(x, 1.58, z), vec3(w * 0.7, 0.16, 1.3), SurfaceType.Metal, {
      yaw, color: 0x6a7076, castShadow: true,
    }),
  ];
}

/** A roof vent stack. Narrow, tall, and just wide enough to hide a head. */
function vent(x: number, z: number, height = 2.4): Brush[] {
  return [
    cylinder(vec3(x, height / 2, z), 0.45, height, SurfaceType.Metal, {
      color: 0x8a9096, segments: 10, castShadow: true,
    }),
    cylinder(vec3(x, height + 0.15, z), 0.6, 0.3, SurfaceType.Metal, {
      color: 0x6a7076, segments: 10, solid: false,
    }),
  ];
}

// ---------------------------------------------------------------------------

function buildGeometry(): Brush[] {
  const b: Brush[] = [];

  // --- the roof itself ----------------------------------------------------
  b.push(ground(vec3(0, 0, 0), 92, 84, SurfaceType.Concrete, 0x8e8b84));
  // A gravel border, purely to break up the enormous flat slab visually.
  b.push(
    box(vec3(0, -0.02, 0), vec3(70, 0.04, 62), SurfaceType.Gravel, {
      color: 0x7d7a72, textureScale: 14, solid: false, castShadow: false,
    }),
  );

  // Perimeter is a low parapet with fencing above it: you can see out over the
  // city, which is the whole point of being up here.
  b.push(...perimeter(vec3(-42, 0, -38), vec3(42, 0, 38), 1.1, SurfaceType.Concrete, 0x9a978f));
  b.push(fence(vec3(0, 1.1, -38.5), 84, 0, 2.6));
  b.push(fence(vec3(0, 1.1, 38.5), 84, 0, 2.6));
  b.push(fence(vec3(-42.5, 1.1, 0), 76, FACE_E, 2.6));
  b.push(fence(vec3(42.5, 1.1, 0), 76, FACE_E, 2.6));

  // --- west: north tower office floor -------------------------------------
  // Enclosed, two storeys, and the only place on the map with short sightlines.
  b.push(
    ...building(vec3(-27, 3.0, -6), vec3(20, 6.0, 26), {
      surface: SurfaceType.Concrete,
      color: 0x8f8c85,
      floorSurface: SurfaceType.Carpet,
      doors: { '+x': [-8, 7], '-z': [0], '+z': [-4] },
      windows: { '+x': [0], '-x': [-6, 6], '+z': [5] },
      doorWidth: 2.4,
      doorHeight: 2.6,
    }),
  );
  // Interior partitions, so the office is a set of rooms rather than a hall.
  b.push(lowWall(vec3(-27, 0, -12), 12, 0, 2.2, SurfaceType.Glass));
  b.push(lowWall(vec3(-32, 0, 0), 10, FACE_E, 2.2, SurfaceType.Glass));
  b.push(...crateStack(vec3(-22, 0, -14)));
  b.push(crate(vec3(-33, 0, -14), 1.4));
  b.push(crate(vec3(-24, 0, 3), 1.2));
  b.push(sandbags(vec3(-20, 0, 6), 5, 0));

  // Upper floor: a mezzanine overlooking the deck through the window band.
  //
  // The walkway is railed on its open side, but the landing at the top of the
  // stairs deliberately is not — a railing there would fence the staircase off
  // from the thing it climbs to, which is the single easiest way to build a
  // second storey nobody can reach.
  b.push(...catwalk(vec3(-20, 3.2, -9.2), vec3(5, 0.16, 15.6), 0, ['+x']));
  b.push(...stairs(vec3(-21, 0, 3), 3.2, 4.4, 3.0, '-z', SurfaceType.Metal));
  // The cross piece has to overlap the walkway by more than a player's width or
  // the two decks are separate places that merely look joined.
  b.push(...catwalk(vec3(-27.75, 3.2, -16), vec3(17.5, 0.16, 4), 0, ['-z']));

  // --- east: service core -------------------------------------------------
  b.push(
    ...building(vec3(26, 3.4, 2), vec3(18, 6.8, 24), {
      surface: SurfaceType.Metal,
      color: 0x7f858b,
      floorSurface: SurfaceType.Tile,
      doors: { '-x': [-7, 6], '+z': [0], '-z': [3] },
      windows: { '-x': [0], '+x': [-8, 8] },
      doorWidth: 2.6,
      doorHeight: 2.9,
    }),
  );
  b.push(...catwalk(vec3(19.5, 3.6, 2), vec3(4, 0.16, 20), 0, ['-x']));
  b.push(...catwalk(vec3(27, 3.6, -8), vec3(16, 0.16, 4), 0, ['-z']));
  // Climbs northward onto the cross piece. Running it the other way tops out in
  // mid-air two metres short of the deck.
  b.push(...stairs(vec3(32, 0, -1.2), 3.6, 4.8, 3.0, '-z', SurfaceType.Metal));
  b.push(solidContainer(vec3(28, 0, 8), 0, 0x6a7a8a, 5));
  b.push(...crateStack(vec3(22, 0, -6)));
  b.push(crate(vec3(31, 0, 2), 1.6));

  // --- centre: the helipad deck -------------------------------------------
  // Raised by half a metre, no cover on it, painted target in the middle. It is
  // the shortest route between the towers and it will get you killed.
  b.push(cylinder(vec3(0, 0.25, 0), 11, 0.5, SurfaceType.Concrete, {
    color: 0x6e6b66, segments: 24, castShadow: false,
  }));
  b.push(cylinder(vec3(0, 0.52, 0), 6.5, 0.04, SurfaceType.Concrete, {
    color: 0xd8d4c8, segments: 24, solid: false, castShadow: false,
  }));

  // Cover ringing the pad, so approaching it is possible but committing is not.
  b.push(...acUnit(-13, -8, 0.2, true));
  b.push(...acUnit(13, 9, -0.15, true));
  b.push(...acUnit(-10, 14, 0.4));
  b.push(...acUnit(11, -15, -0.3));
  b.push(...acUnit(-2, -19, 0));
  b.push(...acUnit(3, 20, 0.1));
  b.push(...vent(-6, -4));
  b.push(...vent(7, 3));
  b.push(...vent(-8, 8, 2.8));
  b.push(...vent(9, -10, 2.8));
  b.push(...vent(0, 16, 2.2));
  b.push(...vent(-1, -25, 2.6));

  b.push(barrier(vec3(-16, 0, 0), 5, FACE_E));
  b.push(barrier(vec3(16, 0, -2), 5, FACE_E));
  b.push(sandbags(vec3(-5, 0, 24), 6, 0));
  b.push(sandbags(vec3(5, 0, -24), 6, 0));

  // --- south (Allied) approach --------------------------------------------
  b.push(
    ...building(vec3(-28, 2.2, 28), vec3(14, 4.4, 8), {
      surface: SurfaceType.Concrete, color: 0x8a8780,
      doors: { '-z': [0] }, windows: { '+x': [0] },
    }),
  );
  b.push(
    ...building(vec3(28, 2.2, 28), vec3(14, 4.4, 8), {
      surface: SurfaceType.Concrete, color: 0x8a8780,
      doors: { '-z': [2] }, windows: { '-x': [0] },
    }),
  );
  b.push(barrier(vec3(-8, 0, 30), 5, 0));
  b.push(barrier(vec3(8, 0, 30), 5, 0));
  b.push(...crateStack(vec3(0, 0, 33)));

  // --- north (Axis) approach ----------------------------------------------
  b.push(
    ...building(vec3(-28, 2.2, -30), vec3(14, 4.4, 8), {
      surface: SurfaceType.Concrete, color: 0x8a8780,
      doors: { '+z': [0] }, windows: { '+x': [0] },
    }),
  );
  b.push(
    ...building(vec3(28, 2.2, -30), vec3(14, 4.4, 8), {
      surface: SurfaceType.Concrete, color: 0x8a8780,
      doors: { '+z': [-2] }, windows: { '-x': [0] },
    }),
  );
  b.push(barrier(vec3(-8, 0, -32), 5, 0));
  b.push(barrier(vec3(8, 0, -32), 5, 0));
  b.push(...crateStack(vec3(2, 0, -34)));

  return b;
}

// ---------------------------------------------------------------------------

function buildSpawns(): SpawnPoint[] {
  return [
    ...spawnCluster(0, 27, Team.Allies, 'allies_home', FACE_N, 7, 3.0),
    ...spawnCluster(-33, 20.5, Team.Allies, 'allies_west', FACE_N, 5, 1.8),
    ...spawnCluster(33, 20.5, Team.Allies, 'allies_east', FACE_N, 5, 1.8),
    ...spawnCluster(-36, 12, Team.Allies, 'allies_mid_west', FACE_N, 4, 2.6),
    ...spawnCluster(38, 14, Team.Allies, 'allies_mid_east', FACE_N, 4, 2.2),

    ...spawnCluster(0, -27, Team.Axis, 'axis_home', FACE_S, 7, 3.0),
    ...spawnCluster(-33, -23.4, Team.Axis, 'axis_west', FACE_S, 5, 1.8),
    ...spawnCluster(33, -23.4, Team.Axis, 'axis_east', FACE_S, 5, 1.8),
    ...spawnCluster(-38, -14, Team.Axis, 'axis_mid_west', FACE_S, 4, 2.6),
    ...spawnCluster(37, -14, Team.Axis, 'axis_mid_east', FACE_S, 4, 2.6),

    ...spawnCluster(-38, 0, Team.None, 'ffa_west', FACE_N, 4, 3.0),
    ...spawnCluster(39, 4, Team.None, 'ffa_east', FACE_S, 4, 2.4),
    ...spawnCluster(-16, 20, Team.None, 'ffa_south', FACE_N, 4, 3.0),
    ...spawnCluster(16, -20, Team.None, 'ffa_north', FACE_S, 4, 3.0),
  ];
}

function buildCoverPoints(): CoverPoint[] {
  return [
    // Around the helipad: high value, high exposure, exactly the trade the map
    // is built on.
    cover(-13, -6.2, FACE_N, 0.55, 1.9, true),
    cover(-13, -9.8, FACE_S, 0.55, 1.9, true),
    cover(13, 10.8, FACE_S, 0.55, 1.9, true),
    cover(13, 7.2, FACE_N, 0.55, 1.9, true),
    cover(-10, 15.8, FACE_S, 0.5, 1.5, true),
    cover(11, -16.8, FACE_N, 0.5, 1.5, true),
    cover(-2, -20.8, FACE_N, 0.5, 1.4, true),
    cover(3, 21.8, FACE_S, 0.5, 1.4, true),
    cover(-6, -4, FACE_N, 0.6, 1.3),
    cover(7, 3, FACE_S, 0.6, 1.3),
    cover(-8, 8, FACE_S, 0.6, 1.2),
    cover(9, -10, FACE_N, 0.6, 1.2),
    cover(-16, 0, FACE_E, 0.45, 1.4, true),
    cover(16, -2, FACE_W, 0.45, 1.4, true),
    cover(-5, 25.5, FACE_N, 0.45, 1.1, true),
    cover(5, -25.5, FACE_S, 0.45, 1.1, true),

    // West office interior: short angles, low exposure.
    cover(-27, -13.5, FACE_N, 0.2, 1.6, true),
    cover(-27, -10.5, FACE_S, 0.2, 1.6, true),
    cover(-33.5, 0, FACE_E, 0.2, 1.5, true),
    cover(-22, -14, FACE_E, 0.25, 1.4),
    cover(-33, -14, FACE_W, 0.25, 1.3),
    cover(-24, 3, FACE_S, 0.25, 1.3),
    cover(-20, 6, FACE_E, 0.3, 1.2, true),

    // West mezzanine — sees the whole deck through the window band.
    //
    // Spaced under six metres apart on purpose: the nav graph only links nodes
    // it can sweep a capsule between, and grid sampling cannot chain a staircase
    // (the rise per sample exceeds the same-floor threshold). A sparse upper deck
    // therefore forms its own island and gets pruned away entirely — the
    // mezzanine renders, and no bot ever sets foot on it.
    cover(-20, 0, FACE_E, 0.55, 1.8, true, 3.36),
    cover(-20, -4, FACE_E, 0.6, 2.3, true, 3.36),
    cover(-20, -8, FACE_E, 0.55, 2.0, true, 3.36),
    cover(-20, -12, FACE_E, 0.6, 2.3, true, 3.36),
    cover(-21, -16, FACE_S, 0.5, 1.9, true, 3.36),
    cover(-26, -16, FACE_S, 0.5, 1.7, true, 3.36),
    cover(-31, -16, FACE_S, 0.5, 1.7, true, 3.36),
    cover(-35, -16, FACE_S, 0.45, 1.5, true, 3.36),

    // East service core.
    cover(26, -6, FACE_N, 0.25, 1.6, true),
    cover(26, 8, FACE_S, 0.25, 1.6, true),
    cover(28, 10.5, FACE_S, 0.3, 1.4),
    cover(22, -6, FACE_W, 0.3, 1.4),
    cover(31, 2, FACE_W, 0.3, 1.2, true),
    cover(19.5, 10, FACE_W, 0.55, 1.8, true, 3.76),
    cover(19.5, 5, FACE_W, 0.6, 2.3, true, 3.76),
    cover(19.5, 0, FACE_W, 0.55, 2.0, true, 3.76),
    cover(19.5, -5, FACE_W, 0.6, 2.3, true, 3.76),
    cover(21, -8, FACE_N, 0.55, 2.0, true, 3.76),
    cover(26, -8, FACE_N, 0.5, 1.8, true, 3.76),
    cover(31, -8, FACE_N, 0.5, 1.8, true, 3.76),

    // Spawn-side, low value so bots do not hold their own end.
    cover(-8, 31.5, FACE_N, 0.4, 0.5, true),
    cover(8, 31.5, FACE_N, 0.4, 0.5, true),
    cover(-8, -33.5, FACE_S, 0.4, 0.5, true),
    cover(8, -33.5, FACE_S, 0.4, 0.5, true),
  ];
}

function buildNavLinks(): NavLink[] {
  return [
    // The staircases, as bidirectional links.
    //
    // A one-way drop is not enough to keep an upper deck alive: the connectivity
    // pass floods outward from every node, so a deck that can only be left never
    // gets reached from the ground and is pruned as an island. The way up has to
    // be in the graph too, and grid sampling cannot supply it.
    { from: vec3(-21, 0, 5), to: vec3(-21, 3.36, -2), kind: 'ladder', cost: 1.4, bidirectional: true },
    { from: vec3(32, 0, 1), to: vec3(32, 3.76, -8), kind: 'ladder', cost: 1.4, bidirectional: true },

    { from: vec3(-20, 3.3, 4), to: vec3(-20, 0, 7), kind: 'drop', cost: 1.0, bidirectional: false },
    { from: vec3(-20, 3.3, -14), to: vec3(-22, 0, -14), kind: 'drop', cost: 1.0, bidirectional: false },
    { from: vec3(19.5, 3.7, 10), to: vec3(19.5, 0, 13), kind: 'drop', cost: 1.0, bidirectional: false },
    { from: vec3(28, 3.7, -8), to: vec3(28, 0, -11), kind: 'drop', cost: 1.0, bidirectional: false },
    // Mantle onto an AC unit for a firing position over the deck.
    { from: vec3(-13, 0, -5.0), to: vec3(-13, 1.5, -8), kind: 'mantle', cost: 1.6, bidirectional: false },
    { from: vec3(13, 0, 12.0), to: vec3(13, 1.5, 9), kind: 'mantle', cost: 1.6, bidirectional: false },
    { from: vec3(0, 0, 31.6), to: vec3(0, 1.0, 33), kind: 'mantle', cost: 1.4, bidirectional: true },
  ];
}

// ---------------------------------------------------------------------------

export const HIGHRISE: MapDef = {
  id: 'highrise',
  name: 'Highrise',
  tagline: 'Nowhere to be but up here.',
  description:
    'Two office towers and the roof deck between them, forty storeys up. The helipad ' +
    'in the middle is the fastest way across and has no cover whatsoever. Hard sun, ' +
    'long shadows, and a very long way down.',
  playerCount: [6, 16],

  bounds: BOUNDS,
  outOfBoundsGrace: 6,

  brushes: buildGeometry(),

  lighting: {
    // High, hard sun from the south-west. The long shadows off the AC units are
    // most of what makes the deck readable rather than a flat grey plane.
    sunDirection: vec3(-0.5, -0.72, 0.48),
    sunColor: 0xfff2d8,
    sunIntensity: 3.4,
    ambientColor: 0xa8bcd4,
    ambientIntensity: 1.7,
    skyTop: 0x4f86c6,
    skyBottom: 0xbcd4ea,
    fogColor: 0xc4d6e8,
    fogNear: 75,
    fogFar: 220,
    exposure: 1.05,
    lights: [
      { position: vec3(-27, 4.6, -12), color: 0xffeccc, intensity: 12, distance: 18 },
      { position: vec3(-27, 4.6, 2), color: 0xffeccc, intensity: 12, distance: 18 },
      { position: vec3(26, 5.2, -4), color: 0xd8ecff, intensity: 12, distance: 18 },
      { position: vec3(26, 5.2, 8), color: 0xd8ecff, intensity: 12, distance: 18 },
    ],
  },

  spawns: buildSpawns(),

  objectives: [
    { kind: ObjectiveKind.DominationFlag, label: 'A', position: vec3(-27, 0, 4), size: vec3(7, 4, 7), initialOwner: Team.Allies },
    { kind: ObjectiveKind.DominationFlag, label: 'B', position: vec3(0, 0.5, 0), size: vec3(10, 5, 10), initialOwner: Team.None },
    { kind: ObjectiveKind.DominationFlag, label: 'C', position: vec3(26, 0, -4), size: vec3(7, 4, 7), initialOwner: Team.Axis },

    { kind: ObjectiveKind.BombSite, label: 'A', position: vec3(-26, 0, -10), size: vec3(8, 4, 8) },
    { kind: ObjectiveKind.BombSite, label: 'B', position: vec3(27, 0, 6), size: vec3(8, 4, 8) },

    { kind: ObjectiveKind.Hardpoint, label: 'P1', position: vec3(0, 0.5, 0), size: vec3(11, 5, 11), order: 0 },
    { kind: ObjectiveKind.Hardpoint, label: 'P2', position: vec3(-26, 0, -8), size: vec3(9, 5, 9), order: 1 },
    { kind: ObjectiveKind.Hardpoint, label: 'P3', position: vec3(-3, 0, -20), size: vec3(10, 5, 10), order: 2 },
    { kind: ObjectiveKind.Hardpoint, label: 'P4', position: vec3(27, 0, 4), size: vec3(9, 5, 9), order: 3 },
    { kind: ObjectiveKind.Hardpoint, label: 'P5', position: vec3(3, 0, 21), size: vec3(10, 5, 10), order: 4 },

    { kind: ObjectiveKind.Headquarters, label: 'HQ1', position: vec3(0, 0.5, 0), size: vec3(11, 5, 11), order: 0 },
    { kind: ObjectiveKind.Headquarters, label: 'HQ2', position: vec3(-26, 0, -4), size: vec3(9, 5, 9), order: 1 },
    { kind: ObjectiveKind.Headquarters, label: 'HQ3', position: vec3(27, 0, 8), size: vec3(9, 5, 9), order: 2 },
    { kind: ObjectiveKind.Headquarters, label: 'HQ4', position: vec3(-3, 0, 22), size: vec3(10, 5, 10), order: 3 },
  ],

  navLinks: buildNavLinks(),
  coverPoints: buildCoverPoints(),

  lanes: [
    { name: 'west', width: 18, path: [vec3(-33, 0, 26), vec3(-30, 0, 12), vec3(-27, 0, -2), vec3(-28, 0, -16), vec3(-32, 0, -28)] },
    { name: 'mid', width: 24, path: [vec3(0, 0, 26), vec3(-4, 0, 12), vec3(0, 0, 0), vec3(4, 0, -12), vec3(0, 0, -26)] },
    { name: 'east', width: 18, path: [vec3(33, 0, 26), vec3(30, 0, 12), vec3(26, 0, 0), vec3(28, 0, -14), vec3(32, 0, -28)] },
  ],

  ambience: {
    reverbTime: 0.9,
    reverbMix: 0.14,
    wind: 0.85,
    mood: 'urban',
  },
};
