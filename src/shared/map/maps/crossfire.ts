/**
 * Crossfire — an overcast European village.
 *
 * The reference map for Operation Vanguard, and the one every other map is
 * measured against. Classic three-lane layout:
 *
 *      AXIS (north, -z)
 *   ┌──────┬──────┬──────┐
 *   │ WEST │ MID  │ EAST │   west  = tight alley, close-quarters, no long angles
 *   │ alley│plaza │ w/hse│   mid   = open market plaza, the risky fast route
 *   │      │      │  ▲2F │   east  = warehouse with a second-floor catwalk
 *   └──────┴──────┴──────┘
 *     ALLIES (south, +z)
 *
 * The two building rows that separate the lanes are punched with doorways at
 * z = ±14 and z = 0, so a player is never more than about four seconds from a
 * lane change. That is what stops the map degenerating into three independent
 * one-lane fights.
 *
 * No sightline runs the full 80 m length of the map: the mid plaza is broken by
 * the fountain and market stalls, and both alleys jog around a building corner.
 */

import { SurfaceType, Team } from '../../types.js';
import { vec3 } from '../../math.js';
import { box, cylinder, type Brush, type CoverPoint, type MapDef, type NavLink, type SpawnPoint } from '../map-types.js';
import { ObjectiveKind } from '../map-types.js';
import {
  barrelCluster,
  barrier,
  building,
  car,
  catwalk,
  crate,
  crateStack,
  fence,
  ground,
  lampPost,
  lowWall,
  marketStall,
  perimeter,
  sandbags,
  shippingContainer,
  solidContainer,
  stairs,
  tree,
  truck,
} from '../props.js';

const BOUNDS = { min: vec3(-46, -3, -44), max: vec3(46, 26, 44) };

// Facing helpers, so spawn yaws read as intent rather than as magic numbers.
// Under our convention yaw 0 looks toward -z, and yaw increases turning left.
const FACE_NORTH = 0; // toward -z (toward the Axis end)
const FACE_SOUTH = Math.PI; // toward +z (toward the Allied end)
const FACE_EAST = -Math.PI / 2;
const FACE_WEST = Math.PI / 2;

// ---------------------------------------------------------------------------
// Authoring helpers local to this map
// ---------------------------------------------------------------------------

/**
 * A cluster of spawn points around a centre.
 *
 * Offsets are a fixed lattice rather than random so the map loads identically
 * every time, which matters because spawn selection is part of the deterministic
 * simulation.
 */
function spawnCluster(
  center: { x: number; z: number },
  team: Team,
  group: string,
  yaw: number,
  count: number,
  spread = 3.2,
): SpawnPoint[] {
  const lattice: Array<[number, number]> = [
    [0, 0], [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [-1, 1], [1, -1], [-1, -1],
    [2, 0], [-2, 0], [0, 2], [0, -2],
    [2, 1], [-2, 1], [2, -1], [-2, -1],
    [1, 2], [-1, 2], [1, -2],
  ];
  return lattice.slice(0, count).map(([ox, oz], i) => ({
    position: vec3(center.x + ox * spread, 0.1, center.z + oz * spread),
    // Fan the facing slightly so a wave of players doesn't spawn as a firing line.
    yaw: yaw + (i % 3) * 0.18 - 0.18,
    team,
    group,
    priority: 1 - Math.abs(ox) * 0.05 - Math.abs(oz) * 0.05,
  }));
}

function cover(
  x: number,
  z: number,
  facing: number,
  exposure: number,
  value = 1,
  crouch = false,
  y = 0,
): CoverPoint {
  return { position: vec3(x, y, z), facing, crouch, exposure, value };
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

function buildGeometry(): Brush[] {
  const b: Brush[] = [];

  // --- ground and containment -------------------------------------------
  b.push(ground(vec3(0, 0, 0), 92, 88, SurfaceType.Concrete, 0x6f6d68));
  // Cobbled plaza inset, purely visual but it reads as the centre of the map.
  b.push(
    box(vec3(0, -0.02, 0), vec3(26, 0.04, 34), SurfaceType.Brick, {
      color: 0x7a6a5c, textureScale: 8, solid: false, castShadow: false,
    }),
  );
  b.push(...perimeter(vec3(-42, 0, -40), vec3(42, 0, 40), 14, SurfaceType.Concrete, 0x4e5155));

  // --- west building row (separates west alley from mid) -----------------
  // Three linked houses with a gap at z = 0 and doorways letting players cut
  // between the alley and the plaza.
  const westWallColor = 0x9a8f7e;
  b.push(
    ...building(vec3(-18, 2.6, -22), vec3(11, 5.2, 13), {
      surface: SurfaceType.Brick,
      color: westWallColor,
      doors: { '+x': [0], '-x': [2], '+z': [-2] },
      windows: { '+x': [-3.5], '-z': [0, -3] },
    }),
  );
  b.push(
    ...building(vec3(-18, 2.6, -6), vec3(11, 5.2, 12), {
      surface: SurfaceType.Brick,
      color: 0x8f8474,
      doors: { '+x': [1], '-x': [-1] },
      windows: { '+x': [-3.5, 4], '-x': [3.5] },
    }),
  );
  b.push(
    ...building(vec3(-18, 2.6, 14), vec3(11, 5.2, 14), {
      surface: SurfaceType.Brick,
      color: westWallColor,
      doors: { '+x': [-2], '-x': [1], '-z': [0] },
      windows: { '+x': [4], '+z': [-2, 3] },
    }),
  );

  // --- east building: the warehouse ---------------------------------------
  // Larger, open-plan, and the only place with a real second floor.
  b.push(
    ...building(vec3(19, 4.2, -4), vec3(16, 8.4, 30), {
      surface: SurfaceType.Metal,
      color: 0x7d8288,
      floorSurface: SurfaceType.Concrete,
      doors: { '-x': [-9, 4], '+x': [-6, 6], '-z': [0], '+z': [-3] },
      windows: { '+x': [-11, 11] },
      doorWidth: 2.6,
      doorHeight: 3.0,
    }),
  );

  // Warehouse mezzanine: a catwalk down the west side overlooking the floor,
  // reachable from stairs at the north end and a crate mantle at the south.
  b.push(...catwalk(vec3(14.5, 3.6, -6), vec3(4, 0.16, 22), 0, ['-x']));
  b.push(...catwalk(vec3(20, 3.6, -16), vec3(11, 0.16, 4), 0, ['+z']));
  b.push(...stairs(vec3(23.5, 0, -12.5), 3.6, 4.6, 3.2, '-z', SurfaceType.Metal));
  // Mantle route up to the south end of the catwalk.
  b.push(crate(vec3(13.6, 0, 3.2), 1.6));
  b.push(crate(vec3(13.6, 1.6, 3.2), 1.4));

  // Warehouse floor clutter — cover that makes the open span fightable.
  b.push(solidContainer(vec3(21, 0, 2), 0, 0x7a4a3a, 6));
  b.push(...crateStack(vec3(17, 0, -12)));
  b.push(...barrelCluster(vec3(23, 0, -1), 5, 0x4a6a3a));
  b.push(crate(vec3(16.5, 0, 6), 1.8));
  b.push(crate(vec3(22.5, 0, 8.5), 1.0));
  b.push(...crateStack(vec3(20.5, 0, -18)));

  // --- mid plaza ----------------------------------------------------------
  // A fountain at dead centre: the one piece of cover that matters most,
  // because it breaks the north-south sightline down the middle of the map.
  b.push(cylinder(vec3(0, 0.5, 0), 3.4, 1.0, SurfaceType.Concrete, { color: 0x8d8a82, segments: 16 }));
  b.push(cylinder(vec3(0, 1.4, 0), 0.9, 2.8, SurfaceType.Concrete, { color: 0x8d8a82, segments: 12 }));

  b.push(...marketStall(vec3(-6.5, 0, 9), 0.1, 0xa8483a));
  b.push(...marketStall(vec3(6.0, 0, 11), -0.15, 0x3a6aa8));
  b.push(...marketStall(vec3(-5.5, 0, -10), 0.2, 0x4a8a5a));
  b.push(...marketStall(vec3(6.5, 0, -12), 0.05, 0xa88a3a));

  b.push(...car(vec3(-8.5, 0, 20), 0.35, 0x3f4f5f));
  b.push(...car(vec3(7.5, 0, -20), 2.9, 0x5f4a3a));
  b.push(...truck(vec3(2, 0, 26), 1.62, 0x50553f));

  b.push(barrier(vec3(-3, 0, 16), 4, 0));
  b.push(barrier(vec3(4, 0, -16), 4, 0.1));
  b.push(sandbags(vec3(-9, 0, -2), 5, 0));
  b.push(sandbags(vec3(9, 0, 3), 5, 0));

  b.push(...tree(vec3(-10, 0, 25), 7, 3.0));
  b.push(...tree(vec3(10, 0, -26), 6.4, 2.7));
  b.push(...lampPost(vec3(-4, 0, 0), 5.5));
  b.push(...lampPost(vec3(4, 0, -8), 5.5));
  b.push(...lampPost(vec3(-4, 0, 8), 5.5));

  // --- west alley ---------------------------------------------------------
  // Deliberately cramped: the SMG lane. The jog at z = 4 kills the long angle.
  b.push(lowWall(vec3(-30, 0, 4), 9, FACE_EAST, 2.6, SurfaceType.Brick));
  b.push(...shippingContainer(vec3(-34, 0, -14), 0.08, 0x6a7a4a, 6));
  b.push(...barrelCluster(vec3(-27, 0, -22), 4));
  b.push(crate(vec3(-25.5, 0, 12), 1.2));
  b.push(crate(vec3(-33, 0, 18), 1.6));
  b.push(...crateStack(vec3(-36, 0, 2)));
  b.push(sandbags(vec3(-28, 0, 24), 6, 0.05));
  b.push(sandbags(vec3(-31, 0, -30), 6, -0.05));
  b.push(fence(vec3(-38, 0, 26), 8, 0));
  b.push(...tree(vec3(-39, 0, -4), 6.8, 2.8));

  // --- north (Axis) staging area ------------------------------------------
  b.push(...building(vec3(-30, 2.4, -34), vec3(12, 4.8, 8), {
    surface: SurfaceType.Concrete, color: 0x8a8578,
    doors: { '+z': [0] }, windows: { '+x': [0] },
  }));
  b.push(...building(vec3(28, 2.4, -33), vec3(14, 4.8, 8), {
    surface: SurfaceType.Concrete, color: 0x8a8578,
    doors: { '+z': [-3, 3] }, windows: { '-x': [0] },
  }));
  b.push(barrier(vec3(-8, 0, -30), 5, 0));
  b.push(barrier(vec3(8, 0, -30), 5, 0));
  b.push(...barrelCluster(vec3(0, 0, -34), 6));

  // --- south (Allied) staging area ----------------------------------------
  b.push(...building(vec3(-29, 2.4, 33), vec3(13, 4.8, 8), {
    surface: SurfaceType.Concrete, color: 0x8a8578,
    doors: { '-z': [0] }, windows: { '+x': [0] },
  }));
  b.push(...building(vec3(29, 2.4, 34), vec3(13, 4.8, 8), {
    surface: SurfaceType.Concrete, color: 0x8a8578,
    doors: { '-z': [2] }, windows: { '-x': [0] },
  }));
  b.push(barrier(vec3(-7, 0, 31), 5, 0));
  b.push(barrier(vec3(7, 0, 31), 5, 0));
  b.push(...crateStack(vec3(-6, 0, 35)));

  // --- east alley (outside the warehouse) ---------------------------------
  b.push(...shippingContainer(vec3(35, 0, 8), -0.05, 0x4a6a7a, 6));
  b.push(solidContainer(vec3(36, 0, -8), 0.06, 0x7a5a3a, 6));
  b.push(crate(vec3(30, 0, 18), 1.4));
  b.push(sandbags(vec3(33, 0, 24), 6, 0));
  b.push(sandbags(vec3(31, 0, -24), 6, 0.08));
  b.push(fence(vec3(40, 0, 0), 14, FACE_EAST));
  b.push(...barrelCluster(vec3(29, 0, -14), 3, 0x3a5a7a));

  return b;
}

// ---------------------------------------------------------------------------
// Spawns
// ---------------------------------------------------------------------------

function buildSpawns(): SpawnPoint[] {
  return [
    // Allied home, south end, facing the fight.
    ...spawnCluster({ x: 0, z: 34 }, Team.Allies, 'allies_home', FACE_NORTH, 7, 3.0),
    ...spawnCluster({ x: -28, z: 25 }, Team.Allies, 'allies_west', FACE_NORTH, 5, 2.8),
    ...spawnCluster({ x: 33, z: 22 }, Team.Allies, 'allies_east', FACE_NORTH, 5, 2.8),
    // Forward spawns used once the Allies push past the midline.
    ...spawnCluster({ x: -30, z: 12 }, Team.Allies, 'allies_mid_west', FACE_NORTH, 4, 2.6),
    ...spawnCluster({ x: 30, z: 14 }, Team.Allies, 'allies_mid_east', FACE_NORTH, 4, 2.6),

    // Axis home, north end.
    ...spawnCluster({ x: 0, z: -34 }, Team.Axis, 'axis_home', FACE_SOUTH, 7, 3.0),
    ...spawnCluster({ x: -29, z: -25 }, Team.Axis, 'axis_west', FACE_SOUTH, 5, 2.8),
    ...spawnCluster({ x: 29, z: -24 }, Team.Axis, 'axis_east', FACE_SOUTH, 5, 2.8),
    ...spawnCluster({ x: -31, z: -12 }, Team.Axis, 'axis_mid_west', FACE_SOUTH, 4, 2.6),
    ...spawnCluster({ x: 34, z: -17 }, Team.Axis, 'axis_mid_east', FACE_SOUTH, 4, 2.6),

    // Neutral spawns for free-for-all, spread so nobody owns a corner.
    ...spawnCluster({ x: -35, z: -2 }, Team.None, 'ffa_west', FACE_NORTH, 4, 3.0),
    ...spawnCluster({ x: 34, z: 20 }, Team.None, 'ffa_east', FACE_WEST, 4, 3.0),
    ...spawnCluster({ x: 0, z: 18 }, Team.None, 'ffa_mid_south', FACE_NORTH, 4, 3.0),
    ...spawnCluster({ x: 0, z: -18 }, Team.None, 'ffa_mid_north', FACE_SOUTH, 4, 3.0),
  ];
}

// ---------------------------------------------------------------------------
// Cover
//
// Hand-placed rather than generated: bots hold these angles, and a bot standing
// somewhere a person never would is the fastest way to break the illusion.
// ---------------------------------------------------------------------------

function buildCoverPoints(): CoverPoint[] {
  return [
    // Mid plaza — around the fountain, facing outward along each approach.
    cover(-3.2, 2.6, FACE_NORTH, 0.45, 2.0, true),
    cover(3.2, 2.6, FACE_NORTH, 0.45, 2.0, true),
    cover(-3.2, -2.6, FACE_SOUTH, 0.45, 2.0, true),
    cover(3.2, -2.6, FACE_SOUTH, 0.45, 2.0, true),
    cover(-9.5, -2.8, FACE_NORTH, 0.3, 1.6, true),
    cover(9.5, 2.2, FACE_SOUTH, 0.3, 1.6, true),
    cover(-6.5, 10.2, FACE_NORTH, 0.35, 1.3, true),
    cover(6.0, 12.2, FACE_NORTH, 0.35, 1.3, true),
    cover(-5.5, -11.2, FACE_SOUTH, 0.35, 1.3, true),
    cover(6.5, -13.2, FACE_SOUTH, 0.35, 1.3, true),
    cover(-3.0, 17.0, FACE_NORTH, 0.4, 1.1, true),
    cover(4.0, -17.0, FACE_SOUTH, 0.4, 1.1, true),
    cover(-8.5, 21.5, FACE_NORTH, 0.3, 1.0, true),
    cover(7.5, -21.5, FACE_SOUTH, 0.3, 1.0, true),

    // West alley — tight, mostly full cover, low exposure.
    cover(-30, 6.5, FACE_NORTH, 0.15, 1.4),
    cover(-30, 1.5, FACE_SOUTH, 0.15, 1.4),
    cover(-34, -11, FACE_SOUTH, 0.2, 1.2),
    cover(-34, -17, FACE_NORTH, 0.2, 1.2),
    cover(-25.5, 13.5, FACE_NORTH, 0.3, 1.1, true),
    cover(-33, 19.5, FACE_NORTH, 0.25, 1.0, true),
    cover(-36, 3.0, FACE_SOUTH, 0.2, 1.0, true),
    cover(-28, 25.0, FACE_NORTH, 0.3, 0.9, true),
    cover(-31, -31.0, FACE_SOUTH, 0.3, 0.9, true),
    cover(-27, -22.5, FACE_SOUTH, 0.25, 1.0, true),
    cover(-39, -4.0, FACE_EAST, 0.2, 0.8),

    // West building interiors — window and doorway holds.
    cover(-18, -16.5, FACE_NORTH, 0.25, 1.5, true),
    cover(-18, -1.0, FACE_SOUTH, 0.25, 1.5, true),
    cover(-18, 8.0, FACE_NORTH, 0.25, 1.5, true),
    cover(-13.0, -22.0, FACE_EAST, 0.35, 1.3, true),
    cover(-13.0, 14.0, FACE_EAST, 0.35, 1.3, true),

    // Warehouse floor.
    cover(21, 5.2, FACE_SOUTH, 0.3, 1.6),
    cover(21, -1.2, FACE_NORTH, 0.3, 1.6),
    cover(17, -12, FACE_NORTH, 0.25, 1.4),
    cover(16.5, 7.2, FACE_SOUTH, 0.3, 1.3),
    cover(23, -1, FACE_NORTH, 0.3, 1.2, true),
    cover(20.5, -18, FACE_NORTH, 0.25, 1.2),

    // Warehouse catwalk — the strongest holds on the map, hence high value.
    cover(14.5, 0, FACE_NORTH, 0.5, 2.4, true, 3.76),
    cover(14.5, -12, FACE_SOUTH, 0.5, 2.4, true, 3.76),
    cover(19, -16, FACE_SOUTH, 0.45, 2.0, true, 3.76),

    // East alley.
    cover(35, 11, FACE_SOUTH, 0.25, 1.2),
    cover(36, -5, FACE_NORTH, 0.25, 1.2),
    cover(30, 19, FACE_NORTH, 0.3, 1.0, true),
    cover(33, 25, FACE_NORTH, 0.3, 0.9, true),
    cover(31, -25, FACE_SOUTH, 0.3, 0.9, true),
    cover(29, -14.5, FACE_SOUTH, 0.25, 1.0, true),

    // Spawn-side holds, low value so bots don't camp their own spawn.
    cover(-8, -30.5, FACE_SOUTH, 0.4, 0.5, true),
    cover(8, -30.5, FACE_SOUTH, 0.4, 0.5, true),
    cover(-7, 31.5, FACE_NORTH, 0.4, 0.5, true),
    cover(7, 31.5, FACE_NORTH, 0.4, 0.5, true),
  ];
}

// ---------------------------------------------------------------------------

function buildNavLinks(): NavLink[] {
  return [
    // Mantle onto the crate stack that reaches the warehouse catwalk.
    { from: vec3(13.6, 0, 1.4), to: vec3(13.6, 1.6, 3.2), kind: 'mantle', cost: 1.6, bidirectional: false },
    { from: vec3(13.6, 1.6, 3.2), to: vec3(14.5, 3.7, 1.0), kind: 'mantle', cost: 1.8, bidirectional: false },
    // Drop off the catwalk anywhere along its length.
    { from: vec3(14.5, 3.7, -2), to: vec3(12.6, 0, -2), kind: 'drop', cost: 1.0, bidirectional: false },
    { from: vec3(14.5, 3.7, -14), to: vec3(12.6, 0, -14), kind: 'drop', cost: 1.0, bidirectional: false },
    { from: vec3(20, 3.7, -16), to: vec3(20, 0, -20), kind: 'drop', cost: 1.0, bidirectional: false },
    // Vault the alley wall rather than walking around it.
    { from: vec3(-30, 0, 6.5), to: vec3(-30, 0, 1.5), kind: 'mantle', cost: 2.2, bidirectional: true },
    // Container hops in the west alley and the east alley.
    { from: vec3(-34, 0, -10.5), to: vec3(-34, 2.7, -13), kind: 'mantle', cost: 2.0, bidirectional: false },
    { from: vec3(35, 0, 11.5), to: vec3(35, 2.7, 9), kind: 'mantle', cost: 2.0, bidirectional: false },
    // Crate stacks near the spawns.
    { from: vec3(-6, 0, 33.6), to: vec3(-6, 1.0, 35), kind: 'mantle', cost: 1.4, bidirectional: true },
  ];
}

// ---------------------------------------------------------------------------

export const CROSSFIRE: MapDef = {
  id: 'crossfire',
  name: 'Crossfire',
  tagline: 'A market town with three ways to die.',
  description:
    'Three lanes through a shelled European village. The plaza is the fast route and the ' +
    'dangerous one; the west alley belongs to whoever is holding a shotgun; the warehouse ' +
    'catwalk owns the east side until somebody flushes it.',
  playerCount: [6, 18],

  bounds: BOUNDS,
  outOfBoundsGrace: 7,

  brushes: buildGeometry(),

  lighting: {
    // Low, diffuse overcast light from the north-west. Deliberately soft so the
    // map reads clearly rather than dramatically — this is the map people learn on.
    sunDirection: vec3(0.42, -0.68, 0.6),
    sunColor: 0xd8dce4,
    sunIntensity: 3.0,
    ambientColor: 0x9aa6b4,
    // Lifted specifically for the building interiors. They get no sun at all, so
    // ambient is the only thing lighting a fight that happens indoors — and
    // rooms you cannot see inside are rooms nobody uses.
    ambientIntensity: 1.9,
    skyTop: 0x8b9db4,
    skyBottom: 0xc3cad2,
    fogColor: 0xb2bac4,
    fogNear: 60,
    fogFar: 190,
    exposure: 1.35,
    lights: [
      { position: vec3(-4, 5.6, 0), color: 0xffe2b0, intensity: 8, distance: 16 },
      { position: vec3(4, 5.6, -8), color: 0xffe2b0, intensity: 8, distance: 16 },
      { position: vec3(-4, 5.6, 8), color: 0xffe2b0, intensity: 8, distance: 16 },
      { position: vec3(19, 6.5, -4), color: 0xcfe0ff, intensity: 14, distance: 30 },
      { position: vec3(19, 6.5, -18), color: 0xcfe0ff, intensity: 10, distance: 24 },
      // The west house row: three interiors that are otherwise pitch black.
      { position: vec3(-18, 4.2, -22), color: 0xffe6c0, intensity: 12, distance: 16 },
      { position: vec3(-18, 4.2, -6), color: 0xffe6c0, intensity: 12, distance: 16 },
      { position: vec3(-18, 4.2, 14), color: 0xffe6c0, intensity: 12, distance: 16 },
    ],
  },

  spawns: buildSpawns(),

  objectives: [
    // Domination: A and C sit diagonally opposite in the flank lanes, B in the
    // plaza. That geometry is what makes B worth fighting for instead of a
    // straight three-in-a-row that resolves into a spawn-trap.
    { kind: ObjectiveKind.DominationFlag, label: 'A', position: vec3(-29, 0, 16), size: vec3(6, 4, 6), initialOwner: Team.Allies },
    { kind: ObjectiveKind.DominationFlag, label: 'B', position: vec3(0, 0, 0), size: vec3(9, 4, 9), initialOwner: Team.None },
    { kind: ObjectiveKind.DominationFlag, label: 'C', position: vec3(29, 0, -18), size: vec3(6, 4, 6), initialOwner: Team.Axis },

    { kind: ObjectiveKind.BombSite, label: 'A', position: vec3(-30, 0, -8), size: vec3(7, 4, 7) },
    { kind: ObjectiveKind.BombSite, label: 'B', position: vec3(20, 0, 4), size: vec3(7, 4, 7) },

    // Hardpoint rotation walks a loop around the map so no team keeps a home advantage.
    { kind: ObjectiveKind.Hardpoint, label: 'P1', position: vec3(0, 0, 0), size: vec3(10, 5, 10), order: 0 },
    { kind: ObjectiveKind.Hardpoint, label: 'P2', position: vec3(-30, 0, 8), size: vec3(9, 5, 9), order: 1 },
    { kind: ObjectiveKind.Hardpoint, label: 'P3', position: vec3(0, 0, -22), size: vec3(10, 5, 10), order: 2 },
    { kind: ObjectiveKind.Hardpoint, label: 'P4', position: vec3(20, 0, -2), size: vec3(10, 5, 10), order: 3 },
    { kind: ObjectiveKind.Hardpoint, label: 'P5', position: vec3(0, 0, 22), size: vec3(10, 5, 10), order: 4 },

    { kind: ObjectiveKind.Headquarters, label: 'HQ1', position: vec3(0, 0, 0), size: vec3(10, 5, 10), order: 0 },
    { kind: ObjectiveKind.Headquarters, label: 'HQ2', position: vec3(-29, 0, -6), size: vec3(9, 5, 9), order: 1 },
    { kind: ObjectiveKind.Headquarters, label: 'HQ3', position: vec3(20, 0, 2), size: vec3(9, 5, 9), order: 2 },
    { kind: ObjectiveKind.Headquarters, label: 'HQ4', position: vec3(0, 0, 24), size: vec3(10, 5, 10), order: 3 },
  ],

  navLinks: buildNavLinks(),
  coverPoints: buildCoverPoints(),

  lanes: [
    {
      name: 'west',
      width: 11,
      path: [vec3(-30, 0, 34), vec3(-30, 0, 18), vec3(-31, 0, 4), vec3(-32, 0, -12), vec3(-30, 0, -30)],
    },
    {
      name: 'mid',
      width: 22,
      path: [vec3(0, 0, 32), vec3(0, 0, 18), vec3(-5, 0, 4), vec3(5, 0, -6), vec3(0, 0, -20), vec3(0, 0, -32)],
    },
    {
      name: 'east',
      width: 14,
      path: [vec3(30, 0, 32), vec3(28, 0, 16), vec3(20, 0, 6), vec3(20, 0, -10), vec3(28, 0, -24), vec3(28, 0, -32)],
    },
  ],

  ambience: {
    reverbTime: 1.5,
    reverbMix: 0.22,
    wind: 0.35,
    mood: 'urban',
  },
};
