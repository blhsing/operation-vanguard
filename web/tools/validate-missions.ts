/**
 * Validate every campaign mission, structurally and against its map's geometry.
 *
 * The geometric half needs a built collision world, so it is here rather than in
 * the pure data validator — same split `validateMap` uses.
 *
 *   npx tsx tools/validate-missions.ts
 */

import { PLAYER_RADIUS, STANCE_HEIGHT } from '../src/shared/constants.js';
import { vec3 } from '../src/shared/math.js';
import { BrushCollisionWorld } from '../src/shared/collision/brush-collision.js';
import { CollisionLayer } from '../src/shared/collision/collision-types.js';
import { getMap } from '../src/shared/map/index.js';
import {
  CAMPAIGN_MISSIONS,
  validateMission,
  validateMissionGeometry,
} from '../src/shared/campaign/index.js';

let problems = 0;

for (const mission of CAMPAIGN_MISSIONS) {
  const map = getMap(mission.mapId);
  const world = new BrushCollisionWorld(map.brushes, map.bounds);
  const probe = {
    groundNear: (x: number, z: number, from: number, depth: number) =>
      world.groundHeightAt(x, z, from, depth),
    standable: (x: number, y: number, z: number) =>
      world.isCapsuleFree(vec3(x, y, z), STANCE_HEIGHT.stand, PLAYER_RADIUS, {
        layers: CollisionLayer.Movement,
      }),
  };

  const errors = [...validateMission(mission), ...validateMissionGeometry(mission, probe)];
  if (errors.length === 0) continue;
  problems += errors.length;
  console.log(`== ${mission.id}`);
  for (const e of errors) console.log(`   ${e}`);
}

if (problems === 0) console.log('ALL CLEAN');
