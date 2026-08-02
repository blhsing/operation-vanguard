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

const OUT = 'offline';
const INDEX = join(OUT, 'index.html');

let html = readFileSync(INDEX, 'utf8');

/*
 * Drop the source-entry guard.
 *
 * The repository's index.html carries a small script that explains itself when
 * somebody double-clicks it, because it points at TypeScript and cannot run off
 * the disk. This *is* the copy that runs off the disk, so that block is dead
 * weight — and dead weight that would fire if anyone ever changed the condition
 * it keys off.
 *
 * Sliced between markers rather than matched by pattern. The block is a script
 * full of quoted markup and apostrophes, and a regex that has to survive all of
 * that is one nobody will dare edit later.
 */
const GUARD_START = '<!-- SOURCE-ONLY:start -->';
const GUARD_END = '<!-- SOURCE-ONLY:end -->';
for (;;) {
  const from = html.indexOf(GUARD_START);
  if (from < 0) break;
  const to = html.indexOf(GUARD_END, from);
  if (to < 0) throw new Error('unterminated SOURCE-ONLY block in index.html');
  const before = html.slice(0, from).replace(/[ \t]*$/, '');
  const after = html.slice(to + GUARD_END.length).replace(/^[ \t]*\r?\n/, '');
  html = before + after;
}

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

/*
 * LF, always, whatever wrote the source.
 *
 * This folder is committed and CI proves it is current by rebuilding and
 * diffing, so it has to be byte-identical everywhere.
 *
 * The story originally recorded here — a Windows checkout producing CRLF and a
 * Linux one LF — was wrong, and wrong in the direction that flattered me. The
 * repository has carried `* text=auto eol=lf` since M3, so every checkout of
 * index.html is LF on every platform, and the committed source has never held a
 * carriage return. What actually happened is smaller and less excusable: an
 * editor rewrote my working copy of index.html to CRLF while I was adding the
 * source-entry guard. Git normalised it back to LF in the index, so `git status`
 * stayed clean and nothing in the diff ever showed it — but the build reads the
 * working tree, not the index, and copied those bytes straight into a folder
 * marked `-text` specifically so nothing would normalise them. Two mechanisms
 * that each hide line endings, pointed at each other.
 *
 * `\r\n?` rather than `\r\n`, because the file that caused this contained a
 * `\r\r\n`, which the narrower pattern turns into `\r\n` and leaves behind.
 */
html = html.replace(/\r\n?/g, '\n');

// --- refuse to ship something that only works over http ---------------------
//
// These run *before* the write, which they did not used to. The docblock at the
// top of this file has always promised the build would "refuse to emit" a folder
// that cannot run off the disk, and for eight milestones it wrote index.html
// first and threw afterwards — so a failed build left the broken artefact on
// disk, ready for the next command to pick up.

const problems: string[] = [];

if (/<script[^>]*type="module"/.test(html)) problems.push('the entry is still a module script');
if (html.includes('SOURCE-ONLY')) problems.push('the source-entry guard was not stripped');
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

// And nothing emitted may carry a carriage return, or the committed copy stops
// being reproducible the moment something upstream rewrites a source file.
// index.html is checked in memory because it has not been written yet.
if (html.includes('\r')) {
  problems.push('index.html contains CRLF; the committed artefact must be LF everywhere');
}
for (const name of present) {
  if (name === 'index.html') continue;
  if (readFileSync(join(OUT, name), 'utf8').includes('\r')) {
    problems.push(`${name} contains CRLF; the committed artefact must be LF everywhere`);
  }
}

if (problems.length > 0) {
  throw new Error(`this build will not run from file://:\n  - ${problems.join('\n  - ')}`);
}

writeFileSync(INDEX, html, 'utf8');

const listing = readdirSync(OUT)
  .map((f) => `${f} ${(statSync(join(OUT, f)).size / 1024).toFixed(0)} kB`)
  .join(', ');
console.log(`${OUT}/  —  ${listing}`);
console.log('open index.html in Chrome; no server needed');
