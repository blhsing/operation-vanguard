/**
 * Shipment Yard — a 24-metre square of shipping containers.
 *
 * Deliberately, aggressively tiny. There is no safe ground anywhere on this map
 * and that is the entire design: fights start the moment you spawn, sightlines
 * are two seconds long, and the skill is in reacting rather than positioning.
 *
 * Everything about it is a consequence of the size:
 *
 *  - **Spawns are scattered, never grouped by side.** On a map this small a team
 *    with a "half" would be spawn-trapped inside thirty seconds. Both teams have
 *    spawn points at every edge and in the middle, and the influence-map scorer
 *    picks whichever happens to be survivable at that instant. It is the one map
 *    where the spawn system is doing visible work every single respawn.
 *  - **The container grid is offset, not aligned.** A regular lattice would give
 *    long straight corridors down every row; staggering them means no line
 *    crosses the whole map.
 *  - **Objectives sit close together.** That is correct here — a Domination flag
 *    thirty metres from another one would be off the map.
 */

import { SurfaceType, Team } from '../../types.js';
import { vec3 } from '../../math.js';
import { box, type Brush, type CoverPoint, type MapDef, type NavLink, type SpawnPoint } from '../map-types.js';
import { ObjectiveKind } from '../map-types.js';
import {
  barrelCluster,
  crate,
  crateStack,
  ground,
  lampPost,
  perimeter,
  sandbags,
  solidContainer,
} from '../props.js';

const HALF = 12;
const BOUNDS = { min: vec3(-18, -3, -18), max: vec3(18, 18, 18) };

const FACE_N = 0;
const FACE_S = Math.PI;
const FACE_E = -Math.PI / 2;
const FACE_W = Math.PI / 2;

function cover(x: number, z: number, facing: number, exposure: number, value = 1, crouch = false, y = 0): CoverPoint {
  return { position: vec3(x, y, z), facing, crouch, exposure, value };
}

function spawn(x: number, z: number, yaw: number, team: Team, group: string): SpawnPoint {
  return { position: vec3(x, 0.1, z), yaw, team, group, priority: 0.5 };
}

// ---------------------------------------------------------------------------

function buildGeometry(): Brush[] {
  const b: Brush[] = [];

  b.push(ground(vec3(0, 0, 0), 40, 40, SurfaceType.Gravel, 0x6a6862));
  b.push(...perimeter(vec3(-HALF - 2, 0, -HALF - 2), vec3(HALF + 2, 0, HALF + 2), 9, SurfaceType.Metal, 0x4a4f54));

  // --- the container grid ------------------------------------------------
  // Staggered on purpose: a square lattice would open a clean lane down every
  // row, and on a map this size one clean lane decides the round.
  const containers: Array<[number, number, number, number, number]> = [
    // x, z, yaw, length, colour
    [-7.5, -8.0, 0, 6, 0x8a4a3a],
    [0.6, -9.0, 0, 6, 0x3a6a7a],
    [8.5, -6.5, Math.PI / 2, 6, 0x6a7a3a],
    [-9.0, -1.0, Math.PI / 2, 6, 0x7a5a3a],
    [-1.0, -2.5, 0, 6, 0x4a5a6a],
    [7.0, 1.0, 0, 6, 0x8a6a3a],
    [-6.0, 6.5, 0, 6, 0x5a4a6a],
    [2.0, 5.5, Math.PI / 2, 6, 0x7a3a3a],
    [9.0, 8.0, 0, 5, 0x3a5a5a],
    [-2.0, 10.0, Math.PI / 2, 5, 0x6a6a4a],
  ];
  for (const [x, z, yaw, len, colour] of containers) {
    b.push(solidContainer(vec3(x, 0, z), yaw, colour, len));
  }

  // A second tier on three of them, reachable by mantling the crates beside
  // them. The high ground is strong but completely exposed — taking it is a
  // real decision rather than a free upgrade.
  b.push(solidContainer(vec3(-7.5, 2.6, -8.0), 0, 0x7a4030, 6));
  b.push(solidContainer(vec3(7.0, 2.6, 1.0), 0, 0x7a5a2a, 6));
  b.push(solidContainer(vec3(-6.0, 2.6, 6.5), 0, 0x4a3a5a, 6));

  // --- mantle routes onto the stacks --------------------------------------
  b.push(...crateStack(vec3(-4.0, 0, -8.0)));
  b.push(...crateStack(vec3(4.6, 0, 1.0)));
  b.push(...crateStack(vec3(-3.0, 0, 6.5)));

  // --- loose cover in the gaps --------------------------------------------
  b.push(crate(vec3(5.0, 0, -3.0), 1.2));
  b.push(crate(vec3(-4.5, 0, 2.5), 1.0));
  b.push(crate(vec3(0.5, 0, 9.0), 1.4));
  b.push(crate(vec3(-9.5, 0, 9.5), 1.0));
  b.push(crate(vec3(9.5, 0, -10.0), 1.2));
  b.push(...barrelCluster(vec3(-1.5, 0, -6.0), 4, 0x8a3a2a));
  b.push(...barrelCluster(vec3(6.0, 0, 6.0), 3, 0x3a5a8a));
  b.push(...barrelCluster(vec3(-10.0, 0, 3.0), 3, 0x5a5a3a));
  b.push(sandbags(vec3(-4.5, 0, -9.5), 5, 0));
  b.push(sandbags(vec3(4.5, 0, 9.5), 5, 0));
  b.push(sandbags(vec3(-9.2, 0, -4.0), 4, Math.PI / 2));
  b.push(sandbags(vec3(9.2, 0, 4.0), 4, Math.PI / 2));

  // --- lighting posts, doubling as head-height cover ----------------------
  b.push(...lampPost(vec3(-11, 0, -11), 6));
  b.push(...lampPost(vec3(11, 0, -11), 6));
  b.push(...lampPost(vec3(-11, 0, 11), 6));
  b.push(...lampPost(vec3(11, 0, 11), 6));

  // A low kerb ring: cosmetic, but it stops the ground reading as a flat plane.
  for (const [x, z, sx, sz] of [
    [0, -12.2, 22, 0.5],
    [0, 12.2, 22, 0.5],
    [-12.2, 0, 0.5, 22],
    [12.2, 0, 0.5, 22],
  ] as Array<[number, number, number, number]>) {
    b.push(box(vec3(x, 0.06, z), vec3(sx, 0.12, sz), SurfaceType.Concrete, { color: 0x8a8880 }));
  }

  return b;
}

// ---------------------------------------------------------------------------
// Spawns
//
// Interleaved rather than split into halves. Both teams draw from points all
// around the yard, so the spawn scorer always has somewhere to put a player that
// is not directly in front of an enemy — which on a 24 m map is the only thing
// standing between this and a permanent spawn trap.
// ---------------------------------------------------------------------------

function buildSpawns(): SpawnPoint[] {
  const out: SpawnPoint[] = [];

  const ring: Array<[number, number, number]> = [
    [-10.5, -10.5, FACE_N], [-5.0, -11.0, FACE_N], [0.0, -11.5, FACE_N], [5.0, -11.0, FACE_N], [10.5, -10.5, FACE_N],
    [11.5, -5.0, FACE_N], [11.5, 0.0, FACE_S], [11.5, 5.0, FACE_N],
    [10.5, 10.5, FACE_S], [5.0, 11.0, FACE_S], [0.0, 11.5, FACE_S], [-5.0, 11.0, FACE_S], [-10.5, 10.5, FACE_S],
    [-11.5, 5.0, FACE_S], [-11.5, 0.0, FACE_N], [-11.5, -5.0, FACE_N],
  ];

  // Interior points, used when the ring is under pressure.
  const interior: Array<[number, number, number]> = [
    [-3.0, -5.0, FACE_N], [4.0, -5.5, FACE_W], [-6.2, 2.6, FACE_E],
    [3.0, 3.0, FACE_S], [-1.0, 8.0, FACE_S], [8.0, -2.0, FACE_W],
  ];

  // Alternate the ring between teams so neither owns a side.
  ring.forEach(([x, z, yaw], i) => {
    out.push(spawn(x, z, yaw, i % 2 === 0 ? Team.Allies : Team.Axis, i % 2 === 0 ? 'allies_ring' : 'axis_ring'));
    // Every ring point is also a valid free-for-all spawn.
    out.push(spawn(x * 0.94, z * 0.94, yaw, Team.None, 'ffa_ring'));
  });

  interior.forEach(([x, z, yaw], i) => {
    out.push(spawn(x, z, yaw, i % 2 === 0 ? Team.Axis : Team.Allies, i % 2 === 0 ? 'axis_inner' : 'allies_inner'));
  });

  // Top up each team so both comfortably clear the validator's minimum even
  // after any point is rejected for being blocked.
  const extra: Array<[number, number, number]> = [
    [-8.0, -5.2, FACE_E], [9.0, 6.0, FACE_S], [-6.0, 9.5, FACE_S], [6.0, -9.5, FACE_N],
    [-10.0, -2.0, FACE_E], [11.0, -1.2, FACE_W], [2.5, -5.8, FACE_N], [-2.5, 7.5, FACE_S],
  ];
  extra.forEach(([x, z, yaw], i) => {
    out.push(spawn(x, z, yaw, i % 2 === 0 ? Team.Allies : Team.Axis, i % 2 === 0 ? 'allies_extra' : 'axis_extra'));
  });

  return out;
}

// ---------------------------------------------------------------------------

function buildCoverPoints(): CoverPoint[] {
  return [
    // Container corners — the whole map is fought around these.
    cover(-4.2, -8.0, FACE_E, 0.3, 1.6),
    cover(-10.8, -8.0, FACE_W, 0.3, 1.4),
    cover(3.9, -9.0, FACE_E, 0.3, 1.6),
    cover(-2.7, -9.0, FACE_W, 0.3, 1.4),
    cover(8.5, -3.2, FACE_S, 0.35, 1.5),
    cover(8.5, -9.8, FACE_N, 0.35, 1.5),
    cover(-9.0, 2.2, FACE_S, 0.3, 1.5),
    cover(-9.0, -4.2, FACE_N, 0.3, 1.5),
    cover(2.3, -2.5, FACE_E, 0.4, 1.7),
    cover(-4.3, -2.5, FACE_W, 0.4, 1.7),
    cover(10.3, 1.0, FACE_E, 0.35, 1.4),
    cover(3.7, 1.0, FACE_W, 0.4, 1.6),
    cover(-2.7, 6.5, FACE_E, 0.35, 1.5),
    cover(-9.3, 6.5, FACE_W, 0.3, 1.4),
    cover(2.0, 8.8, FACE_S, 0.35, 1.4),
    cover(2.0, 2.2, FACE_N, 0.35, 1.5),
    cover(11.5, 8.0, FACE_W, 0.3, 1.2),
    cover(6.5, 8.0, FACE_E, 0.35, 1.3),

    // Loose props.
    cover(5.0, -3.0, FACE_N, 0.5, 1.0, true),
    cover(-4.5, 2.5, FACE_S, 0.5, 1.0, true),
    cover(0.5, 9.0, FACE_S, 0.45, 1.1, true),
    cover(-9.5, 9.5, FACE_S, 0.45, 0.9, true),
    cover(9.5, -10.0, FACE_N, 0.45, 0.9, true),
    cover(-1.5, -6.0, FACE_N, 0.5, 1.0, true),
    cover(6.0, 6.0, FACE_S, 0.5, 1.0, true),
    cover(-10.0, 3.0, FACE_E, 0.5, 0.9, true),
    cover(-4.5, -9.5, FACE_N, 0.5, 0.8, true),
    cover(4.5, 9.5, FACE_S, 0.5, 0.8, true),
    cover(-9.2, -4.0, FACE_E, 0.5, 0.8, true),
    cover(9.2, 4.0, FACE_W, 0.5, 0.8, true),

    // The container tops. High value, high exposure — exactly the trade this
    // map is about.
    cover(-7.5, -8.0, FACE_S, 0.85, 2.0, true, 2.6),
    cover(7.0, 1.0, FACE_N, 0.85, 2.0, true, 2.6),
    cover(-6.0, 6.5, FACE_N, 0.85, 2.0, true, 2.6),
  ];
}

function buildNavLinks(): NavLink[] {
  return [
    { from: vec3(-4.0, 1.0, -8.0), to: vec3(-6.0, 2.7, -8.0), kind: 'mantle', cost: 1.6, bidirectional: false },
    { from: vec3(4.6, 1.0, 1.0), to: vec3(6.0, 2.7, 1.0), kind: 'mantle', cost: 1.6, bidirectional: false },
    { from: vec3(-3.0, 1.0, 6.5), to: vec3(-5.0, 2.7, 6.5), kind: 'mantle', cost: 1.6, bidirectional: false },
    { from: vec3(-7.5, 2.7, -8.0), to: vec3(-7.5, 0, -5.5), kind: 'drop', cost: 1.0, bidirectional: false },
    { from: vec3(7.0, 2.7, 1.0), to: vec3(7.0, 0, 3.5), kind: 'drop', cost: 1.0, bidirectional: false },
    { from: vec3(-6.0, 2.7, 6.5), to: vec3(-6.0, 0, 9.0), kind: 'drop', cost: 1.0, bidirectional: false },
  ];
}

// ---------------------------------------------------------------------------

export const SHIPMENT_YARD: MapDef = {
  id: 'shipment_yard',
  name: '貨櫃場',
  tagline: '二十四公尺。沒有任何掩體撐得久。',
  description:
    '一座比網球場大不了多少的貨櫃場。每次重生都是一場交火，' +
    '每條視線只有兩秒長，唯一有意義的站位，' +
    '是你在被人發現之前搆得到的那個。',
  playerCount: [4, 12],

  bounds: BOUNDS,
  outOfBoundsGrace: 5,

  brushes: buildGeometry(),

  lighting: {
    sunDirection: vec3(0.25, -0.9, 0.35),
    sunColor: 0xfff4e0,
    sunIntensity: 3.1,
    ambientColor: 0x9aa4b0,
    ambientIntensity: 1.5,
    skyTop: 0x9fb6d0,
    skyBottom: 0xd6dee6,
    fogColor: 0xc6cdd6,
    fogNear: 40,
    fogFar: 120,
    exposure: 1.2,
    lights: [
      { position: vec3(-11, 6.1, -11), color: 0xffe9b0, intensity: 10, distance: 16 },
      { position: vec3(11, 6.1, -11), color: 0xffe9b0, intensity: 10, distance: 16 },
      { position: vec3(-11, 6.1, 11), color: 0xffe9b0, intensity: 10, distance: 16 },
      { position: vec3(11, 6.1, 11), color: 0xffe9b0, intensity: 10, distance: 16 },
    ],
  },

  spawns: buildSpawns(),

  objectives: [
    // Close together by necessity. On a 24 m map that is correct — the whole
    // point is that all three flags are contestable from anywhere.
    { kind: ObjectiveKind.DominationFlag, label: 'A', position: vec3(-8.5, 0, 9.0), size: vec3(5, 4, 5), initialOwner: Team.Allies },
    { kind: ObjectiveKind.DominationFlag, label: 'B', position: vec3(0.5, 0, 0.5), size: vec3(6, 4, 6), initialOwner: Team.None },
    { kind: ObjectiveKind.DominationFlag, label: 'C', position: vec3(8.5, 0, -9.0), size: vec3(5, 4, 5), initialOwner: Team.Axis },

    { kind: ObjectiveKind.BombSite, label: 'A', position: vec3(-9.5, 0, -4.5), size: vec3(5, 4, 5) },
    { kind: ObjectiveKind.BombSite, label: 'B', position: vec3(9.5, 0, 4.5), size: vec3(5, 4, 5) },

    { kind: ObjectiveKind.Hardpoint, label: 'P1', position: vec3(0.5, 0, 0.5), size: vec3(7, 5, 7), order: 0 },
    { kind: ObjectiveKind.Hardpoint, label: 'P2', position: vec3(-9.0, 0, -4.5), size: vec3(6, 5, 6), order: 1 },
    { kind: ObjectiveKind.Hardpoint, label: 'P3', position: vec3(0.0, 0, 9.5), size: vec3(6, 5, 6), order: 2 },
    { kind: ObjectiveKind.Hardpoint, label: 'P4', position: vec3(9.5, 0, 4.5), size: vec3(6, 5, 6), order: 3 },

    { kind: ObjectiveKind.Headquarters, label: 'HQ1', position: vec3(0.5, 0, 0.5), size: vec3(7, 5, 7), order: 0 },
    { kind: ObjectiveKind.Headquarters, label: 'HQ2', position: vec3(-9.0, 0, 4.0), size: vec3(6, 5, 6), order: 1 },
    { kind: ObjectiveKind.Headquarters, label: 'HQ3', position: vec3(9.0, 0, -4.0), size: vec3(6, 5, 6), order: 2 },
  ],

  navLinks: buildNavLinks(),
  coverPoints: buildCoverPoints(),

  lanes: [
    { name: 'west', width: 7, path: [vec3(-10, 0, 11), vec3(-10.5, 0, 3), vec3(-9, 0, -5), vec3(-9, 0, -11)] },
    { name: 'mid', width: 8, path: [vec3(0, 0, 11), vec3(1, 0, 4), vec3(-1, 0, -3), vec3(0, 0, -11)] },
    { name: 'east', width: 7, path: [vec3(10, 0, 11), vec3(10.5, 0, 3), vec3(9.5, 0, -5), vec3(9, 0, -11)] },
  ],

  ambience: {
    reverbTime: 1.1,
    reverbMix: 0.25,
    wind: 0.2,
    mood: 'urban',
  },
};
