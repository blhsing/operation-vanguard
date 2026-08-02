/**
 * Subway — an underground station.
 *
 * The only fully interior map in the set, and the tightest. Everything about it
 * is a reaction to the fact that there is no sky: no air support reaches you, no
 * sun lights you, and every fight is decided inside twelve metres.
 *
 * Cross-section, looking down the tunnel:
 *
 *   ceiling y=8.2  ────────────────────────────────
 *   mezzanine y=4.2   ▓▓▓                    ▓▓▓
 *   platform  y=0.0  ████████        ████████
 *   track bed y=-1.2         ────────
 *                    west      mid      east
 *
 * The track bed is the long sightline and it is a trap: you stand 1.2 m below
 * everyone on both platforms with nothing but the rails for cover. The platforms
 * are the real lanes, broken every six metres by a structural pillar. The
 * mezzanine balconies overlook the platform below them but *not* the one
 * opposite — the ceiling clips the angle — so height here buys you your own side
 * of the station and nothing more.
 *
 * Tunnels at both ends are sealed: a stopped train to the north, a collapse to
 * the south. They read as exits and are not.
 */

import { SurfaceType, Team } from '../../types.js';
import { vec3, type Vec3 } from '../../math.js';
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
import { barrier, catwalk, crate, crateStack, lowWall, sandbags, solidContainer, stairs } from '../props.js';

/**
 * Note the ceiling of the bounds: 9 metres, which is *inside* the roof slab.
 *
 * The nav sampler probes downward from `bounds.max.y` looking for standable
 * ground. Leave the bounds above the roof and the first surface it finds in every
 * column is the top of the station — six hundred nodes of perfectly walkable
 * rooftop, which then wins the largest-connected-component vote and prunes the
 * actual station away. The bounds have to stop under the lid.
 */
const BOUNDS = { min: vec3(-30, -4, -44), max: vec3(30, 9, 44) };

const FACE_N = 0;
const FACE_S = Math.PI;
const FACE_E = -Math.PI / 2;
const FACE_W = Math.PI / 2;

/** Platform surface height. The track bed sits 1.2 m below it. */
const PLATFORM_Y = 0;
const TRACK_Y = -1.2;
const MEZZ_Y = 4.2;
const CEILING_Y = 8.2;

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
  spread = 2.6,
  y = PLATFORM_Y,
): SpawnPoint[] {
  const lattice: Array<[number, number]> = [
    [0, 0], [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [-1, 1], [1, -1], [-1, -1], [2, 0], [-2, 0], [0, 2],
  ];
  return lattice.slice(0, count).map(([ox, oz], i) => ({
    position: vec3(cx + ox * spread, y + 0.1, cz + oz * spread),
    yaw: yaw + (i % 3) * 0.14 - 0.14,
    team,
    group,
    priority: 1 - (Math.abs(ox) + Math.abs(oz)) * 0.06,
  }));
}

/** A structural pillar. The platforms are metronomes of these. */
function pillar(x: number, z: number): Brush {
  return box(vec3(x, PLATFORM_Y + 4.1, z), vec3(1.1, 8.2, 1.1), SurfaceType.Concrete, {
    color: 0x8a8f94,
    castShadow: true,
  });
}

/** A platform bench. Crouch cover, and the only soft edge in the place. */
function bench(x: number, z: number, yaw = 0): Brush[] {
  return [
    box(vec3(x, PLATFORM_Y + 0.48, z), vec3(3.2, 0.16, 0.7), SurfaceType.Wood, { yaw, color: 0x6a4a2a, castShadow: true }),
    box(vec3(x, PLATFORM_Y + 0.24, z), vec3(3.0, 0.48, 0.28), SurfaceType.Metal, { yaw, color: 0x4a4f54 }),
  ];
}

/** A vending machine. Chest-high, and the brightest thing on the platform. */
function vending(x: number, z: number, yaw = 0, color = 0xd0402a): Brush {
  return box(vec3(x, PLATFORM_Y + 1.0, z), vec3(1.2, 2.0, 0.8), SurfaceType.Plastic, {
    yaw,
    color,
    castShadow: true,
  });
}

/** A ticket barrier bank: waist-high, passable only at the gaps. */
function turnstiles(x: number, z: number, yaw = 0): Brush[] {
  const out: Brush[] = [];
  for (let i = -1; i <= 1; i++) {
    out.push(
      box(vec3(x + i * 2.2, PLATFORM_Y + 0.55, z), vec3(1.2, 1.1, 0.6), SurfaceType.Metal, {
        yaw,
        color: 0x6a7076,
        castShadow: true,
      }),
    );
  }
  return out;
}

/** One segment of mezzanine railing. `alongZ` runs it down the map. */
function mezzRail(center: Vec3, length: number, alongZ: boolean): Brush {
  const railH = 1.05;
  return box(
    vec3(center.x, center.y + railH / 2, center.z),
    alongZ ? vec3(0.08, railH, length) : vec3(length, railH, 0.08),
    SurfaceType.Metal,
    { color: 0x707880, bulletPassthrough: true, castShadow: false },
  );
}

/** A stopped train, used as a wall at the north end of the track. */
function trainCar(z: number): Brush[] {
  return [
    box(vec3(0, TRACK_Y + 1.9, z), vec3(5.4, 3.8, 16), SurfaceType.Metal, { color: 0x3a5a7a, castShadow: true }),
    box(vec3(0, TRACK_Y + 3.9, z), vec3(4.8, 0.3, 15.4), SurfaceType.Metal, { color: 0x2a4a6a, castShadow: true }),
    // Window band. Non-solid: it is decoration, the car is a wall.
    box(vec3(-2.75, TRACK_Y + 2.6, z), vec3(0.08, 1.0, 14), SurfaceType.Glass, { color: 0x9ac0d8, solid: false }),
    box(vec3(2.75, TRACK_Y + 2.6, z), vec3(0.08, 1.0, 14), SurfaceType.Glass, { color: 0x9ac0d8, solid: false }),
  ];
}

// ---------------------------------------------------------------------------

function buildGeometry(): Brush[] {
  const b: Brush[] = [];

  // --- shell ---------------------------------------------------------------
  // Track bed runs the length of the map; the platforms are slabs on top of it.
  b.push(
    box(vec3(0, TRACK_Y - 0.5, 0), vec3(52, 1.0, 84), SurfaceType.Gravel, {
      color: 0x5a5750,
      textureScale: 14,
      castShadow: false,
    }),
  );
  // Rails. Decorative, but they give the eye the length of the map.
  for (const x of [-1.6, 1.6]) {
    b.push(
      box(vec3(x, TRACK_Y + 0.08, 0), vec3(0.18, 0.16, 82), SurfaceType.Metal, {
        color: 0x7a6a5a, solid: false, castShadow: false,
      }),
    );
  }

  // Platforms: x -24..-6 and 6..24.
  for (const sign of [-1, 1]) {
    b.push(
      box(vec3(sign * 15, PLATFORM_Y - 0.6, 0), vec3(18, 1.2, 84), SurfaceType.Tile, {
        color: 0xb0aca4,
        textureScale: 9,
        castShadow: true,
      }),
    );
    // Warning stripe along the platform edge — non-solid, purely a read.
    b.push(
      box(vec3(sign * 6.6, PLATFORM_Y + 0.01, 0), vec3(0.8, 0.02, 84), SurfaceType.Tile, {
        color: 0xd8c040, solid: false, castShadow: false,
      }),
    );
  }

  // Outer walls, ceiling, and the two tunnel caps.
  b.push(box(vec3(-25.5, 4, 0), vec3(3, 16, 88), SurfaceType.Concrete, { color: 0x8f9298, castShadow: true }));
  b.push(box(vec3(25.5, 4, 0), vec3(3, 16, 88), SurfaceType.Concrete, { color: 0x8f9298, castShadow: true }));
  b.push(box(vec3(0, CEILING_Y + 0.5, 0), vec3(54, 1, 88), SurfaceType.Concrete, { color: 0x74787e, castShadow: true }));
  b.push(box(vec3(0, 4, -42.5), vec3(54, 16, 3), SurfaceType.Concrete, { color: 0x8f9298, castShadow: true }));
  b.push(box(vec3(0, 4, 42.5), vec3(54, 16, 3), SurfaceType.Concrete, { color: 0x8f9298, castShadow: true }));

  // --- pillars -------------------------------------------------------------
  // Every six metres, on both platform edges. This is the map's rhythm: no
  // platform sightline is longer than one pillar gap without a break in it.
  for (let z = -30; z <= 30; z += 6) {
    b.push(pillar(-8.5, z));
    b.push(pillar(8.5, z));
  }

  // --- mezzanine -----------------------------------------------------------
  // Balconies over the outer half of each platform, joined by two bridges.
  //
  // Every deck here is laid railless and the railings are added afterwards as
  // explicit segments. Using the catwalk helper's own railings would run a
  // barrier across each junction — the balcony's inner rail would fence off the
  // bridges, and the bridges' end rails would cut the balconies in half. The
  // result looks exactly like a connected mezzanine and is four separate rooms.
  for (const sign of [-1, 1]) {
    b.push(...catwalk(vec3(sign * 21, MEZZ_Y, 0), vec3(8, 0.3, 58), 0, []));
  }
  b.push(...catwalk(vec3(0, MEZZ_Y, -26), vec3(42, 0.3, 5), 0, []));
  b.push(...catwalk(vec3(0, MEZZ_Y, 26), vec3(42, 0.3, 5), 0, []));

  // Railings: the balcony's inner edge, broken where the bridges meet it, and
  // the bridges' long sides, stopping short of the balconies.
  for (const sign of [-1, 1]) {
    b.push(mezzRail(vec3(sign * 17, MEZZ_Y, 0), 47, true));
  }
  for (const z of [-28.5, -23.5, 23.5, 28.5]) {
    b.push(mezzRail(vec3(0, MEZZ_Y, z), 34, false));
  }

  // Four stairs up. Two per side, at opposite ends, so neither team owns both.
  //
  // Each flight ends flush with the balcony's end rather than under it. Slide a
  // flight even a metre beneath the deck it serves and the top treads lose their
  // headroom: the climb stops half a metre short, which is invisible in the map
  // file, invisible in the renderer, and completely impassable.
  b.push(...stairs(vec3(-20, PLATFORM_Y, -35.5), MEZZ_Y, 6.5, 3.2, '+z', SurfaceType.Concrete));
  b.push(...stairs(vec3(20, PLATFORM_Y, -35.5), MEZZ_Y, 6.5, 3.2, '+z', SurfaceType.Concrete));
  b.push(...stairs(vec3(-20, PLATFORM_Y, 35.5), MEZZ_Y, 6.5, 3.2, '-z', SurfaceType.Concrete));
  b.push(...stairs(vec3(20, PLATFORM_Y, 35.5), MEZZ_Y, 6.5, 3.2, '-z', SurfaceType.Concrete));

  // --- track ends ----------------------------------------------------------
  b.push(...trainCar(-34));
  // Southern collapse: rubble filling the tunnel mouth.
  b.push(box(vec3(0, TRACK_Y + 1.6, 36), vec3(11, 3.2, 8), SurfaceType.Concrete, { color: 0x7a736a, castShadow: true }));
  b.push(...crateStack(vec3(-3, TRACK_Y, 30)));
  b.push(crate(vec3(3.2, TRACK_Y, 31), 1.5));

  // --- platform furniture --------------------------------------------------
  for (const sign of [-1, 1]) {
    const x = sign * 15;
    b.push(...bench(x - sign * 3, -22, Math.PI / 2));
    b.push(...bench(x - sign * 3, -4, Math.PI / 2));
    b.push(...bench(x - sign * 3, 14, Math.PI / 2));
    b.push(vending(x + sign * 3.4, -16, sign < 0 ? FACE_E : FACE_W, sign < 0 ? 0xd0402a : 0x2a70c0));
    b.push(vending(x + sign * 3.4, 8, sign < 0 ? FACE_E : FACE_W, sign < 0 ? 0x2a9050 : 0xd08020));
    b.push(...turnstiles(x, sign < 0 ? -10 : 10, 0));
    b.push(lowWall(vec3(x + sign * 6.2, PLATFORM_Y, -30), 10, sign < 0 ? FACE_E : FACE_W, 1.2, SurfaceType.Metal));
    b.push(lowWall(vec3(x + sign * 6.2, PLATFORM_Y, 24), 10, sign < 0 ? FACE_E : FACE_W, 1.2, SurfaceType.Metal));
  }

  // Centre concourse: the one place the two platforms genuinely meet at ground
  // level, and therefore where every objective ends up.
  b.push(box(vec3(0, PLATFORM_Y - 0.6, 0), vec3(13.2, 1.2, 9), SurfaceType.Tile, { color: 0xa8a49c, castShadow: true }));
  b.push(cylinder(vec3(0, PLATFORM_Y + 1.1, 0), 1.2, 2.2, SurfaceType.Metal, { color: 0x5a6068, segments: 8, castShadow: true }));
  b.push(barrier(vec3(-4.5, PLATFORM_Y, 5.2), 4, 0));
  b.push(barrier(vec3(4.5, PLATFORM_Y, -5.2), 4, 0));
  b.push(sandbags(vec3(-4, TRACK_Y, -14), 5, 0));
  b.push(sandbags(vec3(4, TRACK_Y, 18), 5, 0));
  b.push(solidContainer(vec3(-3.4, TRACK_Y, 8), 0, 0x6a5a3a, 5));
  b.push(solidContainer(vec3(3.4, TRACK_Y, -24), 0, 0x5a6a4a, 5));

  // --- mezzanine furniture -------------------------------------------------
  for (const sign of [-1, 1]) {
    b.push(crate(vec3(sign * 22, MEZZ_Y, -14), 1.3));
    b.push(crate(vec3(sign * 20, MEZZ_Y, 12), 1.1));
    b.push(box(vec3(sign * 22.5, MEZZ_Y + 1.1, 0), vec3(2.4, 2.2, 1.0), SurfaceType.Metal, { color: 0x5a6068, castShadow: true }));
  }
  b.push(crate(vec3(-6, MEZZ_Y, -26), 1.2));
  b.push(crate(vec3(6, MEZZ_Y, 26), 1.2));

  return b;
}

// ---------------------------------------------------------------------------

function buildSpawns(): SpawnPoint[] {
  return [
    ...spawnCluster(-13, 32, Team.Allies, 'allies_west', FACE_N, 6, 2.6),
    ...spawnCluster(13, 32, Team.Allies, 'allies_east', FACE_N, 6, 2.6),
    ...spawnCluster(-13, 20, Team.Allies, 'allies_west_fwd', FACE_N, 4, 2.6),
    ...spawnCluster(13, 20, Team.Allies, 'allies_east_fwd', FACE_N, 4, 2.6),

    ...spawnCluster(-13, -30, Team.Axis, 'axis_west', FACE_S, 6, 2.6),
    ...spawnCluster(13, -30, Team.Axis, 'axis_east', FACE_S, 6, 2.6),
    ...spawnCluster(-13, -18, Team.Axis, 'axis_west_fwd', FACE_S, 4, 2.6),
    ...spawnCluster(13, -18, Team.Axis, 'axis_east_fwd', FACE_S, 4, 2.6),

    ...spawnCluster(-21, 14, Team.None, 'ffa_mezz_sw', FACE_N, 3, 2.4, MEZZ_Y),
    ...spawnCluster(21, -18, Team.None, 'ffa_mezz_ne', FACE_S, 3, 2.4, MEZZ_Y),
    ...spawnCluster(-13, 2, Team.None, 'ffa_west_mid', FACE_E, 4, 2.6),
    ...spawnCluster(13, 4, Team.None, 'ffa_east_mid', FACE_W, 4, 2.6),
  ];
}

function buildCoverPoints(): CoverPoint[] {
  const out: CoverPoint[] = [];

  // Pillars: the backbone of both platform lanes.
  for (let z = -30; z <= 30; z += 6) {
    for (const sign of [-1, 1]) {
      out.push(cover(sign * 9.6, z, sign < 0 ? FACE_E : FACE_W, 0.3, 1.5));
      out.push(cover(sign * 7.4, z, z < 0 ? FACE_N : FACE_S, 0.35, 1.2, true));
    }
  }

  // Platform furniture.
  for (const sign of [-1, 1]) {
    const x = sign * 15;
    out.push(cover(x - sign * 3, -22, sign < 0 ? FACE_E : FACE_W, 0.3, 1.1, true));
    out.push(cover(x - sign * 3, -4, sign < 0 ? FACE_E : FACE_W, 0.3, 1.1, true));
    out.push(cover(x - sign * 3, 14, sign < 0 ? FACE_E : FACE_W, 0.3, 1.1, true));
    out.push(cover(x + sign * 2.2, -16, sign < 0 ? FACE_E : FACE_W, 0.25, 1.3, true));
    out.push(cover(x + sign * 2.2, 8, sign < 0 ? FACE_E : FACE_W, 0.25, 1.3, true));
    out.push(cover(x, sign < 0 ? -12 : 12, sign < 0 ? FACE_S : FACE_N, 0.35, 1.2, true));
    out.push(cover(x + sign * 4.6, -30, sign < 0 ? FACE_E : FACE_W, 0.25, 1.0, true));
    out.push(cover(x + sign * 4.6, 24, sign < 0 ? FACE_E : FACE_W, 0.25, 1.0, true));
  }

  // Track bed. Deliberately low value: down here you are below everyone.
  out.push(cover(-4, -14, FACE_N, 0.7, 0.7, true, TRACK_Y));
  out.push(cover(4, 18, FACE_S, 0.7, 0.7, true, TRACK_Y));
  out.push(cover(-3.4, 5.2, FACE_S, 0.6, 0.9, true, TRACK_Y));
  out.push(cover(3.4, -21, FACE_N, 0.6, 0.9, true, TRACK_Y));
  out.push(cover(0, -26, FACE_S, 0.55, 1.0, true, TRACK_Y));

  // Mezzanine: overlooks its own platform only. Held points every six metres so
  // a bot working the balcony has somewhere to stop, and so the deck is dense
  // enough for the nav graph to treat it as one place.
  for (const sign of [-1, 1]) {
    const inward = sign < 0 ? FACE_E : FACE_W;
    for (const z of [-26, -20, -14, -8, -2, 4, 10, 16, 22, 27]) {
      const value = Math.abs(z) > 22 ? 1.1 : 1.7;
      out.push(cover(sign * 21, z, inward, 0.45, value, true, MEZZ_Y));
    }
    out.push(cover(sign * 22.5, 0, inward, 0.4, 1.4, true, MEZZ_Y));
  }
  // The two bridges over the track.
  for (const z of [-26, 26]) {
    for (const x of [-15, -9, -3, 3, 9, 15]) {
      out.push(cover(x, z, z < 0 ? FACE_S : FACE_N, 0.6, 1.0, true, MEZZ_Y));
    }
  }

  // Centre concourse.
  out.push(cover(-4.5, 5.2, FACE_N, 0.5, 1.3, true));
  out.push(cover(4.5, -5.2, FACE_S, 0.5, 1.3, true));

  return out;
}

function buildNavLinks(): NavLink[] {
  const links: NavLink[] = [];
  // Platform edge <-> track bed. Down is a step off, up is a mantle.
  for (const z of [-28, -16, -4, 8, 20]) {
    for (const sign of [-1, 1]) {
      links.push({ from: vec3(sign * 6.4, PLATFORM_Y, z), to: vec3(sign * 4.6, TRACK_Y, z), kind: 'drop', cost: 0.8, bidirectional: false });
      links.push({ from: vec3(sign * 4.6, TRACK_Y, z), to: vec3(sign * 6.6, PLATFORM_Y, z), kind: 'mantle', cost: 1.4, bidirectional: false });
    }
  }
  // The four staircases, both ways.
  //
  // These are what keep the mezzanine in the graph at all. Grid sampling cannot
  // chain a flight of stairs — the rise between two samples exceeds the
  // same-floor threshold — so without an explicit way *up*, the balconies form
  // an island that the connectivity pass prunes, and the whole upper level
  // quietly stops existing as far as the bots are concerned.
  //
  // The endpoints deliberately sit clear of the staircase footprint: a point on
  // the treads snaps to a mid-flight node that may itself be orphaned.
  for (const sign of [-1, 1]) {
    links.push({ from: vec3(sign * 20, PLATFORM_Y, -38), to: vec3(sign * 20, MEZZ_Y, -26), kind: 'ladder', cost: 1.5, bidirectional: true });
    links.push({ from: vec3(sign * 20, PLATFORM_Y, 38), to: vec3(sign * 20, MEZZ_Y, 26), kind: 'ladder', cost: 1.5, bidirectional: true });
  }

  // Mezzanine drops back onto the platform.
  for (const sign of [-1, 1]) {
    links.push({ from: vec3(sign * 17.2, MEZZ_Y, -8), to: vec3(sign * 14, PLATFORM_Y, -8), kind: 'drop', cost: 1.2, bidirectional: false });
    links.push({ from: vec3(sign * 17.2, MEZZ_Y, 8), to: vec3(sign * 14, PLATFORM_Y, 8), kind: 'drop', cost: 1.2, bidirectional: false });
  }
  return links;
}

// ---------------------------------------------------------------------------

export const SUBWAY: MapDef = {
  id: 'subway',
  name: 'Subway',
  tagline: 'No sky, no air support, no long way round.',
  description:
    'An underground station. Two platforms, a sunken track bed between them and a ' +
    'mezzanine above. Nothing is further than twelve metres away and there is ' +
    'nowhere the ceiling is not.',
  playerCount: [4, 12],

  bounds: BOUNDS,
  outOfBoundsGrace: 6,

  brushes: buildGeometry(),

  lighting: {
    // There is no sun down here. The faint downward key exists only to give the
    // pillars a top edge; almost all of the light is the fluorescent strips and
    // a strong cool ambient bouncing off white tile.
    sunDirection: vec3(0.05, -0.99, 0.1),
    sunColor: 0xc8d4e0,
    sunIntensity: 0.35,
    ambientColor: 0xb8c4cc,
    ambientIntensity: 2.4,
    skyTop: 0x1a1e24,
    skyBottom: 0x101318,
    fogColor: 0x161a20,
    fogNear: 30,
    fogFar: 105,
    exposure: 1.15,
    lights: buildFluorescents(),
  },

  spawns: buildSpawns(),

  objectives: [
    { kind: ObjectiveKind.DominationFlag, label: 'A', position: vec3(-15, PLATFORM_Y, 16), size: vec3(8, 4, 8), initialOwner: Team.Allies },
    { kind: ObjectiveKind.DominationFlag, label: 'B', position: vec3(0, PLATFORM_Y, 0), size: vec3(9, 4, 8), initialOwner: Team.None },
    { kind: ObjectiveKind.DominationFlag, label: 'C', position: vec3(15, PLATFORM_Y, -16), size: vec3(8, 4, 8), initialOwner: Team.Axis },

    { kind: ObjectiveKind.BombSite, label: 'A', position: vec3(-15, PLATFORM_Y, -20), size: vec3(8, 4, 8) },
    { kind: ObjectiveKind.BombSite, label: 'B', position: vec3(15, PLATFORM_Y, 18), size: vec3(8, 4, 8) },

    { kind: ObjectiveKind.Hardpoint, label: 'P1', position: vec3(0, PLATFORM_Y, 0), size: vec3(10, 5, 8), order: 0 },
    { kind: ObjectiveKind.Hardpoint, label: 'P2', position: vec3(-15, PLATFORM_Y, -14), size: vec3(9, 5, 9), order: 1 },
    { kind: ObjectiveKind.Hardpoint, label: 'P3', position: vec3(15, PLATFORM_Y, 14), size: vec3(9, 5, 9), order: 2 },
    { kind: ObjectiveKind.Hardpoint, label: 'P4', position: vec3(-15, PLATFORM_Y, 22), size: vec3(9, 5, 9), order: 3 },
    { kind: ObjectiveKind.Hardpoint, label: 'P5', position: vec3(15, PLATFORM_Y, -22), size: vec3(9, 5, 9), order: 4 },

    { kind: ObjectiveKind.Headquarters, label: 'HQ1', position: vec3(0, PLATFORM_Y, 0), size: vec3(10, 5, 8), order: 0 },
    { kind: ObjectiveKind.Headquarters, label: 'HQ2', position: vec3(-15, PLATFORM_Y, 6), size: vec3(9, 5, 9), order: 1 },
    { kind: ObjectiveKind.Headquarters, label: 'HQ3', position: vec3(15, PLATFORM_Y, -6), size: vec3(9, 5, 9), order: 2 },
    { kind: ObjectiveKind.Headquarters, label: 'HQ4', position: vec3(-15, PLATFORM_Y, -26), size: vec3(9, 5, 9), order: 3 },
  ],

  navLinks: buildNavLinks(),
  coverPoints: buildCoverPoints(),

  lanes: [
    { name: 'west_platform', width: 16, path: [vec3(-15, 0, 34), vec3(-15, 0, 16), vec3(-15, 0, 0), vec3(-15, 0, -16), vec3(-15, 0, -32)] },
    { name: 'track', width: 11, path: [vec3(0, TRACK_Y, 30), vec3(0, TRACK_Y, 14), vec3(0, TRACK_Y, 0), vec3(0, TRACK_Y, -14), vec3(0, TRACK_Y, -26)] },
    { name: 'east_platform', width: 16, path: [vec3(15, 0, 34), vec3(15, 0, 16), vec3(15, 0, 0), vec3(15, 0, -16), vec3(15, 0, -32)] },
    { name: 'mezzanine', width: 8, path: [vec3(-21, MEZZ_Y, 26), vec3(-21, MEZZ_Y, 0), vec3(-21, MEZZ_Y, -26), vec3(21, MEZZ_Y, -26), vec3(21, MEZZ_Y, 0), vec3(21, MEZZ_Y, 26)] },
  ],

  ambience: {
    // A concrete box. Long tail, heavy mix — footsteps arrive before their owner,
    // which is most of what makes this map tense.
    reverbTime: 2.4,
    reverbMix: 0.42,
    wind: 0.08,
    mood: 'interior',
  },
};

/**
 * Ceiling strip lights.
 *
 * Kept to fourteen: the renderer caps a map at sixteen, and blowing that budget
 * on an interior is exactly how you end up with a map whose far end is unlit on
 * some machines and lit on others.
 */
function buildFluorescents(): NonNullable<MapDef['lighting']['lights']> {
  const out: NonNullable<MapDef['lighting']['lights']> = [];
  for (const z of [-30, -18, -6, 6, 18, 30]) {
    out.push({ position: vec3(-15, CEILING_Y - 0.6, z), color: 0xe4f0ff, intensity: 16, distance: 22 });
    out.push({ position: vec3(15, CEILING_Y - 0.6, z), color: 0xe4f0ff, intensity: 16, distance: 22 });
  }
  out.push({ position: vec3(0, CEILING_Y - 0.6, -14), color: 0xd8e8ff, intensity: 14, distance: 20 });
  out.push({ position: vec3(0, CEILING_Y - 0.6, 14), color: 0xd8e8ff, intensity: 14, distance: 20 });
  return out;
}
