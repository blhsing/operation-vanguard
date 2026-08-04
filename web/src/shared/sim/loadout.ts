/**
 * Loadouts: turning a create-a-class selection into a live, armed player.
 *
 * A Loadout is pure data that survives serialisation — it is what gets saved to
 * local storage, sent over the wire on spawn, and shown in the class editor.
 * Resolving it into weapon state and gameplay modifiers happens here, in one
 * place, so the client's prediction and the server's authority arm a player
 * identically.
 */

import {
  DEFAULT_PRIMARY,
  DEFAULT_SECONDARY,
  getWeapon,
  tryGetWeapon,
} from '../data/weapons.js';
import { MAX_EQUIPPED_ATTACHMENTS, type WeaponDef } from '../data/weapon-types.js';
import { resolveWeapon } from '../data/attachments.js';
import { PERKS, combinePerkEffects, type ResolvedPerkEffects } from '../data/perks.js';
import { EQUIPMENT, type EquipmentDef } from '../data/equipment.js';
import { DEFAULT_KILLSTREAKS } from '../data/killstreaks.js';
import { WeaponSlot, type PlayerState } from '../types.js';
import { createWeaponState } from './world.js';

export interface Loadout {
  name: string;
  primary: string;
  primaryAttachments: string[];
  secondary: string;
  secondaryAttachments: string[];
  lethal: string;
  tactical: string;
  perks: [string, string, string] | string[];
  fieldUpgrade: string;
  killstreaks: string[];
}

/** The starting class, playable at rank 0 with nothing unlocked. */
export function defaultLoadout(name = 'Default'): Loadout {
  return {
    name,
    primary: DEFAULT_PRIMARY,
    primaryAttachments: [],
    secondary: DEFAULT_SECONDARY,
    secondaryAttachments: [],
    lethal: 'frag',
    tactical: 'flashbang',
    perks: [],
    fieldUpgrade: '',
    killstreaks: DEFAULT_KILLSTREAKS.slice(0, 3),
  };
}

/**
 * Everything the simulation needs to know about a player's build, resolved once
 * on spawn rather than looked up per tick.
 */
export interface ResolvedLoadout {
  primary: WeaponDef;
  secondary: WeaponDef;
  lethal: EquipmentDef | null;
  tactical: EquipmentDef | null;
  perks: ResolvedPerkEffects;
  perkIds: string[];
  fieldUpgrade: string;
  killstreaks: string[];
}

/**
 * Resolve a loadout, tolerating anything stale or unknown.
 *
 * Loadouts come from local storage and from the network, so they can reference
 * weapons and attachments that no longer exist. Every lookup here falls back
 * rather than throwing: a player with a stale saved class must spawn with
 * something sensible, not fail to spawn at all.
 */
export function resolveLoadout(loadout: Loadout): ResolvedLoadout {
  const primaryBase = tryGetWeapon(loadout.primary) ?? getWeapon(DEFAULT_PRIMARY);
  const secondaryBase = tryGetWeapon(loadout.secondary) ?? getWeapon(DEFAULT_SECONDARY);

  const primary = resolveWeapon(
    primaryBase,
    (loadout.primaryAttachments ?? []).slice(0, MAX_EQUIPPED_ATTACHMENTS),
  );
  const secondary = resolveWeapon(
    secondaryBase,
    (loadout.secondaryAttachments ?? []).slice(0, MAX_EQUIPPED_ATTACHMENTS),
  );

  const perkIds = (loadout.perks ?? []).filter((p) => typeof p === 'string' && p.length > 0);

  return {
    primary,
    secondary,
    lethal: EQUIPMENT[loadout.lethal] ?? null,
    tactical: EQUIPMENT[loadout.tactical] ?? null,
    perks: combinePerkEffects(perkIds),
    perkIds,
    fieldUpgrade: loadout.fieldUpgrade ?? '',
    killstreaks: (loadout.killstreaks ?? []).slice(0, 3),
  };
}

/**
 * Arm a player from a resolved loadout. Called on every spawn.
 *
 * Weapon *state* (ammo counts, recoil accumulators) is rebuilt from scratch
 * here, which is deliberate: carrying ammo across a death would be a balance
 * change, and carrying recoil state across would be a bug.
 */
export function applyLoadout(player: PlayerState, resolved: ResolvedLoadout): void {
  player.weapons = [];
  player.weapons[WeaponSlot.Primary] = createWeaponState(
    resolved.primary.id,
    resolved.primary.magSize,
    resolved.primary.startingReserve,
  );
  player.weapons[WeaponSlot.Secondary] = createWeaponState(
    resolved.secondary.id,
    resolved.secondary.magSize,
    resolved.secondary.startingReserve,
  );
  player.activeSlot = WeaponSlot.Primary;

  player.perks = resolved.perkIds.slice();
  player.fieldUpgrade = resolved.fieldUpgrade;
  player.killstreaks = resolved.killstreaks.slice();

  const perks = resolved.perks;
  player.lethalCount = (resolved.lethal?.count ?? 0) + (perks.extraLethal ?? 0);
  player.tacticalCount = (resolved.tactical?.count ?? 0) + (perks.extraTactical ?? 0);

  // Extra armour from perks raises effective health rather than granting plates,
  // so the HUD health bar stays the single source of truth.
  player.maxHealth = 100 + (perks.extraArmor ?? 0);
  player.health = player.maxHealth;
  player.armor = 0;

  player.fieldUpgradeCharge = 0;
  player.killstreakInventory = [];
}

/**
 * Sanity-check a loadout against a player's unlocks. Returns a corrected copy
 * rather than rejecting, because the class editor should never be able to
 * produce an unspawnable player.
 */
export function sanitizeLoadout(loadout: Loadout, playerLevel: number): Loadout {
  const out = { ...loadout };

  const primary = tryGetWeapon(out.primary);
  if (!primary || primary.unlockLevel > playerLevel) out.primary = DEFAULT_PRIMARY;

  const secondary = tryGetWeapon(out.secondary);
  if (!secondary || secondary.unlockLevel > playerLevel) out.secondary = DEFAULT_SECONDARY;

  out.primaryAttachments = (out.primaryAttachments ?? []).slice(0, MAX_EQUIPPED_ATTACHMENTS);
  out.secondaryAttachments = (out.secondaryAttachments ?? []).slice(0, MAX_EQUIPPED_ATTACHMENTS);

  if (!EQUIPMENT[out.lethal]) out.lethal = 'frag';
  if (!EQUIPMENT[out.tactical]) out.tactical = 'flashbang';

  // Perks must be one per tier, no duplicates, and actually unlocked.
  const seenTiers = new Set<number>();
  out.perks = (out.perks ?? []).filter((id) => {
    const perk = PERKS[id];
    if (!perk) return false;
    if (perk.unlockLevel > playerLevel) return false;
    if (seenTiers.has(perk.tier)) return false;
    seenTiers.add(perk.tier);
    return true;
  });

  out.killstreaks = (out.killstreaks ?? []).slice(0, 3);
  return out;
}

// ---------------------------------------------------------------------------
// Bot loadouts
// ---------------------------------------------------------------------------

/**
 * Generate a varied but sensible loadout for a bot.
 *
 * Bots picking uniformly at random from the whole arsenal produces a lobby full
 * of launcher-wielding oddities. Instead each bot gets an archetype, which also
 * gives the AI something to reason about: an SMG bot should push, a sniper bot
 * should hold an angle.
 */
export type BotArchetype = 'rifleman' | 'rusher' | 'sniper' | 'support' | 'scout';

export const BOT_ARCHETYPES: BotArchetype[] = [
  'rifleman',
  'rusher',
  'sniper',
  'support',
  'scout',
];

export function botLoadout(archetype: BotArchetype, pickIndex: number): Loadout {
  const base = defaultLoadout(archetype);

  // Deterministic selection: the caller supplies an index derived from the
  // world RNG, so a match replays identically.
  const pick = <T>(arr: readonly T[]): T => arr[pickIndex % arr.length]!;

  switch (archetype) {
    case 'rusher':
      base.primary = pick(['mp9k', 'vector9', 'skorp', 'p90x']);
      base.secondary = 'mp5c';
      base.lethal = 'semtex';
      base.tactical = 'flashbang';
      break;
    case 'sniper':
      base.primary = pick(['r700t', 'svk12', 'sp96']);
      base.secondary = 'gs17';
      base.lethal = 'claymore';
      base.tactical = 'smoke';
      break;
    case 'support':
      base.primary = pick(['m60e', 'rpd74', 'lw90']);
      base.secondary = 'p226';
      base.lethal = 'c4';
      base.tactical = 'stun';
      break;
    case 'scout':
      base.primary = pick(['dmr14', 'mk18', 'ebr7', 'aug77']);
      base.secondary = 'p226';
      base.lethal = 'throwing_knife';
      base.tactical = 'snapshot';
      break;
    default:
      base.primary = pick(['vk47', 'm5a1', 'gr63', 'ks12', 'fr55']);
      base.secondary = 'p226';
      base.lethal = 'frag';
      base.tactical = 'flashbang';
      break;
  }

  // Fall back if an archetype references a weapon that no longer exists.
  if (!tryGetWeapon(base.primary)) base.primary = DEFAULT_PRIMARY;
  if (!tryGetWeapon(base.secondary)) base.secondary = DEFAULT_SECONDARY;
  if (!EQUIPMENT[base.lethal]) base.lethal = 'frag';
  if (!EQUIPMENT[base.tactical]) base.tactical = 'flashbang';

  return base;
}

/** Preferred engagement distance for an archetype, used by the AI. */
export function archetypeRange(archetype: BotArchetype): { min: number; max: number } {
  switch (archetype) {
    case 'rusher':
      return { min: 0, max: 14 };
    case 'sniper':
      return { min: 28, max: 90 };
    case 'support':
      return { min: 10, max: 40 };
    case 'scout':
      return { min: 15, max: 50 };
    default:
      return { min: 5, max: 32 };
  }
}
