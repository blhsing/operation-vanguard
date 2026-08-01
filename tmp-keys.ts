import { getMap } from './src/shared/map/index.js';
import { SURFACE_COLORS, SURFACE_ROUGHNESS, SURFACE_METALNESS } from './src/shared/collision/collision-types.js';
const map = getMap('crossfire');
const counts = new Map<string, number>();
for (const b of map.brushes) {
  const k = `s${b.surface}|c${(b.color ?? SURFACE_COLORS[b.surface]).toString(16)}|r${b.roughness ?? SURFACE_ROUGHNESS[b.surface]}|m${b.metalness ?? SURFACE_METALNESS[b.surface]}|e${b.emissive ?? 0}|cs${b.castShadow !== false ? 1 : 0}`;
  counts.set(k, (counts.get(k) ?? 0) + 1);
}
console.log('groups:', counts.size);
[...counts.entries()].sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log(String(v).padStart(4), k));
