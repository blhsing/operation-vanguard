/**
 * Client and server, in the same loop.
 *
 * The unit tests check prediction and interpolation in isolation and the server
 * tests check the room in isolation; neither proves the two agree. This wires a
 * real `GameServer` to a real `Predictor` and `SnapshotBuffer` through an
 * in-process link and ticks both at the same rate, which is the only way to see
 * the property that actually matters: a player who holds forward for a few
 * seconds ends up in the same place on both machines.
 *
 * No sockets and no browser — the transport is a pair of arrays, and latency is
 * simulated by delaying delivery. That makes it deterministic, fast enough for
 * CI, and able to answer questions a live test never can, like "what does a
 * hundred milliseconds of lag do to the correction distance".
 */

import { describe, expect, it } from 'vitest';

import { NET, TICK_DT } from '../src/shared/constants.js';
import { createEmptyInput, type InputCommand, type PlayerState } from '../src/shared/types.js';
import {
  NetMessage,
  decodeControl,
  decodeSnapshot,
  encodeControl,
  encodeInputs,
  peekType,
  type WelcomePayload,
  type WireInput,
} from '../src/shared/net/protocol.js';
import { defaultLoadout } from '../src/shared/sim/loadout.js';
import { GameServer, type ClientLink } from '../src/server/game-server.js';
import { Predictor } from '../src/client/net/prediction.js';
import { SnapshotBuffer } from '../src/client/net/snapshot-buffer.js';
import { GameSimulation } from '../src/shared/sim/game.js';

/**
 * A client that runs the real prediction path against a real server.
 *
 * Its local world is a second `GameSimulation` on the same map — which is what
 * the browser client does too — so prediction runs against identical collision
 * geometry. Only the local player is simulated locally; everyone else arrives in
 * snapshots.
 */
class LoopClient {
  readonly buffer = new SnapshotBuffer();
  readonly predictor: Predictor;
  readonly link: ClientLink;
  local!: PlayerState;
  id = 0;
  ackedInput = 0;

  private readonly sim: GameSimulation;
  private seq = 1;
  /** Frames in flight toward the client, as [deliverAtTick, bytes]. */
  private inbound: Array<[number, Uint8Array]> = [];
  private tickNo = 0;

  constructor(
    private readonly server: GameServer,
    name: string,
    /** One-way delay in ticks. Zero is a LAN; six is about 100 ms round trip. */
    private readonly latencyTicks = 0,
  ) {
    this.sim = new GameSimulation({ mapId: server.sim.map.id, modeId: server.sim.mode.id });
    this.predictor = new Predictor(this.sim.collision);

    this.link = {
      send: (bytes) => this.inbound.push([this.tickNo + latencyTicks, bytes]),
      close: () => {},
    };

    const id = server.join(this.link, {
      protocolVersion: NET.protocolVersion,
      name,
      loadout: defaultLoadout(),
    });
    if (id === null) throw new Error('join was rejected');
    this.id = id;
  }

  /** One tick: deliver what has arrived, predict, and send. */
  tick(held: Partial<InputCommand> = {}): void {
    this.tickNo++;

    const due = this.inbound.filter(([at]) => at <= this.tickNo);
    this.inbound = this.inbound.filter(([at]) => at > this.tickNo);
    for (const [, bytes] of due) this.receive(bytes);

    // The server owns the roster; mirror its copy of us into the local world so
    // prediction has something to move.
    const snap = this.buffer.latest;
    const mine = snap?.players.find((p) => p.id === this.id);
    if (!this.local && mine) {
      this.local = this.sim.addPlayer({ name: 'me', team: 0, id: this.id });
      this.local.alive = true;
      Object.assign(this.local.position, { x: mine.x, y: mine.y, z: mine.z });
    }
    if (!this.local) return;

    if (mine) this.predictor.reconcile(this.local, mine, this.ackedInput);

    const cmd = createEmptyInput();
    cmd.seq = this.seq++;
    cmd.tick = this.tickNo;
    cmd.dt = TICK_DT;
    Object.assign(cmd, held);
    this.predictor.predict(this.local, cmd);

    // Delivery to the server is delayed by the same amount.
    const wire = this.predictor.unacknowledged().map(toWire);
    const bytes = encodeInputs(wire);
    this.outbound.push([this.tickNo + this.latencyTicks, bytes]);
    const ready = this.outbound.filter(([at]) => at <= this.tickNo);
    this.outbound = this.outbound.filter(([at]) => at > this.tickNo);
    for (const [, b] of ready) this.server.receive(this.id, b);
  }

  private outbound: Array<[number, Uint8Array]> = [];

  private receive(bytes: Uint8Array): void {
    switch (peekType(bytes)) {
      case NetMessage.Snapshot: {
        const snap = decodeSnapshot(bytes);
        this.buffer.push(snap);
        this.ackedInput = snap.ackedInput;
        break;
      }
      case NetMessage.Welcome:
        decodeControl<WelcomePayload>(bytes);
        break;
      default:
        break;
    }
  }

  /** Where the server says this client is. */
  serverPosition(): { x: number; z: number } {
    const p = this.server.sim.world.players.get(this.id)!;
    return { x: p.position.x, z: p.position.z };
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

function drift(client: LoopClient): number {
  const s = client.serverPosition();
  return Math.hypot(client.local.position.x - s.x, client.local.position.z - s.z);
}

// ---------------------------------------------------------------------------

describe('client and server in one loop', () => {
  it('keeps a moving player within centimetres of the server, on a LAN', () => {
    // The property the whole design exists for. Prediction runs ahead, the
    // server corrects, and the player never notices because there is nothing
    // to notice.
    const server = new GameServer({ mapId: 'crossfire', modeId: 'tdm', seed: 'loop' });
    const client = new LoopClient(server, 'Alice', 0);

    for (let i = 0; i < 240; i++) {
      client.tick({ moveForward: 1 });
      server.tick();
    }

    expect(client.local).toBeDefined();
    expect(drift(client)).toBeLessThan(0.5);
  });

  it('still converges with a hundred milliseconds of round trip', () => {
    // Latency does not change what is authoritative, only how far ahead the
    // prediction is running when the answer arrives.
    const server = new GameServer({ mapId: 'crossfire', modeId: 'tdm', seed: 'loop-lag' });
    const client = new LoopClient(server, 'Bob', 3);

    for (let i = 0; i < 240; i++) {
      client.tick({ moveForward: 1 });
      server.tick();
    }

    expect(drift(client)).toBeLessThan(1.5);
  });

  it('does not fight the server when standing still', () => {
    // A client that keeps correcting a stationary player is one whose prediction
    // and server disagree about something constant — gravity, ground snapping,
    // stance height — and the player sees a permanent jitter.
    const server = new GameServer({ mapId: 'crossfire', modeId: 'tdm', seed: 'loop-idle' });
    const client = new LoopClient(server, 'Carol', 2);

    for (let i = 0; i < 120; i++) {
      client.tick();
      server.tick();
    }
    const settled = client.predictor.stats().mispredictions;

    for (let i = 0; i < 120; i++) {
      client.tick();
      server.tick();
    }

    // A handful while landing and settling is fine; a steady stream is not.
    expect(client.predictor.stats().mispredictions - settled).toBeLessThan(5);
  });

  it('drains the input buffer instead of saturating it', () => {
    // If acknowledgements never catch up the buffer fills, the oldest
    // unacknowledged input is dropped, and client and server permanently
    // disagree about a movement that only one of them simulated.
    const server = new GameServer({ mapId: 'crossfire', modeId: 'tdm', seed: 'loop-ack' });
    const client = new LoopClient(server, 'Dave', 3);

    for (let i = 0; i < 300; i++) {
      client.tick({ moveForward: 1 });
      server.tick();
    }

    // Roughly the round trip's worth in flight, nothing like the 128 cap.
    expect(client.predictor.stats().pending).toBeLessThan(20);
  });

  it('shows two clients the same world', () => {
    const server = new GameServer({ mapId: 'crossfire', modeId: 'tdm', seed: 'loop-two' });
    const a = new LoopClient(server, 'A', 2);
    const b = new LoopClient(server, 'B', 2);

    for (let i = 0; i < 200; i++) {
      a.tick({ moveForward: 1 });
      b.tick();
      server.tick();
    }

    // B's interpolated view of A must match where A actually is, allowing for
    // the interpolation delay: A is moving, and B renders them in the past on
    // purpose.
    const bsViewOfA = b.buffer.sample().find((p) => p.id === a.id);
    expect(bsViewOfA).toBeDefined();
    const gap = Math.hypot(bsViewOfA!.x - a.local.position.x, bsViewOfA!.z - a.local.position.z);
    expect(gap).toBeLessThan(3);
  });
});
