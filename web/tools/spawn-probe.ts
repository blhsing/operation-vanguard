/**
 * Spawn probe: why is this spawn point rejected?
 *
 * validateMap() tells you a spawn is "inside geometry"; this tells you what is
 * under it, what is on top of it, and which nearby point would have worked.
 *
 *   npx tsx tools/spawn-probe.ts highrise
 *   npx tsx tools/spawn-probe.ts highrise 19.5 3.76 4     # one specific point
 */

import { PLAYER_RADIUS, STANCE_HEIGHT } from '../src/shared/constants.js';
import { anglesToForward, vec3 } from '../src/shared/math.js';
import { BrushCollisionWorld } from '../src/shared/collision/brush-collision.js';
import { CollisionLayer, createRaycastHit } from '../src/shared/collision/collision-types.js';
import { MAPS } from '../src/shared/map/index.js';

const mapId = process.argv[2] ?? 'highrise';
const map = MAPS[mapId]!;
const world = new BrushCollisionWorld(map.brushes, map.bounds);
const hit = createRaycastHit();
const fwd = vec3();

function describe(x: number, y: number, z: number, yaw = 0): string {
  const groundY = world.groundHeightAt(x, z, y + 3, 12);
  if (!Number.isFinite(groundY)) return 'NO GROUND within 12m below';
  const feet = vec3(x, groundY + 0.05, z);
  const free = world.isCapsuleFree(feet, STANCE_HEIGHT.stand, PLAYER_RADIUS, {
    layers: CollisionLayer.Movement,
  });
  // How much headroom is there really?
  let headroom = STANCE_HEIGHT.stand;
  for (let h = 0.2; h <= STANCE_HEIGHT.stand; h += 0.1) {
    if (!world.isCapsuleFree(feet, h, PLAYER_RADIUS, { layers: CollisionLayer.Movement })) {
      headroom = h - 0.1;
      break;
    }
  }
  const eye = vec3(x, groundY + 1.6, z);
  anglesToForward(fwd, yaw, 0);
  const sight = world.raycast(eye, fwd, 4, { layers: CollisionLayer.Sight }, hit);
  return (
    `ground ${groundY.toFixed(2)}  ${free ? 'FREE' : 'BLOCKED'}  ` +
    `headroom ${headroom.toFixed(1)}m  ` +
    `sightline ${sight.hit ? sight.distance.toFixed(2) + 'm' : 'clear'}`
  );
}

if (process.argv.length >= 6) {
  const [x, y, z] = [Number(process.argv[3]), Number(process.argv[4]), Number(process.argv[5])];
  console.log(`(${x}, ${y}, ${z}) -> ${describe(x, y, z, Number(process.argv[6] ?? 0))}`);
} else {
  for (const s of map.spawns) {
    const d = describe(s.position.x, s.position.y, s.position.z, s.yaw);
    if (!d.includes('FREE') || d.includes('sightline 0') || d.includes('sightline 1.')) {
      console.log(`${s.group.padEnd(18)} (${s.position.x.toFixed(1)}, ${s.position.y.toFixed(2)}, ${s.position.z.toFixed(1)}) -> ${d}`);
    }
  }
  console.log('(only problem spawns listed)');
}
