/**
 * Refinery — a night-shift petrochemical plant.
 *
 * The lighting *is* the gameplay here. Sodium lamps throw hard pools of orange
 * across the yard and everything between them is close to black, so the map is
 * really a set of lit islands joined by darkness: crossing the open is only
 * dangerous where you are visible, and learning which routes stay dark is the
 * whole skill of the map.
 *
 *      AXIS (north, -z)
 *   ┌───────┬────────┬────────┐
 *   │ PIPE  │  TANK  │ GANTRY │  west  = pipe alley, tight, almost no light
 *   │ ALLEY │  FARM  │  ▲▲2F  │  mid   = tank farm, huge cylinders as hard cover
 *   │       │        │        │  east  = two-level gantry, the strongest hold
 *   └───────┴────────┴────────┘         on the map and the most exposed
 *      ALLIES (south, +z)
 *
 * The tank farm is the reason cylinder collision exists. Six storage tanks break
 * the central sightline into a series of short angles, and because they are
 * round there is no corner to pre-aim — you find out where someone is by walking
 * around them.
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
  truck,
} from '../props.js';

const BOUNDS = { min: vec3(-48, -3, -44), max: vec3(48, 30, 44) };

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

/** A storage tank: the signature prop of this map. */
function tank(x: number, z: number, radius: number, height: number, colour: number): Brush[] {
  return [
    cylinder(vec3(x, height / 2, z), radius, height, SurfaceType.Metal, {
      color: colour,
      segments: 16,
      castShadow: true,
    }),
    // Skirt at the base, so the silhouette is not a plain tube.
    cylinder(vec3(x, 0.35, z), radius + 0.35, 0.7, SurfaceType.Concrete, {
      color: 0x5a5c58,
      segments: 16,
    }),
    // Cap, purely visual from the gantry.
    cylinder(vec3(x, height + 0.2, z), radius * 0.75, 0.4, SurfaceType.Metal, {
      color: 0x6a6f74,
      segments: 12,
      solid: false,
    }),
  ];
}

/** A run of overhead pipework. Blocks sight from above, not movement below. */
function pipeRun(x: number, z: number, length: number, yaw: number, height: number): Brush[] {
  const out: Brush[] = [];
  for (const offset of [-0.55, 0, 0.55]) {
    out.push(
      box(
        vec3(x - Math.sin(yaw) * 0 + Math.cos(yaw) * 0, height + offset * 0.35, z),
        yaw === 0 ? vec3(length, 0.42, 0.42) : vec3(0.42, 0.42, length),
        SurfaceType.Metal,
        { color: 0x6e7378, castShadow: true, yaw: 0 },
      ),
    );
  }
  // Support legs at each end.
  for (const s of [-1, 1]) {
    const lx = yaw === 0 ? x + (s * length) / 2.4 : x;
    const lz = yaw === 0 ? z : z + (s * length) / 2.4;
    out.push(
      cylinder(vec3(lx, height / 2, lz), 0.18, height, SurfaceType.Metal, {
        color: 0x55595e,
        segments: 6,
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------

function buildGeometry(): Brush[] {
  const b: Brush[] = [];

  b.push(ground(vec3(0, 0, 0), 100, 92, SurfaceType.Concrete, 0x4e5052));
  b.push(...perimeter(vec3(-44, 0, -40), vec3(44, 0, 40), 16, SurfaceType.Metal, 0x3a3e42));

  // --- west: pipe alley ---------------------------------------------------
  // Narrow, cluttered and almost unlit. This is where anyone carrying a shotgun
  // wants the fight to happen.
  b.push(...pipeRun(-30, -18, 26, 0, 3.4));
  b.push(...pipeRun(-30, 6, 26, 0, 3.4));
  b.push(lowWall(vec3(-24, 0, -6), 14, FACE_E, 2.8, SurfaceType.Metal));
  b.push(lowWall(vec3(-24, 0, 14), 12, FACE_E, 2.8, SurfaceType.Metal));
  b.push(...crateStack(vec3(-34, 0, -26)));
  b.push(...crateStack(vec3(-28, 0, 20)));
  b.push(...barrelCluster(vec3(-37, 0, -6), 5, 0x8a4a2a));
  b.push(...barrelCluster(vec3(-31, 0, 12), 4, 0x3a5a7a));
  b.push(solidContainer(vec3(-38, 0, 24), 0.08, 0x5a6a4a, 6));
  b.push(solidContainer(vec3(-33, 0, -14), Math.PI / 2, 0x6a4a4a, 6));
  b.push(sandbags(vec3(-27, 0, 30), 6, 0));
  b.push(sandbags(vec3(-29, 0, -32), 6, 0));
  b.push(crate(vec3(-40, 0, -3), 1.4));
  b.push(crate(vec3(-25, 0, -22), 1.2));
  b.push(fence(vec3(-42, 0, 12), 16, 0));

  // --- mid: tank farm -----------------------------------------------------
  b.push(...tank(-8, -16, 4.2, 9, 0x8a8478));
  b.push(...tank(6, -20, 3.6, 8, 0x7a7e82));
  b.push(...tank(-6, 4, 4.8, 10, 0x8a8478));
  b.push(...tank(8, 8, 3.8, 8.5, 0x7a7e82));
  b.push(...tank(-10, 24, 3.4, 7.5, 0x86806e));
  b.push(...tank(4, 28, 3.0, 7, 0x7a7e82));

  // Pipework tying the tanks together at head height — it reads as a plant and
  // it breaks the diagonal sightlines the round tanks would otherwise leave.
  b.push(...pipeRun(-1, -18, 16, 0, 4.2));
  b.push(...pipeRun(1, 6, 16, 0, 4.2));
  b.push(...pipeRun(-3, 26, 14, 0, 4.0));

  b.push(barrier(vec3(-2, 0, -8), 5, 0.1));
  b.push(barrier(vec3(2, 0, 16), 5, -0.1));
  b.push(sandbags(vec3(-14, 0, -4), 5, Math.PI / 2));
  b.push(sandbags(vec3(13, 0, -2), 5, Math.PI / 2));
  b.push(...truck(vec3(14, 0, 34), 1.6, 0x40453a));
  b.push(...barrelCluster(vec3(-16, 0, 14), 6, 0x8a3a2a));
  b.push(crate(vec3(12, 0, -12), 1.6));
  b.push(crate(vec3(-15, 0, -26), 1.2));

  // --- east: the gantry ---------------------------------------------------
  // Two catwalk levels over a control building. It overlooks the tank farm and
  // half the yard, which is why both stair runs are on the far side: taking it
  // means committing to a route that everyone can watch.
  b.push(
    ...building(vec3(28, 3.0, 0), vec3(18, 6.0, 22), {
      surface: SurfaceType.Metal,
      color: 0x5f666c,
      floorSurface: SurfaceType.Concrete,
      doors: { '-x': [-7, 6], '+x': [0], '-z': [-4], '+z': [4] },
      windows: { '-x': [0], '+x': [-8, 8] },
      doorWidth: 2.4,
      doorHeight: 2.8,
    }),
  );

  // Lower catwalk, running along the building's west face at 4.2m.
  b.push(...catwalk(vec3(17.5, 4.2, 0), vec3(4, 0.16, 24), 0, ['-x']));
  b.push(...catwalk(vec3(26, 4.2, -12.5), vec3(14, 0.16, 4), 0, ['-z']));
  b.push(...stairs(vec3(34, 0, -10.5), 4.2, 5.2, 3.0, '-z', SurfaceType.Metal));

  // Upper catwalk at 8.4m — the best sightline on the map.
  b.push(...catwalk(vec3(20, 8.4, 6), vec3(4, 0.16, 18), 0, ['-x', '+x']));
  b.push(...catwalk(vec3(28, 8.4, 13), vec3(20, 0.16, 4), 0, ['+z']));
  b.push(...stairs(vec3(36, 4.2, 10), 4.2, 5.2, 3.0, '+z', SurfaceType.Metal));

  // A mantle route up from the yard, for players who do not want to use stairs
  // everyone is watching.
  b.push(crate(vec3(15.4, 0, -6), 1.8));
  b.push(crate(vec3(15.4, 1.8, -6), 1.6));

  b.push(...barrelCluster(vec3(24, 0, 4), 5, 0x4a6a3a));
  b.push(crate(vec3(31, 0, -6), 1.4));
  b.push(solidContainer(vec3(38, 0, 20), 0, 0x4a5a6a, 6));
  b.push(solidContainer(vec3(37, 0, -24), 0.05, 0x6a5a3a, 6));
  b.push(sandbags(vec3(33, 0, 30), 6, 0));

  // --- north (Axis) staging ------------------------------------------------
  b.push(
    ...building(vec3(-28, 2.4, -34), vec3(14, 4.8, 8), {
      surface: SurfaceType.Concrete, color: 0x5a5e60,
      doors: { '+z': [0] }, windows: { '+x': [0] },
    }),
  );
  b.push(
    ...building(vec3(26, 2.4, -34), vec3(14, 4.8, 8), {
      surface: SurfaceType.Concrete, color: 0x5a5e60,
      doors: { '+z': [-3, 3] }, windows: { '-x': [0] },
    }),
  );
  b.push(barrier(vec3(-8, 0, -32), 5, 0));
  b.push(barrier(vec3(8, 0, -32), 5, 0));

  // --- south (Allied) staging ---------------------------------------------
  b.push(
    ...building(vec3(-27, 2.4, 34), vec3(14, 4.8, 8), {
      surface: SurfaceType.Concrete, color: 0x5a5e60,
      doors: { '-z': [0] }, windows: { '+x': [0] },
    }),
  );
  b.push(
    ...building(vec3(27, 2.4, 34), vec3(14, 4.8, 8), {
      surface: SurfaceType.Concrete, color: 0x5a5e60,
      doors: { '-z': [2] }, windows: { '-x': [0] },
    }),
  );
  b.push(barrier(vec3(-8, 0, 32), 5, 0));
  b.push(barrier(vec3(8, 0, 32), 5, 0));
  b.push(...crateStack(vec3(-14, 0, 36)));

  return b;
}

// ---------------------------------------------------------------------------

function buildSpawns(): SpawnPoint[] {
  return [
    ...spawnCluster(-2, 35, Team.Allies, 'allies_home', FACE_N, 7, 3.0),
    ...spawnCluster(-30, 25, Team.Allies, 'allies_west', FACE_N, 5, 2.8),
    ...spawnCluster(32, 25, Team.Allies, 'allies_east', FACE_N, 5, 2.8),
    ...spawnCluster(-34, 18, Team.Allies, 'allies_mid_west', FACE_N, 4, 2.6),
    ...spawnCluster(38, 12, Team.Allies, 'allies_mid_east', FACE_N, 4, 2.6),

    ...spawnCluster(-2, -35, Team.Axis, 'axis_home', FACE_S, 7, 3.0),
    ...spawnCluster(-30, -29, Team.Axis, 'axis_west', FACE_S, 5, 2.8),
    ...spawnCluster(30, -29, Team.Axis, 'axis_east', FACE_S, 5, 2.8),
    ...spawnCluster(-36, -12, Team.Axis, 'axis_mid_west', FACE_S, 4, 2.6),
    ...spawnCluster(41, -12, Team.Axis, 'axis_mid_east', FACE_S, 4, 2.6),

    ...spawnCluster(-40, 0, Team.None, 'ffa_west', FACE_E, 4, 3.0),
    ...spawnCluster(40, 24, Team.None, 'ffa_east', FACE_W, 4, 3.0),
    ...spawnCluster(-18, 20, Team.None, 'ffa_south', FACE_N, 4, 3.0),
    ...spawnCluster(16, -26, Team.None, 'ffa_north', FACE_S, 4, 3.0),
  ];
}

// ---------------------------------------------------------------------------

function buildCoverPoints(): CoverPoint[] {
  return [
    // Around the tanks — no pre-aimable corner, so these are all short holds.
    cover(-12.5, -16, FACE_E, 0.35, 1.8),
    cover(-3.5, -16, FACE_W, 0.35, 1.8),
    cover(-8, -20.5, FACE_S, 0.4, 1.5),
    cover(-8, -11.5, FACE_N, 0.4, 1.5),
    cover(2.2, -20, FACE_E, 0.35, 1.6),
    cover(9.8, -20, FACE_W, 0.35, 1.6),
    cover(-11, 4, FACE_E, 0.35, 2.0),
    cover(-1, 4, FACE_W, 0.35, 2.0),
    cover(-6, -1, FACE_N, 0.4, 1.7),
    cover(-6, 9, FACE_S, 0.4, 1.7),
    cover(4, 8, FACE_E, 0.35, 1.6),
    cover(12, 8, FACE_W, 0.35, 1.6),
    cover(-13.5, 24, FACE_E, 0.35, 1.3),
    cover(-6.5, 24, FACE_W, 0.35, 1.3),
    cover(0.8, 28, FACE_E, 0.35, 1.2),
    cover(7.2, 28, FACE_W, 0.35, 1.2),

    // Mid props.
    cover(-2, -8.8, FACE_N, 0.45, 1.4, true),
    cover(2, 16.8, FACE_S, 0.45, 1.4, true),
    cover(-14, -4.8, FACE_E, 0.4, 1.3, true),
    cover(13, -2.8, FACE_W, 0.4, 1.3, true),
    cover(-16, 14, FACE_S, 0.4, 1.2, true),
    cover(12, -12, FACE_N, 0.4, 1.3),

    // West pipe alley — dark, tight, low exposure throughout.
    cover(-24, -6, FACE_E, 0.15, 1.5),
    cover(-24, 14, FACE_E, 0.15, 1.5),
    cover(-34, -26, FACE_N, 0.2, 1.2),
    cover(-28, 20, FACE_S, 0.2, 1.2),
    cover(-37, -6, FACE_E, 0.2, 1.1, true),
    cover(-31, 12, FACE_W, 0.2, 1.1, true),
    cover(-38, 24, FACE_S, 0.2, 1.0),
    cover(-33, -14, FACE_N, 0.2, 1.2),
    cover(-27, 30, FACE_N, 0.3, 0.8, true),
    cover(-29, -32, FACE_S, 0.3, 0.8, true),
    cover(-40, 2, FACE_E, 0.2, 1.0, true),

    // Gantry — the strongest holds on the map, and the most exposed.
    cover(17.5, -6, FACE_W, 0.55, 2.4, true, 4.36),
    cover(17.5, 6, FACE_W, 0.55, 2.4, true, 4.36),
    cover(24, -12.5, FACE_N, 0.5, 2.0, true, 4.36),
    cover(20, 2, FACE_W, 0.7, 2.6, true, 8.56),
    cover(20, 12, FACE_W, 0.7, 2.6, true, 8.56),
    cover(28, 13, FACE_S, 0.65, 2.2, true, 8.56),

    // Control building interior and yard.
    cover(28, -6, FACE_N, 0.3, 1.6, true),
    cover(28, 6, FACE_S, 0.3, 1.6, true),
    cover(24, 4, FACE_W, 0.35, 1.4, true),
    cover(31, -6, FACE_N, 0.35, 1.2, true),
    cover(38, 20, FACE_S, 0.3, 1.1),
    cover(37, -24, FACE_N, 0.3, 1.1),
    cover(33, 30, FACE_N, 0.35, 0.9, true),

    // Spawn-side, low value so bots do not camp their own end.
    cover(-8, -32.5, FACE_S, 0.4, 0.5, true),
    cover(8, -32.5, FACE_S, 0.4, 0.5, true),
    cover(-8, 32.5, FACE_N, 0.4, 0.5, true),
    cover(8, 32.5, FACE_N, 0.4, 0.5, true),
  ];
}

function buildNavLinks(): NavLink[] {
  return [
    // Crate mantle up to the lower gantry, bypassing the watched stairs.
    { from: vec3(15.4, 0, -7.6), to: vec3(15.4, 1.8, -6), kind: 'mantle', cost: 1.6, bidirectional: false },
    { from: vec3(15.4, 1.8, -6), to: vec3(17.5, 4.3, -6), kind: 'mantle', cost: 1.9, bidirectional: false },
    // Drops off both catwalk levels.
    { from: vec3(17.5, 4.3, 0), to: vec3(15, 0, 0), kind: 'drop', cost: 1.0, bidirectional: false },
    { from: vec3(17.5, 4.3, -10), to: vec3(15, 0, -10), kind: 'drop', cost: 1.0, bidirectional: false },
    { from: vec3(20, 8.5, 6), to: vec3(17.5, 4.3, 6), kind: 'drop', cost: 1.0, bidirectional: false },
    { from: vec3(20, 8.5, 12), to: vec3(17.5, 4.3, 12), kind: 'drop', cost: 1.0, bidirectional: false },
    // Vault the alley walls rather than walking the length of them.
    { from: vec3(-24, 0, -4), to: vec3(-24, 0, -8), kind: 'mantle', cost: 2.2, bidirectional: true },
    { from: vec3(-24, 0, 16), to: vec3(-24, 0, 12), kind: 'mantle', cost: 2.2, bidirectional: true },
    // Container hops.
    { from: vec3(-38, 0, 21), to: vec3(-38, 2.7, 24), kind: 'mantle', cost: 2.0, bidirectional: false },
    { from: vec3(38, 0, 17), to: vec3(38, 2.7, 20), kind: 'mantle', cost: 2.0, bidirectional: false },
  ];
}

// ---------------------------------------------------------------------------

export const REFINERY: MapDef = {
  id: 'refinery',
  name: 'Refinery',
  tagline: 'The lamps show you where not to stand.',
  description:
    'A petrochemical plant on the night shift. Sodium lamps carve the yard into lit ' +
    'islands and everything between them is dark. The tank farm has no corner to ' +
    'pre-aim; the gantry sees everything and everything sees the gantry.',
  playerCount: [6, 16],

  bounds: BOUNDS,
  outOfBoundsGrace: 7,

  brushes: buildGeometry(),

  lighting: {
    // Moonlight only. The sodium lamps below do the real work, which is what
    // makes moving between them a decision.
    sunDirection: vec3(-0.3, -0.85, -0.45),
    sunColor: 0x8fa8d8,
    sunIntensity: 0.55,
    ambientColor: 0x2c3a4e,
    ambientIntensity: 0.75,
    skyTop: 0x0a1220,
    skyBottom: 0x1c2a3c,
    fogColor: 0x14202e,
    fogNear: 30,
    fogFar: 130,
    exposure: 1.5,
    lights: [
      // Tank farm.
      { position: vec3(-8, 10.5, -16), color: 0xffb84d, intensity: 24, distance: 26 },
      { position: vec3(-6, 11.5, 4), color: 0xffb84d, intensity: 24, distance: 28 },
      { position: vec3(7, 9.5, 8), color: 0xffb84d, intensity: 20, distance: 24 },
      { position: vec3(-10, 9, 24), color: 0xffb84d, intensity: 18, distance: 22 },
      // Gantry and control building.
      { position: vec3(20, 9.5, 4), color: 0xcfe0ff, intensity: 22, distance: 26 },
      { position: vec3(28, 5.4, -8), color: 0xffd9a0, intensity: 16, distance: 20 },
      { position: vec3(28, 5.4, 8), color: 0xffd9a0, intensity: 16, distance: 20 },
      { position: vec3(34, 5.5, -10), color: 0xffb84d, intensity: 14, distance: 18 },
      // West alley — deliberately sparse, so it stays the dark route.
      { position: vec3(-30, 4.5, -18), color: 0xffb84d, intensity: 13, distance: 16 },
      { position: vec3(-30, 4.5, 8), color: 0xffb84d, intensity: 13, distance: 16 },
      // Spawn ends.
      { position: vec3(0, 6, -32), color: 0xcfe0ff, intensity: 14, distance: 22 },
      { position: vec3(0, 6, 32), color: 0xcfe0ff, intensity: 14, distance: 22 },
    ],
  },

  spawns: buildSpawns(),

  objectives: [
    { kind: ObjectiveKind.DominationFlag, label: 'A', position: vec3(-30, 0, 16), size: vec3(7, 4, 7), initialOwner: Team.Allies },
    { kind: ObjectiveKind.DominationFlag, label: 'B', position: vec3(0, 0, -4), size: vec3(9, 4, 9), initialOwner: Team.None },
    { kind: ObjectiveKind.DominationFlag, label: 'C', position: vec3(30, 0, -18), size: vec3(7, 4, 7), initialOwner: Team.Axis },

    { kind: ObjectiveKind.BombSite, label: 'A', position: vec3(-31, 0, -8), size: vec3(8, 4, 8) },
    { kind: ObjectiveKind.BombSite, label: 'B', position: vec3(28, 0, 0), size: vec3(8, 4, 8) },

    { kind: ObjectiveKind.Hardpoint, label: 'P1', position: vec3(0, 0, -4), size: vec3(10, 5, 10), order: 0 },
    { kind: ObjectiveKind.Hardpoint, label: 'P2', position: vec3(-30, 0, 6), size: vec3(9, 5, 9), order: 1 },
    { kind: ObjectiveKind.Hardpoint, label: 'P3', position: vec3(0, 0, -26), size: vec3(10, 5, 10), order: 2 },
    { kind: ObjectiveKind.Hardpoint, label: 'P4', position: vec3(28, 0, 0), size: vec3(10, 5, 10), order: 3 },
    { kind: ObjectiveKind.Hardpoint, label: 'P5', position: vec3(-2, 0, 20), size: vec3(10, 5, 10), order: 4 },

    { kind: ObjectiveKind.Headquarters, label: 'HQ1', position: vec3(0, 0, -4), size: vec3(10, 5, 10), order: 0 },
    { kind: ObjectiveKind.Headquarters, label: 'HQ2', position: vec3(-30, 0, -8), size: vec3(9, 5, 9), order: 1 },
    { kind: ObjectiveKind.Headquarters, label: 'HQ3', position: vec3(28, 0, 4), size: vec3(9, 5, 9), order: 2 },
    { kind: ObjectiveKind.Headquarters, label: 'HQ4', position: vec3(-2, 0, 22), size: vec3(10, 5, 10), order: 3 },
  ],

  navLinks: buildNavLinks(),
  coverPoints: buildCoverPoints(),

  lanes: [
    { name: 'west', width: 13, path: [vec3(-32, 0, 34), vec3(-30, 0, 16), vec3(-31, 0, 0), vec3(-32, 0, -16), vec3(-30, 0, -32)] },
    { name: 'mid', width: 24, path: [vec3(-2, 0, 34), vec3(-4, 0, 20), vec3(-6, 0, 2), vec3(-2, 0, -14), vec3(0, 0, -32)] },
    { name: 'east', width: 16, path: [vec3(32, 0, 32), vec3(30, 0, 16), vec3(26, 0, 2), vec3(28, 0, -14), vec3(30, 0, -32)] },
  ],

  ambience: {
    reverbTime: 2.2,
    reverbMix: 0.3,
    wind: 0.2,
    mood: 'industrial',
  },
};
