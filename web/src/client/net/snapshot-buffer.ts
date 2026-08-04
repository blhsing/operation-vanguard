/**
 * Remote-player interpolation.
 *
 * Snapshots arrive twenty times a second and the screen redraws sixty or more,
 * so a client that simply adopts the newest one makes every other player move in
 * twenty discrete jumps a second. The fix is to render them slightly in the
 * past: hold a short history and, each frame, look up where everyone was at
 * `now - interpolationDelay`, which almost always falls between two snapshots
 * that have both already arrived.
 *
 * The delay is two snapshot intervals. One is not enough — a single late packet
 * leaves nothing to interpolate toward and remote players visibly stall — and
 * three is added latency bought for no extra protection.
 *
 * This is why remote players are always a little behind where the server thinks
 * they are, and it is not a bug to fix: it is the price of smooth motion, it is
 * the same price every shooter pays, and it is exactly what lag compensation
 * exists to undo on the server side when a shot is resolved.
 */

import { NET } from '../../shared/constants.js';
import { lerp } from '../../shared/math.js';
import type { PlayerSnapshot, Snapshot } from '../../shared/net/protocol.js';

/** Snapshots older than this many seconds are of no use to anybody. */
const HISTORY_SECONDS = 2;

export class SnapshotBuffer {
  private readonly history: Snapshot[] = [];
  /** Newest server time seen, which is what "now" is measured against. */
  private latestServerTime = 0;

  push(snapshot: Snapshot): void {
    // Out-of-order delivery is normal. Insert by time rather than assuming.
    let i = this.history.length;
    while (i > 0 && this.history[i - 1]!.serverTime > snapshot.serverTime) i--;
    this.history.splice(i, 0, snapshot);

    if (snapshot.serverTime > this.latestServerTime) {
      this.latestServerTime = snapshot.serverTime;
    }

    const cutoff = this.latestServerTime - HISTORY_SECONDS;
    while (this.history.length > 2 && this.history[0]!.serverTime < cutoff) this.history.shift();
  }

  get latest(): Snapshot | null {
    return this.history.at(-1) ?? null;
  }

  get size(): number {
    return this.history.length;
  }

  /**
   * Everyone's transform at the render time, interpolated.
   *
   * `advance` is how far the local clock has moved since the newest snapshot
   * landed, so the render time keeps flowing between packets instead of freezing
   * whenever one is late.
   */
  sample(advance = 0): PlayerSnapshot[] {
    if (this.history.length === 0) return [];

    const target = this.latestServerTime + advance - NET.interpolationDelay;

    // Find the pair that brackets the target time.
    let older: Snapshot | null = null;
    let newer: Snapshot | null = null;
    for (const s of this.history) {
      if (s.serverTime <= target) older = s;
      else {
        newer = s;
        break;
      }
    }

    // Before the history starts, or past its end: the nearest snapshot is the
    // best available answer and extrapolating would invent motion.
    if (!older) return this.history[0]!.players;
    if (!newer) return older.players;

    const span = newer.serverTime - older.serverTime;
    const t = span > 1e-6 ? (target - older.serverTime) / span : 0;

    const byId = new Map(newer.players.map((p) => [p.id, p]));
    const out: PlayerSnapshot[] = [];

    for (const a of older.players) {
      const b = byId.get(a.id);
      // Somebody who is in the older frame and not the newer one has left. Do
      // not interpolate them back into existence.
      if (!b) continue;
      out.push({
        ...b,
        x: lerp(a.x, b.x, t),
        y: lerp(a.y, b.y, t),
        z: lerp(a.z, b.z, t),
        vx: lerp(a.vx, b.vx, t),
        vy: lerp(a.vy, b.vy, t),
        vz: lerp(a.vz, b.vz, t),
        yaw: lerpAngle(a.yaw, b.yaw, t),
        pitch: lerp(a.pitch, b.pitch, t),
        lean: lerp(a.lean, b.lean, t),
      });
    }

    // Anyone who appeared in the newer frame only — a join, or a respawn — is
    // taken as-is rather than dropped for a fifth of a second.
    const seen = new Set(out.map((p) => p.id));
    for (const b of newer.players) if (!seen.has(b.id)) out.push(b);

    return out;
  }

  clear(): void {
    this.history.length = 0;
    this.latestServerTime = 0;
  }
}

/**
 * Interpolate the short way round.
 *
 * A player spinning through north goes from 3.1 to -3.1 radians, and a plain
 * lerp sends them the long way round the compass at high speed — the single
 * most obvious artefact in a badly interpolated shooter.
 */
export function lerpAngle(a: number, b: number, t: number): number {
  let delta = b - a;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return a + delta * t;
}
