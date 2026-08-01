/**
 * Attachment table and the build resolver.
 *
 * An attachment is a *sparse* set of modifiers over WeaponDef fields, never a
 * second copy of a weapon. That keeps balance in one place: change a base gun
 * and every build of it moves with it.
 *
 * The design rule enforced by `validateAttachments()` is that no attachment is
 * free. COD's attachment game is interesting because every part is a trade, so
 * an attachment whose modifiers are all beneficial is treated as a data bug.
 */

import {
  AttachmentSlot,
  MAX_EQUIPPED_ATTACHMENTS,
  WeaponClass,
  type WeaponDef,
  WeaponTrait,
} from './weapon-types.js';

/**
 * Sparse modifier set. Absent fields mean "no change" — a missing multiplicative
 * field behaves as 1, a missing additive field as 0, a missing flag as false.
 */
export interface StatModifier {
  // multiplicative, 1 = no change
  adsTime?: number;
  sprintOutTime?: number;
  drawTime?: number;
  reloadTime?: number;
  movementSpeed?: number;
  adsSpeed?: number;
  recoilPitch?: number;
  recoilYaw?: number;
  hipSpread?: number;
  adsSpread?: number;
  damageRangeScale?: number;
  penetration?: number;
  muzzleVelocity?: number;
  swayAmount?: number;
  // additive
  magSizeAdd?: number;
  adsZoomAdd?: number;
  // flags
  suppressed?: boolean;
  hidesMinimapDot?: boolean;
}

export interface AttachmentDef {
  id: string;
  name: string;
  slot: AttachmentSlot;
  description: string;
  /** Restricts the attachment to these weapon classes. Empty = every class. */
  classes: WeaponClass[];
  mods: StatModifier;
  unlockLevel: number;
  /** Player-facing bullet points; purely presentational. */
  pros: string[];
  cons: string[];
}

/** Every class is allowed — hoisted so the table does not allocate 50 empty arrays. */
const ALL_CLASSES: WeaponClass[] = [];

export const ATTACHMENTS: Record<string, AttachmentDef> = {
  // -------------------------------------------------------------------------
  // Muzzle
  // -------------------------------------------------------------------------
  muzzle_flash_hider: {
    id: 'muzzle_flash_hider',
    name: 'Flash Hider',
    slot: AttachmentSlot.Muzzle,
    description: 'Vents gas sideways to kill the muzzle bloom that blinds you mid-burst.',
    classes: ALL_CLASSES,
    mods: { recoilPitch: 0.94, drawTime: 1.04, damageRangeScale: 0.97 },
    unlockLevel: 1,
    pros: ['Reduced vertical kick', 'No muzzle flash blooming your own sight picture'],
    cons: ['Slower weapon raise', 'Marginally shorter damage range'],
  },
  muzzle_compensator: {
    id: 'muzzle_compensator',
    name: 'Compensator',
    slot: AttachmentSlot.Muzzle,
    description: 'Top-ported can that fights horizontal walk at the cost of a wider hip cone.',
    classes: ALL_CLASSES,
    mods: { recoilYaw: 0.78, recoilPitch: 0.92, hipSpread: 1.08, adsTime: 1.03 },
    unlockLevel: 5,
    pros: ['Much tighter horizontal recoil', 'Slightly reduced vertical kick'],
    cons: ['Wider hipfire spread', 'Slower aim down sight'],
  },
  muzzle_brake: {
    id: 'muzzle_brake',
    name: 'Muzzle Brake',
    slot: AttachmentSlot.Muzzle,
    description: 'Aggressive side ports flatten the climb but throw the gun sideways.',
    classes: ALL_CLASSES,
    mods: { recoilPitch: 0.82, recoilYaw: 1.12, hipSpread: 1.1 },
    unlockLevel: 8,
    pros: ['Strongly reduced vertical recoil'],
    cons: ['Worse horizontal recoil', 'Wider hipfire spread'],
  },
  muzzle_choke: {
    id: 'muzzle_choke',
    name: 'Shotgun Choke',
    slot: AttachmentSlot.Muzzle,
    description: 'Constricts the pellet cone into a slug-like column.',
    classes: [WeaponClass.Shotgun],
    mods: { hipSpread: 0.72, adsSpread: 0.7, adsTime: 1.15, drawTime: 1.08 },
    unlockLevel: 6,
    pros: ['Dramatically tighter pellet spread'],
    cons: ['Much slower aim down sight', 'Slower weapon raise'],
  },
  muzzle_suppressor: {
    id: 'muzzle_suppressor',
    name: 'Suppressor',
    slot: AttachmentSlot.Muzzle,
    description: 'Keeps you off the minimap. Bleeds gas pressure, and therefore range.',
    classes: ALL_CLASSES,
    mods: {
      suppressed: true,
      hidesMinimapDot: true,
      damageRangeScale: 0.9,
      adsTime: 1.05,
      muzzleVelocity: 0.95,
    },
    unlockLevel: 3,
    pros: ['Silenced', 'No minimap dot when firing'],
    cons: ['Shorter damage range', 'Slower aim down sight', 'Lower muzzle velocity'],
  },
  muzzle_monolithic_suppressor: {
    id: 'muzzle_monolithic_suppressor',
    name: 'Monolithic Suppressor',
    slot: AttachmentSlot.Muzzle,
    description: 'Full-length can that acts as a barrel extension — silent and longer-reaching.',
    classes: ALL_CLASSES,
    mods: {
      suppressed: true,
      hidesMinimapDot: true,
      damageRangeScale: 1.05,
      recoilPitch: 0.95,
      adsTime: 1.12,
      drawTime: 1.1,
      movementSpeed: 0.98,
    },
    unlockLevel: 12,
    pros: ['Silenced', 'No minimap dot when firing', 'Extended damage range'],
    cons: ['Much slower aim down sight', 'Slower weapon raise', 'Slower movement'],
  },
  muzzle_light_suppressor: {
    id: 'muzzle_light_suppressor',
    name: 'Lightweight Suppressor',
    slot: AttachmentSlot.Muzzle,
    description: 'Titanium can tuned for aggression: keeps handling, pays for it in ballistics.',
    classes: ALL_CLASSES,
    mods: {
      suppressed: true,
      hidesMinimapDot: true,
      adsTime: 0.98,
      damageRangeScale: 0.86,
      muzzleVelocity: 0.9,
      sprintOutTime: 1.05,
    },
    unlockLevel: 20,
    pros: ['Silenced', 'No minimap dot when firing', 'Faster aim down sight'],
    cons: ['Heavily reduced damage range', 'Low muzzle velocity', 'Slower sprint-to-fire'],
  },

  // -------------------------------------------------------------------------
  // Barrel
  // -------------------------------------------------------------------------
  barrel_long_heavy: {
    id: 'barrel_long_heavy',
    name: 'Extended Heavy Barrel',
    slot: AttachmentSlot.Barrel,
    description: 'Every extra centimetre of rifling buys velocity and pays in handling.',
    classes: ALL_CLASSES,
    mods: {
      damageRangeScale: 1.2,
      muzzleVelocity: 1.25,
      recoilPitch: 0.95,
      adsTime: 1.12,
      movementSpeed: 0.95,
      swayAmount: 1.15,
    },
    unlockLevel: 9,
    pros: ['Greatly extended damage range', 'Much higher muzzle velocity'],
    cons: ['Slower aim down sight', 'Slower movement', 'More aim sway'],
  },
  barrel_short_cqb: {
    id: 'barrel_short_cqb',
    name: 'CQB Stub Barrel',
    slot: AttachmentSlot.Barrel,
    description: 'Chopped to the gas block for corridor work.',
    classes: ALL_CLASSES,
    mods: {
      adsTime: 0.88,
      movementSpeed: 1.04,
      hipSpread: 0.9,
      damageRangeScale: 0.85,
      recoilPitch: 1.12,
    },
    unlockLevel: 4,
    pros: ['Faster aim down sight', 'Faster movement', 'Tighter hipfire'],
    cons: ['Much shorter damage range', 'More vertical recoil'],
  },
  barrel_reinforced: {
    id: 'barrel_reinforced',
    name: 'Reinforced Heavy Barrel',
    slot: AttachmentSlot.Barrel,
    description: 'Thick-walled and chrome-lined; rounds keep their energy through cover.',
    classes: ALL_CLASSES,
    mods: {
      penetration: 1.35,
      damageRangeScale: 1.08,
      adsTime: 1.1,
      sprintOutTime: 1.08,
      movementSpeed: 0.96,
    },
    unlockLevel: 15,
    pros: ['Far better wall penetration', 'Extended damage range'],
    cons: ['Slower aim down sight', 'Slower sprint-to-fire', 'Slower movement'],
  },
  barrel_fluted: {
    id: 'barrel_fluted',
    name: 'Fluted Barrel',
    slot: AttachmentSlot.Barrel,
    description: 'Machined flutes shed weight from the front end.',
    classes: ALL_CLASSES,
    mods: { adsTime: 0.94, drawTime: 0.9, recoilPitch: 1.08, damageRangeScale: 0.95 },
    unlockLevel: 11,
    pros: ['Faster aim down sight', 'Faster weapon raise'],
    cons: ['More vertical recoil', 'Slightly shorter damage range'],
  },
  barrel_ported: {
    id: 'barrel_ported',
    name: 'Ported Barrel',
    slot: AttachmentSlot.Barrel,
    description: 'Gas ports cut ahead of the muzzle bleed pressure to settle the gun.',
    classes: ALL_CLASSES,
    mods: { recoilPitch: 0.88, recoilYaw: 0.9, damageRangeScale: 0.92, hipSpread: 1.06 },
    unlockLevel: 7,
    pros: ['Reduced recoil in both axes'],
    cons: ['Shorter damage range', 'Wider hipfire spread'],
  },
  barrel_marksman: {
    id: 'barrel_marksman',
    name: 'Marksman Barrel',
    slot: AttachmentSlot.Barrel,
    description: 'Match-grade tube for people who take their time.',
    classes: ALL_CLASSES,
    mods: {
      adsSpread: 0.8,
      swayAmount: 0.85,
      damageRangeScale: 1.12,
      adsTime: 1.15,
      movementSpeed: 0.94,
    },
    unlockLevel: 18,
    pros: ['Much tighter aimed accuracy', 'Less aim sway', 'Extended damage range'],
    cons: ['Much slower aim down sight', 'Slower movement'],
  },
  barrel_lancer: {
    id: 'barrel_lancer',
    name: 'Cavalry Lancer Barrel',
    slot: AttachmentSlot.Barrel,
    description: 'Stripped to nothing for run-and-gun; accuracy is not the point.',
    classes: [WeaponClass.SubmachineGun, WeaponClass.Shotgun],
    mods: { movementSpeed: 1.06, sprintOutTime: 0.85, damageRangeScale: 0.8, adsSpread: 1.2 },
    unlockLevel: 22,
    pros: ['Faster movement', 'Much faster sprint-to-fire'],
    cons: ['Heavily reduced damage range', 'Much worse aimed accuracy'],
  },

  // -------------------------------------------------------------------------
  // Optic
  // -------------------------------------------------------------------------
  optic_reflex_micro: {
    id: 'optic_reflex_micro',
    name: 'Micro Reflex',
    slot: AttachmentSlot.Optic,
    description: 'The smallest dot that still clears the irons.',
    classes: ALL_CLASSES,
    mods: { swayAmount: 0.97, adsZoomAdd: 0.05, adsTime: 1.02 },
    unlockLevel: 2,
    pros: ['Clean sight picture', 'Slightly less sway'],
    cons: ['Marginally slower aim down sight'],
  },
  optic_red_dot: {
    id: 'optic_red_dot',
    name: 'Red Dot Sight',
    slot: AttachmentSlot.Optic,
    description: 'Standard-issue dot. Precise, uncomplicated, a little bulky.',
    classes: ALL_CLASSES,
    mods: { adsSpread: 0.95, adsZoomAdd: 0.1, adsTime: 1.04 },
    unlockLevel: 4,
    pros: ['Tighter aimed accuracy', 'Uncluttered reticle'],
    cons: ['Slower aim down sight'],
  },
  optic_holographic: {
    id: 'optic_holographic',
    name: 'Holographic Sight',
    slot: AttachmentSlot.Optic,
    description: 'Wide window, ring reticle, and a housing you feel on the rail.',
    classes: ALL_CLASSES,
    mods: { swayAmount: 0.95, adsZoomAdd: 0.15, adsTime: 1.06, hipSpread: 1.05 },
    unlockLevel: 8,
    pros: ['Wide field of view', 'Less aim sway'],
    cons: ['Slower aim down sight', 'Wider hipfire spread'],
  },
  optic_offset_canted: {
    id: 'optic_offset_canted',
    name: 'Canted Offset Sight',
    slot: AttachmentSlot.Optic,
    description: 'A 45-degree dot you roll onto — fast, but you give up the fine reticle.',
    classes: ALL_CLASSES,
    mods: { adsTime: 0.96, adsZoomAdd: -0.1, adsSpread: 1.08, hipSpread: 1.04 },
    unlockLevel: 14,
    pros: ['Faster aim down sight', 'Wider peripheral vision'],
    cons: ['Worse aimed accuracy', 'Reduced zoom', 'Slightly wider hipfire'],
  },
  optic_scope_3x: {
    id: 'optic_scope_3x',
    name: '3x Combat Scope',
    slot: AttachmentSlot.Optic,
    description: 'Mid-range glass with a chevron; the first optic that punishes you up close.',
    classes: ALL_CLASSES,
    mods: { adsZoomAdd: 0.6, adsSpread: 0.9, adsTime: 1.12, hipSpread: 1.15, movementSpeed: 0.98 },
    unlockLevel: 13,
    pros: ['Strong magnification', 'Tighter aimed accuracy'],
    cons: ['Slower aim down sight', 'Much wider hipfire spread', 'Slower movement'],
  },
  optic_scope_4x: {
    id: 'optic_scope_4x',
    name: '4x Tactical Scope',
    slot: AttachmentSlot.Optic,
    description: 'Long glass for holding a lane. Sway becomes your problem, not recoil.',
    classes: ALL_CLASSES,
    mods: { adsZoomAdd: 1.0, adsSpread: 0.85, adsTime: 1.18, swayAmount: 1.2, hipSpread: 1.2 },
    unlockLevel: 17,
    pros: ['High magnification', 'Much tighter aimed accuracy'],
    cons: ['Much slower aim down sight', 'More aim sway', 'Much wider hipfire spread'],
  },
  optic_thermal: {
    id: 'optic_thermal',
    name: 'Thermal Hybrid',
    slot: AttachmentSlot.Optic,
    description: 'Paints bodies white through smoke. Boots slowly and weighs a lot.',
    classes: ALL_CLASSES,
    mods: { adsZoomAdd: 0.5, adsSpread: 0.88, adsTime: 1.22, drawTime: 1.15, hipSpread: 1.1 },
    unlockLevel: 24,
    pros: ['Targets highlighted through smoke', 'Tighter aimed accuracy'],
    cons: ['Very slow aim down sight', 'Slow weapon raise', 'Wider hipfire spread'],
  },
  optic_variable_sniper: {
    id: 'optic_variable_sniper',
    name: 'Variable Sniper Scope',
    slot: AttachmentSlot.Optic,
    description: 'Dialled-up magnification for shots most players never take.',
    classes: [WeaponClass.SniperRifle, WeaponClass.MarksmanRifle],
    mods: { adsZoomAdd: 2.0, adsSpread: 0.7, adsTime: 1.25, swayAmount: 1.25, movementSpeed: 0.96 },
    unlockLevel: 26,
    pros: ['Extreme magnification', 'Near-perfect aimed accuracy'],
    cons: ['Very slow aim down sight', 'Heavy scope sway', 'Slower movement'],
  },

  // -------------------------------------------------------------------------
  // Underbarrel
  // -------------------------------------------------------------------------
  under_vertical_grip: {
    id: 'under_vertical_grip',
    name: 'Vertical Foregrip',
    slot: AttachmentSlot.Underbarrel,
    description: 'Pulls the muzzle down under sustained fire.',
    classes: ALL_CLASSES,
    mods: { recoilPitch: 0.85, adsTime: 1.06, movementSpeed: 0.98 },
    unlockLevel: 3,
    pros: ['Strongly reduced vertical recoil'],
    cons: ['Slower aim down sight', 'Slower movement'],
  },
  under_angled_grip: {
    id: 'under_angled_grip',
    name: 'Angled Foregrip',
    slot: AttachmentSlot.Underbarrel,
    description: 'Rolls the wrist forward so the gun comes up quicker out of a sprint.',
    classes: ALL_CLASSES,
    mods: { adsTime: 0.9, sprintOutTime: 0.88, recoilPitch: 1.08, hipSpread: 1.05 },
    unlockLevel: 6,
    pros: ['Faster aim down sight', 'Faster sprint-to-fire'],
    cons: ['More vertical recoil', 'Wider hipfire spread'],
  },
  under_bipod: {
    id: 'under_bipod',
    name: 'Folding Bipod',
    slot: AttachmentSlot.Underbarrel,
    description: 'Weight up front kills both kick and sway; also kills your legs.',
    classes: ALL_CLASSES,
    mods: { recoilPitch: 0.8, swayAmount: 0.8, movementSpeed: 0.94, adsTime: 1.08 },
    unlockLevel: 10,
    pros: ['Heavily reduced vertical recoil', 'Much less aim sway'],
    cons: ['Much slower movement', 'Slower aim down sight'],
  },
  under_ranger_grip: {
    id: 'under_ranger_grip',
    name: 'Ranger Handguard',
    slot: AttachmentSlot.Underbarrel,
    description: 'Built for shooting from the hip and living with the consequences.',
    classes: ALL_CLASSES,
    mods: { hipSpread: 0.82, adsSpread: 1.12, adsTime: 1.05 },
    unlockLevel: 12,
    pros: ['Much tighter hipfire spread'],
    cons: ['Worse aimed accuracy', 'Slower aim down sight'],
  },
  under_handstop: {
    id: 'under_handstop',
    name: 'Polymer Handstop',
    slot: AttachmentSlot.Underbarrel,
    description: 'A thumb stop and nothing else. Movement first.',
    classes: ALL_CLASSES,
    mods: { sprintOutTime: 0.85, movementSpeed: 1.03, recoilYaw: 1.1, hipSpread: 1.06 },
    unlockLevel: 8,
    pros: ['Much faster sprint-to-fire', 'Faster movement'],
    cons: ['More horizontal recoil', 'Wider hipfire spread'],
  },
  under_damped_grip: {
    id: 'under_damped_grip',
    name: 'Damped Foregrip',
    slot: AttachmentSlot.Underbarrel,
    description: 'Tungsten-cored grip that soaks up kick in both axes.',
    classes: ALL_CLASSES,
    mods: { recoilPitch: 0.88, recoilYaw: 0.88, adsTime: 1.1, drawTime: 1.08, movementSpeed: 0.97 },
    unlockLevel: 16,
    pros: ['Reduced recoil in both axes'],
    cons: ['Slower aim down sight', 'Slower weapon raise', 'Slower movement'],
  },
  under_grenade_launcher: {
    id: 'under_grenade_launcher',
    name: '40mm Launcher',
    slot: AttachmentSlot.Underbarrel,
    description: 'A single 40mm shell slung under the handguard. Everything else gets slower.',
    classes: [WeaponClass.AssaultRifle, WeaponClass.LightMachineGun],
    mods: {
      recoilPitch: 0.95,
      adsTime: 1.15,
      movementSpeed: 0.93,
      drawTime: 1.12,
      sprintOutTime: 1.1,
    },
    unlockLevel: 21,
    pros: ['Underbarrel explosive shell', 'Extra mass steadies the muzzle'],
    cons: ['Much slower aim down sight', 'Much slower movement', 'Sluggish weapon raise'],
  },

  // -------------------------------------------------------------------------
  // Magazine
  // -------------------------------------------------------------------------
  mag_extended: {
    id: 'mag_extended',
    name: 'Extended Mag',
    slot: AttachmentSlot.Magazine,
    description: 'Ten more rounds before you have to think about reloading.',
    classes: ALL_CLASSES,
    mods: { magSizeAdd: 10, reloadTime: 1.08, adsTime: 1.04, movementSpeed: 0.99 },
    unlockLevel: 2,
    pros: ['+10 rounds'],
    cons: ['Slower reload', 'Slower aim down sight'],
  },
  mag_extended_large: {
    id: 'mag_extended_large',
    name: 'High-Capacity Mag',
    slot: AttachmentSlot.Magazine,
    description: 'Thirty extra rounds of hanging weight.',
    classes: ALL_CLASSES,
    mods: { magSizeAdd: 30, reloadTime: 1.25, adsTime: 1.12, movementSpeed: 0.96, sprintOutTime: 1.08 },
    unlockLevel: 9,
    pros: ['+30 rounds'],
    cons: ['Much slower reload', 'Slower aim down sight', 'Slower movement'],
  },
  mag_drum: {
    id: 'mag_drum',
    name: 'Drum Magazine',
    slot: AttachmentSlot.Magazine,
    description: 'Sixty extra rounds. You will not be sprinting anywhere.',
    classes: ALL_CLASSES,
    mods: { magSizeAdd: 60, reloadTime: 1.45, adsTime: 1.2, movementSpeed: 0.92, drawTime: 1.2 },
    unlockLevel: 18,
    pros: ['+60 rounds'],
    cons: ['Very slow reload', 'Very slow aim down sight', 'Much slower movement'],
  },
  mag_taped: {
    id: 'mag_taped',
    name: 'Taped Mags',
    slot: AttachmentSlot.Magazine,
    description: 'Two mags jungle-taped together — the fastest reload in the game.',
    classes: ALL_CLASSES,
    mods: { reloadTime: 0.72, magSizeAdd: -2, adsTime: 1.05 },
    unlockLevel: 5,
    pros: ['Dramatically faster reload'],
    cons: ['-2 rounds', 'Slower aim down sight'],
  },
  mag_lightweight: {
    id: 'mag_lightweight',
    name: 'Lightweight Mag',
    slot: AttachmentSlot.Magazine,
    description: 'Short polymer mag that gets out of the way of everything.',
    classes: ALL_CLASSES,
    mods: { adsTime: 0.94, movementSpeed: 1.03, reloadTime: 0.92, magSizeAdd: -5 },
    unlockLevel: 7,
    pros: ['Faster aim down sight', 'Faster movement', 'Faster reload'],
    cons: ['-5 rounds'],
  },
  mag_armor_piercing: {
    id: 'mag_armor_piercing',
    name: 'Armour-Piercing Rounds',
    slot: AttachmentSlot.Magazine,
    description: 'Hardened penetrators that treat plywood as an inconvenience.',
    classes: ALL_CLASSES,
    mods: {
      penetration: 1.6,
      damageRangeScale: 1.05,
      reloadTime: 1.1,
      muzzleVelocity: 0.95,
      magSizeAdd: -4,
    },
    unlockLevel: 14,
    pros: ['Greatly improved wall penetration', 'Slightly extended damage range'],
    cons: ['-4 rounds', 'Slower reload', 'Lower muzzle velocity'],
  },
  mag_subsonic: {
    id: 'mag_subsonic',
    name: 'Subsonic Rounds',
    slot: AttachmentSlot.Magazine,
    description: 'No supersonic crack, so no dot on the minimap — and no reach either.',
    classes: ALL_CLASSES,
    mods: { hidesMinimapDot: true, recoilPitch: 0.95, muzzleVelocity: 0.7, damageRangeScale: 0.85 },
    unlockLevel: 20,
    pros: ['No minimap dot when firing', 'Slightly softer recoil'],
    cons: ['Much lower muzzle velocity', 'Reduced damage range'],
  },
  mag_overpressured: {
    id: 'mag_overpressured',
    name: 'Overpressured Rounds',
    slot: AttachmentSlot.Magazine,
    description: 'Hot loads that reach further and try to take your wrist with them.',
    classes: ALL_CLASSES,
    mods: {
      muzzleVelocity: 1.3,
      damageRangeScale: 1.18,
      recoilPitch: 1.2,
      recoilYaw: 1.15,
      magSizeAdd: -4,
    },
    unlockLevel: 25,
    pros: ['Much higher muzzle velocity', 'Extended damage range'],
    cons: ['-4 rounds', 'Much more recoil in both axes'],
  },

  // -------------------------------------------------------------------------
  // Stock
  // -------------------------------------------------------------------------
  stock_heavy: {
    id: 'stock_heavy',
    name: 'Heavy Stock',
    slot: AttachmentSlot.Stock,
    description: 'Shoulders like a bench rest and moves like one too.',
    classes: ALL_CLASSES,
    mods: { recoilPitch: 0.85, swayAmount: 0.8, adsTime: 1.1, movementSpeed: 0.95, sprintOutTime: 1.1 },
    unlockLevel: 5,
    pros: ['Strongly reduced vertical recoil', 'Much less aim sway'],
    cons: ['Slower aim down sight', 'Slower movement', 'Slower sprint-to-fire'],
  },
  stock_skeleton: {
    id: 'stock_skeleton',
    name: 'Skeleton Stock',
    slot: AttachmentSlot.Stock,
    description: 'Milled out until only the cheek weld is left.',
    classes: ALL_CLASSES,
    mods: { adsTime: 0.9, movementSpeed: 1.05, sprintOutTime: 0.9, recoilPitch: 1.15, adsSpread: 1.08 },
    unlockLevel: 3,
    pros: ['Faster aim down sight', 'Faster movement', 'Faster sprint-to-fire'],
    cons: ['More vertical recoil', 'Worse aimed accuracy'],
  },
  stock_none: {
    id: 'stock_none',
    name: 'Stockless',
    slot: AttachmentSlot.Stock,
    description: 'No stock at all. Pure aggression, zero stability.',
    classes: ALL_CLASSES,
    mods: {
      movementSpeed: 1.08,
      adsTime: 0.85,
      sprintOutTime: 0.8,
      recoilPitch: 1.25,
      recoilYaw: 1.2,
      adsSpread: 1.15,
      swayAmount: 1.2,
    },
    unlockLevel: 11,
    pros: ['Much faster aim down sight', 'Much faster movement', 'Near-instant sprint-to-fire'],
    cons: ['Severe recoil in both axes', 'Poor aimed accuracy', 'Heavy aim sway'],
  },
  stock_collapsible: {
    id: 'stock_collapsible',
    name: 'Collapsible Stock',
    slot: AttachmentSlot.Stock,
    description: 'Middle-ground telescoping stock for people who cannot commit.',
    classes: ALL_CLASSES,
    mods: { movementSpeed: 1.03, adsTime: 0.95, recoilYaw: 1.08, swayAmount: 1.06 },
    unlockLevel: 6,
    pros: ['Faster movement', 'Faster aim down sight'],
    cons: ['More horizontal recoil', 'More aim sway'],
  },
  stock_precision: {
    id: 'stock_precision',
    name: 'Precision Stock',
    slot: AttachmentSlot.Stock,
    description: 'Adjustable comb and cheek riser; built around holding a crosshair still.',
    classes: ALL_CLASSES,
    mods: { swayAmount: 0.7, adsSpread: 0.88, adsTime: 1.08, movementSpeed: 0.96, drawTime: 1.05 },
    unlockLevel: 15,
    pros: ['Dramatically less aim sway', 'Tighter aimed accuracy'],
    cons: ['Slower aim down sight', 'Slower movement', 'Slower weapon raise'],
  },
  stock_padded: {
    id: 'stock_padded',
    name: 'Recoil-Padded Stock',
    slot: AttachmentSlot.Stock,
    description: 'A thick rubber pad that eats impulse in every direction.',
    classes: ALL_CLASSES,
    mods: { recoilPitch: 0.9, recoilYaw: 0.9, movementSpeed: 0.97, adsTime: 1.05 },
    unlockLevel: 9,
    pros: ['Reduced recoil in both axes'],
    cons: ['Slower movement', 'Slower aim down sight'],
  },
  stock_brace: {
    id: 'stock_brace',
    name: 'Aim-Assist Brace',
    slot: AttachmentSlot.Stock,
    description: 'Sling-tensioned brace that lets you keep walking while scoped.',
    classes: ALL_CLASSES,
    mods: { adsSpeed: 1.15, swayAmount: 0.9, adsTime: 1.06, sprintOutTime: 1.05 },
    unlockLevel: 19,
    pros: ['Much faster movement while aiming', 'Less aim sway'],
    cons: ['Slower aim down sight', 'Slower sprint-to-fire'],
  },

  // -------------------------------------------------------------------------
  // Rear grip
  // -------------------------------------------------------------------------
  grip_rubberized: {
    id: 'grip_rubberized',
    name: 'Rubberised Grip',
    slot: AttachmentSlot.RearGrip,
    description: 'Soft overmould that soaks up the first shot of every burst.',
    classes: ALL_CLASSES,
    mods: { recoilPitch: 0.9, adsTime: 1.05 },
    unlockLevel: 2,
    pros: ['Reduced vertical recoil'],
    cons: ['Slower aim down sight'],
  },
  grip_stippled: {
    id: 'grip_stippled',
    name: 'Stippled Grip Tape',
    slot: AttachmentSlot.RearGrip,
    description: 'Coarse tape so the gun does not shift as you snap onto a target.',
    classes: ALL_CLASSES,
    mods: { adsTime: 0.9, sprintOutTime: 0.9, recoilPitch: 1.1 },
    unlockLevel: 4,
    pros: ['Faster aim down sight', 'Faster sprint-to-fire'],
    cons: ['More vertical recoil'],
  },
  grip_granulated: {
    id: 'grip_granulated',
    name: 'Granulated Grip',
    slot: AttachmentSlot.RearGrip,
    description: 'Grit-blasted panels for wet hands and fast mag changes.',
    classes: ALL_CLASSES,
    mods: { drawTime: 0.85, reloadTime: 0.9, recoilYaw: 1.1, hipSpread: 1.05 },
    unlockLevel: 7,
    pros: ['Much faster weapon raise', 'Faster reload'],
    cons: ['More horizontal recoil', 'Wider hipfire spread'],
  },
  grip_quickdraw: {
    id: 'grip_quickdraw',
    name: 'Quickdraw Grip',
    slot: AttachmentSlot.RearGrip,
    description: 'Cut-down tang that clears a holster before anyone hears it.',
    classes: ALL_CLASSES,
    mods: { drawTime: 0.75, swayAmount: 1.15, adsSpread: 1.05 },
    unlockLevel: 10,
    pros: ['Dramatically faster weapon raise'],
    cons: ['More aim sway', 'Worse aimed accuracy'],
  },
  grip_ergonomic: {
    id: 'grip_ergonomic',
    name: 'Ergonomic Grip',
    slot: AttachmentSlot.RearGrip,
    description: 'Palm swell and a steeper rake — steady, but slow to work the mag well.',
    classes: ALL_CLASSES,
    mods: { swayAmount: 0.85, adsSpeed: 1.08, reloadTime: 1.08, movementSpeed: 0.98 },
    unlockLevel: 16,
    pros: ['Less aim sway', 'Faster movement while aiming'],
    cons: ['Slower reload', 'Slower movement'],
  },
  grip_heavy_wrap: {
    id: 'grip_heavy_wrap',
    name: 'Heavy Grip Wrap',
    slot: AttachmentSlot.RearGrip,
    description: 'Weighted paracord wrap that stops the gun walking sideways.',
    classes: ALL_CLASSES,
    mods: { recoilYaw: 0.85, hipSpread: 0.95, drawTime: 1.12, adsTime: 1.06 },
    unlockLevel: 13,
    pros: ['Strongly reduced horizontal recoil', 'Tighter hipfire'],
    cons: ['Slower weapon raise', 'Slower aim down sight'],
  },

  // -------------------------------------------------------------------------
  // Laser
  // -------------------------------------------------------------------------
  laser_1mw: {
    id: 'laser_1mw',
    name: '1mW Laser',
    slot: AttachmentSlot.Laser,
    description: 'A dim dot on the wall that makes hipfire honest.',
    classes: ALL_CLASSES,
    mods: { hipSpread: 0.78, adsTime: 1.04, movementSpeed: 0.99 },
    unlockLevel: 1,
    pros: ['Much tighter hipfire spread'],
    cons: ['Slower aim down sight', 'Beam is visible to enemies'],
  },
  laser_5mw: {
    id: 'laser_5mw',
    name: '5mW Laser',
    slot: AttachmentSlot.Laser,
    description: 'Bright enough to see in daylight. Bright enough for them to see, too.',
    classes: ALL_CLASSES,
    mods: { hipSpread: 0.68, adsTime: 0.95, movementSpeed: 0.97, drawTime: 1.06 },
    unlockLevel: 6,
    pros: ['Dramatically tighter hipfire', 'Faster aim down sight'],
    cons: ['Slower movement', 'Slower weapon raise', 'Highly visible beam'],
  },
  laser_ir: {
    id: 'laser_ir',
    name: 'IR Illuminator',
    slot: AttachmentSlot.Laser,
    description: 'Invisible to the naked eye, so nobody traces it back to you.',
    classes: ALL_CLASSES,
    mods: { hipSpread: 0.85, sprintOutTime: 0.9, drawTime: 1.1, adsTime: 1.05 },
    unlockLevel: 12,
    pros: ['Tighter hipfire', 'Faster sprint-to-fire', 'Beam invisible to enemies'],
    cons: ['Slower weapon raise', 'Slower aim down sight'],
  },
  laser_steady: {
    id: 'laser_steady',
    name: 'Steady-Aim Laser',
    slot: AttachmentSlot.Laser,
    description: 'Gyro-stabilised module that damps the wobble at full magnification.',
    classes: ALL_CLASSES,
    mods: { swayAmount: 0.75, hipSpread: 0.9, adsTime: 1.08, movementSpeed: 0.97 },
    unlockLevel: 17,
    pros: ['Much less aim sway', 'Tighter hipfire'],
    cons: ['Slower aim down sight', 'Slower movement'],
  },
  laser_rangefinder: {
    id: 'laser_rangefinder',
    name: 'Laser Rangefinder',
    slot: AttachmentSlot.Laser,
    description: 'Ranges the target and trims the holdover for you.',
    classes: ALL_CLASSES,
    mods: { damageRangeScale: 1.1, adsSpread: 0.92, adsTime: 1.1, drawTime: 1.08 },
    unlockLevel: 23,
    pros: ['Extended damage range', 'Tighter aimed accuracy'],
    cons: ['Slower aim down sight', 'Slower weapon raise'],
  },
  laser_combat_light: {
    id: 'laser_combat_light',
    name: 'Combat Light',
    slot: AttachmentSlot.Laser,
    description: 'Weapon light and laser in one housing. Wonderful indoors, suicidal outdoors.',
    classes: ALL_CLASSES,
    mods: { hipSpread: 0.72, sprintOutTime: 0.92, adsSpread: 1.1, movementSpeed: 0.98 },
    unlockLevel: 9,
    pros: ['Very tight hipfire spread', 'Faster sprint-to-fire'],
    cons: ['Worse aimed accuracy', 'Slower movement', 'Lights you up to everyone'],
  },
};

export function getAttachment(id: string): AttachmentDef {
  const def = ATTACHMENTS[id];
  if (!def) throw new Error(`Unknown attachment: ${id}`);
  return def;
}

/**
 * Attachments a given weapon may fit in a slot, ordered the way the gunsmith UI
 * shows them: earliest unlock first, then alphabetically for a stable list.
 */
export function attachmentsForSlot(slot: AttachmentSlot, weaponClass: WeaponClass): AttachmentDef[] {
  return Object.values(ATTACHMENTS)
    .filter((a) => a.slot === slot && (a.classes.length === 0 || a.classes.includes(weaponClass)))
    .sort((a, b) => a.unlockLevel - b.unlockLevel || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Build resolution
// ---------------------------------------------------------------------------

/** Every multiplicative/additive/flag modifier collapsed into one dense record. */
interface AccumulatedMods {
  adsTime: number;
  sprintOutTime: number;
  drawTime: number;
  reloadTime: number;
  movementSpeed: number;
  adsSpeed: number;
  recoilPitch: number;
  recoilYaw: number;
  hipSpread: number;
  adsSpread: number;
  damageRangeScale: number;
  penetration: number;
  muzzleVelocity: number;
  swayAmount: number;
  magSizeAdd: number;
  adsZoomAdd: number;
  suppressed: boolean;
  hidesMinimapDot: boolean;
}

function neutralMods(): AccumulatedMods {
  return {
    adsTime: 1,
    sprintOutTime: 1,
    drawTime: 1,
    reloadTime: 1,
    movementSpeed: 1,
    adsSpeed: 1,
    recoilPitch: 1,
    recoilYaw: 1,
    hipSpread: 1,
    adsSpread: 1,
    damageRangeScale: 1,
    penetration: 1,
    muzzleVelocity: 1,
    swayAmount: 1,
    magSizeAdd: 0,
    adsZoomAdd: 0,
    suppressed: false,
    hidesMinimapDot: false,
  };
}

/**
 * Deep copy of everything `resolveWeapon` writes to. The base table is shared
 * process-wide and handed to the renderer, so mutating it would silently rebalance
 * every other player's identical gun.
 */
function cloneWeapon(base: WeaponDef): WeaponDef {
  return {
    ...base,
    damage: base.damage.map((stop) => ({ distance: stop.distance, damage: stop.damage })),
    recoil: {
      ...base.recoil,
      pattern: base.recoil.pattern.map((step) => ({ pitch: step.pitch, yaw: step.yaw })),
    },
    spread: { ...base.spread },
    handling: { ...base.handling },
    attachmentSlots: [...base.attachmentSlots],
    audio: { ...base.audio },
    model: { ...base.model },
    traits: [...base.traits],
  };
}

/**
 * Picks the attachments that actually take effect: known ids only, one per slot
 * (first wins, matching the gunsmith's "replace the part you already fitted"
 * behaviour), and never more than the equip cap.
 */
function selectAttachments(attachmentIds: readonly string[]): AttachmentDef[] {
  const picked: AttachmentDef[] = [];
  const usedSlots = new Set<AttachmentSlot>();

  for (const id of attachmentIds) {
    if (picked.length >= MAX_EQUIPPED_ATTACHMENTS) break;
    const def = ATTACHMENTS[id];
    if (!def) continue;
    if (usedSlots.has(def.slot)) continue;
    usedSlots.add(def.slot);
    picked.push(def);
  }
  return picked;
}

function accumulate(defs: readonly AttachmentDef[]): AccumulatedMods {
  const acc = neutralMods();
  for (const def of defs) {
    const m = def.mods;
    acc.adsTime *= m.adsTime ?? 1;
    acc.sprintOutTime *= m.sprintOutTime ?? 1;
    acc.drawTime *= m.drawTime ?? 1;
    acc.reloadTime *= m.reloadTime ?? 1;
    acc.movementSpeed *= m.movementSpeed ?? 1;
    acc.adsSpeed *= m.adsSpeed ?? 1;
    acc.recoilPitch *= m.recoilPitch ?? 1;
    acc.recoilYaw *= m.recoilYaw ?? 1;
    acc.hipSpread *= m.hipSpread ?? 1;
    acc.adsSpread *= m.adsSpread ?? 1;
    acc.damageRangeScale *= m.damageRangeScale ?? 1;
    acc.penetration *= m.penetration ?? 1;
    acc.muzzleVelocity *= m.muzzleVelocity ?? 1;
    acc.swayAmount *= m.swayAmount ?? 1;
    acc.magSizeAdd += m.magSizeAdd ?? 0;
    acc.adsZoomAdd += m.adsZoomAdd ?? 0;
    acc.suppressed = acc.suppressed || (m.suppressed ?? false);
    acc.hidesMinimapDot = acc.hidesMinimapDot || (m.hidesMinimapDot ?? false);
  }
  return acc;
}

/**
 * Effective weapon for a build. Pure: the base def is never touched, and the
 * result is a standalone WeaponDef that combat code can use without knowing
 * attachments exist.
 *
 * Modifiers are multiplied together *before* being applied, so the result does
 * not depend on the order the player fitted the parts.
 */
export function resolveWeapon(base: WeaponDef, attachmentIds: readonly string[]): WeaponDef {
  const out = cloneWeapon(base);
  const equipped = selectAttachments(attachmentIds);
  if (equipped.length === 0) return out;

  const mods = accumulate(equipped);

  out.handling.adsTime *= mods.adsTime;
  out.handling.sprintOutTime *= mods.sprintOutTime;
  out.handling.drawTime *= mods.drawTime;
  out.handling.movementSpeedMultiplier *= mods.movementSpeed;
  out.handling.adsSpeedMultiplier *= mods.adsSpeed;
  out.handling.swayAmount *= mods.swayAmount;

  // All four reload timings scale together: the ammo-add moments are fractions of
  // the animation, so scaling only the totals would let a fast mag add ammo after
  // the reload had already finished.
  out.handling.reloadTime *= mods.reloadTime;
  out.handling.reloadEmptyTime *= mods.reloadTime;
  out.handling.reloadAmmoTime *= mods.reloadTime;
  out.handling.reloadEmptyAmmoTime *= mods.reloadTime;

  for (const step of out.recoil.pattern) {
    step.pitch *= mods.recoilPitch;
    step.yaw *= mods.recoilYaw;
  }
  // The random component is part of the same felt recoil; leaving it unscaled
  // would make a heavily-braked gun still feel loose.
  out.recoil.randomPitch *= mods.recoilPitch;
  out.recoil.randomYaw *= mods.recoilYaw;

  out.spread.hipMin *= mods.hipSpread;
  out.spread.hipMax *= mods.hipSpread;
  out.spread.adsMin *= mods.adsSpread;
  out.spread.adsMax *= mods.adsSpread;

  // Range attachments move where the damage steps sit, never how hard they hit —
  // otherwise attachments would change time-to-kill, which is the one thing the
  // base weapon table owns.
  for (const stop of out.damage) {
    stop.distance *= mods.damageRangeScale;
  }

  out.penetration *= mods.penetration;
  out.muzzleVelocity *= mods.muzzleVelocity;

  out.magSize = Math.max(1, Math.round(out.magSize + mods.magSizeAdd));
  out.adsZoom = Math.max(1, out.adsZoom + mods.adsZoomAdd);

  if (mods.suppressed) out.audio.suppressed = true;
  if (mods.hidesMinimapDot && !out.traits.includes(WeaponTrait.AlwaysSuppressed)) {
    out.traits.push(WeaponTrait.AlwaysSuppressed);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Data validation
// ---------------------------------------------------------------------------

/** Multiplicative fields where a value above 1 is a penalty. */
const LOWER_IS_BETTER = [
  'adsTime',
  'sprintOutTime',
  'drawTime',
  'reloadTime',
  'recoilPitch',
  'recoilYaw',
  'hipSpread',
  'adsSpread',
  'swayAmount',
] as const;

/** Multiplicative fields where a value below 1 is a penalty. */
const HIGHER_IS_BETTER = [
  'movementSpeed',
  'adsSpeed',
  'damageRangeScale',
  'penetration',
  'muzzleVelocity',
] as const;

const MAX_UNLOCK_LEVEL = 30;

/**
 * Data integrity pass, meant to run in a unit test rather than at runtime.
 *
 * `adsZoomAdd` is deliberately not scored: more or less magnification is a
 * preference, not a strict upgrade, so an optic cannot pay for itself with zoom.
 */
export function validateAttachments(): string[] {
  const errors: string[] = [];

  for (const [key, def] of Object.entries(ATTACHMENTS)) {
    if (key !== def.id) {
      errors.push(`${key}: table key does not match id "${def.id}"`);
    }

    if (def.unlockLevel < 0 || def.unlockLevel > MAX_UNLOCK_LEVEL) {
      errors.push(
        `${def.id}: unlockLevel ${def.unlockLevel} is outside 0..${MAX_UNLOCK_LEVEL}`,
      );
    }

    let hasDownside = false;
    for (const field of LOWER_IS_BETTER) {
      const value = def.mods[field];
      if (value !== undefined && value > 1) hasDownside = true;
    }
    for (const field of HIGHER_IS_BETTER) {
      const value = def.mods[field];
      if (value !== undefined && value < 1) hasDownside = true;
    }
    if ((def.mods.magSizeAdd ?? 0) < 0) hasDownside = true;

    if (!hasDownside) {
      errors.push(`${def.id}: has no downside — every attachment must cost something`);
    }
  }

  return errors;
}
