/* scratch: do authored upper cover points survive into the nav graph? */
import { BrushCollisionWorld } from '../../src/shared/collision/brush-collision.js';
import { NavGraph } from '../../src/shared/ai/navigation.js';
import { MAPS } from '../../src/shared/map/index.js';

for (const [id, map] of Object.entries(MAPS)) {
  const nav = new NavGraph(map, new BrushCollisionWorld(map.brushes, map.bounds));
  const minY = Math.min(...nav.nodes.map((n) => n.position.y));
  const upper = nav.nodes.filter((n) => n.position.y > minY + 2);
  const upperCover = upper.filter((n) => n.isCover);

  const authoredUpper = map.coverPoints.filter((c) => c.position.y > minY + 2);
  let kept = 0;
  for (const cp of authoredUpper) {
    let bestD = Infinity;
    let best = -1;
    for (const n of nav.nodes) {
      const d = Math.hypot(
        n.position.x - cp.position.x,
        n.position.y - cp.position.y,
        n.position.z - cp.position.z,
      );
      if (d < bestD) {
        bestD = d;
        best = n.id;
      }
    }
    if (bestD < 2.5 && nav.nodes[best]!.isCover) kept++;
  }

  // Ground cover that got lifted onto a deck it was not authored on.
  let lifted = 0;
  for (const cp of map.coverPoints) {
    if (cp.position.y > minY + 2) continue;
    let bestD = Infinity;
    let best = -1;
    for (const n of nav.nodes) {
      const d = Math.hypot(n.position.x - cp.position.x, n.position.z - cp.position.z);
      if (d < bestD) {
        bestD = d;
        best = n.id;
      }
    }
    const n = nav.nodes[best]!;
    if (n.isCover && n.position.y > minY + 2) lifted++;
  }

  console.log(
    `${id.padEnd(14)} nodes=${String(nav.nodes.length).padStart(4)} conn=${nav.connectivity().toFixed(2)}` +
      `  cover=${String(nav.nodes.filter((n) => n.isCover).length).padStart(3)}` +
      `  upper=${String(upper.length).padStart(3)} upperCover=${String(upperCover.length).padStart(3)}` +
      `  authoredUpper=${String(authoredUpper.length).padStart(3)} kept=${String(kept).padStart(3)}` +
      `  groundLiftedOntoDeck=${lifted}`,
  );
}
