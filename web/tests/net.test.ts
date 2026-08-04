/**
 * Netcode tests.
 *
 * Two halves, and the second is the one that matters. Encoding tests catch a
 * field written in one order and read in another — real, cheap, and not proof of
 * anything about the game. The room tests drive a full authoritative server
 * in-process with fake links, which is what tells you whether a client that
 * connects and presses forward actually moves.
 *
 * There are no sockets here on purpose. `GameServer` takes a `ClientLink`, so a
 * test can be a link, and everything about ordering, acknowledgement and
 * authority is observable without a network in the way.
 */

import { describe, expect, it } from 'vitest';

import { MAX_PLAYERS, NET, TICK_DT } from '../src/shared/constants.js';
import { InputFlag, Team } from '../src/shared/types.js';
import {
  NetMessage,
  Reader,
  Writer,
  decodeControl,
  decodeInputs,
  decodeSnapshot,
  encodeControl,
  encodeInputs,
  encodeSnapshot,
  packAngle,
  peekType,
  unpackAngle,
  type PlayerSnapshot,
  type Snapshot,
  type WireInput,
} from '../src/shared/net/protocol.js';
import { GameServer, type ClientLink } from '../src/server/game-server.js';
import { defaultLoadout } from '../src/shared/sim/loadout.js';

// ---------------------------------------------------------------------------

/** A client link that keeps everything it was sent. */
class FakeLink implements ClientLink {
  readonly sent: Uint8Array[] = [];
  closed: string | null = null;

  send(bytes: Uint8Array): void {
    this.sent.push(bytes);
  }
  close(reason: string): void {
    this.closed = reason;
  }

  /** The most recent frame of a given type, decoded as a snapshot. */
  lastSnapshot(): Snapshot | null {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      if (peekType(this.sent[i]!) === NetMessage.Snapshot) return decodeSnapshot(this.sent[i]!);
    }
    return null;
  }

  countOf(type: NetMessage): number {
    return this.sent.filter((b) => peekType(b) === type).length;
  }
}

function hello(name = 'Tester') {
  return { protocolVersion: NET.protocolVersion, name, loadout: defaultLoadout() };
}

function input(seq: number, over: Partial<WireInput> = {}): WireInput {
  return {
    seq,
    tick: seq,
    dt: TICK_DT,
    moveForward: 0,
    moveRight: 0,
    yaw: 0,
    pitch: 0,
    buttons: 0,
    weaponSlot: 0,
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe('wire primitives', () => {
  it('round-trips every scalar it claims to support', () => {
    const w = new Writer(64);
    w.u8(200);
    w.i8(-100);
    w.u16(60000);
    w.u32(4_000_000_000);
    w.f32(1.5);
    w.str('先鋒行動');

    const r = new Reader(w.finish());
    expect(r.u8()).toBe(200);
    expect(r.i8()).toBe(-100);
    expect(r.u16()).toBe(60000);
    expect(r.u32()).toBe(4_000_000_000);
    expect(r.f32()).toBeCloseTo(1.5, 6);
    // Length-prefixed UTF-8, so a multi-byte string must survive intact — the
    // whole interface is Chinese and a name field that mangles it is useless.
    expect(r.str()).toBe('先鋒行動');
  });

  it('grows past its initial capacity rather than truncating', () => {
    // A silent overflow would corrupt a frame in a way no decoder could detect.
    const w = new Writer(4);
    for (let i = 0; i < 100; i++) w.u32(i);
    const r = new Reader(w.finish());
    for (let i = 0; i < 100; i++) expect(r.u32()).toBe(i);
  });

  it('packs angles to a resolution finer than any player can aim', () => {
    for (const a of [0, 0.001, 1, -1, Math.PI - 0.0001, -Math.PI + 0.0001]) {
      expect(unpackAngle(packAngle(a))).toBeCloseTo(a, 3);
    }
  });

  it('wraps angles instead of disagreeing about π', () => {
    // An angle sent as a float needs normalising on both ends and then argues
    // about whether -π and π are the same heading. A 16-bit turn cannot.
    expect(packAngle(Math.PI * 2)).toBe(packAngle(0));
    expect(packAngle(Math.PI * 3)).toBe(packAngle(Math.PI));
    expect(Math.abs(unpackAngle(packAngle(-Math.PI)))).toBeCloseTo(Math.PI, 3);
  });
});

describe('snapshots', () => {
  const player: PlayerSnapshot = {
    id: 7,
    team: Team.Axis,
    alive: true,
    onGround: false,
    isBot: true,
    stance: 1,
    moveState: 2,
    x: -12.5,
    y: 3.25,
    z: 40.125,
    vx: 1,
    vy: -9.8,
    vz: 0.5,
    yaw: 1.25,
    pitch: -0.5,
    health: 73,
    weaponSlot: 1,
    lean: -0.5,
  };

  it('round-trips a full snapshot', () => {
    const snap: Snapshot = { tick: 4096, serverTime: 64, ackedInput: 129, players: [player] };
    const back = decodeSnapshot(encodeSnapshot(snap));

    expect(back.tick).toBe(4096);
    expect(back.serverTime).toBeCloseTo(64, 4);
    expect(back.ackedInput).toBe(129);
    expect(back.players).toHaveLength(1);

    const p = back.players[0]!;
    expect(p.id).toBe(7);
    expect(p.x).toBeCloseTo(-12.5, 4);
    expect(p.z).toBeCloseTo(40.125, 4);
    expect(p.vy).toBeCloseTo(-9.8, 3);
    expect(p.yaw).toBeCloseTo(1.25, 3);
    expect(p.health).toBe(73);
    expect(p.lean).toBeCloseTo(-0.5, 2);
  });

  it('keeps the three booleans apart', () => {
    // They share one flags byte, so a shifted mask silently makes every corpse
    // airborne or every human a bot.
    for (const [alive, onGround, isBot] of [
      [true, false, false],
      [false, true, false],
      [false, false, true],
      [true, true, true],
    ] as Array<[boolean, boolean, boolean]>) {
      const back = decodeSnapshot(
        encodeSnapshot({
          tick: 0,
          serverTime: 0,
          ackedInput: 0,
          players: [{ ...player, alive, onGround, isBot }],
        }),
      );
      expect(back.players[0]!.alive).toBe(alive);
      expect(back.players[0]!.onGround).toBe(onGround);
      expect(back.players[0]!.isBot).toBe(isBot);
    }
  });

  it('stays small enough to send twenty times a second to a full lobby', () => {
    const players = Array.from({ length: MAX_PLAYERS }, (_, i) => ({ ...player, id: i }));
    const bytes = encodeSnapshot({ tick: 1, serverTime: 1, ackedInput: 1, players });
    // The budget that matters is bytes per second per client, not per frame.
    const perSecond = bytes.length * NET.snapshotRate;
    expect(perSecond).toBeLessThan(64 * 1024);
  });
});

describe('inputs', () => {
  it('round-trips a batch', () => {
    const batch = [
      input(1, { moveForward: 1, buttons: InputFlag.Sprint }),
      input(2, { moveRight: -1, yaw: 0.5, pitch: -0.25 }),
      input(3, { buttons: InputFlag.Fire | InputFlag.Ads, weaponSlot: 1 }),
    ];
    const back = decodeInputs(encodeInputs(batch));

    expect(back).toHaveLength(3);
    expect(back[0]!.moveForward).toBeCloseTo(1, 2);
    expect(back[0]!.buttons).toBe(InputFlag.Sprint);
    expect(back[1]!.yaw).toBeCloseTo(0.5, 3);
    expect(back[2]!.buttons).toBe(InputFlag.Fire | InputFlag.Ads);
    expect(back[2]!.weaponSlot).toBe(1);
  });

  it('caps a batch at the protocol limit, keeping the newest', () => {
    // An unbounded batch is a client asking the server to simulate a minute of
    // movement in one go, which is the cheapest speed hack there is. When it is
    // trimmed, the recent inputs are the ones worth having.
    const batch = Array.from({ length: NET.maxInputsPerPacket + 20 }, (_, i) => input(i + 1));
    const back = decodeInputs(encodeInputs(batch));

    expect(back).toHaveLength(NET.maxInputsPerPacket);
    expect(back[back.length - 1]!.seq).toBe(batch[batch.length - 1]!.seq);
  });
});

describe('control frames', () => {
  it('round-trips JSON payloads inside the binary envelope', () => {
    const bytes = encodeControl(NetMessage.Welcome, { yourId: 3, mapId: 'subway' });
    expect(peekType(bytes)).toBe(NetMessage.Welcome);
    const { type, payload } = decodeControl<{ yourId: number; mapId: string }>(bytes);
    expect(type).toBe(NetMessage.Welcome);
    expect(payload.yourId).toBe(3);
    expect(payload.mapId).toBe('subway');
  });
});

// ---------------------------------------------------------------------------

describe('the authoritative room', () => {
  it('welcomes a client and gives it a player', () => {
    const server = new GameServer({ mapId: 'crossfire', modeId: 'tdm' });
    const link = new FakeLink();

    const id = server.join(link, hello('Alice'));
    expect(id).not.toBeNull();

    const { type, payload } = decodeControl<{ yourId: number; tickRate: number }>(link.sent[0]!);
    expect(type).toBe(NetMessage.Welcome);
    expect(payload.yourId).toBe(id);
    expect(payload.tickRate).toBe(64);
    expect(server.sim.world.players.get(id!)?.name).toBe('Alice');
  });

  it('refuses a client on the wrong protocol version', () => {
    // Version skew produces garbled structs rather than an honest failure, so
    // the handshake has to catch it before anything else is read.
    const server = new GameServer({ mapId: 'crossfire', modeId: 'tdm' });
    const link = new FakeLink();

    const id = server.join(link, { ...hello(), protocolVersion: NET.protocolVersion + 1 });
    expect(id).toBeNull();
    expect(link.closed).toContain('protocol');
    expect(peekType(link.sent[0]!)).toBe(NetMessage.Reject);
    expect(server.sim.world.players.size).toBe(0);
  });

  it('moves a player who presses forward, and tells them where they ended up', () => {
    const server = new GameServer({ mapId: 'crossfire', modeId: 'tdm' });
    const link = new FakeLink();
    const id = server.join(link, hello())!;

    const start = { ...server.sim.world.players.get(id)!.position };

    // Where the player was at each tick, so a snapshot can be checked against
    // the tick it claims to describe rather than against wherever the loop
    // happened to stop — snapshots are sent at a third of the tick rate, so the
    // newest one is always a little behind the simulation.
    const history = new Map<number, { x: number; z: number }>();

    let seq = 1;
    for (let i = 0; i < 64; i++) {
      server.receive(id, encodeInputs([input(seq++, { moveForward: 1 })]));
      server.tick();
      const p = server.sim.world.players.get(id)!.position;
      history.set(server.sim.world.tick, { x: p.x, z: p.z });
    }

    const now = server.sim.world.players.get(id)!.position;
    expect(Math.hypot(now.x - start.x, now.z - start.z)).toBeGreaterThan(2);

    const snap = link.lastSnapshot();
    expect(snap).not.toBeNull();
    const mine = snap!.players.find((p) => p.id === id)!;
    const truth = history.get(snap!.tick);
    expect(truth, `snapshot claims tick ${snap!.tick}, which never happened`).toBeDefined();
    expect(mine.x).toBeCloseTo(truth!.x, 2);
    expect(mine.z).toBeCloseTo(truth!.z, 2);
  });

  it('acknowledges the newest input it consumed, per client', () => {
    // Reconciliation is impossible without this: the client replays everything
    // after the ack, so an ack that is wrong or shared replays the wrong inputs.
    const server = new GameServer({ mapId: 'crossfire', modeId: 'tdm' });
    const a = new FakeLink();
    const b = new FakeLink();
    const idA = server.join(a, hello('A'))!;
    const idB = server.join(b, hello('B'))!;

    for (let i = 1; i <= 30; i++) {
      server.receive(idA, encodeInputs([input(i)]));
      if (i <= 10) server.receive(idB, encodeInputs([input(i)]));
      server.tick();
    }

    // B stopped sending at 10 and the server has long since drained its queue,
    // so B's ack is exactly 10 and stays there. A is still being fed, so its ack
    // trails the newest input by however long ago the last snapshot went out —
    // what matters is that the two numbers are each client's own.
    expect(b.lastSnapshot()!.ackedInput).toBe(10);
    expect(a.lastSnapshot()!.ackedInput).toBeGreaterThan(20);
    expect(a.lastSnapshot()!.ackedInput).toBeLessThanOrEqual(30);
  });

  it('sends snapshots at the snapshot rate, not the tick rate', () => {
    // Sending the world every tick is bandwidth spent on frames the client
    // interpolates through anyway.
    const server = new GameServer({ mapId: 'crossfire', modeId: 'tdm' });
    const link = new FakeLink();
    server.join(link, hello());

    for (let i = 0; i < 64; i++) server.tick();

    const snapshots = link.countOf(NetMessage.Snapshot);
    expect(snapshots).toBeGreaterThanOrEqual(NET.snapshotRate - 2);
    expect(snapshots).toBeLessThanOrEqual(NET.snapshotRate + 2);
  });

  it('clamps a client claiming an enormous timestep', () => {
    // The simulation advances a player by the time their command claims to
    // cover, so an unclamped dt is a free teleport.
    const honest = new GameServer({ mapId: 'crossfire', modeId: 'tdm', seed: 'clamp' });
    const cheat = new GameServer({ mapId: 'crossfire', modeId: 'tdm', seed: 'clamp' });
    const hl = new FakeLink();
    const cl = new FakeLink();
    const hid = honest.join(hl, hello())!;
    const cid = cheat.join(cl, hello())!;

    const hStart = { ...honest.sim.world.players.get(hid)!.position };
    const cStart = { ...cheat.sim.world.players.get(cid)!.position };

    for (let i = 1; i <= 32; i++) {
      honest.receive(hid, encodeInputs([input(i, { moveForward: 1, dt: TICK_DT })]));
      cheat.receive(cid, encodeInputs([input(i, { moveForward: 1, dt: 5 })]));
      honest.tick();
      cheat.tick();
    }

    const h = honest.sim.world.players.get(hid)!.position;
    const c = cheat.sim.world.players.get(cid)!.position;
    const honestDist = Math.hypot(h.x - hStart.x, h.z - hStart.z);
    const cheatDist = Math.hypot(c.x - cStart.x, c.z - cStart.z);

    // Some advantage survives — dt is clamped to a band, not to the tick — but
    // it must be a small multiple rather than the 300x the client asked for.
    expect(cheatDist).toBeLessThan(honestDist * 4 + 1);
  });

  it('ignores inputs it has already folded in', () => {
    // Resends are normal on a lossy link and must not be simulated twice.
    const server = new GameServer({ mapId: 'crossfire', modeId: 'tdm' });
    const link = new FakeLink();
    const id = server.join(link, hello())!;

    const batch = encodeInputs([input(1, { moveForward: 1 })]);
    for (let i = 0; i < 10; i++) server.receive(id, batch);
    server.tick();
    server.tick();

    expect(link.lastSnapshot()?.ackedInput ?? 0).toBeLessThanOrEqual(1);
  });

  it('survives a malformed frame instead of taking the room down with it', () => {
    const server = new GameServer({ mapId: 'crossfire', modeId: 'tdm' });
    const link = new FakeLink();
    const id = server.join(link, hello())!;

    expect(() => {
      server.receive(id, new Uint8Array([NetMessage.Input, 250]));
      server.receive(id, new Uint8Array([NetMessage.Chat, 255, 255]));
      server.receive(id, new Uint8Array([]));
      server.tick();
    }).not.toThrow();

    expect(server.sim.world.players.has(id)).toBe(true);
  });

  it('removes a player who leaves and tells everyone else', () => {
    const server = new GameServer({ mapId: 'crossfire', modeId: 'tdm' });
    const a = new FakeLink();
    const b = new FakeLink();
    const idA = server.join(a, hello('A'))!;
    server.join(b, hello('B'));

    server.leave(idA);

    expect(server.sim.world.players.has(idA)).toBe(false);
    expect(b.countOf(NetMessage.Bye)).toBe(1);
  });

  it('runs a real match with bots and humans in the same world', () => {
    // The point of an authoritative server is that everything already in the
    // game keeps working behind it, bots included.
    const server = new GameServer({ mapId: 'crossfire', modeId: 'tdm', botCount: 6 });
    const link = new FakeLink();
    const id = server.join(link, hello())!;

    let seq = 1;
    let events = 0;
    for (let i = 0; i < 64 * 30; i++) {
      if (i % 4 === 0) server.receive(id, encodeInputs([input(seq++, { moveForward: 1 })]));
      events += server.tick().length;
    }

    expect(server.sim.world.players.size).toBe(7);
    expect(events).toBeGreaterThan(0);
    const snap = link.lastSnapshot()!;
    expect(snap.players).toHaveLength(7);
    expect(snap.players.filter((p) => p.isBot)).toHaveLength(6);
  }, 30_000);
});
