/**
 * Perk table.
 *
 * Perks are three independent picks (one per tier), so the tier a perk sits in is
 * the real balance lever: two effects that would be oppressive together are put in
 * the same tier and made mutually exclusive rather than nerfed.
 *
 * `combinePerkEffects()` returns a fully-populated effect set so gameplay code can
 * read `effects.movementSpeedMult` unconditionally instead of null-checking a
 * sparse object on every tick.
 */

/**
 * Sparse effect set.
 *
 * Field naming carries the combine semantics:
 *  - `*Mult` fields are ratios and combine multiplicatively (neutral = 1).
 *  - every other number is an additive bonus (neutral = 0) — `fasterCapture: 0.3`
 *    means "+30% capture rate", `quieterFootsteps: 0.5` means "50% of footstep
 *    volume removed". Expressing them as additive deltas is what makes stacking
 *    two perks well-defined.
 *  - booleans combine with OR.
 */
export interface PerkEffects {
  movementSpeedMult?: number;
  adsSpeedMult?: number;
  reloadSpeedMult?: number;
  swapSpeedMult?: number;
  sprintOutMult?: number;
  healthRegenDelayMult?: number;
  healthRegenRateMult?: number;
  extraLethal?: number;
  extraTactical?: number;
  silentMovement?: boolean;
  hiddenFromUav?: boolean;
  flashImmune?: boolean;
  explosiveResistMult?: number;
  fallDamageImmune?: boolean;
  killstreakCostMult?: number;
  scavenger?: boolean;
  seeEnemyEquipment?: boolean;
  /** Seconds an enemy stays marked for your team after you kill someone. */
  markEnemiesOnKill?: number;
  extraArmor?: number;
  deadMansTrigger?: boolean;
  /** Additive fraction of extra objective capture rate. */
  fasterCapture?: number;
  /** Extra seconds of scope breath hold. */
  longerBreathHold?: number;
  /** Additive fraction of footstep volume removed. */
  quieterFootsteps?: number;
  extraKillstreakSlot?: boolean;
}

/** Dense effect set — every field present, so callers never branch on undefined. */
export type ResolvedPerkEffects = Required<PerkEffects>;

export interface PerkDef {
  id: string;
  name: string;
  tier: 1 | 2 | 3;
  description: string;
  /** Key into the HUD icon atlas. */
  icon: string;
  unlockLevel: number;
  effects: PerkEffects;
}

export const PERKS: Record<string, PerkDef> = {
  // -------------------------------------------------------------------------
  // Tier 1 — kit and mobility
  // -------------------------------------------------------------------------
  bandolier: {
    id: 'bandolier',
    name: 'Bandolier',
    tier: 1,
    description: 'Carry an extra lethal.',
    icon: 'perk_bandolier',
    unlockLevel: 0,
    effects: { extraLethal: 1 },
  },
  pouch_rig: {
    id: 'pouch_rig',
    name: 'Pouch Rig',
    tier: 1,
    description: 'Carry an extra tactical and hold your breath longer.',
    icon: 'perk_pouch_rig',
    unlockLevel: 4,
    effects: { extraTactical: 1, longerBreathHold: 1.5 },
  },
  soft_soles: {
    id: 'soft_soles',
    name: 'Soft Soles',
    tier: 1,
    description: 'Move without being heard.',
    icon: 'perk_soft_soles',
    unlockLevel: 7,
    effects: { silentMovement: true, quieterFootsteps: 0.5 },
  },
  salvager: {
    id: 'salvager',
    name: 'Salvager',
    tier: 1,
    description: 'Resupply ammunition from the fallen.',
    icon: 'perk_salvager',
    unlockLevel: 10,
    effects: { scavenger: true },
  },
  quick_hands: {
    id: 'quick_hands',
    name: 'Quick Hands',
    tier: 1,
    description: 'Reload and swap weapons noticeably faster.',
    icon: 'perk_quick_hands',
    unlockLevel: 12,
    effects: { reloadSpeedMult: 1.25, swapSpeedMult: 1.2 },
  },
  roadrunner: {
    id: 'roadrunner',
    name: 'Roadrunner',
    tier: 1,
    description: 'Move faster and get on target sooner out of a sprint.',
    icon: 'perk_roadrunner',
    unlockLevel: 15,
    effects: { movementSpeedMult: 1.07, sprintOutMult: 0.9 },
  },
  blast_liner: {
    id: 'blast_liner',
    name: 'Blast Liner',
    tier: 1,
    description: 'Take far less explosive damage and never break an ankle on a drop.',
    icon: 'perk_blast_liner',
    unlockLevel: 18,
    effects: { explosiveResistMult: 0.55, fallDamageImmune: true },
  },
  plate_carrier: {
    id: 'plate_carrier',
    name: 'Plate Carrier',
    tier: 1,
    description: 'Ceramic plates absorb the first hits. You pay for them in speed.',
    icon: 'perk_plate_carrier',
    unlockLevel: 21,
    effects: { extraArmor: 30, movementSpeedMult: 0.97 },
  },
  steady_lungs: {
    id: 'steady_lungs',
    name: 'Steady Lungs',
    tier: 1,
    description: 'Hold a scoped breath far longer.',
    icon: 'perk_steady_lungs',
    unlockLevel: 24,
    effects: { longerBreathHold: 3.5 },
  },

  // -------------------------------------------------------------------------
  // Tier 2 — information and survivability
  // -------------------------------------------------------------------------
  ghostwalk: {
    id: 'ghostwalk',
    name: 'Ghostwalk',
    tier: 2,
    description: 'Invisible to enemy radar sweeps.',
    icon: 'perk_ghostwalk',
    unlockLevel: 5,
    effects: { hiddenFromUav: true },
  },
  iron_lens: {
    id: 'iron_lens',
    name: 'Iron Lens',
    tier: 2,
    description: 'Immune to flash blindness.',
    icon: 'perk_iron_lens',
    unlockLevel: 8,
    effects: { flashImmune: true },
  },
  spotter: {
    id: 'spotter',
    name: 'Spotter',
    tier: 2,
    description: 'See enemy equipment and field upgrades through walls.',
    icon: 'perk_spotter',
    unlockLevel: 11,
    effects: { seeEnemyEquipment: true },
  },
  snap_aim: {
    id: 'snap_aim',
    name: 'Snap Aim',
    tier: 2,
    description: 'Come out of a sprint shooting and strafe faster while aimed.',
    icon: 'perk_snap_aim',
    unlockLevel: 14,
    effects: { adsSpeedMult: 1.2, sprintOutMult: 0.85 },
  },
  field_medic: {
    id: 'field_medic',
    name: 'Field Medic',
    tier: 2,
    description: 'Start healing sooner and heal faster.',
    icon: 'perk_field_medic',
    unlockLevel: 17,
    effects: { healthRegenDelayMult: 0.6, healthRegenRateMult: 1.4 },
  },
  hunter_mark: {
    id: 'hunter_mark',
    name: "Hunter's Mark",
    tier: 2,
    description: 'Killing someone paints nearby enemies for your team.',
    icon: 'perk_hunter_mark',
    unlockLevel: 20,
    effects: { markEnemiesOnKill: 4 },
  },
  logistics: {
    id: 'logistics',
    name: 'Logistics',
    tier: 2,
    description: 'Killstreaks cost fewer kills to earn.',
    icon: 'perk_logistics',
    unlockLevel: 23,
    effects: { killstreakCostMult: 0.85 },
  },
  flag_runner: {
    id: 'flag_runner',
    name: 'Flag Runner',
    tier: 2,
    description: 'Capture and arm objectives considerably faster.',
    icon: 'perk_flag_runner',
    unlockLevel: 26,
    effects: { fasterCapture: 0.3 },
  },
  low_profile: {
    id: 'low_profile',
    name: 'Low Profile',
    tier: 2,
    description: 'Quieter on your feet and quicker between cover.',
    icon: 'perk_low_profile',
    unlockLevel: 28,
    effects: { quieterFootsteps: 0.4, movementSpeedMult: 1.03 },
  },

  // -------------------------------------------------------------------------
  // Tier 3 — specialisations
  // -------------------------------------------------------------------------
  dead_hand: {
    id: 'dead_hand',
    name: 'Dead Hand',
    tier: 3,
    description: 'Drop a live grenade when you die, and carry one more.',
    icon: 'perk_dead_hand',
    unlockLevel: 6,
    effects: { deadMansTrigger: true, extraLethal: 1 },
  },
  command_link: {
    id: 'command_link',
    name: 'Command Link',
    tier: 3,
    description: 'Carry a fourth killstreak into the match.',
    icon: 'perk_command_link',
    unlockLevel: 9,
    effects: { extraKillstreakSlot: true },
  },
  quartermaster: {
    id: 'quartermaster',
    name: 'Quartermaster',
    tier: 3,
    description: 'Killstreaks are substantially cheaper.',
    icon: 'perk_quartermaster',
    unlockLevel: 12,
    effects: { killstreakCostMult: 0.75 },
  },
  combat_stim: {
    id: 'combat_stim',
    name: 'Combat Stim',
    tier: 3,
    description: 'Recover almost immediately after breaking contact.',
    icon: 'perk_combat_stim',
    unlockLevel: 15,
    effects: { healthRegenDelayMult: 0.45, healthRegenRateMult: 1.6 },
  },
  hardpoint: {
    id: 'hardpoint',
    name: 'Hardpoint',
    tier: 3,
    description: 'Own the objective: capture far faster and soak an extra hit doing it.',
    icon: 'perk_hardpoint',
    unlockLevel: 18,
    effects: { fasterCapture: 0.5, extraArmor: 15 },
  },
  predator: {
    id: 'predator',
    name: 'Predator',
    tier: 3,
    description: 'Kills mark enemies for longer, and you see their equipment.',
    icon: 'perk_predator',
    unlockLevel: 21,
    effects: { markEnemiesOnKill: 6, seeEnemyEquipment: true },
  },
  ghost_protocol: {
    id: 'ghost_protocol',
    name: 'Ghost Protocol',
    tier: 3,
    description: 'Off the radar and silent, at the price of a step of pace.',
    icon: 'perk_ghost_protocol',
    unlockLevel: 24,
    effects: { hiddenFromUav: true, silentMovement: true, movementSpeedMult: 0.98 },
  },
  demolitions: {
    id: 'demolitions',
    name: 'Demolitions',
    tier: 3,
    description: 'An extra lethal and tactical, plus a tolerance for blast.',
    icon: 'perk_demolitions',
    unlockLevel: 27,
    effects: { extraLethal: 1, extraTactical: 1, explosiveResistMult: 0.7 },
  },
  bulwark: {
    id: 'bulwark',
    name: 'Bulwark',
    tier: 3,
    description: 'Heavy plating that turns you into cover. Nothing about you is quick.',
    icon: 'perk_bulwark',
    unlockLevel: 30,
    effects: { extraArmor: 60, movementSpeedMult: 0.9, adsSpeedMult: 0.92 },
  },
};

export function getPerk(id: string): PerkDef {
  const def = PERKS[id];
  if (!def) throw new Error(`Unknown perk: ${id}`);
  return def;
}

/** Perks selectable in a tier, ordered by unlock so the menu reads as progression. */
export function perksForTier(tier: 1 | 2 | 3): PerkDef[] {
  return Object.values(PERKS)
    .filter((p) => p.tier === tier)
    .sort((a, b) => a.unlockLevel - b.unlockLevel || a.id.localeCompare(b.id));
}

function neutralEffects(): ResolvedPerkEffects {
  return {
    movementSpeedMult: 1,
    adsSpeedMult: 1,
    reloadSpeedMult: 1,
    swapSpeedMult: 1,
    sprintOutMult: 1,
    healthRegenDelayMult: 1,
    healthRegenRateMult: 1,
    explosiveResistMult: 1,
    killstreakCostMult: 1,
    extraLethal: 0,
    extraTactical: 0,
    markEnemiesOnKill: 0,
    extraArmor: 0,
    fasterCapture: 0,
    longerBreathHold: 0,
    quieterFootsteps: 0,
    silentMovement: false,
    hiddenFromUav: false,
    flashImmune: false,
    fallDamageImmune: false,
    scavenger: false,
    seeEnemyEquipment: false,
    deadMansTrigger: false,
    extraKillstreakSlot: false,
  };
}

/**
 * Collapses a perk selection into one dense effect set.
 *
 * Unknown ids are skipped rather than thrown on: a loadout can outlive a perk
 * being renamed, and a stale saved loadout must not crash a spawn.
 */
export function combinePerkEffects(perkIds: readonly string[]): ResolvedPerkEffects {
  const out = neutralEffects();

  for (const id of perkIds) {
    const perk = PERKS[id];
    if (!perk) continue;
    const e = perk.effects;

    out.movementSpeedMult *= e.movementSpeedMult ?? 1;
    out.adsSpeedMult *= e.adsSpeedMult ?? 1;
    out.reloadSpeedMult *= e.reloadSpeedMult ?? 1;
    out.swapSpeedMult *= e.swapSpeedMult ?? 1;
    out.sprintOutMult *= e.sprintOutMult ?? 1;
    out.healthRegenDelayMult *= e.healthRegenDelayMult ?? 1;
    out.healthRegenRateMult *= e.healthRegenRateMult ?? 1;
    out.explosiveResistMult *= e.explosiveResistMult ?? 1;
    out.killstreakCostMult *= e.killstreakCostMult ?? 1;

    out.extraLethal += e.extraLethal ?? 0;
    out.extraTactical += e.extraTactical ?? 0;
    out.markEnemiesOnKill += e.markEnemiesOnKill ?? 0;
    out.extraArmor += e.extraArmor ?? 0;
    out.fasterCapture += e.fasterCapture ?? 0;
    out.longerBreathHold += e.longerBreathHold ?? 0;
    out.quieterFootsteps += e.quieterFootsteps ?? 0;

    out.silentMovement = out.silentMovement || (e.silentMovement ?? false);
    out.hiddenFromUav = out.hiddenFromUav || (e.hiddenFromUav ?? false);
    out.flashImmune = out.flashImmune || (e.flashImmune ?? false);
    out.fallDamageImmune = out.fallDamageImmune || (e.fallDamageImmune ?? false);
    out.scavenger = out.scavenger || (e.scavenger ?? false);
    out.seeEnemyEquipment = out.seeEnemyEquipment || (e.seeEnemyEquipment ?? false);
    out.deadMansTrigger = out.deadMansTrigger || (e.deadMansTrigger ?? false);
    out.extraKillstreakSlot = out.extraKillstreakSlot || (e.extraKillstreakSlot ?? false);
  }

  return out;
}
