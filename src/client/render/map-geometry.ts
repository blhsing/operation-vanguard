/**
 * Brush -> renderable geometry.
 *
 * The single most important thing this file does is *batch*. A map is authored
 * as a few hundred convex brushes; emitting one Mesh per brush would mean one
 * draw call per brush plus a full material bind, and the frame cost of that
 * dwarfs the cost of the triangles themselves. Instead brushes are bucketed by
 * everything that would force a separate material or mesh state, and each bucket
 * is welded into a single BufferGeometry.
 *
 * The trade-off is deliberate: merged meshes cannot be frustum-culled per brush.
 * For arena-scale maps (tens of metres, always mostly on screen) that is a clear
 * win; it would not be for an open world.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BrushKind } from '@shared/map/map-types.js';
import type {
  BoxBrush,
  Brush,
  CylinderBrush,
  MapDef,
  PlaneBrush,
  RampBrush,
} from '@shared/map/map-types.js';
import type { SurfaceType } from '@shared/types.js';
import {
  SURFACE_COLORS,
  SURFACE_METALNESS,
  SURFACE_ROUGHNESS,
} from '@shared/collision/collision-types.js';
import { surfaceMaterial } from './materials.js';

export interface MapGeometry {
  root: THREE.Group;
  /** Brushes that participate in collision — reported for parity checks against the collider. */
  colliderCount: number;
  triangleCount: number;
}

/**
 * World size of one texture repeat. Every UV is derived from face dimensions
 * divided by this, so a 2m crate and a 40m wall show bricks of the same size
 * instead of the wall smearing one brick across its whole face.
 */
const METRES_PER_TILE = 2;

const DEFAULT_CYLINDER_SEGMENTS = 12;

type Vec2 = [number, number];
type Vec3T = [number, number, number];

// ---------------------------------------------------------------------------
// Primitive builders. Each returns geometry in *brush-local* space with UVs
// already scaled to world units; the caller applies yaw and translation.
// ---------------------------------------------------------------------------

/**
 * BoxGeometry emits 24 vertices in a fixed face order (+x, -x, +y, -y, +z, -z),
 * four per face, each face UV-mapped 0..1. Rewriting those unit UVs per face is
 * what keeps tiling square on non-cubic boxes.
 */
function boxGeometry(size: THREE.Vector3Like, uvScale: number): THREE.BufferGeometry {
  const geom = new THREE.BoxGeometry(size.x, size.y, size.z);
  const uv = geom.attributes.uv as THREE.BufferAttribute;
  const spans: Vec2[] = [
    [size.z, size.y],
    [size.z, size.y],
    [size.x, size.z],
    [size.x, size.z],
    [size.x, size.y],
    [size.x, size.y],
  ];
  for (let face = 0; face < 6; face++) {
    const span = spans[face];
    const su = span[0] * uvScale;
    const sv = span[1] * uvScale;
    for (let v = 0; v < 4; v++) {
      const i = face * 4 + v;
      uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
    }
  }
  uv.needsUpdate = true;
  return geom;
}

/**
 * A real sloped prism, not a rotated box: bottom quad, sloped top quad, vertical
 * back wall and two triangular sides. Rotated boxes leave a wedge of solid
 * geometry hanging under the ramp and a visible lip at the low end, which reads
 * as a bug the moment a player walks up it.
 *
 * Built rising toward +x; other directions are produced by yawing the result.
 */
function rampGeometry(w: number, h: number, d: number, uvScale: number): THREE.BufferGeometry {
  const hw = w / 2;
  const hh = h / 2;
  const hd = d / 2;

  const pos: number[] = [];
  const nor: number[] = [];
  const uvs: number[] = [];

  const tri = (a: Vec3T, b: Vec3T, c: Vec3T, n: Vec3T, ua: Vec2, ub: Vec2, uc: Vec2): void => {
    pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    nor.push(n[0], n[1], n[2], n[0], n[1], n[2], n[0], n[1], n[2]);
    uvs.push(ua[0], ua[1], ub[0], ub[1], uc[0], uc[1]);
  };
  const quad = (
    a: Vec3T,
    b: Vec3T,
    c: Vec3T,
    e: Vec3T,
    n: Vec3T,
    ua: Vec2,
    ub: Vec2,
    uc: Vec2,
    ue: Vec2,
  ): void => {
    tri(a, b, c, n, ua, ub, uc);
    tri(a, c, e, n, ua, uc, ue);
  };

  // Cross-section in XY: A (low, -x) -> B (high end, bottom) -> C (high end, top).
  const A0: Vec3T = [-hw, -hh, -hd];
  const B0: Vec3T = [hw, -hh, -hd];
  const C0: Vec3T = [hw, hh, -hd];
  const A1: Vec3T = [-hw, -hh, hd];
  const B1: Vec3T = [hw, -hh, hd];
  const C1: Vec3T = [hw, hh, hd];

  const su = w * uvScale;
  const sv = h * uvScale;
  const sd = d * uvScale;
  const hyp = Math.hypot(w, h) * uvScale;

  // Bottom (-Y)
  quad(A0, B0, B1, A1, [0, -1, 0], [0, 0], [su, 0], [su, sd], [0, sd]);

  // Slope (+Y, tilted back toward the low end)
  const slopeLen = Math.hypot(w, h) || 1;
  const slopeN: Vec3T = [-h / slopeLen, w / slopeLen, 0];
  quad(A0, A1, C1, C0, slopeN, [0, 0], [sd, 0], [sd, hyp], [0, hyp]);

  // Vertical back wall at the high end (+X)
  quad(B0, C0, C1, B1, [1, 0, 0], [0, 0], [0, sv], [sd, sv], [sd, 0]);

  // Triangular sides
  tri(A0, C0, B0, [0, 0, -1], [0, 0], [su, sv], [su, 0]);
  tri(A1, B1, C1, [0, 0, 1], [0, 0], [su, 0], [su, sv]);

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return geom;
}

/** Yaw that maps the +x-rising ramp onto the requested rise direction. */
function rampYaw(rise: RampBrush['rise']): number {
  switch (rise) {
    case '+x':
      return 0;
    case '-z':
      return Math.PI / 2;
    case '-x':
      return Math.PI;
    case '+z':
      return -Math.PI / 2;
  }
}

function cylinderGeometry(brush: CylinderBrush, uvScale: number): THREE.BufferGeometry {
  const segments = Math.max(3, brush.segments ?? DEFAULT_CYLINDER_SEGMENTS);
  const geom = new THREE.CylinderGeometry(brush.radius, brush.radius, brush.height, segments);
  const uv = geom.attributes.uv as THREE.BufferAttribute;
  const normal = geom.attributes.normal as THREE.BufferAttribute;

  const wrapU = 2 * Math.PI * brush.radius * uvScale;
  const wrapV = brush.height * uvScale;
  const capSpan = 2 * brush.radius * uvScale;

  for (let i = 0; i < uv.count; i++) {
    // Cap vertices point straight up or down; side vertices are horizontal.
    if (Math.abs(normal.getY(i)) > 0.5) {
      uv.setXY(i, 0.5 + (uv.getX(i) - 0.5) * capSpan, 0.5 + (uv.getY(i) - 0.5) * capSpan);
    } else {
      uv.setXY(i, uv.getX(i) * wrapU, uv.getY(i) * wrapV);
    }
  }
  uv.needsUpdate = true;
  return geom;
}

function planeGeometry(brush: PlaneBrush, uvScale: number): THREE.BufferGeometry {
  const { x, y, z } = brush.size;
  let a: number;
  let b: number;
  switch (brush.facing) {
    case '+y':
    case '-y':
      a = x;
      b = z;
      break;
    case '+x':
    case '-x':
      a = z;
      b = y;
      break;
    default:
      a = x;
      b = y;
      break;
  }

  const geom = new THREE.PlaneGeometry(a, b);
  const uv = geom.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * a * uvScale, uv.getY(i) * b * uvScale);
  }
  uv.needsUpdate = true;

  // PlaneGeometry faces +Z; rotate it onto the requested axis.
  switch (brush.facing) {
    case '+x':
      geom.rotateY(Math.PI / 2);
      break;
    case '-x':
      geom.rotateY(-Math.PI / 2);
      break;
    case '+y':
      geom.rotateX(-Math.PI / 2);
      break;
    case '-y':
      geom.rotateX(Math.PI / 2);
      break;
    case '-z':
      geom.rotateY(Math.PI);
      break;
    case '+z':
      break;
  }
  return geom;
}

// ---------------------------------------------------------------------------
// Brush dispatch
// ---------------------------------------------------------------------------

function hasVolume(size: THREE.Vector3Like): boolean {
  return size.x > 1e-4 && size.y > 1e-4 && size.z > 1e-4;
}

/** Returns world-space geometry for a brush, or null if it is degenerate. */
function brushGeometry(brush: Brush): THREE.BufferGeometry | null {
  const uvScale = (brush.textureScale ?? 1) / METRES_PER_TILE;
  let geom: THREE.BufferGeometry | null = null;
  let extraYaw = 0;

  switch (brush.kind) {
    case BrushKind.Box: {
      const b = brush as BoxBrush;
      if (!hasVolume(b.size)) return null;
      geom = boxGeometry(b.size, uvScale);
      break;
    }
    case BrushKind.Ramp: {
      const b = brush as RampBrush;
      if (!hasVolume(b.size)) return null;
      // The ramp is authored rising along +x, so when it is yawed onto the z axis
      // its local width/depth swap to keep the world footprint equal to `size`.
      const alongZ = b.rise === '+z' || b.rise === '-z';
      const w = alongZ ? b.size.z : b.size.x;
      const d = alongZ ? b.size.x : b.size.z;
      geom = rampGeometry(w, b.size.y, d, uvScale);
      extraYaw = rampYaw(b.rise);
      break;
    }
    case BrushKind.Cylinder: {
      const b = brush as CylinderBrush;
      if (b.radius <= 1e-4 || b.height <= 1e-4) return null;
      geom = cylinderGeometry(b, uvScale);
      break;
    }
    case BrushKind.Plane: {
      const b = brush as PlaneBrush;
      geom = planeGeometry(b, uvScale);
      break;
    }
  }

  if (!geom) return null;

  // Bake the transform into the vertices — merged batches have no per-brush node
  // to carry a matrix.
  const yaw = (brush.yaw ?? 0) + extraYaw;
  if (yaw !== 0) geom.rotateY(yaw);
  geom.translate(brush.position.x, brush.position.y, brush.position.z);

  // mergeGeometries refuses to mix indexed and non-indexed inputs, and the ramp
  // is authored non-indexed, so normalise everything to non-indexed.
  if (geom.index) {
    const flat = geom.toNonIndexed();
    geom.dispose();
    geom = flat;
  }

  applyVertexColor(geom, brush.color ?? SURFACE_COLORS[brush.surface], brush.surface);
  return geom;
}

/**
 * Bake the brush tint into a vertex attribute.
 *
 * Map authors override `color` on many brushes — crossfire alone uses 40
 * distinct tints — and colour on the material would mean 40 materials and 40
 * draw calls. As a vertex attribute it costs 12 bytes per vertex and collapses
 * every tint of a given surface into one batch.
 *
 * setHex with SRGBColorSpace converts to the linear working space, matching what
 * `Material.color` does internally; skipping that step washes the map out.
 */
const scratchColor = new THREE.Color();
const scratchBase = new THREE.Color();

/**
 * Write the per-brush tint as a vertex colour.
 *
 * The value stored is a RATIO against the surface's own colour, not the colour
 * itself. The procedural surface texture already paints concrete concrete-grey
 * and brick brick-red, and the shader multiplies map x vertexColor x
 * material.color — so writing the absolute colour here multiplied the surface
 * albedo by itself and dropped the whole map to roughly a fifth of its intended
 * brightness. Every untinted brush now stores exactly white and comes through
 * the shader unchanged; a brush that overrides `color` shifts its surface toward
 * that colour.
 *
 * The division is done in linear space, which is where the shader multiplies.
 */
function applyVertexColor(geom: THREE.BufferGeometry, hex: number, surface: SurfaceType): void {
  scratchColor.setHex(hex, THREE.SRGBColorSpace);
  scratchBase.setHex(SURFACE_COLORS[surface], THREE.SRGBColorSpace);

  // Guard against a black base surface, and cap the ratio so an extreme override
  // can brighten a surface without blowing it out.
  const ratio = (tint: number, base: number): number =>
    Math.min(4, base > 1e-4 ? tint / base : 1);

  const r = ratio(scratchColor.r, scratchBase.r);
  const g = ratio(scratchColor.g, scratchBase.g);
  const b = ratio(scratchColor.b, scratchBase.b);

  const count = geom.getAttribute('position').count;
  const data = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    data[i * 3] = r;
    data[i * 3 + 1] = g;
    data[i * 3 + 2] = b;
  }
  geom.setAttribute('color', new THREE.BufferAttribute(data, 3));
}

// ---------------------------------------------------------------------------
// Batching
// ---------------------------------------------------------------------------

interface Batch {
  brush: Brush;
  castShadow: boolean;
  geometries: THREE.BufferGeometry[];
}

/**
 * Everything that forces a distinct material or a distinct mesh flag.
 *
 * Two authored properties are deliberately *absent*:
 *
 * - `textureScale`, because tiling is baked into the UVs above. (map-types
 *   documents it as "repeats across the face"; world-consistent tiling reads
 *   far better in game, so it is applied as a multiplier on top of the
 *   world-scale derivation rather than as a literal face count.)
 * - `color`, because it is baked into vertex colours — except on emissive
 *   brushes, where the tint also drives the glow and so must stay on the
 *   material.
 */
function batchKey(brush: Brush, castShadow: boolean): string {
  const roughness = brush.roughness ?? SURFACE_ROUGHNESS[brush.surface];
  const metalness = brush.metalness ?? SURFACE_METALNESS[brush.surface];
  const emissive = brush.emissive ?? 0;
  const emissiveTint = emissive > 0 ? (brush.color ?? SURFACE_COLORS[brush.surface]) : 0;
  return `${brush.surface}|${roughness}|${metalness}|${emissive}|${emissiveTint}|${castShadow ? 1 : 0}`;
}

export function buildMapGeometry(map: MapDef): MapGeometry {
  const root = new THREE.Group();
  root.name = `map:${map.id}`;

  const batches = new Map<string, Batch>();
  let colliderCount = 0;

  for (const brush of map.brushes) {
    // Clip brushes are invisible but still collide, and planes never collide.
    if (brush.solid !== false && brush.kind !== BrushKind.Plane) colliderCount++;
    if (brush.visible === false) continue;

    const geom = brushGeometry(brush);
    if (!geom) continue;

    const castShadow = brush.castShadow !== false;
    const key = batchKey(brush, castShadow);
    let batch = batches.get(key);
    if (!batch) {
      batch = { brush, castShadow, geometries: [] };
      batches.set(key, batch);
    }
    batch.geometries.push(geom);
  }

  let triangleCount = 0;
  for (const [key, batch] of batches) {
    const merged = mergeGeometries(batch.geometries, false) as THREE.BufferGeometry | null;
    for (const g of batch.geometries) g.dispose();
    if (!merged) continue;

    merged.computeBoundingSphere();
    merged.computeBoundingBox();

    const { brush } = batch;
    const emissive = brush.emissive ?? 0;
    const material = surfaceMaterial(brush.surface, {
      // Albedo comes from the vertex attribute; this only tints the glow.
      color: emissive > 0 ? (brush.color ?? SURFACE_COLORS[brush.surface]) : 0xffffff,
      roughness: brush.roughness ?? SURFACE_ROUGHNESS[brush.surface],
      metalness: brush.metalness ?? SURFACE_METALNESS[brush.surface],
      emissive,
      vertexColors: true,
    });

    const mesh = new THREE.Mesh(merged, material);
    mesh.name = `batch:${key}`;
    mesh.castShadow = batch.castShadow;
    mesh.receiveShadow = true;
    // Static level geometry never moves; skip the per-frame matrix update.
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    root.add(mesh);

    triangleCount += merged.attributes.position.count / 3;
  }

  return { root, colliderCount, triangleCount };
}

/**
 * Releases merged geometry. Materials are shared through the material cache and
 * are freed by `disposeMaterialCache()` instead — disposing them here would rip
 * shaders out from under every other consumer.
 */
export function disposeMapGeometry(g: MapGeometry): void {
  g.root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) obj.geometry.dispose();
  });
  g.root.clear();
}
