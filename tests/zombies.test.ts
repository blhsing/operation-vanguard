/**
 * Zombies tests.
 *
 * The mode is a treadmill: you are paid for shooting, you spend that on shooting
 * better, and the round curve outruns you anyway. Each test here pins one part
 * of that loop, because every one of them is load-bearing — a round curve that
 * does not escalate, an economy that does not pay, or a revive that always works
 * each turn the mode into a walking simulator.
 */

import { describe, expect, it } from 'vitest';

import { TICK_DT } from '../src/shared/constants.js';
import { vec3 } from '../src/shared/math.js';
import { Rng } from '../src/shared/rng.js';
import { Team, type PlayerState, type SimEvent } from '../src/shared/types.js';
import { GameSimulation } from '../src/shared/sim/game.js';
import { NavGraph } from '../src/shared/ai/navigation.js';
import {
  DOWN,
  MYSTERY_BOX_COST,
  PACK_A_PUNCH_COST,
  POINTS,
  ROUND_CURVE,
  RoundPhase,
  ZOMBIE_PERKS,
  ZombiesDirector,
  getZombiesMap,
  zombieCountForRound,
  zombieHealthForRound,
  zombieSpeedForRound,
} from '../src/shared/zombies/index.js';

interface Harness {
  sim: GameSimulation;
  director: ZombiesDirector;
  players: PlayerState[];
  events: SimEvent[];
  run(seconds: number): void;
}

function makeGame(playerCount = 1): Harness {
  const sim = new GameSimulation({ mapId: 'crossfire', modeId: 'zombies', seed: 'zm' });
  const nav = new NavGraph(sim.map, sim.collision);
  const data = getZombiesMap('crossfire');
  const director = new ZombiesDirector(sim, nav, new Rng(99), data);

  const players: PlayerState[] = [];
  for (let i = 0; i < playerCount; i++) {
    const p = sim.addPlayer({ name: `Survivor${i}`, team: Team.Allies });
    sim.spawnPlayer(p);
    const spawn = data.playerSpawns[i % data.playerSpawns.length]!;
    p.position.x = spawn.x;
    p.position.y = spawn.y;
    p.position.z = spawn.z;
    director.addSurvivor(p);
    players.push(p);
  }

  const events: SimEvent[] = [];

  return {
    sim,
    director,
    players,
    events,
    run(seconds: number) {
      const ticks = Math.round(seconds / TICK_DT);
      for (let i = 0; i < ticks; i++) {
        const simEvents = sim.step(TICK_DT);
        for (const e of simEvents) events.push(e);
        for (const e of director.step(TICK_DT, simEvents)) events.push(e);
      }
    },
  };
}

function zombies(h: Harness): PlayerState[] {
  return Array.from(h.sim.world.players.values()).filter((p) => p.team === Team.Hostile);
}

// ---------------------------------------------------------------------------

describe('the round curve', () => {
  it('escalates health without limit — there is always an eventual wall', () => {
    let previous = 0;
    for (const round of [1, 5, 10, 15, 20, 30]) {
      const hp = zombieHealthForRound(round);
      expect(hp, `round ${round}`).toBeGreaterThan(previous);
      previous = hp;
    }
    expect(zombieHealthForRound(30)).toBeGreaterThan(zombieHealthForRound(10) * 3);
  });

  it('caps speed, because an uncapped curve just picks a round to become unplayable', () => {
    expect(zombieSpeedForRound(1)).toBeLessThan(zombieSpeedForRound(10));
    expect(zombieSpeedForRound(50)).toBe(ROUND_CURVE.maxSpeed);
    // And it must never outrun a sprinting player by so much that space stops working.
    expect(ROUND_CURVE.maxSpeed).toBeLessThan(7);
  });

  it('sends more zombies with more players', () => {
    expect(zombieCountForRound(5, 4)).toBeGreaterThan(zombieCountForRound(5, 1));
    expect(zombieCountForRound(10, 1)).toBeGreaterThan(zombieCountForRound(1, 1));
  });
});

describe('a running game', () => {
  it('starts in intermission and then begins round one', () => {
    const h = makeGame();
    expect(h.director.state.phase).toBe(RoundPhase.Intermission);
    expect(h.director.state.round).toBe(0);

    h.run(6);
    expect(h.director.state.phase).toBe(RoundPhase.Active);
    expect(h.director.state.round).toBe(1);
  });

  it('spawns the horde gradually rather than all at once', () => {
    const h = makeGame();
    h.run(6.5);
    const early = zombies(h).length;
    h.run(6);
    const later = zombies(h).length;

    expect(early, 'some should be out immediately').toBeGreaterThan(0);
    expect(later, 'and more should arrive over the round').toBeGreaterThan(early);
  });

  it('never exceeds its concurrent zombie budget', () => {
    const h = makeGame(4);
    // Deep enough into the game that the round wants far more than the cap.
    h.director.state.round = 14;
    h.run(60);
    expect(zombies(h).length).toBeLessThanOrEqual(ROUND_CURVE.maxAlive);
  });

  it('does not spawn zombies on top of the players', () => {
    const h = makeGame();
    h.run(8);
    for (const z of zombies(h)) {
      let nearest = Infinity;
      for (const p of h.players) {
        nearest = Math.min(nearest, Math.hypot(z.position.x - p.position.x, z.position.z - p.position.z));
      }
      // They may have closed since spawning, so check only the freshly spawned.
      if (z.health === z.maxHealth) {
        expect(nearest, 'a zombie should never appear in your face').toBeGreaterThan(3);
      }
    }
  });

  it('sends zombies toward the players rather than milling about', () => {
    const h = makeGame();
    h.run(8);
    const before = zombies(h).map((z) => ({
      id: z.id,
      d: Math.hypot(z.position.x - h.players[0]!.position.x, z.position.z - h.players[0]!.position.z),
    }));
    h.run(6);

    let closed = 0;
    for (const z of zombies(h)) {
      const prior = before.find((b) => b.id === z.id);
      if (!prior) continue;
      const now = Math.hypot(
        z.position.x - h.players[0]!.position.x,
        z.position.z - h.players[0]!.position.z,
      );
      if (now < prior.d - 1) closed++;
    }
    expect(closed, 'zombies should be closing the distance').toBeGreaterThan(0);
  });

  it('keeps zombies out of the multiplayer scoreboard', () => {
    const h = makeGame(2);
    h.run(10);
    expect(zombies(h).length).toBeGreaterThan(0);
    expect(h.sim.scoreboard().every((p) => p.team !== Team.Hostile)).toBe(true);
    expect(h.sim.scoreboard().length).toBe(2);
  });

  it('does not end the match on a timer it does not have', () => {
    const h = makeGame();
    h.run(30);
    expect(h.director.state.phase).not.toBe(RoundPhase.GameOver);
  });
});

describe('the economy', () => {
  it('pays for hits, so a weak starting pistol is still survivable', () => {
    const h = makeGame();
    const start = h.director.points(h.players[0]!.id);
    h.run(8);

    const zombie = zombies(h)[0];
    expect(zombie).toBeDefined();

    // Land a non-lethal hit.
    h.sim.damagePlayer(zombie!, {
      amount: 10, attacker: h.players[0]!.id, victim: zombie!.id, cause: 0,
      weaponId: 'p226', location: 'chest', position: vec3(), direction: vec3(0, 0, 1),
      distance: 5, ignoreArmor: false,
    });
    h.run(TICK_DT * 2);

    expect(h.director.points(h.players[0]!.id)).toBe(start + POINTS.hit);
  });

  it('pays more for a kill than a hit, and more again for a headshot', () => {
    expect(POINTS.kill).toBeGreaterThan(POINTS.hit);
    expect(POINTS.headshotKill).toBeGreaterThan(POINTS.kill);
    expect(POINTS.meleeKill).toBeGreaterThan(POINTS.headshotKill);
  });

  it('awards a kill to the player who fired', () => {
    const h = makeGame();
    h.run(8);
    const zombie = zombies(h)[0]!;
    const before = h.director.points(h.players[0]!.id);

    h.sim.damagePlayer(zombie, {
      amount: 99999, attacker: h.players[0]!.id, victim: zombie.id, cause: 0,
      weaponId: 'p226', location: 'chest', position: vec3(), direction: vec3(0, 0, 1),
      distance: 5, ignoreArmor: true,
    });
    h.run(TICK_DT * 2);

    expect(h.director.points(h.players[0]!.id)).toBeGreaterThanOrEqual(before + POINTS.kill);
  });

  it('removes a killed zombie from the world rather than leaving corpses', () => {
    const h = makeGame();
    h.run(8);
    const zombie = zombies(h)[0]!;
    const countBefore = zombies(h).length;

    h.sim.damagePlayer(zombie, {
      amount: 99999, attacker: h.players[0]!.id, victim: zombie.id, cause: 0,
      weaponId: 'p226', location: 'chest', position: vec3(), direction: vec3(0, 0, 1),
      distance: 5, ignoreArmor: true,
    });
    h.run(TICK_DT * 2);

    expect(zombies(h).length).toBe(countBefore - 1);
  });
});

describe('buying things', () => {
  function nearest(h: Harness, id: string): void {
    const data = getZombiesMap('crossfire');
    const def = data.interactables.find((i) => i.id === id)!;
    h.players[0]!.position.x = def.position.x;
    h.players[0]!.position.y = def.position.y;
    h.players[0]!.position.z = def.position.z;
  }

  it('refuses a purchase you cannot afford, and takes the points when you can', () => {
    const h = makeGame();
    nearest(h, 'door_mid');

    const zs = h.director.players.get(h.players[0]!.id)!;
    zs.points = 100;
    expect(h.director.interact(h.players[0]!.id).ok).toBe(false);
    expect(h.director.state.openZones.has('mid')).toBe(false);

    zs.points = 5000;
    const before = zs.points;
    expect(h.director.interact(h.players[0]!.id).ok).toBe(true);
    expect(h.director.state.openZones.has('mid')).toBe(true);
    expect(zs.points).toBeLessThan(before);
  });

  it('locks everything outside the starting zone until a door is opened', () => {
    const h = makeGame();
    nearest(h, 'wall_ar'); // lives in the mid zone
    h.director.players.get(h.players[0]!.id)!.points = 99999;

    const blocked = h.director.interact(h.players[0]!.id);
    expect(blocked.ok).toBe(false);
    expect(blocked.message).toBe('area locked');
  });

  it('gives the gun on the first wall buy and ammo on the second', () => {
    const h = makeGame();
    nearest(h, 'wall_smg');
    const zs = h.director.players.get(h.players[0]!.id)!;
    zs.points = 99999;

    expect(h.director.interact(h.players[0]!.id).ok).toBe(true);
    const owned = h.players[0]!.weapons.some((w) => w?.defId === 'mp9k');
    expect(owned, 'the wall weapon should be in hand').toBe(true);

    // Spend the magazine, then buy again — it should top up rather than re-issue.
    const state = h.players[0]!.weapons.find((w) => w?.defId === 'mp9k')!;
    state.ammoReserve = 0;
    const result = h.director.interact(h.players[0]!.id);
    expect(result.ok).toBe(true);
    expect(result.message).toBe('ammo');
    expect(state.ammoReserve).toBeGreaterThan(0);
  });

  it('gates the power-dependent machines behind the power switch', () => {
    const h = makeGame();
    const zs = h.director.players.get(h.players[0]!.id)!;
    zs.points = 99999;

    // Open the warehouse first so the zone check is not what blocks us.
    nearest(h, 'door_warehouse');
    h.director.interact(h.players[0]!.id);

    nearest(h, 'perk_jugg');
    expect(h.director.interact(h.players[0]!.id).message).toBe('needs power');

    nearest(h, 'power');
    expect(h.director.interact(h.players[0]!.id).ok).toBe(true);
    expect(h.director.state.powerOn).toBe(true);

    nearest(h, 'perk_jugg');
    expect(h.director.interact(h.players[0]!.id).ok).toBe(true);
  });

  it('makes Juggernog actually raise the ceiling', () => {
    const h = makeGame();
    const zs = h.director.players.get(h.players[0]!.id)!;
    zs.points = 99999;
    h.director.state.openZones.add('warehouse');
    h.director.state.powerOn = true;

    const before = h.players[0]!.maxHealth;
    nearest(h, 'perk_jugg');
    expect(h.director.interact(h.players[0]!.id).ok).toBe(true);

    expect(h.players[0]!.maxHealth).toBeGreaterThan(before);
    expect(h.players[0]!.health).toBe(h.players[0]!.maxHealth);
    expect(zs.perks).toContain('juggernog');
  });

  it('caps how many perks one player can hold', () => {
    const h = makeGame();
    const zs = h.director.players.get(h.players[0]!.id)!;
    zs.points = 99999;
    zs.perks = ['juggernog', 'speed_cola', 'double_tap', 'stamin_up'];
    h.director.state.openZones.add('start');

    nearest(h, 'perk_revive');
    expect(h.director.interact(h.players[0]!.id).message).toBe('no perk slots');
  });

  it('hands out a weapon from the mystery box', () => {
    const h = makeGame();
    const zs = h.director.players.get(h.players[0]!.id)!;
    zs.points = MYSTERY_BOX_COST + 100;
    h.director.state.openZones.add('warehouse');

    nearest(h, 'box');
    const result = h.director.interact(h.players[0]!.id);
    expect(result.ok).toBe(true);
    expect(result.message.length).toBeGreaterThan(0);
    expect(zs.points).toBe(100);
  });

  it('upgrades a weapon at the Pack-a-Punch, once', () => {
    const h = makeGame();
    const zs = h.director.players.get(h.players[0]!.id)!;
    zs.points = PACK_A_PUNCH_COST * 3;
    h.director.state.openZones.add('north');
    h.director.state.powerOn = true;

    const weaponId = h.players[0]!.weapons[h.players[0]!.activeSlot]!.defId;
    expect(h.director.damageMultiplier(h.players[0]!.id, weaponId)).toBe(1);

    nearest(h, 'pap');
    expect(h.director.interact(h.players[0]!.id).ok).toBe(true);
    expect(h.director.damageMultiplier(h.players[0]!.id, weaponId)).toBeGreaterThan(1);

    // A second attempt on the same gun must not drain another five thousand.
    const after = zs.points;
    const again = h.director.interact(h.players[0]!.id);
    expect(again.ok).toBe(false);
    expect(zs.points).toBe(after);
  });
});

describe('going down', () => {
  function downPlayer(h: Harness, player: PlayerState): void {
    h.sim.damagePlayer(player, {
      amount: 99999, attacker: 0, victim: player.id, cause: 7,
      weaponId: 'zombie', location: 'chest', position: vec3(), direction: vec3(0, 0, 1),
      distance: 1, ignoreArmor: true,
    });
    h.run(TICK_DT * 2);
  }

  it('puts a player down rather than killing them outright', () => {
    const h = makeGame(2);
    h.run(6);
    downPlayer(h, h.players[0]!);

    const zs = h.director.players.get(h.players[0]!.id)!;
    expect(zs.downed, 'they should be crawling, not dead').toBe(true);
    expect(h.players[0]!.alive).toBe(true);
    expect(zs.downs).toBe(1);
  });

  it('strips the perks they paid for, so going down actually costs something', () => {
    const h = makeGame(2);
    const zs = h.director.players.get(h.players[0]!.id)!;
    zs.perks = ['juggernog', 'speed_cola'];
    h.run(6);
    downPlayer(h, h.players[0]!);

    expect(zs.perks).toEqual([]);
  });

  it('lets a teammate revive them by standing over them', () => {
    const h = makeGame(2);
    h.run(6);
    downPlayer(h, h.players[0]!);
    const zs = h.director.players.get(h.players[0]!.id)!;
    expect(zs.downed).toBe(true);

    // Park the second player on top of them for longer than the revive takes.
    const ticks = Math.round((DOWN.reviveTime + 1) / TICK_DT);
    for (let i = 0; i < ticks; i++) {
      h.players[1]!.position.x = h.players[0]!.position.x;
      h.players[1]!.position.y = h.players[0]!.position.y;
      h.players[1]!.position.z = h.players[0]!.position.z;
      const e = h.sim.step(TICK_DT);
      h.director.step(TICK_DT, e);
    }

    expect(zs.downed, 'they should be back on their feet').toBe(false);
    expect(h.players[0]!.health).toBeGreaterThan(1);
  });

  it('restarts an interrupted revive rather than banking the progress', () => {
    const h = makeGame(2);
    h.run(6);
    downPlayer(h, h.players[0]!);
    const zs = h.director.players.get(h.players[0]!.id)!;

    // Start a revive, then walk away.
    const partial = Math.round((DOWN.reviveTime * 0.5) / TICK_DT);
    for (let i = 0; i < partial; i++) {
      h.players[1]!.position.x = h.players[0]!.position.x;
      h.players[1]!.position.z = h.players[0]!.position.z;
      const e = h.sim.step(TICK_DT);
      h.director.step(TICK_DT, e);
    }
    expect(zs.reviveProgress).toBeGreaterThan(0);

    for (let i = 0; i < 20; i++) {
      h.players[1]!.position.x = h.players[0]!.position.x + 20;
      h.players[1]!.position.z = h.players[0]!.position.z + 20;
      const e = h.sim.step(TICK_DT);
      h.director.step(TICK_DT, e);
    }
    expect(zs.reviveProgress, 'a broken revive starts over').toBe(0);
  });

  it('bleeds out a player nobody reaches', () => {
    const h = makeGame(2);
    h.run(6);
    downPlayer(h, h.players[0]!);

    // Keep the teammate far away.
    const ticks = Math.round((DOWN.bleedOutTime + 2) / TICK_DT);
    for (let i = 0; i < ticks; i++) {
      h.players[1]!.position.x = 30;
      h.players[1]!.position.z = 30;
      const e = h.sim.step(TICK_DT);
      h.director.step(TICK_DT, e);
    }

    const zs = h.director.players.get(h.players[0]!.id)!;
    expect(zs.downed).toBe(false);
    expect(h.players[0]!.alive, 'they are out until the round ends').toBe(false);
  });

  it('ends the game once nobody is left standing', () => {
    const h = makeGame(1);
    h.run(6);
    downPlayer(h, h.players[0]!);

    const ticks = Math.round((DOWN.bleedOutTime + 3) / TICK_DT);
    for (let i = 0; i < ticks; i++) {
      const e = h.sim.step(TICK_DT);
      h.director.step(TICK_DT, e);
    }

    expect(h.director.state.phase).toBe(RoundPhase.GameOver);
  });

  it('lets Quick Revive pick a solo player up exactly once', () => {
    const h = makeGame(1);
    const zs = h.director.players.get(h.players[0]!.id)!;
    zs.perks = ['quick_revive'];
    h.run(6);

    downPlayer(h, h.players[0]!);
    expect(zs.downed, 'the perk should catch the first down').toBe(false);
    expect(zs.selfReviveUsed).toBe(true);

    // Second time it must not save them — the perk was consumed.
    zs.perks = ['quick_revive'];
    downPlayer(h, h.players[0]!);
    expect(zs.downed).toBe(true);
  });
});

describe('perks that change the simulation', () => {
  it('makes Double Tap raise the rate of fire', () => {
    const h = makeGame();
    const zs = h.director.players.get(h.players[0]!.id)!;
    expect(h.director.fireRateMultiplier(h.players[0]!.id)).toBe(1);
    zs.perks = ['double_tap'];
    expect(h.director.fireRateMultiplier(h.players[0]!.id)).toBe(
      ZOMBIE_PERKS.double_tap!.fireRateMult,
    );
  });

  it('applies perk effects through the simulation hook exactly once', () => {
    const h = makeGame();
    const zs = h.director.players.get(h.players[0]!.id)!;
    zs.perks = ['stamin_up'];

    // Run a tick and confirm the speed bonus is applied once, not squared.
    // Squaring 1.18 would give 1.39, which is why the hook must be called once.
    const perk = ZOMBIE_PERKS.stamin_up!;
    const move = {
      speedMultiplier: 1, adsSpeedMultiplier: 1, adsProgress: 0,
      sprintBlocked: false, slideBlocked: false, slowMultiplier: 1, fallDamageImmune: false,
    };
    const weapon = {
      reloadSpeedMult: 1, adsSpeedMult: 1, swapSpeedMult: 1,
      sprintOutMult: 1, hipSpreadMult: 1, fireBlocked: false,
    };
    h.sim.modifierHook?.(h.players[0]!, move, weapon);
    expect(move.speedMultiplier).toBeCloseTo(perk.speedMult!, 5);
  });

  it('never lets a zombie fire a weapon', () => {
    const h = makeGame();
    h.run(10);
    for (const z of zombies(h)) {
      expect(z.weapons.length, 'zombies carry nothing').toBe(0);
    }
  });
});
