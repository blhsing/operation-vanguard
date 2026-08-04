/**
 * Play one campaign mission headlessly and print what is happening each second.
 *
 * The campaign tests tell you a mission stalled and which objective it stalled
 * on. This tells you why: where the stand-in is, what it is doing, how many
 * hostiles exist and whether they are anywhere near it.
 *
 *   npx tsx tools/mission-trace.ts cold_open 120
 */

import { TICK_DT } from '../src/shared/constants.js';
import { Team } from '../src/shared/types.js';
import { GameSimulation } from '../src/shared/sim/game.js';
import { NavGraph } from '../src/shared/ai/navigation.js';
import { BotController, DIFFICULTIES } from '../src/shared/ai/bot.js';
import { botLoadout } from '../src/shared/sim/loadout.js';
import { Rng } from '../src/shared/rng.js';
import { CampaignDirector, MissionPhase, getMission } from '../src/shared/campaign/index.js';

const missionId = process.argv[2] ?? 'cold_open';
const seconds = Number(process.argv[3] ?? 120);
const seed = Number(process.argv[4] ?? 7);

const mission = getMission(missionId);
const sim = new GameSimulation({ mapId: mission.mapId, modeId: 'campaign', seed: `t-${missionId}-${seed}` });
const nav = new NavGraph(sim.map, sim.collision);
const bots = new BotController(sim, nav, new Rng(seed));
const director = new CampaignDirector(sim, nav, bots, new Rng(seed + 1), mission);

const player = sim.addPlayer({
  name: 'Player',
  team: Team.Allies,
  isBot: true,
  botSkill: 0.75,
  loadout: botLoadout('rifleman', 0),
});
director.begin(player);
bots.register(player.id, 'rifleman', DIFFICULTIES.veteran!);

console.log(`${mission.name} on ${mission.mapId} (seed ${seed})`);

for (let i = 0; i < Math.round(seconds / TICK_DT); i++) {
  const objectives = director.activeObjectives();
  const marked = objectives.find((o) => o.position !== null);
  let target = marked?.position ?? null;
  if (!target) {
    let best = Infinity;
    for (const p of sim.world.players.values()) {
      if (p.team !== Team.Hostile || !p.alive) continue;
      const d = Math.hypot(p.position.x - player.position.x, p.position.z - player.position.z);
      if (d < best) {
        best = d;
        target = p.position;
      }
    }
  }
  bots.orderTo(player.id, target);
  director.setUsing(player.id, objectives.some((o) => o.progress < 1 && marked !== undefined));

  bots.update(TICK_DT);
  const produced = sim.step(TICK_DT);
  director.step(TICK_DT, produced);

  if (i % 64 === 0) {
    const brain = bots.getBrain(player.id);
    const hostiles = [...sim.world.players.values()].filter((p) => p.team === Team.Hostile);
    const alive = hostiles.filter((p) => p.alive);
    let nearest = Infinity;
    for (const h of alive) {
      const d = Math.hypot(h.position.x - player.position.x, h.position.z - player.position.z);
      if (d < nearest) nearest = d;
    }
    const objText = objectives.map((o) => `${o.label}:${o.progress.toFixed(2)}`).join(' ');
    console.log(
      `${String(Math.round(i * TICK_DT)).padStart(4)}s ${director.state.phase.padEnd(9)} ` +
        `pos(${player.position.x.toFixed(0)},${player.position.y.toFixed(1)},${player.position.z.toFixed(0)}) ` +
        `hp${String(Math.round(player.health)).padStart(4)} ${String(brain?.goal ?? '?').padEnd(8)} ` +
        `hostiles ${alive.length}/${hostiles.length} nearest ${nearest === Infinity ? '--' : nearest.toFixed(0) + 'm'} ` +
        `restarts ${director.state.restarts}  [${objText}]`,
    );
  }

  if (director.state.phase === MissionPhase.Complete) {
    console.log(`COMPLETE at ${(i * TICK_DT).toFixed(1)}s`);
    break;
  }
}
