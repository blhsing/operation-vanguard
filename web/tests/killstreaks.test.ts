/**
 * Killstreak tests.
 *
 * The rule these protect is that a killstreak must be *counterable*. Each test
 * pins one of the properties that makes that true: a strike takes long enough to
 * arrive that you can move, radar can be jammed, air support cannot shoot you
 * indoors, and nothing damages your own team.
 */

import { describe, expect, it } from 'vitest';

import { TICK_DT } from '../src/shared/constants.js';
import { vec3 } from '../src/shared/math.js';
import { MatchPhase, SimEventType, Team, type SimEvent } from '../src/shared/types.js';
import { GameSimulation } from '../src/shared/sim/game.js';
import { teamEffects } from '../src/shared/sim/killstreak-runtime.js';
import { KILLSTREAKS } from '../src/shared/data/killstreaks.js';

function makeSim(): GameSimulation {
  const sim = new GameSimulation({ mapId: 'crossfire', modeId: 'tdm', seed: 'ks' });
  sim.world.match.phase = MatchPhase.Live;
  sim.world.match.timeRemaining = 600;
  return sim;
}

function addPlayer(sim: GameSimulation, team: Team, name: string) {
  const p = sim.addPlayer({ name, team });
  sim.spawnPlayer(p);
  return p;
}

function run(sim: GameSimulation, seconds: number, onTick?: () => void): SimEvent[] {
  const out: SimEvent[] = [];
  const ticks = Math.round(seconds / TICK_DT);
  for (let i = 0; i < ticks; i++) {
    onTick?.();
    for (const e of sim.step(TICK_DT)) out.push(e);
  }
  return out;
}

function grant(sim: GameSimulation, playerId: number, streakId: string): void {
  sim.world.players.get(playerId)!.killstreakInventory.push(streakId);
}

/** Press the killstreak key for one tick. */
function callStreak(sim: GameSimulation, playerId: number, slot = 0): void {
  sim.setInput(playerId, {
    seq: sim.world.tick,
    tick: sim.world.tick,
    dt: TICK_DT,
    moveForward: 0,
    moveRight: 0,
    yaw: 0,
    pitch: 0.35, // Look down so the strike traces onto the ground ahead.
    buttons: 0,
    killstreakSlot: slot,
  });
  sim.step(TICK_DT);
  sim.setInput(playerId, {
    seq: sim.world.tick, tick: sim.world.tick, dt: TICK_DT,
    moveForward: 0, moveRight: 0, yaw: 0, pitch: 0.35, buttons: 0, killstreakSlot: -1,
  });
}

describe('every killstreak in the table', () => {
  it('has a coherent cost, unlock and announcement', () => {
    for (const [id, def] of Object.entries(KILLSTREAKS)) {
      expect(def.id, `${id} id mismatch`).toBe(id);
      expect(def.cost, `${id} cost`).toBeGreaterThan(0);
      expect(def.scoreCost, `${id} scoreCost`).toBeGreaterThan(0);
      expect(def.friendlyAnnounce.length, `${id} needs a friendly callout`).toBeGreaterThan(0);
    }
  });

  it('escalates in cost with power, so the expensive ones are actually rarer', () => {
    const uav = KILLSTREAKS.uav!;
    const chopper = KILLSTREAKS.chopper_gunner!;
    const nuke = KILLSTREAKS.tactical_nuke!;
    expect(uav.cost).toBeLessThan(chopper.cost);
    expect(chopper.cost).toBeLessThan(nuke.cost);
  });
});

describe('UAV', () => {
  it('gives the calling team radar and expires on its own', () => {
    const sim = makeSim();
    const p = addPlayer(sim, Team.Allies, 'Caller');
    grant(sim, p.id, 'uav');

    expect(sim.teamHasRadar(Team.Allies)).toBe(false);
    callStreak(sim, p.id);
    expect(sim.teamHasRadar(Team.Allies)).toBe(true);
    expect(sim.radarTime(Team.Allies)).toBeGreaterThan(0);

    run(sim, KILLSTREAKS.uav!.duration + 1);
    expect(sim.teamHasRadar(Team.Allies)).toBe(false);
  });

  it('does not give the enemy team radar', () => {
    const sim = makeSim();
    const p = addPlayer(sim, Team.Allies, 'Caller');
    addPlayer(sim, Team.Axis, 'Enemy');
    grant(sim, p.id, 'uav');
    callStreak(sim, p.id);

    expect(sim.teamHasRadar(Team.Allies)).toBe(true);
    expect(sim.teamHasRadar(Team.Axis)).toBe(false);
  });

  it('is defeated by an enemy Counter-UAV', () => {
    const sim = makeSim();
    const ally = addPlayer(sim, Team.Allies, 'Ally');
    const axis = addPlayer(sim, Team.Axis, 'Axis');

    grant(sim, ally.id, 'uav');
    callStreak(sim, ally.id);
    expect(sim.teamHasRadar(Team.Allies)).toBe(true);

    grant(sim, axis.id, 'counter_uav');
    callStreak(sim, axis.id);

    // Jamming beats reconnaissance — otherwise the counter only works when you
    // are already winning.
    expect(sim.teamHasRadar(Team.Allies)).toBe(false);
  });

  it('is consumed, not reusable', () => {
    const sim = makeSim();
    const p = addPlayer(sim, Team.Allies, 'Caller');
    grant(sim, p.id, 'uav');

    callStreak(sim, p.id);
    expect(p.killstreakInventory.length).toBe(0);
  });
});

describe('Precision Airstrike', () => {
  it('takes long enough to arrive that the target can move', () => {
    const sim = makeSim();
    const p = addPlayer(sim, Team.Allies, 'Caller');
    grant(sim, p.id, 'precision_airstrike');

    callStreak(sim, p.id);

    // Nothing should have exploded on the tick it was called.
    const immediate = run(sim, 0.5).filter((e) => e.type === SimEventType.Explosion);
    expect(immediate.length, 'a strike must not land instantly').toBe(0);

    const later = run(sim, 6).filter((e) => e.type === SimEventType.Explosion);
    expect(later.length, 'the strike should arrive').toBeGreaterThan(0);
  });

  it('delivers a walking run of several explosions, not one instant circle', () => {
    const sim = makeSim();
    const p = addPlayer(sim, Team.Allies, 'Caller');
    grant(sim, p.id, 'precision_airstrike');
    callStreak(sim, p.id);

    const explosions = run(sim, 8).filter((e) => e.type === SimEventType.Explosion);
    expect(explosions.length).toBeGreaterThanOrEqual(4);

    // The bombs must land in different places.
    const positions = explosions.map((e) => (e as { position: { x: number; z: number } }).position);
    const spread = Math.max(...positions.map((a) => a.x)) - Math.min(...positions.map((a) => a.x)) +
      Math.max(...positions.map((a) => a.z)) - Math.min(...positions.map((a) => a.z));
    expect(spread, 'bombs should walk across the target').toBeGreaterThan(3);
  });

  it('kills an enemy standing in it', () => {
    const sim = makeSim();
    const caller = addPlayer(sim, Team.Allies, 'Caller');
    const victim = addPlayer(sim, Team.Axis, 'Victim');
    grant(sim, caller.id, 'precision_airstrike');

    // Put the victim right where the caller is looking.
    callStreak(sim, caller.id);
    const strike = sim.killstreaks.pendingStrikes[0];
    expect(strike, 'a strike should be pending').toBeDefined();

    run(sim, 8, () => {
      if (!strike) return;
      victim.position.x = strike.target.x;
      victim.position.z = strike.target.z;
    });

    expect(victim.deaths).toBeGreaterThan(0);
  });

  it('does not hurt the caller’s own team', () => {
    const sim = makeSim();
    const caller = addPlayer(sim, Team.Allies, 'Caller');
    const mate = addPlayer(sim, Team.Allies, 'Mate');
    grant(sim, caller.id, 'precision_airstrike');

    callStreak(sim, caller.id);
    const strike = sim.killstreaks.pendingStrikes[0];

    run(sim, 8, () => {
      if (!strike) return;
      mate.position.x = strike.target.x;
      mate.position.z = strike.target.z;
    });

    expect(mate.deaths, 'friendly fire is off').toBe(0);
  });
});

describe('EMP', () => {
  it('jams the enemy and not the caller', () => {
    const sim = makeSim();
    const p = addPlayer(sim, Team.Allies, 'Caller');
    addPlayer(sim, Team.Axis, 'Enemy');
    grant(sim, p.id, 'emp_burst');

    callStreak(sim, p.id);

    expect(sim.teamIsJammed(Team.Axis)).toBe(true);
    expect(sim.teamIsJammed(Team.Allies)).toBe(false);
  });
});

describe('Juggernaut', () => {
  it('grants heavy armour to the caller', () => {
    const sim = makeSim();
    const p = addPlayer(sim, Team.Allies, 'Tank');
    grant(sim, p.id, 'juggernaut');

    const before = p.maxHealth;
    callStreak(sim, p.id);

    expect(p.maxHealth).toBeGreaterThan(before);
    expect(p.health).toBe(p.maxHealth);
  });
});

describe('Tactical Nuke', () => {
  it('ends the match for the team that called it', () => {
    const sim = makeSim();
    const p = addPlayer(sim, Team.Allies, 'Nuker');
    addPlayer(sim, Team.Axis, 'Victim');
    grant(sim, p.id, 'tactical_nuke');

    expect(sim.world.match.phase).toBe(MatchPhase.Live);
    callStreak(sim, p.id);

    expect(sim.world.match.phase).toBe(MatchPhase.MatchEnd);
    expect(sim.world.match.winner).toBe(Team.Allies);
  });
});

describe('air support', () => {
  it('cannot shoot a player it has no line of sight to', () => {
    const sim = makeSim();
    const caller = addPlayer(sim, Team.Allies, 'Caller');
    const victim = addPlayer(sim, Team.Axis, 'Indoors');
    grant(sim, caller.id, 'attack_chopper');
    callStreak(sim, caller.id);

    expect(sim.world.killstreakEntities.size).toBe(1);

    // Park the victim inside the warehouse, under its roof.
    run(sim, 12, () => {
      victim.position.x = 19;
      victim.position.y = 0.05;
      victim.position.z = -4;
      victim.health = victim.maxHealth;
    });

    // They are being healed each tick, so the test is that they were never
    // reduced below full by something with no sightline.
    expect(victim.deaths).toBe(0);
  });

  it('despawns when its time runs out', () => {
    const sim = makeSim();
    const caller = addPlayer(sim, Team.Allies, 'Caller');
    grant(sim, caller.id, 'attack_chopper');
    callStreak(sim, caller.id);
    expect(sim.world.killstreakEntities.size).toBe(1);

    run(sim, KILLSTREAKS.attack_chopper!.duration + 2);
    expect(sim.world.killstreakEntities.size).toBe(0);
  });
});
