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
    name: '消焰器',
    slot: AttachmentSlot.Muzzle,
    description: '向側面排氣，消除連發中晃瞎自己的槍口火光。',
    classes: ALL_CLASSES,
    mods: { recoilPitch: 0.94, drawTime: 1.04, damageRangeScale: 0.97 },
    unlockLevel: 1,
    pros: ['垂直後座力降低', '槍口火光不再糊住自己的視線'],
    cons: ['舉槍速度較慢', '傷害射程微幅縮短'],
  },
  muzzle_compensator: {
    id: 'muzzle_compensator',
    name: '補償器',
    slot: AttachmentSlot.Muzzle,
    description: '頂部開孔，壓制水平飄移，代價是腰射散佈變大。',
    classes: ALL_CLASSES,
    mods: { recoilYaw: 0.78, recoilPitch: 0.92, hipSpread: 1.08, adsTime: 1.03 },
    unlockLevel: 5,
    pros: ['水平後座力大幅收斂', '垂直後座力略微降低'],
    cons: ['腰射散佈變大', '瞄準速度較慢'],
  },
  muzzle_brake: {
    id: 'muzzle_brake',
    name: '槍口制退器',
    slot: AttachmentSlot.Muzzle,
    description: '側向大開孔壓平上跳，但把槍甩向側邊。',
    classes: ALL_CLASSES,
    mods: { recoilPitch: 0.82, recoilYaw: 1.12, hipSpread: 1.1 },
    unlockLevel: 8,
    pros: ['垂直後座力顯著降低'],
    cons: ['水平後座力變差', '腰射散佈變大'],
  },
  muzzle_choke: {
    id: 'muzzle_choke',
    name: '霰彈槍縮口',
    slot: AttachmentSlot.Muzzle,
    description: '把彈丸擴散收攏成近似獨頭彈的一束。',
    classes: [WeaponClass.Shotgun],
    mods: { hipSpread: 0.72, adsSpread: 0.7, adsTime: 1.15, drawTime: 1.08 },
    unlockLevel: 6,
    pros: ['彈丸散佈大幅收攏'],
    cons: ['瞄準速度慢很多', '舉槍速度較慢'],
  },
  muzzle_suppressor: {
    id: 'muzzle_suppressor',
    name: '消音器',
    slot: AttachmentSlot.Muzzle,
    description: '讓你不出現在小地圖上。洩掉膛壓，射程也跟著洩掉。',
    classes: ALL_CLASSES,
    mods: {
      suppressed: true,
      hidesMinimapDot: true,
      damageRangeScale: 0.9,
      adsTime: 1.05,
      muzzleVelocity: 0.95,
    },
    unlockLevel: 3,
    pros: ['消音', '開火時不顯示小地圖光點'],
    cons: ['傷害射程縮短', '瞄準速度較慢', '槍口初速降低'],
  },
  muzzle_monolithic_suppressor: {
    id: 'muzzle_monolithic_suppressor',
    name: '整體式消音器',
    slot: AttachmentSlot.Muzzle,
    description: '全長筒身兼作槍管延長——安靜，而且打得更遠。',
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
    pros: ['消音', '開火時不顯示小地圖光點', '傷害射程延長'],
    cons: ['瞄準速度慢很多', '舉槍速度較慢', '移動速度較慢'],
  },
  muzzle_light_suppressor: {
    id: 'muzzle_light_suppressor',
    name: '輕量消音器',
    slot: AttachmentSlot.Muzzle,
    description: '為進攻調校的鈦合金筒身：操控性保住了，彈道付出代價。',
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
    pros: ['消音', '開火時不顯示小地圖光點', '瞄準速度更快'],
    cons: ['傷害射程大幅縮減', '槍口初速偏低', '衝刺後開火較慢'],
  },

  // -------------------------------------------------------------------------
  // Barrel
  // -------------------------------------------------------------------------
  barrel_long_heavy: {
    id: 'barrel_long_heavy',
    name: '加長重型槍管',
    slot: AttachmentSlot.Barrel,
    description: '多一公分膛線就多一分初速，操控性照付。',
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
    pros: ['傷害射程大幅延長', '槍口初速大幅提高'],
    cons: ['瞄準速度較慢', '移動速度較慢', '瞄準晃動增加'],
  },
  barrel_short_cqb: {
    id: 'barrel_short_cqb',
    name: 'CQB短管',
    slot: AttachmentSlot.Barrel,
    description: '為走廊近戰砍到剩導氣座。',
    classes: ALL_CLASSES,
    mods: {
      adsTime: 0.88,
      movementSpeed: 1.04,
      hipSpread: 0.9,
      damageRangeScale: 0.85,
      recoilPitch: 1.12,
    },
    unlockLevel: 4,
    pros: ['瞄準速度更快', '移動速度更快', '腰射更集中'],
    cons: ['傷害射程大幅縮短', '垂直後座力增加'],
  },
  barrel_reinforced: {
    id: 'barrel_reinforced',
    name: '強化重型槍管',
    slot: AttachmentSlot.Barrel,
    description: '厚壁鍍鉻內膛；子彈穿過掩體仍保有動能。',
    classes: ALL_CLASSES,
    mods: {
      penetration: 1.35,
      damageRangeScale: 1.08,
      adsTime: 1.1,
      sprintOutTime: 1.08,
      movementSpeed: 0.96,
    },
    unlockLevel: 15,
    pros: ['穿牆能力遠勝以往', '傷害射程延長'],
    cons: ['瞄準速度較慢', '衝刺後開火較慢', '移動速度較慢'],
  },
  barrel_fluted: {
    id: 'barrel_fluted',
    name: '開槽槍管',
    slot: AttachmentSlot.Barrel,
    description: '車出來的凹槽削掉了前端重量。',
    classes: ALL_CLASSES,
    mods: { adsTime: 0.94, drawTime: 0.9, recoilPitch: 1.08, damageRangeScale: 0.95 },
    unlockLevel: 11,
    pros: ['瞄準速度更快', '舉槍速度更快'],
    cons: ['垂直後座力增加', '傷害射程略微縮短'],
  },
  barrel_ported: {
    id: 'barrel_ported',
    name: '開孔槍管',
    slot: AttachmentSlot.Barrel,
    description: '槍口前方的洩氣孔卸掉膛壓，把槍壓穩。',
    classes: ALL_CLASSES,
    mods: { recoilPitch: 0.88, recoilYaw: 0.9, damageRangeScale: 0.92, hipSpread: 1.06 },
    unlockLevel: 7,
    pros: ['雙軸後座力降低'],
    cons: ['傷害射程縮短', '腰射散佈變大'],
  },
  barrel_marksman: {
    id: 'barrel_marksman',
    name: '神射手槍管',
    slot: AttachmentSlot.Barrel,
    description: '競賽級管身，給願意慢慢來的人。',
    classes: ALL_CLASSES,
    mods: {
      adsSpread: 0.8,
      swayAmount: 0.85,
      damageRangeScale: 1.12,
      adsTime: 1.15,
      movementSpeed: 0.94,
    },
    unlockLevel: 18,
    pros: ['瞄準精準度大幅提升', '瞄準晃動減少', '傷害射程延長'],
    cons: ['瞄準速度慢很多', '移動速度較慢'],
  },
  barrel_lancer: {
    id: 'barrel_lancer',
    name: '騎兵長槍槍管',
    slot: AttachmentSlot.Barrel,
    description: '為邊跑邊打削到極簡；精準度不是重點。',
    classes: [WeaponClass.SubmachineGun, WeaponClass.Shotgun],
    mods: { movementSpeed: 1.06, sprintOutTime: 0.85, damageRangeScale: 0.8, adsSpread: 1.2 },
    unlockLevel: 22,
    pros: ['移動速度更快', '衝刺後開火快很多'],
    cons: ['傷害射程大幅縮減', '瞄準精準度大幅變差'],
  },

  // -------------------------------------------------------------------------
  // Optic
  // -------------------------------------------------------------------------
  optic_reflex_micro: {
    id: 'optic_reflex_micro',
    name: '微型反射瞄具',
    slot: AttachmentSlot.Optic,
    description: '能越過機械瞄具的最小光點。',
    classes: ALL_CLASSES,
    mods: { swayAmount: 0.97, adsZoomAdd: 0.05, adsTime: 1.02 },
    unlockLevel: 2,
    pros: ['視野乾淨', '晃動略微減少'],
    cons: ['瞄準速度微幅變慢'],
  },
  optic_red_dot: {
    id: 'optic_red_dot',
    name: '紅點瞄準鏡',
    slot: AttachmentSlot.Optic,
    description: '制式紅點。精準、單純，就是有點笨重。',
    classes: ALL_CLASSES,
    mods: { adsSpread: 0.95, adsZoomAdd: 0.1, adsTime: 1.04 },
    unlockLevel: 4,
    pros: ['瞄準精準度提升', '準星簡潔不擋視線'],
    cons: ['瞄準速度較慢'],
  },
  optic_holographic: {
    id: 'optic_holographic',
    name: '全像瞄準鏡',
    slot: AttachmentSlot.Optic,
    description: '大視窗、環形準星，還有一個掛在導軌上感覺得到的殼。',
    classes: ALL_CLASSES,
    mods: { swayAmount: 0.95, adsZoomAdd: 0.15, adsTime: 1.06, hipSpread: 1.05 },
    unlockLevel: 8,
    pros: ['視野寬廣', '瞄準晃動減少'],
    cons: ['瞄準速度較慢', '腰射散佈變大'],
  },
  optic_offset_canted: {
    id: 'optic_offset_canted',
    name: '側傾偏置瞄具',
    slot: AttachmentSlot.Optic,
    description: '側轉45度就能接上的光點——快，但放棄了精細準星。',
    classes: ALL_CLASSES,
    mods: { adsTime: 0.96, adsZoomAdd: -0.1, adsSpread: 1.08, hipSpread: 1.04 },
    unlockLevel: 14,
    pros: ['瞄準速度更快', '周邊視野更廣'],
    cons: ['瞄準精準度變差', '放大倍率降低', '腰射略微變大'],
  },
  optic_scope_3x: {
    id: 'optic_scope_3x',
    name: '3x戰鬥瞄準鏡',
    slot: AttachmentSlot.Optic,
    description: '帶人字準星的中距離鏡片；第一款近距離會反咬你的瞄具。',
    classes: ALL_CLASSES,
    mods: { adsZoomAdd: 0.6, adsSpread: 0.9, adsTime: 1.12, hipSpread: 1.15, movementSpeed: 0.98 },
    unlockLevel: 13,
    pros: ['倍率充足', '瞄準精準度提升'],
    cons: ['瞄準速度較慢', '腰射散佈大幅變大', '移動速度較慢'],
  },
  optic_scope_4x: {
    id: 'optic_scope_4x',
    name: '4x戰術瞄準鏡',
    slot: AttachmentSlot.Optic,
    description: '用來鎖線的長焦鏡片。你的麻煩會從後座力變成晃動。',
    classes: ALL_CLASSES,
    mods: { adsZoomAdd: 1.0, adsSpread: 0.85, adsTime: 1.18, swayAmount: 1.2, hipSpread: 1.2 },
    unlockLevel: 17,
    pros: ['高倍率', '瞄準精準度大幅提升'],
    cons: ['瞄準速度慢很多', '瞄準晃動增加', '腰射散佈大幅變大'],
  },
  optic_thermal: {
    id: 'optic_thermal',
    name: '熱像複合瞄具',
    slot: AttachmentSlot.Optic,
    description: '隔著煙霧把人體標成白色。開機慢，也重。',
    classes: ALL_CLASSES,
    mods: { adsZoomAdd: 0.5, adsSpread: 0.88, adsTime: 1.22, drawTime: 1.15, hipSpread: 1.1 },
    unlockLevel: 24,
    pros: ['隔著煙霧標示目標', '瞄準精準度提升'],
    cons: ['瞄準速度極慢', '舉槍速度慢', '腰射散佈變大'],
  },
  optic_variable_sniper: {
    id: 'optic_variable_sniper',
    name: '可變倍狙擊鏡',
    slot: AttachmentSlot.Optic,
    description: '把倍率轉到底，用在多數玩家從不嘗試的一槍。',
    classes: [WeaponClass.SniperRifle, WeaponClass.MarksmanRifle],
    mods: { adsZoomAdd: 2.0, adsSpread: 0.7, adsTime: 1.25, swayAmount: 1.25, movementSpeed: 0.96 },
    unlockLevel: 26,
    pros: ['極高倍率', '瞄準精準度近乎完美'],
    cons: ['瞄準速度極慢', '鏡體晃動嚴重', '移動速度較慢'],
  },

  // -------------------------------------------------------------------------
  // Underbarrel
  // -------------------------------------------------------------------------
  under_vertical_grip: {
    id: 'under_vertical_grip',
    name: '垂直前握把',
    slot: AttachmentSlot.Underbarrel,
    description: '持續射擊時把槍口往下壓。',
    classes: ALL_CLASSES,
    mods: { recoilPitch: 0.85, adsTime: 1.06, movementSpeed: 0.98 },
    unlockLevel: 3,
    pros: ['垂直後座力顯著降低'],
    cons: ['瞄準速度較慢', '移動速度較慢'],
  },
  under_angled_grip: {
    id: 'under_angled_grip',
    name: '傾斜前握把',
    slot: AttachmentSlot.Underbarrel,
    description: '手腕前傾，衝刺結束後舉槍更快。',
    classes: ALL_CLASSES,
    mods: { adsTime: 0.9, sprintOutTime: 0.88, recoilPitch: 1.08, hipSpread: 1.05 },
    unlockLevel: 6,
    pros: ['瞄準速度更快', '衝刺後開火更快'],
    cons: ['垂直後座力增加', '腰射散佈變大'],
  },
  under_bipod: {
    id: 'under_bipod',
    name: '摺疊腳架',
    slot: AttachmentSlot.Underbarrel,
    description: '前端配重殺掉後座與晃動；順便殺掉你的腳程。',
    classes: ALL_CLASSES,
    mods: { recoilPitch: 0.8, swayAmount: 0.8, movementSpeed: 0.94, adsTime: 1.08 },
    unlockLevel: 10,
    pros: ['垂直後座力大幅降低', '瞄準晃動明顯減少'],
    cons: ['移動速度慢很多', '瞄準速度較慢'],
  },
  under_ranger_grip: {
    id: 'under_ranger_grip',
    name: '遊騎兵護木',
    slot: AttachmentSlot.Underbarrel,
    description: '為腰射而生，後果自負。',
    classes: ALL_CLASSES,
    mods: { hipSpread: 0.82, adsSpread: 1.12, adsTime: 1.05 },
    unlockLevel: 12,
    pros: ['腰射散佈大幅收攏'],
    cons: ['瞄準精準度變差', '瞄準速度較慢'],
  },
  under_handstop: {
    id: 'under_handstop',
    name: '聚合物手擋',
    slot: AttachmentSlot.Underbarrel,
    description: '一個拇指擋塊，沒別的。機動優先。',
    classes: ALL_CLASSES,
    mods: { sprintOutTime: 0.85, movementSpeed: 1.03, recoilYaw: 1.1, hipSpread: 1.06 },
    unlockLevel: 8,
    pros: ['衝刺後開火快很多', '移動速度更快'],
    cons: ['水平後座力增加', '腰射散佈變大'],
  },
  under_damped_grip: {
    id: 'under_damped_grip',
    name: '阻尼前握把',
    slot: AttachmentSlot.Underbarrel,
    description: '鎢芯握把，吸收雙軸的後座衝擊。',
    classes: ALL_CLASSES,
    mods: { recoilPitch: 0.88, recoilYaw: 0.88, adsTime: 1.1, drawTime: 1.08, movementSpeed: 0.97 },
    unlockLevel: 16,
    pros: ['雙軸後座力降低'],
    cons: ['瞄準速度較慢', '舉槍速度較慢', '移動速度較慢'],
  },
  under_grenade_launcher: {
    id: 'under_grenade_launcher',
    name: '40mm榴彈發射器',
    slot: AttachmentSlot.Underbarrel,
    description: '護木下掛一發40mm榴彈。其餘一切都變慢。',
    classes: [WeaponClass.AssaultRifle, WeaponClass.LightMachineGun],
    mods: {
      recoilPitch: 0.95,
      adsTime: 1.15,
      movementSpeed: 0.93,
      drawTime: 1.12,
      sprintOutTime: 1.1,
    },
    unlockLevel: 21,
    pros: ['槍管下掛爆裂彈', '額外配重穩住槍口'],
    cons: ['瞄準速度慢很多', '移動速度慢很多', '舉槍遲鈍'],
  },

  // -------------------------------------------------------------------------
  // Magazine
  // -------------------------------------------------------------------------
  mag_extended: {
    id: 'mag_extended',
    name: '加長彈匣',
    slot: AttachmentSlot.Magazine,
    description: '多十發，才需要開始想換彈匣的事。',
    classes: ALL_CLASSES,
    mods: { magSizeAdd: 10, reloadTime: 1.08, adsTime: 1.04, movementSpeed: 0.99 },
    unlockLevel: 2,
    pros: ['+10發'],
    cons: ['裝填較慢', '瞄準速度較慢'],
  },
  mag_extended_large: {
    id: 'mag_extended_large',
    name: '高容量彈匣',
    slot: AttachmentSlot.Magazine,
    description: '多掛三十發的重量。',
    classes: ALL_CLASSES,
    mods: { magSizeAdd: 30, reloadTime: 1.25, adsTime: 1.12, movementSpeed: 0.96, sprintOutTime: 1.08 },
    unlockLevel: 9,
    pros: ['+30發'],
    cons: ['裝填慢很多', '瞄準速度較慢', '移動速度較慢'],
  },
  mag_drum: {
    id: 'mag_drum',
    name: '彈鼓',
    slot: AttachmentSlot.Magazine,
    description: '多六十發。你哪裡都衝刺不了。',
    classes: ALL_CLASSES,
    mods: { magSizeAdd: 60, reloadTime: 1.45, adsTime: 1.2, movementSpeed: 0.92, drawTime: 1.2 },
    unlockLevel: 18,
    pros: ['+60發'],
    cons: ['裝填極慢', '瞄準速度極慢', '移動速度慢很多'],
  },
  mag_taped: {
    id: 'mag_taped',
    name: '併聯彈匣',
    slot: AttachmentSlot.Magazine,
    description: '兩個彈匣用膠帶綁在一起——全遊戲最快的裝填。',
    classes: ALL_CLASSES,
    mods: { reloadTime: 0.72, magSizeAdd: -2, adsTime: 1.05 },
    unlockLevel: 5,
    pros: ['裝填速度大幅提升'],
    cons: ['-2發', '瞄準速度較慢'],
  },
  mag_lightweight: {
    id: 'mag_lightweight',
    name: '輕量彈匣',
    slot: AttachmentSlot.Magazine,
    description: '短版聚合物彈匣，什麼都不擋。',
    classes: ALL_CLASSES,
    mods: { adsTime: 0.94, movementSpeed: 1.03, reloadTime: 0.92, magSizeAdd: -5 },
    unlockLevel: 7,
    pros: ['瞄準速度更快', '移動速度更快', '裝填更快'],
    cons: ['-5發'],
  },
  mag_armor_piercing: {
    id: 'mag_armor_piercing',
    name: '穿甲彈',
    slot: AttachmentSlot.Magazine,
    description: '硬化彈芯，合板對它只是有點礙事。',
    classes: ALL_CLASSES,
    mods: {
      penetration: 1.6,
      damageRangeScale: 1.05,
      reloadTime: 1.1,
      muzzleVelocity: 0.95,
      magSizeAdd: -4,
    },
    unlockLevel: 14,
    pros: ['穿牆能力大幅提升', '傷害射程略微延長'],
    cons: ['-4發', '裝填較慢', '槍口初速降低'],
  },
  mag_subsonic: {
    id: 'mag_subsonic',
    name: '次音速彈',
    slot: AttachmentSlot.Magazine,
    description: '沒有音爆聲，小地圖上就沒有光點——射程也一起沒了。',
    classes: ALL_CLASSES,
    mods: { hidesMinimapDot: true, recoilPitch: 0.95, muzzleVelocity: 0.7, damageRangeScale: 0.85 },
    unlockLevel: 20,
    pros: ['開火時不顯示小地圖光點', '後座力略微變軟'],
    cons: ['槍口初速大幅降低', '傷害射程縮減'],
  },
  mag_overpressured: {
    id: 'mag_overpressured',
    name: '超壓彈',
    slot: AttachmentSlot.Magazine,
    description: '高裝藥，打得更遠，順便想把你的手腕一起帶走。',
    classes: ALL_CLASSES,
    mods: {
      muzzleVelocity: 1.3,
      damageRangeScale: 1.18,
      recoilPitch: 1.2,
      recoilYaw: 1.15,
      magSizeAdd: -4,
    },
    unlockLevel: 25,
    pros: ['槍口初速大幅提高', '傷害射程延長'],
    cons: ['-4發', '雙軸後座力大增'],
  },

  // -------------------------------------------------------------------------
  // Stock
  // -------------------------------------------------------------------------
  stock_heavy: {
    id: 'stock_heavy',
    name: '重型槍托',
    slot: AttachmentSlot.Stock,
    description: '抵肩像架在射擊台上，移動起來也像。',
    classes: ALL_CLASSES,
    mods: { recoilPitch: 0.85, swayAmount: 0.8, adsTime: 1.1, movementSpeed: 0.95, sprintOutTime: 1.1 },
    unlockLevel: 5,
    pros: ['垂直後座力顯著降低', '瞄準晃動明顯減少'],
    cons: ['瞄準速度較慢', '移動速度較慢', '衝刺後開火較慢'],
  },
  stock_skeleton: {
    id: 'stock_skeleton',
    name: '骨架槍托',
    slot: AttachmentSlot.Stock,
    description: '銑到只剩下貼腮的部分。',
    classes: ALL_CLASSES,
    mods: { adsTime: 0.9, movementSpeed: 1.05, sprintOutTime: 0.9, recoilPitch: 1.15, adsSpread: 1.08 },
    unlockLevel: 3,
    pros: ['瞄準速度更快', '移動速度更快', '衝刺後開火更快'],
    cons: ['垂直後座力增加', '瞄準精準度變差'],
  },
  stock_none: {
    id: 'stock_none',
    name: '無槍托',
    slot: AttachmentSlot.Stock,
    description: '完全沒有槍托。純粹進攻，零穩定性。',
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
    pros: ['瞄準速度快很多', '移動速度快很多', '衝刺後幾乎立即開火'],
    cons: ['雙軸後座力極大', '瞄準精準度低落', '瞄準晃動嚴重'],
  },
  stock_collapsible: {
    id: 'stock_collapsible',
    name: '伸縮槍托',
    slot: AttachmentSlot.Stock,
    description: '折衷的伸縮槍托，給下不了決心的人。',
    classes: ALL_CLASSES,
    mods: { movementSpeed: 1.03, adsTime: 0.95, recoilYaw: 1.08, swayAmount: 1.06 },
    unlockLevel: 6,
    pros: ['移動速度更快', '瞄準速度更快'],
    cons: ['水平後座力增加', '瞄準晃動增加'],
  },
  stock_precision: {
    id: 'stock_precision',
    name: '精準槍托',
    slot: AttachmentSlot.Stock,
    description: '可調托背與貼腮墊；整支就為了把準星定住。',
    classes: ALL_CLASSES,
    mods: { swayAmount: 0.7, adsSpread: 0.88, adsTime: 1.08, movementSpeed: 0.96, drawTime: 1.05 },
    unlockLevel: 15,
    pros: ['瞄準晃動大幅減少', '瞄準精準度提升'],
    cons: ['瞄準速度較慢', '移動速度較慢', '舉槍速度較慢'],
  },
  stock_padded: {
    id: 'stock_padded',
    name: '緩衝墊槍托',
    slot: AttachmentSlot.Stock,
    description: '厚橡膠墊，吃掉各個方向的衝量。',
    classes: ALL_CLASSES,
    mods: { recoilPitch: 0.9, recoilYaw: 0.9, movementSpeed: 0.97, adsTime: 1.05 },
    unlockLevel: 9,
    pros: ['雙軸後座力降低'],
    cons: ['移動速度較慢', '瞄準速度較慢'],
  },
  stock_brace: {
    id: 'stock_brace',
    name: '輔助瞄準支架',
    slot: AttachmentSlot.Stock,
    description: '靠背帶張力繃緊的支架，讓你瞄準時還能繼續走。',
    classes: ALL_CLASSES,
    mods: { adsSpeed: 1.15, swayAmount: 0.9, adsTime: 1.06, sprintOutTime: 1.05 },
    unlockLevel: 19,
    pros: ['瞄準時移動快很多', '瞄準晃動減少'],
    cons: ['瞄準速度較慢', '衝刺後開火較慢'],
  },

  // -------------------------------------------------------------------------
  // Rear grip
  // -------------------------------------------------------------------------
  grip_rubberized: {
    id: 'grip_rubberized',
    name: '橡膠握把',
    slot: AttachmentSlot.RearGrip,
    description: '軟質包膠，吸掉每次連發的第一槍。',
    classes: ALL_CLASSES,
    mods: { recoilPitch: 0.9, adsTime: 1.05 },
    unlockLevel: 2,
    pros: ['垂直後座力降低'],
    cons: ['瞄準速度較慢'],
  },
  grip_stippled: {
    id: 'grip_stippled',
    name: '顆粒握把膠帶',
    slot: AttachmentSlot.RearGrip,
    description: '粗糙膠帶，甩槍上目標時槍身不會滑動。',
    classes: ALL_CLASSES,
    mods: { adsTime: 0.9, sprintOutTime: 0.9, recoilPitch: 1.1 },
    unlockLevel: 4,
    pros: ['瞄準速度更快', '衝刺後開火更快'],
    cons: ['垂直後座力增加'],
  },
  grip_granulated: {
    id: 'grip_granulated',
    name: '粗砂握把',
    slot: AttachmentSlot.RearGrip,
    description: '噴砂面板，應付濕手與快速換彈匣。',
    classes: ALL_CLASSES,
    mods: { drawTime: 0.85, reloadTime: 0.9, recoilYaw: 1.1, hipSpread: 1.05 },
    unlockLevel: 7,
    pros: ['舉槍速度快很多', '裝填更快'],
    cons: ['水平後座力增加', '腰射散佈變大'],
  },
  grip_quickdraw: {
    id: 'grip_quickdraw',
    name: '快拔握把',
    slot: AttachmentSlot.RearGrip,
    description: '削短的握把尾，出槍套時沒人聽得見。',
    classes: ALL_CLASSES,
    mods: { drawTime: 0.75, swayAmount: 1.15, adsSpread: 1.05 },
    unlockLevel: 10,
    pros: ['舉槍速度大幅提升'],
    cons: ['瞄準晃動增加', '瞄準精準度變差'],
  },
  grip_ergonomic: {
    id: 'grip_ergonomic',
    name: '人體工學握把',
    slot: AttachmentSlot.RearGrip,
    description: '掌心隆起加上更大傾角——穩，但彈匣井操作變慢。',
    classes: ALL_CLASSES,
    mods: { swayAmount: 0.85, adsSpeed: 1.08, reloadTime: 1.08, movementSpeed: 0.98 },
    unlockLevel: 16,
    pros: ['瞄準晃動減少', '瞄準時移動更快'],
    cons: ['裝填較慢', '移動速度較慢'],
  },
  grip_heavy_wrap: {
    id: 'grip_heavy_wrap',
    name: '加重纏繩握把',
    slot: AttachmentSlot.RearGrip,
    description: '加重傘繩纏繞，止住槍身橫向飄移。',
    classes: ALL_CLASSES,
    mods: { recoilYaw: 0.85, hipSpread: 0.95, drawTime: 1.12, adsTime: 1.06 },
    unlockLevel: 13,
    pros: ['水平後座力顯著降低', '腰射更集中'],
    cons: ['舉槍速度較慢', '瞄準速度較慢'],
  },

  // -------------------------------------------------------------------------
  // Laser
  // -------------------------------------------------------------------------
  laser_1mw: {
    id: 'laser_1mw',
    name: '1mW雷射',
    slot: AttachmentSlot.Laser,
    description: '牆上一顆暗淡的光點，讓腰射變得誠實。',
    classes: ALL_CLASSES,
    mods: { hipSpread: 0.78, adsTime: 1.04, movementSpeed: 0.99 },
    unlockLevel: 1,
    pros: ['腰射散佈大幅收攏'],
    cons: ['瞄準速度較慢', '光束會被敵人看見'],
  },
  laser_5mw: {
    id: 'laser_5mw',
    name: '5mW雷射',
    slot: AttachmentSlot.Laser,
    description: '亮到白天也看得見。亮到他們也看得見。',
    classes: ALL_CLASSES,
    mods: { hipSpread: 0.68, adsTime: 0.95, movementSpeed: 0.97, drawTime: 1.06 },
    unlockLevel: 6,
    pros: ['腰射大幅收攏', '瞄準速度更快'],
    cons: ['移動速度較慢', '舉槍速度較慢', '光束極為顯眼'],
  },
  laser_ir: {
    id: 'laser_ir',
    name: '紅外線照明器',
    slot: AttachmentSlot.Laser,
    description: '肉眼看不見，沒人能循著光束找到你。',
    classes: ALL_CLASSES,
    mods: { hipSpread: 0.85, sprintOutTime: 0.9, drawTime: 1.1, adsTime: 1.05 },
    unlockLevel: 12,
    pros: ['腰射更集中', '衝刺後開火更快', '敵人看不見光束'],
    cons: ['舉槍速度較慢', '瞄準速度較慢'],
  },
  laser_steady: {
    id: 'laser_steady',
    name: '穩瞄雷射',
    slot: AttachmentSlot.Laser,
    description: '陀螺穩定模組，抑制高倍率下的抖動。',
    classes: ALL_CLASSES,
    mods: { swayAmount: 0.75, hipSpread: 0.9, adsTime: 1.08, movementSpeed: 0.97 },
    unlockLevel: 17,
    pros: ['瞄準晃動明顯減少', '腰射更集中'],
    cons: ['瞄準速度較慢', '移動速度較慢'],
  },
  laser_rangefinder: {
    id: 'laser_rangefinder',
    name: '雷射測距儀',
    slot: AttachmentSlot.Laser,
    description: '替你測距，並修掉彈道補正的誤差。',
    classes: ALL_CLASSES,
    mods: { damageRangeScale: 1.1, adsSpread: 0.92, adsTime: 1.1, drawTime: 1.08 },
    unlockLevel: 23,
    pros: ['傷害射程延長', '瞄準精準度提升'],
    cons: ['瞄準速度較慢', '舉槍速度較慢'],
  },
  laser_combat_light: {
    id: 'laser_combat_light',
    name: '戰術槍燈',
    slot: AttachmentSlot.Laser,
    description: '槍燈與雷射合在同一個殼裡。室內好用，室外找死。',
    classes: ALL_CLASSES,
    mods: { hipSpread: 0.72, sprintOutTime: 0.92, adsSpread: 1.1, movementSpeed: 0.98 },
    unlockLevel: 9,
    pros: ['腰射散佈極為集中', '衝刺後開火更快'],
    cons: ['瞄準精準度變差', '移動速度較慢', '等於幫所有人照亮你'],
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
