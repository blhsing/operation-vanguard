/**
 * Placed equipment tests.
 *
 * These protect the rule that makes traps fair rather than infuriating: anything
 * that kills you must be visible and avoidable first. Mines arm with a delay,
 * only watch their own front arc, and can be shot. Nothing here kills through a
 * wall or the instant it hits the ground.
 *
 * They also pin the distinction that was broken before this existed — placed
 * equipment is PLACED, not thrown. A claymore that arcs across the map on a fuse
 * is a bad grenade, not a claymore.
 */

import { describe, expect, it } from 'vitest';

import { TICK_DT } from '../src/shared/constants.js';
import { anglesToForward, vec3 } from '../src/shared/math.js';
import {
  DeployableKind,
  InputFlag,
  MatchPhase,
  Team,
  createEmptyInput,
  type DeployableState,
  type PlayerState,
} from '../src/shared/types.js';
import { GameSimulation } from '../src/shared/sim/game.js';
import { defaultLoadout } from '../src/shared/sim/loadout.js';
import { deployableSpec } from '../src/shared/sim/deployables.js';
import { resolveExplosion, type ExplosionTarget } from '../src/shared/sim/combat.js';

/**
 * A wide, flat, prop-free patch of the Crossfire plaza.
 *
 * Tests move the owner here before placing anything, because left at a real
 * spawn point they become environment-dependent in ways that read as product
 * bugs. The first draft put the owner behind sandbags — a claymore correctly
 * refusing to shoot through cover looks exactly like a claymore that is broken —
 * and the second put a sentry in a gap between two buildings, so its target was
 * standing inside one of them.
 *
 * This spot is verified to have 14m of clear sightline toward -z and room to
 * park a second player well clear of the action.
 */
const CLEAR_GROUND = { x: -8, y: 0.05, z: 28 };

function makeSim(lethal = 'frag', field = ''): { sim: GameSimulation; player: PlayerState } {
  const sim = new GameSimulation({ mapId: 'crossfire', modeId: 'tdm', seed: 'dep' });
  sim.world.match.phase = MatchPhase.Live;
  sim.world.match.timeRemaining = 600;

  const loadout = defaultLoadout();
  loadout.lethal = lethal;
  loadout.fieldUpgrade = field;

  const player = sim.addPlayer({ name: 'Owner', team: Team.Allies, loadout });
  sim.spawnPlayer(player);
  player.position.x = CLEAR_GROUND.x;
  player.position.y = CLEAR_GROUND.y;
  player.position.z = CLEAR_GROUND.z;
  player.yaw = 0;
  return { sim, player };
}

/** Park a player far from the action without letting them wander. */
function park(sim: GameSimulation, player: PlayerState, seconds: number): void {
  const at = { x: CLEAR_GROUND.x + 25, y: CLEAR_GROUND.y, z: CLEAR_GROUND.z + 18 };
  run(sim, seconds, { player, at });
}

/**
 * Call a killstreak, then RELEASE the key.
 *
 * Activation is edge-triggered, so a held key would otherwise fire again the
 * instant anything new landed in the inventory — which is exactly the bug this
 * behaviour was changed to prevent.
 */
function callStreak(sim: GameSimulation, id: number, pitch = 0): void {
  sim.setInput(sim.world.players.get(id)!.id, {
    ...createEmptyInput(), dt: TICK_DT, killstreakSlot: 0, pitch,
  });
  sim.step(TICK_DT);
  sim.setInput(id, { ...createEmptyInput(), dt: TICK_DT, pitch });
}

/** Press a button for exactly one tick, then release. */
function press(sim: GameSimulation, id: number, buttons: number, pitch = 0): void {
  sim.setInput(id, { ...createEmptyInput(), dt: TICK_DT, buttons, pitch });
  sim.step(TICK_DT);
  sim.setInput(id, { ...createEmptyInput(), dt: TICK_DT, pitch });
}

/** Run the sim, optionally pinning a player in place each tick. */
function run(
  sim: GameSimulation,
  seconds: number,
  pin?: { player: PlayerState; at: { x: number; y: number; z: number } },
): void {
  const ticks = Math.round(seconds / TICK_DT);
  for (let i = 0; i < ticks; i++) {
    if (pin) {
      pin.player.position.x = pin.at.x;
      pin.player.position.y = pin.at.y;
      pin.player.position.z = pin.at.z;
    }
    sim.step(TICK_DT);
  }
}

function only(sim: GameSimulation): DeployableState {
  const list = Array.from(sim.world.deployables.values());
  expect(list.length, 'expected exactly one deployable').toBe(1);
  return list[0]!;
}

/** A point the given distance directly in front of a deployable. */
function inFrontOf(dep: DeployableState, distance: number): { x: number; y: number; z: number } {
  const fwd = anglesToForward(vec3(), dep.yaw, 0);
  return {
    x: dep.position.x + fwd.x * distance,
    y: dep.position.y,
    z: dep.position.z + fwd.z * distance,
  };
}

function behind(dep: DeployableState, distance: number): { x: number; y: number; z: number } {
  return inFrontOf(dep, -distance);
}

// ---------------------------------------------------------------------------

describe('placement', () => {
  it('places a claymore instead of throwing it', () => {
    const { sim, player } = makeSim('claymore');
    press(sim, player.id, InputFlag.Lethal);

    const dep = only(sim);
    expect(dep.kind).toBe(DeployableKind.Claymore);
    expect(sim.world.projectiles.size, 'a claymore is not a grenade').toBe(0);

    // It should land within arm's reach, not sail across the map.
    const dx = dep.position.x - player.position.x;
    const dz = dep.position.z - player.position.z;
    expect(Math.hypot(dx, dz)).toBeLessThan(3);
  });

  it('still throws things that are meant to be thrown', () => {
    const { sim, player } = makeSim('frag');
    press(sim, player.id, InputFlag.Lethal);

    expect(sim.world.deployables.size).toBe(0);
    expect(sim.world.projectiles.size, 'a frag is a grenade').toBe(1);
  });

  it('consumes a charge per placement', () => {
    const { sim, player } = makeSim('claymore');
    const before = player.lethalCount;
    press(sim, player.id, InputFlag.Lethal);
    expect(player.lethalCount).toBe(before - 1);
  });
});

describe('claymores', () => {
  it('is harmless until it has armed', () => {
    const { sim, player } = makeSim('claymore');
    press(sim, player.id, InputFlag.Lethal);
    const dep = only(sim);
    const spec = deployableSpec(DeployableKind.Claymore);
    expect(spec.armTime).toBeGreaterThan(0.5);

    const enemy = sim.addPlayer({ name: 'Enemy', team: Team.Axis });
    sim.spawnPlayer(enemy);

    // Stand right in front of it for less than the arm time.
    run(sim, spec.armTime * 0.5, { player: enemy, at: inFrontOf(dep, 1.5) });

    expect(enemy.alive, 'an unarmed mine must not trigger').toBe(true);
    expect(sim.world.deployables.has(dep.id)).toBe(true);
  });

  it('kills an enemy who walks into its arc once armed', () => {
    const { sim, player } = makeSim('claymore');
    press(sim, player.id, InputFlag.Lethal);
    const dep = only(sim);

    const enemy = sim.addPlayer({ name: 'Enemy', team: Team.Axis });
    sim.spawnPlayer(enemy);
    // Park the enemy well clear while it arms.
    park(sim, enemy, 2.5);

    run(sim, 0.5, { player: enemy, at: inFrontOf(dep, 1.5) });

    expect(enemy.alive, 'an armed claymore should kill at 1.5m').toBe(false);
    expect(sim.world.deployables.has(dep.id), 'and consume itself').toBe(false);
  });

  it('ignores an enemy standing behind it', () => {
    const { sim, player } = makeSim('claymore');
    press(sim, player.id, InputFlag.Lethal);
    const dep = only(sim);

    const enemy = sim.addPlayer({ name: 'Enemy', team: Team.Axis });
    sim.spawnPlayer(enemy);
    park(sim, enemy, 2.5);

    // Directly behind, well inside the trigger radius.
    run(sim, 1.0, { player: enemy, at: behind(dep, 1.5) });

    expect(enemy.alive, 'a claymore only watches its front arc').toBe(true);
    expect(sim.world.deployables.has(dep.id)).toBe(true);
  });

  it('ignores a friendly walking straight over it', () => {
    const { sim, player } = makeSim('claymore');
    press(sim, player.id, InputFlag.Lethal);
    const dep = only(sim);

    const mate = sim.addPlayer({ name: 'Mate', team: Team.Allies });
    sim.spawnPlayer(mate);
    park(sim, mate, 2.5);
    run(sim, 1.0, { player: mate, at: inFrontOf(dep, 1.2) });

    expect(mate.alive).toBe(true);
    expect(sim.world.deployables.has(dep.id)).toBe(true);
  });
});

describe('C4', () => {
  it('does not trigger on proximity — it waits for its owner', () => {
    const { sim, player } = makeSim('c4');
    press(sim, player.id, InputFlag.Lethal);
    const dep = only(sim);

    const enemy = sim.addPlayer({ name: 'Enemy', team: Team.Axis });
    sim.spawnPlayer(enemy);
    run(sim, 2, { player: enemy, at: inFrontOf(dep, 0.8) });

    expect(enemy.alive, 'C4 is a trap, not a mine').toBe(true);
    expect(sim.world.deployables.has(dep.id)).toBe(true);
  });

  it('detonates on a second press of the lethal key', () => {
    const { sim, player } = makeSim('c4');
    press(sim, player.id, InputFlag.Lethal);
    expect(sim.world.deployables.size).toBe(1);
    const dep = only(sim);

    const enemy = sim.addPlayer({ name: 'Enemy', team: Team.Axis });
    sim.spawnPlayer(enemy);
    run(sim, 1, { player: enemy, at: inFrontOf(dep, 1.0) });

    press(sim, player.id, InputFlag.Lethal);
    sim.step(TICK_DT);

    expect(sim.world.deployables.size, 'the charge is spent').toBe(0);
    expect(enemy.alive, 'and it kills what was standing on it').toBe(false);
  });
});

describe('field upgrades', () => {
  it('charges over time and deploys when ready', () => {
    const { sim, player } = makeSim('frag', 'trophy_system');

    expect(player.fieldUpgradeCharge).toBe(0);
    run(sim, 5);
    const partial = player.fieldUpgradeCharge;
    expect(partial, 'it should be charging').toBeGreaterThan(0);
    expect(partial, 'but not instantly ready').toBeLessThan(1);

    // Pressing early must do nothing.
    press(sim, player.id, InputFlag.FieldUpgrade);
    expect(sim.world.deployables.size).toBe(0);

    run(sim, 300);
    expect(player.fieldUpgradeCharge).toBe(1);

    press(sim, player.id, InputFlag.FieldUpgrade);
    expect(sim.world.deployables.size).toBe(1);
    expect(only(sim).kind).toBe(DeployableKind.TrophySystem);
    expect(player.fieldUpgradeCharge, 'and the charge is spent').toBe(0);
  });
});

describe('killstreak deployables', () => {
  it('a sentry gun actually appears when the streak is called', () => {
    const { sim, player } = makeSim();
    player.killstreakInventory.push('sentry_gun');

    callStreak(sim, player.id, 0.3);

    const list = Array.from(sim.world.deployables.values());
    expect(list.some((d) => d.kind === DeployableKind.SentryGun)).toBe(true);
    expect(player.killstreakInventory.length, 'the streak is consumed').toBe(0);
  });

  it('a sentry gun shoots enemies in its arc', () => {
    const { sim, player } = makeSim();
    player.killstreakInventory.push('sentry_gun');
    callStreak(sim, player.id, 0.3);
    const sentry = only(sim);

    const enemy = sim.addPlayer({ name: 'Target', team: Team.Axis });
    sim.spawnPlayer(enemy);
    run(sim, 10, { player: enemy, at: inFrontOf(sentry, 8) });

    expect(enemy.deaths, 'a sentry should eventually kill a stationary target')
      .toBeGreaterThan(0);
  });

  it('a care package cannot be collected the instant it lands', () => {
    const { sim, player } = makeSim();
    player.killstreakInventory.push('care_package');
    callStreak(sim, player.id, 0.4);

    const pkg = only(sim);
    expect(pkg.kind).toBe(DeployableKind.CarePackage);
    expect(pkg.payload, 'it should be carrying something').not.toBe('');

    // Standing on it immediately must not grant anything — otherwise the whole
    // point of a package landing in the open is lost.
    run(sim, 1.0, { player, at: { ...pkg.position } });
    expect(player.killstreakInventory.length).toBe(0);

    run(sim, 3.0, { player, at: { ...pkg.position } });
    expect(player.killstreakInventory.length, 'and grants once it has settled').toBe(1);
    expect(sim.world.deployables.size).toBe(0);
  });
});

describe('explosive falloff', () => {
  /**
   * Tested against resolveExplosion directly rather than by throwing a grenade
   * and chasing it. A thrown frag bounces, so an integration test of the falloff
   * curve ends up measuring where the grenade happened to roll — which is a test
   * of the physics, not of the rule it claims to check.
   */
  function damageAt(distance: number, radius: number, maxDamage: number): number {
    const sim = new GameSimulation({ mapId: 'crossfire', modeId: 'tdm', seed: 'blast' });
    sim.world.match.phase = MatchPhase.Live;

    const thrower = sim.addPlayer({ name: 'Thrower', team: Team.Allies });
    sim.spawnPlayer(thrower);
    const victim = sim.addPlayer({ name: 'Victim', team: Team.Axis });
    sim.spawnPlayer(victim);

    // Both on verified-clear ground, separated along a clear axis.
    const centre = { x: CLEAR_GROUND.x, y: CLEAR_GROUND.y, z: CLEAR_GROUND.z };
    thrower.position.x = centre.x;
    thrower.position.y = centre.y;
    thrower.position.z = centre.z;
    victim.position.x = centre.x;
    victim.position.y = centre.y;
    victim.position.z = centre.z - distance;

    const targets: ExplosionTarget[] = [];
    resolveExplosion(
      sim.world,
      sim.collision,
      vec3(centre.x, centre.y + 0.2, centre.z),
      radius,
      maxDamage,
      thrower.id,
      false,
      targets,
    );

    return targets.find((t) => t.player.id === victim.id)?.damage ?? 0;
  }

  it('kills outright at the centre of the blast', () => {
    // Frag reference: 130 damage over 5.5m.
    expect(damageAt(0.5, 5.5, 130)).toBeGreaterThanOrEqual(100);
    expect(damageAt(1.8, 5.5, 130)).toBeGreaterThanOrEqual(100);
  });

  it('leaves a survivor near the edge', () => {
    const edge = damageAt(4.9, 5.5, 130);
    expect(edge, 'the edge must still hurt').toBeGreaterThan(5);
    expect(edge, 'but not kill').toBeLessThan(100);
  });

  it('falls off monotonically with distance', () => {
    let previous = Infinity;
    for (const d of [0.5, 1.5, 2.5, 3.5, 4.5, 5.4]) {
      const dmg = damageAt(d, 5.5, 130);
      expect(dmg, `damage rose at ${d}m`).toBeLessThanOrEqual(previous + 1e-6);
      previous = dmg;
    }
  });

  it('does nothing beyond its radius', () => {
    expect(damageAt(7, 5.5, 130)).toBe(0);
  });
});
