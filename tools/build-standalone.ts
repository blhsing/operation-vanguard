/**
 * Make the built folder loadable from `file://`, and refuse to emit one that is not.
 *
 * Vite writes the entry as `<script type="module" crossorigin src="…">`, which is
 * correct for a web server and fatal off the disk: a module script is fetched
 * with CORS semantics, a `file://` page has an origin of `null`, and `null`
 * fails the check. The page loads, the script silently does not, and you get a
 * blank screen with one console line about CORS.
 *
 * A classic script tag has no CORS story at all, so the fix is to take the two
 * attributes off. That is the whole transformation — the files themselves are
 * already right, because the bundle is built as an IIFE.
 *
 * The checks afterwards matter more than the edit. It is very easy to produce a
 * build that works perfectly over http and shows nothing off the disk, and the
 * only way to never ship one is to make the build fail instead.
 *
 *   npm run build:standalone
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const OUT = 'dist-standalone';
const INDEX = join(OUT, 'index.html');

let html = readFileSync(INDEX, 'utf8');

// `type="module"` and `crossorigin` both have to go; the src stays exactly as it
// is, because a relative path is the one thing that works everywhere.
/*
 * `defer` is not optional here, and its absence is the trap.
 *
 * Vite emits the entry into <head>, which is safe for a module script because
 * module scripts are deferred by definition. Strip `type="module"` and that
 * guarantee goes with it: a classic script in <head> executes immediately, and
 * the app queries `#app` before the parser has reached <body>. Everything looks
 * right in the markup and nothing works.
 */
html = html.replace(/<script\b[^>]*>/g, (tag) => {
  if (!tag.includes('src=')) return tag;
  const classic = tag
    .replace(/\stype="module"/g, '')
    .replace(/\scrossorigin(?:="[^"]*")?/g, '');
  return /\sdefer\b/.test(classic) ? classic : classic.replace(/\s*>$/, ' defer>');
});
html = html.replace(/<link\b[^>]*rel="stylesheet"[^>]*>/g, (tag) =>
  tag.replace(/\scrossorigin(?:="[^"]*")?/g, ''),
);

writeFileSync(INDEX, html, 'utf8');

// --- refuse to ship something that only works over http ---------------------

const problems: string[] = [];

if (/<script[^>]*type="module"/.test(html)) problems.push('the entry is still a module script');
if (/crossorigin/.test(html)) problems.push('a crossorigin attribute survived, which forces CORS');

// A classic script above <body> runs before the DOM it needs exists.
const headEnd = html.indexOf('</head>');
for (const m of html.matchAll(/<script\b[^>]*\bsrc=[^>]*>/g)) {
  if (m.index! < headEnd && !/\sdefer\b|\sasync\b/.test(m[0])) {
    problems.push('a classic script sits in <head> without defer, so it runs before the DOM');
  }
}

// Every reference must be relative. An absolute path resolves against the drive
// root off the disk and quietly 404s.
for (const [, url] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  if (url.startsWith('data:')) continue;
  if (/^[a-z]+:\/\//i.test(url) || url.startsWith('/')) {
    problems.push(`absolute reference will not resolve from file://: ${url}`);
  }
}

// The referenced files have to actually be there, under the names the HTML uses.
const present = new Set(readdirSync(OUT));
for (const [, url] of html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)) {
  if (!present.has(url)) problems.push(`index.html references ${url}, which was not emitted`);
}

// And the script has to be a classic script in fact, not just in markup. A stray
// `import` or `export` at the top level means the format is wrong and it will
// throw the moment it is parsed.
const jsName = [...present].find((f) => f.endsWith('.js'));
if (!jsName) {
  problems.push('no script was emitted');
} else {
  const js = readFileSync(join(OUT, jsName), 'utf8');
  if (/^\s*import[\s{*'"]/m.test(js)) problems.push(`${jsName} contains a top-level import`);
  if (/^\s*export[\s{*]/m.test(js)) problems.push(`${jsName} contains a top-level export`);
  if (/\bimport\s*\(/.test(js)) problems.push(`${jsName} contains a dynamic import()`);
  try {
    new Function(js);
  } catch (e) {
    problems.push(`${jsName} does not parse: ${(e as Error).message}`);
  }
}

if (problems.length > 0) {
  throw new Error(`this build will not run from file://:\n  - ${problems.join('\n  - ')}`);
}

const listing = readdirSync(OUT)
  .map((f) => `${f} ${(statSync(join(OUT, f)).size / 1024).toFixed(0)} kB`)
  .join(', ');
console.log(`${OUT}/  —  ${listing}`);
console.log('open index.html in Chrome; no server needed');
