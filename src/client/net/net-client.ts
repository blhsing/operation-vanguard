/**
 * The client half of the connection.
 *
 * Owns the socket, the prediction buffer and the snapshot history, and exposes
 * the result as plain state the rest of the client reads — same one-directional
 * contract as everything else here: the network writes into the world, and
 * nothing downstream writes back.
 *
 * The local player and everyone else are handled completely differently, and
 * that asymmetry is the whole design:
 *
 *   - **You** are predicted. Your input moves you on the frame you pressed it,
 *     and the server's correction is folded in when it arrives.
 *   - **Everyone else** is interpolated, rendered a fifth of a second in the
 *     past so their motion is smooth between the twenty snapshots a second that
 *     describe it.
 */

import { NET, TICK_DT } from '../../shared/constants.js';
import {
  NetMessage,
  decodeControl,
  decodeSnapshot,
  encodeControl,
  encodeInputs,
  peekType,
  type ByePayload,
  type ChatPayload,
  type RejectPayload,
  type WelcomePayload,
  type WireInput,
} from '../../shared/net/protocol.js';
import type { CollisionWorld } from '../../shared/collision/collision-types.js';
import type { InputCommand, PlayerId, PlayerState, SimEvent } from '../../shared/types.js';
import type { Loadout } from '../../shared/sim/loadout.js';
import { Predictor, type PredictionStats } from './prediction.js';
import { SnapshotBuffer } from './snapshot-buffer.js';

export type NetStatus = 'connecting' | 'playing' | 'rejected' | 'disconnected';

export interface NetClientOptions {
  url: string;
  name: string;
  loadout: Loadout;
  collision: CollisionWorld;
}

export class NetClient {
  status: NetStatus = 'connecting';
  /** Why the connection ended, when it did. */
  statusDetail = '';
  welcome: WelcomePayload | null = null;
  localId: PlayerId = 0;

  readonly snapshots = new SnapshotBuffer();
  readonly chat: ChatPayload[] = [];
  /** Events from the server, drained by the client each frame. */
  readonly events: SimEvent[] = [];

  private socket: WebSocket | null = null;
  private readonly predictor: Predictor;
  private seq = 1;
  /** Round-trip time in seconds, smoothed. */
  private rtt = 0;
  private pingTimer = 0;
  /** Local time elapsed since the newest snapshot, for interpolation. */
  private sinceSnapshot = 0;

  constructor(private readonly opts: NetClientOptions) {
    this.predictor = new Predictor(opts.collision);
    this.open();
  }

  private open(): void {
    const socket = new WebSocket(this.opts.url);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.onopen = () => {
      this.send(
        encodeControl(NetMessage.Hello, {
          protocolVersion: NET.protocolVersion,
          name: this.opts.name,
          loadout: this.opts.loadout,
        }),
      );
    };

    socket.onmessage = (ev) => this.receive(new Uint8Array(ev.data as ArrayBuffer));

    socket.onclose = () => {
      if (this.status !== 'rejected') {
        this.status = 'disconnected';
        this.statusDetail ||= '連線中斷';
      }
    };
    socket.onerror = () => {
      if (this.status === 'connecting') {
        this.status = 'rejected';
        this.statusDetail = '無法連線到伺服器';
      }
    };
  }

  // -------------------------------------------------------------------------

  private receive(bytes: Uint8Array): void {
    switch (peekType(bytes)) {
      case NetMessage.Welcome: {
        this.welcome = decodeControl<WelcomePayload>(bytes).payload;
        this.localId = this.welcome.yourId;
        this.status = 'playing';
        break;
      }
      case NetMessage.Reject: {
        this.status = 'rejected';
        this.statusDetail = decodeControl<RejectPayload>(bytes).payload.reason;
        break;
      }
      case NetMessage.Snapshot: {
        this.snapshots.push(decodeSnapshot(bytes));
        this.sinceSnapshot = 0;
        break;
      }
      case NetMessage.Events: {
        for (const e of decodeControl<SimEvent[]>(bytes).payload) this.events.push(e);
        break;
      }
      case NetMessage.Chat: {
        this.chat.push(decodeControl<ChatPayload>(bytes).payload);
        if (this.chat.length > 32) this.chat.shift();
        break;
      }
      case NetMessage.Bye: {
        const { id } = decodeControl<ByePayload>(bytes).payload;
        if (id === this.localId) {
          this.status = 'disconnected';
          this.statusDetail = '你已離開伺服器';
        }
        break;
      }
      case NetMessage.Pong: {
        const sentAt = decodeControl<{ t: number }>(bytes).payload.t;
        const sample = (performance.now() - sentAt) / 1000;
        // Smoothed, because one slow packet is not a slow connection and a ping
        // readout that jumps around is worse than no readout.
        this.rtt = this.rtt === 0 ? sample : this.rtt * 0.8 + sample * 0.2;
        break;
      }
      default:
        break;
    }
  }

  // -------------------------------------------------------------------------

  /**
   * Advance one tick: predict locally, then tell the server what was pressed.
   *
   * Called from the client's fixed-timestep loop, so this runs at exactly the
   * rate the server ticks at.
   */
  tick(local: PlayerState | undefined, input: InputCommand): void {
    if (this.status !== 'playing' || !this.socket) return;

    input.seq = this.seq++;
    if (local && local.alive) this.predictor.predict(local, input);

    this.send(encodeInputs(this.predictor.unacknowledged().map(toWire)));

    this.pingTimer -= TICK_DT;
    if (this.pingTimer <= 0) {
      this.pingTimer = NET.heartbeatInterval;
      this.send(encodeControl(NetMessage.Ping, { t: performance.now() }));
    }
  }

  /**
   * Fold in whatever the server has said since the last call.
   *
   * Separate from `tick` because it is driven by arrivals rather than by the
   * clock: a snapshot lands when it lands.
   */
  reconcile(local: PlayerState | undefined): void {
    const snap = this.snapshots.latest;
    if (!snap || !local) return;
    const mine = snap.players.find((p) => p.id === this.localId);
    if (!mine) return;

    // A dead player is not predicting anything, and replaying movement through a
    // respawn would fight the server over where they came back.
    if (!mine.alive || !local.alive) {
      this.predictor.reset();
      return;
    }

    this.predictor.reconcile(local, mine, snap.ackedInput);
  }

  /** Remote players, interpolated for this frame. */
  remotePlayers(dt: number): ReturnType<SnapshotBuffer['sample']> {
    this.sinceSnapshot += dt;
    return this.snapshots.sample(this.sinceSnapshot);
  }

  drainEvents(): SimEvent[] {
    const out = this.events.slice();
    this.events.length = 0;
    return out;
  }

  requestRespawn(): void {
    this.send(encodeControl(NetMessage.Respawn, {}));
  }

  say(text: string): void {
    this.send(encodeControl(NetMessage.Chat, { from: this.localId, text }));
  }

  stats(): PredictionStats & { ping: number; snapshots: number } {
    return {
      ...this.predictor.stats(),
      ping: Math.round(this.rtt * 1000),
      snapshots: this.snapshots.size,
    };
  }

  private send(bytes: Uint8Array): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(bytes);
  }

  dispose(): void {
    this.socket?.close();
    this.socket = null;
    this.snapshots.clear();
    this.predictor.reset();
  }
}

function toWire(c: InputCommand): WireInput {
  return {
    seq: c.seq,
    tick: c.tick,
    dt: c.dt,
    moveForward: c.moveForward,
    moveRight: c.moveRight,
    yaw: c.yaw,
    pitch: c.pitch,
    buttons: c.buttons,
    weaponSlot: 0,
  };
}
