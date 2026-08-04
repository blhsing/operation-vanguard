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
    } else if (/\.(ts|tsx|js|mjs|html)$/.test(e.name)) files.push(norm(p));
  }
}
for (const r of roots) walk(r);
files.push('index.html');

const contents = new Map();
for (const f of files) { try { contents.set(f, fs.readFileSync(f, 'utf8')); } catch { } }

// find enum blocks in src/shared
const enums = [];
for (const [file, txt] of contents) {
  if (!file.startsWith('src/shared/')) continue;
  const re = /export\s+enum\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
  let m;
  while ((m = re.exec(txt))) {
    const name = m[1];
    const body = m[2];
    const members = [...body.matchAll(/^\s*(\w+)\s*(?:=|,|$)/gm)].map((x) => x[1]);
    enums.push({ file, name, members: [...new Set(members)] });
  }
}

for (const e of enums) {
  const dead = [];
  for (const mem of e.members) {
    const re = new RegExp('\\b' + e.name + '\\.' + mem + '\\b', 'g');
    let ext = 0, own = 0;
    for (const [file, txt] of contents) {
      const mm = txt.match(re);
      if (!mm) continue;
      if (file === e.file) own += mm.length; else ext += mm.length;
    }
    if (ext + own === 0) dead.push(mem + ' (0 qualified refs anywhere)');
    else if (ext === 0) dead.push(mem + ` (own=${own}, ext=0)`);
  }
  if (dead.length) console.log(`\n${e.name}  [${e.file}]  ${e.members.length} members\n  DEAD: ${dead.join('\n        ')}`);
}
