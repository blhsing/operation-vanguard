/**
 * Allocation-free 3D math for the deterministic simulation.
 *
 * The sim runs on both the client (prediction) and the server (authority), so it
 * must not depend on three.js — that stays entirely on the render side. Every
 * operation here writes into an `out` parameter so hot loops never allocate.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const EPSILON = 1e-6;
export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
export const TAU = Math.PI * 2;

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function v3set(out: Vec3, x: number, y: number, z: number): Vec3 {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function v3copy(out: Vec3, a: Vec3): Vec3 {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  return out;
}

export function v3clone(a: Vec3): Vec3 {
  return { x: a.x, y: a.y, z: a.z };
}

export function v3add(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  out.x = a.x + b.x;
  out.y = a.y + b.y;
  out.z = a.z + b.z;
  return out;
}

export function v3sub(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  out.x = a.x - b.x;
  out.y = a.y - b.y;
  out.z = a.z - b.z;
  return out;
}

export function v3scale(out: Vec3, a: Vec3, s: number): Vec3 {
  out.x = a.x * s;
  out.y = a.y * s;
  out.z = a.z * s;
  return out;
}

/** out = a + b * s — the workhorse of every integrator in the sim. */
export function v3addScaled(out: Vec3, a: Vec3, b: Vec3, s: number): Vec3 {
  out.x = a.x + b.x * s;
  out.y = a.y + b.y * s;
  out.z = a.z + b.z * s;
  return out;
}

export function v3mul(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  out.x = a.x * b.x;
  out.y = a.y * b.y;
  out.z = a.z * b.z;
  return out;
}

export function v3neg(out: Vec3, a: Vec3): Vec3 {
  out.x = -a.x;
  out.y = -a.y;
  out.z = -a.z;
  return out;
}

export function v3dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function v3cross(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  const ax = a.x;
  const ay = a.y;
  const az = a.z;
  const bx = b.x;
  const by = b.y;
  const bz = b.z;
  out.x = ay * bz - az * by;
  out.y = az * bx - ax * bz;
  out.z = ax * by - ay * bx;
  return out;
}

export function v3lengthSq(a: Vec3): number {
  return a.x * a.x + a.y * a.y + a.z * a.z;
}

export function v3length(a: Vec3): number {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
}

export function v3distanceSq(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

export function v3distance(a: Vec3, b: Vec3): number {
  return Math.sqrt(v3distanceSq(a, b));
}

/** Horizontal (XZ) distance — used constantly for range checks that ignore height. */
export function v3distanceXZ(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

export function v3normalize(out: Vec3, a: Vec3): Vec3 {
  const lenSq = v3lengthSq(a);
  if (lenSq < EPSILON) {
    return v3set(out, 0, 0, 0);
  }
  const inv = 1 / Math.sqrt(lenSq);
  out.x = a.x * inv;
  out.y = a.y * inv;
  out.z = a.z * inv;
  return out;
}

export function v3lerp(out: Vec3, a: Vec3, b: Vec3, t: number): Vec3 {
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.z = a.z + (b.z - a.z) * t;
  return out;
}

/** Clamp a vector's magnitude, preserving direction. */
export function v3clampLength(out: Vec3, a: Vec3, max: number): Vec3 {
  const lenSq = v3lengthSq(a);
  if (lenSq > max * max && lenSq > EPSILON) {
    return v3scale(out, a, max / Math.sqrt(lenSq));
  }
  return v3copy(out, a);
}

/** Remove the component of `a` that points along `normal` (slide along a wall). */
export function v3projectOnPlane(out: Vec3, a: Vec3, normal: Vec3): Vec3 {
  const d = v3dot(a, normal);
  out.x = a.x - normal.x * d;
  out.y = a.y - normal.y * d;
  out.z = a.z - normal.z * d;
  return out;
}

/** Reflect `a` about `normal` with `bounce` elasticity (1 = perfect mirror). */
export function v3reflect(out: Vec3, a: Vec3, normal: Vec3, bounce = 1): Vec3 {
  const d = v3dot(a, normal) * (1 + bounce);
  out.x = a.x - normal.x * d;
  out.y = a.y - normal.y * d;
  out.z = a.z - normal.z * d;
  return out;
}

export function v3equals(a: Vec3, b: Vec3, tol = EPSILON): boolean {
  return (
    Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol && Math.abs(a.z - b.z) <= tol
  );
}

export function v3isFinite(a: Vec3): boolean {
  return Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z);
}

// ---------------------------------------------------------------------------
// Angles
// ---------------------------------------------------------------------------

/**
 * View angles use the FPS convention:
 *   yaw   — rotation about +Y, 0 = looking down -Z, increasing turns left
 *   pitch — negative looks up, positive looks down (clamped to ±89°)
 */
export interface ViewAngles {
  yaw: number;
  pitch: number;
}

export function anglesToForward(out: Vec3, yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  out.x = -Math.sin(yaw) * cp;
  out.y = -Math.sin(pitch);
  out.z = -Math.cos(yaw) * cp;
  return out;
}

/** Forward vector flattened to the ground plane — movement basis, never zero-length. */
export function anglesToForwardFlat(out: Vec3, yaw: number): Vec3 {
  out.x = -Math.sin(yaw);
  out.y = 0;
  out.z = -Math.cos(yaw);
  return out;
}

export function anglesToRight(out: Vec3, yaw: number): Vec3 {
  out.x = Math.cos(yaw);
  out.y = 0;
  out.z = -Math.sin(yaw);
  return out;
}

export function forwardToYaw(dir: Vec3): number {
  return Math.atan2(-dir.x, -dir.z);
}

export function forwardToPitch(dir: Vec3): number {
  const horiz = Math.sqrt(dir.x * dir.x + dir.z * dir.z);
  return Math.atan2(-dir.y, horiz);
}

/** Wrap to (-PI, PI]. Essential before any angular comparison or lerp. */
export function wrapAngle(a: number): number {
  let x = (a + Math.PI) % TAU;
  if (x < 0) x += TAU;
  return x - Math.PI;
}

/** Shortest signed delta from `from` to `to`. */
export function angleDelta(from: number, to: number): number {
  return wrapAngle(to - from);
}

export function angleLerp(from: number, to: number, t: number): number {
  return wrapAngle(from + angleDelta(from, to) * t);
}

/** Move `from` toward `to` by at most `maxStep` radians. */
export function angleApproach(from: number, to: number, maxStep: number): number {
  const d = angleDelta(from, to);
  if (Math.abs(d) <= maxStep) return wrapAngle(to);
  return wrapAngle(from + Math.sign(d) * maxStep);
}

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Inverse lerp, clamped — maps `v` in [a,b] onto [0,1]. */
export function invLerp(a: number, b: number, v: number): number {
  if (Math.abs(b - a) < EPSILON) return 0;
  return clamp01((v - a) / (b - a));
}

export function remap(v: number, inA: number, inB: number, outA: number, outB: number): number {
  return lerp(outA, outB, invLerp(inA, inB, v));
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = invLerp(edge0, edge1, x);
  return t * t * (3 - 2 * t);
}

export function smootherstep(edge0: number, edge1: number, x: number): number {
  const t = invLerp(edge0, edge1, x);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Frame-rate-independent exponential smoothing.
 * `rate` is the fraction of remaining distance covered per second.
 */
export function damp(current: number, target: number, rate: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-rate * dt));
}

export function v3damp(out: Vec3, current: Vec3, target: Vec3, rate: number, dt: number): Vec3 {
  const t = 1 - Math.exp(-rate * dt);
  return v3lerp(out, current, target, t);
}

export function moveTowards(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

export function sign(v: number): number {
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

/** Round to a fixed number of decimals — used to keep replay logs stable. */
export function roundTo(v: number, decimals: number): number {
  const m = 10 ** decimals;
  return Math.round(v * m) / m;
}

// ---------------------------------------------------------------------------
// Geometry helpers used by collision, AI perception and hit registration
// ---------------------------------------------------------------------------

export interface AABB {
  min: Vec3;
  max: Vec3;
}

export function aabb(min: Vec3, max: Vec3): AABB {
  return { min, max };
}

export function aabbFromCenterSize(center: Vec3, size: Vec3): AABB {
  return {
    min: vec3(center.x - size.x / 2, center.y - size.y / 2, center.z - size.z / 2),
    max: vec3(center.x + size.x / 2, center.y + size.y / 2, center.z + size.z / 2),
  };
}

export function aabbContains(box: AABB, p: Vec3): boolean {
  return (
    p.x >= box.min.x &&
    p.x <= box.max.x &&
    p.y >= box.min.y &&
    p.y <= box.max.y &&
    p.z >= box.min.z &&
    p.z <= box.max.z
  );
}

export function aabbOverlaps(a: AABB, b: AABB): boolean {
  return (
    a.min.x <= b.max.x &&
    a.max.x >= b.min.x &&
    a.min.y <= b.max.y &&
    a.max.y >= b.min.y &&
    a.min.z <= b.max.z &&
    a.max.z >= b.min.z
  );
}

export function aabbExpand(out: AABB, box: AABB, amount: number): AABB {
  out.min.x = box.min.x - amount;
  out.min.y = box.min.y - amount;
  out.min.z = box.min.z - amount;
  out.max.x = box.max.x + amount;
  out.max.y = box.max.y + amount;
  out.max.z = box.max.z + amount;
  return out;
}

export function aabbClosestPoint(out: Vec3, box: AABB, p: Vec3): Vec3 {
  out.x = clamp(p.x, box.min.x, box.max.x);
  out.y = clamp(p.y, box.min.y, box.max.y);
  out.z = clamp(p.z, box.min.z, box.max.z);
  return out;
}

/**
 * Slab-method ray/AABB intersection.
 * Returns the entry distance along `dir`, or -1 on a miss. `dir` must be normalized.
 */
export function rayAABB(origin: Vec3, dir: Vec3, box: AABB, maxDist: number): number {
  let tmin = 0;
  let tmax = maxDist;

  // X slab
  if (Math.abs(dir.x) < EPSILON) {
    if (origin.x < box.min.x || origin.x > box.max.x) return -1;
  } else {
    const inv = 1 / dir.x;
    let t1 = (box.min.x - origin.x) * inv;
    let t2 = (box.max.x - origin.x) * inv;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }

  // Y slab
  if (Math.abs(dir.y) < EPSILON) {
    if (origin.y < box.min.y || origin.y > box.max.y) return -1;
  } else {
    const inv = 1 / dir.y;
    let t1 = (box.min.y - origin.y) * inv;
    let t2 = (box.max.y - origin.y) * inv;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }

  // Z slab
  if (Math.abs(dir.z) < EPSILON) {
    if (origin.z < box.min.z || origin.z > box.max.z) return -1;
  } else {
    const inv = 1 / dir.z;
    let t1 = (box.min.z - origin.z) * inv;
    let t2 = (box.max.z - origin.z) * inv;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }

  return tmin;
}

/** Surface normal of the AABB face nearest to `point`. Used for impact decals. */
export function aabbNormalAt(out: Vec3, box: AABB, point: Vec3): Vec3 {
  const cx = (box.min.x + box.max.x) * 0.5;
  const cy = (box.min.y + box.max.y) * 0.5;
  const cz = (box.min.z + box.max.z) * 0.5;
  const ex = (box.max.x - box.min.x) * 0.5 || EPSILON;
  const ey = (box.max.y - box.min.y) * 0.5 || EPSILON;
  const ez = (box.max.z - box.min.z) * 0.5 || EPSILON;

  const dx = (point.x - cx) / ex;
  const dy = (point.y - cy) / ey;
  const dz = (point.z - cz) / ez;

  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const az = Math.abs(dz);

  if (ax >= ay && ax >= az) return v3set(out, Math.sign(dx) || 1, 0, 0);
  if (ay >= az) return v3set(out, 0, Math.sign(dy) || 1, 0);
  return v3set(out, 0, 0, Math.sign(dz) || 1);
}

/** Squared distance from a point to a segment — the core of capsule collision. */
export function pointSegmentDistanceSq(p: Vec3, a: Vec3, b: Vec3, outClosest?: Vec3): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const apx = p.x - a.x;
  const apy = p.y - a.y;
  const apz = p.z - a.z;

  const abLenSq = abx * abx + aby * aby + abz * abz;
  let t = abLenSq < EPSILON ? 0 : (apx * abx + apy * aby + apz * abz) / abLenSq;
  t = clamp01(t);

  const cx = a.x + abx * t;
  const cy = a.y + aby * t;
  const cz = a.z + abz * t;

  if (outClosest) v3set(outClosest, cx, cy, cz);

  const dx = p.x - cx;
  const dy = p.y - cy;
  const dz = p.z - cz;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Ray vs. vertical capsule (a common shape for player hitboxes when we don't need
 * per-bone precision — bots use this for cheap LOS, hitreg uses per-bone boxes).
 * Returns hit distance or -1.
 */
export function rayCapsule(
  origin: Vec3,
  dir: Vec3,
  base: Vec3,
  height: number,
  radius: number,
  maxDist: number,
): number {
  // Solve against the infinite cylinder in XZ, then clamp to the capsule body/caps.
  const ox = origin.x - base.x;
  const oz = origin.z - base.z;
  const a = dir.x * dir.x + dir.z * dir.z;
  const b = 2 * (ox * dir.x + oz * dir.z);
  const c = ox * ox + oz * oz - radius * radius;

  let best = -1;

  if (a > EPSILON) {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      for (const t of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) {
        if (t < 0 || t > maxDist) continue;
        const y = origin.y + dir.y * t;
        if (y >= base.y && y <= base.y + height) {
          if (best < 0 || t < best) best = t;
        }
      }
    }
  } else if (c <= 0) {
    // Ray is vertical and inside the cylinder radius — check the horizontal caps.
    for (const capY of [base.y, base.y + height]) {
      if (Math.abs(dir.y) < EPSILON) continue;
      const t = (capY - origin.y) / dir.y;
      if (t >= 0 && t <= maxDist && (best < 0 || t < best)) best = t;
    }
  }

  // Hemispherical caps.
  for (const capY of [base.y, base.y + height]) {
    const cx = origin.x - base.x;
    const cy = origin.y - capY;
    const cz = origin.z - base.z;
    const qa = 1; // dir is normalized
    const qb = 2 * (cx * dir.x + cy * dir.y + cz * dir.z);
    const qc = cx * cx + cy * cy + cz * cz - radius * radius;
    const disc = qb * qb - 4 * qa * qc;
    if (disc < 0) continue;
    const sq = Math.sqrt(disc);
    for (const t of [(-qb - sq) / 2, (-qb + sq) / 2]) {
      if (t < 0 || t > maxDist) continue;
      const y = origin.y + dir.y * t;
      // Only accept points on the correct hemisphere.
      if (capY === base.y ? y <= base.y : y >= base.y + height) {
        if (best < 0 || t < best) best = t;
      }
    }
  }

  return best;
}

/** Ray vs. sphere. Returns nearest non-negative hit distance or -1. */
export function raySphere(
  origin: Vec3,
  dir: Vec3,
  center: Vec3,
  radius: number,
  maxDist: number,
): number {
  const ox = origin.x - center.x;
  const oy = origin.y - center.y;
  const oz = origin.z - center.z;
  const b = 2 * (ox * dir.x + oy * dir.y + oz * dir.z);
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - 4 * c;
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  const t0 = (-b - sq) / 2;
  const t1 = (-b + sq) / 2;
  if (t0 >= 0 && t0 <= maxDist) return t0;
  if (t1 >= 0 && t1 <= maxDist) return t1;
  return -1;
}

/**
 * Is `target` inside a cone of half-angle `halfAngleRad` centred on `dir` from `origin`?
 * Used for AI field-of-view and for flashbang/concussion falloff.
 */
export function inCone(
  origin: Vec3,
  dir: Vec3,
  target: Vec3,
  halfAngleRad: number,
  maxDist: number,
): boolean {
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const dz = target.z - origin.z;
  const distSq = dx * dx + dy * dy + dz * dz;
  if (distSq > maxDist * maxDist) return false;
  if (distSq < EPSILON) return true;
  const inv = 1 / Math.sqrt(distSq);
  const cosAngle = (dx * dir.x + dy * dir.y + dz * dir.z) * inv;
  return cosAngle >= Math.cos(halfAngleRad);
}

/** Signed distance from a point to a plane defined by a normal and a point on it. */
export function pointPlaneDistance(p: Vec3, planePoint: Vec3, planeNormal: Vec3): number {
  return (
    (p.x - planePoint.x) * planeNormal.x +
    (p.y - planePoint.y) * planeNormal.y +
    (p.z - planePoint.z) * planeNormal.z
  );
}

// ---------------------------------------------------------------------------
// Scratch vectors
//
// Shared temporaries for call sites that need a throwaway Vec3 inside a hot loop.
// Never hold a reference across a function boundary — copy out first.
// ---------------------------------------------------------------------------

export const TMP_A: Vec3 = vec3();
export const TMP_B: Vec3 = vec3();
export const TMP_C: Vec3 = vec3();
export const TMP_D: Vec3 = vec3();
