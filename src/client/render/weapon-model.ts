/**
 * Procedural weapon models.
 *
 * Local space matches the viewmodel camera: -Z is downrange, +Y is up, +X is the
 * shooter's right, and the origin sits at the trigger hand. Every dimension is
 * derived from `WeaponDef.model`, so a balance pass that shortens a barrel also
 * shortens the mesh without anyone touching this file.
 *
 * The named anchors are load-bearing, not decoration:
 *  - `muzzle` is where the flash and smoke spawn,
 *  - `ejectionPort` is where shells are born,
 *  - `sightRear` / `sightFront` are placed at exactly the same X and Y so the
 *    line through them is parallel to -Z. ADS works by translating the model so
 *    that line passes through screen centre; if the two anchors disagree by even
 *    a millimetre the gun points visibly off-centre while aimed.
 */

import * as THREE from 'three';
import type { WeaponDef } from '@shared/data/weapon-types.js';
import { SurfaceType } from '@shared/types.js';
import { surfaceMaterial, weaponMaterial } from './materials.js';

export interface WeaponModel {
  root: THREE.Group;
  muzzle: THREE.Object3D;
  ejectionPort: THREE.Object3D;
  /** Animate a reload by translating this group; it holds the magazine mesh. */
  magazine: THREE.Object3D;
  /** Animate cycling by translating this group along +Z (rearward). */
  boltCarrier: THREE.Object3D;
  sightRear: THREE.Object3D;
  sightFront: THREE.Object3D;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Darken a packed colour without going fully black, for barrel steel and pins. */
function darken(hex: number, f: number): number {
  const r = Math.round(((hex >> 16) & 0xff) * f);
  const g = Math.round(((hex >> 8) & 0xff) * f);
  const b = Math.round((hex & 0xff) * f);
  return (r << 16) | (g << 8) | b;
}

interface Palette {
  body: THREE.Material;
  furniture: THREE.Material;
  steel: THREE.Material;
  sight: THREE.Material;
}

function palette(def: WeaponDef): Palette {
  return {
    body: weaponMaterial(def.model.color, 0.55, 0.44),
    furniture: weaponMaterial(def.model.accentColor, 0.18, 0.66),
    steel: weaponMaterial(darken(def.model.color, 0.55), 0.9, 0.3),
    sight: weaponMaterial(0x0e1012, 0.8, 0.42),
  };
}

function box(
  parent: THREE.Object3D,
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  material: THREE.Material,
  rotX = 0,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y, z);
  if (rotX !== 0) mesh.rotation.x = rotX;
  parent.add(mesh);
  return mesh;
}

/** Cylinder lying along -Z (the barrel axis) rather than three's default +Y. */
function tube(
  parent: THREE.Object3D,
  radius: number,
  length: number,
  x: number,
  y: number,
  z: number,
  material: THREE.Material,
  segments = 10,
): THREE.Mesh {
  const geom = new THREE.CylinderGeometry(radius, radius, length, segments);
  geom.rotateX(Math.PI / 2);
  const mesh = new THREE.Mesh(geom, material);
  mesh.position.set(x, y, z);
  parent.add(mesh);
  return mesh;
}

function anchor(parent: THREE.Object3D, name: string, x: number, y: number, z: number): THREE.Object3D {
  const obj = new THREE.Object3D();
  obj.name = name;
  obj.position.set(x, y, z);
  parent.add(obj);
  return obj;
}

// ---------------------------------------------------------------------------
// Sub-assemblies
// ---------------------------------------------------------------------------

function buildMagazine(group: THREE.Object3D, def: WeaponDef, pal: Palette, barrelZ: number): void {
  switch (def.model.magStyle) {
    case 'stick': {
      // Two raked segments read as a curved STANAG far more cheaply than a
      // lathe-swept curve, and the seam is hidden by the magwell.
      box(group, 0.030, 0.090, 0.062, 0, -0.045, 0.004, pal.furniture, 0.10);
      box(group, 0.029, 0.085, 0.058, 0, -0.126, 0.020, pal.furniture, 0.22);
      box(group, 0.032, 0.010, 0.064, 0, -0.166, 0.029, pal.body, 0.22);
      break;
    }
    case 'box': {
      box(group, 0.050, 0.130, 0.086, 0, -0.068, 0.006, pal.furniture);
      box(group, 0.054, 0.012, 0.090, 0, -0.138, 0.006, pal.body);
      break;
    }
    case 'drum': {
      const geom = new THREE.CylinderGeometry(0.078, 0.078, 0.044, 16);
      geom.rotateZ(Math.PI / 2);
      const drum = new THREE.Mesh(geom, pal.furniture);
      drum.position.set(0, -0.082, 0.01);
      group.add(drum);
      // Feed tower connecting the drum to the magwell.
      box(group, 0.030, 0.050, 0.055, 0, -0.024, 0.004, pal.body);
      break;
    }
    case 'tube': {
      // Shotgun magazine tube: it lives under the barrel, not under the receiver,
      // so the group is repositioned rather than the mesh offset.
      group.position.set(0, -0.026, barrelZ);
      tube(group, 0.017, Math.abs(barrelZ) * 0.9, 0, 0, 0, pal.steel, 10);
      box(group, 0.020, 0.020, 0.018, 0, 0.014, Math.abs(barrelZ) * 0.42, pal.body);
      break;
    }
    case 'none':
      break;
  }
}

function buildStock(root: THREE.Object3D, def: WeaponDef, pal: Palette, from: number, to: number): void {
  const len = to - from;
  if (len <= 0.01) return;
  const mid = from + len / 2;

  switch (def.model.stockStyle) {
    case 'fixed': {
      box(root, 0.046, 0.074, len, 0, -0.014, mid, pal.furniture);
      box(root, 0.052, 0.096, 0.014, 0, -0.020, to, pal.body);
      // Cheek weld ridge.
      box(root, 0.036, 0.016, len * 0.6, 0, 0.030, mid + len * 0.1, pal.furniture);
      break;
    }
    case 'folding': {
      // Folded against the left side of the receiver — a distinct silhouette from
      // 'fixed' at a glance, which is the point of having the variant.
      box(root, 0.020, 0.026, 0.030, 0, -0.006, from + 0.015, pal.steel);
      box(root, 0.018, 0.052, len * 0.92, -0.044, -0.004, mid, pal.steel);
      box(root, 0.022, 0.070, 0.012, -0.044, -0.004, to, pal.furniture);
      break;
    }
    case 'skeleton': {
      const bar = 0.014;
      box(root, bar, bar, len, 0, 0.026, mid, pal.steel);
      box(root, bar, bar, len, 0, -0.038, mid, pal.steel);
      box(root, 0.044, 0.090, 0.014, 0, -0.006, to, pal.furniture);
      box(root, 0.030, 0.014, len * 0.45, 0, 0.038, mid + len * 0.18, pal.furniture);
      break;
    }
    case 'none':
      break;
  }
}

function buildIronSights(
  root: THREE.Object3D,
  pal: Palette,
  sightHeight: number,
  rearZ: number,
  frontZ: number,
): { rear: THREE.Object3D; front: THREE.Object3D } {
  // Rear aperture: two uprights and a bridge, leaving a notch on the sight line.
  box(root, 0.006, 0.024, 0.007, -0.012, sightHeight - 0.004, rearZ, pal.sight);
  box(root, 0.006, 0.024, 0.007, 0.012, sightHeight - 0.004, rearZ, pal.sight);
  box(root, 0.030, 0.006, 0.007, 0, sightHeight + 0.010, rearZ, pal.sight);

  // Front post inside a protective hood.
  box(root, 0.005, 0.022, 0.005, 0, sightHeight - 0.006, frontZ, pal.sight);
  box(root, 0.005, 0.026, 0.006, -0.013, sightHeight - 0.004, frontZ, pal.sight);
  box(root, 0.005, 0.026, 0.006, 0.013, sightHeight - 0.004, frontZ, pal.sight);
  box(root, 0.031, 0.005, 0.006, 0, sightHeight + 0.011, frontZ, pal.sight);

  return {
    rear: anchor(root, 'sightRear', 0, sightHeight, rearZ),
    front: anchor(root, 'sightFront', 0, sightHeight, frontZ),
  };
}

/**
 * The riot shield is not a gun and forcing it through the receiver/barrel layout
 * produces nonsense, so it gets its own body. The anchors are still populated —
 * callers attach effects unconditionally and must not have to special-case it.
 */
function buildRiotShield(def: WeaponDef, pal: Palette): WeaponModel {
  const root = new THREE.Group();
  root.name = `weapon:${def.id}`;

  const w = 0.62;
  const h = 0.98;
  const t = 0.032;
  const panelZ = -0.30;
  const panelY = 0.10;

  // Viewport aperture, framed by four solid segments so it is a real hole.
  const vw = 0.30;
  const vh = 0.15;
  const vy = panelY + 0.26;

  const top = panelY + h / 2;
  const bottom = panelY - h / 2;
  const upper = top - (vy + vh / 2);
  const lower = vy - vh / 2 - bottom;
  const side = (w - vw) / 2;

  box(root, w, upper, t, 0, top - upper / 2, panelZ, pal.body);
  box(root, w, lower, t, 0, bottom + lower / 2, panelZ, pal.body);
  box(root, side, vh, t, -(vw + side) / 2, vy, panelZ, pal.body);
  box(root, side, vh, t, (vw + side) / 2, vy, panelZ, pal.body);

  // Armoured glass in the aperture, using the shared world glass material so it
  // picks up the same tint and transparency as map windows.
  const pane = new THREE.Mesh(new THREE.BoxGeometry(vw, vh, t * 0.4), surfaceMaterial(SurfaceType.Glass));
  pane.position.set(0, vy, panelZ);
  root.add(pane);

  // Reinforcing ribs and the grab handle on the rear face.
  box(root, w * 0.94, 0.026, 0.014, 0, panelY - 0.30, panelZ + t * 0.7, pal.furniture);
  box(root, w * 0.94, 0.026, 0.014, 0, panelY + 0.10, panelZ + t * 0.7, pal.furniture);
  box(root, 0.030, 0.030, 0.16, 0.05, panelY - 0.06, panelZ + 0.10, pal.furniture);

  const magazine = new THREE.Group();
  magazine.name = 'magazine';
  magazine.position.set(0.05, panelY - 0.06, panelZ + 0.10);
  root.add(magazine);

  const boltCarrier = new THREE.Group();
  boltCarrier.name = 'boltCarrier';
  boltCarrier.position.set(0, panelY, panelZ);
  root.add(boltCarrier);

  return {
    root,
    muzzle: anchor(root, 'muzzle', 0, vy, panelZ - t),
    ejectionPort: anchor(root, 'ejectionPort', w / 2, panelY, panelZ),
    magazine,
    boltCarrier,
    sightRear: anchor(root, 'sightRear', 0, vy, panelZ + 0.20),
    sightFront: anchor(root, 'sightFront', 0, vy, panelZ - t),
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function buildWeaponModel(def: WeaponDef): WeaponModel {
  const pal = palette(def);
  if (def.model.magStyle === 'none' && def.id === 'riot_shield') {
    return buildRiotShield(def, pal);
  }

  const m = def.model;
  const root = new THREE.Group();
  root.name = `weapon:${def.id}`;

  // Longitudinal layout. The hand sits at the origin, roughly a third of the way
  // back, which is where a real grip falls on every class from pistol to LMG.
  const L = Math.max(0.16, m.length);
  const front = -L * 0.62;
  const rear = L * 0.38;
  const barrelLen = clamp(m.barrelLength, 0.06, L * 0.85);
  const breech = front + barrelLen;

  const stockLen = m.stockStyle === 'none' ? 0 : L * 0.26;
  const receiverBack = rear - stockLen;
  const receiverLen = Math.max(0.12, receiverBack - breech);
  const receiverZ = breech + receiverLen / 2;

  // --- barrel and muzzle ---------------------------------------------------
  tube(root, 0.0105, barrelLen, 0, 0, front + barrelLen / 2, pal.steel, 12);
  // Flash hider: slightly fatter, with a step so the tip reads at ADS distance.
  tube(root, 0.016, 0.042, 0, 0, front + 0.021, pal.steel, 10);
  tube(root, 0.013, 0.014, 0, 0, front + 0.048, pal.body, 10);

  // --- handguard -----------------------------------------------------------
  const hgLen = barrelLen * 0.72;
  const hgZ = front + barrelLen - hgLen / 2;
  box(root, 0.050, 0.052, hgLen, 0, -0.002, hgZ, pal.furniture);
  // Vent slots, purely for silhouette detail along the top rail line.
  for (let i = 0; i < 3; i++) {
    const z = hgZ - hgLen * 0.25 + (i * hgLen) / 4;
    box(root, 0.054, 0.008, 0.012, 0, 0.020, z, pal.steel);
  }
  // Gas block where the handguard meets the exposed barrel.
  box(root, 0.030, 0.034, 0.030, 0, 0.010, front + barrelLen * 0.24, pal.steel);

  // --- receiver ------------------------------------------------------------
  box(root, 0.052, 0.078, receiverLen, 0, 0, receiverZ, pal.body);
  box(root, 0.044, 0.018, receiverLen * 0.92, 0, 0.046, receiverZ, pal.body);
  // Magwell flare below the receiver, forward of the trigger.
  const magZ = receiverBack - 0.15;
  box(root, 0.042, 0.040, 0.076, 0, -0.050, magZ, pal.body);

  // --- grip, trigger guard, trigger ---------------------------------------
  const gripZ = receiverBack - 0.035;
  box(root, 0.034, 0.118, 0.046, 0, -0.098, gripZ + 0.028, pal.furniture, -0.30);
  const guardZ = receiverBack - 0.090;
  box(root, 0.010, 0.050, 0.012, 0, -0.062, guardZ - 0.030, pal.body);
  box(root, 0.010, 0.050, 0.012, 0, -0.062, guardZ + 0.030, pal.body);
  box(root, 0.010, 0.012, 0.072, 0, -0.083, guardZ, pal.body);
  box(root, 0.008, 0.030, 0.009, 0, -0.055, guardZ + 0.010, pal.steel);

  // --- bolt carrier --------------------------------------------------------
  const boltCarrier = new THREE.Group();
  boltCarrier.name = 'boltCarrier';
  boltCarrier.position.set(0, 0.026, receiverZ);
  root.add(boltCarrier);
  box(boltCarrier, 0.038, 0.026, receiverLen * 0.55, 0, 0, 0, pal.steel);
  // Charging handle, on the right where the ejection port is.
  box(boltCarrier, 0.030, 0.012, 0.014, 0.030, 0.004, receiverLen * 0.22, pal.steel);

  // --- magazine ------------------------------------------------------------
  const magazine = new THREE.Group();
  magazine.name = 'magazine';
  magazine.position.set(0, -0.062, magZ);
  root.add(magazine);
  buildMagazine(magazine, def, pal, front + barrelLen * 0.55);

  // --- stock ---------------------------------------------------------------
  buildStock(root, def, pal, receiverBack, rear);

  // --- carry handle --------------------------------------------------------
  const sightHeight = Math.max(0.02, m.sightHeight);
  let rearSightZ = receiverBack - 0.045;
  if (m.hasCarryHandle) {
    const handleLen = receiverLen * 0.55;
    const handleZ = receiverZ + receiverLen * 0.12;
    const railY = sightHeight - 0.016;
    box(root, 0.026, 0.014, handleLen, 0, railY, handleZ, pal.body);
    box(root, 0.024, railY - 0.052, 0.016, 0, (railY + 0.052) / 2, handleZ - handleLen / 2 + 0.01, pal.body);
    box(root, 0.024, railY - 0.052, 0.016, 0, (railY + 0.052) / 2, handleZ + handleLen / 2 - 0.01, pal.body);
    // The rear sight belongs on the handle, not the receiver, when one is fitted.
    rearSightZ = handleZ + handleLen / 2 - 0.02;
  }

  const sights = buildIronSights(root, pal, sightHeight, rearSightZ, front + 0.055);

  return {
    root,
    muzzle: anchor(root, 'muzzle', 0, 0, front),
    // Just proud of the receiver's right wall, level with the bolt.
    ejectionPort: anchor(root, 'ejectionPort', 0.028, 0.024, breech + Math.min(0.07, receiverLen * 0.35)),
    magazine,
    boltCarrier,
    sightRear: sights.rear,
    sightFront: sights.front,
  };
}

/**
 * Frees the per-instance geometry. Materials come from the shared cache and are
 * left alone; `disposeMaterialCache()` owns those.
 */
export function disposeWeaponModel(m: WeaponModel): void {
  m.root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) obj.geometry.dispose();
  });
  m.root.clear();
}
