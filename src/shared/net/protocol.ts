/**
 * The wire protocol.
 *
 * One envelope, two payload styles, and the split is deliberate:
 *
 *   - **Snapshots and inputs are packed binary.** They are the high-rate path —
 *     a snapshot goes to every client twenty times a second and carries every
 *     player in the match — so their size is the whole bandwidth budget.
 *   - **Everything else is UTF-8 JSON inside the same envelope.** A hello, a
 *     loadout, a chat line and a disconnect happen once or twice each. Hand
 *     packing them would buy nothing and cost a class of bug where a field is
 *     added to a struct and silently not written.
 *
 * A frame is always `[u8 type][payload]`, so a reader can dispatch before it
 * knows anything else.
 *
 * IMPORTANT: a snapshot is NOT a serialised `PlayerState`. `PlayerState` has
 * some sixty fields, most of which are the simulation's private business —
 * slide cooldowns, mantle interpolation endpoints, sprint-out latches. What a
 * remote client needs is the much smaller set below, and writing that set out
 * explicitly is what stops the wire format from growing every time somebody adds
 * a timer to the movement controller.
 */

import { NET } from '../constants.js';
import type { PlayerId } from '../types.js';

export enum NetMessage {
  /** Client → server, first thing after the socket opens. */
  Hello = 1,
  /** Server → client, accepting the connection and describing the match. */
  Welcome = 2,
  /** Server → client, refusing it. */
  Reject = 3,
  /** Client → server, a batch of unacknowledged input commands. */
  Input = 4,
  /** Server → client, the authoritative world. */
  Snapshot = 5,
  /** Server → client, the tick's simulation events, for HUD and audio. */
  Events = 6,
  /** Either direction, for round-trip timing and liveness. */
  Ping = 7,
  Pong = 8,
  /** Client → server. */
  Respawn = 9,
  Chat = 10,
  /** Server → client, someone left. */
  Bye = 11,
}

// ---------------------------------------------------------------------------
// What a remote player looks like on the wire
// ---------------------------------------------------------------------------

export interface PlayerSnapshot {
  id: PlayerId;
  team: number;
  alive: boolean;
  onGround: boolean;
  isBot: boolean;
  stance: number;
  moveState: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  pitch: number;
  /** 0..255, quantised from the 0..100 the simulation uses. */
  health: number;
  weaponSlot: number;
  /** -1..1. */
  lean: number;
}

export interface Snapshot {
  tick: number;
  serverTime: number;
  /**
   * The last input sequence from *this* client the server has folded in.
   *
   * Per-recipient, which is why a snapshot is encoded once per client rather
   * than broadcast byte-identical. Without it the client cannot know which of
   * its predicted inputs to replay, and reconciliation is impossible.
   */
  ackedInput: number;
  players: PlayerSnapshot[];
}

// ---------------------------------------------------------------------------
// Control payloads (JSON)
// ---------------------------------------------------------------------------

export interface HelloPayload {
  protocolVersion: number;
  name: string;
  /** Serialised Loadout. Validated server-side; never trusted. */
  loadout: unknown;
}

export interface WelcomePayload {
  yourId: PlayerId;
  mapId: string;
  modeId: string;
  seed: string;
  tickRate: number;
  snapshotRate: number;
}

export interface RejectPayload {
  reason: string;
}

export interface ByePayload {
  id: PlayerId;
  reason: string;
}

export interface ChatPayload {
  from: PlayerId;
  text: string;
}

// ---------------------------------------------------------------------------
// Buffer primitives
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class Writer {
  private view: DataView;
  private bytes: Uint8Array;
  private offset = 0;

  constructor(capacity = 64 * 1024) {
    this.bytes = new Uint8Array(capacity);
    this.view = new DataView(this.bytes.buffer);
  }

  private need(n: number): void {
    if (this.offset + n <= this.bytes.length) return;
    // Growing is not expected on the hot path — the default capacity holds a
    // full lobby — but a silent overflow would corrupt a frame, so grow rather
    // than truncate.
    const grown = new Uint8Array(Math.max(this.bytes.length * 2, this.offset + n));
    grown.set(this.bytes);
    this.bytes = grown;
    this.view = new DataView(grown.buffer);
  }

  u8(v: number): void {
    this.need(1);
    this.view.setUint8(this.offset++, v);
  }
  i8(v: number): void {
    this.need(1);
    this.view.setInt8(this.offset++, v);
  }
  u16(v: number): void {
    this.need(2);
    this.view.setUint16(this.offset, v, true);
    this.offset += 2;
  }
  u32(v: number): void {
    this.need(4);
    this.view.setUint32(this.offset, v >>> 0, true);
    this.offset += 4;
  }
  f32(v: number): void {
    this.need(4);
    this.view.setFloat32(this.offset, v, true);
    this.offset += 4;
  }
  /** A length-prefixed UTF-8 string. */
  str(v: string): void {
    const b = encoder.encode(v);
    this.u16(b.length);
    this.need(b.length);
    this.bytes.set(b, this.offset);
    this.offset += b.length;
  }

  finish(): Uint8Array {
    return this.bytes.slice(0, this.offset);
  }
}

export class Reader {
  private view: DataView;
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get done(): boolean {
    return this.offset >= this.view.byteLength;
  }

  u8(): number {
    return this.view.getUint8(this.offset++);
  }
  i8(): number {
    return this.view.getInt8(this.offset++);
  }
  u16(): number {
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }
  u32(): number {
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }
  f32(): number {
    const v = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return v;
  }
  str(): string {
    const n = this.u16();
    const s = decoder.decode(new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, n));
    this.offset += n;
    return s;
  }
}

// ---------------------------------------------------------------------------
// Angles
// ---------------------------------------------------------------------------

const ANGLE_SCALE = 65536 / (Math.PI * 2);

/**
 * Angles go over the wire as unsigned 16-bit turns.
 *
 * Two bytes gives a resolution of about 0.005 degrees, which is far finer than
 * any mouse movement a player can make and a quarter the size of a float. It
 * also wraps for free, which is the real reason: an angle sent as a float has to
 * be normalised on both ends and disagrees about whether -π and π are the same
 * number.
 */
export function packAngle(radians: number): number {
  const turns = radians * ANGLE_SCALE;
  return ((turns % 65536) + 65536) % 65536 | 0;
}

export function unpackAngle(packed: number): number {
  const a = packed / ANGLE_SCALE;
  return a > Math.PI ? a - Math.PI * 2 : a;
}

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

/** Wrap a JSON control payload in the standard envelope. */
export function encodeControl(type: NetMessage, payload: unknown): Uint8Array {
  const w = new Writer(1024);
  w.u8(type);
  w.str(JSON.stringify(payload));
  return w.finish();
}

export function decodeControl<T>(bytes: Uint8Array): { type: NetMessage; payload: T } {
  const r = new Reader(bytes);
  const type = r.u8() as NetMessage;
  return { type, payload: JSON.parse(r.str()) as T };
}

/** Read just the type byte, so a receiver can dispatch before decoding. */
export function peekType(bytes: Uint8Array): NetMessage {
  return bytes[0] as NetMessage;
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

const FLAG_ALIVE = 1 << 0;
const FLAG_ON_GROUND = 1 << 1;
const FLAG_BOT = 1 << 2;

export function encodeSnapshot(snap: Snapshot): Uint8Array {
  const w = new Writer(8 * 1024);
  w.u8(NetMessage.Snapshot);
  w.u32(snap.tick);
  w.f32(snap.serverTime);
  w.u32(snap.ackedInput);
  w.u16(snap.players.length);

  for (const p of snap.players) {
    w.u16(p.id);
    w.u8(
      (p.alive ? FLAG_ALIVE : 0) | (p.onGround ? FLAG_ON_GROUND : 0) | (p.isBot ? FLAG_BOT : 0),
    );
    w.u8(p.team);
    w.u8(p.stance);
    w.u8(p.moveState);
    w.f32(p.x);
    w.f32(p.y);
    w.f32(p.z);
    w.f32(p.vx);
    w.f32(p.vy);
    w.f32(p.vz);
    w.u16(packAngle(p.yaw));
    w.u16(packAngle(p.pitch));
    w.u8(p.health);
    w.u8(p.weaponSlot);
    w.i8(Math.round(p.lean * 127));
  }

  return w.finish();
}

export function decodeSnapshot(bytes: Uint8Array): Snapshot {
  const r = new Reader(bytes);
  r.u8(); // type
  const tick = r.u32();
  const serverTime = r.f32();
  const ackedInput = r.u32();
  const count = r.u16();

  const players: PlayerSnapshot[] = [];
  for (let i = 0; i < count; i++) {
    const id = r.u16();
    const flags = r.u8();
    players.push({
      id,
      alive: (flags & FLAG_ALIVE) !== 0,
      onGround: (flags & FLAG_ON_GROUND) !== 0,
      isBot: (flags & FLAG_BOT) !== 0,
      team: r.u8(),
      stance: r.u8(),
      moveState: r.u8(),
      x: r.f32(),
      y: r.f32(),
      z: r.f32(),
      vx: r.f32(),
      vy: r.f32(),
      vz: r.f32(),
      yaw: unpackAngle(r.u16()),
      pitch: unpackAngle(r.u16()),
      health: r.u8(),
      weaponSlot: r.u8(),
      lean: r.i8() / 127,
    });
  }

  return { tick, serverTime, ackedInput, players };
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * What a client sends. A subset of `InputCommand`: the fields the server needs
 * to re-run movement and weapons, and nothing it can derive itself.
 */
export interface WireInput {
  seq: number;
  tick: number;
  dt: number;
  moveForward: number;
  moveRight: number;
  yaw: number;
  pitch: number;
  buttons: number;
  weaponSlot: number;
}

export function encodeInputs(inputs: readonly WireInput[]): Uint8Array {
  const w = new Writer(2048);
  w.u8(NetMessage.Input);
  // A client that has been silent batches its backlog, but only so much of it —
  // an unbounded batch is a client asking the server to simulate a minute of
  // movement in one tick, which is the cheapest speed hack there is.
  const n = Math.min(inputs.length, NET.maxInputsPerPacket);
  w.u8(n);
  for (let i = inputs.length - n; i < inputs.length; i++) {
    const c = inputs[i]!;
    w.u32(c.seq);
    w.u32(c.tick);
    w.f32(c.dt);
    w.i8(Math.round(c.moveForward * 127));
    w.i8(Math.round(c.moveRight * 127));
    w.u16(packAngle(c.yaw));
    w.u16(packAngle(c.pitch));
    w.u32(c.buttons);
    w.u8(c.weaponSlot);
  }
  return w.finish();
}

export function decodeInputs(bytes: Uint8Array): WireInput[] {
  const r = new Reader(bytes);
  r.u8();
  const n = r.u8();
  const out: WireInput[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      seq: r.u32(),
      tick: r.u32(),
      dt: r.f32(),
      moveForward: r.i8() / 127,
      moveRight: r.i8() / 127,
      yaw: unpackAngle(r.u16()),
      pitch: unpackAngle(r.u16()),
      buttons: r.u32(),
      weaponSlot: r.u8(),
    });
  }
  return out;
}
