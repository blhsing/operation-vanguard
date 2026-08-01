/**
 * Map format.
 *
 * Maps are authored as TypeScript data, not binary assets. That keeps the whole
 * game self-contained and diffable, and it means the renderer, the collision
 * system, the navmesh builder and the spawn selector all read from one source of
 * truth instead of three exported files that can drift apart.
 *
 * A map is a set of convex brushes (boxes and ramps), plus semantic annotations:
 * spawn zones, objectives, cover points, and navigation hints.
 */

import type { Vec3 } from '../math.js';
import { SurfaceType, Team } from '../types.js';

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export enum BrushKind {
  /** Axis-aligned or yaw-rotated box. The workhorse. */
  Box = 'box',
  /** A wedge — box with one sloped face. Used for ramps and roofs. */
  Ramp = 'ramp',
  /** Vertical cylinder — pillars, barrels, silos. */
  Cylinder = 'cylinder',
  /** A flat plane with no thickness; renders one-sided, blocks nothing. */
  Plane = 'plane',
}

export interface BrushBase {
  kind: BrushKind;
  /** Centre of the brush in world space. */
  position: Vec3;
  /** Yaw rotation about Y, radians. Boxes support rotation; cylinders ignore it. */
  yaw?: number;
  surface: SurfaceType;
  /** Overrides the surface's default colour when set. */
  color?: number;
  /** 0 = matte, 1 = mirror. Defaults from the surface. */
  roughness?: number;
  metalness?: number;
  /** Emissive intensity for signage and light panels. */
  emissive?: number;
  /** Repeats the procedural texture this many times across the face. */
  textureScale?: number;
  /** When false, bullets and players pass through (decoration only). */
  solid?: boolean;
  /** When false, the brush is invisible but still collides (clip brushes). */
  visible?: boolean;
  /** When true, this brush blocks movement but not bullets (e.g. railings). */
  bulletPassthrough?: boolean;
  /** Shatters when shot. */
  breakable?: boolean;
  /** Casts shadows. Disable on tiny props for performance. */
  castShadow?: boolean;
  /** Free-form tag used by mode scripts and AI hints. */
  tag?: string;
}

export interface BoxBrush extends BrushBase {
  kind: BrushKind.Box;
  /** Full extents (width, height, depth). */
  size: Vec3;
}

export interface RampBrush extends BrushBase {
  kind: BrushKind.Ramp;
  size: Vec3;
  /** Which horizontal direction the ramp rises toward, before `yaw` is applied. */
  rise: '+x' | '-x' | '+z' | '-z';
}

export interface CylinderBrush extends BrushBase {
  kind: BrushKind.Cylinder;
  radius: number;
  height: number;
  /** Radial segments. Low values give a faceted, stylised look cheaply. */
  segments?: number;
}

export interface PlaneBrush extends BrushBase {
  kind: BrushKind.Plane;
  size: Vec3;
  /** Which way the plane faces. */
  facing: '+x' | '-x' | '+y' | '-y' | '+z' | '-z';
}

export type Brush = BoxBrush | RampBrush | CylinderBrush | PlaneBrush;

// ---------------------------------------------------------------------------
// Lighting and atmosphere
// ---------------------------------------------------------------------------

export interface MapLighting {
  /** Sun direction (points from the sun toward the scene). */
  sunDirection: Vec3;
  sunColor: number;
  sunIntensity: number;
  ambientColor: number;
  ambientIntensity: number;
  /** Sky gradient top and bottom. */
  skyTop: number;
  skyBottom: number;
  fogColor: number;
  fogNear: number;
  fogFar: number;
  /** Overall exposure, tuned per map so no map reads too dark. */
  exposure: number;
  /** Point lights for interiors. */
  lights?: Array<{
    position: Vec3;
    color: number;
    intensity: number;
    distance: number;
    castShadow?: boolean;
  }>;
}

// ---------------------------------------------------------------------------
// Spawns
// ---------------------------------------------------------------------------

export interface SpawnPoint {
  position: Vec3;
  yaw: number;
  /** Which team may use this point. Team.None = any team (FFA and neutral zones). */
  team: Team;
  /**
   * Spawn group. Modes bias toward the group nearest their objective, which is
   * what makes Domination spawns flip when a flag changes hands.
   */
  group: string;
  /** Higher priority spawns are preferred when otherwise equal. */
  priority?: number;
  /** Only usable at round start (Search & Destroy insertion points). */
  initialOnly?: boolean;
}

// ---------------------------------------------------------------------------
// Objectives
// ---------------------------------------------------------------------------

export enum ObjectiveKind {
  /** Domination flag. */
  DominationFlag = 'dom_flag',
  /** Search & Destroy bomb site. */
  BombSite = 'bomb_site',
  /** Hardpoint rotation zone. */
  Hardpoint = 'hardpoint',
  /** Headquarters capture zone. */
  Headquarters = 'hq',
  /** Generic capture zone for custom modes. */
  Capture = 'capture',
}

export interface ObjectiveDef {
  kind: ObjectiveKind;
  /** Display label — "A", "B", "C" for Domination and S&D. */
  label: string;
  position: Vec3;
  /** Capture volume, centred on `position`. */
  size: Vec3;
  /** Rotation order for Hardpoint; ignored elsewhere. */
  order?: number;
  /** Which team starts owning it (Domination B is neutral). */
  initialOwner?: Team;
}

// ---------------------------------------------------------------------------
// Navigation and AI hints
// ---------------------------------------------------------------------------

/**
 * Navmesh polygons are generated from brush geometry at load time, but maps can
 * supply explicit links for jumps, mantles and drop-downs that the generator
 * cannot infer.
 */
export interface NavLink {
  from: Vec3;
  to: Vec3;
  kind: 'mantle' | 'jump' | 'drop' | 'ladder';
  /** Traversal cost multiplier — bots avoid expensive links unless it pays off. */
  cost: number;
  /** One-way links (drop-downs) can't be traversed in reverse. */
  bidirectional: boolean;
}

/**
 * A position a bot can hold while shooting, with the direction it should face.
 * Hand-placing these is what makes bots hold angles like people instead of
 * standing in the open.
 */
export interface CoverPoint {
  position: Vec3;
  /** Direction the cover protects against. */
  facing: number;
  /** Whether the bot must crouch to be covered here. */
  crouch: boolean;
  /** How exposed this spot is, 0 (fully covered) to 1 (open). */
  exposure: number;
  /** Bots prefer high-value cover overlooking objectives. */
  value: number;
}

/**
 * COD maps are built on three lanes. Tagging them lets bots pick a lane and
 * commit to it, and lets the spawn system reason about which half of the map a
 * team controls.
 */
export interface LaneDef {
  name: string;
  /** Ordered waypoints from one team's side to the other. */
  path: Vec3[];
  width: number;
}

// ---------------------------------------------------------------------------
// The map itself
// ---------------------------------------------------------------------------

export interface MapDef {
  id: string;
  name: string;
  /** One-line flavour text for the loading screen. */
  tagline: string;
  description: string;
  /** Recommended player count range. */
  playerCount: [number, number];

  /** World bounds. Anything outside is out of bounds and kills after a delay. */
  bounds: { min: Vec3; max: Vec3 };
  /** Seconds out of bounds before death. */
  outOfBoundsGrace: number;

  brushes: Brush[];
  lighting: MapLighting;
  spawns: SpawnPoint[];
  objectives: ObjectiveDef[];
  navLinks: NavLink[];
  coverPoints: CoverPoint[];
  lanes: LaneDef[];

  /** Ambient soundscape parameters for the procedural audio engine. */
  ambience: {
    /** Reverb decay in seconds — tight for indoor maps, long for canyons. */
    reverbTime: number;
    /** Wet/dry mix, 0..1. */
    reverbMix: number;
    /** Wind intensity, 0..1. */
    wind: number;
    /** Background loop character. */
    mood: 'urban' | 'desert' | 'industrial' | 'forest' | 'arctic' | 'interior';
  };

  /** Which modes this map supports. Empty = all modes. */
  supportedModes?: string[];
}

// ---------------------------------------------------------------------------
// Authoring helpers
//
// These exist so map files read as a readable description of a place rather than
// a wall of object literals.
// ---------------------------------------------------------------------------

export function box(
  position: Vec3,
  size: Vec3,
  surface: SurfaceType,
  extra: Partial<Omit<BoxBrush, 'kind' | 'position' | 'size' | 'surface'>> = {},
): BoxBrush {
  return { kind: BrushKind.Box, position, size, surface, ...extra };
}

export function ramp(
  position: Vec3,
  size: Vec3,
  rise: RampBrush['rise'],
  surface: SurfaceType,
  extra: Partial<Omit<RampBrush, 'kind' | 'position' | 'size' | 'surface' | 'rise'>> = {},
): RampBrush {
  return { kind: BrushKind.Ramp, position, size, rise, surface, ...extra };
}

export function cylinder(
  position: Vec3,
  radius: number,
  height: number,
  surface: SurfaceType,
  extra: Partial<Omit<CylinderBrush, 'kind' | 'position' | 'radius' | 'height' | 'surface'>> = {},
): CylinderBrush {
  return { kind: BrushKind.Cylinder, position, radius, height, surface, ...extra };
}

/** A hollow room: floor, ceiling and four walls with optional door gaps. */
export function room(
  center: Vec3,
  size: Vec3,
  surface: SurfaceType,
  opts: {
    wallThickness?: number;
    floor?: boolean;
    ceiling?: boolean;
    /** Which walls to omit entirely, creating open sides. */
    openSides?: Array<'+x' | '-x' | '+z' | '-z'>;
    floorSurface?: SurfaceType;
  } = {},
): Brush[] {
  const t = opts.wallThickness ?? 0.3;
  const open = new Set(opts.openSides ?? []);
  const out: Brush[] = [];
  const hx = size.x / 2;
  const hy = size.y / 2;
  const hz = size.z / 2;

  if (opts.floor !== false) {
    out.push(
      box(
        { x: center.x, y: center.y - hy - t / 2, z: center.z },
        { x: size.x + t * 2, y: t, z: size.z + t * 2 },
        opts.floorSurface ?? surface,
      ),
    );
  }
  if (opts.ceiling !== false) {
    out.push(
      box(
        { x: center.x, y: center.y + hy + t / 2, z: center.z },
        { x: size.x + t * 2, y: t, z: size.z + t * 2 },
        surface,
      ),
    );
  }
  if (!open.has('-x')) {
    out.push(
      box({ x: center.x - hx - t / 2, y: center.y, z: center.z }, { x: t, y: size.y, z: size.z }, surface),
    );
  }
  if (!open.has('+x')) {
    out.push(
      box({ x: center.x + hx + t / 2, y: center.y, z: center.z }, { x: t, y: size.y, z: size.z }, surface),
    );
  }
  if (!open.has('-z')) {
    out.push(
      box({ x: center.x, y: center.y, z: center.z - hz - t / 2 }, { x: size.x + t * 2, y: size.y, z: t }, surface),
    );
  }
  if (!open.has('+z')) {
    out.push(
      box({ x: center.x, y: center.y, z: center.z + hz + t / 2 }, { x: size.x + t * 2, y: size.y, z: t }, surface),
    );
  }
  return out;
}

/** A wall with a doorway punched through it, built from three boxes. */
export function wallWithDoor(
  center: Vec3,
  size: Vec3,
  surface: SurfaceType,
  door: { offset: number; width: number; height: number },
): Brush[] {
  const horizontal = size.x >= size.z;
  const span = horizontal ? size.x : size.z;
  const half = span / 2;
  const doorHalf = door.width / 2;
  const leftEdge = door.offset - doorHalf;
  const rightEdge = door.offset + doorHalf;

  const out: Brush[] = [];
  const mk = (offset: number, length: number, height: number, yCenter: number): void => {
    if (length <= 0.01) return;
    out.push(
      box(
        {
          x: center.x + (horizontal ? offset : 0),
          y: yCenter,
          z: center.z + (horizontal ? 0 : offset),
        },
        horizontal ? { x: length, y: height, z: size.z } : { x: size.x, y: height, z: length },
        surface,
      ),
    );
  };

  const bottom = center.y - size.y / 2;
  // Left segment
  mk((-half + leftEdge) / 2, leftEdge - -half, size.y, center.y);
  // Right segment
  mk((rightEdge + half) / 2, half - rightEdge, size.y, center.y);
  // Header above the doorway
  const headerHeight = size.y - door.height;
  if (headerHeight > 0.01) {
    mk(door.offset, door.width, headerHeight, bottom + door.height + headerHeight / 2);
  }
  return out;
}
