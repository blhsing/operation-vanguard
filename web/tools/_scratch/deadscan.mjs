import fs from 'fs';
import path from 'path';

const roots = ['src', 'tests', 'tools'];
const files = [];
function norm(p) { return p.split(path.sep).join('/'); }
function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === '_scratch') continue;
      walk(p);
    } else if (/\.(ts|tsx|js|mjs|html|json)$/.test(e.name)) {
      files.push(norm(p));
    }
  }
}
for (const r of roots) walk(r);
files.push('index.html');
files.push('package.json');
files.push('README.md');

const contents = new Map();
for (const f of files) {
  try { contents.set(f, fs.readFileSync(f, 'utf8')); } catch { /* ignore */ }
}

const exportsList = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n')
  .filter(Boolean)
  .map((l) => { const [n, f] = l.split('|'); return { n, f: norm(f) }; });

const out = [];
for (const { n, f } of exportsList) {
  const re = new RegExp('\\b' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g');
  let ext = 0, own = 0;
  const hits = [];
  for (const [file, txt] of contents) {
    const m = txt.match(re);
    if (!m) continue;
    if (file === f) own += m.length;
    else { ext += m.length; hits.push(file + ':' + m.length); }
  }
  out.push({ n, f, own, ext, hits });
}
const dead = out.filter((o) => o.ext === 0);
console.log('TOTAL', out.length, 'ZERO_EXTERNAL', dead.length);
for (const d of dead) console.log(`${d.n}\t${d.f}\townRefs=${d.own}`);
console.log('--- NEAR-DEAD (ext<=2) ---');
for (const d of out.filter((o) => o.ext > 0 && o.ext <= 2)) {
  console.log(`${d.n}\t${d.f}\text=${d.ext}\t${d.hits.join(' ')}`);
}
