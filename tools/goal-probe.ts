/**
 * Throwaway probe: which goal actually chooses a bot's destination, and how
 * often does each one send a bot upstairs?
 *
 * roamDestination demonstrably picks an upper node 11-17% of the time it is
 * consulted, yet under 0.3% of real routing goes upward. So either roam is
 * rarely consulted, or something else is choosing.
 */

import { TICK_DT } from '../src/shared/constants.js';
import { Team } from '../src/shared/types.js';
import { GameSimulation } from '../src/shared/sim/game.js';
import { BOT_ARCHETYPES, botLoadout, type BotArchetype } from '../src/shared/sim/loadout.js';
import { NavGraph } from '../src/shared/ai/navigation.js';
import { BotController, DIFFICULTIES } from '../src/shared/ai/bot.js';
import { Rng } from '../src/shared/rng.js';
import { MAP_IDS } from '../src/shared/map/index.js';

const SECONDS = 120;
const BOTS = 12;

for (const mapId of MAP_IDS) {
  const sim = new GameSimulation({ mapId, modeId: 'tdm', seed: `goal-${mapId}` });
  const nav = new NavGraph(sim.map, sim.collision);
  const bots = new BotController(sim, nav, new Rng(4242));

  const ids: number[] = [];
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
    ids.push(p.id);
  }

  const floor = Math.min(...nav.nodes.map((n) => n.position.y));
  const threshold = floor + 2;

  // How long each goal is held, and where each goal sends the bot.
  const goalTicks = new Map<string, number>();
  const picks = new Map<string, number>();
  const picksUpper = new Map<string, number>();
  const lastDest = new Map<number, number>();

  const ticks = Math.round(SECONDS / TICK_DT);
  for (let t = 0; t < ticks; t++) {
    bots.update(TICK_DT);
    sim.step(TICK_DT);
    for (const id of ids) {
      const brain = bots.getBrain(id);
      if (!brain) continue;
      const g = String(brain.goal);
      goalTicks.set(g, (goalTicks.get(g) ?? 0) + 1);
      if (brain.destination !== lastDest.get(id) && brain.destination >= 0) {
        lastDest.set(id, brain.destination);
        picks.set(g, (picks.get(g) ?? 0) + 1);
        const node = nav.nodes[brain.destination];
        if (node && node.position.y > threshold) {
          picksUpper.set(g, (picksUpper.get(g) ?? 0) + 1);
        }
      }
    }
  }

  const totalTicks = [...goalTicks.values()].reduce((a, b) => a + b, 0);
  const totalPicks = [...picks.values()].reduce((a, b) => a + b, 0);
  const totalUpper = [...picksUpper.values()].reduce((a, b) => a + b, 0);

  const rows = [...picks.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([g, n]) => {
      const up = picksUpper.get(g) ?? 0;
      const held = ((goalTicks.get(g) ?? 0) / totalTicks) * 100;
      return `${g} ${((n / totalPicks) * 100).toFixed(0)}%of-picks/${held.toFixed(0)}%of-time up=${up}`;
    });

  console.log(
    `${mapId.padEnd(14)} picks ${String(totalPicks).padStart(5)}  upper ${String(totalUpper).padStart(4)} ` +
      `(${((totalUpper / Math.max(1, totalPicks)) * 100).toFixed(1)}%)   ${rows.join('  |  ')}`,
  );
}
