/**
 * Can anything actually get to every campaign objective?
 *
 * A mission objective is a box in space. The player has to stand in it, and so
 * does a bot, and nothing in the mission data says whether the map allows that.
 * `validate-missions` proves the objective *graph* is sound — dependencies
 * resolve, quotas are reachable, placements sit on real floors — which is a
 * different claim and passes happily on a mission nobody can finish.
 *
 * Last Floor was the demonstration. Its final two objectives stand on a helipad
 * half a metre proud of the roof deck, against a step height of forty-two
 * centimetres. Every nav sample on that pad was pruned as an unreachable island,
 * the stand-in walked to the nearest surviving node eleven metres short, and the
 * mission sat at progress 0.00 for the rest of its runtime with every hostile
 * dead and full health. It read as a hard mission for five milestones.
 *
 * The signature is unmistakable once you look for it: an objective that fails at
 * *exactly* 0.00 has not been attempted and lost, it has never been entered. So
 * this asks the only question that matters — is there a nav node inside the
 * zone, and can you get to it from where the mission drops you?
 *
 *   npx tsx tools/objective-reach.ts
 *   npx tsx tools/objective-reach.ts cracking_tower
 */

import { GameSimulation } from '../src/shared/sim/game.js';
import { NavGraph } from '../src/shared/ai/navigation.js';
import { CAMPAIGN_MISSIONS, getMission } from '../src/shared/campaign/index.js';
import type { MissionDef, Objective } from '../src/shared/campaign/campaign-types.js';
import { vec3, type Vec3 } from '../src/shared/math.js';

const only = process.argv[2];
const missions = only ? [getMission(only)] : CAMPAIGN_MISSIONS;

/** The zone an objective wants a body standing in, if it has one. */
function zoneOf(def: Objective): { center: Vec3; size: Vec3 } | null {
  const t = def.trigger;
  if (t.kind === 'reach' || t.kind === 'hold' || t.kind === 'interact' || t.kind === 'escort') {
    return t.zone;
  }
  return null;
}

let problems = 0;

for (const mission of missions as MissionDef[]) {
  const sim = new GameSimulation({ mapId: mission.mapId, modeId: 'campaign', seed: 'reach' });
  const nav = new NavGraph(sim.map, sim.collision);

  console.log(`\n${mission.id}  (${mission.mapId}, ${nav.nodes.length} nav nodes)`);

  const start = nav.nearestNode(mission.insertion.position, 30);
  if (start < 0) {
    console.log(`  !! insertion point has no nav node within 30 m — nothing can start this mission`);
    problems++;
    continue;
  }

  for (const def of mission.objectives) {
    const zone = zoneOf(def);
    if (!zone) {
      console.log(`  ${def.id.padEnd(16)} (no zone — kill quota or timer)`);
      continue;
    }

    // Nodes standing inside the box the objective actually tests against.
    const hx = zone.size.x / 2;
    const hy = zone.size.y / 2;
    const hz = zone.size.z / 2;
    const inside = nav.nodes.filter(
      (n) =>
        Math.abs(n.position.x - zone.center.x) <= hx &&
        Math.abs(n.position.y - zone.center.y) <= hy &&
        Math.abs(n.position.z - zone.center.z) <= hz,
    );

    const nearest = nav.nearestNode(zone.center, 40);
    const np = nearest >= 0 ? nav.nodes[nearest]!.position : null;
    const gap = np
      ? Math.hypot(np.x - zone.center.x, np.z - zone.center.z)
      : Infinity;

    // And can you get there from the insertion point at all?
    let routed = false;
    if (inside.length > 0) {
      const target = nav.nearestNode(inside[0]!.position, 4);
      routed = target >= 0 && nav.findPath(start, target).length > 0;
    }

    const bad = inside.length === 0 || !routed;
    if (bad) problems++;
    console.log(
      `  ${bad ? '!!' : 'ok'} ${def.id.padEnd(16)} ${String(inside.length).padStart(3)} nodes in zone` +
        `   nearest node ${gap === Infinity ? 'none within 40m' : gap.toFixed(1) + 'm from centre'}` +
        `   ${inside.length > 0 ? (routed ? 'routable' : 'UNREACHABLE from insertion') : 'NO NODE INSIDE'}`,
    );
  }
}

console.log(
  problems === 0
    ? '\nALL OBJECTIVES REACHABLE'
    : `\n${problems} objective(s) cannot be reached — a mission cannot be finished by anything that walks`,
);
process.exitCode = problems === 0 ? 0 : 1;
