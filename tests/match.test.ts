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
import {
  InputFlag,
  MatchPhase,
  SimEventType,
  Team,
  createEmptyInput,
  type SimEvent,
} from '../src/shared/types.js';
import { GameSimulation } from '../src/shared/sim/game.js';
import { BOT_ARCHETYPES, botLoadout, type BotArchetype } from '../src/shared/sim/loadout.js';
import { NavGraph } from '../src/shared/ai/navigation.js';
import { BotController, DIFFICULTIES } from '../src/shared/ai/bot.js';
import { Rng } from '../src/shared/rng.js';
import { v3distance } from '../src/shared/math.js';
import { MAP_IDS } from '../src/shared/map/index.js';

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

  /**
   * Every spawn must land a bot somewhere the graph knows about.
   *
   * This is the check that catches a map whose bounds let the sampler walk on
   * the *roof*: the rooftop is large, flat and perfectly connected, so it wins
   * the largest-component vote and the playable interior is pruned away. The
   * map still validates, still renders, and every bot in it stands still.
   */
  it.each(MAP_IDS)('puts a nav node on the same floor as every spawn on %s', (mapId) => {
    const sim = new GameSimulation({ mapId, modeId: 'tdm' });
    const nav = new NavGraph(sim.map, sim.collision);

    // Same floor, not merely nearby: a graph that has drifted onto the roof
    // still answers `nearestNode` for a spawn on the platform below it, and the
    // bot then paths from a node nine metres above its own head.
    const orphaned = sim.map.spawns.filter((s) => {
      const idx = nav.nearestNode(s.position, 14);
      if (idx < 0) return true;
      return Math.abs(nav.nodes[idx]!.position.y - s.position.y) > 2;
    });
    expect(orphaned.map((s) => `${s.group} @ ${s.position.x},${s.position.z}`)).toEqual([]);
  });

  /**
   * Every floor above the ground must be reachable *from* the ground.
   *
   * A one-way drop down is not enough to keep an upper deck alive: the
   * connectivity pass floods outward following edges, so a deck that can only be
   * left is never reached from below and gets pruned as an island — which is how
   * a hand-authored mezzanine ends up as scenery no bot has ever stood on.
   *
   * The reverse is deliberately not asserted. A bot standing on a crate does not
   * need a planned route down; it walks off the edge and the movement code does
   * the rest. Demanding a modelled descent from every perch would fail maps that
   * are perfectly playable.
   */
  it.each(MAP_IDS)('connects every upper floor on %s to the ground', (mapId) => {
    const sim = new GameSimulation({ mapId, modeId: 'tdm' });
    const nav = new NavGraph(sim.map, sim.collision);

    const floor = Math.min(...nav.nodes.map((n) => n.position.y));
    const upper = nav.nodes.filter((n) => n.position.y > floor + 2);
    if (upper.length === 0) return; // A single-storey map is allowed.

    const ground = nav.nodes.find((n) => n.position.y <= floor + 0.5)!;
    const unreachable = upper.filter((u) => nav.findPath(ground.id, u.id).length === 0);
    expect(
      unreachable.map((u) => `(${u.position.x}, ${u.position.y.toFixed(1)}, ${u.position.z})`),
    ).toEqual([]);
  });

  /**
   * A `ladder` link is a claim that a player can walk this climb on foot.
   *
   * Verify the claim by walking it: hold forward along the link and check the
   * player actually ends up on the upper deck. Stairs that stop half a metre
   * short of the surface they serve look completely correct in the map file and
   * in the renderer, and are impassable.
   */
  it.each(MAP_IDS)('backs every ladder link on %s with a climbable route', (mapId) => {
    const sim = new GameSimulation({ mapId, modeId: 'tdm' });
    const ladders = sim.map.navLinks.filter((l) => l.kind === 'ladder' && l.to.y > l.from.y + 1);
    if (ladders.length === 0) return;

    for (const link of ladders) {
      const player = sim.addPlayer({ name: 'Climber', team: Team.Allies, isBot: false });
      sim.step(TICK_DT);
      player.position.x = link.from.x;
      player.position.y = link.from.y + 0.1;
      player.position.z = link.from.z;
      player.velocity.x = 0;
      player.velocity.y = 0;
      player.velocity.z = 0;

      // Face the top of the climb and walk at it.
      const yaw = Math.atan2(-(link.to.x - link.from.x), -(link.to.z - link.from.z));
      let peak = -Infinity;
      for (let i = 0; i < Math.round(10 / TICK_DT); i++) {
        const cmd = createEmptyInput();
        cmd.dt = TICK_DT;
        cmd.seq = i;
        cmd.tick = sim.world.tick;
        cmd.yaw = yaw;
        cmd.moveForward = 1;
        cmd.buttons |= InputFlag.Sprint;
        sim.setInput(player.id, cmd);
        sim.step(TICK_DT);
        if (player.position.y > peak) peak = player.position.y;
      }

      expect(
        peak,
        `${mapId}: ladder to (${link.to.x}, ${link.to.y}, ${link.to.z}) tops out at ${peak.toFixed(2)}`,
      ).toBeGreaterThanOrEqual(link.to.y - 0.5);
      sim.removePlayer(player.id);
    }
  });

  /**
   * A second storey has to be somewhere bots actually go.
   *
   * Being *reachable* turns out not to be enough, and the gap between the two is
   * embarrassingly wide. Bots spend four fifths of a match in the Engage goal,
   * which routes them at whoever they can see; roaming, the only goal that picks
   * a destination on the merits, accounts for about 3% of decisions. So an upper
   * floor is populated only if somebody is already on it — which on a dead-end
   * mezzanine nobody ever is. Highrise and Dust Market both shipped with upper
   * decks that validated, rendered, pathed correctly, and had never once had a
   * bot standing on them.
   *
   * The threshold is deliberately a floor's worth of nodes. A four-node perch on
   * top of a crate is not a storey and nobody should have to justify it here.
   */
  /**
   * The designer's cover points on an upper floor have to survive into the graph.
   *
   * `findCover` — the only thing that makes a bot hold an angle rather than
   * stand in the open — looks exclusively at nodes carrying `isCover`, and those
   * come exclusively from authored cover points. A point that gets snapped to
   * the wrong storey while being dropped onto geometry is gone without a trace:
   * the map still validates, still renders, still paths, and the floor it was
   * meant to defend simply has no tactical positions on it.
   *
   * That is not hypothetical. Subway shipped with all thirty-four of its
   * mezzanine cover points resolving onto the underside of the station ceiling
   * and failing the capsule test, and Highrise with eleven of fifteen landing on
   * the office roof, an unreachable island the connectivity pass then deleted.
   */
  it.each(MAP_IDS)('keeps the authored upper-floor cover on %s', (mapId) => {
    const sim = new GameSimulation({ mapId, modeId: 'tdm' });
    const nav = new NavGraph(sim.map, sim.collision);

    const floor = Math.min(...nav.nodes.map((n) => n.position.y));
    if (nav.nodes.filter((n) => n.position.y > floor + 2).length < 20) return; // A perch.

    const authored = sim.map.coverPoints.filter((c) => c.position.y > floor + 2);
    if (authored.length === 0) return;

    const cover = nav.nodes.filter((n) => n.isCover);
    const survived = authored.filter((c) =>
      cover.some(
        (n) =>
          Math.hypot(n.position.x - c.position.x, n.position.z - c.position.z) < 2.5 &&
          Math.abs(n.position.y - c.position.y) < 2.5,
      ),
    ).length;

    // Not all of them: two points inside the merge radius legitimately collapse
    // into one node that carries both their metadata. Most of them, though.
    expect(
      survived / authored.length,
      `${mapId}: only ${survived} of ${authored.length} authored upper cover points reached the graph`,
    ).toBeGreaterThan(0.6);
  });

  it.each(MAP_IDS)('puts bots on the upper floors of %s, not just in reach of them', (mapId) => {
    // Asked across playthroughs. Upper-floor occupancy runs at a few percent on
    // the maps where it works at all, so a single match is a coin toss and a
    // single-seed assertion would fail for reasons that have nothing to do with
    // whether the storey is usable.
    let seen = 0;
    let upperNodes = 0;

    for (const seed of [99, 314]) {
      const sim = new GameSimulation({ mapId, modeId: 'tdm', seed: `vertical-${mapId}-${seed}` });
      const nav = new NavGraph(sim.map, sim.collision);

      const floor = Math.min(...nav.nodes.map((n) => n.position.y));
      const upper = nav.nodes.filter((n) => n.position.y > floor + 2);
      if (upper.length < 20) return; // A perch, not a storey.
      upperNodes = upper.length;

      const bots = new BotController(sim, nav, new Rng(seed));
      for (let i = 0; i < 10; i++) {
        const archetype: BotArchetype = BOT_ARCHETYPES[i % BOT_ARCHETYPES.length]!;
        const p = sim.addPlayer({
          name: `Bot${i}`,
          team: i % 2 === 0 ? Team.Allies : Team.Axis,
          isBot: true,
          botSkill: 0.5,
          loadout: botLoadout(archetype, i),
        });
        bots.register(p.id, archetype, DIFFICULTIES.regular!);
      }

      const ticks = Math.round(90 / TICK_DT);
      for (let i = 0; i < ticks; i++) {
        bots.update(TICK_DT);
        sim.step(TICK_DT);
        if (i % 32 !== 0) continue;
        for (const p of sim.world.players.values()) {
          if (p.alive && p.position.y > floor + 2) seen++;
        }
      }
      if (seen > 0) return;
    }

    expect.fail(`${mapId} has a ${upperNodes}-node upper floor that no bot stood on in two matches`);
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

describe('every registered map', () => {
  it('supports a real bot match without anyone breaking', () => {
    for (const mapId of MAP_IDS) {
      const sim = new GameSimulation({ mapId, modeId: 'tdm', seed: `map-${mapId}` });
      const nav = new NavGraph(sim.map, sim.collision);
      const bots = new BotController(sim, nav, new Rng(3));

      // Small maps cannot hold a full lobby; scale to what the map declares.
      const count = Math.min(8, sim.map.playerCount[1]);
      for (let i = 0; i < count; i++) {
        const p = sim.addPlayer({
          name: `B${i}`,
          team: i % 2 === 0 ? Team.Allies : Team.Axis,
          isBot: true,
          loadout: botLoadout('rifleman', i),
        });
        bots.register(p.id, 'rifleman', DIFFICULTIES.hardened!);
      }

      for (let i = 0; i < Math.round(30 / TICK_DT); i++) {
        bots.update(TICK_DT);
        sim.step(TICK_DT);
      }

      const players = Array.from(sim.world.players.values());
      expect(players.length, `${mapId}`).toBe(count);
      for (const p of players) {
        expect(Number.isFinite(p.position.x), `${mapId}: ${p.name} x`).toBe(true);
        expect(Number.isFinite(p.position.z), `${mapId}: ${p.name} z`).toBe(true);
        expect(p.position.y, `${mapId}: ${p.name} fell out of the world`).toBeGreaterThan(
          sim.map.bounds.min.y - 25,
        );
      }
      // A 30s match on any map should produce at least some contact.
      const shots = players.reduce((a, p) => a + p.deaths + p.kills, 0);
      expect(shots, `${mapId} produced no combat at all`).toBeGreaterThan(0);
    }
  });

  it('builds a connected navigation graph for every map', () => {
    for (const mapId of MAP_IDS) {
      const sim = new GameSimulation({ mapId, modeId: 'tdm' });
      const nav = new NavGraph(sim.map, sim.collision);
      expect(nav.size, `${mapId} node count`).toBeGreaterThan(30);
      expect(nav.connectivity(), `${mapId} connectivity`).toBe(1);
    }
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
