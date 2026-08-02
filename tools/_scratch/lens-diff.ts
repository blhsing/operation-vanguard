/* scratch: per-cover-point resolution, old probe vs new probe */
import { PLAYER_RADIUS, STANCE_HEIGHT } from '../../src/shared/constants.js';
import { vec3 } from '../../src/shared/math.js';
import { BrushCollisionWorld } from '../../src/shared/collision/brush-collision.js';
import { CollisionLayer } from '../../src/shared/collision/collision-types.js';
import { MAPS } from '../../src/shared/map/index.js';
import { PROP_HEIGHT } from '../../src/shared/map/props.js';

const F = { layers: CollisionLayer.Movement };

for (const [id, map] of Object.entries(MAPS)) {
  const w = new BrushCollisionWorld(map.brushes, map.bounds);
  const changed: string[] = [];
  for (const cp of map.coverPoints) {
    const wide = w.groundHeightAt(cp.position.x, cp.position.z, cp.position.y + 4, 14);
    const near = w.groundHeightAt(cp.position.x, cp.position.z, cp.position.y + 1, PROP_HEIGHT.storey);
    const now = Number.isFinite(near) ? near : wide;
    if (Math.abs(now - wide) < 0.01) continue;
    const ok = (g: number) =>
      Number.isFinite(g) &&
      w.isCapsuleFree(vec3(cp.position.x, g + 0.05, cp.position.z), STANCE_HEIGHT.crouch, PLAYER_RADIUS, F);
    changed.push(
      `(${cp.position.x}, ${cp.position.y}, ${cp.position.z}) v=${cp.value}  old ${Number.isFinite(wide) ? wide.toFixed(2) : 'none'}${ok(wide) ? '' : '(rej)'}` +
        ` -> new ${Number.isFinite(now) ? now.toFixed(2) : 'none'}${ok(now) ? '' : '(rej)'}`,
    );
  }
  console.log(`\n=== ${id}: ${changed.length} cover points change floor ===`);
  for (const c of changed) console.log('   ', c);
}
