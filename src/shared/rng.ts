/**
 * Deterministic pseudo-random number generation.
 *
 * Client prediction only agrees with server authority if both draw the same
 * numbers in the same order. Every random draw inside the simulation MUST come
 * from a seeded Rng carried in WorldState — never Math.random(). Presentation-only
 * randomness (particle jitter, UI flourishes) may use Math.random() freely.
 */

/** Mulberry32 — small, fast, and good enough for game randomness. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    // Avoid the degenerate all-zero state.
    this.state = (seed >>> 0) || 0x9e3779b9;
  }

  /** Snapshot the internal state so it can be replicated or rewound. */
  getState(): number {
    return this.state;
  }

  setState(state: number): void {
    this.state = (state >>> 0) || 0x9e3779b9;
  }

  clone(): Rng {
    return new Rng(this.state);
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Uniform in [-magnitude, +magnitude]. */
  signed(magnitude = 1): number {
    return (this.next() * 2 - 1) * magnitude;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick: empty array');
    return items[this.int(0, items.length - 1)]!;
  }

  /**
   * Weighted pick. `weights` must be the same length as `items` and sum > 0.
   * Used for spawn selection, care package rolls and Mystery Box draws.
   */
  pickWeighted<T>(items: readonly T[], weights: readonly number[]): T {
    if (items.length === 0) throw new Error('Rng.pickWeighted: empty array');
    let total = 0;
    for (const w of weights) total += Math.max(0, w);
    if (total <= 0) return this.pick(items);

    let roll = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      roll -= Math.max(0, weights[i] ?? 0);
      if (roll <= 0) return items[i]!;
    }
    return items[items.length - 1]!;
  }

  /** Fisher–Yates, in place. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const tmp = items[i]!;
      items[i] = items[j]!;
      items[j] = tmp;
    }
    return items;
  }

  /**
   * Standard normal via Box–Muller. Bot aim error is normally distributed, which
   * is what makes bots miss like people rather than like dice.
   */
  gaussian(mean = 0, stdDev = 1): number {
    // Guard against log(0).
    const u1 = Math.max(this.next(), 1e-12);
    const u2 = this.next();
    const mag = Math.sqrt(-2 * Math.log(u1));
    return mean + stdDev * mag * Math.cos(2 * Math.PI * u2);
  }

  /** A uniformly distributed point inside the unit disc. Used for spread cones. */
  unitDisc(out: { x: number; y: number }): { x: number; y: number } {
    const r = Math.sqrt(this.next());
    const theta = this.next() * Math.PI * 2;
    out.x = r * Math.cos(theta);
    out.y = r * Math.sin(theta);
    return out;
  }
}

/**
 * Hash a string to a 32-bit seed (FNV-1a). Lets us derive stable per-map or
 * per-match seeds from human-readable ids.
 */
export function hashString(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mix several integers into one seed, so (matchId, tick, playerId) is reproducible. */
export function mixSeeds(...values: number[]): number {
  let h = 0x9e3779b9;
  for (const v of values) {
    h ^= v >>> 0;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
  }
  return h >>> 0;
}

/** Shared instance for presentation-only randomness. Never use inside the sim. */
export const visualRng = new Rng(Date.now() & 0xffffffff);
