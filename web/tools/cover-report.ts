/**
 * Cover report: how many hand-authored cover points actually survive into the
 * nav graph, and on which floor they land.
 *
 * `findCover` — the thing that makes bots hold angles rather than stand in the
 * open — only ever looks at nodes with isCover set, and those come exclusively
 * from a map's authored cover points. A cover point that gets snapped to the
 * wrong storey, or dropped for failing the capsule test, is silently gone: the
 * map still validates and the floor it was meant to defend simply has no
 * tactical positions on it.
 *
 *   npx tsx tools/cover-report.ts
 */

import { BrushCollisionWorld } from '../src/shared/collision/brush-collision.js';
import { NavGraph } from '../src/shared/ai/navigation.js';
import { MAPS } from '../src/shared/map/index.js';

console.log('map            authored  in-graph  lost   upper-authored  upper-in-graph');

for (const [id, map] of Object.entries(MAPS)) {
  const nav = new NavGraph(map, new BrushCollisionWorld(map.brushes, map.bounds));

  const floor = Math.min(...nav.nodes.map((n) => n.position.y));
  const upperAuthored = map.coverPoints.filter((c) => c.position.y > floor + 2).length;
  const inGraph = nav.nodes.filter((n) => n.isCover);
  const upperInGraph = inGraph.filter((n) => n.position.y > floor + 2).length;

  // "Lost" means the designer's point produced no cover node anywhere near it.
  // Two authored points landing within the graph's merge radius collapse into
  // one node that carries both their metadata, which is correct and must not be
  // counted as loss — the naive authored-minus-ingraph subtraction reads a
  // healthy merge as a bug.
  const lost = map.coverPoints.filter(
    (c) =>
      !inGraph.some(
        (n) =>
          Math.hypot(n.position.x - c.position.x, n.position.z - c.position.z) < 2.5 &&
          Math.abs(n.position.y - c.position.y) < 2.5,
      ),
  ).length;
  console.log(
    `${id.padEnd(14)} ${String(map.coverPoints.length).padStart(8)} ${String(inGraph.length).padStart(9)} ` +
      `${String(lost).padStart(5)} ${String(upperAuthored).padStart(15)} ${String(upperInGraph).padStart(15)}` +
      (upperAuthored > 0 && upperInGraph === 0 ? '   <-- every upper cover point lost' : ''),
  );
}
