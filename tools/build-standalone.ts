/**
 * Fold the built app into one HTML file that runs from `file://`.
 *
 * Vite still emits the script and the stylesheet beside the document even when
 * everything else is inlined, and a `<script src>` or `<link rel=stylesheet>` is
 * a fetch — which from a `file://` origin is a CORS failure, not a load. So the
 * last step is to pull both into the document and delete the tags that pointed
 * at them.
 *
 * Afterwards the file is checked rather than assumed: any surviving reference to
 * a sibling file, any `import` statement, any `fetch` of a relative path, and the
 * build fails. It is very easy to produce a standalone bundle that works
 * perfectly over http and shows a blank page off the disk, and the only way to
 * not ship one is to make the build refuse.
 *
 *   npm run build:standalone
 */

import { readFileSync, writeFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const OUT = 'dist-standalone';
const TARGET = join(OUT, 'vanguard.html');

const html = readFileSync(join(OUT, 'index.html'), 'utf8');
const assets = join(OUT, 'assets');

const files = readdirSync(assets);
const jsFile = files.find((f) => f.endsWith('.js'));
const cssFile = files.find((f) => f.endsWith('.css'));
if (!jsFile) throw new Error('no bundle emitted — did the build run?');

const js = readFileSync(join(assets, jsFile), 'utf8');
const css = cssFile ? readFileSync(join(assets, cssFile), 'utf8') : '';

let out = html
  // Both tags carry a crossorigin attribute and an absolute path; match loosely.
  .replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, '')
  .replace(/<link[^>]*rel="stylesheet"[^>]*>/g, '');

/*
 * The replacements go through a FUNCTION, not a string.
 *
 * A replacement string is scanned for `$` patterns, and `$&` means "the text
 * that matched". Minified bundles are full of one-character identifiers, `$`
 * among them, so a bundle containing `:$&&_(` — a variable named `$` followed by
 * a logical and — silently becomes `:</body>&_(` when spliced in as a string.
 * That is exactly what happened here: three.js's material-parameter object
 * acquired a `</body>` in the middle of it, and the only symptom was
 * `Uncaught SyntaxError: Unexpected token '<'` six hundred kilobytes into a
 * minified file. A function replacer disables the expansion entirely.
 */
if (css) out = out.replace('</head>', () => `<style>\n${css}\n</style>\n</head>`);
// Deliberately not type="module": a classic script has no CORS story at all.
out = out.replace('</body>', () => `<script>\n${js}\n</script>\n</body>`);

// --- refuse to ship something that only works over http ---------------------

const problems: string[] = [];
if (/<script[^>]*\ssrc=/.test(out)) problems.push('a <script src> survived');
if (/<link[^>]*rel="stylesheet"/.test(out)) problems.push('a stylesheet link survived');
if (/\bimport\s*\(/.test(out)) problems.push('a dynamic import() survived');
if (/^\s*import\s/m.test(out)) problems.push('a static import survived');
if (/\bfetch\(\s*['"`]\.?\//.test(out)) problems.push('a fetch of a relative path survived');

// And check the script still parses. Splicing a megabyte of minified JavaScript
// into a document is precisely the kind of operation that corrupts it silently,
// and a build that cheerfully emits a broken file is worse than one that fails.
const scriptStart = out.indexOf('<script>') + '<script>'.length;
const scriptEnd = out.lastIndexOf('</script>');
try {
  new Function(out.slice(scriptStart, scriptEnd));
} catch (e) {
  problems.push(`the inlined script does not parse: ${(e as Error).message}`);
}

if (problems.length > 0) {
  throw new Error(`standalone bundle is not standalone:\n  - ${problems.join('\n  - ')}`);
}

writeFileSync(TARGET, out, 'utf8');

// Everything else in the directory is now dead weight and, worse, a thing a
// reader might mistake for a dependency of the html file.
rmSync(assets, { recursive: true, force: true });
rmSync(join(OUT, 'index.html'), { force: true });

const bytes = statSync(TARGET).size;
console.log(`${TARGET}  ${(bytes / 1024 / 1024).toFixed(2)} MB  (single file, no server needed)`);
