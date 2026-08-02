/**
 * Movement and collision integration tests.
 *
 * These exist because every system above them assumes a player who lands on the
 * floor, stops at walls, and stays where the server put them. A regression here
 * is invisible in a screenshot and catastrophic in a match, so each test states
 * the player-facing guarantee it protects rather than just poking a function.
 */

import { describe, expect, it } from 'vitest';

import { BrushCollisionWorld } from '../src/shared/collision/brush-collision.js';
import { CollisionLayer, type QueryFilter } from '../src/shared/collision/collision-types.js';
import { MOVE, PLAYER_RADIUS, STANCE_HEIGHT, TICK_DT } from '../src/shared/constants.js';
import { box, cylinder, ramp, type Brush } from '../src/shared/map/map-types.js';
import { vec3 } from '../src/shared/math.js';
import { InputFlag, MoveState, Stance, SurfaceType, Team, type InputCommand } from '../src/shared/types.js';
import { createEmptyInput } from '../src/shared/types.js';
import { currentHeight, horizontalSpeed, stepMovement } from '../src/shared/sim/movement.js';
import { createPlayer, respawnPlayer } from '../src/shared/sim/world.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Two fixtures, deliberately kept apart.
 *
 * Locomotion tests need genuinely empty ground: if an obstacle sits anywhere in
 * the walking lane, a speed assertion silently becomes a collision assertion and
 * stops testing what its name claims.
 */
function flatWorld(): BrushCollisionWorld {
  return new BrushCollisionWorld([box(vec3(0, -0.5, 0), vec3(200, 1, 200), SurfaceType.Concrete)], {
    min: vec3(-100, -5, -100),
    max: vec3(100, 20, 100),
  });
}

/** Floor plus obstacles, each in its own lane so tests can't interfere. */
function obstacleBrushes(): Brush[] {
  return [
    // Floor: top face at y = 0.
    box(vec3(0, -0.5, 0), vec3(120, 1, 120), SurfaceType.Concrete),
    // Wall lane: a tall wall at x = 5 running along Z.
    box(vec3(5, 2, 0), vec3(0.5, 4, 40), SurfaceType.Concrete),
    // Step lane (z = -30): a long 0.3 m platform, below MOVE.stepHeight.
    // Long enough that a walking player ends up standing on it.
    box(vec3(0, 0.15, -40), vec3(20, 0.3, 20), SurfaceType.Concrete),
    // Crate lane (z = +30): 1.2 m tall, above step height, must block.
    box(vec3(0, 0.6, 30), vec3(20, 1.2, 1), SurfaceType.Wood),
    // Ramp lane: rises toward +x from x = 10 to x = 16.
    ramp(vec3(13, 1, 8), vec3(6, 2, 6), '+x', SurfaceType.Concrete),
  ];
}

function obstacleWorld(): BrushCollisionWorld {
  return new BrushCollisionWorld(obstacleBrushes(), {
    min: vec3(-60, -5, -60),
    max: vec3(60, 20, 60),
  });
}

function makePlayer(x = 0, y = 2, z = 0) {
  const p = createPlayer({ id: 1, name: 'Test', team: Team.Allies, position: vec3(x, y, z) });
  respawnPlayer(p, vec3(x, y, z), 0);
  return p;
}

function input(overrides: Partial<InputCommand> = {}): InputCommand {
  return { ...createEmptyInput(), dt: TICK_DT, ...overrides };
}

/** Run the movement controller for `seconds` of simulated time. */
function simulate(
  player: ReturnType<typeof makePlayer>,
  world: BrushCollisionWorld,
  cmd: InputCommand,
  seconds: number,
): void {
  const ticks = Math.round(seconds / TICK_DT);
  for (let i = 0; i < ticks; i++) {
    stepMovement(player, cmd, world, TICK_DT);
  }
}

const MOVEMENT_FILTER: QueryFilter = { layers: CollisionLayer.Movement };

// ---------------------------------------------------------------------------

describe('collision world', () => {
  it('reports the floor beneath a point so spawns can be placed on the ground', () => {
    const world = obstacleWorld();
    expect(world.groundHeightAt(0, 0, 10, 20)).toBeCloseTo(0, 2);
  });

  it('returns -Infinity where there is no ground, so spawn logic can reject the spot', () => {
    const world = obstacleWorld();
    expect(world.groundHeightAt(100, 100, 10, 20)).toBe(-Infinity);
  });

  it('blocks line of sight through a wall', () => {
    const world = obstacleWorld();
    const sight: QueryFilter = { layers: CollisionLayer.Sight };
    // Straight through the wall at x = 5.
    expect(world.isVisible(vec3(0, 1.5, 0), vec3(10, 1.5, 0), sight)).toBe(false);
    // Around it: the wall spans z in [-20, 20], so z = 25 is past its end.
    expect(world.isVisible(vec3(0, 1.5, 25), vec3(10, 1.5, 25), sight)).toBe(true);
  });

  it('never reports a sweep fraction outside [0, 1]', () => {
    const world = obstacleWorld();
    const out = {
      hit: false, fraction: 1, point: vec3(), normal: vec3(),
      surface: SurfaceType.Concrete, entity: 0, brushIndex: -1, startedSolid: false,
    };
    for (const delta of [vec3(20, 0, 0), vec3(-20, 0, 0), vec3(0, -50, 0), vec3(0.001, 0, 0)]) {
      world.sweepCapsule(vec3(0, 1, 0), STANCE_HEIGHT.stand, PLAYER_RADIUS, delta, MOVEMENT_FILTER, out);
      expect(out.fraction).toBeGreaterThanOrEqual(0);
      expect(out.fraction).toBeLessThanOrEqual(1);
    }
  });

  /**
   * Brushing a crate corner must not weld you to it.
   *
   * The capsule test is round, so a player can touch the vertical *edge* of a
   * crate while standing outside both of its faces. The escape from an edge is
   * radially away from it. Reporting a face normal instead hands the movement
   * controller a direction perpendicular to nothing it is touching, and when
   * that direction happens to be perpendicular to the way the player is running,
   * sliding along it removes no motion at all: the next sweep finds the same
   * contact at the same fraction, and the player sprints on the spot with the
   * position bit-identical every tick.
   *
   * The geometry below is lifted from where it was found — a 1 m crate on
   * Shipment Yard, a bot tangent to its corner at exactly the capsule radius,
   * running past it. Bots wear this worst because they hold one input until they
   * arrive, so "arrive" never comes; a person twitches the mouse and never
   * notices there was a bug.
   */
  it('slides around a crate corner instead of welding the player to it', () => {
    const world = new BrushCollisionWorld(
      [
        box(vec3(0, -0.5, 0), vec3(60, 1, 60), SurfaceType.Concrete),
        box(vec3(-9.5, 0.5, 9.5), vec3(1, 1, 1), SurfaceType.Wood),
      ],
      { min: vec3(-30, -5, -30), max: vec3(30, 20, 30) },
    );

    // Tangent to the crate's corner: exactly PLAYER_RADIUS from (-10, 10).
    const offset = PLAYER_RADIUS / Math.SQRT2;
    const player = createPlayer({
      id: 1,
      name: 'Grazer',
      team: Team.Allies,
      position: vec3(-10 - offset, 0, 10 + offset),
    });
    respawnPlayer(player, vec3(-10 - offset, 0, 10 + offset), 0);

    // Run straight down -Z, parallel to the crate's +X face — the direction the
    // bogus face normal cannot remove any of.
    const startZ = player.position.z;
    simulate(player, world, input({ moveForward: 1, yaw: 0 }), 1.5);

    expect(
      startZ - player.position.z,
      'a player grazing a corner at full speed must get past it',
    ).toBeGreaterThan(3);
  });

  /**
   * A cylinder shorter than your step is a step, not a wall.
   *
   * Boxes have always offered an upward escape when the capsule is near the top
   * face — that is what turns a wedged player into one standing on a crate.
   * Cylinders only ever offered a radial one, so landing on top of a cylinder
   * reported a horizontal contact normal, and the step-up in the movement
   * controller accepts a step only when the surface it lands on faces upward. A
   * cylinder was therefore unclimbable at any height, and a player walking at an
   * ankle-high one stopped dead at its rim.
   *
   * Highrise's helipad is a twenty-two metre cylinder in the centre of the map,
   * and this is why nothing could get onto it — which made the final campaign
   * mission, whose last two objectives both stand on that surface, impossible
   * rather than difficult.
   */
  it('steps up onto a low cylinder instead of stopping at its rim', () => {
    const world = new BrushCollisionWorld(
      [
        box(vec3(0, -0.5, 0), vec3(60, 1, 60), SurfaceType.Concrete),
        // 0.3 m tall, comfortably under MOVE.stepHeight.
        cylinder(vec3(0, 0.15, 0), 6, 0.3, SurfaceType.Concrete, { segments: 24 }),
      ],
      { min: vec3(-30, -5, -30), max: vec3(30, 20, 30) },
    );

    const player = makePlayer(0, 0.2, 12);
    // yaw 0 faces -Z, straight at the cylinder.
    simulate(player, world, input({ moveForward: 1, yaw: 0 }), 2.5);

    expect(
      player.position.y,
      `a player walked into a ${MOVE.stepHeight > 0.3 ? 'steppable' : 'tall'} cylinder and never got on top of it`,
    ).toBeGreaterThan(0.25);
    expect(Math.abs(player.position.z), 'should have walked onto the disc').toBeLessThan(6);
  });
});

describe('gravity and ground', () => {
  it('a player dropped in the air lands on the floor and stops falling', () => {
    const world = flatWorld();
    const p = makePlayer(0, 6, 0);

    simulate(p, world, input(), 3);

    expect(p.onGround).toBe(true);
    expect(p.position.y).toBeCloseTo(0, 1);
    expect(Math.abs(p.velocity.y)).toBeLessThan(3);
  });

  it('a player standing still does not sink through the floor over time', () => {
    const world = flatWorld();
    const p = makePlayer(0, 0.05, 0);

    simulate(p, world, input(), 10);

    expect(p.position.y).toBeGreaterThan(-0.05);
    expect(p.position.y).toBeLessThan(0.15);
  });
});

describe('walking', () => {
  it('reaches a steady speed close to the tuned base speed', () => {
    const world = flatWorld();
    const p = makePlayer(0, 0.05, 0);
    simulate(p, world, input(), 0.5); // settle

    simulate(p, world, input({ moveForward: 1 }), 1.5);

    const speed = horizontalSpeed(p);
    expect(speed).toBeGreaterThan(MOVE.baseSpeed * 0.85);
    expect(speed).toBeLessThan(MOVE.baseSpeed * 1.15);
  });

  it('stops almost immediately when input is released — the COD "snap stop"', () => {
    const world = flatWorld();
    const p = makePlayer(0, 0.05, 0);
    simulate(p, world, input({ moveForward: 1 }), 1.5);
    expect(horizontalSpeed(p)).toBeGreaterThan(3);

    simulate(p, world, input(), 0.25);

    expect(horizontalSpeed(p)).toBeLessThan(0.6);
  });

  it('does not move faster diagonally than straight ahead', () => {
    const world = flatWorld();

    const straight = makePlayer(0, 0.05, 0);
    simulate(straight, world, input(), 0.5);
    simulate(straight, world, input({ moveForward: 1 }), 2);

    const diagonal = makePlayer(0, 0.05, 0);
    simulate(diagonal, world, input(), 0.5);
    simulate(diagonal, world, input({ moveForward: 1, moveRight: 1 }), 2);

    expect(horizontalSpeed(diagonal)).toBeLessThanOrEqual(horizontalSpeed(straight) + 0.05);
  });

  it('sprinting is meaningfully faster than walking', () => {
    const world = flatWorld();

    const walker = makePlayer(0, 0.05, 0);
    simulate(walker, world, input(), 0.5);
    simulate(walker, world, input({ moveForward: 1 }), 2);

    const sprinter = makePlayer(0, 0.05, 0);
    simulate(sprinter, world, input(), 0.5);
    simulate(sprinter, world, input({ moveForward: 1, buttons: InputFlag.Sprint }), 2);

    expect(horizontalSpeed(sprinter)).toBeGreaterThan(horizontalSpeed(walker) * 1.25);
  });

  it('moving backwards is slower than moving forwards', () => {
    const world = flatWorld();

    const fwd = makePlayer(0, 0.05, 0);
    simulate(fwd, world, input(), 0.5);
    simulate(fwd, world, input({ moveForward: 1 }), 2);

    const back = makePlayer(0, 0.05, 0);
    simulate(back, world, input(), 0.5);
    simulate(back, world, input({ moveForward: -1 }), 2);

    expect(horizontalSpeed(back)).toBeLessThan(horizontalSpeed(fwd) * 0.95);
  });
});

describe('walls', () => {
  it('a player running at a wall is stopped by it and does not pass through', () => {
    const world = obstacleWorld();
    const p = makePlayer(0, 0.05, 0);
    simulate(p, world, input(), 0.5);

    // Face +x (yaw = -PI/2 points toward +x under our convention) and run.
    simulate(p, world, input({ moveForward: 1, yaw: -Math.PI / 2, buttons: InputFlag.Sprint }), 4);

    // The wall's near face is at x = 4.75; a capsule of radius r stops before it.
    expect(p.position.x).toBeLessThan(5 - PLAYER_RADIUS + 0.1);
  });

  it('sliding along a wall preserves forward progress instead of sticking', () => {
    const world = obstacleWorld();
    const p = makePlayer(4, 0.05, -8);
    simulate(p, world, input(), 0.5);

    const startZ = p.position.z;
    // Push diagonally into the wall: mostly +z, partly +x.
    simulate(
      p,
      world,
      input({ moveForward: 1, moveRight: 0.6, yaw: Math.PI, buttons: InputFlag.Sprint }),
      2,
    );

    // We should have travelled along Z despite being pressed against the wall.
    expect(Math.abs(p.position.z - startZ)).toBeGreaterThan(3);
  });
});

describe('steps and ramps', () => {
  it('walks up a step shorter than the step height without jumping', () => {
    const world = obstacleWorld();
    const p = makePlayer(0, 0.05, -25);
    simulate(p, world, input(), 0.5);

    // Walk toward -z (yaw = 0 faces -z) onto the 0.3 m platform spanning z -50..-30.
    simulate(p, world, input({ moveForward: 1, yaw: 0 }), 3);

    expect(p.position.z).toBeLessThan(-31);
    expect(p.position.y).toBeGreaterThan(0.2);
    expect(p.onGround).toBe(true);
  });

  it('is blocked by an obstacle taller than the step height', () => {
    const world = obstacleWorld();
    const p = makePlayer(0, 0.05, 25);
    simulate(p, world, input(), 0.5);

    // Sprint toward +z (yaw = PI) into the 1.2 m crate wall at z = 30.
    simulate(p, world, input({ moveForward: 1, yaw: Math.PI, buttons: InputFlag.Sprint }), 3);

    // The crate spans z in [29.5, 30.5]; a capsule must stop short of its near face.
    expect(p.position.z).toBeLessThan(29.5);
    expect(p.position.y).toBeLessThan(0.2);
  });

  it('gains height walking up a ramp and reports a sloped ground normal', () => {
    const world = obstacleWorld();
    const p = makePlayer(10.5, 2.5, 8);
    simulate(p, world, input(), 1.0);

    const startY = p.position.y;
    // Stop short of the ramp's far edge at x = 16, so we measure the climb
    // rather than the landing after running off the top.
    simulate(p, world, input({ moveForward: 1, yaw: -Math.PI / 2 }), 1.2);

    expect(p.position.x).toBeGreaterThan(11.5);
    expect(p.position.x).toBeLessThan(16);
    expect(p.position.y).toBeGreaterThan(startY + 0.5);
    expect(p.onGround).toBe(true);
    // A ramp normal must not be perfectly vertical, or slope logic can't see it.
    expect(p.groundNormal.y).toBeLessThan(0.999);
    expect(p.groundNormal.y).toBeGreaterThan(0.5);
  });
});

describe('jumping', () => {
  it('leaves the ground and returns to it', () => {
    const world = flatWorld();
    const p = makePlayer(0, 0.05, 0);
    simulate(p, world, input(), 0.5);

    stepMovement(p, input({ buttons: InputFlag.Jump }), world, TICK_DT);
    simulate(p, world, input({ buttons: InputFlag.Jump }), 0.2);
    expect(p.onGround).toBe(false);
    expect(p.position.y).toBeGreaterThan(0.3);

    simulate(p, world, input(), 2);
    expect(p.onGround).toBe(true);
    expect(p.position.y).toBeCloseTo(0, 1);
  });

  it('cannot jump again mid-air', () => {
    const world = flatWorld();
    const p = makePlayer(0, 0.05, 0);
    simulate(p, world, input(), 0.5);

    simulate(p, world, input({ buttons: InputFlag.Jump }), 0.3);
    const peak = p.position.y;
    simulate(p, world, input({ buttons: InputFlag.Jump }), 0.3);

    // Without a double jump the player must be descending, not climbing.
    expect(p.position.y).toBeLessThan(peak + MOVE.jumpVelocity * 0.3);
  });
});

describe('stance', () => {
  it('crouching lowers the collision height', () => {
    const world = flatWorld();
    const p = makePlayer(0, 0.05, 0);
    simulate(p, world, input(), 0.5);
    const standing = currentHeight(p);

    simulate(p, world, input({ buttons: InputFlag.Crouch }), 1);

    expect(p.stance).toBe(Stance.Crouch);
    expect(currentHeight(p)).toBeLessThan(standing);
    expect(currentHeight(p)).toBeCloseTo(STANCE_HEIGHT.crouch, 2);
  });

  it('crouching slows the player down', () => {
    const world = flatWorld();

    const upright = makePlayer(0, 0.05, 0);
    simulate(upright, world, input(), 0.5);
    simulate(upright, world, input({ moveForward: 1 }), 2);

    const crouched = makePlayer(0, 0.05, 0);
    simulate(crouched, world, input(), 0.5);
    simulate(crouched, world, input({ moveForward: 1, buttons: InputFlag.Crouch }), 2);

    expect(horizontalSpeed(crouched)).toBeLessThan(horizontalSpeed(upright) * 0.75);
  });
});

describe('sliding', () => {
  it('a sprinting player who crouches slides and gains speed', () => {
    const world = flatWorld();
    const p = makePlayer(0, 0.05, 0);
    simulate(p, world, input(), 0.5);
    simulate(p, world, input({ moveForward: 1, buttons: InputFlag.Sprint }), 1.5);
    const sprintSpeed = horizontalSpeed(p);

    stepMovement(
      p,
      input({ moveForward: 1, buttons: InputFlag.Sprint | InputFlag.Crouch }),
      world,
      TICK_DT,
    );

    expect(p.moveState).toBe(MoveState.Slide);
    expect(horizontalSpeed(p)).toBeGreaterThan(sprintSpeed);
  });

  it('a slide ends and does not last forever', () => {
    const world = flatWorld();
    const p = makePlayer(0, 0.05, 0);
    simulate(p, world, input(), 0.5);
    simulate(p, world, input({ moveForward: 1, buttons: InputFlag.Sprint }), 1.5);
    simulate(
      p,
      world,
      input({ moveForward: 1, buttons: InputFlag.Sprint | InputFlag.Crouch }),
      2.5,
    );

    expect(p.moveState).not.toBe(MoveState.Slide);
  });
});

describe('robustness', () => {
  it('never produces a NaN position, whatever the input', () => {
    const world = flatWorld();
    const p = makePlayer(0, 2, 0);

    // Deliberately hostile input: extreme values, every button at once.
    for (let i = 0; i < 600; i++) {
      stepMovement(
        p,
        input({
          moveForward: i % 3 === 0 ? 1e6 : -1,
          moveRight: i % 2 === 0 ? -1e6 : 1,
          yaw: i * 7.3,
          pitch: i * 3.1,
          buttons: 0xffff,
        }),
        world,
        TICK_DT,
      );
      expect(Number.isFinite(p.position.x)).toBe(true);
      expect(Number.isFinite(p.position.y)).toBe(true);
      expect(Number.isFinite(p.position.z)).toBe(true);
    }
  });

  it('is deterministic — identical inputs produce identical positions', () => {
    const runOnce = () => {
      const world = flatWorld();
      const p = makePlayer(0, 2, 0);
      for (let i = 0; i < 300; i++) {
        stepMovement(
          p,
          input({
            moveForward: Math.sin(i * 0.11),
            moveRight: Math.cos(i * 0.07),
            yaw: i * 0.03,
            buttons: i % 40 === 0 ? InputFlag.Jump : InputFlag.Sprint,
          }),
          world,
          TICK_DT,
        );
      }
      return { ...p.position };
    };

    const a = runOnce();
    const b = runOnce();
    expect(a.x).toBe(b.x);
    expect(a.y).toBe(b.y);
    expect(a.z).toBe(b.z);
  });
});
