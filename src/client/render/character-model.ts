/**
 * Procedural soldier.
 *
 * Blocky on purpose: a browser FPS renders up to a dozen of these plus their
 * shadows, and a box-per-limb body reads cleanly at the ranges that matter while
 * costing almost nothing. What it is *not* allowed to be is a rigid prop — the
 * joint hierarchy below is the animation system's entire interface:
 *
 *   root -> hips -> torso -> head
 *                        `-> leftArm  -> (forearm, glove)
 *                        `-> rightArm -> (forearm, glove, weaponMount)
 *           `-> leftLeg  -> (shin, boot)
 *           `-> rightLeg -> (shin, boot)
 *
 * Each group's origin is the joint, and its children hang below it, so rotating
 * a group swings the limb the way a bone would. Feet rest at y = 0 and the head
 * tops out at ~1.8m so the mesh agrees with the capsule the simulation uses.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Team } from '@shared/types.js';
import { teamMaterial, weaponMaterial } from './materials.js';

export interface CharacterModel {
  root: THREE.Group;
  head: THREE.Object3D;
  torso: THREE.Object3D;
  hips: THREE.Object3D;
  leftArm: THREE.Object3D;
  rightArm: THREE.Object3D;
  leftLeg: THREE.Object3D;
  rightLeg: THREE.Object3D;
  /** Attach a WeaponModel root here; it rides the right arm through animation. */
  weaponMount: THREE.Object3D;
}

const HIP_HEIGHT = 0.92;

/**
 * Deferred box emission.
 *
 * Boxes are collected rather than turned into meshes immediately, then merged
 * per (joint, material) once the whole body is described. A soldier is ~38
 * boxes; emitting one mesh each meant nine opponents cost over 340 draw calls
 * before the map drew a single triangle. None of that detail moves relative to
 * the joint it hangs off, so there is no reason for it to be separately
 * addressable at render time.
 */
interface PendingBox {
  parent: THREE.Object3D;
  material: THREE.Material;
  geometry: THREE.BufferGeometry;
}

let pending: PendingBox[] = [];

function box(
  parent: THREE.Object3D,
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  material: THREE.Material,
): void {
  const geometry = new THREE.BoxGeometry(w, h, d);
  // Bake the offset into the vertices; the merged mesh sits at the joint origin.
  geometry.translate(x, y, z);
  pending.push({ parent, material, geometry });
}

/**
 * Merge everything collected so far into one mesh per (joint, material) and
 * attach it. Returns the meshes so their geometry can be cached and shared.
 */
function flushBatches(): THREE.Mesh[] {
  const groups = new Map<THREE.Object3D, Map<THREE.Material, THREE.BufferGeometry[]>>();

  for (const item of pending) {
    let byMaterial = groups.get(item.parent);
    if (!byMaterial) {
      byMaterial = new Map();
      groups.set(item.parent, byMaterial);
    }
    const list = byMaterial.get(item.material);
    if (list) list.push(item.geometry);
    else byMaterial.set(item.material, [item.geometry]);
  }

  const meshes: THREE.Mesh[] = [];
  for (const [parent, byMaterial] of groups) {
    for (const [material, geometries] of byMaterial) {
      const merged =
        geometries.length === 1 ? geometries[0]! : mergeGeometries(geometries, false);
      // mergeGeometries copies vertex data, so the sources are now dead weight.
      if (geometries.length > 1) {
        for (const g of geometries) g.dispose();
      }
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      parent.add(mesh);
      meshes.push(mesh);
    }
  }

  pending = [];
  return meshes;
}

function joint(parent: THREE.Object3D, name: string, x: number, y: number, z: number): THREE.Group {
  const group = new THREE.Group();
  group.name = name;
  group.position.set(x, y, z);
  parent.add(group);
  return group;
}

interface Kit {
  fatigues: THREE.Material;
  vest: THREE.Material;
  gear: THREE.Material;
  boots: THREE.Material;
  skin: THREE.Material;
  accent: THREE.Material;
}

/**
 * Enemies read hot, friendlies read cool — but hue alone fails in smoke, at
 * range and for colourblind players, so the two also carry different hard
 * points: enemies get angular pauldrons and a helmet antenna, friendlies get a
 * rounded pack and a low-profile helmet. The silhouettes differ before any
 * colour is resolved.
 */
function kit(team: Team, enemy: boolean): Kit {
  return {
    fatigues: teamMaterial(team, enemy),
    vest: weaponMaterial(enemy ? 0x2b2320 : 0x232a30, 0.1, 0.82),
    gear: weaponMaterial(0x1b1d1f, 0.25, 0.7),
    boots: weaponMaterial(0x141414, 0.15, 0.85),
    skin: weaponMaterial(0x9a7357, 0.0, 0.9),
    accent: weaponMaterial(enemy ? 0xd8452c : 0x2f86d8, 0.1, 0.5),
  };
}

function buildLeg(hips: THREE.Object3D, name: string, side: number, k: Kit): THREE.Group {
  const leg = joint(hips, name, side * 0.095, -0.10, 0);
  box(leg, 0.150, 0.42, 0.170, 0, -0.21, 0, k.fatigues);
  // Knee pad — a hard edge on the leg silhouette during a slide.
  box(leg, 0.140, 0.070, 0.030, 0, -0.415, -0.078, k.gear);
  box(leg, 0.130, 0.30, 0.150, 0, -0.57, 0, k.fatigues);
  box(leg, 0.150, 0.100, 0.270, 0, -0.77, 0.045, k.boots);
  return leg;
}

function buildArm(torso: THREE.Object3D, name: string, side: number, k: Kit): THREE.Group {
  const arm = joint(torso, name, side * 0.245, 0.46, 0);
  box(arm, 0.130, 0.30, 0.150, 0, -0.15, 0, k.fatigues);
  box(arm, 0.140, 0.060, 0.160, 0, -0.020, 0, k.vest);
  box(arm, 0.115, 0.28, 0.130, 0, -0.44, 0, k.fatigues);
  box(arm, 0.120, 0.100, 0.140, 0, -0.63, 0, k.gear);
  return arm;
}

export function buildCharacterModel(team: Team, enemy: boolean): CharacterModel {
  const k = kit(team, enemy);
  const root = new THREE.Group();
  root.name = `character:${team}:${enemy ? 'enemy' : 'friendly'}`;

  // --- hips ----------------------------------------------------------------
  const hips = joint(root, 'hips', 0, HIP_HEIGHT, 0);
  box(hips, 0.340, 0.200, 0.220, 0, 0, 0, k.fatigues);
  box(hips, 0.360, 0.055, 0.240, 0, 0.055, 0, k.gear);
  // Belt pouches, offset so the hips are not left/right symmetric.
  box(hips, 0.090, 0.090, 0.070, -0.13, -0.01, 0.130, k.gear);
  box(hips, 0.070, 0.080, 0.060, 0.14, -0.02, 0.120, k.gear);

  // --- torso ---------------------------------------------------------------
  const torso = joint(hips, 'torso', 0, 0.10, 0);
  box(torso, 0.400, 0.520, 0.240, 0, 0.26, 0, k.fatigues);
  box(torso, 0.430, 0.360, 0.285, 0, 0.30, 0, k.vest);
  // Magazine pouches across the front plate.
  for (let i = 0; i < 3; i++) {
    box(torso, 0.075, 0.110, 0.045, (i - 1) * 0.095, 0.235, -0.160, k.gear);
  }
  // Team stripe across the chest and around the left bicep.
  box(torso, 0.300, 0.045, 0.020, 0, 0.415, -0.155, k.accent);
  box(torso, 0.110, 0.020, 0.190, 0, 0.485, 0, k.accent);

  if (enemy) {
    // Angular pauldrons: they widen the shoulders and square off the outline.
    box(torso, 0.105, 0.095, 0.230, -0.235, 0.455, 0, k.gear);
    box(torso, 0.105, 0.095, 0.230, 0.235, 0.455, 0, k.gear);
    box(torso, 0.100, 0.030, 0.220, -0.235, 0.510, 0, k.accent);
    box(torso, 0.100, 0.030, 0.220, 0.235, 0.510, 0, k.accent);
  } else {
    // Rounded pack plus a shoulder radio — a taller, deeper back profile.
    box(torso, 0.270, 0.330, 0.150, 0, 0.300, 0.185, k.gear);
    box(torso, 0.230, 0.040, 0.160, 0, 0.430, 0.190, k.accent);
    box(torso, 0.060, 0.120, 0.055, -0.175, 0.430, 0.120, k.gear);
    box(torso, 0.014, 0.220, 0.014, -0.175, 0.590, 0.120, k.gear);
  }

  box(torso, 0.110, 0.070, 0.110, 0, 0.545, 0, k.skin);

  // --- head ----------------------------------------------------------------
  const head = joint(torso, 'head', 0, 0.55, 0);
  box(head, 0.200, 0.220, 0.210, 0, 0.10, 0, k.skin);
  // Balaclava / lower face cover, so the head is not a bare cube.
  box(head, 0.205, 0.090, 0.215, 0, 0.045, -0.005, k.gear);
  box(head, 0.240, 0.100, 0.250, 0, 0.200, 0.005, k.vest);
  box(head, 0.245, 0.030, 0.100, 0, 0.155, -0.090, k.vest);
  box(head, 0.170, 0.030, 0.020, 0, 0.235, -0.120, k.accent);

  if (enemy) {
    // Helmet antenna: reads at any range and from behind.
    box(head, 0.014, 0.200, 0.014, -0.085, 0.345, 0.060, k.gear);
    box(head, 0.024, 0.028, 0.024, -0.085, 0.455, 0.060, k.accent);
  } else {
    // Night-vision mount on the brow — short, forward, unmistakably not an antenna.
    box(head, 0.070, 0.055, 0.070, 0, 0.235, -0.140, k.gear);
  }

  // --- limbs ---------------------------------------------------------------
  const leftArm = buildArm(torso, 'leftArm', -1, k);
  const rightArm = buildArm(torso, 'rightArm', 1, k);
  const leftLeg = buildLeg(hips, 'leftLeg', -1, k);
  const rightLeg = buildLeg(hips, 'rightLeg', 1, k);

  // Sits at the right glove and slightly inboard, where a rifle's grip lands.
  const weaponMount = joint(rightArm, 'weaponMount', -0.030, -0.640, -0.090);

  flushBatches();

  return { root, head, torso, hips, leftArm, rightArm, leftLeg, rightLeg, weaponMount };
}

/**
 * Frees per-instance geometry. Materials are shared through the material cache;
 * `disposeMaterialCache()` owns those.
 */
export function disposeCharacterModel(m: CharacterModel): void {
  m.root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) obj.geometry.dispose();
  });
  m.root.clear();
}
