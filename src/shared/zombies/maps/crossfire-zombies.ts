/**
 * Crossfire, after dark.
 *
 * The multiplayer map's three-lane layout turns out to be an excellent zombies
 * map for exactly the reason it is a good deathmatch map: it is a loop. Every
 * zone connects to two others, so there is always a way round — and "always a
 * way round" is the entire survival mechanic, because a player who can still
 * move can still win and a player who cannot is already dead.
 *
 * The zone order is deliberate. Players start in the south plaza with a pistol
 * and no room, and the first door they can afford opens the mid plaza with its
 * fountain to circle. Everything genuinely powerful — the box, the power, the
 * Pack-a-Punch — is deep in the map, so the run out to it is the risk you are
 * being asked to take.
 */

import { vec3 } from '../../math.js';
import { InteractKind, type ZombiesMapData } from '../zombie-types.js';

export const CROSSFIRE_ZOMBIES: ZombiesMapData = {
  mapId: 'crossfire',

  // The Allied end of the plaza: open, but with only two ways out.
  playerSpawns: [
    vec3(-2, 0.1, 30),
    vec3(2, 0.1, 30),
    vec3(-2, 0.1, 27),
    vec3(2, 0.1, 27),
  ],

  startingWeapon: 'p226',
  startingPistol: 'p226',
  startingPoints: 500,

  zones: [
    {
      id: 'start',
      name: '南廣場',
      startingZone: true,
      // Zombies come in from the map edges behind the players, so the pressure
      // is always from the direction you are not looking.
      spawnPoints: [
        vec3(-12, 0.1, 34),
        vec3(12, 0.1, 34),
        vec3(-16, 0.1, 26),
        vec3(16, 0.1, 26),
      ],
    },
    {
      id: 'mid',
      name: '市集廣場',
      spawnPoints: [
        vec3(-10, 0.1, 8),
        vec3(10, 0.1, 10),
        vec3(-9, 0.1, -8),
        vec3(9, 0.1, -6),
      ],
    },
    {
      id: 'west',
      name: '西側巷弄',
      spawnPoints: [
        vec3(-33, 0.1, 20),
        vec3(-34, 0.1, -4),
        vec3(-30, 0.1, -22),
      ],
    },
    {
      id: 'warehouse',
      name: '倉庫',
      spawnPoints: [
        vec3(24, 0.1, 8),
        vec3(23, 0.1, -14),
        vec3(34, 0.1, 2),
      ],
    },
    {
      id: 'north',
      name: '北側貨場',
      spawnPoints: [
        vec3(-12, 0.1, -30),
        vec3(12, 0.1, -30),
        vec3(0, 0.1, -34),
      ],
    },
  ],

  interactables: [
    // --- doors ------------------------------------------------------------
    // Cheap first, so the starting area is never a trap you cannot buy out of.
    {
      id: 'door_mid',
      kind: InteractKind.Door,
      position: vec3(0, 0.1, 20),
      yaw: 0,
      cost: 750,
      zone: 'start',
      opensZone: 'mid',
      label: '清除瓦礫',
    },
    {
      id: 'door_west',
      kind: InteractKind.Door,
      position: vec3(-26, 0.1, 22),
      yaw: Math.PI / 2,
      cost: 1000,
      zone: 'start',
      opensZone: 'west',
      label: '開啟巷弄鐵門',
    },
    {
      id: 'door_warehouse',
      kind: InteractKind.Door,
      position: vec3(27, 0.1, 18),
      yaw: -Math.PI / 2,
      cost: 1250,
      zone: 'start',
      opensZone: 'warehouse',
      label: '開啟裝卸門',
    },
    {
      id: 'door_north',
      kind: InteractKind.Door,
      position: vec3(0, 0.1, -22),
      yaw: 0,
      cost: 1500,
      zone: 'mid',
      opensZone: 'north',
      label: '撬開北側閘門',
    },

    // --- wall buys --------------------------------------------------------
    // A ladder of guns, one per zone, so opening a door is immediately followed
    // by an upgrade you can actually afford.
    {
      id: 'wall_smg',
      kind: InteractKind.WallBuy,
      position: vec3(-7, 1.2, 31),
      yaw: Math.PI,
      cost: 1000,
      ammoCost: 450,
      zone: 'start',
      weaponId: 'mp9k',
      label: 'MP9-K',
    },
    {
      id: 'wall_shotgun',
      kind: InteractKind.WallBuy,
      position: vec3(7, 1.2, 31),
      yaw: Math.PI,
      cost: 1200,
      ammoCost: 500,
      zone: 'start',
      weaponId: 'm870',
      label: 'M870 破門',
    },
    {
      id: 'wall_ar',
      kind: InteractKind.WallBuy,
      position: vec3(-4, 1.2, 2),
      yaw: -Math.PI / 2,
      cost: 1400,
      ammoCost: 600,
      zone: 'mid',
      weaponId: 'vk47',
      label: 'VK-47 山貓',
    },
    {
      id: 'wall_smg2',
      kind: InteractKind.WallBuy,
      position: vec3(-30, 1.2, 6),
      yaw: -Math.PI / 2,
      cost: 1300,
      ammoCost: 550,
      zone: 'west',
      weaponId: 'vector9',
      label: 'Vector-9',
    },
    {
      id: 'wall_lmg',
      kind: InteractKind.WallBuy,
      position: vec3(22, 1.2, -6),
      yaw: Math.PI / 2,
      cost: 1800,
      ammoCost: 750,
      zone: 'warehouse',
      weaponId: 'm60e',
      label: 'M60-E 鐵砧',
    },
    {
      id: 'wall_sniper',
      kind: InteractKind.WallBuy,
      position: vec3(-8, 1.2, -28),
      yaw: 0,
      cost: 1600,
      ammoCost: 700,
      zone: 'north',
      weaponId: 'gr63',
      label: 'GR-63 鐵鎚',
    },

    // --- power ------------------------------------------------------------
    // Deep in the warehouse. Everything worth having is gated behind a run that
    // takes you away from the rest of the team.
    {
      id: 'power',
      kind: InteractKind.Power,
      position: vec3(20, 0.1, -16),
      yaw: 0,
      cost: 0,
      zone: 'warehouse',
      label: '啟動電力',
    },

    // --- mystery box ------------------------------------------------------
    {
      id: 'box',
      kind: InteractKind.MysteryBox,
      position: vec3(19, 0.1, 6),
      yaw: Math.PI,
      cost: 0,
      zone: 'warehouse',
      label: '神秘箱',
    },

    // --- pack-a-punch -----------------------------------------------------
    {
      id: 'pap',
      kind: InteractKind.PackAPunch,
      position: vec3(0, 0.1, -30),
      yaw: Math.PI,
      cost: 0,
      zone: 'north',
      requiresPower: true,
      label: '強化機',
    },

    // --- perk machines ----------------------------------------------------
    // Quick Revive is in the starting zone by convention: the one perk you want
    // before you have any points is the one that forgives not having any.
    {
      id: 'perk_revive',
      kind: InteractKind.PerkMachine,
      position: vec3(6, 0.1, 27),
      yaw: Math.PI,
      cost: 0,
      zone: 'start',
      perkId: 'quick_revive',
      label: '快速復活',
    },
    {
      id: 'perk_jugg',
      kind: InteractKind.PerkMachine,
      position: vec3(21, 0.1, 2),
      yaw: Math.PI / 2,
      cost: 0,
      zone: 'warehouse',
      perkId: 'juggernog',
      requiresPower: true,
      label: '重裝可樂',
    },
    {
      id: 'perk_speed',
      kind: InteractKind.PerkMachine,
      position: vec3(-32, 0.1, -14),
      yaw: -Math.PI / 2,
      cost: 0,
      zone: 'west',
      perkId: 'speed_cola',
      requiresPower: true,
      label: '快速可樂',
    },
    {
      id: 'perk_doubletap',
      kind: InteractKind.PerkMachine,
      position: vec3(-10, 0.1, -26),
      yaw: 0,
      cost: 0,
      zone: 'north',
      perkId: 'double_tap',
      requiresPower: true,
      label: '雙倍快發',
    },
    {
      id: 'perk_stamin',
      kind: InteractKind.PerkMachine,
      position: vec3(-6, 0.1, 12),
      yaw: Math.PI,
      cost: 0,
      zone: 'mid',
      perkId: 'stamin_up',
      requiresPower: true,
      label: '耐力增強',
    },
  ],
};
