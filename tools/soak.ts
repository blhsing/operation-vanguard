/**
 * Match soak: run a real bot match on every map and report how it played.
 *
 * This is not a test — it asserts nothing. It exists because the questions that
 * matter about a map ("do bots fight, do they cross it, do they ever go
 * upstairs") have numeric answers, and a number you look at every time you touch
 * a map is worth more than an opinion formed by watching one round.
 *
 *   npx tsx tools/soak.ts              # every map, 180 s
 *   npx tsx tools/soak.ts subway 300   # one map, 300 s
 */

import { TICK_DT } from '../src/shared/constants.js';
import { SimEventType, Team } from '../src/shared/types.js';
import { GameSimulation } from '../src/shared/sim/game.js';
import { BOT_ARCHETYPES, botLoadout, type BotArchetype } from '../src/shared/sim/loadout.js';
import { NavGraph } from '../src/shared/ai/navigation.js';
import { BotController, DIFFICULTIES } from '../src/shared/ai/bot.js';
import { Rng } from '../src/shared/rng.js';
import { MAP_IDS, getMap } from '../src/shared/map/index.js';

const arg = process.argv[2];
const maps = arg && MAP_IDS.includes(arg) ? [arg] : MAP_IDS;
const seconds = Number(process.argv[3] ?? (arg && !MAP_IDS.includes(arg) ? arg : 180)) || 180;
const BOTS = 12;

/**
 * "Upper floor" is relative to the map, not to y = 0: Subway's ground is its
 * platform at 0 with a track bed below it, and Dust Market's terrace is nearly
 * seven metres up. Two metres above the lowest walkable surface is the line
 * between "standing on a crate" and "on another storey".
 */
function upperThreshold(mapId: string, nav: NavGraph): number {
  const floor = Math.min(...nav.nodes.map((n) => n.position.y));
  void mapId;
  return floor + 2;
}

console.log(
  'map            kills shots  acc   spawns  travel  maxY  upper%  routed%  x-realtime',
);

for (const mapId of maps) {
  const sim = new GameSimulation({ mapId, modeId: 'tdm', seed: `soak-${mapId}` });
  const nav = new NavGraph(sim.map, sim.collision);
  const bots = new BotController(sim, nav, new Rng(4242));

  for (let i = 0; i < BOTS; i++) {
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

  // Count where bots ask to be routed, which is a cleaner signal than where they
  // end up: it separates "never chose to go" from "chose to go and failed".
  const threshold = upperThreshold(mapId, nav);
  let routed = 0;
  let routedUpper = 0;
  const realFindPath = nav.findPath.bind(nav);
  (nav as unknown as { findPath: NavGraph['findPath'] }).findPath = (from, to, out) => {
    routed++;
    if (nav.nodes[to] && nav.nodes[to]!.position.y > threshold) routedUpper++;
    return realFindPath(from, to, out);
  };

  let kills = 0;
  let shots = 0;
  let hits = 0;
  let spawns = 0;
  let maxY = -Infinity;
  let upperSamples = 0;
  let samples = 0;
  let travel = 0;
  const last = new Map<number, { x: number; z: number }>();

  const t0 = performance.now();
  const ticks = Math.round(seconds / TICK_DT);
  for (let i = 0; i < ticks; i++) {
    bots.update(TICK_DT);
    for (const e of sim.step(TICK_DT)) {
      if (e.type === SimEventType.Kill) kills++;
      else if (e.type === SimEventType.Shot) shots++;
      else if (e.type === SimEventType.Hit) hits++;
      else if (e.type === SimEventType.Spawn) spawns++;
    }
    if (i % 32 === 0) {
      for (const p of sim.world.players.values()) {
        if (!p.alive) continue;
        samples++;
        if (p.position.y > maxY) maxY = p.position.y;
        if (p.position.y > threshold) upperSamples++;
        const prev = last.get(p.id);
        // A teleport-sized step is a respawn, not travel.
        if (prev) {
          const d = Math.hypot(p.position.x - prev.x, p.position.z - prev.z);
          if (d < 12) travel += d;
        }
        last.set(p.id, { x: p.position.x, z: p.position.z });
      }
    }
  }
  const wall = (performance.now() - t0) / 1000;

  const pct = (n: number, d: number) => `${((n / Math.max(1, d)) * 100).toFixed(1)}%`;
  console.log(
    `${mapId.padEnd(14)} ${String(kills).padStart(5)} ${String(shots).padStart(5)} ` +
      `${pct(hits, shots).padStart(5)} ${String(spawns).padStart(6)} ` +
      `${(travel / BOTS).toFixed(0).padStart(6)}m ${maxY.toFixed(1).padStart(5)} ` +
      `${pct(upperSamples, samples).padStart(7)} ${pct(routedUpper, routed).padStart(8)} ` +
      `${(seconds / wall).toFixed(0).padStart(9)}x  (${getMap(mapId).name})`,
  );
}
