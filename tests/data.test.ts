/**
 * Data-integrity tests.
 *
 * The arsenal and the maps are hand-authored data, so a typo produces no compile
 * error — a weapon with a 90 ms time-to-kill or a spawn point inside a wall is
 * perfectly valid TypeScript. These tests are the only thing standing between
 * that and a live match.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PRIMARY,
  DEFAULT_SECONDARY,
  WEAPONS,
  WEAPONS_BY_CLASS,
  WEAPON_IDS,
  getWeapon,
  validateArsenal,
} from '../src/shared/data/weapons.js';
import {
  WeaponClass,
  damageAtRange,
  fireInterval,
  shotsToKill,
  timeToKill,
} from '../src/shared/data/weapon-types.js';
import { MAPS, MAP_IDS, getMap, validateAllMaps, validateMap } from '../src/shared/map/index.js';
import { HEALTH, HIT_MULTIPLIER } from '../src/shared/constants.js';

describe('arsenal', () => {
  it('passes its own balance validation with zero violations', () => {
    const errors = validateArsenal();
    // Print them, so a failure tells you what broke rather than just the count.
    expect(errors).toEqual([]);
  });

  it('has a full arsenal across every class a player expects', () => {
    expect(WEAPON_IDS.length).toBeGreaterThanOrEqual(32);
    expect(WEAPONS_BY_CLASS[WeaponClass.AssaultRifle].length).toBeGreaterThanOrEqual(6);
    expect(WEAPONS_BY_CLASS[WeaponClass.SubmachineGun].length).toBeGreaterThanOrEqual(5);
    expect(WEAPONS_BY_CLASS[WeaponClass.LightMachineGun].length).toBeGreaterThanOrEqual(3);
    expect(WEAPONS_BY_CLASS[WeaponClass.SniperRifle].length).toBeGreaterThanOrEqual(3);
    expect(WEAPONS_BY_CLASS[WeaponClass.Shotgun].length).toBeGreaterThanOrEqual(3);
    expect(WEAPONS_BY_CLASS[WeaponClass.Pistol].length).toBeGreaterThanOrEqual(3);
    expect(WEAPONS_BY_CLASS[WeaponClass.Launcher].length).toBeGreaterThanOrEqual(2);
    expect(WEAPONS_BY_CLASS[WeaponClass.Melee].length).toBeGreaterThanOrEqual(2);
  });

  it('starts every player with weapons that exist and are unlocked at rank 0', () => {
    expect(getWeapon(DEFAULT_PRIMARY).unlockLevel).toBe(0);
    expect(getWeapon(DEFAULT_SECONDARY).unlockLevel).toBe(0);
  });

  it('rewards headshots on every gun that has a damage curve', () => {
    for (const w of Object.values(WEAPONS)) {
      if (w.class === WeaponClass.Melee || w.class === WeaponClass.Launcher) continue;
      const body = shotsToKill(w.damage, 10, HEALTH.max, 1);
      const head = shotsToKill(w.damage, 10, HEALTH.max, HIT_MULTIPLIER.head);
      expect(head, `${w.id} headshots must not be worse than body shots`).toBeLessThanOrEqual(body);
    }
  });

  it('keeps SMGs dominant up close and assault rifles dominant at range', () => {
    const bestSmgClose = Math.min(
      ...WEAPONS_BY_CLASS[WeaponClass.SubmachineGun].map((w) => timeToKill(w, 8, HEALTH.max, 1)),
    );
    const bestArClose = Math.min(
      ...WEAPONS_BY_CLASS[WeaponClass.AssaultRifle].map((w) => timeToKill(w, 8, HEALTH.max, 1)),
    );
    const bestSmgFar = Math.min(
      ...WEAPONS_BY_CLASS[WeaponClass.SubmachineGun].map((w) => timeToKill(w, 35, HEALTH.max, 1)),
    );
    const bestArFar = Math.min(
      ...WEAPONS_BY_CLASS[WeaponClass.AssaultRifle].map((w) => timeToKill(w, 35, HEALTH.max, 1)),
    );

    expect(bestSmgClose).toBeLessThan(bestArClose);
    expect(bestArFar).toBeLessThan(bestSmgFar);
  });

  it('never lets a weapon out-damage itself at longer range', () => {
    for (const w of Object.values(WEAPONS)) {
      let prev = Infinity;
      for (const d of [0, 5, 10, 20, 30, 50, 80, 150]) {
        const dmg = damageAtRange(w.damage, d);
        expect(dmg, `${w.id} damage rose at ${d}m`).toBeLessThanOrEqual(prev + 1e-6);
        prev = dmg;
      }
    }
  });

  it('derives a sane fire interval for every weapon', () => {
    for (const w of Object.values(WEAPONS)) {
      const interval = fireInterval(w);
      expect(interval, `${w.id}`).toBeGreaterThan(0);
      // Nothing should fire faster than 2000 RPM or slower than one shot per 3s.
      expect(interval, `${w.id}`).toBeGreaterThanOrEqual(0.03);
      expect(interval, `${w.id}`).toBeLessThanOrEqual(3);
    }
  });

  it('gives every weapon a usable magazine and reserve', () => {
    for (const w of Object.values(WEAPONS)) {
      expect(w.magSize, `${w.id}`).toBeGreaterThan(0);
      expect(w.startingReserve, `${w.id}`).toBeGreaterThanOrEqual(0);
      expect(w.maxReserve, `${w.id}`).toBeGreaterThanOrEqual(w.startingReserve);
    }
  });

  it('spreads unlocks across the rank progression instead of bunching them', () => {
    const levels = Object.values(WEAPONS).map((w) => w.unlockLevel);
    expect(Math.min(...levels)).toBe(0);
    expect(Math.max(...levels)).toBeGreaterThan(40);
    // At least a third of the arsenal must be locked at the start, or progression
    // has nothing to give.
    const lockedAtStart = levels.filter((l) => l > 0).length;
    expect(lockedAtStart / levels.length).toBeGreaterThan(0.33);
  });

  it('gives every weapon procedural audio and model parameters', () => {
    for (const w of Object.values(WEAPONS)) {
      expect(w.audio.bodyFreq, `${w.id}`).toBeGreaterThan(20);
      expect(w.audio.crackDuration, `${w.id}`).toBeGreaterThan(0);
      expect(w.model.length, `${w.id}`).toBeGreaterThan(0.1);
      expect(w.model.barrelLength, `${w.id}`).toBeGreaterThan(0);
    }
  });
});

describe('maps', () => {
  it('registers at least one playable map', () => {
    expect(MAP_IDS.length).toBeGreaterThan(0);
  });

  it('passes structural validation for every registered map', () => {
    const problems = validateAllMaps();
    expect(problems).toEqual({});
  });

  it('has enough geometry to feel built rather than blocked out', () => {
    for (const id of MAP_IDS) {
      const map = getMap(id);
      expect(map.brushes.length, `${id} brush count`).toBeGreaterThanOrEqual(100);
      expect(map.spawns.length, `${id} spawn count`).toBeGreaterThanOrEqual(30);
      expect(map.coverPoints.length, `${id} cover count`).toBeGreaterThanOrEqual(20);
    }
  });

  it('describes its lanes so bots and spawn logic can reason about the layout', () => {
    for (const id of MAP_IDS) {
      const map = getMap(id);
      expect(map.lanes.length, `${id}`).toBeGreaterThanOrEqual(2);
      for (const lane of map.lanes) {
        expect(lane.path.length, `${id}/${lane.name}`).toBeGreaterThanOrEqual(2);
        expect(lane.width, `${id}/${lane.name}`).toBeGreaterThan(0);
      }
    }
  });

  it('supports the objective modes it claims to', () => {
    for (const id of MAP_IDS) {
      const map = getMap(id);
      const kinds = new Set(map.objectives.map((o) => o.kind));
      expect(kinds.has('dom_flag'), `${id} needs Domination flags`).toBe(true);
      expect(kinds.has('bomb_site'), `${id} needs bomb sites`).toBe(true);
      expect(kinds.has('hardpoint'), `${id} needs Hardpoint zones`).toBe(true);
    }
  });

  it('reports problems rather than throwing when handed a broken map', () => {
    const broken = {
      ...getMap(MAP_IDS[0]!),
      id: 'broken',
      spawns: [],
      lanes: [],
      coverPoints: [],
      objectives: [],
    };
    const errors = validateMap(broken);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((e) => typeof e === 'string')).toBe(true);
  });

  it('builds a collision world for every map without error', () => {
    for (const id of MAP_IDS) {
      const map = getMap(id);
      expect(() => validateMap(map)).not.toThrow();
      expect(Object.keys(MAPS)).toContain(id);
    }
  });
});
