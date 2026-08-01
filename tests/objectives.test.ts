/**
 * Objective mode tests.
 *
 * Objective rules are the part of a shooter players argue about, so each test
 * here pins a rule they would recognise: a contested flag does nothing, a
 * half-capture is not banked, denying a teammate's tag stops the enemy scoring,
 * holding the HQ costs you your respawns.
 *
 * Players are teleported into zones directly rather than driven there by bots —
 * the point is to test the rule, not the pathfinding.
 */

import { describe, expect, it } from 'vitest';

import { TICK_DT } from '../src/shared/constants.js';
import { MatchPhase, Team, type PlayerState } from '../src/shared/types.js';
import { vec3 } from '../src/shared/math.js';
import { PLAYER_RADIUS, STANCE_HEIGHT } from '../src/shared/constants.js';
import { CollisionLayer } from '../src/shared/collision/collision-types.js';
import { GameSimulation } from '../src/shared/sim/game.js';
import { ObjectiveKind } from '../src/shared/map/map-types.js';
import { getMode } from '../src/shared/data/modes.js';

function makeSim(modeId: string): GameSimulation {
  const sim = new GameSimulation({ mapId: 'crossfire', modeId, seed: 'obj' });
  // Skip warmup: these tests are about the live phase.
  sim.world.match.phase = MatchPhase.Live;
  sim.world.match.timeRemaining = getMode(modeId).timeLimit || 600;
  return sim;
}

function addAt(sim: GameSimulation, team: Team, name: string): PlayerState {
  const p = sim.addPlayer({ name, team });
  sim.spawnPlayer(p);
  return p;
}

/** Put a player inside a zone and hold them there while the sim runs. */
function stand(player: PlayerState, at: { x: number; y: number; z: number }): void {
  player.position.x = at.x;
  player.position.y = at.y;
  player.position.z = at.z;
  player.velocity.x = 0;
  player.velocity.y = 0;
  player.velocity.z = 0;
}

function run(sim: GameSimulation, seconds: number, hold: Array<[PlayerState, { x: number; y: number; z: number }]> = []): void {
  const ticks = Math.round(seconds / TICK_DT);
  for (let i = 0; i < ticks; i++) {
    // Re-plant them each tick so gravity and collision don't drift them out.
    for (const [player, at] of hold) stand(player, at);
    sim.step(TICK_DT);
  }
}

/**
 * A point inside an objective zone that a player can actually stand on.
 *
 * The centre of a zone is frequently occupied — Crossfire's B flag is drawn
 * around a fountain — so tests search the zone for free floor rather than
 * assuming the middle is empty. Standing a player inside solid geometry does not
 * test the capture rule, it tests depenetration.
 */
function standablePointIn(
  sim: GameSimulation,
  kind: ObjectiveKind,
  label: string,
): { x: number; y: number; z: number } {
  const obj = sim.map.objectives.find((o) => o.kind === kind && o.label === label);
  if (!obj) throw new Error(`no ${kind} objective ${label}`);

  const filter = { layers: CollisionLayer.Movement };
  // Spiral outward from the centre so we pick the most central free spot.
  for (const r of [0, 1, 2, 3, 4, 5]) {
    for (let a = 0; a < 12; a++) {
      const theta = (a / 12) * Math.PI * 2;
      const x = obj.position.x + Math.cos(theta) * r;
      const z = obj.position.z + Math.sin(theta) * r;
      if (Math.abs(x - obj.position.x) > obj.size.x / 2 - 0.4) continue;
      if (Math.abs(z - obj.position.z) > obj.size.z / 2 - 0.4) continue;

      const ground = sim.collision.groundHeightAt(x, z, obj.position.y + 6, 14);
      if (!Number.isFinite(ground)) continue;
      const feet = vec3(x, ground + 0.05, z);
      if (!sim.collision.isCapsuleFree(feet, STANCE_HEIGHT.stand, PLAYER_RADIUS, filter)) continue;
      return { x, y: ground + 0.05, z };
    }
  }
  throw new Error(`no standable point inside ${kind} ${label}`);
}

function flag(sim: GameSimulation, label: string): { x: number; y: number; z: number } {
  return standablePointIn(sim, ObjectiveKind.DominationFlag, label);
}

/** A patch of open plaza on Crossfire, clear of the fountain and its props. */
const OPEN_GROUND = { x: -14, y: 0.05, z: 4 };

function zoneOwner(sim: GameSimulation, label: string): Team {
  return sim.objectiveStatus().find((z) => z.label === label)?.owner ?? Team.None;
}

function zoneProgress(sim: GameSimulation, label: string): number {
  return sim.objectiveStatus().find((z) => z.label === label)?.progress ?? 0;
}

// ---------------------------------------------------------------------------

describe('Domination', () => {
  it('starts with the authored flag ownership', () => {
    const sim = makeSim('domination');
    expect(zoneOwner(sim, 'A')).toBe(Team.Allies);
    expect(zoneOwner(sim, 'B')).toBe(Team.None);
    expect(zoneOwner(sim, 'C')).toBe(Team.Axis);
  });

  it('captures a neutral flag in roughly the advertised time', () => {
    const sim = makeSim('domination');
    const p = addAt(sim, Team.Allies, 'Cap');
    const b = flag(sim, 'B');

    run(sim, 6, [[p, b]]);
    expect(zoneOwner(sim, 'B'), 'should not have captured yet at 6s').toBe(Team.None);
    expect(zoneProgress(sim, 'B')).toBeGreaterThan(0.4);

    run(sim, 5, [[p, b]]);
    expect(zoneOwner(sim, 'B')).toBe(Team.Allies);
  });

  it('captures faster with more players, but sub-linearly', () => {
    const solo = makeSim('domination');
    const a1 = addAt(solo, Team.Allies, 'A1');
    run(solo, 4, [[a1, flag(solo, 'B')]]);
    const soloProgress = zoneProgress(solo, 'B');

    const pair = makeSim('domination');
    const b1 = addAt(pair, Team.Allies, 'B1');
    const b2 = addAt(pair, Team.Allies, 'B2');
    const zone = flag(pair, 'B');
    run(pair, 4, [[b1, zone], [b2, { ...zone, x: zone.x + 1 }]]);
    const pairProgress = zoneProgress(pair, 'B');

    expect(pairProgress).toBeGreaterThan(soloProgress);
    // Two players must not be twice as fast, or stacking a flag becomes correct.
    expect(pairProgress).toBeLessThan(soloProgress * 2);
  });

  it('makes no progress at all while contested', () => {
    const sim = makeSim('domination');
    const ally = addAt(sim, Team.Allies, 'Ally');
    const axis = addAt(sim, Team.Axis, 'Axis');
    const b = flag(sim, 'B');

    run(sim, 15, [[ally, b], [axis, { ...b, x: b.x + 1.5 }]]);

    expect(zoneOwner(sim, 'B')).toBe(Team.None);
    expect(zoneProgress(sim, 'B')).toBe(0);
  });

  it('does not bank a half-capture when the attacker leaves', () => {
    const sim = makeSim('domination');
    const p = addAt(sim, Team.Allies, 'Quitter');
    const b = flag(sim, 'B');

    run(sim, 5, [[p, b]]);
    const peak = zoneProgress(sim, 'B');
    expect(peak).toBeGreaterThan(0.2);

    // Walk away.
    run(sim, 8, [[p, { x: 0, y: 0, z: 34 }]]);
    expect(zoneProgress(sim, 'B')).toBeLessThan(peak);
  });

  it('ticks team score for every flag held', () => {
    const sim = makeSim('domination');
    const p = addAt(sim, Team.Allies, 'Holder');
    // Allies already own A at the start.
    run(sim, 12, [[p, flag(sim, 'A')]]);

    const allies = sim.world.match.scores.find((s) => s.team === Team.Allies)?.score ?? 0;
    expect(allies).toBeGreaterThan(0);
  });

  it('awards capture credit to the players who took the flag', () => {
    const sim = makeSim('domination');
    const p = addAt(sim, Team.Allies, 'Cap');
    run(sim, 13, [[p, flag(sim, 'B')]]);

    expect(zoneOwner(sim, 'B')).toBe(Team.Allies);
    expect(p.captures).toBeGreaterThan(0);
    expect(p.score).toBeGreaterThan(0);
  });
});

describe('Hardpoint', () => {
  it('has exactly one live zone at a time', () => {
    const sim = makeSim('hardpoint');
    const live = sim.objectiveStatus().filter((z) => z.active);
    expect(live.length).toBe(1);
  });

  it('rotates the zone after the rotation window', () => {
    const sim = makeSim('hardpoint');
    const first = sim.objectiveStatus().find((z) => z.active)?.label;

    // Rotation is 60s, then a 5s gap before the next zone opens.
    run(sim, 70);

    const now = sim.objectiveStatus().find((z) => z.active)?.label;
    expect(now).toBeDefined();
    expect(now).not.toBe(first);
  });

  it('scores for the team holding it and stops while contested', () => {
    const sim = makeSim('hardpoint');
    const zone = sim.objectiveStatus().find((z) => z.active)!;
    const at = standablePointIn(sim, ObjectiveKind.Hardpoint, zone.label);

    const ally = addAt(sim, Team.Allies, 'Holder');
    run(sim, 10, [[ally, at]]);
    const held = sim.world.match.scores.find((s) => s.team === Team.Allies)?.score ?? 0;
    expect(held).toBeGreaterThan(0);

    // Now contest it — scoring must stop dead.
    const axis = addAt(sim, Team.Axis, 'Contester');
    run(sim, 10, [[ally, at], [axis, { ...at, x: at.x + 1 }]]);
    const after = sim.world.match.scores.find((s) => s.team === Team.Allies)?.score ?? 0;
    expect(after).toBe(held);
  });
});

describe('Headquarters', () => {
  it('stops the owning team respawning while they hold it', () => {
    const sim = makeSim('hq');
    const zone = sim.objectiveStatus().find((z) => z.active)!;
    const at = standablePointIn(sim, ObjectiveKind.Headquarters, zone.label);

    const capper = addAt(sim, Team.Allies, 'Capper');
    const mate = addAt(sim, Team.Allies, 'Mate');

    run(sim, 14, [[capper, at]]);
    expect(sim.objectiveStatus().find((z) => z.label === zone.label)?.owner).toBe(Team.Allies);

    // Kill the teammate; they must stay down while their team owns the HQ.
    sim.damagePlayer(mate, {
      amount: 500, attacker: 0, victim: mate.id, cause: 0, weaponId: '',
      location: 'chest', position: vec3(), direction: vec3(0, 1, 0), distance: 0,
      ignoreArmor: true,
    });
    expect(mate.alive).toBe(false);

    run(sim, 12, [[capper, at]]);
    expect(mate.alive, 'HQ owners must not respawn').toBe(false);
  });
});

describe('Search & Destroy', () => {
  it('lets an attacker plant, and detonation wins the round', () => {
    const sim = makeSim('snd');
    const at = standablePointIn(sim, ObjectiveKind.BombSite, 'A');

    const attacker = addAt(sim, Team.Allies, 'Planter');
    addAt(sim, Team.Axis, 'Defender');

    run(sim, 6, [[attacker, at]]);
    expect(sim.objectives.bomb.planted, 'bomb should be planted after 6s').toBe(true);
    expect(attacker.plants).toBe(1);

    // 45s fuse.
    run(sim, 47, [[attacker, at]]);
    const allies = sim.world.match.scores.find((s) => s.team === Team.Allies);
    expect(allies?.roundsWon).toBeGreaterThan(0);
  });

  it('lets a defender defuse, winning the round instead', () => {
    const sim = makeSim('snd');
    const at = standablePointIn(sim, ObjectiveKind.BombSite, 'A');

    const attacker = addAt(sim, Team.Allies, 'Planter');
    const defender = addAt(sim, Team.Axis, 'Defuser');
    // Keep the defender well away while the plant happens.
    run(sim, 6, [[attacker, at], [defender, { x: 0, y: 0, z: -34 }]]);
    expect(sim.objectives.bomb.planted).toBe(true);

    run(sim, 9, [[defender, at], [attacker, { x: 0, y: 0, z: 34 }]]);

    const axis = sim.world.match.scores.find((s) => s.team === Team.Axis);
    expect(axis?.roundsWon).toBeGreaterThan(0);
  });

  it('restarts a defuse that gets interrupted', () => {
    const sim = makeSim('snd');
    const at = standablePointIn(sim, ObjectiveKind.BombSite, 'A');
    const away = { x: 0, y: 0, z: 34 };

    const attacker = addAt(sim, Team.Allies, 'Planter');
    const defender = addAt(sim, Team.Axis, 'Defuser');
    run(sim, 6, [[attacker, at], [defender, { x: 0, y: 0, z: -34 }]]);

    // Start a defuse, then step off before it completes.
    run(sim, 4, [[defender, at], [attacker, away]]);
    expect(sim.objectives.bomb.progress).toBeGreaterThan(0);
    run(sim, 1, [[defender, away], [attacker, away]]);
    expect(sim.objectives.bomb.progress, 'partial defuse must not be banked').toBe(0);
  });
});

describe('Kill Confirmed', () => {
  it('does not score the team for a kill until the tag is collected', () => {
    const sim = makeSim('kc');
    const killer = addAt(sim, Team.Allies, 'Killer');
    const victim = addAt(sim, Team.Axis, 'Victim');
    // Somewhere with actual floor: the world origin on Crossfire is the fountain.
    stand(victim, OPEN_GROUND);

    sim.damagePlayer(victim, {
      amount: 500, attacker: killer.id, victim: victim.id, cause: 0, weaponId: 'vk47',
      location: 'chest', position: vec3(), direction: vec3(0, 0, 1), distance: 5,
      ignoreArmor: true,
    });

    expect(victim.alive).toBe(false);
    expect(sim.objectives.tags.length, 'a tag should have dropped').toBe(1);

    const beforeConfirm = sim.world.match.scores.find((s) => s.team === Team.Allies)?.score ?? 0;
    expect(beforeConfirm, 'the kill alone must not score').toBe(0);

    // Walk the killer onto the tag.
    const tag = sim.objectives.tags[0]!;
    run(sim, 0.5, [[killer, { x: tag.position.x, y: tag.position.y - 0.3, z: tag.position.z }]]);

    const afterConfirm = sim.world.match.scores.find((s) => s.team === Team.Allies)?.score ?? 0;
    expect(afterConfirm).toBeGreaterThan(0);
    expect(sim.objectives.tags.length).toBe(0);
  });

  it('lets a teammate deny the tag so the enemy never scores it', () => {
    const sim = makeSim('kc');
    const killer = addAt(sim, Team.Allies, 'Killer');
    const victim = addAt(sim, Team.Axis, 'Victim');
    const mate = addAt(sim, Team.Axis, 'Mate');
    stand(victim, OPEN_GROUND);

    sim.damagePlayer(victim, {
      amount: 500, attacker: killer.id, victim: victim.id, cause: 0, weaponId: 'vk47',
      location: 'chest', position: vec3(), direction: vec3(0, 0, 1), distance: 5,
      ignoreArmor: true,
    });

    const tag = sim.objectives.tags[0]!;
    run(sim, 0.5, [[mate, { x: tag.position.x, y: tag.position.y - 0.3, z: tag.position.z }]]);

    expect(sim.objectives.tags.length, 'the tag should be denied').toBe(0);
    expect(sim.world.match.scores.find((s) => s.team === Team.Allies)?.score ?? 0).toBe(0);
    expect(mate.score).toBeGreaterThan(0);
  });
});

describe('Team Deathmatch scoring', () => {
  it('adds a team point for every kill, unlike the objective modes', () => {
    const sim = makeSim('tdm');
    const killer = addAt(sim, Team.Allies, 'Killer');
    const victim = addAt(sim, Team.Axis, 'Victim');

    sim.damagePlayer(victim, {
      amount: 500, attacker: killer.id, victim: victim.id, cause: 0, weaponId: 'vk47',
      location: 'chest', position: vec3(), direction: vec3(0, 0, 1), distance: 5,
      ignoreArmor: true,
    });

    expect(sim.world.match.scores.find((s) => s.team === Team.Allies)?.score).toBe(1);
  });
});
