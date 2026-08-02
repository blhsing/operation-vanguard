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
    name: '彈帶',
    tier: 1,
    description: '多攜帶一件致命裝備。',
    icon: 'perk_bandolier',
    unlockLevel: 0,
    effects: { extraLethal: 1 },
  },
  pouch_rig: {
    id: 'pouch_rig',
    name: '攜行具',
    tier: 1,
    description: '多攜帶一件戰術裝備，屏息時間更長。',
    icon: 'perk_pouch_rig',
    unlockLevel: 4,
    effects: { extraTactical: 1, longerBreathHold: 1.5 },
  },
  soft_soles: {
    id: 'soft_soles',
    name: '軟底靴',
    tier: 1,
    description: '移動不發出任何聲響。',
    icon: 'perk_soft_soles',
    unlockLevel: 7,
    effects: { silentMovement: true, quieterFootsteps: 0.5 },
  },
  salvager: {
    id: 'salvager',
    name: '拾荒者',
    tier: 1,
    description: '從陣亡者身上補充彈藥。',
    icon: 'perk_salvager',
    unlockLevel: 10,
    effects: { scavenger: true },
  },
  quick_hands: {
    id: 'quick_hands',
    name: '快手',
    tier: 1,
    description: '裝填與換槍明顯更快。',
    icon: 'perk_quick_hands',
    unlockLevel: 12,
    effects: { reloadSpeedMult: 1.25, swapSpeedMult: 1.2 },
  },
  roadrunner: {
    id: 'roadrunner',
    name: '疾行',
    tier: 1,
    description: '移動更快，衝刺後更快進入瞄準。',
    icon: 'perk_roadrunner',
    unlockLevel: 15,
    effects: { movementSpeedMult: 1.07, sprintOutMult: 0.9 },
  },
  blast_liner: {
    id: 'blast_liner',
    name: '防爆襯層',
    tier: 1,
    description: '爆炸傷害大幅減免，落地也不會摔斷腳踝。',
    icon: 'perk_blast_liner',
    unlockLevel: 18,
    effects: { explosiveResistMult: 0.55, fallDamageImmune: true },
  },
  plate_carrier: {
    id: 'plate_carrier',
    name: '護板背心',
    tier: 1,
    description: '陶瓷護板替你吸收最初幾發。代價是速度。',
    icon: 'perk_plate_carrier',
    unlockLevel: 21,
    effects: { extraArmor: 30, movementSpeedMult: 0.97 },
  },
  steady_lungs: {
    id: 'steady_lungs',
    name: '穩息',
    tier: 1,
    description: '瞄準鏡下的屏息時間大幅延長。',
    icon: 'perk_steady_lungs',
    unlockLevel: 24,
    effects: { longerBreathHold: 3.5 },
  },

  // -------------------------------------------------------------------------
  // Tier 2 — information and survivability
  // -------------------------------------------------------------------------
  ghostwalk: {
    id: 'ghostwalk',
    name: '幽行',
    tier: 2,
    description: '敵方雷達掃描看不見你。',
    icon: 'perk_ghostwalk',
    unlockLevel: 5,
    effects: { hiddenFromUav: true },
  },
  iron_lens: {
    id: 'iron_lens',
    name: '鐵瞳',
    tier: 2,
    description: '免疫閃光致盲。',
    icon: 'perk_iron_lens',
    unlockLevel: 8,
    effects: { flashImmune: true },
  },
  spotter: {
    id: 'spotter',
    name: '觀測手',
    tier: 2,
    description: '穿牆看見敵方裝備與戰地升級。',
    icon: 'perk_spotter',
    unlockLevel: 11,
    effects: { seeEnemyEquipment: true },
  },
  snap_aim: {
    id: 'snap_aim',
    name: '速瞄',
    tier: 2,
    description: '衝刺後能立刻開火，瞄準時橫移也更快。',
    icon: 'perk_snap_aim',
    unlockLevel: 14,
    effects: { adsSpeedMult: 1.2, sprintOutMult: 0.85 },
  },
  field_medic: {
    id: 'field_medic',
    name: '戰地醫護',
    tier: 2,
    description: '更早開始回血，回血也更快。',
    icon: 'perk_field_medic',
    unlockLevel: 17,
    effects: { healthRegenDelayMult: 0.6, healthRegenRateMult: 1.4 },
  },
  hunter_mark: {
    id: 'hunter_mark',
    name: "獵人印記",
    tier: 2,
    description: '擊殺敵人時，為隊友標記附近的敵人。',
    icon: 'perk_hunter_mark',
    unlockLevel: 20,
    effects: { markEnemiesOnKill: 4 },
  },
  logistics: {
    id: 'logistics',
    name: '後勤',
    tier: 2,
    description: '連殺獎勵所需的擊殺數變少。',
    icon: 'perk_logistics',
    unlockLevel: 23,
    effects: { killstreakCostMult: 0.85 },
  },
  flag_runner: {
    id: 'flag_runner',
    name: '奪旗手',
    tier: 2,
    description: '佔領與安裝目標明顯更快。',
    icon: 'perk_flag_runner',
    unlockLevel: 26,
    effects: { fasterCapture: 0.3 },
  },
  low_profile: {
    id: 'low_profile',
    name: '低調',
    tier: 2,
    description: '腳步更輕，掩體之間移動更快。',
    icon: 'perk_low_profile',
    unlockLevel: 28,
    effects: { quieterFootsteps: 0.4, movementSpeedMult: 1.03 },
  },

  // -------------------------------------------------------------------------
  // Tier 3 — specialisations
  // -------------------------------------------------------------------------
  dead_hand: {
    id: 'dead_hand',
    name: '死手',
    tier: 3,
    description: '陣亡時掉落一顆已解保險的手榴彈，並多帶一顆。',
    icon: 'perk_dead_hand',
    unlockLevel: 6,
    effects: { deadMansTrigger: true, extraLethal: 1 },
  },
  command_link: {
    id: 'command_link',
    name: '指揮鏈路',
    tier: 3,
    description: '可帶第四個連殺獎勵進場。',
    icon: 'perk_command_link',
    unlockLevel: 9,
    effects: { extraKillstreakSlot: true },
  },
  quartermaster: {
    id: 'quartermaster',
    name: '軍需官',
    tier: 3,
    description: '連殺獎勵所需的擊殺數大幅降低。',
    icon: 'perk_quartermaster',
    unlockLevel: 12,
    effects: { killstreakCostMult: 0.75 },
  },
  combat_stim: {
    id: 'combat_stim',
    name: '戰鬥興奮劑',
    tier: 3,
    description: '脫離接戰後幾乎立刻恢復。',
    icon: 'perk_combat_stim',
    unlockLevel: 15,
    effects: { healthRegenDelayMult: 0.45, healthRegenRateMult: 1.6 },
  },
  hardpoint: {
    id: 'hardpoint',
    name: '要塞',
    tier: 3,
    description: '掌控目標：佔領速度快得多，過程中還能多扛一發。',
    icon: 'perk_hardpoint',
    unlockLevel: 18,
    effects: { fasterCapture: 0.5, extraArmor: 15 },
  },
  predator: {
    id: 'predator',
    name: '掠食者',
    tier: 3,
    description: '擊殺標記敵人的時間更長，也看得見他們的裝備。',
    icon: 'perk_predator',
    unlockLevel: 21,
    effects: { markEnemiesOnKill: 6, seeEnemyEquipment: true },
  },
  ghost_protocol: {
    id: 'ghost_protocol',
    name: '幽靈協定',
    tier: 3,
    description: '雷達上消失且行動無聲，代價是慢上半拍。',
    icon: 'perk_ghost_protocol',
    unlockLevel: 24,
    effects: { hiddenFromUav: true, silentMovement: true, movementSpeedMult: 0.98 },
  },
  demolitions: {
    id: 'demolitions',
    name: '爆破',
    tier: 3,
    description: '多一件致命與戰術裝備，外加對爆炸的耐受。',
    icon: 'perk_demolitions',
    unlockLevel: 27,
    effects: { extraLethal: 1, extraTactical: 1, explosiveResistMult: 0.7 },
  },
  bulwark: {
    id: 'bulwark',
    name: '壁壘',
    tier: 3,
    description: '重型護板讓你自成掩體。你身上沒有一處是快的。',
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
