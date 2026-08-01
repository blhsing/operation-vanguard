/**
 * Killstreak table.
 *
 * `cost` is the classic consecutive-kill requirement; `scoreCost` is the same
 * reward on the scorestreak ladder, priced at roughly 500 points per kill so a
 * player who plays the objective earns streaks at a comparable rate to a player
 * who only shoots people.
 *
 * Announce lines are radio chatter, deliberately split by side: hearing "enemy
 * air support inbound" is the warning that makes a streak counterable, so the two
 * teams must never be told the same thing.
 */

import { KillstreakVehicleKind } from '../types.js';

export interface KillstreakDef {
  id: string;
  name: string;
  /** Consecutive kills required. */
  cost: number;
  /** Points required on the scorestreak ladder. */
  scoreCost: number;
  description: string;
  /**
   * How the sim spawns it:
   *  - `passive`     — applies to the owner only, no world entity
   *  - `call_in`     — AI-flown or scripted entity
   *  - `controlled`  — the player takes direct control
   *  - `care_package`— drops a crate someone has to physically claim
   *  - `deployable`  — a placed object with health that can be destroyed
   */
  kind: 'passive' | 'call_in' | 'controlled' | 'care_package' | 'deployable';
  /** Seconds the effect or entity lasts. 0 = instantaneous. */
  duration: number;
  vehicle?: KillstreakVehicleKind;
  damage?: number;
  radius?: number;
  health?: number;
  unlockLevel: number;
  friendlyAnnounce: string;
  enemyAnnounce: string;
}

export const KILLSTREAKS: Record<string, KillstreakDef> = {
  uav: {
    id: 'uav',
    name: 'UAV',
    cost: 3,
    scoreCost: 1500,
    description: 'Reveals enemy positions on the minimap.',
    kind: 'call_in',
    duration: 30,
    vehicle: KillstreakVehicleKind.UAV,
    health: 250,
    unlockLevel: 0,
    friendlyAnnounce: 'UAV overhead — eyes on the map.',
    enemyAnnounce: 'Enemy UAV up. Stay off the radar.',
  },
  personal_radar: {
    id: 'personal_radar',
    name: 'Personal Radar',
    cost: 4,
    scoreCost: 2000,
    description: 'A private radar sweep only you can see. Nothing to shoot down.',
    kind: 'passive',
    duration: 60,
    radius: 45,
    unlockLevel: 2,
    friendlyAnnounce: 'Personal radar online.',
    enemyAnnounce: '',
  },
  counter_uav: {
    id: 'counter_uav',
    name: 'Counter-UAV',
    cost: 4,
    scoreCost: 2000,
    description: 'Jams the enemy minimap and scrambles their radar returns.',
    kind: 'call_in',
    duration: 30,
    vehicle: KillstreakVehicleKind.CounterUAV,
    health: 250,
    unlockLevel: 4,
    friendlyAnnounce: 'Counter-UAV inbound — their radar is down.',
    enemyAnnounce: 'Radar jammed! Enemy Counter-UAV in the air.',
  },
  care_package: {
    id: 'care_package',
    name: 'Care Package',
    cost: 4,
    scoreCost: 2000,
    description: 'Marks a drop zone for a random killstreak crate. Anyone can claim it.',
    kind: 'care_package',
    duration: 90,
    unlockLevel: 6,
    friendlyAnnounce: 'Care package on the way — mark the smoke.',
    enemyAnnounce: 'Enemy care package inbound. Steal it.',
  },
  cluster_strike: {
    id: 'cluster_strike',
    name: 'Cluster Strike',
    cost: 5,
    scoreCost: 2500,
    description: 'Saturates a marked area with a spread of mortar submunitions.',
    kind: 'call_in',
    duration: 6,
    vehicle: KillstreakVehicleKind.ClusterStrike,
    damage: 150,
    radius: 8,
    unlockLevel: 8,
    friendlyAnnounce: 'Cluster strike, rounds out.',
    enemyAnnounce: 'Incoming mortars! Get out of the open!',
  },
  precision_airstrike: {
    id: 'precision_airstrike',
    name: 'Precision Airstrike',
    cost: 5,
    scoreCost: 2500,
    description: 'A two-aircraft bombing run along a line you draw on the map.',
    kind: 'call_in',
    duration: 8,
    vehicle: KillstreakVehicleKind.Airstrike,
    damage: 200,
    radius: 12,
    unlockLevel: 10,
    friendlyAnnounce: 'Airstrike inbound, danger close.',
    enemyAnnounce: 'Enemy airstrike inbound! Take cover!',
  },
  sentry_gun: {
    id: 'sentry_gun',
    name: 'Sentry Gun',
    cost: 6,
    scoreCost: 3000,
    description: 'Automated turret that holds an angle until someone destroys it.',
    kind: 'deployable',
    duration: 90,
    damage: 25,
    radius: 30,
    health: 250,
    unlockLevel: 12,
    friendlyAnnounce: 'Sentry gun deployed — that lane is covered.',
    enemyAnnounce: 'Enemy sentry gun active. Flank it.',
  },
  cruise_missile: {
    id: 'cruise_missile',
    name: 'Cruise Missile',
    cost: 7,
    scoreCost: 3500,
    description: 'Pilot a remote missile from launch to impact.',
    kind: 'controlled',
    duration: 25,
    vehicle: KillstreakVehicleKind.PredatorMissile,
    damage: 300,
    radius: 9,
    health: 100,
    unlockLevel: 14,
    friendlyAnnounce: 'Missile away — you have control.',
    enemyAnnounce: 'Enemy missile in the air! Break contact!',
  },
  attack_chopper: {
    id: 'attack_chopper',
    name: 'Attack Chopper',
    cost: 7,
    scoreCost: 3500,
    description: 'AI gunship that patrols the map and engages on its own.',
    kind: 'call_in',
    duration: 45,
    vehicle: KillstreakVehicleKind.Chopper,
    damage: 45,
    radius: 3,
    health: 900,
    unlockLevel: 16,
    friendlyAnnounce: 'Attack chopper on station.',
    enemyAnnounce: 'Enemy chopper inbound — get inside!',
  },
  vtol_jet: {
    id: 'vtol_jet',
    name: 'VTOL Jet',
    cost: 8,
    scoreCost: 4000,
    description: 'Strafing run on a marked target, then a hover-and-hold overwatch.',
    kind: 'call_in',
    duration: 40,
    vehicle: KillstreakVehicleKind.VTOL,
    damage: 60,
    radius: 5,
    health: 1100,
    unlockLevel: 18,
    friendlyAnnounce: 'VTOL on station, hitting your mark.',
    enemyAnnounce: 'Enemy VTOL overhead! Find hard cover!',
  },
  advanced_uav: {
    id: 'advanced_uav',
    name: 'Advanced UAV',
    cost: 8,
    scoreCost: 4000,
    description: 'Continuous radar showing enemy positions and the way they are facing.',
    kind: 'call_in',
    duration: 40,
    vehicle: KillstreakVehicleKind.UAV,
    health: 400,
    unlockLevel: 20,
    friendlyAnnounce: 'Advanced UAV up — you can see which way they are looking.',
    enemyAnnounce: 'Advanced UAV overhead. They see everything.',
  },
  chopper_gunner: {
    id: 'chopper_gunner',
    name: 'Chopper Gunner',
    cost: 9,
    scoreCost: 4500,
    description: 'Take the minigun seat of an orbiting helicopter.',
    kind: 'controlled',
    duration: 40,
    vehicle: KillstreakVehicleKind.Chopper,
    damage: 70,
    radius: 3,
    health: 1200,
    unlockLevel: 22,
    friendlyAnnounce: 'Chopper gunner — the gun is yours.',
    enemyAnnounce: 'Enemy chopper gunner! Stay under cover!',
  },
  gunship: {
    id: 'gunship',
    name: 'Gunship',
    cost: 10,
    scoreCost: 5000,
    description: 'Three-weapon fixed-wing platform in a lazy orbit. Nothing is safe outdoors.',
    kind: 'controlled',
    duration: 40,
    vehicle: KillstreakVehicleKind.AC130,
    damage: 120,
    radius: 6,
    health: 1400,
    unlockLevel: 24,
    friendlyAnnounce: 'Gunship on station — cleared hot.',
    enemyAnnounce: 'Enemy gunship overhead! Get inside, now!',
  },
  emp_burst: {
    id: 'emp_burst',
    name: 'EMP Burst',
    cost: 11,
    scoreCost: 5500,
    description: 'Blacks out enemy HUDs and destroys their air support.',
    kind: 'call_in',
    duration: 25,
    damage: 400,
    radius: 200,
    unlockLevel: 26,
    friendlyAnnounce: 'EMP out — their gear is dead.',
    enemyAnnounce: 'EMP! Electronics are down!',
  },
  juggernaut: {
    id: 'juggernaut',
    name: 'Juggernaut',
    cost: 12,
    scoreCost: 6000,
    description: 'A drop crate of heavy armour and a belt-fed machine gun. Slow and very hard to kill.',
    kind: 'care_package',
    duration: 0,
    health: 1200,
    unlockLevel: 28,
    friendlyAnnounce: 'Juggernaut suit inbound — go get it.',
    enemyAnnounce: 'Enemy juggernaut on the field. Focus fire!',
  },
  tactical_nuke: {
    id: 'tactical_nuke',
    name: 'Tactical Nuke',
    cost: 25,
    scoreCost: 12500,
    description: 'Ends the match. Everyone dies, your team wins.',
    kind: 'call_in',
    duration: 10,
    damage: 100000,
    radius: 10000,
    unlockLevel: 30,
    friendlyAnnounce: 'Nuke armed. Ten seconds.',
    enemyAnnounce: 'Enemy has a nuke! Ten seconds!',
  },
};

export function getKillstreak(id: string): KillstreakDef {
  const def = KILLSTREAKS[id];
  if (!def) throw new Error(`Unknown killstreak: ${id}`);
  return def;
}

/** The classic 3/5/9 loadout every new player starts on. */
export const DEFAULT_KILLSTREAKS: string[] = ['uav', 'precision_airstrike', 'chopper_gunner'];

/** Everything a player at the given streak count has already earned, cheapest first. */
export function killstreaksUpTo(cost: number): KillstreakDef[] {
  return Object.values(KILLSTREAKS)
    .filter((k) => k.cost <= cost)
    .sort((a, b) => a.cost - b.cost || a.id.localeCompare(b.id));
}
