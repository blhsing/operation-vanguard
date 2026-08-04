/**
 * Build the offline app — the folder you open straight off the disk.
 *
 * A tiny wrapper so the npm script stays portable: setting an environment
 * variable inline works in sh and fails in cmd, and this project is developed on
 * Windows. Setting it here works everywhere.
 */

import { build } from 'vite';

process.env.VANGUARD_STANDALONE = '1';
// Nothing is fetched at runtime, but a relative base keeps the emitted HTML
// honest in case anything ever is.
process.env.VITE_BASE = './';

await build();
await import('./build-standalone.js');
