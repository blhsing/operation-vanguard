/**
 * Weapon state machine tests.
 *
 * The behaviours here are the ones a player notices within seconds of holding a
 * gun: that a semi-automatic fires once per click and again on the next click,
 * that an automatic keeps firing, that reloads take time and can be cancelled,
 * and that you cannot shoot the instant you stop sprinting.
 *
 * The semi-automatic case has its own test because it was genuinely broken: the
 * trigger edge was only latched on some code paths, so releasing the trigger
 * while the weapon was Ready never cleared it and every semi-auto and
 * bolt-action weapon fired exactly once per life. It compiled, it typechecked,
 * and the only symptom was that snipers scored no kills.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { TICK_DT } from '../src/shared/constants.js';
import { Rng } from '../src/shared/rng.js';
import {
  InputFlag,
  MoveState,
  Team,
  WeaponAction,
  createEmptyInput,
  type InputCommand,
  type PlayerState,
} from '../src/shared/types.js';
import { getWeapon } from '../src/shared/data/weapons.js';
import { FireMode, fireInterval, type WeaponDef } from '../src/shared/data/weapon-types.js';
import { createPlayer, createWeaponState, respawnPlayer } from '../src/shared/sim/world.js';
import { activeWeapon, resetWeaponRuntime, setTrigger, stepWeapon } from '../src/shared/sim/weapon-system.js';
import { vec3 } from '../src/shared/math.js';

let nextId = 1;

function armed(weaponId: string): { player: PlayerState; def: WeaponDef } {
  const def = getWeapon(weaponId);
  const player = createPlayer({ id: nextId++, name: 'T', team: Team.Allies, position: vec3() });
  respawnPlayer(player, vec3(), 0);
  player.weapons = [createWeaponState(def.id, def.magSize, def.startingReserve)];
  player.activeSlot = 0;
  player.moveState = MoveState.Idle;
  player.sprintOutTime = 0;
  resetWeaponRuntime(player.id);
  return { player, def };
}

function input(overrides: Partial<InputCommand> = {}): InputCommand {
  return { ...createEmptyInput(), dt: TICK_DT, ...overrides };
}

/**
 * Run the weapon for `seconds`, driving the trigger with a callback so tests can
 * express click patterns. Returns the total number of rounds fired.
 */
function run(
  player: PlayerState,
  def: WeaponDef,
  seconds: number,
  trigger: (tick: number, time: number) => boolean,
  startTime = 0,
): number {
  const rng = new Rng(42);
  const ticks = Math.round(seconds / TICK_DT);
  let fired = 0;
  let time = startTime;

  for (let i = 0; i < ticks; i++) {
    time += TICK_DT;
    const cmd = input({ buttons: trigger(i, time) ? InputFlag.Fire : 0 });
    setTrigger(player, cmd);
    const result = stepWeapon(player, cmd, time, TICK_DT, rng, () => def);
    fired += result.shotsFired;
  }
  return fired;
}

beforeEach(() => {
  nextId += 100;
});

describe('automatic weapons', () => {
  it('keep firing while the trigger is held', () => {
    const { player, def } = armed('vk47');
    const fired = run(player, def, 1.0, () => true);

    const expected = 1 / fireInterval(def);
    // Allow a round either side for tick alignment.
    expect(fired).toBeGreaterThanOrEqual(Math.floor(expected) - 1);
    expect(fired).toBeLessThanOrEqual(Math.ceil(expected) + 1);
  });

  it('respect the magazine and stop when empty', () => {
    const { player, def } = armed('vk47');
    const fired = run(player, def, 10, () => true);
    // It will auto-reload on empty, so it should fire more than one magazine but
    // never more than the ammo it started with.
    expect(fired).toBeGreaterThan(def.magSize);
    expect(fired).toBeLessThanOrEqual(def.magSize + def.startingReserve);
  });

  it('fire at the rate their RPM specifies, not the tick rate', () => {
    const fast = armed('vector9'); // 1200 rpm
    const slow = armed('gr63'); // 470 rpm

    const fastShots = run(fast.player, fast.def, 1.0, () => true);
    const slowShots = run(slow.player, slow.def, 1.0, () => true);

    expect(fastShots).toBeGreaterThan(slowShots * 2);
  });
});

describe('semi-automatic weapons', () => {
  it('fire exactly once when the trigger is held down', () => {
    const { player, def } = armed('sa58');
    expect(def.fireMode).toBe(FireMode.Semi);

    const fired = run(player, def, 2.0, () => true);
    expect(fired).toBe(1);
  });

  it('fire again on every subsequent click — the regression that broke snipers', () => {
    const { player, def } = armed('sa58');

    // Click at 4 Hz for three seconds: press for two ticks, release for the rest.
    const clickPeriod = Math.round(0.25 / TICK_DT);
    const fired = run(player, def, 3.0, (tick) => tick % clickPeriod < 2);

    // Roughly twelve clicks in three seconds; the weapon's own 400rpm cycle is
    // faster than that, so every click should produce a round.
    expect(fired).toBeGreaterThanOrEqual(10);
  });

  it('cannot be clicked faster than the weapon cycles', () => {
    const { player, def } = armed('sa58');
    const interval = fireInterval(def);

    // Click every single tick — far faster than the 400rpm action allows.
    const fired = run(player, def, 1.0, (tick) => tick % 2 === 0);
    const maxPossible = Math.ceil(1.0 / interval) + 1;

    expect(fired).toBeLessThanOrEqual(maxPossible);
  });
});

describe('bolt-action weapons', () => {
  it('fire once per click and must rechamber between shots', () => {
    const { player, def } = armed('r700t');
    expect(def.fireMode).toBe(FireMode.BoltAction);

    const heldDown = run(player, def, 2.0, () => true);
    expect(heldDown).toBe(1);

    const { player: p2, def: d2 } = armed('r700t');
    const clickPeriod = Math.round(0.6 / TICK_DT);
    const clicked = run(p2, d2, 4.0, (tick) => tick % clickPeriod < 2);
    // 48 rpm = 1.25s per shot, so ~3 shots in 4 seconds however fast you click.
    expect(clicked).toBeGreaterThanOrEqual(2);
    expect(clicked).toBeLessThanOrEqual(4);
  });
});

describe('burst weapons', () => {
  it('fire a full burst from one trigger pull', () => {
    const { player, def } = armed('fr55');
    expect(def.fireMode).toBe(FireMode.Burst);

    // A single short press must still deliver the whole burst.
    const fired = run(player, def, 1.0, (tick) => tick < 2);
    expect(fired).toBe(def.burstCount);
  });

  it('pause between bursts even when the trigger is held', () => {
    const { player, def } = armed('fr55');
    const fired = run(player, def, 1.0, () => true);
    // Held down it should not become a full-auto weapon.
    const burstsPerSecond = 1 / ((def.burstCount - 1) * fireInterval(def) + def.burstDelay);
    expect(fired).toBeLessThanOrEqual(Math.ceil(burstsPerSecond) * def.burstCount + def.burstCount);
  });
});

describe('reloading', () => {
  it('takes time and then refills the magazine', () => {
    const { player, def } = armed('vk47');
    const state = activeWeapon(player)!;
    state.ammoInMag = 5;

    const rng = new Rng(1);
    let time = 0;
    // Press reload for one tick, then wait.
    for (let i = 0; i < Math.round(0.1 / TICK_DT); i++) {
      time += TICK_DT;
      const cmd = input({ buttons: i === 0 ? InputFlag.Reload : 0 });
      setTrigger(player, cmd);
      stepWeapon(player, cmd, time, TICK_DT, rng, () => def);
    }
    expect(player.action).toBe(WeaponAction.Reloading);
    expect(state.ammoInMag).toBe(5);

    for (let i = 0; i < Math.round(4 / TICK_DT); i++) {
      time += TICK_DT;
      const cmd = input();
      setTrigger(player, cmd);
      stepWeapon(player, cmd, time, TICK_DT, rng, () => def);
    }
    expect(player.action).toBe(WeaponAction.Ready);
    expect(state.ammoInMag).toBe(def.magSize);
  });

  it('draws from the reserve, not from thin air', () => {
    const { player, def } = armed('vk47');
    const state = activeWeapon(player)!;
    const before = state.ammoInMag + state.ammoReserve;
    state.ammoInMag = 0;

    const rng = new Rng(1);
    let time = 0;
    for (let i = 0; i < Math.round(6 / TICK_DT); i++) {
      time += TICK_DT;
      const cmd = input({ buttons: i === 0 ? InputFlag.Reload : 0 });
      setTrigger(player, cmd);
      stepWeapon(player, cmd, time, TICK_DT, rng, () => def);
    }

    const after = state.ammoInMag + state.ammoReserve;
    // Total ammo is conserved: we started the reload having spent a magazine.
    expect(after).toBeLessThanOrEqual(before);
    expect(state.ammoInMag).toBe(def.magSize);
  });
});

describe('sprint-out', () => {
  it('blocks firing for a moment after sprinting stops', () => {
    const { player, def } = armed('vk47');
    player.moveState = MoveState.Sprint;

    const rng = new Rng(1);
    let time = 0;

    // Sprint for a while with the trigger held: nothing should come out.
    let fired = 0;
    for (let i = 0; i < 20; i++) {
      time += TICK_DT;
      const cmd = input({ buttons: InputFlag.Fire });
      setTrigger(player, cmd);
      fired += stepWeapon(player, cmd, time, TICK_DT, rng, () => def).shotsFired;
    }
    expect(fired).toBe(0);

    // Stop sprinting: the weapon still needs its sprint-out time.
    player.moveState = MoveState.Walk;
    let firstShotAt = -1;
    for (let i = 0; i < 40; i++) {
      time += TICK_DT;
      const cmd = input({ buttons: InputFlag.Fire });
      setTrigger(player, cmd);
      if (stepWeapon(player, cmd, time, TICK_DT, rng, () => def).shotsFired > 0) {
        firstShotAt = i * TICK_DT;
        break;
      }
    }

    expect(firstShotAt).toBeGreaterThan(0);
    expect(firstShotAt).toBeLessThan(def.handling.sprintOutTime + 0.1);
  });
});

describe('aiming', () => {
  it('transitions to fully aimed in the weapon`s ADS time', () => {
    const { player, def } = armed('vk47');
    const rng = new Rng(1);
    let time = 0;

    const ticks = Math.round((def.handling.adsTime + 0.05) / TICK_DT);
    for (let i = 0; i < ticks; i++) {
      time += TICK_DT;
      const cmd = input({ buttons: InputFlag.Ads });
      setTrigger(player, cmd);
      stepWeapon(player, cmd, time, TICK_DT, rng, () => def);
    }
    expect(player.adsProgress).toBeGreaterThan(0.98);
  });

  it('comes out of aim faster than it goes in', () => {
    const { player, def } = armed('r700t');
    const rng = new Rng(1);
    let time = 0;

    for (let i = 0; i < Math.round(1.5 / TICK_DT); i++) {
      time += TICK_DT;
      const cmd = input({ buttons: InputFlag.Ads });
      setTrigger(player, cmd);
      stepWeapon(player, cmd, time, TICK_DT, rng, () => def);
    }
    expect(player.adsProgress).toBe(1);

    let ticksToRelease = 0;
    while (player.adsProgress > 0 && ticksToRelease < 500) {
      time += TICK_DT;
      const cmd = input();
      setTrigger(player, cmd);
      stepWeapon(player, cmd, time, TICK_DT, rng, () => def);
      ticksToRelease++;
    }
    expect(ticksToRelease * TICK_DT).toBeLessThan(def.handling.adsTime);
  });
});
