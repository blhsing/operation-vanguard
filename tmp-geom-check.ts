import * as THREE from 'three';
import { getMap } from './src/shared/map/index.js';
import { buildMapGeometry, disposeMapGeometry } from './src/client/render/map-geometry.js';

const map = getMap('crossfire');
const result = buildMapGeometry(map);

let meshes = 0;
result.root.traverse((o) => {
  if ((o as THREE.Mesh).isMesh) meshes++;
});

console.log('brushes        :', map.brushes.length);
console.log('visible brushes:', map.brushes.filter((b) => b.visible !== false).length);
console.log('merged meshes  :', meshes);
console.log('triangles      :', result.triangleCount);
console.log('colliderCount  :', result.colliderCount);

if (meshes >= 30) {
  console.error(`FAIL: expected fewer than 30 meshes, got ${meshes}`);
  process.exit(1);
}
if (meshes >= map.brushes.length) {
  console.error('FAIL: no batching happened');
  process.exit(1);
}
console.log('PASS');
disposeMapGeometry(result);
