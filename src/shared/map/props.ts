/**
 * Map prop kit.
 *
 * Maps are authored from a shared vocabulary of props rather than raw boxes.
 * Two reasons: the props encode gameplay-correct dimensions (a crate you can
 * mantle is 1.0 m; a crate that blocks you is 1.6 m; a wall you can shoot over
 * while crouched is 1.1 m), and reusing them means every map reads consistently
 * to a player who has learned one of them.
 *
 * Every helper returns plain Brush[] so maps stay pure data.
 */

import { SurfaceType } from '../types.js';
import { MANTLE, MOVE, STANCE_HEIGHT } from '../constants.js';
import { vec3, type Vec3 } from '../math.js';
import { box, cylinder, ramp, type Brush } from './map-types.js';

// ---------------------------------------------------------------------------
// Canonical heights
//
// These are derived from the movement constants rather than guessed, so a change
// to step height or mantle reach can never silently desync the level design from
// what the controller actually permits.
// ---------------------------------------------------------------------------

export const PROP_HEIGHT = {
  /** Walk straight over it — below step height. */
  curb: MOVE.stepHeight * 0.7,
  /** Vault it. Comfortably inside the mantle band. */
  vaultable: 1.0,
  /** Crouch behind it, shoot over it standing. */
  waistCover: 1.15,
  /** Stand behind it and be fully hidden. */
  fullCover: STANCE_HEIGHT.stand + 0.15,
  /** Tallest thing still mantleable. */
  maxMantle: MANTLE.maxHeight - 0.05,
  /** Standard interior storey. */
  storey: 3.4,
} as const;

// ---------------------------------------------------------------------------
// Containers and crates
// ---------------------------------------------------------------------------

/** A 6 m shipping container. The single most useful cover primitive there is. */
export function shippingContainer(
  position: Vec3,
  yaw = 0,
  color = 0x8a5a3a,
  length = 6,
): Brush[] {
  const h = 2.6;
  const w = 2.4;
  const t = 0.12;
  const y = position.y + h / 2;
  return [
    // Shell built from panels so the interior is enterable when an end is open.
    box(vec3(position.x, y, position.z), vec3(length, t, w), SurfaceType.Metal, {
      yaw, color, castShadow: true,
    }),
    box(vec3(position.x, position.y + h, position.z), vec3(length, t, w), SurfaceType.Metal, {
      yaw, color, castShadow: true,
    }),
    box(vec3(position.x, y, position.z), vec3(length, h, t), SurfaceType.Metal, {
      yaw, color, castShadow: true,
    }),
  ].concat(
    // Two side walls, offset along the container's local Z.
    [-1, 1].map((s) =>
      box(
        vec3(
          position.x - Math.sin(yaw) * 0 + Math.cos(yaw) * 0 + s * Math.sin(yaw) * (w / 2),
          y,
          position.z + s * Math.cos(yaw) * (w / 2),
        ),
        vec3(length, h, t),
        SurfaceType.Metal,
        { yaw, color, castShadow: true },
      ),
    ),
  );
}

/** A solid container — no interior, cheaper, used when it is pure cover. */
export function solidContainer(position: Vec3, yaw = 0, color = 0x8a5a3a, length = 6): Brush {
  return box(
    vec3(position.x, position.y + 1.3, position.z),
    vec3(length, 2.6, 2.4),
    SurfaceType.Metal,
    { yaw, color, castShadow: true },
  );
}

/** A wooden crate. `size` is the cube edge; 1.0 is mantleable, 1.8 is not. */
export function crate(position: Vec3, size = 1.0, yaw = 0): Brush {
  return box(
    vec3(position.x, position.y + size / 2, position.z),
    vec3(size, size, size),
    SurfaceType.Wood,
    { yaw, castShadow: true, textureScale: Math.max(1, size) },
  );
}

/** A stack of crates forming a mantleable step up to a higher one. */
export function crateStack(position: Vec3, yaw = 0): Brush[] {
  return [
    crate(vec3(position.x, position.y, position.z), 1.0, yaw),
    crate(vec3(position.x + 1.05, position.y, position.z + 0.1), 1.4, yaw + 0.2),
    crate(vec3(position.x + 0.3, position.y + 1.0, position.z - 0.1), 0.8, yaw - 0.3),
  ];
}

/** An oil drum. Cylindrical so players can actually hide behind it properly. */
export function barrel(position: Vec3, color = 0x8a3a2a): Brush {
  return cylinder(vec3(position.x, position.y + 0.45, position.z), 0.31, 0.9, SurfaceType.Metal, {
    color,
    segments: 12,
    castShadow: true,
  });
}

export function barrelCluster(position: Vec3, count = 4, color = 0x8a3a2a): Brush[] {
  // Fixed offsets rather than random so the map is byte-identical every load.
  const offsets: Array<[number, number]> = [
    [0, 0],
    [0.68, 0.12],
    [0.3, 0.66],
    [-0.4, 0.5],
    [0.9, 0.8],
    [-0.6, -0.3],
  ];
  return offsets
    .slice(0, count)
    .map(([dx, dz]) => barrel(vec3(position.x + dx, position.y, position.z + dz), color));
}

// ---------------------------------------------------------------------------
// Cover
// ---------------------------------------------------------------------------

/** A waist-high sandbag wall you can shoot over standing but not crouched. */
export function sandbags(position: Vec3, length: number, yaw = 0): Brush {
  return box(
    vec3(position.x, position.y + PROP_HEIGHT.waistCover / 2, position.z),
    vec3(length, PROP_HEIGHT.waistCover, 0.7),
    SurfaceType.Sand,
    { yaw, color: 0x9a8a63, castShadow: true },
  );
}

/** A concrete jersey barrier. */
export function barrier(position: Vec3, length = 3, yaw = 0): Brush {
  return box(
    vec3(position.x, position.y + 0.55, position.z),
    vec3(length, 1.1, 0.6),
    SurfaceType.Concrete,
    { yaw, color: 0x9a9a94, castShadow: true },
  );
}

/**
 * A low wall. Height defaults to waist so it doubles as cover; pass
 * PROP_HEIGHT.vaultable to make it a mantle point.
 */
export function lowWall(
  position: Vec3,
  length: number,
  yaw = 0,
  height: number = PROP_HEIGHT.waistCover,
  surface: SurfaceType = SurfaceType.Brick,
): Brush {
  return box(
    vec3(position.x, position.y + height / 2, position.z),
    vec3(length, height, 0.45),
    surface,
    { yaw, castShadow: true },
  );
}

/**
 * A chain-link fence: blocks movement, lets bullets and sight through. This is
 * the prop that makes a lane feel connected without being walkable.
 */
export function fence(position: Vec3, length: number, yaw = 0, height = 2.4): Brush {
  return box(
    vec3(position.x, position.y + height / 2, position.z),
    vec3(length, height, 0.08),
    SurfaceType.Metal,
    { yaw, color: 0x6a6f74, bulletPassthrough: true, castShadow: false, textureScale: length },
  );
}

// ---------------------------------------------------------------------------
// Structures
// ---------------------------------------------------------------------------

export interface BuildingOptions {
  surface?: SurfaceType;
  floorSurface?: SurfaceType;
  color?: number;
  wallThickness?: number;
  /** Sides left completely open. */
  openSides?: Array<'+x' | '-x' | '+z' | '-z'>;
  /** Doorways punched into the remaining walls: side -> lateral offsets. */
  doors?: Partial<Record<'+x' | '-x' | '+z' | '-z', number[]>>;
  /** Window slits at chest height. */
  windows?: Partial<Record<'+x' | '-x' | '+z' | '-z', number[]>>;
  doorWidth?: number;
  doorHeight?: number;
  windowWidth?: number;
  roof?: boolean;
  floor?: boolean;
}

/**
 * A rectangular building with doorways and windows.
 *
 * Doors and windows are punched by emitting wall segments around the gap rather
 * than by subtracting volumes, because the collision system is convex-brush based
 * and has no CSG. The bookkeeping is worth it: a building you can actually run
 * through and shoot out of is the difference between a map and a maze of blocks.
 */
export function building(center: Vec3, size: Vec3, opts: BuildingOptions = {}): Brush[] {
  const t = opts.wallThickness ?? 0.35;
  const surface = opts.surface ?? SurfaceType.Concrete;
  const color = opts.color;
  const doorW = opts.doorWidth ?? 1.6;
  const doorH = opts.doorHeight ?? 2.3;
  const winW = opts.windowWidth ?? 1.8;
  const open = new Set(opts.openSides ?? []);

  const hx = size.x / 2;
  const hy = size.y / 2;
  const hz = size.z / 2;
  const bottom = center.y - hy;
  const out: Brush[] = [];

  const style = { color, castShadow: true } as const;

  if (opts.floor !== false) {
    out.push(
      box(
        vec3(center.x, bottom - t / 2, center.z),
        vec3(size.x + t * 2, t, size.z + t * 2),
        opts.floorSurface ?? SurfaceType.Concrete,
        style,
      ),
    );
  }
  if (opts.roof !== false) {
    out.push(
      box(
        vec3(center.x, center.y + hy + t / 2, center.z),
        vec3(size.x + t * 2, t, size.z + t * 2),
        surface,
        style,
      ),
    );
  }

  const sides: Array<{
    key: '+x' | '-x' | '+z' | '-z';
    /** Centre of the wall. */
    c: Vec3;
    /** Length of the wall along its running axis. */
    span: number;
    horizontal: boolean;
  }> = [
    { key: '-x', c: vec3(center.x - hx - t / 2, center.y, center.z), span: size.z, horizontal: false },
    { key: '+x', c: vec3(center.x + hx + t / 2, center.y, center.z), span: size.z, horizontal: false },
    { key: '-z', c: vec3(center.x, center.y, center.z - hz - t / 2), span: size.x, horizontal: true },
    { key: '+z', c: vec3(center.x, center.y, center.z + hz + t / 2), span: size.x, horizontal: true },
  ];

  for (const side of sides) {
    if (open.has(side.key)) continue;

    const doors = (opts.doors?.[side.key] ?? []).map((o) => ({ offset: o, width: doorW, bottom: 0, top: doorH }));
    const windows = (opts.windows?.[side.key] ?? []).map((o) => ({
      offset: o,
      width: winW,
      bottom: 1.05,
      top: 2.15,
    }));
    const gaps = [...doors, ...windows].sort((a, b) => a.offset - b.offset);

    emitWallWithGaps(out, side, size, t, bottom, gaps, surface, style);
  }

  return out;
}

interface Gap {
  offset: number;
  width: number;
  /** Height above the building floor where the gap starts and ends. */
  bottom: number;
  top: number;
}

/**
 * Emit a wall as a set of solid segments around the supplied gaps.
 *
 * Horizontal runs are split first, then each gap contributes a sill below it and
 * a header above it. Overlapping gaps are merged by processing them in order and
 * tracking how far along the wall we have already built.
 */
function emitWallWithGaps(
  out: Brush[],
  side: { c: Vec3; span: number; horizontal: boolean },
  size: Vec3,
  thickness: number,
  bottom: number,
  gaps: Gap[],
  surface: SurfaceType,
  style: { color?: number; castShadow: boolean },
): void {
  const half = side.span / 2;
  const height = size.y;
  const depth = thickness;

  const push = (offset: number, length: number, yCenter: number, h: number): void => {
    if (length <= 0.02 || h <= 0.02) return;
    const pos = side.horizontal
      ? vec3(side.c.x + offset, yCenter, side.c.z)
      : vec3(side.c.x, yCenter, side.c.z + offset);
    const dim = side.horizontal ? vec3(length, h, depth) : vec3(depth, h, length);
    out.push(box(pos, dim, surface, style));
  };

  if (gaps.length === 0) {
    push(0, side.span, side.c.y, height);
    return;
  }

  let cursor = -half;
  for (const gap of gaps) {
    const left = gap.offset - gap.width / 2;
    const right = gap.offset + gap.width / 2;

    // Solid run before this gap.
    if (left > cursor) {
      const segLen = left - cursor;
      push(cursor + segLen / 2, segLen, side.c.y, height);
    }

    const gapLeft = Math.max(cursor, left);
    const gapRight = Math.min(half, right);
    const gapLen = gapRight - gapLeft;

    if (gapLen > 0.02) {
      // Sill below the opening.
      if (gap.bottom > 0.02) {
        push(gapLeft + gapLen / 2, gapLen, bottom + gap.bottom / 2, gap.bottom);
      }
      // Header above it.
      const headerH = height - gap.top;
      if (headerH > 0.02) {
        push(gapLeft + gapLen / 2, gapLen, bottom + gap.top + headerH / 2, headerH);
      }
    }

    cursor = Math.max(cursor, right);
  }

  if (cursor < half) {
    const segLen = half - cursor;
    push(cursor + segLen / 2, segLen, side.c.y, height);
  }
}

// ---------------------------------------------------------------------------
// Vertical circulation
// ---------------------------------------------------------------------------

/**
 * A staircase built from discrete steps.
 *
 * Real steps rather than a ramp, because the step-up code is what players
 * actually feel when climbing, and because a stair you can shoot between the
 * treads of reads very differently to a solid slope.
 */
export function stairs(
  bottomCenter: Vec3,
  rise: number,
  run: number,
  width: number,
  direction: '+x' | '-x' | '+z' | '-z',
  surface = SurfaceType.Concrete,
): Brush[] {
  const stepHeight = 0.28;
  const count = Math.max(1, Math.round(rise / stepHeight));
  const actualStep = rise / count;
  const stepRun = run / count;
  const out: Brush[] = [];

  const dx = direction === '+x' ? 1 : direction === '-x' ? -1 : 0;
  const dz = direction === '+z' ? 1 : direction === '-z' ? -1 : 0;

  for (let i = 0; i < count; i++) {
    // Each tread is a solid block from the ground up, so there is no gap to
    // fall through and the step-up code always finds a surface.
    const h = actualStep * (i + 1);
    const cx = bottomCenter.x + dx * (stepRun * (i + 0.5));
    const cz = bottomCenter.z + dz * (stepRun * (i + 0.5));
    out.push(
      box(
        vec3(cx, bottomCenter.y + h / 2, cz),
        dx !== 0 ? vec3(stepRun, h, width) : vec3(width, h, stepRun),
        surface,
        { castShadow: true },
      ),
    );
  }
  return out;
}

/** A sloped ramp with side rails — faster to traverse than stairs. */
export function rampWithRails(
  center: Vec3,
  size: Vec3,
  rise: '+x' | '-x' | '+z' | '-z',
  surface = SurfaceType.Metal,
): Brush[] {
  const out: Brush[] = [ramp(center, size, rise, surface, { castShadow: true })];
  const along = rise === '+x' || rise === '-x';
  const railOffset = (along ? size.z : size.x) / 2;
  for (const s of [-1, 1]) {
    out.push(
      box(
        along
          ? vec3(center.x, center.y + size.y / 2 + 0.5, center.z + s * railOffset)
          : vec3(center.x + s * railOffset, center.y + size.y / 2 + 0.5, center.z),
        along ? vec3(size.x, 1.0, 0.08) : vec3(0.08, 1.0, size.z),
        SurfaceType.Metal,
        { bulletPassthrough: true, color: 0x707880, castShadow: false },
      ),
    );
  }
  return out;
}

/** An elevated walkway with railings — the classic second-floor flank route. */
export function catwalk(
  center: Vec3,
  size: Vec3,
  yaw = 0,
  railings: Array<'+x' | '-x' | '+z' | '-z'> = ['+z', '-z'],
): Brush[] {
  const deckThickness = 0.16;
  const out: Brush[] = [
    box(
      vec3(center.x, center.y, center.z),
      vec3(size.x, deckThickness, size.z),
      SurfaceType.Metal,
      { yaw, color: 0x5f666d, castShadow: true },
    ),
  ];

  const railH = 1.05;
  for (const side of railings) {
    const isX = side === '+x' || side === '-x';
    const s = side === '+x' || side === '+z' ? 1 : -1;
    out.push(
      box(
        isX
          ? vec3(center.x + (s * size.x) / 2, center.y + railH / 2, center.z)
          : vec3(center.x, center.y + railH / 2, center.z + (s * size.z) / 2),
        isX ? vec3(0.08, railH, size.z) : vec3(size.x, railH, 0.08),
        SurfaceType.Metal,
        { yaw, color: 0x707880, bulletPassthrough: true, castShadow: false },
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scenery
// ---------------------------------------------------------------------------

/** A car. Cover you can shoot through the windows of but not the engine block. */
export function car(position: Vec3, yaw = 0, color = 0x4a5a6a): Brush[] {
  return [
    box(vec3(position.x, position.y + 0.42, position.z), vec3(4.3, 0.84, 1.85), SurfaceType.Metal, {
      yaw, color, castShadow: true,
    }),
    box(vec3(position.x, position.y + 1.12, position.z), vec3(2.3, 0.62, 1.7), SurfaceType.Glass, {
      yaw, color: 0x2a3540, castShadow: true, breakable: true,
    }),
    // Wheels keep it from looking like it is floating and give a prone gap.
    ...[
      [-1.5, -0.85],
      [-1.5, 0.85],
      [1.5, -0.85],
      [1.5, 0.85],
    ].map(([ox, oz]) =>
      cylinder(
        vec3(
          position.x + ox! * Math.cos(yaw) - oz! * Math.sin(yaw),
          position.y + 0.16,
          position.z + ox! * Math.sin(yaw) + oz! * Math.cos(yaw),
        ),
        0.33,
        0.3,
        SurfaceType.Plastic,
        { color: 0x1a1a1c, segments: 8, castShadow: false },
      ),
    ),
  ];
}

/** A burnt-out truck — bigger cover, blocks a lane. */
export function truck(position: Vec3, yaw = 0, color = 0x5a5f4a): Brush[] {
  return [
    box(vec3(position.x, position.y + 0.75, position.z), vec3(7.5, 1.5, 2.5), SurfaceType.Metal, {
      yaw, color, castShadow: true,
    }),
    box(
      vec3(position.x - 2.2 * Math.cos(yaw), position.y + 1.9, position.z - 2.2 * Math.sin(yaw)),
      vec3(2.4, 1.4, 2.4),
      SurfaceType.Metal,
      { yaw, color, castShadow: true },
    ),
    box(
      vec3(position.x + 1.6 * Math.cos(yaw), position.y + 2.3, position.z + 1.6 * Math.sin(yaw)),
      vec3(4.4, 2.2, 2.5),
      SurfaceType.Metal,
      { yaw, color: 0x3a3f30, castShadow: true },
    ),
  ];
}

/** A tree. Trunk collides; canopy is decoration that breaks up sightlines. */
export function tree(position: Vec3, height = 6, canopyRadius = 2.6): Brush[] {
  return [
    cylinder(vec3(position.x, position.y + height / 2, position.z), 0.32, height, SurfaceType.Wood, {
      color: 0x4a3a28,
      segments: 8,
      castShadow: true,
    }),
    cylinder(
      vec3(position.x, position.y + height * 0.85, position.z),
      canopyRadius,
      height * 0.5,
      SurfaceType.Foliage,
      { color: 0x3d5a2c, segments: 10, solid: false, castShadow: true },
    ),
  ];
}

/** A lamp post — vertical landmark, and something to hide the head behind. */
export function lampPost(position: Vec3, height = 5): Brush[] {
  return [
    cylinder(vec3(position.x, position.y + height / 2, position.z), 0.13, height, SurfaceType.Metal, {
      color: 0x3a3f44,
      segments: 6,
      castShadow: true,
    }),
    box(
      vec3(position.x, position.y + height + 0.1, position.z),
      vec3(0.5, 0.2, 0.5),
      SurfaceType.Glass,
      { color: 0xffe9b0, emissive: 1.4, castShadow: false },
    ),
  ];
}

/** A market stall — cheap interior cover with an awning that blocks air sight. */
export function marketStall(position: Vec3, yaw = 0, color = 0xb04a3a): Brush[] {
  return [
    box(vec3(position.x, position.y + 0.5, position.z), vec3(3.0, 1.0, 1.6), SurfaceType.Wood, {
      yaw, color: 0x7a5a3a, castShadow: true,
    }),
    box(vec3(position.x, position.y + 2.5, position.z), vec3(3.4, 0.1, 2.2), SurfaceType.Plastic, {
      yaw, color, castShadow: true, solid: false,
    }),
    ...[-1.5, 1.5].map((ox) =>
      cylinder(
        vec3(position.x + ox * Math.cos(yaw), position.y + 1.25, position.z + ox * Math.sin(yaw)),
        0.06,
        2.5,
        SurfaceType.Wood,
        { color: 0x6a4a2a, segments: 5, castShadow: false },
      ),
    ),
  ];
}

/** A perimeter wall ring that keeps players inside the playable area. */
export function perimeter(
  min: Vec3,
  max: Vec3,
  height = 12,
  surface = SurfaceType.Concrete,
  color = 0x55585c,
): Brush[] {
  const cx = (min.x + max.x) / 2;
  const cz = (min.z + max.z) / 2;
  const sx = max.x - min.x;
  const sz = max.z - min.z;
  const t = 1.0;
  const y = min.y + height / 2;
  return [
    box(vec3(cx, y, min.z - t / 2), vec3(sx + t * 2, height, t), surface, { color, castShadow: true }),
    box(vec3(cx, y, max.z + t / 2), vec3(sx + t * 2, height, t), surface, { color, castShadow: true }),
    box(vec3(min.x - t / 2, y, cz), vec3(t, height, sz + t * 2), surface, { color, castShadow: true }),
    box(vec3(max.x + t / 2, y, cz), vec3(t, height, sz + t * 2), surface, { color, castShadow: true }),
  ];
}

/** The ground plane. Always emit this first so it sorts predictably. */
export function ground(
  center: Vec3,
  sizeX: number,
  sizeZ: number,
  surface = SurfaceType.Concrete,
  color?: number,
): Brush {
  return box(vec3(center.x, center.y - 0.5, center.z), vec3(sizeX, 1, sizeZ), surface, {
    color,
    textureScale: Math.max(sizeX, sizeZ) / 4,
    castShadow: false,
  });
}
