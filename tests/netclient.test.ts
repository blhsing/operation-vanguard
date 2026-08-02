/**
 * Client netcode tests.
 *
 * Prediction and interpolation are the two places where a shooter feels wrong
 * for reasons a player cannot articulate, and both are pure enough to test
 * exactly. There is no socket here: `Predictor` takes a collision world and
 * `SnapshotBuffer` takes snapshots, so both can be driven against the real
 * movement code with nothing else attached.
 *
 * The assertions are all about what the player experiences — you move on the
 * frame you pressed the key, an agreeing server never jerks you, a disagreeing
 * one moves you once and only once, and nobody spins the long way round the
 * compass.
 */

import { describe, expect, it } from 'vitest';

import { NET, TICK_DT } from '../src/shared/constants.js';
import { GameSimulation } from '../src/shared/sim/game.js';
import { Team, createEmptyInput, type InputCommand, type PlayerState } from '../src/shared/types.js';
import { Predictor } from '../src/client/net/prediction.js';
import { SnapshotBuffer, lerpAngle } from '../src/client/net/snapshot-buffer.js';
import type { PlayerSnapshot, Snapshot } from '../src/shared/net/protocol.js';

// ---------------------------------------------------------------------------

/** A real world with real collision, because prediction has to match the server. */
function world() {
  const sim = new GameSimulation({ mapId: 'crossfire', modeId: 'tdm', seed: 'predict' });
  const player = sim.addPlayer({ name: 'Me', team: Team.Allies, isBot: false });
  sim.spawnPlayer(player);
  return { sim, player };
}

function forward(seq: number): InputCommand {
  const c = createEmptyInput();
  c.seq = seq;
  c.tick = seq;
  c.dt = TICK_DT;
  c.moveForward = 1;
  return c;
}

function snapshotOf(player: PlayerState, over: Partial<PlayerSnapshot> = {}): PlayerSnapshot {
  return {
    id: player.id,
    team: player.team,
    alive: player.alive,
    onGround: player.onGround,
    isBot: false,
    stance: player.stance,
    moveState: player.moveState,
    x: player.position.x,
    y: player.position.y,
    z: player.position.z,
    vx: player.velocity.x,
    vy: player.velocity.y,
    vz: player.velocity.z,
    yaw: player.yaw,
    pitch: player.pitch,
    health: player.health,
    weaponSlot: 0,
    lean: 0,
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe('prediction', () => {
  it('moves the player on the tick the key was pressed', () => {
    // The whole reason prediction exists. Waiting a round trip for this is what
    // makes an otherwise fine connection feel broken.
    const { sim, player } = world();
    const predictor = new Predictor(sim.collision);
    const before = { ...player.position };

    predictor.predict(player, forward(1));

    expect(player.position).not.toEqual(before);
    expect(predictor.unacknowledged()).toHaveLength(1);
  });

  it('keeps every input until the server acknowledges it', () => {
    const { sim, player } = world();
    const predictor = new Predictor(sim.collision);

    for (let i = 1; i <= 20; i++) predictor.predict(player, forward(i));
    expect(predictor.unacknowledged()).toHaveLength(20);

    predictor.reconcile(player, snapshotOf(player), 12);
    // Twelve folded in by the server, eight still in flight.
    expect(predictor.unacknowledged()).toHaveLength(8);
  });

  it('stores copies, not the caller’s one reused input object', () => {
    // The input path is allocation-free and hands the same object back every
    // tick. Storing the reference would give a buffer of N pointers to one
    // mutating command, and replay would apply the newest input N times.
    const { sim, player } = world();
    const predictor = new Predictor(sim.collision);

    const reused = forward(1);
    predictor.predict(player, reused);
    reused.seq = 2;
    reused.moveForward = -1;
    predictor.predict(player, reused);

    const [first, second] = predictor.unacknowledged();
    expect(first!.seq).toBe(1);
    expect(first!.moveForward).toBe(1);
    expect(second!.seq).toBe(2);
  });

  it('does not move the player when the server agrees', () => {
    // The common case, and the one that has to be invisible: replaying the
    // unacknowledged inputs against the same movement code must land in the
    // same place prediction already reached.
    const { sim, player } = world();
    const predictor = new Predictor(sim.collision);

    for (let i = 1; i <= 10; i++) predictor.predict(player, forward(i));

    // The server ran exactly the same inputs, so its answer for input 4 is what
    // the client had after input 4. Reproduce that by replaying from a copy.
    const replay = world();
    const truthPredictor = new Predictor(replay.sim.collision);
    for (let i = 1; i <= 4; i++) truthPredictor.predict(replay.player, forward(i));

    const predicted = { ...player.position };
    predictor.reconcile(player, snapshotOf(replay.player), 4);

    expect(player.position.x).toBeCloseTo(predicted.x, 3);
    expect(player.position.z).toBeCloseTo(predicted.z, 3);
    expect(predictor.stats().mispredictions).toBe(0);
  });

  it('corrects the player exactly once when the server disagrees', () => {
    const { sim, player } = world();
    const predictor = new Predictor(sim.collision);

    for (let i = 1; i <= 6; i++) predictor.predict(player, forward(i));

    // The server says they were somewhere else entirely — hit by an explosion,
    // or the client mispredicted a collision.
    const truth = snapshotOf(player, { x: player.position.x + 5 });
    predictor.reconcile(player, truth, 6);

    expect(predictor.stats().mispredictions).toBe(1);
    expect(predictor.stats().lastCorrection).toBeGreaterThan(4);
    // Nothing left to replay, so the player is exactly where the server says.
    expect(player.position.x).toBeCloseTo(truth.x, 4);

    // And a second reconcile against the same truth is not a second correction.
    predictor.reconcile(player, snapshotOf(player), 6);
    expect(predictor.stats().mispredictions).toBe(1);
  });

  it('leaves the player’s aim alone', () => {
    // Their hand is on the mouse. The server's copy of where they were looking a
    // round trip ago is strictly worse than the one in front of them, and
    // snapping it back is the single most hated netcode bug there is.
    const { sim, player } = world();
    const predictor = new Predictor(sim.collision);

    player.yaw = 1.5;
    player.pitch = -0.3;
    predictor.reconcile(player, snapshotOf(player, { yaw: -2.8, pitch: 0.9 }), 0);

    expect(player.yaw).toBe(1.5);
    expect(player.pitch).toBe(-0.3);
  });
});

describe('interpolation', () => {
  const at = (t: number, x: number, yaw = 0): Snapshot => ({
    tick: Math.round(t * 64),
    serverTime: t,
    ackedInput: 0,
    players: [
      {
        id: 1,
        team: Team.Axis,
        alive: true,
        onGround: true,
        isBot: false,
        stance: 0,
        moveState: 0,
        x,
        y: 0,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        yaw,
        pitch: 0,
        health: 100,
        weaponSlot: 0,
        lean: 0,
      },
    ],
  });

  it('renders remote players between the two snapshots that bracket the render time', () => {
    const buffer = new SnapshotBuffer();
    // Interpolation delay is two snapshot intervals, so with snapshots at 0.0
    // through 0.2 the render time is 0.1 — squarely between two of them.
    buffer.push(at(0.0, 0));
    buffer.push(at(0.05, 5));
    buffer.push(at(0.1, 10));
    buffer.push(at(0.15, 15));
    buffer.push(at(0.2, 20));

    const [p] = buffer.sample();
    expect(p!.x).toBeCloseTo(10, 4);
  });

  it('keeps moving between packets instead of freezing', () => {
    // Without advancing the render clock, remote players stop dead every time a
    // snapshot is late — which is exactly when smoothness matters most.
    const buffer = new SnapshotBuffer();
    buffer.push(at(0.0, 0));
    buffer.push(at(0.1, 10));
    buffer.push(at(0.2, 20));

    const still = buffer.sample(0)[0]!.x;
    const later = buffer.sample(0.025)[0]!.x;
    expect(later).toBeGreaterThan(still);
  });

  it('does not extrapolate past the newest snapshot it holds', () => {
    // Inventing motion looks worse than a brief stall and puts players through
    // walls.
    const buffer = new SnapshotBuffer();
    buffer.push(at(0.0, 0));
    buffer.push(at(0.1, 10));

    const p = buffer.sample(10)[0]!;
    expect(p.x).toBeLessThanOrEqual(10);
  });

  it('accepts snapshots that arrive out of order', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(at(0.2, 20));
    buffer.push(at(0.0, 0));
    buffer.push(at(0.1, 10));

    expect(buffer.latest!.serverTime).toBeCloseTo(0.2, 6);
    expect(buffer.sample()[0]!.x).toBeCloseTo(10, 4);
  });

  it('drops a player who left rather than interpolating them back', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(at(0.0, 0));
    const gone: Snapshot = { ...at(0.2, 20), players: [] };
    buffer.push(gone);

    expect(buffer.sample(0).find((p) => p.id === 1)).toBeUndefined();
  });

  it('forgets history rather than growing without bound', () => {
    const buffer = new SnapshotBuffer();
    for (let i = 0; i < 500; i++) buffer.push(at(i * (1 / NET.snapshotRate), i));
    expect(buffer.size).toBeLessThan(NET.snapshotRate * 4);
  });

  it('turns the short way round the compass', () => {
    // A player spinning through north goes 3.1 -> -3.1, and a plain lerp sends
    // them the long way round at high speed. It is the most obvious artefact in
    // a badly interpolated shooter.
    expect(lerpAngle(3.1, -3.1, 0.5)).toBeCloseTo(Math.PI, 2);
    expect(lerpAngle(-3.1, 3.1, 0.5)).toBeCloseTo(-Math.PI, 2);
    expect(lerpAngle(0, 1, 0.5)).toBeCloseTo(0.5, 6);
  });
});
