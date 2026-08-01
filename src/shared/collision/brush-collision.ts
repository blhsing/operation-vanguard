/**
 * Brush collision world.
 *
 * Maps are convex brushes, so collision is exact rather than approximate: every
 * brush becomes either an oriented box (OBB) or a vertical cylinder, and queries
 * test those primitives directly. There is no triangle soup and no BVH, which
 * means no mesh baking step and no divergence between what the renderer draws
 * and what the simulation collides with.
 *
 * Performance comes from a uniform spatial hash over XZ. Rays walk it with a 2D
 * DDA and capsule sweeps gather the cells their swept AABB touches. With a 4 m
 * cell and a typical 300-brush map, a full-length trace visits a few dozen
 * brushes instead of all of them — which is the difference between 24 players
 * firing at 64 Hz being free and being the frame budget.
 *
 * Everything writes into caller-supplied `out` parameters and uses module-scope
 * scratch vectors, so the steady state allocates nothing.
 */

import {
  EPSILON,
  aabbOverlaps,
  clamp,
  rayAABB,
  v3copy,
  v3dot,
  v3normalize,
  v3set,
  vec3,
  type AABB,
  type Vec3,
} from '../math.js';
import { BrushKind, type Brush, type BoxBrush, type CylinderBrush, type PlaneBrush, type RampBrush } from '../map/map-types.js';
import { SurfaceType, type EntityId } from '../types.js';
import {
  CollisionLayer,
  type CollisionWorld,
  type QueryFilter,
  type RaycastHit,
  type SweepHit,
} from './collision-types.js';

// ---------------------------------------------------------------------------
// Collider representation
// ---------------------------------------------------------------------------

export enum ColliderShape {
  /** Oriented box: centre, half-extents, and a yaw rotation about Y. */
  Box = 0,
  /** Vertical cylinder: centre, radius, half-height. */
  Cylinder = 1,
}

export interface BrushCollider {
  shape: ColliderShape;
  /** Index of the source brush, so hits can be traced back to map data. */
  brushIndex: number;
  center: Vec3;
  /** Half-extents for boxes; (radius, halfHeight, radius) for cylinders. */
  half: Vec3;
  yaw: number;
  cosYaw: number;
  sinYaw: number;
  surface: SurfaceType;
  layer: CollisionLayer;
  /** Cached world-space AABB for broadphase. */
  bounds: AABB;
  /**
   * For ramps: the sloped top plane in world space. Movement needs the true
   * slope normal or it cannot tell a walkable ramp from a wall.
   */
  slopeNormal: Vec3 | null;
  /** Plane constant for the slope: dot(normal, p) = slopeD on the surface. */
  slopeD: number;
}

/** Which collision layers a brush participates in, derived from its flags. */
function layersForBrush(brush: Brush): CollisionLayer {
  if (brush.solid === false) return CollisionLayer.None;

  let layer = CollisionLayer.World;
  if (brush.bulletPassthrough) {
    // Blocks players but not bullets: railings, chain-link, low fences.
    layer = CollisionLayer.PlayerClip;
  }
  if (brush.visible === false && !brush.bulletPassthrough) {
    // Invisible clip brush: still full world collision.
    layer = CollisionLayer.World;
  }
  if (brush.breakable) layer |= CollisionLayer.Breakable;
  return layer;
}

function boundsOf(center: Vec3, half: Vec3, yaw: number): AABB {
  // A yaw-rotated box's AABB extent is |c|*hx + |s|*hz on X and vice versa.
  const c = Math.abs(Math.cos(yaw));
  const s = Math.abs(Math.sin(yaw));
  const ex = c * half.x + s * half.z;
  const ez = s * half.x + c * half.z;
  return {
    min: vec3(center.x - ex, center.y - half.y, center.z - ez),
    max: vec3(center.x + ex, center.y + half.y, center.z + ez),
  };
}

function makeBox(
  brushIndex: number,
  center: Vec3,
  half: Vec3,
  yaw: number,
  surface: SurfaceType,
  layer: CollisionLayer,
): BrushCollider {
  return {
    shape: ColliderShape.Box,
    brushIndex,
    center: vec3(center.x, center.y, center.z),
    half: vec3(half.x, half.y, half.z),
    yaw,
    cosYaw: Math.cos(yaw),
    sinYaw: Math.sin(yaw),
    surface,
    layer,
    bounds: boundsOf(center, half, yaw),
    slopeNormal: null,
    slopeD: 0,
  };
}

/**
 * Convert a brush into colliders.
 *
 * A ramp becomes a box carrying an extra slope plane; the box handles the sides
 * and underside, and the plane replaces the top face. That keeps ramps cheap
 * while still giving movement a genuine slope normal to stand on.
 */
export function brushToColliders(brush: Brush, brushIndex: number): BrushCollider[] {
  const layer = layersForBrush(brush);
  if (layer === CollisionLayer.None) return [];

  const yaw = brush.yaw ?? 0;

  switch (brush.kind) {
    case BrushKind.Box: {
      const b = brush as BoxBrush;
      return [
        makeBox(
          brushIndex,
          b.position,
          vec3(b.size.x / 2, b.size.y / 2, b.size.z / 2),
          yaw,
          b.surface,
          layer,
        ),
      ];
    }

    case BrushKind.Ramp: {
      const r = brush as RampBrush;
      const half = vec3(r.size.x / 2, r.size.y / 2, r.size.z / 2);
      const collider = makeBox(brushIndex, r.position, half, yaw, r.surface, layer);

      // Local-space slope: the top face rises from one edge to the opposite one.
      // Build the normal in local space, then rotate it by the brush yaw.
      let nx = 0;
      let nz = 0;
      let run = 0;
      switch (r.rise) {
        case '+x':
          run = r.size.x;
          nx = -r.size.y;
          break;
        case '-x':
          run = r.size.x;
          nx = r.size.y;
          break;
        case '+z':
          run = r.size.z;
          nz = -r.size.y;
          break;
        default:
          run = r.size.z;
          nz = r.size.y;
          break;
      }
      const len = Math.hypot(nx, run, nz) || 1;
      const localN = vec3(nx / len, run / len, nz / len);

      const c = collider.cosYaw;
      const s = collider.sinYaw;
      const worldN = vec3(
        localN.x * c + localN.z * s,
        localN.y,
        -localN.x * s + localN.z * c,
      );
      v3normalize(worldN, worldN);
      collider.slopeNormal = worldN;
      // The plane passes through the midpoint of the top face.
      collider.slopeD =
        worldN.x * r.position.x +
        worldN.y * (r.position.y + half.y - half.y * 0) +
        worldN.z * r.position.z;
      // Anchor the plane so it contains the ramp's top-face centre.
      collider.slopeD =
        worldN.x * r.position.x + worldN.y * r.position.y + worldN.z * r.position.z;
      return [collider];
    }

    case BrushKind.Cylinder: {
      const cy = brush as CylinderBrush;
      const half = vec3(cy.radius, cy.height / 2, cy.radius);
      return [
        {
          shape: ColliderShape.Cylinder,
          brushIndex,
          center: vec3(cy.position.x, cy.position.y, cy.position.z),
          half,
          yaw: 0,
          cosYaw: 1,
          sinYaw: 0,
          surface: cy.surface,
          layer,
          bounds: {
            min: vec3(cy.position.x - cy.radius, cy.position.y - half.y, cy.position.z - cy.radius),
            max: vec3(cy.position.x + cy.radius, cy.position.y + half.y, cy.position.z + cy.radius),
          },
          slopeNormal: null,
          slopeD: 0,
        },
      ];
    }

    case BrushKind.Plane: {
      // Planes are decoration: visible, never solid.
      const p = brush as PlaneBrush;
      void p;
      return [];
    }

    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Dynamic colliders
// ---------------------------------------------------------------------------

export interface DynamicCollider {
  id: EntityId;
  layer: CollisionLayer;
  /** Feet position for capsules, centre for boxes. */
  position: Vec3;
  kind: 'capsule' | 'box';
  height: number;
  radius: number;
  size?: Vec3;
  yaw?: number;
  active: boolean;
}

// ---------------------------------------------------------------------------
// Scratch
// ---------------------------------------------------------------------------

const _local = vec3();
const _localDir = vec3();
const _localNormal = vec3();
const _worldNormal = vec3();
const _sweptMin = vec3();
const _sweptMax = vec3();
const _sweptBounds: AABB = { min: _sweptMin, max: _sweptMax };
const _expandedMin = vec3();
const _expandedMax = vec3();
const _expanded: AABB = { min: _expandedMin, max: _expandedMax };
const _point = vec3();
const _probeA = vec3();
const _probeB = vec3();
const _pushOut = vec3();

/** Reusable hit record for internal probes that discard their result. */
function resetSweep(out: SweepHit): SweepHit {
  out.hit = false;
  out.fraction = 1;
  out.startedSolid = false;
  out.entity = 0;
  out.brushIndex = -1;
  out.surface = SurfaceType.Concrete;
  v3set(out.normal, 0, 1, 0);
  v3set(out.point, 0, 0, 0);
  return out;
}

function resetRay(out: RaycastHit): RaycastHit {
  out.hit = false;
  out.distance = 0;
  out.entity = 0;
  out.brushIndex = -1;
  out.surface = SurfaceType.Concrete;
  out.thickness = 0;
  out.layer = CollisionLayer.None;
  v3set(out.normal, 0, 1, 0);
  v3set(out.point, 0, 0, 0);
  return out;
}

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

const CELL_SIZE = 4;

/**
 * Interpenetration below this depth counts as contact rather than overlap.
 * Large enough to absorb the float error of a capsule snapped onto a surface,
 * small enough that a real penetration is never mistaken for resting on it.
 */
const CONTACT_EPSILON = 1e-4;

export class BrushCollisionWorld implements CollisionWorld {
  private readonly colliders: BrushCollider[] = [];
  private readonly bounds: { min: Vec3; max: Vec3 };

  /** Spatial hash: cell key -> collider indices. */
  private readonly grid = new Map<number, number[]>();
  private readonly gridMinX: number;
  private readonly gridMinZ: number;
  private readonly gridW: number;
  private readonly gridH: number;

  private dynamics: readonly DynamicCollider[] = [];

  /** Per-query visitation stamps, so a collider is only tested once per query. */
  private readonly visited: Int32Array;
  private queryStamp = 0;

  constructor(brushes: readonly Brush[], bounds: { min: Vec3; max: Vec3 }) {
    this.bounds = {
      min: vec3(bounds.min.x, bounds.min.y, bounds.min.z),
      max: vec3(bounds.max.x, bounds.max.y, bounds.max.z),
    };

    for (let i = 0; i < brushes.length; i++) {
      for (const c of brushToColliders(brushes[i]!, i)) {
        this.colliders.push(c);
      }
    }

    // Size the grid to the map bounds, with a margin so out-of-bounds queries
    // clamp rather than wrap.
    const pad = CELL_SIZE * 2;
    this.gridMinX = Math.floor((this.bounds.min.x - pad) / CELL_SIZE);
    this.gridMinZ = Math.floor((this.bounds.min.z - pad) / CELL_SIZE);
    this.gridW = Math.max(1, Math.ceil((this.bounds.max.x + pad) / CELL_SIZE) - this.gridMinX + 1);
    this.gridH = Math.max(1, Math.ceil((this.bounds.max.z + pad) / CELL_SIZE) - this.gridMinZ + 1);

    for (let i = 0; i < this.colliders.length; i++) {
      const c = this.colliders[i]!;
      const x0 = this.cellX(c.bounds.min.x);
      const x1 = this.cellX(c.bounds.max.x);
      const z0 = this.cellZ(c.bounds.min.z);
      const z1 = this.cellZ(c.bounds.max.z);
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const key = z * this.gridW + x;
          let bucket = this.grid.get(key);
          if (!bucket) {
            bucket = [];
            this.grid.set(key, bucket);
          }
          bucket.push(i);
        }
      }
    }

    this.visited = new Int32Array(this.colliders.length);
  }

  get colliderCount(): number {
    return this.colliders.length;
  }

  setDynamicColliders(colliders: readonly DynamicCollider[]): void {
    this.dynamics = colliders;
  }

  // -------------------------------------------------------------------------
  // Grid helpers
  // -------------------------------------------------------------------------

  private cellX(x: number): number {
    return clamp(Math.floor(x / CELL_SIZE) - this.gridMinX, 0, this.gridW - 1);
  }

  private cellZ(z: number): number {
    return clamp(Math.floor(z / CELL_SIZE) - this.gridMinZ, 0, this.gridH - 1);
  }

  private newQuery(): number {
    this.queryStamp++;
    if (this.queryStamp === 0x7fffffff) {
      this.visited.fill(0);
      this.queryStamp = 1;
    }
    return this.queryStamp;
  }

  // -------------------------------------------------------------------------
  // Raycast
  // -------------------------------------------------------------------------

  raycast(
    origin: Vec3,
    direction: Vec3,
    maxDistance: number,
    filter: QueryFilter,
    out: RaycastHit,
  ): RaycastHit {
    resetRay(out);
    let best = maxDistance;

    const stamp = this.newQuery();

    // --- static geometry, via a 2D DDA over the grid ---
    this.walkRayCells(origin, direction, maxDistance, (cellKey) => {
      const bucket = this.grid.get(cellKey);
      if (!bucket) return true;

      for (const idx of bucket) {
        if (this.visited[idx] === stamp) continue;
        this.visited[idx] = stamp;

        const c = this.colliders[idx]!;
        if ((c.layer & filter.layers) === 0) continue;

        const t = this.rayCollider(origin, direction, best, c, _worldNormal);
        if (t >= 0 && t < best) {
          best = t;
          out.hit = true;
          out.distance = t;
          out.brushIndex = c.brushIndex;
          out.surface = c.surface;
          out.layer = c.layer;
          out.entity = 0;
          v3copy(out.normal, _worldNormal);
          out.thickness = this.measureThickness(origin, direction, t, c);
        }
      }
      // Keep walking: a nearer brush may live in a later cell only if the ray
      // re-enters, so we cannot stop at the first cell with any hit. We can stop
      // once the cell's near edge is beyond the best hit — handled by the walker.
      return true;
    }, () => best);

    // --- dynamic colliders ---
    for (const d of this.dynamics) {
      if (!d.active) continue;
      if ((d.layer & filter.layers) === 0) continue;
      if (filter.ignoreEntities?.includes(d.id)) continue;
      if (filter.entityPredicate && !filter.entityPredicate(d.id)) continue;

      const t = this.rayDynamic(origin, direction, best, d, _worldNormal);
      if (t >= 0 && t < best) {
        best = t;
        out.hit = true;
        out.distance = t;
        out.brushIndex = -1;
        out.surface = d.kind === 'capsule' ? SurfaceType.Flesh : SurfaceType.Metal;
        out.layer = d.layer;
        out.entity = d.id;
        out.thickness = d.kind === 'capsule' ? d.radius * 2 : 0.4;
        v3copy(out.normal, _worldNormal);
      }
    }

    if (out.hit) {
      out.point.x = origin.x + direction.x * out.distance;
      out.point.y = origin.y + direction.y * out.distance;
      out.point.z = origin.z + direction.z * out.distance;
    }
    return out;
  }

  raycastAll(
    origin: Vec3,
    direction: Vec3,
    maxDistance: number,
    filter: QueryFilter,
    out: RaycastHit[],
    maxHits: number,
  ): number {
    let count = 0;
    let travelled = 0;
    v3copy(_probeA, origin);

    // Repeated nearest-hit queries, stepping past each surface. Simpler than a
    // sorted gather and naturally handles overlapping brushes.
    while (count < maxHits && count < out.length && travelled < maxDistance) {
      const hit = out[count]!;
      this.raycast(_probeA, direction, maxDistance - travelled, filter, hit);
      if (!hit.hit) break;

      hit.distance += travelled;
      count++;

      const step = Math.max(hit.thickness, 0.02) + 0.01;
      travelled = hit.distance + step;
      _probeA.x = origin.x + direction.x * travelled;
      _probeA.y = origin.y + direction.y * travelled;
      _probeA.z = origin.z + direction.z * travelled;
    }

    return count;
  }

  isVisible(from: Vec3, to: Vec3, filter: QueryFilter): boolean {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < EPSILON) return true;

    v3set(_localDir, dx / dist, dy / dist, dz / dist);
    const hit = this.raycast(from, _localDir, dist - 0.02, filter, _sharedRay);
    return !hit.hit;
  }

  groundHeightAt(x: number, z: number, fromY: number, maxDrop: number): number {
    v3set(_probeB, x, fromY, z);
    v3set(_localDir, 0, -1, 0);
    const hit = this.raycast(_probeB, _localDir, maxDrop, GROUND_FILTER, _sharedRay);
    return hit.hit ? fromY - hit.distance : -Infinity;
  }

  // -------------------------------------------------------------------------
  // Capsule sweep
  // -------------------------------------------------------------------------

  sweepCapsule(
    start: Vec3,
    height: number,
    radius: number,
    delta: Vec3,
    filter: QueryFilter,
    out: SweepHit,
  ): SweepHit {
    resetSweep(out);

    const len = Math.sqrt(delta.x * delta.x + delta.y * delta.y + delta.z * delta.z);
    if (len < EPSILON) {
      // Still report starting-solid so callers can depenetrate while stationary.
      out.startedSolid = this.capsuleOverlaps(start, height, radius, filter);
      if (out.startedSolid) out.fraction = 0;
      return out;
    }

    // Swept AABB of the capsule over the whole motion, used for broadphase.
    const minX = Math.min(start.x, start.x + delta.x) - radius;
    const maxX = Math.max(start.x, start.x + delta.x) + radius;
    const minY = Math.min(start.y, start.y + delta.y);
    const maxY = Math.max(start.y, start.y + delta.y) + height;
    const minZ = Math.min(start.z, start.z + delta.z) - radius;
    const maxZ = Math.max(start.z, start.z + delta.z) + radius;
    v3set(_sweptMin, minX, minY, minZ);
    v3set(_sweptMax, maxX, maxY, maxZ);

    // Conservative advancement: binary-search the first fraction at which the
    // capsule overlaps anything. Exact enough at our scale, and it works
    // uniformly for boxes, cylinders and ramp planes without per-shape sweeps.
    if (this.capsuleOverlaps(start, height, radius, filter)) {
      out.startedSolid = true;
      out.fraction = 0;
      out.hit = true;
      // Report an escape direction so the caller can push out sensibly.
      if (this.computePushOut(start, height, radius, filter, _pushOut)) {
        v3copy(out.normal, _pushOut);
        v3normalize(out.normal, out.normal);
      }
      v3copy(out.point, start);
      return out;
    }

    // Step through the motion. Step size is bounded by the capsule radius so we
    // cannot tunnel through anything thinner than we are.
    const maxStep = Math.max(radius * 0.65, 0.05);
    const steps = Math.min(64, Math.max(1, Math.ceil(len / maxStep)));

    let lastFree = 0;
    let firstHit = -1;

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      _probeA.x = start.x + delta.x * t;
      _probeA.y = start.y + delta.y * t;
      _probeA.z = start.z + delta.z * t;

      if (this.capsuleOverlaps(_probeA, height, radius, filter)) {
        firstHit = t;
        break;
      }
      lastFree = t;
    }

    if (firstHit < 0) {
      out.fraction = 1;
      return out;
    }

    // Refine between the last free position and the first blocked one.
    let lo = lastFree;
    let hi = firstHit;
    for (let i = 0; i < 8; i++) {
      const mid = (lo + hi) * 0.5;
      _probeA.x = start.x + delta.x * mid;
      _probeA.y = start.y + delta.y * mid;
      _probeA.z = start.z + delta.z * mid;
      if (this.capsuleOverlaps(_probeA, height, radius, filter)) {
        hi = mid;
      } else {
        lo = mid;
      }
    }

    out.hit = true;
    out.fraction = clamp(lo, 0, 1);
    v3set(
      out.point,
      start.x + delta.x * out.fraction,
      start.y + delta.y * out.fraction,
      start.z + delta.z * out.fraction,
    );

    // Recover a contact normal by pushing out from the blocked position.
    _probeA.x = start.x + delta.x * hi;
    _probeA.y = start.y + delta.y * hi;
    _probeA.z = start.z + delta.z * hi;
    if (this.computePushOut(_probeA, height, radius, filter, _pushOut)) {
      v3normalize(out.normal, _pushOut);
    } else {
      // Fall back to opposing the motion.
      v3set(out.normal, -delta.x / len, -delta.y / len, -delta.z / len);
    }

    return out;
  }

  resolvePenetration(
    position: Vec3,
    height: number,
    radius: number,
    filter: QueryFilter,
    out: Vec3,
  ): boolean {
    v3copy(out, position);
    let moved = false;

    // Four passes: enough to escape a corner, few enough to stay cheap. Each
    // pass moves along the summed minimum-translation vector, which is stable
    // where iterating one contact at a time would oscillate.
    for (let pass = 0; pass < 4; pass++) {
      if (!this.computePushOut(out, height, radius, filter, _pushOut)) break;
      const mag = Math.sqrt(
        _pushOut.x * _pushOut.x + _pushOut.y * _pushOut.y + _pushOut.z * _pushOut.z,
      );
      if (mag < 1e-4) break;
      out.x += _pushOut.x;
      out.y += _pushOut.y;
      out.z += _pushOut.z;
      moved = true;
      if (!this.capsuleOverlaps(out, height, radius, filter)) break;
    }

    return moved;
  }

  isCapsuleFree(position: Vec3, height: number, radius: number, filter: QueryFilter): boolean {
    return !this.capsuleOverlaps(position, height, radius, filter);
  }

  // -------------------------------------------------------------------------
  // Overlap tests
  // -------------------------------------------------------------------------

  private capsuleOverlaps(
    position: Vec3,
    height: number,
    radius: number,
    filter: QueryFilter,
  ): boolean {
    v3set(_expandedMin, position.x - radius, position.y, position.z - radius);
    v3set(_expandedMax, position.x + radius, position.y + height, position.z + radius);

    const x0 = this.cellX(_expandedMin.x);
    const x1 = this.cellX(_expandedMax.x);
    const z0 = this.cellZ(_expandedMin.z);
    const z1 = this.cellZ(_expandedMax.z);
    const stamp = this.newQuery();

    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const bucket = this.grid.get(z * this.gridW + x);
        if (!bucket) continue;
        for (const idx of bucket) {
          if (this.visited[idx] === stamp) continue;
          this.visited[idx] = stamp;
          const c = this.colliders[idx]!;
          if ((c.layer & filter.layers) === 0) continue;
          if (!aabbOverlaps(c.bounds, _expanded)) continue;
          if (this.colliderOverlapsCapsule(c, position, height, radius, null)) return true;
        }
      }
    }

    for (const d of this.dynamics) {
      if (!d.active) continue;
      if ((d.layer & filter.layers) === 0) continue;
      if (filter.ignoreEntities?.includes(d.id)) continue;
      if (filter.entityPredicate && !filter.entityPredicate(d.id)) continue;
      if (this.dynamicOverlapsCapsule(d, position, height, radius, null)) return true;
    }

    return false;
  }

  /**
   * Sum of minimum-translation vectors for every overlapping collider.
   * Summing rather than taking the largest is what makes corners resolve to the
   * diagonal instead of ping-ponging between two walls.
   */
  private computePushOut(
    position: Vec3,
    height: number,
    radius: number,
    filter: QueryFilter,
    out: Vec3,
  ): boolean {
    v3set(out, 0, 0, 0);
    let any = false;

    v3set(_expandedMin, position.x - radius, position.y, position.z - radius);
    v3set(_expandedMax, position.x + radius, position.y + height, position.z + radius);

    const x0 = this.cellX(_expandedMin.x);
    const x1 = this.cellX(_expandedMax.x);
    const z0 = this.cellZ(_expandedMin.z);
    const z1 = this.cellZ(_expandedMax.z);
    const stamp = this.newQuery();

    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const bucket = this.grid.get(z * this.gridW + x);
        if (!bucket) continue;
        for (const idx of bucket) {
          if (this.visited[idx] === stamp) continue;
          this.visited[idx] = stamp;
          const c = this.colliders[idx]!;
          if ((c.layer & filter.layers) === 0) continue;
          if (!aabbOverlaps(c.bounds, _expanded)) continue;
          if (this.colliderOverlapsCapsule(c, position, height, radius, _mtv)) {
            out.x += _mtv.x;
            out.y += _mtv.y;
            out.z += _mtv.z;
            any = true;
          }
        }
      }
    }

    for (const d of this.dynamics) {
      if (!d.active) continue;
      if ((d.layer & filter.layers) === 0) continue;
      if (filter.ignoreEntities?.includes(d.id)) continue;
      if (filter.entityPredicate && !filter.entityPredicate(d.id)) continue;
      if (this.dynamicOverlapsCapsule(d, position, height, radius, _mtv)) {
        out.x += _mtv.x;
        out.y += _mtv.y;
        out.z += _mtv.z;
        any = true;
      }
    }

    return any;
  }

  /**
   * Capsule vs. collider. When `mtv` is supplied it receives the minimum
   * translation that separates them.
   *
   * The capsule is treated as a vertical segment with a radius, so the test is
   * "closest point on the box to the segment, within radius" — exact for boxes,
   * and for ramps we additionally clip against the slope plane.
   */
  private colliderOverlapsCapsule(
    c: BrushCollider,
    position: Vec3,
    height: number,
    radius: number,
    mtv: Vec3 | null,
  ): boolean {
    if (c.shape === ColliderShape.Cylinder) {
      return this.cylinderOverlapsCapsule(c, position, height, radius, mtv);
    }

    // Transform the capsule segment into the box's local frame.
    const dx = position.x - c.center.x;
    const dz = position.z - c.center.z;
    const lx = dx * c.cosYaw - dz * c.sinYaw;
    const lz = dx * c.sinYaw + dz * c.cosYaw;

    const segBottom = position.y - c.center.y;
    const segTop = segBottom + height;

    // Vertical overlap between the capsule segment and the box slab.
    const boxBottom = -c.half.y;
    const boxTop = c.half.y;
    const yOverlapLow = Math.max(segBottom, boxBottom);
    const yOverlapHigh = Math.min(segTop, boxTop);

    // Nearest point on the box in local XZ.
    const cx = clamp(lx, -c.half.x, c.half.x);
    const cz = clamp(lz, -c.half.z, c.half.z);
    const ddx = lx - cx;
    const ddz = lz - cz;
    const horizDistSq = ddx * ddx + ddz * ddz;

    // How deeply the capsule and the box interpenetrate vertically.
    const yOverlap = Math.min(segTop, boxTop) - Math.max(segBottom, boxBottom);

    if (yOverlap <= CONTACT_EPSILON) {
      // Resting exactly on the surface, or entirely clear of it. This is NOT an
      // overlap, and treating it as one is actively dangerous: with the feet
      // level with the box top, the upward escape distance is zero, so the
      // minimum-translation search picks the downward escape instead and shoves
      // the player through the floor. A capsule that has actually sunk into a
      // surface still reports yOverlap > 0 and depenetrates correctly.
      const vertGap = Math.max(0, -yOverlap);
      if (horizDistSq + vertGap * vertGap > radius * radius) return false;
      if (mtv) v3set(mtv, 0, 0, 0);
      return false;
    }

    if (horizDistSq > radius * radius) return false;

    // Ramp: reject anything above the sloped top face, and treat the plane as
    // the contact surface so the caller gets a walkable normal.
    if (c.slopeNormal) {
      const n = c.slopeNormal;
      const feetHeightAbovePlane =
        n.x * position.x + n.y * position.y + n.z * position.z - c.slopeD;
      if (feetHeightAbovePlane > 0) {
        // Above the ramp surface — only collide if we are within radius of it.
        if (feetHeightAbovePlane > 0.02) {
          if (mtv) v3set(mtv, 0, 0, 0);
          return false;
        }
      }
      if (mtv) {
        // The escape direction is always +n. Deriving the sign from the
        // penetration depth would invert the normal whenever the capsule rests
        // just *above* the plane but inside the contact tolerance, which reads
        // to the movement controller as a ceiling rather than a walkable slope.
        const push = Math.max(0, -feetHeightAbovePlane) + 0.001;
        v3set(mtv, n.x * push, n.y * push, n.z * push);
      }
      return true;
    }

    if (!mtv) return true;

    // Minimum translation: pick the cheapest axis to escape along.
    // Horizontal escape distance along the local axes.
    const pushXLocal = c.half.x + radius - Math.abs(lx);
    const pushZLocal = c.half.z + radius - Math.abs(lz);
    const pushUp = boxTop - segBottom;
    const pushDown = segTop - boxBottom;

    // Prefer pushing up when we are close to the top face — that is what turns a
    // wedged player into a player standing on a crate rather than one shoved
    // sideways off it.
    const candidates: Array<[number, number, number, number]> = [
      [pushXLocal, Math.sign(lx) || 1, 0, 0],
      [pushZLocal, 0, 0, Math.sign(lz) || 1],
      [Math.max(0, pushUp), 0, 1, 0],
      [Math.max(0, pushDown), 0, -1, 0],
    ];

    let bestDepth = Infinity;
    let bestIdx = 0;
    for (let i = 0; i < candidates.length; i++) {
      const d = candidates[i]![0];
      if (d <= 0) continue;
      // Bias vertical escapes so shallow ledges resolve upward.
      const weighted = i === 2 ? d * 0.6 : d;
      if (weighted < bestDepth) {
        bestDepth = weighted;
        bestIdx = i;
      }
    }
    if (!Number.isFinite(bestDepth)) {
      v3set(mtv, 0, 0.01, 0);
      return true;
    }

    const [depth, sx, sy, sz] = candidates[bestIdx]!;
    if (sy !== 0) {
      v3set(mtv, 0, sy * (depth + 0.001), 0);
    } else {
      // Rotate the local escape direction back into world space.
      const wx = sx * c.cosYaw + sz * c.sinYaw;
      const wz = -sx * c.sinYaw + sz * c.cosYaw;
      const d = depth + 0.001;
      v3set(mtv, wx * d, 0, wz * d);
    }
    return true;
  }

  private cylinderOverlapsCapsule(
    c: BrushCollider,
    position: Vec3,
    height: number,
    radius: number,
    mtv: Vec3 | null,
  ): boolean {
    const segBottom = position.y;
    const segTop = position.y + height;
    const cylBottom = c.center.y - c.half.y;
    const cylTop = c.center.y + c.half.y;
    // Same contact rule as boxes: touching is not overlapping.
    if (Math.min(segTop, cylTop) - Math.max(segBottom, cylBottom) <= CONTACT_EPSILON) {
      return false;
    }

    const dx = position.x - c.center.x;
    const dz = position.z - c.center.z;
    const distSq = dx * dx + dz * dz;
    const reach = c.half.x + radius;
    if (distSq > reach * reach) return false;

    if (!mtv) return true;

    const dist = Math.sqrt(distSq);
    if (dist < 1e-5) {
      // Dead centre: pick an arbitrary but stable direction.
      v3set(mtv, reach, 0, 0);
      return true;
    }
    const push = reach - dist + 0.001;
    v3set(mtv, (dx / dist) * push, 0, (dz / dist) * push);
    return true;
  }

  private dynamicOverlapsCapsule(
    d: DynamicCollider,
    position: Vec3,
    height: number,
    radius: number,
    mtv: Vec3 | null,
  ): boolean {
    if (d.kind === 'capsule') {
      const segBottom = position.y;
      const segTop = position.y + height;
      if (segBottom > d.position.y + d.height || segTop < d.position.y) return false;

      const dx = position.x - d.position.x;
      const dz = position.z - d.position.z;
      const distSq = dx * dx + dz * dz;
      const reach = d.radius + radius;
      if (distSq > reach * reach) return false;

      if (!mtv) return true;
      const dist = Math.sqrt(distSq);
      if (dist < 1e-5) {
        v3set(mtv, reach, 0, 0);
        return true;
      }
      const push = reach - dist + 0.001;
      v3set(mtv, (dx / dist) * push, 0, (dz / dist) * push);
      return true;
    }

    const size = d.size ?? { x: 0.5, y: 0.5, z: 0.5 };
    const yaw = d.yaw ?? 0;
    _tempCollider.center.x = d.position.x;
    _tempCollider.center.y = d.position.y;
    _tempCollider.center.z = d.position.z;
    _tempCollider.half.x = size.x / 2;
    _tempCollider.half.y = size.y / 2;
    _tempCollider.half.z = size.z / 2;
    _tempCollider.yaw = yaw;
    _tempCollider.cosYaw = Math.cos(yaw);
    _tempCollider.sinYaw = Math.sin(yaw);
    _tempCollider.slopeNormal = null;
    return this.colliderOverlapsCapsule(_tempCollider, position, height, radius, mtv);
  }

  // -------------------------------------------------------------------------
  // Ray vs. individual colliders
  // -------------------------------------------------------------------------

  private rayCollider(
    origin: Vec3,
    direction: Vec3,
    maxDist: number,
    c: BrushCollider,
    outNormal: Vec3,
  ): number {
    if (c.shape === ColliderShape.Cylinder) {
      return this.rayCylinder(origin, direction, maxDist, c, outNormal);
    }

    // Into the box's local frame.
    const dx = origin.x - c.center.x;
    const dz = origin.z - c.center.z;
    v3set(
      _local,
      dx * c.cosYaw - dz * c.sinYaw,
      origin.y - c.center.y,
      dx * c.sinYaw + dz * c.cosYaw,
    );
    v3set(
      _localDir,
      direction.x * c.cosYaw - direction.z * c.sinYaw,
      direction.y,
      direction.x * c.sinYaw + direction.z * c.cosYaw,
    );

    v3set(_localBoxMin, -c.half.x, -c.half.y, -c.half.z);
    v3set(_localBoxMax, c.half.x, c.half.y, c.half.z);

    const t = rayAABB(_local, _localDir, _localBox, maxDist);
    if (t < 0) return -1;

    // Ramps: the box is the bounding volume; the actual surface is the plane.
    if (c.slopeNormal) {
      const n = c.slopeNormal;
      const denom = v3dot(direction, n);
      const originDist = n.x * origin.x + n.y * origin.y + n.z * origin.z - c.slopeD;

      if (originDist >= 0) {
        // Coming from above the ramp surface: hit the plane if we descend to it.
        if (denom >= -EPSILON) return -1;
        const tp = -originDist / denom;
        if (tp < 0 || tp > maxDist) return -1;
        // Confirm the plane hit lies within the ramp's footprint.
        v3set(
          _point,
          origin.x + direction.x * tp,
          origin.y + direction.y * tp,
          origin.z + direction.z * tp,
        );
        if (!this.pointInsideBoxXZ(c, _point)) return -1;
        v3copy(outNormal, n);
        return tp;
      }
      // Starting below the ramp: treat it as the solid box beneath.
      this.boxNormalAt(c, _local, _localDir, t, outNormal);
      return t;
    }

    this.boxNormalAt(c, _local, _localDir, t, outNormal);
    return t;
  }

  private pointInsideBoxXZ(c: BrushCollider, p: Vec3): boolean {
    const dx = p.x - c.center.x;
    const dz = p.z - c.center.z;
    const lx = dx * c.cosYaw - dz * c.sinYaw;
    const lz = dx * c.sinYaw + dz * c.cosYaw;
    return Math.abs(lx) <= c.half.x + 1e-4 && Math.abs(lz) <= c.half.z + 1e-4;
  }

  /** Face normal at a local-space hit, rotated back into world space. */
  private boxNormalAt(
    c: BrushCollider,
    localOrigin: Vec3,
    localDir: Vec3,
    t: number,
    outNormal: Vec3,
  ): void {
    const hx = localOrigin.x + localDir.x * t;
    const hy = localOrigin.y + localDir.y * t;
    const hz = localOrigin.z + localDir.z * t;

    // Whichever face the hit point is closest to (relative to its extent) wins.
    const rx = c.half.x > EPSILON ? Math.abs(hx) / c.half.x : 0;
    const ry = c.half.y > EPSILON ? Math.abs(hy) / c.half.y : 0;
    const rz = c.half.z > EPSILON ? Math.abs(hz) / c.half.z : 0;

    if (ry >= rx && ry >= rz) {
      v3set(_localNormal, 0, Math.sign(hy) || 1, 0);
    } else if (rx >= rz) {
      v3set(_localNormal, Math.sign(hx) || 1, 0, 0);
    } else {
      v3set(_localNormal, 0, 0, Math.sign(hz) || 1);
    }

    v3set(
      outNormal,
      _localNormal.x * c.cosYaw + _localNormal.z * c.sinYaw,
      _localNormal.y,
      -_localNormal.x * c.sinYaw + _localNormal.z * c.cosYaw,
    );
  }

  private rayCylinder(
    origin: Vec3,
    direction: Vec3,
    maxDist: number,
    c: BrushCollider,
    outNormal: Vec3,
  ): number {
    const radius = c.half.x;
    const bottom = c.center.y - c.half.y;
    const top = c.center.y + c.half.y;

    const ox = origin.x - c.center.x;
    const oz = origin.z - c.center.z;
    const a = direction.x * direction.x + direction.z * direction.z;
    const b = 2 * (ox * direction.x + oz * direction.z);
    const cc = ox * ox + oz * oz - radius * radius;

    let best = -1;

    if (a > EPSILON) {
      const disc = b * b - 4 * a * cc;
      if (disc >= 0) {
        const sq = Math.sqrt(disc);
        const t0 = (-b - sq) / (2 * a);
        const t1 = (-b + sq) / (2 * a);
        for (const t of [t0, t1]) {
          if (t < 0 || t > maxDist) continue;
          const y = origin.y + direction.y * t;
          if (y < bottom || y > top) continue;
          if (best < 0 || t < best) {
            best = t;
            const nx = ox + direction.x * t;
            const nz = oz + direction.z * t;
            const inv = 1 / (Math.hypot(nx, nz) || 1);
            v3set(outNormal, nx * inv, 0, nz * inv);
          }
          break;
        }
      }
    }

    // End caps.
    if (Math.abs(direction.y) > EPSILON) {
      for (const capY of [bottom, top]) {
        const t = (capY - origin.y) / direction.y;
        if (t < 0 || t > maxDist) continue;
        if (best >= 0 && t >= best) continue;
        const px = ox + direction.x * t;
        const pz = oz + direction.z * t;
        if (px * px + pz * pz > radius * radius) continue;
        best = t;
        v3set(outNormal, 0, capY === top ? 1 : -1, 0);
      }
    }

    return best;
  }

  private rayDynamic(
    origin: Vec3,
    direction: Vec3,
    maxDist: number,
    d: DynamicCollider,
    outNormal: Vec3,
  ): number {
    if (d.kind === 'capsule') {
      _tempCollider.shape = ColliderShape.Cylinder;
      _tempCollider.center.x = d.position.x;
      _tempCollider.center.y = d.position.y + d.height / 2;
      _tempCollider.center.z = d.position.z;
      _tempCollider.half.x = d.radius;
      _tempCollider.half.y = d.height / 2;
      _tempCollider.half.z = d.radius;
      _tempCollider.slopeNormal = null;
      return this.rayCylinder(origin, direction, maxDist, _tempCollider, outNormal);
    }

    const size = d.size ?? { x: 0.5, y: 0.5, z: 0.5 };
    const yaw = d.yaw ?? 0;
    _tempCollider.shape = ColliderShape.Box;
    _tempCollider.center.x = d.position.x;
    _tempCollider.center.y = d.position.y;
    _tempCollider.center.z = d.position.z;
    _tempCollider.half.x = size.x / 2;
    _tempCollider.half.y = size.y / 2;
    _tempCollider.half.z = size.z / 2;
    _tempCollider.yaw = yaw;
    _tempCollider.cosYaw = Math.cos(yaw);
    _tempCollider.sinYaw = Math.sin(yaw);
    _tempCollider.slopeNormal = null;
    return this.rayCollider(origin, direction, maxDist, _tempCollider, outNormal);
  }

  /**
   * How much material a ray must cross to exit a collider it just entered.
   * Bullet penetration depends on this being roughly right; we find the exit by
   * casting backwards from beyond the collider.
   */
  private measureThickness(
    origin: Vec3,
    direction: Vec3,
    entryDist: number,
    c: BrushCollider,
  ): number {
    // Furthest the ray could travel inside this collider.
    const span =
      2 *
      Math.sqrt(
        c.half.x * c.half.x + c.half.y * c.half.y + c.half.z * c.half.z,
      );

    // March forward from just past the entry until we are outside the collider.
    const step = Math.max(0.05, span / 16);
    for (let d = step; d <= span + step; d += step) {
      const t = entryDist + d;
      v3set(
        _point,
        origin.x + direction.x * t,
        origin.y + direction.y * t,
        origin.z + direction.z * t,
      );
      if (!this.pointInsideCollider(c, _point)) return d;
    }
    return span;
  }

  private pointInsideCollider(c: BrushCollider, p: Vec3): boolean {
    if (Math.abs(p.y - c.center.y) > c.half.y) return false;
    if (c.shape === ColliderShape.Cylinder) {
      const dx = p.x - c.center.x;
      const dz = p.z - c.center.z;
      return dx * dx + dz * dz <= c.half.x * c.half.x;
    }
    if (!this.pointInsideBoxXZ(c, p)) return false;
    if (c.slopeNormal) {
      const n = c.slopeNormal;
      return n.x * p.x + n.y * p.y + n.z * p.z - c.slopeD <= 0;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Grid traversal
  // -------------------------------------------------------------------------

  /**
   * 2D DDA over the XZ grid. Calls `visit` for each cell the ray passes through,
   * nearest first, stopping when `visit` returns false or when the cell's entry
   * distance exceeds the current best hit reported by `bestSoFar`.
   */
  private walkRayCells(
    origin: Vec3,
    direction: Vec3,
    maxDistance: number,
    visit: (cellKey: number) => boolean,
    bestSoFar: () => number,
  ): void {
    let x = this.cellX(origin.x);
    let z = this.cellZ(origin.z);

    const stepX = direction.x > 0 ? 1 : direction.x < 0 ? -1 : 0;
    const stepZ = direction.z > 0 ? 1 : direction.z < 0 ? -1 : 0;

    const invDx = Math.abs(direction.x) > EPSILON ? 1 / direction.x : Infinity;
    const invDz = Math.abs(direction.z) > EPSILON ? 1 / direction.z : Infinity;

    // Distance along the ray to the next cell boundary on each axis.
    const worldX = (x + this.gridMinX) * CELL_SIZE;
    const worldZ = (z + this.gridMinZ) * CELL_SIZE;

    let tMaxX =
      stepX === 0
        ? Infinity
        : ((stepX > 0 ? worldX + CELL_SIZE : worldX) - origin.x) * invDx;
    let tMaxZ =
      stepZ === 0
        ? Infinity
        : ((stepZ > 0 ? worldZ + CELL_SIZE : worldZ) - origin.z) * invDz;

    const tDeltaX = stepX === 0 ? Infinity : Math.abs(CELL_SIZE * invDx);
    const tDeltaZ = stepZ === 0 ? Infinity : Math.abs(CELL_SIZE * invDz);

    let travelled = 0;
    // Bound the walk: a ray can cross at most this many cells.
    const maxCells = this.gridW + this.gridH + 4;

    for (let i = 0; i < maxCells; i++) {
      if (x < 0 || z < 0 || x >= this.gridW || z >= this.gridH) break;
      if (travelled > maxDistance) break;
      // Once we are past the nearest confirmed hit, no later cell can improve it.
      if (travelled > bestSoFar()) break;

      if (!visit(z * this.gridW + x)) break;

      if (tMaxX < tMaxZ) {
        travelled = tMaxX;
        tMaxX += tDeltaX;
        x += stepX;
      } else {
        travelled = tMaxZ;
        tMaxZ += tDeltaZ;
        z += stepZ;
      }
      if (!Number.isFinite(travelled)) break;
    }
  }
}

// ---------------------------------------------------------------------------
// Module-scope scratch that needs to exist after the class body
// ---------------------------------------------------------------------------

const _mtv = vec3();
const _localBoxMin = vec3();
const _localBoxMax = vec3();
const _localBox: AABB = { min: _localBoxMin, max: _localBoxMax };

const _sharedRay: RaycastHit = {
  hit: false,
  distance: 0,
  point: vec3(),
  normal: vec3(0, 1, 0),
  surface: SurfaceType.Concrete,
  entity: 0,
  brushIndex: -1,
  thickness: 0,
  layer: CollisionLayer.None,
};

/** Reused collider used to test dynamic entities without allocating. */
const _tempCollider: BrushCollider = {
  shape: ColliderShape.Box,
  brushIndex: -1,
  center: vec3(),
  half: vec3(),
  yaw: 0,
  cosYaw: 1,
  sinYaw: 0,
  surface: SurfaceType.Metal,
  layer: CollisionLayer.Deployable,
  bounds: { min: vec3(), max: vec3() },
  slopeNormal: null,
  slopeD: 0,
};

const GROUND_FILTER: QueryFilter = { layers: CollisionLayer.World | CollisionLayer.Breakable };
