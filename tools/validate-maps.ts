/**
 * Run validateMap() over every registered map and print what it finds.
 *
 *   npx tsx tools/validate-maps.ts
 */

import { validateAllMaps } from '../src/shared/map/index.js';

const results = validateAllMaps();
for (const [id, errors] of Object.entries(results)) {
  console.log(`== ${id}`);
  for (const e of errors) console.log(`   ${e}`);
}
if (Object.keys(results).length === 0) console.log('ALL CLEAN');
