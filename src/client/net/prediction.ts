/**
 * Local-player prediction and reconciliation.
 *
 * A client that waits for the server before moving feels broken at 40 ms and
 * unplayable at 120. So the local player moves *immediately* on the input that
 * caused it, and the server's answer arrives a round trip later describing a
 * tick that already happened.
 *
 * Reconciliation is what makes those two agree without either lying:
 *
 *   1. Every input is kept until the server acknowledges it.
 *   2. When a snapshot arrives, the local player is snapped back to exactly
 *      what the server says it was at the acknowledged input.
 *   3. Every input *after* that one is then re-applied, in order, against the
 *      same movement code the server ran.
 *
 * If the client and server agree — which is almost always, because both run the
 * identical `stepMovement` over identical collision geometry — step 3 lands the
 * player exactly where prediction already had them and nothing is visible. When
 * they disagree, the correction is applied once and the player ends up where the
 * server says, which is the only acceptable outcome.
 *
 * Only movement is predicted. Firing, damage and spawning are not: their
 * outcomes depend on other players and on server RNG, and a client that predicts
 * a kill it did not get is worse than one that waits.
 */

import { INPUT_BUFFER_SIZE } from '../../shared/constants.js';
import { v3distance } from '../../shared/math.js';
import { stepMovement } from '../../shared/sim/movement.js';
import type { CollisionWorld } from '../../shared/collision/collision-types.js';
import type { InputCommand, PlayerState } from '../../shared/types.js';
import type { PlayerSnapshot } from '../../shared/net/protocol.js';

/**
 * A correction larger than this is worth counting as a real disagreement.
 *
 * Below it the difference is float noise between two runs of the same maths and
 * happens constantly; treating that as a misprediction would make the statistic
 * meaningless and tempt somebody into "fixing" it.
 */
const MISPREDICT_EPSILON = 0.05;

export interface PredictionStats {
  /** Inputs sent but not yet acknowledged. Grows with latency. */
  pending: number;
  /** Corrections that actually moved the player, since connect. */
  mispredictions: number;
  /** How far the last correction moved them, in metres. */
  lastCorrection: number;
}

export class Predictor {
  /** Unacknowledged inputs, oldest first. */
  private readonly pending: InputCommand[] = [];
  private mispredictions = 0;
  private lastCorrection = 0;

  constructor(private readonly collision: CollisionWorld) {}

  /**
   * Apply an input locally, right now, and remember it.
   *
   * Called on the same tick the input was produced — before it has been sent,
   * let alone answered.
   */
  predict(player: PlayerState, input: InputCommand): void {
    stepMovement(player, input, this.collision, input.dt);

    this.pending.push(cloneInput(input));
    // The buffer is a safety valve, not a design parameter: at 64 Hz it holds
    // two seconds of input, and a client that is two seconds behind the server
    // has lost the connection in every sense that matters.
    if (this.pending.length > INPUT_BUFFER_SIZE) this.pending.shift();
  }

  /**
   * Adopt the server's version of this player and replay everything it has not
   * seen yet.
   */
  reconcile(player: PlayerState, authoritative: PlayerSnapshot, ackedInput: number): void {
    const before = { x: player.position.x, y: player.position.y, z: player.position.z };

    player.position.x = authoritative.x;
    player.position.y = authoritative.y;
    player.position.z = authoritative.z;
    player.velocity.x = authoritative.vx;
    player.velocity.y = authoritative.vy;
    player.velocity.z = authoritative.vz;
    player.onGround = authoritative.onGround;
    // Not yaw and pitch: the player is holding the mouse and the server's copy of
    // where they were looking a round trip ago is strictly worse than the one in
    // their hand. Only what the world does to them is corrected.

    // Everything the server has already folded in is history.
    while (this.pending.length > 0 && this.pending[0]!.seq <= ackedInput) this.pending.shift();

    for (const input of this.pending) {
      stepMovement(player, input, this.collision, input.dt);
    }

    const correction = v3distance(before, player.position);
    this.lastCorrection = correction;
    if (correction > MISPREDICT_EPSILON) this.mispredictions++;
  }

  /** Inputs the server has not acknowledged, for the wire. */
  unacknowledged(): readonly InputCommand[] {
    return this.pending;
  }

  reset(): void {
    this.pending.length = 0;
    this.mispredictions = 0;
    this.lastCorrection = 0;
  }

  stats(): PredictionStats {
    return {
      pending: this.pending.length,
      mispredictions: this.mispredictions,
      lastCorrection: this.lastCorrection,
    };
  }
}

/**
 * Inputs are cloned on the way into the buffer.
 *
 * The caller reuses one command object per tick — the whole input path is
 * allocation-free by design — so storing the reference would give a buffer of
 * N pointers to the same mutating object, and replay would apply the newest
 * input N times.
 */
function cloneInput(input: InputCommand): InputCommand {
  return { ...input };
}
