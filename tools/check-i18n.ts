/**
 * Localisation guards.
 *
 * The interface is Traditional Chinese. Two things can go wrong when it is
 * touched, and neither produces a compile error:
 *
 *   - A user-visible string reverts to, or is added in, English. The game still
 *     runs; one label is simply in the wrong language, which nobody notices
 *     until a player does.
 *   - Something structural gets translated. An `id`, a CSS class, a dataset key,
 *     a spawn group. This one is worse: `id: '突擊步槍'` looks like careful work
 *     and silently breaks every lookup that referenced the old value.
 *
 * So both directions are checked. Developer comments are deliberately expected
 * to stay English — the codebase is documented for the people maintaining it.
 *
 *   npx tsx tools/check-i18n.ts
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const HAN = /[一-鿿]/;

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) tsFiles(p, out);
    else if (entry.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const files = tsFiles('src');
const problems: string[] = [];

// --- 1. display strings that are still entirely English ---------------------
//
// Personal names and alphanumeric model designations are legitimately Latin, so
// the test is "contains no Han AND contains a Latin word", with those exempted.

const DISPLAY =
  /(^|[\s{,])(name|shortName|description|tagline|introLine|brief|outro|verb|label)\s*:\s*'([^']{2,})'/g;

const LATIN_BY_DESIGN = new Set([
  // Squad members. Foreign surnames stay foreign.
  'Vasquez', 'Reyes', 'Okafor', 'Brandt', 'Sood', 'Marchetti', 'Doyle',
  'Ferrara', 'Nasser', 'Lindqvist', 'Kowalczyk', 'Adeyemi', 'Strand',
  // Brands and designations that are not words in any language.
  'Semtex', 'Vector-9', 'RPG-9', 'FIM-9',
]);

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  let m: RegExpExecArray | null;
  DISPLAY.lastIndex = 0;
  while ((m = DISPLAY.exec(src))) {
    const field = m[2]!;
    const value = m[3]!;
    if (HAN.test(value)) continue;
    if (!/[A-Za-z]{3,}/.test(value)) continue; // pure designation, e.g. "M5A1"
    if (LATIN_BY_DESIGN.has(value)) continue;
    // shortName is a HUD abbreviation and is allowed to be a bare designation.
    if (field === 'shortName') continue;
    // Lowercase snake_case is an identifier, not prose. `LaneDef.name` is the
    // clearest case: 'west_platform' is what the AI matches on when it decides
    // which lane a bot is committed to, and it is never drawn anywhere.
    if (/^[a-z][a-z0-9_]*$/.test(value)) continue;
    problems.push(`${file}: ${field} is still English — '${value}'`);
  }
}

// --- 2. structural strings that were translated -----------------------------

const STRUCTURAL: Array<[RegExp, string]> = [
  [/\bid:\s*'([^']*)'/g, 'id'],
  [/\bicon:\s*'([^']*)'/g, 'icon'],
  [/querySelector(?:All)?\(\s*'([^']*)'/g, 'selector'],
  [/classList\.(?:add|remove|toggle|contains)\(\s*'([^']*)'/g, 'class name'],
  [/\bgroup:\s*'([^']*)'/g, 'spawn group'],
  [/\bkind:\s*'([^']*)'/g, 'kind'],
  [/\bmapId:\s*'([^']*)'/g, 'map id'],
];

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  for (const [re, what] of STRUCTURAL) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      if (HAN.test(m[1]!)) problems.push(`${file}: ${what} was translated — '${m[1]}'`);
    }
  }
}

// --- 3. comments must stay English ------------------------------------------

/*
 * The rule is "documentation stays English", not "never name a Chinese term".
 * A comment explaining why a translation reads the way it does has to be able to
 * quote it — 兵種 rather than 職業 is a note that cannot be written without the
 * words it is about. So the test is proportional: a line that is mostly Han is
 * translated prose, a line with a few Han characters inside English is a
 * terminology note and is exactly what should be there.
 */
for (const file of files) {
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (!/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      const body = line.replace(/^\s*(\/\/|\*\/?|\/\*+)\s*/, '').trim();
      if (body.length === 0) return;
      const han = (body.match(/[一-鿿]/g) ?? []).length;
      if (han / body.length > 0.3) {
        problems.push(`${file}:${i + 1}: comment is in Chinese`);
      }
    });
}

if (problems.length > 0) {
  console.error(`${problems.length} localisation problems:\n  ${problems.slice(0, 40).join('\n  ')}`);
  process.exit(1);
}

console.log(`localisation clean across ${files.length} files`);
