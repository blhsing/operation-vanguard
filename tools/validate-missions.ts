/**
 * Run validateMission() over every campaign mission and print what it finds.
 *
 *   npx tsx tools/validate-missions.ts
 */

import { validateAllMissions } from '../src/shared/campaign/index.js';

const results = validateAllMissions();
for (const [id, errors] of Object.entries(results)) {
  console.log(`== ${id}`);
  for (const e of errors) console.log(`   ${e}`);
}
if (Object.keys(results).length === 0) console.log('ALL CLEAN');
