/**
 * The arsenal.
 *
 * Weapons are declared with `defineWeapon`, which fills in class-appropriate
 * defaults so each entry reads as *what makes this gun different* rather than as
 * forty fields of boilerplate. Anything a weapon doesn't override is inherited
 * from its class archetype, which also means a class-wide balance change is a
 * one-line edit.
 *
 * The balance targets every weapon is designed against — and which
 * `validateArsenal()` enforces — are:
 *
 *   AR      250-420 ms TTK at 20 m, chest
 *   SMG     180-320 ms TTK inside 12 m, but losing to ARs past ~25 m
 *   LMG     slow to aim, forgiving to hold, strong through walls
 *   Sniper  bolt-action one-shots the chest inside its first stop; >= 0.5 s ADS
 *   Shotgun lethal inside ~6 m, near-useless past ~14 m
 *
 * No weapon may kill in under 150 ms with body shots. That floor exists because
 * anything faster is not reactable at any realistic ping.
 */

import { HEALTH } from '../constants.js';
import {
  AttachmentSlot,
  FireMode,
  WeaponClass,
  WeaponTrait,
  damageAtRange,
  timeToKill,
  type DamageStop,
  type RecoilProfile,
  type SpreadProfile,
  type WeaponDef,
  type WeaponHandling,
} from './weapon-types.js';

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// Recoil pattern helpers
//
// Patterns are authored as (pitch, yaw) pairs in degrees for readability and
// converted to radians on the way in. Hand-authoring 8-12 steps per gun is what
// gives each one a learnable signature.
// ---------------------------------------------------------------------------

function pattern(...steps: Array<[number, number]>): Array<{ pitch: number; yaw: number }> {
  return steps.map(([p, y]) => ({ pitch: p * DEG, yaw: y * DEG }));
}

/**
 * A pattern that climbs, then drifts to one side, then snaps back — the shape
 * that rewards learning a gun rather than just pulling down.
 */
function climbAndDrift(
  climb: number,
  drift: number,
  length = 12,
  settle = 0.55,
): Array<{ pitch: number; yaw: number }> {
  const out: Array<{ pitch: number; yaw: number }> = [];
  for (let i = 0; i < length; i++) {
    const t = i / (length - 1);
    // Vertical kick is strongest early, then plateaus.
    const p = climb * (0.55 + 0.45 * Math.sin(t * Math.PI * 0.8));
    // Horizontal drifts one way then reverses, giving the classic sine sway.
    const y = drift * Math.sin(t * Math.PI * 1.6) * (1 - settle * t);
    out.push({ pitch: p * DEG, yaw: y * DEG });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Class archetypes
// ---------------------------------------------------------------------------

interface Archetype {
  recoil: RecoilProfile;
  spread: SpreadProfile;
  handling: WeaponHandling;
  attachmentSlots: AttachmentSlot[];
  penetration: number;
  vehicleDamageMultiplier: number;
  muzzleVelocity: number;
  bulletGravity: number;
  adsZoom: number;
  scoped: boolean;
  scopeFocusTime: number;
  meleeDamage: number;
  pellets: number;
  burstCount: number;
  burstDelay: number;
  maxReserve: number;
}

const FULL_SLOTS = [
  AttachmentSlot.Muzzle,
  AttachmentSlot.Barrel,
  AttachmentSlot.Optic,
  AttachmentSlot.Underbarrel,
  AttachmentSlot.Magazine,
  AttachmentSlot.Stock,
  AttachmentSlot.RearGrip,
  AttachmentSlot.Laser,
];

const PISTOL_SLOTS = [
  AttachmentSlot.Muzzle,
  AttachmentSlot.Barrel,
  AttachmentSlot.Optic,
  AttachmentSlot.Magazine,
  AttachmentSlot.RearGrip,
  AttachmentSlot.Laser,
];

function baseSpread(o: Partial<SpreadProfile>): SpreadProfile {
  return {
    hipMin: 2.4 * DEG,
    hipMax: 6.5 * DEG,
    adsMin: 0.12 * DEG,
    adsMax: 1.6 * DEG,
    perShot: 0.16 * DEG,
    recovery: 4.2 * DEG,
    movingMultiplier: 1.55,
    jumpingMultiplier: 2.6,
    crouchMultiplier: 0.82,
    proneMultiplier: 0.68,
    ...o,
  };
}

function baseHandling(o: Partial<WeaponHandling>): WeaponHandling {
  return {
    adsTime: 0.26,
    sprintOutTime: 0.19,
    drawTime: 0.55,
    holsterTime: 0.4,
    reloadTime: 2.0,
    reloadEmptyTime: 2.6,
    reloadAmmoTime: 1.35,
    reloadEmptyAmmoTime: 1.9,
    movementSpeedMultiplier: 1.0,
    adsSpeedMultiplier: 1.0,
    swayAmount: 0.9 * DEG,
    swaySpeed: 1.1,
    ...o,
  };
}

function baseRecoil(o: Partial<RecoilProfile>): RecoilProfile {
  return {
    pattern: climbAndDrift(0.42, 0.2),
    randomPitch: 0.05 * DEG,
    randomYaw: 0.09 * DEG,
    recoverySpeed: 9.5,
    recoveryFraction: 0.9,
    viewKickMultiplier: 1.0,
    cameraShake: 0.35 * DEG,
    ...o,
  };
}

const ARCHETYPES: Record<WeaponClass, Archetype> = {
  [WeaponClass.AssaultRifle]: {
    recoil: baseRecoil({ pattern: climbAndDrift(0.44, 0.24), recoverySpeed: 9.0 }),
    spread: baseSpread({}),
    handling: baseHandling({ adsTime: 0.27, movementSpeedMultiplier: 0.97 }),
    attachmentSlots: FULL_SLOTS,
    penetration: 0.55,
    vehicleDamageMultiplier: 1.0,
    muzzleVelocity: Infinity,
    bulletGravity: 0,
    adsZoom: 1.25,
    scoped: false,
    scopeFocusTime: 0,
    meleeDamage: 55,
    pellets: 1,
    burstCount: 1,
    burstDelay: 0,
    maxReserve: 300,
  },
  [WeaponClass.SubmachineGun]: {
    recoil: baseRecoil({ pattern: climbAndDrift(0.36, 0.36), recoverySpeed: 11.0, cameraShake: 0.28 * DEG }),
    spread: baseSpread({ hipMin: 1.6 * DEG, hipMax: 5.4 * DEG, perShot: 0.2 * DEG, recovery: 5.4 * DEG }),
    handling: baseHandling({
      adsTime: 0.21,
      sprintOutTime: 0.13,
      drawTime: 0.45,
      holsterTime: 0.32,
      reloadTime: 1.75,
      reloadEmptyTime: 2.25,
      reloadAmmoTime: 1.15,
      reloadEmptyAmmoTime: 1.6,
      movementSpeedMultiplier: 1.05,
      adsSpeedMultiplier: 1.08,
    }),
    attachmentSlots: FULL_SLOTS,
    penetration: 0.35,
    vehicleDamageMultiplier: 0.85,
    muzzleVelocity: Infinity,
    bulletGravity: 0,
    adsZoom: 1.18,
    scoped: false,
    scopeFocusTime: 0,
    meleeDamage: 55,
    pellets: 1,
    burstCount: 1,
    burstDelay: 0,
    maxReserve: 300,
  },
  [WeaponClass.LightMachineGun]: {
    recoil: baseRecoil({ pattern: climbAndDrift(0.5, 0.3, 14), recoverySpeed: 7.0, cameraShake: 0.5 * DEG }),
    spread: baseSpread({ hipMin: 3.6 * DEG, hipMax: 8.2 * DEG, adsMin: 0.14 * DEG, perShot: 0.12 * DEG }),
    handling: baseHandling({
      adsTime: 0.42,
      sprintOutTime: 0.32,
      drawTime: 0.9,
      holsterTime: 0.7,
      reloadTime: 4.4,
      reloadEmptyTime: 5.4,
      reloadAmmoTime: 3.1,
      reloadEmptyAmmoTime: 4.0,
      movementSpeedMultiplier: 0.86,
      adsSpeedMultiplier: 0.8,
    }),
    attachmentSlots: FULL_SLOTS,
    penetration: 0.85,
    vehicleDamageMultiplier: 1.25,
    muzzleVelocity: Infinity,
    bulletGravity: 0,
    adsZoom: 1.3,
    scoped: false,
    scopeFocusTime: 0,
    meleeDamage: 55,
    pellets: 1,
    burstCount: 1,
    burstDelay: 0,
    maxReserve: 400,
  },
  [WeaponClass.SniperRifle]: {
    recoil: baseRecoil({
      pattern: pattern([2.2, 0.4], [2.4, -0.5], [2.3, 0.6]),
      randomPitch: 0.2 * DEG,
      randomYaw: 0.25 * DEG,
      recoverySpeed: 5.0,
      cameraShake: 1.6 * DEG,
      viewKickMultiplier: 1.8,
    }),
    spread: baseSpread({
      hipMin: 7.5 * DEG,
      hipMax: 11 * DEG,
      adsMin: 0,
      adsMax: 0.5 * DEG,
      perShot: 0.5 * DEG,
      recovery: 3.0 * DEG,
      movingMultiplier: 2.2,
    }),
    handling: baseHandling({
      adsTime: 0.58,
      sprintOutTime: 0.4,
      drawTime: 1.0,
      holsterTime: 0.8,
      reloadTime: 3.2,
      reloadEmptyTime: 3.9,
      reloadAmmoTime: 2.2,
      reloadEmptyAmmoTime: 2.9,
      movementSpeedMultiplier: 0.88,
      adsSpeedMultiplier: 0.62,
      swayAmount: 2.6 * DEG,
      swaySpeed: 0.7,
    }),
    attachmentSlots: FULL_SLOTS,
    penetration: 1.0,
    vehicleDamageMultiplier: 1.5,
    muzzleVelocity: Infinity,
    bulletGravity: 0,
    adsZoom: 4.2,
    scoped: true,
    scopeFocusTime: 0.12,
    meleeDamage: 55,
    pellets: 1,
    burstCount: 1,
    burstDelay: 0,
    maxReserve: 60,
  },
  [WeaponClass.MarksmanRifle]: {
    recoil: baseRecoil({
      pattern: pattern([0.95, 0.18], [1.1, -0.24], [1.05, 0.3], [1.15, -0.2]),
      recoverySpeed: 7.5,
      cameraShake: 0.7 * DEG,
    }),
    spread: baseSpread({ hipMin: 4.2 * DEG, hipMax: 8 * DEG, adsMin: 0.03 * DEG, perShot: 0.3 * DEG }),
    handling: baseHandling({
      adsTime: 0.36,
      sprintOutTime: 0.26,
      drawTime: 0.7,
      holsterTime: 0.55,
      reloadTime: 2.5,
      reloadEmptyTime: 3.1,
      reloadAmmoTime: 1.7,
      reloadEmptyAmmoTime: 2.3,
      movementSpeedMultiplier: 0.93,
      adsSpeedMultiplier: 0.85,
      swayAmount: 1.4 * DEG,
    }),
    attachmentSlots: FULL_SLOTS,
    penetration: 0.8,
    vehicleDamageMultiplier: 1.2,
    muzzleVelocity: Infinity,
    bulletGravity: 0,
    adsZoom: 2.4,
    scoped: false,
    scopeFocusTime: 0,
    meleeDamage: 55,
    pellets: 1,
    burstCount: 1,
    burstDelay: 0,
    maxReserve: 120,
  },
  [WeaponClass.Shotgun]: {
    recoil: baseRecoil({
      pattern: pattern([1.8, 0.3], [1.9, -0.4], [1.85, 0.5]),
      recoverySpeed: 6.5,
      cameraShake: 1.1 * DEG,
      viewKickMultiplier: 1.5,
    }),
    spread: baseSpread({
      hipMin: 3.2 * DEG,
      hipMax: 5.5 * DEG,
      adsMin: 2.0 * DEG,
      adsMax: 3.6 * DEG,
      perShot: 0.3 * DEG,
      recovery: 5.0 * DEG,
    }),
    handling: baseHandling({
      adsTime: 0.24,
      sprintOutTime: 0.16,
      drawTime: 0.6,
      holsterTime: 0.45,
      reloadTime: 0.62,
      reloadEmptyTime: 0.62,
      reloadAmmoTime: 0.38,
      reloadEmptyAmmoTime: 0.38,
      movementSpeedMultiplier: 0.95,
    }),
    attachmentSlots: FULL_SLOTS,
    penetration: 0.2,
    vehicleDamageMultiplier: 0.7,
    muzzleVelocity: Infinity,
    bulletGravity: 0,
    adsZoom: 1.12,
    scoped: false,
    scopeFocusTime: 0,
    meleeDamage: 55,
    pellets: 8,
    burstCount: 1,
    burstDelay: 0,
    maxReserve: 60,
  },
  [WeaponClass.Pistol]: {
    recoil: baseRecoil({
      pattern: climbAndDrift(0.55, 0.4, 8),
      recoverySpeed: 12.0,
      cameraShake: 0.3 * DEG,
    }),
    spread: baseSpread({ hipMin: 2.0 * DEG, hipMax: 6.0 * DEG, perShot: 0.28 * DEG, recovery: 6.5 * DEG }),
    handling: baseHandling({
      adsTime: 0.17,
      sprintOutTime: 0.1,
      drawTime: 0.35,
      holsterTime: 0.25,
      reloadTime: 1.5,
      reloadEmptyTime: 2.0,
      reloadAmmoTime: 0.95,
      reloadEmptyAmmoTime: 1.4,
      movementSpeedMultiplier: 1.08,
      adsSpeedMultiplier: 1.15,
    }),
    attachmentSlots: PISTOL_SLOTS,
    penetration: 0.3,
    vehicleDamageMultiplier: 0.7,
    muzzleVelocity: Infinity,
    bulletGravity: 0,
    adsZoom: 1.15,
    scoped: false,
    scopeFocusTime: 0,
    meleeDamage: 55,
    pellets: 1,
    burstCount: 1,
    burstDelay: 0,
    maxReserve: 120,
  },
  [WeaponClass.Launcher]: {
    recoil: baseRecoil({
      pattern: pattern([3.0, 0.5]),
      recoverySpeed: 4.0,
      cameraShake: 2.4 * DEG,
      viewKickMultiplier: 2.2,
    }),
    spread: baseSpread({ hipMin: 1.5 * DEG, hipMax: 2.5 * DEG, adsMin: 0.2 * DEG, adsMax: 0.5 * DEG }),
    handling: baseHandling({
      adsTime: 0.45,
      sprintOutTime: 0.35,
      drawTime: 0.95,
      holsterTime: 0.75,
      reloadTime: 3.6,
      reloadEmptyTime: 3.6,
      reloadAmmoTime: 2.5,
      reloadEmptyAmmoTime: 2.5,
      movementSpeedMultiplier: 0.9,
      adsSpeedMultiplier: 0.75,
    }),
    attachmentSlots: [AttachmentSlot.Optic],
    penetration: 0,
    vehicleDamageMultiplier: 4.0,
    muzzleVelocity: 55,
    bulletGravity: 3.5,
    adsZoom: 1.6,
    scoped: false,
    scopeFocusTime: 0,
    meleeDamage: 55,
    pellets: 1,
    burstCount: 1,
    burstDelay: 0,
    maxReserve: 4,
  },
  [WeaponClass.Melee]: {
    recoil: baseRecoil({ pattern: pattern([0, 0]), cameraShake: 0 }),
    spread: baseSpread({ hipMin: 0, hipMax: 0, adsMin: 0, adsMax: 0, perShot: 0 }),
    handling: baseHandling({
      adsTime: 0.2,
      sprintOutTime: 0.05,
      drawTime: 0.3,
      holsterTime: 0.2,
      reloadTime: 0,
      reloadEmptyTime: 0,
      reloadAmmoTime: 0,
      reloadEmptyAmmoTime: 0,
      movementSpeedMultiplier: 1.15,
      adsSpeedMultiplier: 1.2,
    }),
    attachmentSlots: [],
    penetration: 0,
    vehicleDamageMultiplier: 0.5,
    muzzleVelocity: Infinity,
    bulletGravity: 0,
    adsZoom: 1,
    scoped: false,
    scopeFocusTime: 0,
    meleeDamage: 150,
    pellets: 1,
    burstCount: 1,
    burstDelay: 0,
    maxReserve: 0,
  },
  [WeaponClass.Special]: {
    recoil: baseRecoil({}),
    spread: baseSpread({}),
    handling: baseHandling({}),
    attachmentSlots: [AttachmentSlot.Optic],
    penetration: 0.4,
    vehicleDamageMultiplier: 1,
    muzzleVelocity: Infinity,
    bulletGravity: 0,
    adsZoom: 1.2,
    scoped: false,
    scopeFocusTime: 0,
    meleeDamage: 55,
    pellets: 1,
    burstCount: 1,
    burstDelay: 0,
    maxReserve: 100,
  },
};

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

interface WeaponSpec {
  id: string;
  name: string;
  shortName: string;
  class: WeaponClass;
  description: string;
  fireMode?: FireMode;
  rpm: number;
  magSize: number;
  startingReserve?: number;
  damage: DamageStop[];
  unlockLevel: number;
  audio: WeaponDef['audio'];
  model: WeaponDef['model'];
  traits?: WeaponTrait[];
  pellets?: number;
  burstCount?: number;
  burstDelay?: number;
  penetration?: number;
  adsZoom?: number;
  scoped?: boolean;
  muzzleVelocity?: number;
  bulletGravity?: number;
  meleeDamage?: number;
  maxReserve?: number;
  vehicleDamageMultiplier?: number;
  recoil?: Partial<RecoilProfile>;
  spread?: Partial<SpreadProfile>;
  handling?: Partial<WeaponHandling>;
  attachmentSlots?: AttachmentSlot[];
}

function defineWeapon(spec: WeaponSpec): WeaponDef {
  const arch = ARCHETYPES[spec.class];
  return {
    id: spec.id,
    name: spec.name,
    shortName: spec.shortName,
    class: spec.class,
    description: spec.description,
    fireMode: spec.fireMode ?? FireMode.Auto,
    rpm: spec.rpm,
    burstCount: spec.burstCount ?? arch.burstCount,
    burstDelay: spec.burstDelay ?? arch.burstDelay,
    magSize: spec.magSize,
    startingReserve: spec.startingReserve ?? spec.magSize * 4,
    maxReserve: spec.maxReserve ?? arch.maxReserve,
    pellets: spec.pellets ?? arch.pellets,
    damage: spec.damage,
    vehicleDamageMultiplier: spec.vehicleDamageMultiplier ?? arch.vehicleDamageMultiplier,
    penetration: spec.penetration ?? arch.penetration,
    muzzleVelocity: spec.muzzleVelocity ?? arch.muzzleVelocity,
    bulletGravity: spec.bulletGravity ?? arch.bulletGravity,
    recoil: { ...arch.recoil, ...spec.recoil },
    spread: { ...arch.spread, ...spec.spread },
    handling: { ...arch.handling, ...spec.handling },
    attachmentSlots: spec.attachmentSlots ?? arch.attachmentSlots,
    unlockLevel: spec.unlockLevel,
    audio: spec.audio,
    model: spec.model,
    adsZoom: spec.adsZoom ?? arch.adsZoom,
    scoped: spec.scoped ?? arch.scoped,
    scopeFocusTime: arch.scopeFocusTime,
    meleeDamage: spec.meleeDamage ?? arch.meleeDamage,
    traits: spec.traits ?? [],
  };
}

/** Shorthand for a damage curve. */
function dmg(...stops: Array<[number, number]>): DamageStop[] {
  return stops.map(([distance, damage]) => ({ distance, damage }));
}

// ---------------------------------------------------------------------------
// Assault rifles
// ---------------------------------------------------------------------------

const ASSAULT_RIFLES: WeaponDef[] = [
  defineWeapon({
    id: 'vk47',
    name: 'VK-47 Lynx',
    shortName: 'VK-47',
    class: WeaponClass.AssaultRifle,
    description:
      'The baseline. Punishing damage, honest recoil, no tricks — if you can hold it steady it beats almost anything at range.',
    rpm: 600,
    magSize: 30,
    // Four to the chest almost everywhere: the reference TTK the rest of the
    // arsenal is measured against.
    damage: dmg([28, 30], [46, 26], [70, 22]),
    unlockLevel: 0,
    recoil: { pattern: climbAndDrift(0.5, 0.22), recoverySpeed: 8.4 },
    audio: { bodyFreq: 168, crackDuration: 0.035, boom: 0.62, mech: 0.5, tail: 0.85, suppressed: false },
    model: {
      length: 0.88, color: 0x39332c, accentColor: 0x6b4a2a, magStyle: 'stick',
      stockStyle: 'fixed', hasCarryHandle: false, barrelLength: 0.42, sightHeight: 0.055,
    },
  }),
  defineWeapon({
    id: 'm5a1',
    name: 'M5A1 Carbine',
    shortName: 'M5A1',
    class: WeaponClass.AssaultRifle,
    description:
      'A laser. Lowest recoil in the class, paid for with the softest damage — you will win every long trade you can actually land.',
    rpm: 720,
    magSize: 30,
    // Five shots rather than four: it wins by landing every round, not by TTK.
    damage: dmg([34, 21], [55, 19], [82, 17]),
    unlockLevel: 4,
    recoil: { pattern: climbAndDrift(0.26, 0.12), recoverySpeed: 12.5, cameraShake: 0.22 * DEG },
    spread: { adsMin: 0.08 * DEG, perShot: 0.12 * DEG },
    handling: { adsTime: 0.25 },
    audio: { bodyFreq: 205, crackDuration: 0.028, boom: 0.45, mech: 0.55, tail: 0.7, suppressed: false },
    model: {
      length: 0.84, color: 0x2f3338, accentColor: 0x4a5158, magStyle: 'stick',
      stockStyle: 'skeleton', hasCarryHandle: true, barrelLength: 0.38, sightHeight: 0.07,
    },
  }),
  defineWeapon({
    id: 'gr63',
    name: 'GR-63 Hammer',
    shortName: 'GR-63',
    class: WeaponClass.AssaultRifle,
    description:
      'Slow, heavy, and hits like a truck. Three rounds to the chest at any range you will realistically fight at.',
    rpm: 470,
    magSize: 24,
    damage: dmg([40, 40], [62, 34], [90, 29]),
    unlockLevel: 11,
    penetration: 0.75,
    recoil: { pattern: climbAndDrift(0.72, 0.3), recoverySpeed: 7.0, cameraShake: 0.55 * DEG },
    handling: { adsTime: 0.32, movementSpeedMultiplier: 0.93, reloadTime: 2.35, reloadEmptyTime: 3.0 },
    audio: { bodyFreq: 132, crackDuration: 0.045, boom: 0.82, mech: 0.42, tail: 1.05, suppressed: false },
    model: {
      length: 0.95, color: 0x35302a, accentColor: 0x1e1c1a, magStyle: 'box',
      stockStyle: 'fixed', hasCarryHandle: false, barrelLength: 0.48, sightHeight: 0.06,
    },
  }),
  defineWeapon({
    id: 'ks12',
    name: 'KS-12 Whisper',
    shortName: 'KS-12',
    class: WeaponClass.AssaultRifle,
    description:
      'Fast-cycling and light. Wins the close fights an AR has no business winning, and falls apart past the mid-lane.',
    rpm: 810,
    magSize: 32,
    // The SMG-shaped AR: fastest handling in the class, worst damage retention.
    damage: dmg([24, 20], [40, 17], [64, 14]),
    unlockLevel: 17,
    recoil: { pattern: climbAndDrift(0.4, 0.38), recoverySpeed: 11.0 },
    handling: { adsTime: 0.235, sprintOutTime: 0.15, movementSpeedMultiplier: 1.02 },
    audio: { bodyFreq: 225, crackDuration: 0.024, boom: 0.4, mech: 0.6, tail: 0.6, suppressed: false },
    model: {
      length: 0.79, color: 0x4a4640, accentColor: 0x8a7a5a, magStyle: 'stick',
      stockStyle: 'folding', hasCarryHandle: false, barrelLength: 0.34, sightHeight: 0.05,
    },
  }),
  defineWeapon({
    id: 'aug77',
    name: 'AUG-77 Bulldog',
    shortName: 'AUG-77',
    class: WeaponClass.AssaultRifle,
    description:
      'Bullpup layout: the mass sits back, so it aims fast for its weight and kicks harder than it looks.',
    rpm: 660,
    magSize: 30,
    damage: dmg([30, 31], [48, 26], [74, 21]),
    unlockLevel: 24,
    recoil: { pattern: climbAndDrift(0.56, 0.34), recoverySpeed: 8.8 },
    handling: { adsTime: 0.245, movementSpeedMultiplier: 0.99 },
    audio: { bodyFreq: 186, crackDuration: 0.032, boom: 0.55, mech: 0.62, tail: 0.78, suppressed: false },
    model: {
      length: 0.72, color: 0x5a5344, accentColor: 0x2a2724, magStyle: 'stick',
      stockStyle: 'none', hasCarryHandle: true, barrelLength: 0.4, sightHeight: 0.075,
    },
  }),
  defineWeapon({
    id: 'fr55',
    name: 'FR-55 Triad',
    shortName: 'FR-55',
    class: WeaponClass.AssaultRifle,
    description:
      'Three-round burst. Land the whole burst and it is the fastest kill in the class; miss one and you wait.',
    fireMode: FireMode.Burst,
    rpm: 900,
    burstCount: 3,
    burstDelay: 0.24,
    magSize: 30,
    damage: dmg([34, 30], [55, 26], [82, 22]),
    unlockLevel: 31,
    recoil: { pattern: pattern([0.5, 0.1], [0.62, -0.16], [0.7, 0.22]), recoverySpeed: 10.5 },
    handling: { adsTime: 0.28 },
    audio: { bodyFreq: 196, crackDuration: 0.03, boom: 0.5, mech: 0.5, tail: 0.72, suppressed: false },
    model: {
      length: 0.86, color: 0x33383d, accentColor: 0x5a6068, magStyle: 'stick',
      stockStyle: 'fixed', hasCarryHandle: false, barrelLength: 0.41, sightHeight: 0.06,
    },
  }),
  defineWeapon({
    id: 'sa58',
    name: 'SA-58 Vantage',
    shortName: 'SA-58',
    class: WeaponClass.AssaultRifle,
    description:
      'A battle rifle in an AR slot. Semi-automatic, brutal per-shot damage, and it goes through most of what it hits.',
    fireMode: FireMode.Semi,
    rpm: 400,
    magSize: 20,
    // Three shots at every range it will ever be fired at — two if you hit a head.
    damage: dmg([50, 48], [78, 42], [110, 36]),
    unlockLevel: 42,
    penetration: 0.95,
    adsZoom: 1.45,
    recoil: { pattern: pattern([1.15, 0.2], [1.3, -0.3], [1.25, 0.35], [1.4, -0.22]), recoverySpeed: 7.8, cameraShake: 0.8 * DEG },
    handling: { adsTime: 0.34, movementSpeedMultiplier: 0.92, reloadTime: 2.4, reloadEmptyTime: 3.1 },
    audio: { bodyFreq: 118, crackDuration: 0.05, boom: 0.9, mech: 0.4, tail: 1.15, suppressed: false },
    model: {
      length: 1.0, color: 0x2b2822, accentColor: 0x6a5334, magStyle: 'box',
      stockStyle: 'fixed', hasCarryHandle: false, barrelLength: 0.53, sightHeight: 0.058,
    },
  }),
];

// ---------------------------------------------------------------------------
// Submachine guns
// ---------------------------------------------------------------------------

const SMGS: WeaponDef[] = [
  defineWeapon({
    id: 'mp9k',
    name: 'MP9-K',
    shortName: 'MP9-K',
    class: WeaponClass.SubmachineGun,
    description:
      'The all-rounder. Enough range to fight in a doorway, enough speed to win the room behind it.',
    rpm: 850,
    magSize: 32,
    damage: dmg([14, 30], [24, 23], [38, 17]),
    unlockLevel: 0,
    audio: { bodyFreq: 232, crackDuration: 0.022, boom: 0.35, mech: 0.65, tail: 0.5, suppressed: false },
    model: {
      length: 0.6, color: 0x2e2e30, accentColor: 0x505055, magStyle: 'stick',
      stockStyle: 'folding', hasCarryHandle: false, barrelLength: 0.22, sightHeight: 0.048,
    },
  }),
  defineWeapon({
    id: 'vector9',
    name: 'Vector-9',
    shortName: 'VEC-9',
    class: WeaponClass.SubmachineGun,
    description:
      'Absurd rate of fire. Deletes anything inside ten metres and runs dry doing it.',
    rpm: 1200,
    magSize: 30,
    startingReserve: 150,
    // Five hits, but they arrive in 200 ms. Past twenty metres it is a water pistol.
    damage: dmg([11, 20], [18, 14], [30, 10]),
    unlockLevel: 7,
    recoil: { pattern: climbAndDrift(0.3, 0.44), recoverySpeed: 13.0 },
    spread: { hipMin: 1.9 * DEG, perShot: 0.24 * DEG },
    handling: { adsTime: 0.2, reloadTime: 1.85, reloadEmptyTime: 2.4 },
    audio: { bodyFreq: 268, crackDuration: 0.018, boom: 0.28, mech: 0.72, tail: 0.42, suppressed: false },
    model: {
      length: 0.55, color: 0x25272b, accentColor: 0x3f434a, magStyle: 'stick',
      stockStyle: 'folding', hasCarryHandle: false, barrelLength: 0.18, sightHeight: 0.052,
    },
  }),
  defineWeapon({
    id: 'pk10',
    name: 'PK-10 Marauder',
    shortName: 'PK-10',
    class: WeaponClass.SubmachineGun,
    description:
      'An SMG that thinks it is a rifle. Slower, heavier, and it still hits at thirty metres.',
    rpm: 700,
    magSize: 36,
    damage: dmg([20, 30], [34, 24], [52, 18]),
    unlockLevel: 14,
    penetration: 0.45,
    recoil: { pattern: climbAndDrift(0.34, 0.22), recoverySpeed: 10.0 },
    handling: { adsTime: 0.235, movementSpeedMultiplier: 1.0 },
    audio: { bodyFreq: 198, crackDuration: 0.026, boom: 0.45, mech: 0.58, tail: 0.62, suppressed: false },
    model: {
      length: 0.68, color: 0x3a352e, accentColor: 0x6b5a3a, magStyle: 'stick',
      stockStyle: 'skeleton', hasCarryHandle: false, barrelLength: 0.28, sightHeight: 0.05,
    },
  }),
  defineWeapon({
    id: 'skorp',
    name: 'Skorpion VZ',
    shortName: 'SKORP',
    class: WeaponClass.SubmachineGun,
    description:
      'Tiny, twitchy, and faster to raise than anything else in the game. Point-blank specialist.',
    rpm: 1000,
    magSize: 25,
    damage: dmg([10, 27], [17, 18], [28, 13]),
    unlockLevel: 21,
    recoil: { pattern: climbAndDrift(0.42, 0.56), recoverySpeed: 14.0 },
    spread: { hipMin: 1.4 * DEG, hipMax: 5.0 * DEG },
    handling: {
      adsTime: 0.165, sprintOutTime: 0.1, drawTime: 0.36, holsterTime: 0.26,
      movementSpeedMultiplier: 1.09, adsSpeedMultiplier: 1.14,
    },
    audio: { bodyFreq: 288, crackDuration: 0.016, boom: 0.24, mech: 0.78, tail: 0.36, suppressed: false },
    model: {
      length: 0.45, color: 0x2a2a2c, accentColor: 0x46464a, magStyle: 'stick',
      stockStyle: 'none', hasCarryHandle: false, barrelLength: 0.14, sightHeight: 0.042,
    },
  }),
  defineWeapon({
    id: 'thompson',
    name: 'TS-45 Chicago',
    shortName: 'TS-45',
    class: WeaponClass.SubmachineGun,
    description:
      'A heavy old design chambered in something enormous. Slow for the class, but two hits close in.',
    rpm: 620,
    magSize: 30,
    damage: dmg([16, 42], [26, 30], [40, 21]),
    unlockLevel: 28,
    recoil: { pattern: climbAndDrift(0.52, 0.3), recoverySpeed: 9.0, cameraShake: 0.42 * DEG },
    handling: { adsTime: 0.25, movementSpeedMultiplier: 0.98, reloadTime: 2.1, reloadEmptyTime: 2.8 },
    audio: { bodyFreq: 152, crackDuration: 0.034, boom: 0.62, mech: 0.5, tail: 0.7, suppressed: false },
    model: {
      length: 0.72, color: 0x5a4028, accentColor: 0x2e2a26, magStyle: 'drum',
      stockStyle: 'fixed', hasCarryHandle: false, barrelLength: 0.3, sightHeight: 0.05,
    },
  }),
  defineWeapon({
    id: 'p90x',
    name: 'P90-X Swarm',
    shortName: 'P90-X',
    class: WeaponClass.SubmachineGun,
    description:
      'Fifty rounds top-loaded. You will not need to reload in the middle of a fight, ever.',
    rpm: 900,
    magSize: 50,
    startingReserve: 200,
    damage: dmg([13, 25], [22, 19], [34, 14]),
    unlockLevel: 35,
    recoil: { pattern: climbAndDrift(0.28, 0.3), recoverySpeed: 12.0 },
    handling: { adsTime: 0.225, reloadTime: 2.4, reloadEmptyTime: 3.0 },
    audio: { bodyFreq: 246, crackDuration: 0.02, boom: 0.32, mech: 0.68, tail: 0.46, suppressed: false },
    model: {
      length: 0.5, color: 0x232528, accentColor: 0x3a3d42, magStyle: 'box',
      stockStyle: 'none', hasCarryHandle: true, barrelLength: 0.16, sightHeight: 0.068,
    },
  }),
];

// ---------------------------------------------------------------------------
// Light machine guns
// ---------------------------------------------------------------------------

const LMGS: WeaponDef[] = [
  defineWeapon({
    id: 'm60e',
    name: 'M60-E Anvil',
    shortName: 'M60-E',
    class: WeaponClass.LightMachineGun,
    description:
      'A hundred rounds of suppression. Slow to bring up, but nothing wins a sustained trade against it.',
    rpm: 540,
    magSize: 100,
    startingReserve: 200,
    damage: dmg([36, 36], [58, 30], [88, 25]),
    unlockLevel: 5,
    audio: { bodyFreq: 142, crackDuration: 0.042, boom: 0.78, mech: 0.45, tail: 1.0, suppressed: false },
    model: {
      length: 1.05, color: 0x33352f, accentColor: 0x1c1e1a, magStyle: 'box',
      stockStyle: 'fixed', hasCarryHandle: true, barrelLength: 0.55, sightHeight: 0.062,
    },
  }),
  defineWeapon({
    id: 'rpd74',
    name: 'RPD-74 Bastion',
    shortName: 'RPD-74',
    class: WeaponClass.LightMachineGun,
    description:
      'Drum-fed and surprisingly quick to aim for its size. The LMG you can actually push with.',
    rpm: 640,
    magSize: 75,
    damage: dmg([32, 32], [52, 27], [80, 22]),
    unlockLevel: 19,
    handling: { adsTime: 0.36, movementSpeedMultiplier: 0.9, reloadTime: 3.9, reloadEmptyTime: 4.8 },
    recoil: { pattern: climbAndDrift(0.44, 0.26, 14), recoverySpeed: 8.0 },
    audio: { bodyFreq: 158, crackDuration: 0.038, boom: 0.7, mech: 0.48, tail: 0.92, suppressed: false },
    model: {
      length: 1.0, color: 0x3d372c, accentColor: 0x6b5230, magStyle: 'drum',
      stockStyle: 'fixed', hasCarryHandle: false, barrelLength: 0.5, sightHeight: 0.056,
    },
  }),
  defineWeapon({
    id: 'mg42x',
    name: 'MG-42X Sawblade',
    shortName: 'MG-42X',
    class: WeaponClass.LightMachineGun,
    description:
      'Twelve hundred rounds a minute. Utterly uncontrollable standing up, devastating from a bipod.',
    rpm: 1150,
    magSize: 125,
    startingReserve: 250,
    damage: dmg([28, 27], [46, 22], [72, 18]),
    unlockLevel: 33,
    recoil: { pattern: climbAndDrift(0.62, 0.5, 16), recoverySpeed: 6.5, cameraShake: 0.7 * DEG },
    spread: { hipMin: 4.6 * DEG, hipMax: 9.5 * DEG, proneMultiplier: 0.45, crouchMultiplier: 0.7 },
    handling: { adsTime: 0.5, movementSpeedMultiplier: 0.8, reloadTime: 5.2, reloadEmptyTime: 6.2 },
    audio: { bodyFreq: 176, crackDuration: 0.02, boom: 0.66, mech: 0.72, tail: 0.88, suppressed: false },
    model: {
      length: 1.12, color: 0x2c2e30, accentColor: 0x4c4e52, magStyle: 'box',
      stockStyle: 'fixed', hasCarryHandle: true, barrelLength: 0.62, sightHeight: 0.07,
    },
  }),
  defineWeapon({
    id: 'lw90',
    name: 'LW-90 Breaker',
    shortName: 'LW-90',
    class: WeaponClass.LightMachineGun,
    description:
      'Belt-fed armour-piercing. Punches through cover most weapons cannot even scratch.',
    rpm: 480,
    magSize: 60,
    damage: dmg([44, 42], [70, 35], [100, 30]),
    unlockLevel: 47,
    penetration: 1.0,
    vehicleDamageMultiplier: 1.6,
    recoil: { pattern: climbAndDrift(0.66, 0.24, 12), recoverySpeed: 6.8, cameraShake: 0.85 * DEG },
    handling: { adsTime: 0.46, movementSpeedMultiplier: 0.84 },
    audio: { bodyFreq: 112, crackDuration: 0.05, boom: 0.92, mech: 0.4, tail: 1.2, suppressed: false },
    model: {
      length: 1.15, color: 0x30322c, accentColor: 0x15170f, magStyle: 'box',
      stockStyle: 'fixed', hasCarryHandle: true, barrelLength: 0.66, sightHeight: 0.064,
    },
  }),
];

// ---------------------------------------------------------------------------
// Sniper rifles
// ---------------------------------------------------------------------------

const SNIPERS: WeaponDef[] = [
  defineWeapon({
    id: 'r700t',
    name: 'R700-T Verdict',
    shortName: 'R700-T',
    class: WeaponClass.SniperRifle,
    description:
      'Bolt-action. One shot anywhere above the waist, at any range you can see. The price is everything else.',
    fireMode: FireMode.BoltAction,
    rpm: 48,
    magSize: 5,
    startingReserve: 25,
    damage: dmg([100, 150], [200, 130], [300, 110]),
    unlockLevel: 0,
    traits: [WeaponTrait.OneShotUpperTorso, WeaponTrait.Rechamber, WeaponTrait.NoAkimbo],
    handling: { adsTime: 0.6 },
    audio: { bodyFreq: 96, crackDuration: 0.06, boom: 1.0, mech: 0.5, tail: 1.6, suppressed: false },
    model: {
      length: 1.2, color: 0x2a2a26, accentColor: 0x4a3a24, magStyle: 'none',
      stockStyle: 'fixed', hasCarryHandle: false, barrelLength: 0.68, sightHeight: 0.09,
    },
  }),
  defineWeapon({
    id: 'dsr50',
    name: 'DSR-50 Anvil',
    shortName: 'DSR-50',
    class: WeaponClass.SniperRifle,
    description:
      'Anti-materiel. Goes through walls, vehicles and whoever is standing behind them.',
    fireMode: FireMode.BoltAction,
    rpm: 40,
    magSize: 4,
    startingReserve: 16,
    damage: dmg([150, 175], [300, 160]),
    unlockLevel: 26,
    penetration: 1.0,
    vehicleDamageMultiplier: 2.2,
    adsZoom: 5.2,
    traits: [WeaponTrait.OneShotUpperTorso, WeaponTrait.Rechamber, WeaponTrait.NoAkimbo, WeaponTrait.NoFalloff],
    handling: { adsTime: 0.72, movementSpeedMultiplier: 0.82, reloadTime: 3.8, reloadEmptyTime: 4.6 },
    recoil: { pattern: pattern([3.4, 0.6], [3.6, -0.7]), cameraShake: 2.4 * DEG, viewKickMultiplier: 2.4 },
    audio: { bodyFreq: 72, crackDuration: 0.075, boom: 1.0, mech: 0.45, tail: 2.0, suppressed: false },
    model: {
      length: 1.35, color: 0x24262a, accentColor: 0x40444a, magStyle: 'box',
      stockStyle: 'skeleton', hasCarryHandle: false, barrelLength: 0.82, sightHeight: 0.1,
    },
  }),
  defineWeapon({
    id: 'svk12',
    name: 'SVK-12 Reaper',
    shortName: 'SVK-12',
    class: WeaponClass.SniperRifle,
    description:
      'Semi-automatic. Will not one-shot the body, but it will not make you wait for a second try either.',
    fireMode: FireMode.Semi,
    rpm: 200,
    magSize: 10,
    startingReserve: 40,
    damage: dmg([90, 78], [160, 68], [250, 58]),
    unlockLevel: 38,
    adsZoom: 3.6,
    handling: { adsTime: 0.52, movementSpeedMultiplier: 0.9 },
    recoil: { pattern: pattern([1.7, 0.3], [1.9, -0.4], [1.8, 0.45]), recoverySpeed: 6.5 },
    audio: { bodyFreq: 108, crackDuration: 0.05, boom: 0.88, mech: 0.55, tail: 1.4, suppressed: false },
    model: {
      length: 1.15, color: 0x3a352c, accentColor: 0x5e4a2c, magStyle: 'box',
      stockStyle: 'fixed', hasCarryHandle: false, barrelLength: 0.62, sightHeight: 0.085,
    },
  }),
  defineWeapon({
    id: 'sp96',
    name: 'SP-96 Kestrel',
    shortName: 'SP-96',
    class: WeaponClass.SniperRifle,
    description:
      'Stripped to the frame for speed. Aims almost as fast as a marksman rifle and still one-shots the chest up close.',
    fireMode: FireMode.BoltAction,
    rpm: 55,
    magSize: 5,
    startingReserve: 25,
    damage: dmg([65, 150], [120, 95], [220, 80]),
    unlockLevel: 51,
    adsZoom: 3.4,
    traits: [WeaponTrait.OneShotUpperTorso, WeaponTrait.Rechamber],
    handling: {
      adsTime: 0.5, sprintOutTime: 0.3, movementSpeedMultiplier: 0.95,
      adsSpeedMultiplier: 0.75, swayAmount: 3.4 * DEG,
    },
    audio: { bodyFreq: 118, crackDuration: 0.052, boom: 0.85, mech: 0.6, tail: 1.35, suppressed: false },
    model: {
      length: 1.05, color: 0x2e3034, accentColor: 0x565a60, magStyle: 'none',
      stockStyle: 'skeleton', hasCarryHandle: false, barrelLength: 0.55, sightHeight: 0.088,
    },
  }),
];

// ---------------------------------------------------------------------------
// Marksman rifles
// ---------------------------------------------------------------------------

const MARKSMAN: WeaponDef[] = [
  defineWeapon({
    id: 'dmr14',
    name: 'DMR-14 Sentinel',
    shortName: 'DMR-14',
    class: WeaponClass.MarksmanRifle,
    description:
      'Two shots to the chest inside forty metres. Fast enough to double-tap, slow enough to punish a miss.',
    fireMode: FireMode.Semi,
    rpm: 300,
    magSize: 15,
    damage: dmg([45, 55], [72, 46], [105, 38]),
    unlockLevel: 9,
    audio: { bodyFreq: 128, crackDuration: 0.045, boom: 0.8, mech: 0.5, tail: 1.1, suppressed: false },
    model: {
      length: 1.02, color: 0x35322a, accentColor: 0x5a4626, magStyle: 'box',
      stockStyle: 'fixed', hasCarryHandle: false, barrelLength: 0.54, sightHeight: 0.072,
    },
  }),
  defineWeapon({
    id: 'mk18',
    name: 'MK-18 Longbow',
    shortName: 'MK-18',
    class: WeaponClass.MarksmanRifle,
    description:
      'A headshot ends it in one. Everything else takes three, so pick your angles.',
    fireMode: FireMode.Semi,
    rpm: 260,
    magSize: 12,
    damage: dmg([60, 62], [95, 52], [140, 44]),
    unlockLevel: 29,
    penetration: 0.9,
    adsZoom: 2.9,
    handling: { adsTime: 0.4 },
    recoil: { pattern: pattern([1.3, 0.22], [1.45, -0.3], [1.4, 0.36]) },
    audio: { bodyFreq: 112, crackDuration: 0.05, boom: 0.86, mech: 0.48, tail: 1.25, suppressed: false },
    model: {
      length: 1.1, color: 0x2c2e2a, accentColor: 0x4a4c46, magStyle: 'box',
      stockStyle: 'skeleton', hasCarryHandle: false, barrelLength: 0.6, sightHeight: 0.078,
    },
  }),
  defineWeapon({
    id: 'ebr7',
    name: 'EBR-7 Tempest',
    shortName: 'EBR-7',
    class: WeaponClass.MarksmanRifle,
    description:
      'Fires as fast as you can pull. Rewards a steady hand more than any other gun here.',
    fireMode: FireMode.Semi,
    rpm: 400,
    magSize: 20,
    damage: dmg([38, 44], [62, 37], [92, 31]),
    unlockLevel: 44,
    handling: { adsTime: 0.33, movementSpeedMultiplier: 0.95 },
    recoil: { pattern: climbAndDrift(0.85, 0.34, 10), recoverySpeed: 8.5 },
    audio: { bodyFreq: 142, crackDuration: 0.04, boom: 0.72, mech: 0.55, tail: 0.98, suppressed: false },
    model: {
      length: 0.98, color: 0x30302e, accentColor: 0x585850, magStyle: 'box',
      stockStyle: 'fixed', hasCarryHandle: false, barrelLength: 0.5, sightHeight: 0.07,
    },
  }),
];

// ---------------------------------------------------------------------------
// Shotguns
// ---------------------------------------------------------------------------

const SHOTGUNS: WeaponDef[] = [
  defineWeapon({
    id: 'm870',
    name: 'M870 Breach',
    shortName: 'M870',
    class: WeaponClass.Shotgun,
    description:
      'Pump-action. One shell, one body, provided you are close enough to smell them.',
    fireMode: FireMode.BoltAction,
    rpm: 75,
    magSize: 6,
    startingReserve: 30,
    pellets: 9,
    damage: dmg([5, 22], [9, 12], [15, 4], [22, 1.5]),
    unlockLevel: 0,
    traits: [WeaponTrait.ShellReload, WeaponTrait.Rechamber],
    audio: { bodyFreq: 88, crackDuration: 0.055, boom: 0.95, mech: 0.8, tail: 1.1, suppressed: false },
    model: {
      length: 0.95, color: 0x2a2622, accentColor: 0x6a4a28, magStyle: 'tube',
      stockStyle: 'fixed', hasCarryHandle: false, barrelLength: 0.52, sightHeight: 0.04,
    },
  }),
  defineWeapon({
    id: 'sx12',
    name: 'SX-12 Vector',
    shortName: 'SX-12',
    class: WeaponClass.Shotgun,
    description:
      'Semi-automatic. Trades the one-shot for the ability to correct your mistake immediately.',
    fireMode: FireMode.Semi,
    rpm: 260,
    magSize: 8,
    startingReserve: 32,
    pellets: 8,
    damage: dmg([5, 15], [9, 9], [15, 3.5], [22, 1.2]),
    unlockLevel: 16,
    traits: [WeaponTrait.ShellReload],
    handling: { adsTime: 0.26, reloadTime: 0.58, reloadAmmoTime: 0.36 },
    audio: { bodyFreq: 98, crackDuration: 0.048, boom: 0.86, mech: 0.7, tail: 0.95, suppressed: false },
    model: {
      length: 0.88, color: 0x26282c, accentColor: 0x44484e, magStyle: 'tube',
      stockStyle: 'folding', hasCarryHandle: false, barrelLength: 0.44, sightHeight: 0.045,
    },
  }),
  defineWeapon({
    id: 'aa9',
    name: 'AA-9 Streetsweeper',
    shortName: 'AA-9',
    class: WeaponClass.Shotgun,
    description:
      'Fully automatic, drum-fed. Clears a room in one trigger pull and cannot reach past the door.',
    rpm: 300,
    magSize: 12,
    startingReserve: 36,
    pellets: 7,
    damage: dmg([4, 15], [7.5, 9], [13, 3.2], [20, 1.1]),
    unlockLevel: 40,
    handling: {
      adsTime: 0.3, reloadTime: 3.6, reloadEmptyTime: 4.2,
      reloadAmmoTime: 2.6, reloadEmptyAmmoTime: 3.1, movementSpeedMultiplier: 0.92,
    },
    recoil: { pattern: climbAndDrift(1.4, 0.6, 10), recoverySpeed: 5.5, cameraShake: 1.3 * DEG },
    audio: { bodyFreq: 104, crackDuration: 0.042, boom: 0.8, mech: 0.75, tail: 0.88, suppressed: false },
    model: {
      length: 0.82, color: 0x2c2c2e, accentColor: 0x4e4e52, magStyle: 'drum',
      stockStyle: 'folding', hasCarryHandle: false, barrelLength: 0.36, sightHeight: 0.048,
    },
  }),
];

// ---------------------------------------------------------------------------
// Pistols
// ---------------------------------------------------------------------------

const PISTOLS: WeaponDef[] = [
  defineWeapon({
    id: 'p226',
    name: 'P226 Sidearm',
    shortName: 'P226',
    class: WeaponClass.Pistol,
    description: 'Standard issue. Fast to draw, honest damage, nothing to think about.',
    fireMode: FireMode.Semi,
    rpm: 420,
    magSize: 15,
    damage: dmg([16, 34], [28, 26], [45, 20]),
    unlockLevel: 0,
    audio: { bodyFreq: 212, crackDuration: 0.026, boom: 0.42, mech: 0.6, tail: 0.55, suppressed: false },
    model: {
      length: 0.22, color: 0x2a2c30, accentColor: 0x4a4e54, magStyle: 'stick',
      stockStyle: 'none', hasCarryHandle: false, barrelLength: 0.11, sightHeight: 0.028,
    },
  }),
  defineWeapon({
    id: 'gs17',
    name: 'GS-17 Deadbolt',
    shortName: 'GS-17',
    class: WeaponClass.Pistol,
    description: 'A hand cannon. Two rounds anywhere, one to the head, and a wrist you will feel it in.',
    fireMode: FireMode.Semi,
    rpm: 220,
    magSize: 7,
    damage: dmg([18, 62], [32, 50], [50, 40]),
    unlockLevel: 22,
    penetration: 0.6,
    recoil: { pattern: pattern([2.0, 0.4], [2.2, -0.5], [2.1, 0.55]), recoverySpeed: 8.0, cameraShake: 0.9 * DEG },
    handling: { adsTime: 0.22, reloadTime: 1.8, reloadEmptyTime: 2.3 },
    audio: { bodyFreq: 126, crackDuration: 0.045, boom: 0.85, mech: 0.5, tail: 1.0, suppressed: false },
    model: {
      length: 0.28, color: 0x3a3226, accentColor: 0x8a6a3a, magStyle: 'stick',
      stockStyle: 'none', hasCarryHandle: false, barrelLength: 0.15, sightHeight: 0.03,
    },
  }),
  defineWeapon({
    id: 'mp5c',
    name: 'MP-5C Hornet',
    shortName: 'MP-5C',
    class: WeaponClass.Pistol,
    description: 'A machine pistol in a sidearm slot. Empties in a heartbeat and often that is enough.',
    rpm: 1100,
    magSize: 20,
    startingReserve: 100,
    damage: dmg([9, 22], [16, 15], [26, 11]),
    unlockLevel: 34,
    recoil: { pattern: climbAndDrift(0.6, 0.7, 8), recoverySpeed: 13.5 },
    spread: { hipMin: 2.6 * DEG, hipMax: 7.5 * DEG },
    handling: { adsTime: 0.19, reloadTime: 1.6, reloadEmptyTime: 2.1 },
    audio: { bodyFreq: 262, crackDuration: 0.017, boom: 0.26, mech: 0.75, tail: 0.4, suppressed: false },
    model: {
      length: 0.34, color: 0x26282a, accentColor: 0x3e4246, magStyle: 'stick',
      stockStyle: 'none', hasCarryHandle: false, barrelLength: 0.13, sightHeight: 0.032,
    },
  }),
  defineWeapon({
    id: 'r45',
    name: 'R45 Ranger',
    shortName: 'R45',
    class: WeaponClass.Pistol,
    description: 'A revolver. Six shots, no reload you will survive, and a hell of a lot of stopping power.',
    fireMode: FireMode.Semi,
    rpm: 180,
    magSize: 6,
    startingReserve: 24,
    damage: dmg([25, 70], [42, 56], [65, 45]),
    unlockLevel: 49,
    penetration: 0.7,
    adsZoom: 1.35,
    recoil: { pattern: pattern([2.6, 0.5], [2.8, -0.6]), recoverySpeed: 7.0, cameraShake: 1.2 * DEG },
    handling: { adsTime: 0.26, reloadTime: 2.6, reloadEmptyTime: 2.6, reloadAmmoTime: 1.9, reloadEmptyAmmoTime: 1.9 },
    audio: { bodyFreq: 108, crackDuration: 0.05, boom: 0.92, mech: 0.55, tail: 1.2, suppressed: false },
    model: {
      length: 0.3, color: 0x3c3c40, accentColor: 0x5a4026, magStyle: 'none',
      stockStyle: 'none', hasCarryHandle: false, barrelLength: 0.17, sightHeight: 0.03,
    },
  }),
];

// ---------------------------------------------------------------------------
// Launchers
// ---------------------------------------------------------------------------

const LAUNCHERS: WeaponDef[] = [
  defineWeapon({
    id: 'rpg9',
    name: 'RPG-9',
    shortName: 'RPG-9',
    class: WeaponClass.Launcher,
    description: 'Dumbfire rocket. No lock, no guidance, no second chances.',
    fireMode: FireMode.Semi,
    rpm: 30,
    magSize: 1,
    startingReserve: 2,
    damage: dmg([6, 160], [10, 90], [14, 40]),
    unlockLevel: 12,
    traits: [WeaponTrait.Explosive],
    muzzleVelocity: 48,
    bulletGravity: 2.5,
    audio: { bodyFreq: 64, crackDuration: 0.09, boom: 1.0, mech: 0.3, tail: 2.2, suppressed: false },
    model: {
      length: 1.15, color: 0x3a4030, accentColor: 0x6a3020, magStyle: 'none',
      stockStyle: 'none', hasCarryHandle: true, barrelLength: 0.9, sightHeight: 0.09,
    },
  }),
  defineWeapon({
    id: 'stinger',
    name: 'FIM-9 Talon',
    shortName: 'FIM-9',
    class: WeaponClass.Launcher,
    description: 'Locks on to anything airborne. Useless against infantry, decisive against a chopper.',
    fireMode: FireMode.Semi,
    rpm: 24,
    magSize: 1,
    startingReserve: 3,
    damage: dmg([4, 60], [8, 30]),
    unlockLevel: 30,
    traits: [WeaponTrait.Explosive, WeaponTrait.AirLockOn],
    vehicleDamageMultiplier: 8.0,
    muzzleVelocity: 90,
    bulletGravity: 0,
    audio: { bodyFreq: 78, crackDuration: 0.08, boom: 0.9, mech: 0.35, tail: 1.9, suppressed: false },
    model: {
      length: 1.3, color: 0x2e3236, accentColor: 0x8a8a30, magStyle: 'none',
      stockStyle: 'none', hasCarryHandle: true, barrelLength: 1.0, sightHeight: 0.1,
    },
  }),
  defineWeapon({
    id: 'gl40',
    name: 'GL-40 Thumper',
    shortName: 'GL-40',
    class: WeaponClass.Launcher,
    description: 'Break-action grenade launcher. Arcs over cover and ruins whatever is behind it.',
    fireMode: FireMode.Semi,
    rpm: 45,
    magSize: 1,
    startingReserve: 4,
    damage: dmg([4, 130], [7, 75], [11, 35]),
    unlockLevel: 45,
    traits: [WeaponTrait.Explosive],
    muzzleVelocity: 32,
    bulletGravity: 9.5,
    handling: { reloadTime: 2.6, reloadAmmoTime: 1.8, adsTime: 0.38 },
    audio: { bodyFreq: 92, crackDuration: 0.06, boom: 0.75, mech: 0.7, tail: 1.0, suppressed: false },
    model: {
      length: 0.7, color: 0x353a2e, accentColor: 0x1e2018, magStyle: 'none',
      stockStyle: 'folding', hasCarryHandle: false, barrelLength: 0.34, sightHeight: 0.07,
    },
  }),
];

// ---------------------------------------------------------------------------
// Melee
// ---------------------------------------------------------------------------

const MELEE: WeaponDef[] = [
  defineWeapon({
    id: 'combat_knife',
    name: 'Combat Knife',
    shortName: 'KNIFE',
    class: WeaponClass.Melee,
    description: 'One hit. Move faster than anyone carrying a gun and get close enough to use it.',
    fireMode: FireMode.Swing,
    rpm: 110,
    magSize: 1,
    startingReserve: 0,
    damage: dmg([2.4, 150]),
    unlockLevel: 0,
    meleeDamage: 150,
    audio: { bodyFreq: 320, crackDuration: 0.02, boom: 0.05, mech: 0.9, tail: 0.15, suppressed: true },
    model: {
      length: 0.26, color: 0x9aa0a6, accentColor: 0x24262a, magStyle: 'none',
      stockStyle: 'none', hasCarryHandle: false, barrelLength: 0.18, sightHeight: 0,
    },
    traits: [WeaponTrait.AlwaysSuppressed],
  }),
  defineWeapon({
    id: 'riot_shield',
    name: 'Riot Shield',
    shortName: 'SHIELD',
    class: WeaponClass.Melee,
    description: 'Absorbs everything from the front. You give up your gun and most of your speed for it.',
    fireMode: FireMode.Swing,
    rpm: 70,
    magSize: 1,
    startingReserve: 0,
    damage: dmg([2.2, 100]),
    unlockLevel: 20,
    meleeDamage: 100,
    handling: {
      movementSpeedMultiplier: 0.78, adsSpeedMultiplier: 0.7,
      drawTime: 0.7, holsterTime: 0.55, sprintOutTime: 0.25,
    },
    audio: { bodyFreq: 140, crackDuration: 0.03, boom: 0.4, mech: 0.8, tail: 0.3, suppressed: true },
    model: {
      length: 0.9, color: 0x3a4048, accentColor: 0x7a8288, magStyle: 'none',
      stockStyle: 'none', hasCarryHandle: true, barrelLength: 0.05, sightHeight: 0,
    },
    traits: [WeaponTrait.AlwaysSuppressed, WeaponTrait.NoAkimbo],
  }),
];

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const ALL: WeaponDef[] = [
  ...ASSAULT_RIFLES,
  ...SMGS,
  ...LMGS,
  ...SNIPERS,
  ...MARKSMAN,
  ...SHOTGUNS,
  ...PISTOLS,
  ...LAUNCHERS,
  ...MELEE,
];

export const WEAPONS: Record<string, WeaponDef> = Object.fromEntries(
  ALL.map((w) => [w.id, w]),
);

export const WEAPONS_BY_CLASS: Record<WeaponClass, WeaponDef[]> = {
  [WeaponClass.AssaultRifle]: ASSAULT_RIFLES,
  [WeaponClass.SubmachineGun]: SMGS,
  [WeaponClass.LightMachineGun]: LMGS,
  [WeaponClass.SniperRifle]: SNIPERS,
  [WeaponClass.MarksmanRifle]: MARKSMAN,
  [WeaponClass.Shotgun]: SHOTGUNS,
  [WeaponClass.Pistol]: PISTOLS,
  [WeaponClass.Launcher]: LAUNCHERS,
  [WeaponClass.Melee]: MELEE,
  [WeaponClass.Special]: [],
};

export const WEAPON_IDS: string[] = ALL.map((w) => w.id);

export const DEFAULT_PRIMARY = 'vk47';
export const DEFAULT_SECONDARY = 'p226';

export function getWeapon(id: string): WeaponDef {
  const w = WEAPONS[id];
  if (!w) throw new Error(`Unknown weapon id: ${id}`);
  return w;
}

export function tryGetWeapon(id: string): WeaponDef | undefined {
  return WEAPONS[id];
}

/** Weapons available at a given rank, for the create-a-class UI. */
export function weaponsUnlockedAt(level: number): WeaponDef[] {
  return ALL.filter((w) => w.unlockLevel <= level);
}

// ---------------------------------------------------------------------------
// Balance validation
//
// Called by the test suite. Returning strings rather than throwing means one run
// reports every problem at once instead of the first.
// ---------------------------------------------------------------------------

export function validateArsenal(): string[] {
  const errors: string[] = [];
  const H = HEALTH.max;

  for (const w of ALL) {
    const tag = `${w.id}`;

    if (w.magSize <= 0) errors.push(`${tag}: magSize must be > 0`);
    if (w.damage.length < 1) errors.push(`${tag}: needs at least one damage stop`);
    if (w.recoil.pattern.length === 0) errors.push(`${tag}: empty recoil pattern`);
    if (w.rpm <= 0) errors.push(`${tag}: rpm must be > 0`);

    // Damage must never increase with distance.
    for (let i = 1; i < w.damage.length; i++) {
      const prev = w.damage[i - 1]!;
      const cur = w.damage[i]!;
      if (cur.distance <= prev.distance) {
        errors.push(`${tag}: damage stop ${i} distance must increase`);
      }
      if (cur.damage > prev.damage + 1e-6) {
        errors.push(`${tag}: damage increases with range at stop ${i}`);
      }
    }

    if (new Set(w.attachmentSlots).size !== w.attachmentSlots.length) {
      errors.push(`${tag}: duplicate attachment slots`);
    }

    // Universal floor: nothing may body-shot faster than 150 ms.
    if (w.class !== WeaponClass.Melee && w.class !== WeaponClass.Launcher) {
      for (const d of [3, 8, 15, 25, 40, 60]) {
        const ttk = timeToKill(w, d, H, 1);
        if (Number.isFinite(ttk) && ttk > 0 && ttk < 0.15) {
          errors.push(`${tag}: body TTK ${(ttk * 1000) | 0}ms at ${d}m is below the 150ms floor`);
        }
      }
    }

    switch (w.class) {
      case WeaponClass.AssaultRifle: {
        const ttk = timeToKill(w, 20, H, 1);
        if (!(ttk >= 0.25 && ttk <= 0.42)) {
          errors.push(`${tag}: AR TTK at 20m is ${(ttk * 1000) | 0}ms, want 250-420ms`);
        }
        break;
      }
      case WeaponClass.SubmachineGun: {
        const close = timeToKill(w, 10, H, 1);
        if (!(close >= 0.18 && close <= 0.32)) {
          errors.push(`${tag}: SMG TTK at 10m is ${(close * 1000) | 0}ms, want 180-320ms`);
        }
        // Must fall off: significantly worse at 35m than at 10m.
        const far = timeToKill(w, 35, H, 1);
        if (Number.isFinite(far) && far < close * 1.25) {
          errors.push(`${tag}: SMG does not fall off enough (10m ${(close * 1000) | 0}ms vs 35m ${(far * 1000) | 0}ms)`);
        }
        break;
      }
      case WeaponClass.SniperRifle: {
        if (w.handling.adsTime < 0.5) {
          errors.push(`${tag}: sniper adsTime ${w.handling.adsTime}s is below the 0.5s floor`);
        }
        if (w.traits.includes(WeaponTrait.OneShotUpperTorso)) {
          const first = w.damage[0]!;
          if (damageAtRange(w.damage, first.distance) < H) {
            errors.push(`${tag}: claims one-shot torso but deals < 100 at its first stop`);
          }
        }
        break;
      }
      case WeaponClass.Shotgun: {
        const closeDmg = damageAtRange(w.damage, 5) * w.pellets;
        const farDmg = damageAtRange(w.damage, 16) * w.pellets;
        if (closeDmg < H * 0.9) {
          errors.push(`${tag}: shotgun deals only ${closeDmg.toFixed(0)} at 5m, want ~lethal`);
        }
        if (farDmg > H * 0.45) {
          errors.push(`${tag}: shotgun still deals ${farDmg.toFixed(0)} at 16m, want it weak`);
        }
        break;
      }
      default:
        break;
    }
  }

  // Cross-class: SMGs must lose to ARs at range.
  const bestArAt30 = Math.min(...ASSAULT_RIFLES.map((w) => timeToKill(w, 30, H, 1)));
  const bestSmgAt30 = Math.min(...SMGS.map((w) => timeToKill(w, 30, H, 1)));
  if (bestSmgAt30 <= bestArAt30) {
    errors.push(
      `cross-class: best SMG at 30m (${(bestSmgAt30 * 1000) | 0}ms) beats best AR (${(bestArAt30 * 1000) | 0}ms)`,
    );
  }

  if (!WEAPONS[DEFAULT_PRIMARY]) errors.push(`DEFAULT_PRIMARY '${DEFAULT_PRIMARY}' does not exist`);
  if (!WEAPONS[DEFAULT_SECONDARY]) {
    errors.push(`DEFAULT_SECONDARY '${DEFAULT_SECONDARY}' does not exist`);
  }

  const ids = new Set<string>();
  for (const w of ALL) {
    if (ids.has(w.id)) errors.push(`duplicate weapon id: ${w.id}`);
    ids.add(w.id);
  }

  return errors;
}
