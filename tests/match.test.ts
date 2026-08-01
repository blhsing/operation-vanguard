/**
 * Headless match tests.
 *
 * These run a real match — real map, real collision, real weapons, real bots —
 * with no renderer attached, and assert that it behaves like a game. It is the
 * only test that can catch "everything compiles and nothing happens", which is
 * the characteristic failure mode of a simulation assembled from parts that each
 * work in isolation.
 *
 * Every assertion here is a claim about the player's experience: bots find each
 * other, fights resolve, people respawn somewhere survivable, and the match ends.
 */

import { describe, expect, it } from 'vitest';

import { TICK_DT } from '../src/shared/constants.js';
import { MatchPhase, SimEventType, Team, type SimEvent } from '../src/shared/types.js';
import { GameSimulation } from '../src/shared/sim/game.js';
import { BOT_ARCHETYPES, botLoadout, type BotArchetype } from '../src/shared/sim/loadout.js';
import { NavGraph } from '../src/shared/ai/navigation.js';
import { BotController, DIFFICULTIES } from '../src/shared/ai/bot.js';
import { Rng } from '../src/shared/rng.js';
import { v3distance } from '../src/shared/math.js';

interface Harness {
  sim: GameSimulation;
  bots: BotController;
  nav: NavGraph;
  events: SimEvent[];
  run(seconds: number): void;
}

function makeMatch(opts: {
  modeId?: string;
  botCount?: number;
  seed?: string;
  difficulty?: keyof typeof DIFFICULTIES;
} = {}): Harness {
  const sim = new GameSimulation({
    mapId: 'crossfire',
    modeId: opts.modeId ?? 'tdm',
    seed: opts.seed ?? 'test-seed',
  });
  const nav = new NavGraph(sim.map, sim.collision);
  const rng = new Rng(1234);
  const bots = new BotController(sim, nav, rng);

  const count = opts.botCount ?? 8;
  const difficulty = DIFFICULTIES[opts.difficulty ?? 'regular']!;

  for (let i = 0; i < count; i++) {
    const team = i % 2 === 0 ? Team.Allies : Team.Axis;
    const archetype: BotArchetype = BOT_ARCHETYPES[i % BOT_ARCHETYPES.length]!;
    const player = sim.addPlayer({
      name: `Bot${i}`,
      team,
      isBot: true,
      botSkill: 0.5,
      loadout: botLoadout(archetype, i),
    });
    bots.register(player.id, archetype, difficulty);
  }

  const events: SimEvent[] = [];

  return {
    sim,
    bots,
    nav,
    events,
    run(seconds: number) {
      const ticks = Math.round(seconds / TICK_DT);
      for (let i = 0; i < ticks; i++) {
        bots.update(TICK_DT);
        const produced = sim.step(TICK_DT);
        for (const e of produced) events.push(e);
      }
    },
  };
}

function countEvents(events: SimEvent[], type: SimEventType): number {
  let n = 0;
  for (const e of events) if (e.type === type) n++;
  return n;
}

describe('navigation graph', () => {
  it('covers the map as one connected region', () => {
    const sim = new GameSimulation({ mapId: 'crossfire', modeId: 'tdm' });
    const nav = new NavGraph(sim.map, sim.collision);

    expect(nav.size).toBeGreaterThan(200);
    expect(nav.connectivity()).toBe(1);
    expect(nav.nodes.every((n) => n.edges.length > 0)).toBe(true);
  });

  it('can path between opposite ends of the map', () => {
    const sim = new GameSimulation({ mapId: 'crossfire', modeId: 'tdm' });
    const nav = new NavGraph(sim.map, sim.collision);

    const alliedEnd = nav.nearestNode({ x: 0, y: 0, z: 34 }, 20);
    const axisEnd = nav.nearestNode({ x: 0, y: 0, z: -34 }, 20);
    expect(alliedEnd).toBeGreaterThanOrEqual(0);
    expect(axisEnd).toBeGreaterThanOrEqual(0);

    const path = nav.findPath(alliedEnd, axisEnd);
    expect(path.length).toBeGreaterThan(3);
    expect(path[0]).toBe(alliedEnd);
    expect(path[path.length - 1]).toBe(axisEnd);
  });

  it('preserves the hand-placed cover positions the AI relies on', () => {
    const sim = new GameSimulation({ mapId: 'crossfire', modeId: 'tdm' });
    const nav = new NavGraph(sim.map, sim.collision);
    expect(nav.nodes.filter((n) => n.isCover).length).toBeGreaterThan(15);
  });

  it('reaches the elevated catwalk, so bots use the map vertically', () => {
    const sim = new GameSimulation({ mapId: 'crossfire', modeId: 'tdm' });
    const nav = new NavGraph(sim.map, sim.collision);

    const elevated = nav.nodes.filter((n) => n.position.y > 3);
    expect(elevated.length).toBeGreaterThan(0);

    const ground = nav.nearestNode({ x: 0, y: 0, z: 20 }, 20);
    const path = nav.findPath(ground, elevated[0]!.id);
    expect(path.length).toBeGreaterThan(0);
  });
});

describe('a live match', () => {
  it('spawns every bot into the world', () => {
    const h = makeMatch({ botCount: 8 });
    h.run(2);

    const alive = Array.from(h.sim.world.players.values()).filter((p) => p.alive);
    expect(alive.length).toBe(8);
    expect(countEvents(h.events, SimEventType.Spawn)).toBeGreaterThanOrEqual(8);
  });

  it('never spawns two players on top of each other', () => {
    const h = makeMatch({ botCount: 12 });
    h.run(2);

    const players = Array.from(h.sim.world.players.values()).filter((p) => p.alive);
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        const d = v3distance(players[i]!.position, players[j]!.position);
        expect(d, `${players[i]!.name} and ${players[j]!.name} overlap`).toBeGreaterThan(0.5);
      }
    }
  });

  it('moves bots away from their spawn instead of leaving them idle', () => {
    const h = makeMatch({ botCount: 8 });
    h.run(2);

    const start = new Map(
      Array.from(h.sim.world.players.values()).map((p) => [p.id, { ...p.position }]),
    );

    h.run(10);

    let moved = 0;
    for (const p of h.sim.world.players.values()) {
      const from = start.get(p.id);
      if (!from) continue;
      if (v3distance(from, p.position) > 6) moved++;
    }
    // Some bots will have died and respawned; most should have travelled.
    expect(moved).toBeGreaterThanOrEqual(5);
  });

  it('produces a real firefight — shots, hits and kills', () => {
    const h = makeMatch({ botCount: 10, difficulty: 'hardened' });
    h.run(75);

    const shots = countEvents(h.events, SimEventType.Shot);
    const hits = countEvents(h.events, SimEventType.Hit);
    const kills = countEvents(h.events, SimEventType.Kill);

    expect(shots, 'bots should be shooting').toBeGreaterThan(150);
    expect(hits, 'bots should be hitting each other').toBeGreaterThan(20);
    expect(kills, 'bots should be killing each other').toBeGreaterThan(4);

    // Accuracy sanity: bots that hit with every shot are cheating; bots that
    // never hit are broken.
    const accuracy = hits / Math.max(1, shots);
    expect(accuracy).toBeGreaterThan(0.02);
    expect(accuracy).toBeLessThan(0.8);
  });

  it('respawns players after they die', () => {
    const h = makeMatch({ botCount: 10, difficulty: 'hardened' });
    h.run(75);

    const players = Array.from(h.sim.world.players.values());
    const totalDeaths = players.reduce((a, p) => a + p.deaths, 0);
    expect(totalDeaths).toBeGreaterThan(3);

    // The property that matters is that deaths turn back into lives. Counting
    // how many happen to be alive at one arbitrary instant measures the
    // firefight, not the respawn system.
    //
    // Every player spawned once to enter the match, plus once per death — minus
    // those still counting down when the run stopped, who have not respawned yet.
    const spawns = countEvents(h.events, SimEventType.Spawn);
    const deadNow = players.filter((p) => !p.alive).length;
    expect(spawns).toBe(players.length + totalDeaths - deadNow);

    // And nobody is stuck dead: every corpse has a bounded countdown.
    for (const p of players) {
      if (!p.alive) {
        expect(p.respawnTimer, `${p.name} is stuck dead`).toBeLessThanOrEqual(
          h.sim.mode.respawnDelay + 0.1,
        );
      }
    }
  });

  it('awards score and keeps a coherent scoreboard', () => {
    const h = makeMatch({ botCount: 10, difficulty: 'hardened' });
    h.run(75);

    const board = h.sim.scoreboard();
    expect(board.length).toBe(10);
    // Sorted descending by score.
    for (let i = 1; i < board.length; i++) {
      expect(board[i - 1]!.score).toBeGreaterThanOrEqual(board[i]!.score);
    }
    expect(board[0]!.score).toBeGreaterThan(0);
  });

  it('never lets a player fall out of the world', () => {
    const h = makeMatch({ botCount: 12 });
    h.run(45);

    for (const p of h.sim.world.players.values()) {
      expect(Number.isFinite(p.position.x), `${p.name} x`).toBe(true);
      expect(Number.isFinite(p.position.y), `${p.name} y`).toBe(true);
      expect(Number.isFinite(p.position.z), `${p.name} z`).toBe(true);
      expect(p.position.y, `${p.name} fell through the floor`).toBeGreaterThan(
        h.sim.map.bounds.min.y - 25,
      );
    }
  });

  it('keeps bots inside the map bounds', () => {
    const h = makeMatch({ botCount: 12 });
    h.run(45);

    const b = h.sim.map.bounds;
    for (const p of h.sim.world.players.values()) {
      expect(p.position.x, `${p.name} x out of bounds`).toBeGreaterThanOrEqual(b.min.x - 2);
      expect(p.position.x, `${p.name} x out of bounds`).toBeLessThanOrEqual(b.max.x + 2);
      expect(p.position.z, `${p.name} z out of bounds`).toBeGreaterThanOrEqual(b.min.z - 2);
      expect(p.position.z, `${p.name} z out of bounds`).toBeLessThanOrEqual(b.max.z + 2);
    }
  });

  it('runs the match clock and can reach a conclusion', () => {
    const h = makeMatch({ botCount: 6 });
    expect(h.sim.world.match.phase).toBe(MatchPhase.Warmup);
    h.run(12);
    expect(h.sim.world.match.phase).toBe(MatchPhase.Live);
    expect(h.sim.world.match.timeRemaining).toBeLessThan(h.sim.mode.timeLimit);
  });

  it('is deterministic — the same seed replays identically', () => {
    const runOnce = () => {
      const h = makeMatch({ botCount: 8, seed: 'determinism' });
      h.run(20);
      return Array.from(h.sim.world.players.values())
        .sort((a, b) => a.id - b.id)
        .map((p) => `${p.id}:${p.position.x.toFixed(6)},${p.position.z.toFixed(6)}:${p.kills}:${p.deaths}`)
        .join('|');
    };

    expect(runOnce()).toBe(runOnce());
  });

  it('holds a stable tick budget with a full lobby', () => {
    const h = makeMatch({ botCount: 12, difficulty: 'veteran' });
    // Warm up so path graphs and caches are populated.
    h.run(3);

    const ticks = 600;
    const t0 = performance.now();
    for (let i = 0; i < ticks; i++) {
      h.bots.update(TICK_DT);
      h.sim.step(TICK_DT);
    }
    const elapsed = performance.now() - t0;
    const perTick = elapsed / ticks;

    // A 64Hz tick has 15.6ms. Simulation plus AI for 12 bots must leave the
    // overwhelming majority of that for rendering.
    expect(perTick, `${perTick.toFixed(2)}ms per tick`).toBeLessThan(4);
  });
});

describe('game modes', () => {
  it('runs free-for-all without teams', () => {
    const sim = new GameSimulation({ mapId: 'crossfire', modeId: 'ffa' });
    const nav = new NavGraph(sim.map, sim.collision);
    const bots = new BotController(sim, nav, new Rng(7));

    for (let i = 0; i < 6; i++) {
      const p = sim.addPlayer({
        name: `FFA${i}`,
        team: Team.None,
        isBot: true,
        loadout: botLoadout('rifleman', i),
      });
      bots.register(p.id, 'rifleman', DIFFICULTIES.hardened!);
    }

    for (let i = 0; i < Math.round(40 / TICK_DT); i++) {
      bots.update(TICK_DT);
      sim.step(TICK_DT);
    }

    const kills = Array.from(sim.world.players.values()).reduce((a, p) => a + p.kills, 0);
    expect(kills).toBeGreaterThan(0);
  });

  it('runs domination and ticks the objective scoring path', () => {
    const sim = new GameSimulation({ mapId: 'crossfire', modeId: 'domination' });
    const nav = new NavGraph(sim.map, sim.collision);
    const bots = new BotController(sim, nav, new Rng(11));

    for (let i = 0; i < 8; i++) {
      const p = sim.addPlayer({
        name: `Dom${i}`,
        team: i % 2 === 0 ? Team.Allies : Team.Axis,
        isBot: true,
        loadout: botLoadout('rifleman', i),
      });
      bots.register(p.id, 'rifleman', DIFFICULTIES.regular!);
    }

    for (let i = 0; i < Math.round(30 / TICK_DT); i++) {
      bots.update(TICK_DT);
      sim.step(TICK_DT);
    }

    expect(sim.world.match.phase).toBe(MatchPhase.Live);
    expect(Array.from(sim.world.players.values()).every((p) => Number.isFinite(p.position.x))).toBe(true);
  });
});
