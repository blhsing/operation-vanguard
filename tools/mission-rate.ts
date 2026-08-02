/**
 * How often does each mission actually finish?
 *
 * The completability test plays three seeds and passes if any one of them
 * reaches the end. That is the right *shape* for a stochastic stand-in, but it
 * is a coin toss with three flips: a mission that finishes 40% of the time
 * passes comfortably one week and fails the next, and any change to movement or
 * AI reshuffles which missions land badly. Chasing that with a pass/fail is how
 * you end up tuning physics to satisfy a random number generator.
 *
 * This measures the rate instead, so "did that change help or hurt" is a number
 * rather than an argument.
 *
 *   npx tsx tools/mission-rate.ts            # every mission, 12 seeds
 *   npx tsx tools/mission-rate.ts line_three 20
 */

import { TICK_DT } from '../src/shared/constants.js';
import { Team } from '../src/shared/types.js';
import { GameSimulation } from '../src/shared/sim/game.js';
import { NavGraph } from '../src/shared/ai/navigation.js';
import { BotController, DIFFICULTIES } from '../src/shared/ai/bot.js';
import { botLoadout } from '../src/shared/sim/loadout.js';
import { Rng } from '../src/shared/rng.js';
import {
  CAMPAIGN_MISSIONS,
  CampaignDirector,
  MissionPhase,
  getMission,
} from '../src/shared/campaign/index.js';
import type { MissionDef } from '../src/shared/campaign/campaign-types.js';

const arg = process.argv[2];
const seedCount = Number(process.argv[3] ?? 12);
const LIMIT_SECONDS = 600;

interface Outcome {
  finished: boolean;
  seconds: number;
  stuckOn: string;
}

function runOnce(mission: MissionDef, seed: number): Outcome {
  const sim = new GameSimulation({
    mapId: mission.mapId,
    modeId: 'campaign',
    seed: `c-${mission.id}-${seed}`,
  });
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

  const ticks = Math.round(LIMIT_SECONDS / TICK_DT);
  for (let i = 0; i < ticks; i++) {
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
    director.step(TICK_DT, sim.step(TICK_DT));

    if (director.state.phase === MissionPhase.Complete) {
      return { finished: true, seconds: i * TICK_DT, stuckOn: '' };
    }
  }

  const stuck = director.activeObjectives().map((o) => o.id).join(',') || '(none active)';
  return { finished: false, seconds: LIMIT_SECONDS, stuckOn: stuck };
}

const missions = arg ? [getMission(arg)] : CAMPAIGN_MISSIONS;
const seeds = Array.from({ length: seedCount }, (_, i) => 7 + i * 8);

let totalRuns = 0;
let totalWins = 0;

for (const mission of missions) {
  const outcomes = seeds.map((s) => runOnce(mission, s));
  const wins = outcomes.filter((o) => o.finished);
  totalRuns += outcomes.length;
  totalWins += wins.length;

  const rate = (wins.length / outcomes.length) * 100;
  const median =
    wins.length > 0
      ? wins.map((w) => w.seconds).sort((a, b) => a - b)[Math.floor(wins.length / 2)]!.toFixed(0) + 's'
      : '--';

  // Where the failures pile up matters more than how many there are: one
  // objective accounting for every loss is a broken objective, while losses
  // spread evenly across a mission are just a stand-in losing firefights.
  const blockers = new Map<string, number>();
  for (const o of outcomes) {
    if (o.finished) continue;
    blockers.set(o.stuckOn, (blockers.get(o.stuckOn) ?? 0) + 1);
  }
  const worst = [...blockers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2);

  console.log(
    `${mission.id.padEnd(16)} ${String(wins.length).padStart(2)}/${outcomes.length} ` +
      `${rate.toFixed(0).padStart(3)}%  median ${median.padStart(5)}  ` +
      (worst.length ? `blocked: ${worst.map(([k, n]) => `${k}×${n}`).join(' ')}` : ''),
  );
}

console.log(`\noverall ${totalWins}/${totalRuns} (${((totalWins / totalRuns) * 100).toFixed(0)}%)`);
