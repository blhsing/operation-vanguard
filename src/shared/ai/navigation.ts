/**
 * Navigation.
 *
 * Rather than voxelising the map into a navmesh at load time, the graph is built
 * from data the level designer already authored — lane waypoints and cover
 * points — plus the explicit nav links for mantles and drop-downs. Edges are
 * created between nodes that can actually walk to each other, verified with real
 * capsule sweeps against the real collision world.
 *
 * Two reasons this is the right trade here:
 *
 *   1. The authored points are where a designer decided fighting happens. A
 *      generated navmesh would let bots path through the geometrically-shortest
 *      route, which is frequently the one no human would take.
 *   2. Building it costs one pass over a few hundred nodes at map load, with no
 *      baked artefact to keep in sync with the brush data.
 *
 * Bots follow the graph at the strategic level and steer directly at the tactical
 * level, which is what stops them walking into doorframes.
 */

import { PLAYER_RADIUS, STANCE_HEIGHT } from '../constants.js';
import {
  v3distance,
  v3distanceXZ,
  v3set,
  v3sub,
  v3normalize,
  vec3,
  type Vec3,
} from '../math.js';
import {
  CollisionLayer,
  createRaycastHit,
  createSweepHit,
  type CollisionWorld,
  type QueryFilter,
} from '../collision/collision-types.js';
import { PROP_HEIGHT } from '../map/props.js';
import type { MapDef } from '../map/map-types.js';

const NAV_FILTER: QueryFilter = { layers: CollisionLayer.Movement };
const _sweep = createSweepHit();
const _delta = vec3();
const _probe = vec3();

export interface NavNode {
  id: number;
  position: Vec3;
  /** Indices of reachable neighbours, with the traversal cost of each. */
  edges: Array<{ to: number; cost: number }>;
  /** Whether this node is a designated fighting position. */
  isCover: boolean;
  /** How exposed the node is, 0 (safe) to 1 (open). Cover nodes carry the
   *  designer's value; generated lane nodes assume moderate exposure. */
  exposure: number;
  /** Tactical value of holding here. */
  value: number;
  /** Facing a bot should adopt when holding this node, if it is cover. */
  facing: number;
  crouch: boolean;
  /** Lane this node belongs to, or '' for cover points off-lane. */
  lane: string;
}

export class NavGraph {
  readonly nodes: NavNode[] = [];

  /** Spatial bucket for nearest-node lookups, keyed by a coarse grid cell. */
  private readonly buckets = new Map<number, number[]>();
  private static readonly BUCKET = 8;

  constructor(map: MapDef, collision: CollisionWorld) {
    this.build(map, collision);
  }

  private build(map: MapDef, collision: CollisionWorld): void {
    // --- grid sampling ------------------------------------------------------
    // Authored points alone leave the graph fragmented: cover points sit against
    // walls and lane waypoints are tens of metres apart, so long edges fail the
    // walkability test and the map splits into islands. A uniform sample
    // guarantees coverage; the authored points then layer their tactical
    // metadata on top.
    this.sampleGrid(map, collision);

    // --- nodes from authored data ------------------------------------------
    for (const lane of map.lanes) {
      // Subdivide lane paths so long legs still give bots intermediate targets.
      for (let i = 0; i < lane.path.length; i++) {
        const a = lane.path[i]!;
        this.addNode(a, collision, { lane: lane.name, exposure: 0.6, value: 0.5 });

        const b = lane.path[i + 1];
        if (!b) continue;
        const dist = v3distance(a, b);
        const steps = Math.floor(dist / 8);
        for (let s = 1; s <= steps; s++) {
          const t = s / (steps + 1);
          this.addNode(
            vec3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t),
            collision,
            { lane: lane.name, exposure: 0.6, value: 0.4 },
          );
        }
      }
    }

    for (const cp of map.coverPoints) {
      this.addNode(cp.position, collision, {
        lane: '',
        exposure: cp.exposure,
        value: cp.value,
        isCover: true,
        facing: cp.facing,
        crouch: cp.crouch,
      });
    }

    for (const spawn of map.spawns) {
      // Spawns are added sparsely — one per group is enough to anchor the graph
      // at each end of the map without flooding it with near-duplicate nodes.
      this.addNode(spawn.position, collision, { lane: '', exposure: 0.5, value: 0.2 }, 6);
    }

    // --- edges --------------------------------------------------------------
    // Only connect nodes a capsule can actually sweep between. This is the
    // expensive part of load, and the reason bots never path through a wall.
    //
    // Edges are kept SHORT. A long edge has to survive every intermediate
    // walkability probe along its length, so raising this radius paradoxically
    // *reduces* connectivity — one clipped doorframe twenty metres away kills
    // the whole link. Short hops between dense nodes are far more robust.
    const MAX_EDGE = 6.5;
    for (let i = 0; i < this.nodes.length; i++) {
      const a = this.nodes[i]!;
      for (const j of this.nearbyIndices(a.position, MAX_EDGE)) {
        if (j <= i) continue;
        const b = this.nodes[j]!;
        const dist = v3distance(a.position, b.position);
        if (dist > MAX_EDGE) continue;
        // Reject links between floors that happen to be vertically close.
        if (Math.abs(a.position.y - b.position.y) > 1.2) continue;
        if (!this.walkable(a.position, b.position, collision)) continue;

        // Prefer routes through cover: a bot that hugs cover reads as competent
        // even when its aim is mediocre.
        const cost = dist * (1 + (a.exposure + b.exposure) * 0.25);
        a.edges.push({ to: j, cost });
        b.edges.push({ to: i, cost });
      }
    }

    // --- explicit links -----------------------------------------------------
    for (const link of map.navLinks) {
      const from = this.nearestNode(link.from, 6);
      const to = this.nearestNode(link.to, 6);
      if (from < 0 || to < 0 || from === to) continue;
      const dist = v3distance(link.from, link.to);
      this.nodes[from]!.edges.push({ to, cost: dist * link.cost });
      if (link.bidirectional) {
        this.nodes[to]!.edges.push({ to: from, cost: dist * link.cost });
      }
    }

    // --- prune to the reachable world ---------------------------------------
    this.keepLargestComponent();
  }

  /**
   * Discard every node outside the largest connected component.
   *
   * Grid sampling inevitably finds standable surfaces that are not part of the
   * playable space: building rooftops, ledges with no way up, and the strip of
   * ground plane outside the perimeter wall. Each becomes its own island. If
   * they survive, `nearestNode` will happily return one for a bot standing
   * below it and every subsequent path request silently fails.
   *
   * The largest component *is* the playable area, by definition — so keeping
   * only that is both the simplest rule and the correct one.
   */
  private keepLargestComponent(): void {
    if (this.nodes.length === 0) return;

    const component = new Int32Array(this.nodes.length).fill(-1);
    let bestId = -1;
    let bestSize = 0;
    let nextId = 0;

    for (let start = 0; start < this.nodes.length; start++) {
      if (component[start] !== -1) continue;
      const id = nextId++;
      let size = 0;
      const stack = [start];
      component[start] = id;
      while (stack.length > 0) {
        const node = stack.pop()!;
        size++;
        for (const edge of this.nodes[node]!.edges) {
          if (component[edge.to] === -1) {
            component[edge.to] = id;
            stack.push(edge.to);
          }
        }
      }
      if (size > bestSize) {
        bestSize = size;
        bestId = id;
      }
    }

    if (bestSize === this.nodes.length) return;

    // Compact, remapping indices as we go.
    const remap = new Int32Array(this.nodes.length).fill(-1);
    const kept: NavNode[] = [];
    for (let i = 0; i < this.nodes.length; i++) {
      if (component[i] !== bestId) continue;
      remap[i] = kept.length;
      kept.push(this.nodes[i]!);
    }

    for (const node of kept) {
      node.edges = node.edges
        .filter((e) => remap[e.to] !== -1)
        .map((e) => ({ to: remap[e.to]!, cost: e.cost }));
    }
    for (let i = 0; i < kept.length; i++) kept[i]!.id = i;

    this.nodes.length = 0;
    this.nodes.push(...kept);

    // Rebuild the spatial buckets against the new indices.
    this.buckets.clear();
    for (const node of this.nodes) this.bucketOf(node.position).push(node.id);

    // Search scratch is sized to the node count; force reallocation.
    this.scratchG = undefined;
    this.scratchF = undefined;
    this.scratchFrom = undefined;
    this.scratchClosed = undefined;
  }

  /**
   * Sample a lattice of standable positions across the map.
   *
   * Each column is probed downward repeatedly rather than once, so multi-storey
   * geometry gets nodes on every floor — without this, a warehouse catwalk is
   * invisible to the AI and bots never use the map's verticality.
   */
  private sampleGrid(map: MapDef, collision: CollisionWorld): void {
    /**
     * Sampling density scales with the map, and it has to.
     *
     * A fixed three-metre grid is right for an eighty-metre map with lanes you
     * could drive down. On a thirty-six-metre container yard it is a disaster:
     * the walkable gaps between containers are about two metres wide, so the
     * grid steps straight over them and lands on the container roofs instead.
     * Adjacent samples then differ by three to five metres in height, the edge
     * builder refuses to connect across that, and every interior sample becomes
     * its own island — which `keepLargestComponent` deletes in favour of the one
     * genuinely contiguous surface, the perimeter walkway.
     *
     * Shipment Yard shipped like that. Its entire interior — a hundred and
     * thirty-six standable sample points, three domination flags and all
     * thirty-three of its authored cover positions — was invisible to every bot
     * in the game, which navigated a hollow ring around the outside of a map
     * whose whole idea is the middle.
     */
    const extent = Math.max(
      map.bounds.max.x - map.bounds.min.x,
      map.bounds.max.z - map.bounds.min.z,
    );
    const SPACING = Math.max(1.5, Math.min(3.0, extent / 26));
    const minX = map.bounds.min.x + 1;
    const maxX = map.bounds.max.x - 1;
    const minZ = map.bounds.min.z + 1;
    const maxZ = map.bounds.max.z - 1;
    const ceiling = map.bounds.max.y;

    for (let z = minZ; z <= maxZ; z += SPACING) {
      for (let x = minX; x <= maxX; x += SPACING) {
        let probeY = ceiling;
        // At most four floors in a column; beyond that the map is doing
        // something the AI has no business navigating anyway.
        for (let level = 0; level < 4; level++) {
          const groundY = collision.groundHeightAt(x, z, probeY, probeY - map.bounds.min.y);
          if (!Number.isFinite(groundY)) break;

          const feet = vec3(x, groundY + 0.05, z);
          if (collision.isCapsuleFree(feet, STANCE_HEIGHT.stand, PLAYER_RADIUS, NAV_FILTER)) {
            this.pushNode({
              position: feet,
              isCover: false,
              exposure: 0.55,
              value: 0.3,
              facing: 0,
              crouch: false,
              lane: '',
            });
          }
          // Continue below this floor to find any storey underneath.
          probeY = groundY - 0.3;
          if (probeY <= map.bounds.min.y) break;
        }
      }
    }
  }

  private pushNode(spec: Omit<NavNode, 'id' | 'edges'>): number {
    const node: NavNode = { id: this.nodes.length, edges: [], ...spec };
    this.nodes.push(node);
    this.bucketOf(node.position).push(node.id);
    return node.id;
  }

  /**
   * The floor of the storey an authored point belongs to.
   *
   * Authored Y is approximate and has to be dropped onto real geometry — but it
   * is approximate by centimetres, and what it tells you is which *storey* the
   * designer meant. The old rule started the probe four metres up and took the
   * first surface under it, which answers a different question: four metres
   * clears a whole floor (`PROP_HEIGHT.storey` is 3.4), so on an indoor upper
   * deck the ray began above that deck's own ceiling and came back with the
   * wrong one.
   *
   * The damage was invisible and total. All fifteen of Highrise's mezzanine
   * cover points resolved three metres up onto the office roof, an unreachable
   * island `keepLargestComponent` then deleted; all thirty-four of Subway's
   * resolved onto the underside of the station ceiling and failed the capsule
   * test outright. Both maps were left with upper floors built entirely from
   * value-0.3 grid samples carrying no `isCover` at all — so `findCover`, the
   * thing that makes a bot hold an angle instead of standing in the open, had
   * nothing to offer upstairs on either of them. It ran the other way too,
   * lifting ground cover that sat under a catwalk up onto it.
   *
   * So look inside one storey first, and only fall back to the wide probe when
   * that finds nothing — ground points are legitimately authored at y = 0 on
   * maps whose floor is a metre up, and dropping those would fragment the graph.
   *
   * (A single downward ray, deliberately: `raycastAll` down the whole column is
   * the more general answer and does not work here, because these probes start
   * inside the ceiling brush and a multi-hit trace that begins solid silently
   * loses surfaces below it.)
   */
  private floorNear(position: Vec3, collision: CollisionWorld): number {
    const inStorey = collision.groundHeightAt(
      position.x,
      position.z,
      position.y + 1,
      PROP_HEIGHT.storey,
    );
    if (Number.isFinite(inStorey)) return inStorey;
    return collision.groundHeightAt(position.x, position.z, position.y + 4, 14);
  }

  private addNode(
    position: Vec3,
    collision: CollisionWorld,
    opts: {
      lane: string;
      exposure: number;
      value: number;
      isCover?: boolean;
      facing?: number;
      crouch?: boolean;
    },
    minSeparation = 2.2,
  ): number {
    // Drop to the floor the author meant.
    const groundY = this.floorNear(position, collision);
    const y = Number.isFinite(groundY) ? groundY + 0.05 : position.y;
    const pos = vec3(position.x, y, position.z);

    if (!collision.isCapsuleFree(pos, STANCE_HEIGHT.crouch, PLAYER_RADIUS, NAV_FILTER)) {
      return -1;
    }

    // The grid has already covered the map, so an authored point that lands on
    // an existing node should *upgrade* it with the designer's metadata rather
    // than be discarded — otherwise every hand-placed cover position would be
    // silently thrown away by the deduplication.
    for (const idx of this.nearbyIndices(pos, minSeparation)) {
      const existing = this.nodes[idx]!;
      if (v3distance(existing.position, pos) >= minSeparation) continue;

      if (opts.isCover && !existing.isCover) {
        existing.isCover = true;
        existing.facing = opts.facing ?? 0;
        existing.crouch = opts.crouch ?? false;
        existing.exposure = opts.exposure;
        existing.value = Math.max(existing.value, opts.value);
      } else if (opts.lane && !existing.lane) {
        existing.lane = opts.lane;
      }
      return idx;
    }

    return this.pushNode({
      position: pos,
      isCover: opts.isCover ?? false,
      exposure: opts.exposure,
      value: opts.value,
      facing: opts.facing ?? 0,
      crouch: opts.crouch ?? false,
      lane: opts.lane,
    });
  }

  /**
   * Can a player capsule get from a to b in a straight line?
   *
   * Uses a stepped sweep rather than a single one so that a route which requires
   * climbing a small step is still accepted — the movement controller can handle
   * those, and rejecting them would disconnect half the graph.
   */
  private walkable(a: Vec3, b: Vec3, collision: CollisionWorld): boolean {
    v3sub(_delta, b, a);
    const dist = Math.hypot(_delta.x, _delta.z);
    if (dist < 0.01) return true;

    const steps = Math.max(2, Math.ceil(dist / 1.5));
    v3set(_probe, a.x, a.y, a.z);

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const tx = a.x + (b.x - a.x) * t;
      const tz = a.z + (b.z - a.z) * t;

      // Follow the floor rather than assuming a flat path.
      const groundY = collision.groundHeightAt(tx, tz, _probe.y + 2.2, 5);
      if (!Number.isFinite(groundY)) return false;

      // Reject anything that would need a jump or a big drop.
      const rise = groundY + 0.05 - _probe.y;
      if (rise > 0.55 || rise < -2.5) return false;

      const next = vec3(tx, groundY + 0.05, tz);
      v3sub(_delta, next, _probe);
      collision.sweepCapsule(_probe, STANCE_HEIGHT.crouch, PLAYER_RADIUS, _delta, NAV_FILTER, _sweep);
      if (_sweep.hit && _sweep.fraction < 0.92) return false;

      v3set(_probe, next.x, next.y, next.z);
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  private bucketKey(x: number, z: number): number {
    const bx = Math.floor(x / NavGraph.BUCKET) + 512;
    const bz = Math.floor(z / NavGraph.BUCKET) + 512;
    return bz * 1024 + bx;
  }

  private bucketOf(p: Vec3): number[] {
    const key = this.bucketKey(p.x, p.z);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = [];
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  /** Node indices within `radius` of a point, via the bucket grid. */
  private *nearbyIndices(p: Vec3, radius: number): Generator<number> {
    const cells = Math.ceil(radius / NavGraph.BUCKET);
    for (let dz = -cells; dz <= cells; dz++) {
      for (let dx = -cells; dx <= cells; dx++) {
        const bucket = this.buckets.get(
          this.bucketKey(p.x + dx * NavGraph.BUCKET, p.z + dz * NavGraph.BUCKET),
        );
        if (!bucket) continue;
        for (const idx of bucket) yield idx;
      }
    }
  }

  nearestNode(position: Vec3, maxDistance = 30): number {
    let best = -1;
    let bestDist = maxDistance;
    for (const idx of this.nearbyIndices(position, maxDistance)) {
      const d = v3distance(this.nodes[idx]!.position, position);
      if (d < bestDist) {
        bestDist = d;
        best = idx;
      }
    }
    return best;
  }

  /**
   * A* over the graph. Returns node indices from start to goal inclusive, or an
   * empty array if unreachable.
   *
   * The open set is a plain array with a linear scan for the minimum. With a few
   * hundred nodes that beats a binary heap on constant factors, and it keeps the
   * code obvious.
   */
  findPath(startIdx: number, goalIdx: number, out: number[] = []): number[] {
    out.length = 0;
    if (startIdx < 0 || goalIdx < 0 || startIdx >= this.nodes.length || goalIdx >= this.nodes.length) {
      return out;
    }
    if (startIdx === goalIdx) {
      out.push(startIdx);
      return out;
    }

    const n = this.nodes.length;
    const gScore = this.scratchG ?? (this.scratchG = new Float32Array(n));
    const fScore = this.scratchF ?? (this.scratchF = new Float32Array(n));
    const cameFrom = this.scratchFrom ?? (this.scratchFrom = new Int32Array(n));
    const closed = this.scratchClosed ?? (this.scratchClosed = new Uint8Array(n));

    if (gScore.length < n) {
      this.scratchG = new Float32Array(n);
      this.scratchF = new Float32Array(n);
      this.scratchFrom = new Int32Array(n);
      this.scratchClosed = new Uint8Array(n);
      return this.findPath(startIdx, goalIdx, out);
    }

    gScore.fill(Infinity);
    fScore.fill(Infinity);
    cameFrom.fill(-1);
    closed.fill(0);

    const goal = this.nodes[goalIdx]!.position;
    const open: number[] = [startIdx];
    gScore[startIdx] = 0;
    fScore[startIdx] = v3distance(this.nodes[startIdx]!.position, goal);

    let guard = 0;
    while (open.length > 0 && guard++ < 4096) {
      let bestSlot = 0;
      for (let i = 1; i < open.length; i++) {
        if (fScore[open[i]!]! < fScore[open[bestSlot]!]!) bestSlot = i;
      }
      const current = open[bestSlot]!;
      if (current === goalIdx) {
        // Walk the parent chain back and reverse.
        let node = current;
        while (node !== -1) {
          out.push(node);
          node = cameFrom[node]!;
        }
        out.reverse();
        return out;
      }

      open.splice(bestSlot, 1);
      closed[current] = 1;

      for (const edge of this.nodes[current]!.edges) {
        if (closed[edge.to]) continue;
        const tentative = gScore[current]! + edge.cost;
        if (tentative >= gScore[edge.to]!) continue;
        cameFrom[edge.to] = current;
        gScore[edge.to] = tentative;
        fScore[edge.to] = tentative + v3distance(this.nodes[edge.to]!.position, goal);
        if (!open.includes(edge.to)) open.push(edge.to);
      }
    }

    return out;
  }

  private scratchG?: Float32Array;
  private scratchF?: Float32Array;
  private scratchFrom?: Int32Array;
  private scratchClosed?: Uint8Array;

  /**
   * The best cover node near a point, scored by tactical value against the
   * direction a threat is coming from.
   */
  findCover(near: Vec3, threatFrom: Vec3, radius = 25): NavNode | null {
    let best: NavNode | null = null;
    let bestScore = -Infinity;

    v3sub(_delta, threatFrom, near);
    v3normalize(_delta, _delta);

    for (const idx of this.nearbyIndices(near, radius)) {
      const node = this.nodes[idx]!;
      if (!node.isCover) continue;

      const dist = v3distance(node.position, near);
      if (dist > radius) continue;

      let score = node.value * 10 - node.exposure * 8 - dist * 0.25;

      // Prefer cover that faces the threat: a hold position pointing the wrong
      // way is worse than no hold position.
      const dx = threatFrom.x - node.position.x;
      const dz = threatFrom.z - node.position.z;
      const toThreat = Math.atan2(-dx, -dz);
      const facingError = Math.abs(wrap(toThreat - node.facing));
      score -= facingError * 2.2;

      // And prefer cover that isn't further from the threat than we already are.
      const threatDist = v3distanceXZ(node.position, threatFrom);
      if (threatDist < 6) score -= 12;

      if (score > bestScore) {
        bestScore = score;
        best = node;
      }
    }

    return best;
  }

  /** Total node count, exposed for diagnostics and tests. */
  get size(): number {
    return this.nodes.length;
  }

  /** Fraction of nodes reachable from the largest connected component. */
  connectivity(): number {
    if (this.nodes.length === 0) return 1;
    const seen = new Uint8Array(this.nodes.length);
    let bestComponent = 0;

    for (let start = 0; start < this.nodes.length; start++) {
      if (seen[start]) continue;
      let count = 0;
      const stack = [start];
      seen[start] = 1;
      while (stack.length > 0) {
        const node = stack.pop()!;
        count++;
        for (const edge of this.nodes[node]!.edges) {
          if (!seen[edge.to]) {
            seen[edge.to] = 1;
            stack.push(edge.to);
          }
        }
      }
      if (count > bestComponent) bestComponent = count;
    }
    return bestComponent / this.nodes.length;
  }
}

function wrap(a: number): number {
  let x = (a + Math.PI) % (Math.PI * 2);
  if (x < 0) x += Math.PI * 2;
  return x - Math.PI;
}
