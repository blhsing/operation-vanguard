/**
 * Weapon definition schema.
 *
 * Every number that affects time-to-kill lives in a WeaponDef, so balance changes
 * never require touching combat code. Attachments express themselves as a sparse
 * set of modifiers over these same fields (see attachments.ts), which means a
 * single `resolveWeapon()` pass produces the effective stats for any build.
 */

export enum WeaponClass {
  AssaultRifle = 'assault_rifle',
  SubmachineGun = 'smg',
  LightMachineGun = 'lmg',
  SniperRifle = 'sniper',
  MarksmanRifle = 'marksman',
  Shotgun = 'shotgun',
  Pistol = 'pistol',
  Launcher = 'launcher',
  Melee = 'melee',
  Special = 'special',
}

export enum FireMode {
  /** Holds trigger, keeps firing. */
  Auto = 'auto',
  /** One shot per trigger pull. */
  Semi = 'semi',
  /** Fixed-length burst per pull. */
  Burst = 'burst',
  /** Manual cycle between shots (bolt/pump). */
  BoltAction = 'bolt',
  /** Melee swing. */
  Swing = 'swing',
}

export enum AttachmentSlot {
  Muzzle = 0,
  Barrel = 1,
  Optic = 2,
  Underbarrel = 3,
  Magazine = 4,
  Stock = 5,
  RearGrip = 6,
  Laser = 7,
}

export const ATTACHMENT_SLOT_COUNT = 8;
/** Players may equip at most this many attachments, COD-style. */
export const MAX_EQUIPPED_ATTACHMENTS = 5;

/**
 * A damage curve is a list of (distance, damage) stops. Damage is linearly
 * interpolated between stops and clamped flat beyond the last one. This models
 * COD's stepped damage ranges while keeping the falloff smooth enough that
 * players don't feel a cliff edge.
 */
export interface DamageStop {
  /** Distance in metres at which this damage value applies. */
  distance: number;
  damage: number;
}

/**
 * Deterministic recoil. COD guns kick along a repeatable pattern so the gun can
 * be mastered; a small random component keeps it from being a laser.
 *
 * `pattern` is sampled by shot index (clamped at the end), giving per-shot
 * vertical/horizontal kick in radians.
 */
export interface RecoilProfile {
  /** Per-shot kick, indexed by shot number in the current trigger pull. */
  pattern: Array<{ pitch: number; yaw: number }>;
  /** Random kick added on top of the pattern, in radians. */
  randomPitch: number;
  randomYaw: number;
  /** How fast accumulated recoil decays back toward zero, per second. */
  recoverySpeed: number;
  /** Fraction of recoil the view returns automatically (1 = full auto-centering). */
  recoveryFraction: number;
  /** Visual-only kick applied to the viewmodel, multiplied against the above. */
  viewKickMultiplier: number;
  /** Camera shake magnitude in radians. */
  cameraShake: number;
}

/**
 * Bullet spread. Hipfire is a cone that grows while moving and firing; ADS
 * collapses it toward `adsMin`. Snipers reach exactly zero when fully scoped.
 */
export interface SpreadProfile {
  /** Cone half-angle in radians while standing still and hip-firing. */
  hipMin: number;
  hipMax: number;
  /** Fully-aimed cone half-angle. */
  adsMin: number;
  adsMax: number;
  /** Added per shot fired. */
  perShot: number;
  /** Decay back toward the minimum, per second. */
  recovery: number;
  /** Multipliers applied to the current cone. */
  movingMultiplier: number;
  jumpingMultiplier: number;
  crouchMultiplier: number;
  proneMultiplier: number;
}

export interface WeaponHandling {
  /** Seconds from hipfire to fully aimed. The single most important SMG/AR stat. */
  adsTime: number;
  /** Seconds from sprinting to being able to fire. */
  sprintOutTime: number;
  /** Seconds to raise this weapon when swapping to it. */
  drawTime: number;
  /** Seconds to lower this weapon when swapping away. */
  holsterTime: number;
  /** Tactical reload keeps the chambered round. */
  reloadTime: number;
  /** Empty reload has to cycle the action. */
  reloadEmptyTime: number;
  /** Point during the reload at which ammo is actually added (reload cancelling). */
  reloadAmmoTime: number;
  reloadEmptyAmmoTime: number;
  /** Multiplier on base movement speed while holding this weapon. */
  movementSpeedMultiplier: number;
  /** Multiplier on movement speed while aiming. */
  adsSpeedMultiplier: number;
  /** Weapon sway amplitude while aimed, radians. */
  swayAmount: number;
  swaySpeed: number;
}

export interface WeaponDef {
  id: string;
  name: string;
  /** Short label for the killfeed and HUD. */
  shortName: string;
  class: WeaponClass;
  description: string;

  fireMode: FireMode;
  /** Rounds per minute. For burst weapons this is the in-burst rate. */
  rpm: number;
  /** Shots per burst; ignored unless fireMode is Burst. */
  burstCount: number;
  /** Delay between bursts, seconds. */
  burstDelay: number;

  magSize: number;
  startingReserve: number;
  maxReserve: number;
  /** Pellets per shot. Shotguns fire many; everything else fires one. */
  pellets: number;

  damage: DamageStop[];
  /** Damage multiplier applied to non-player targets (killstreaks, deployables). */
  vehicleDamageMultiplier: number;
  /** How much material this round punches through, 0..1. Feeds wallbang math. */
  penetration: number;
  /** Muzzle velocity in m/s. Infinity = pure hitscan (most COD guns). */
  muzzleVelocity: number;
  /** Projectile drop in m/s². 0 for hitscan. */
  bulletGravity: number;

  recoil: RecoilProfile;
  spread: SpreadProfile;
  handling: WeaponHandling;

  /** Which attachment slots this weapon supports. */
  attachmentSlots: AttachmentSlot[];

  /** Player level required to unlock. 0 = available from the start. */
  unlockLevel: number;

  /** Audio synthesis parameters — see the procedural audio engine. */
  audio: {
    /** Base pitch of the shot's body, Hz. */
    bodyFreq: number;
    /** Duration of the transient crack, seconds. */
    crackDuration: number;
    /** Low-end thump amount, 0..1. */
    boom: number;
    /** Mechanical action noise, 0..1. */
    mech: number;
    /** Tail length (reverb send), seconds. */
    tail: number;
    /** True if this weapon is suppressed by default. */
    suppressed: boolean;
  };

  /** Viewmodel construction parameters — see the procedural model builder. */
  model: {
    /** Overall length in metres, drives the primitive layout. */
    length: number;
    /** Body colour. */
    color: number;
    accentColor: number;
    /** Magazine size/shape hint. */
    magStyle: 'stick' | 'box' | 'drum' | 'tube' | 'none';
    stockStyle: 'fixed' | 'folding' | 'skeleton' | 'none';
    hasCarryHandle: boolean;
    barrelLength: number;
    /** Position of the iron sights relative to the barrel, for ADS alignment. */
    sightHeight: number;
  };

  /** Zoom factor applied to FOV when aiming (1 = no zoom). */
  adsZoom: number;
  /** True for weapons that show a scope overlay instead of the viewmodel. */
  scoped: boolean;
  /** Fraction of a second the scope takes to focus (sniper glint / blur). */
  scopeFocusTime: number;

  /** Melee damage when bashing with this weapon. */
  meleeDamage: number;
  /** Extra flags that combat code branches on. */
  traits: WeaponTrait[];
}

export enum WeaponTrait {
  /** One-hit-kill to the upper torso within the first damage stop. */
  OneShotUpperTorso = 'one_shot_upper_torso',
  /** Fires explosive rounds. */
  Explosive = 'explosive',
  /** Cannot be dual-wielded or akimbo'd. */
  NoAkimbo = 'no_akimbo',
  /** Rechambers between shots, blocking fire. */
  Rechamber = 'rechamber',
  /** Reloads one round at a time and can be interrupted. */
  ShellReload = 'shell_reload',
  /** Ignores the ADS sway penalty. */
  SteadyAim = 'steady_aim',
  /** Locks onto air targets. */
  AirLockOn = 'air_lock_on',
  /** Damage is unaffected by range. */
  NoFalloff = 'no_falloff',
  /** Silent by design — never shows on the minimap. */
  AlwaysSuppressed = 'always_suppressed',
}

// ---------------------------------------------------------------------------
// Derived helpers
// ---------------------------------------------------------------------------

/** Seconds between shots, derived from RPM. */
export function fireInterval(def: Pick<WeaponDef, 'rpm'>): number {
  return def.rpm > 0 ? 60 / def.rpm : 0;
}

/**
 * Damage at a given distance, interpolating between stops.
 * Flat before the first stop and after the last, which is what makes the
 * "damage range" concept legible to players.
 */
export function damageAtRange(stops: readonly DamageStop[], distance: number): number {
  if (stops.length === 0) return 0;
  const first = stops[0]!;
  if (distance <= first.distance) return first.damage;

  for (let i = 1; i < stops.length; i++) {
    const prev = stops[i - 1]!;
    const cur = stops[i]!;
    if (distance <= cur.distance) {
      const span = cur.distance - prev.distance;
      if (span <= 0) return cur.damage;
      const t = (distance - prev.distance) / span;
      return prev.damage + (cur.damage - prev.damage) * t;
    }
  }
  return stops[stops.length - 1]!.damage;
}

/**
 * Shots required to kill at a given range and hit multiplier.
 * The canonical way to reason about balance — every weapon in the arsenal is
 * validated against expected STK bands in the test suite.
 */
export function shotsToKill(
  stops: readonly DamageStop[],
  distance: number,
  health: number,
  multiplier = 1,
): number {
  const dmg = damageAtRange(stops, distance) * multiplier;
  if (dmg <= 0) return Infinity;
  return Math.ceil(health / dmg);
}

/** Time to kill in seconds, ignoring the first shot's travel time. */
export function timeToKill(
  def: Pick<WeaponDef, 'rpm' | 'damage' | 'pellets' | 'burstCount' | 'burstDelay' | 'fireMode'>,
  distance: number,
  health: number,
  multiplier = 1,
): number {
  const perShot = damageAtRange(def.damage, distance) * multiplier * Math.max(1, def.pellets);
  if (perShot <= 0) return Infinity;
  const shots = Math.ceil(health / perShot);
  if (shots <= 1) return 0;

  const interval = fireInterval(def);
  if (def.fireMode === FireMode.Burst && def.burstCount > 1) {
    const fullBursts = Math.floor((shots - 1) / def.burstCount);
    const remainder = (shots - 1) % def.burstCount;
    return fullBursts * ((def.burstCount - 1) * interval + def.burstDelay) + remainder * interval;
  }
  return (shots - 1) * interval;
}
