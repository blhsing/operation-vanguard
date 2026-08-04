/**
 * Nav graph report: size, connectivity, and the vertical distribution of nodes.
 *
 * The vertical histogram is the useful column. A map with an authored upper
 * floor and no nodes above y=0 has an upper floor that was silently pruned —
 * which renders perfectly and is, to every bot in the match, not there.
 *
 *   npx tsx tools/nav-report.ts
 */

import { BrushCollisionWorld } from '../src/shared/collision/brush-collision.js';
import { NavGraph } from '../src/shared/ai/navigation.js';
import { MAPS } from '../src/shared/map/index.js';

console.log('map            brushes nodes edges  conn  build   vertical distribution');

for (const [id, map] of Object.entries(MAPS)) {
  const t0 = performance.now();
  const nav = new NavGraph(map, new BrushCollisionWorld(map.brushes, map.bounds));
  const ms = performance.now() - t0;

  let edges = 0;
  for (const n of nav.nodes) edges += n.edges.length;

  const bands = new Map<number, number>();
  for (const n of nav.nodes) {
    const band = Math.round(n.position.y);
    bands.set(band, (bands.get(band) ?? 0) + 1);
  }
  const hist = [...bands.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([y, c]) => `y=${y}:${c}`)
    .join('  ');

  console.log(
    `${id.padEnd(14)} ${String(map.brushes.length).padStart(7)} ${String(nav.nodes.length).padStart(5)} ` +
      `${String(edges).padStart(5)} ${String(nav.connectivity()).padStart(5)} ` +
      `${ms.toFixed(0).padStart(5)}ms   ${hist}`,
  );
}
