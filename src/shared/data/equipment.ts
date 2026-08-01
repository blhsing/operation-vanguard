/**
 * Grenades, placed equipment and field upgrades.
 *
 * Balance anchor: the frag grenade is 130 damage over a 5.5 m radius on a 3.5 s
 * fuse. Everything lethal is priced against it — anything that hits harder or
 * arms faster gives up radius, throw range or count in exchange.
 *
 * `projectileKind` / `deployableKind` choose the *physics and model* the sim uses
 * to move and draw the item; the `effect` record decides what actually happens
 * when it goes off. That split lets several distinct pieces of kit share one
 * projectile body instead of each demanding its own enum member.
 */

import { DeployableKind, ProjectileKind } from '../types.js';

export interface EquipmentDef {
  id: string;
  name: string;
  slot: 'lethal' | 'tactical' | 'field';
  description: string;
  /** How many you spawn with. */
  count: number;
  unlockLevel: number;
  projectileKind?: ProjectileKind;
  deployableKind?: DeployableKind;
  damage?: number;
  /** Metres. For sensors and field upgrades this is the effect/scan radius. */
  radius?: number;
  /** Seconds from release to detonation. 0 = manual or on-trigger. */
  fuse?: number;
  /** Initial throw/place speed in m/s. */
  throwSpeed?: number;
  /** Seconds of field-upgrade recharge, or the arming delay for placed lethals. */
  chargeTime?: number;
  effect?: {
    flash?: number;
    stun?: number;
    smoke?: number;
    emp?: number;
    burn?: number;
    duration?: number;
  };
}

export const EQUIPMENT: Record<string, EquipmentDef> = {
  // -------------------------------------------------------------------------
  // Lethal
  // -------------------------------------------------------------------------
  frag: {
    id: 'frag',
    name: 'Frag Grenade',
    slot: 'lethal',
    description: 'Cookable fragmentation grenade. The yardstick every other lethal is measured against.',
    count: 1,
    unlockLevel: 0,
    projectileKind: ProjectileKind.Frag,
    damage: 130,
    radius: 5.5,
    fuse: 3.5,
    throwSpeed: 16,
  },
  semtex: {
    id: 'semtex',
    name: 'Semtex',
    slot: 'lethal',
    description: 'Sticks to whatever it touches. Shorter fuse, tighter blast, no bouncing it round a corner.',
    count: 1,
    unlockLevel: 4,
    projectileKind: ProjectileKind.Semtex,
    damage: 140,
    radius: 4.6,
    fuse: 2.2,
    throwSpeed: 18,
  },
  throwing_knife: {
    id: 'throwing_knife',
    name: 'Throwing Knife',
    slot: 'lethal',
    description: 'Silent, lethal on a clean hit, and recoverable from the body.',
    count: 1,
    unlockLevel: 7,
    projectileKind: ProjectileKind.ThrowingKnife,
    damage: 200,
    radius: 0,
    fuse: 0,
    throwSpeed: 32,
  },
  c4: {
    id: 'c4',
    name: 'C4',
    slot: 'lethal',
    description: 'Remote charge you detonate on your own timing.',
    count: 1,
    unlockLevel: 10,
    projectileKind: ProjectileKind.C4,
    deployableKind: DeployableKind.C4Placed,
    damage: 190,
    radius: 6.5,
    fuse: 0,
    throwSpeed: 12,
    chargeTime: 0.5,
  },
  claymore: {
    id: 'claymore',
    name: 'Claymore',
    slot: 'lethal',
    description: 'Directional mine triggered by a tripwire across its front arc.',
    count: 1,
    unlockLevel: 13,
    projectileKind: ProjectileKind.ClaymoreProjectile,
    deployableKind: DeployableKind.Claymore,
    damage: 160,
    radius: 4.5,
    fuse: 0,
    throwSpeed: 6,
    chargeTime: 1.2,
  },
  proximity_mine: {
    id: 'proximity_mine',
    name: 'Proximity Mine',
    slot: 'lethal',
    description: 'Pressure mine that arms slowly but covers every approach, not just one arc.',
    count: 1,
    unlockLevel: 16,
    projectileKind: ProjectileKind.ClaymoreProjectile,
    deployableKind: DeployableKind.ProximityMine,
    damage: 150,
    radius: 4,
    fuse: 0,
    throwSpeed: 6,
    chargeTime: 1.8,
  },
  thermite: {
    id: 'thermite',
    name: 'Thermite',
    slot: 'lethal',
    description: 'Burns on contact. Low blast, but the fire finishes anyone who stays in it.',
    count: 1,
    unlockLevel: 19,
    projectileKind: ProjectileKind.ThermiteStick,
    damage: 45,
    radius: 2.5,
    fuse: 0.5,
    throwSpeed: 17,
    effect: { burn: 30, duration: 5 },
  },
  molotov: {
    id: 'molotov',
    name: 'Molotov',
    slot: 'lethal',
    description: 'Shatters into a pool of fire. Area denial rather than a kill on impact.',
    count: 1,
    unlockLevel: 22,
    projectileKind: ProjectileKind.Molotov,
    damage: 30,
    radius: 3.2,
    fuse: 0,
    throwSpeed: 15,
    effect: { burn: 22, duration: 8 },
  },

  // -------------------------------------------------------------------------
  // Tactical
  // -------------------------------------------------------------------------
  flashbang: {
    id: 'flashbang',
    name: 'Flashbang',
    slot: 'tactical',
    description: 'Blinds and deafens anyone looking anywhere near it.',
    count: 2,
    unlockLevel: 0,
    projectileKind: ProjectileKind.Flashbang,
    radius: 8,
    fuse: 1.6,
    throwSpeed: 17,
    effect: { flash: 1, duration: 4.5 },
  },
  stun_grenade: {
    id: 'stun_grenade',
    name: 'Stun Grenade',
    slot: 'tactical',
    description: 'Concussive blast that slows movement and aim without taking sight away.',
    count: 2,
    unlockLevel: 3,
    projectileKind: ProjectileKind.StunGrenade,
    radius: 6.5,
    fuse: 1.4,
    throwSpeed: 17,
    effect: { stun: 1, duration: 4 },
  },
  smoke_grenade: {
    id: 'smoke_grenade',
    name: 'Smoke Grenade',
    slot: 'tactical',
    description: 'Thick screen for crossing open ground or covering a plant.',
    count: 1,
    unlockLevel: 6,
    projectileKind: ProjectileKind.SmokeGrenade,
    radius: 7,
    fuse: 1,
    throwSpeed: 16,
    effect: { smoke: 1, duration: 15 },
  },
  snapshot_grenade: {
    id: 'snapshot_grenade',
    name: 'Snapshot Grenade',
    slot: 'tactical',
    description: 'Pulses a single wireframe snapshot of everyone caught in the blast.',
    count: 2,
    unlockLevel: 9,
    projectileKind: ProjectileKind.StunGrenade,
    radius: 12,
    fuse: 1.2,
    throwSpeed: 18,
    effect: { duration: 2.5 },
  },
  decoy_grenade: {
    id: 'decoy_grenade',
    name: 'Decoy Grenade',
    slot: 'tactical',
    description: 'Fakes gunfire and radar contacts to pull attention off you.',
    count: 2,
    unlockLevel: 12,
    projectileKind: ProjectileKind.Flashbang,
    radius: 10,
    fuse: 1,
    throwSpeed: 17,
    effect: { duration: 8 },
  },
  gas_grenade: {
    id: 'gas_grenade',
    name: 'Gas Grenade',
    slot: 'tactical',
    description: 'Lingering cloud that blurs vision, slows movement and burns lungs.',
    count: 1,
    unlockLevel: 15,
    projectileKind: ProjectileKind.SmokeGrenade,
    radius: 6,
    fuse: 1,
    throwSpeed: 15,
    effect: { smoke: 0.6, stun: 0.5, burn: 8, duration: 10 },
  },
  heartbeat_sensor: {
    id: 'heartbeat_sensor',
    name: 'Heartbeat Sensor',
    slot: 'tactical',
    description: 'Handheld scanner that pings nearby movement. Held, not thrown — you cannot shoot while reading it.',
    count: 1,
    unlockLevel: 18,
    radius: 25,
    effect: { duration: 0 },
  },

  // -------------------------------------------------------------------------
  // Field upgrades — recharge over time rather than being carried in a count
  // -------------------------------------------------------------------------
  dead_silence: {
    id: 'dead_silence',
    name: 'Dead Silence',
    slot: 'field',
    description: 'Your footsteps go silent for a window, and kills extend it.',
    count: 1,
    unlockLevel: 5,
    chargeTime: 60,
    effect: { duration: 15 },
  },
  deployable_cover: {
    id: 'deployable_cover',
    name: 'Deployable Cover',
    slot: 'field',
    description: 'Pop-up ballistic shield that makes cover where there was none.',
    count: 1,
    unlockLevel: 2,
    deployableKind: DeployableKind.DeployableCover,
    radius: 2,
    chargeTime: 45,
    effect: { duration: 120 },
  },
  tactical_insertion: {
    id: 'tactical_insertion',
    name: 'Tactical Insertion',
    slot: 'field',
    description: 'Flare that sets where you respawn. Enemies can see it and destroy it.',
    count: 1,
    unlockLevel: 8,
    deployableKind: DeployableKind.TacticalInsertion,
    radius: 1,
    chargeTime: 40,
    effect: { duration: 120 },
  },
  munitions_box: {
    id: 'munitions_box',
    name: 'Munitions Box',
    slot: 'field',
    description: 'Resupplies ammunition and equipment for anyone on your team who reaches it.',
    count: 1,
    unlockLevel: 11,
    deployableKind: DeployableKind.AmmoBox,
    radius: 3,
    chargeTime: 70,
    effect: { duration: 120 },
  },
  trophy_system: {
    id: 'trophy_system',
    name: 'Trophy System',
    slot: 'field',
    description: 'Shoots down the next few grenades, rockets or drones that come near it.',
    count: 1,
    unlockLevel: 14,
    deployableKind: DeployableKind.TrophySystem,
    radius: 6,
    chargeTime: 80,
    effect: { duration: 120 },
  },
  recon_drone: {
    id: 'recon_drone',
    name: 'Recon Drone',
    slot: 'field',
    description: 'Fly a small drone and mark what it sees. You are defenceless while piloting.',
    count: 1,
    unlockLevel: 17,
    radius: 40,
    chargeTime: 90,
    effect: { duration: 25 },
  },
  stopping_power: {
    id: 'stopping_power',
    name: 'Stopping Power Rounds',
    slot: 'field',
    description: 'One magazine of high-pressure rounds that cut a shot off most time-to-kills.',
    count: 1,
    unlockLevel: 20,
    chargeTime: 100,
    effect: { duration: 0 },
  },
  emp_drone: {
    id: 'emp_drone',
    name: 'EMP Drone',
    slot: 'field',
    description: 'Kamikaze drone that fries enemy HUDs and equipment in the blast.',
    count: 1,
    unlockLevel: 23,
    damage: 60,
    radius: 12,
    chargeTime: 110,
    effect: { emp: 1, duration: 8 },
  },
};

export function getEquipment(id: string): EquipmentDef {
  const def = EQUIPMENT[id];
  if (!def) throw new Error(`Unknown equipment: ${id}`);
  return def;
}

/** Everything in a slot, ordered by unlock so the loadout menu reads as progression. */
export function equipmentForSlot(slot: 'lethal' | 'tactical' | 'field'): EquipmentDef[] {
  return Object.values(EQUIPMENT)
    .filter((e) => e.slot === slot)
    .sort((a, b) => a.unlockLevel - b.unlockLevel || a.id.localeCompare(b.id));
}
