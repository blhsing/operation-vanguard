/**
 * Zombie behaviour.
 *
 * A zombie has exactly one idea: reach the nearest living player and hit them.
 * Everything interesting about the mode comes from the fact that they never stop
 * having it — you are not out-thinking them, you are out-running them, and the
 * moment you stop moving you lose.
 *
 * They drive the simulation through the same `InputCommand` a human sends, so
 * they collide, get stuck on the same corners, and are shot with the same
 * hitboxes. That is a deliberate constraint: it means a zombie can never walk
 * through a door a player cannot, and there is no second movement code path to
 * keep in sync.
 *
 * The one place they cheat is target *selection*: they always know where the
 * nearest player is. Giving zombies perception would make them lose you, and a
 * horde you can hide from is not a horde.
 */

import { TICK_DT } from '../constants.js';
import {
  angleApproach,
  clamp,
  forwardToYaw,
  v3distance,
  v3distanceXZ,
  v3normalize,
  v3set,
  v3sub,
  vec3,
  type Vec3,
} from '../math.js';
import type { Rng } from '../rng.js';
import {
  InputFlag,
  Team,
  createEmptyInput,
  type InputCommand,
  type PlayerId,
  type PlayerState,
  type WorldState,
} from '../types.js';
import type { NavGraph } from '../ai/navigation.js';

export interface ZombieBrain {
  id: PlayerId;
  /** Who it is chasing. */
  targetId: PlayerId;
  /** Path through the nav graph. */
  path: number[];
  pathCursor: number;
  pathAge: number;
  /** Seconds until it may swing again. */
  attackCooldown: number;
  /** Time spent barely moving, used to detect being wedged. */
  stuckTime: number;
  lastPosition: Vec3;
  /**
   * A small per-zombie speed offset.
   *
   * Without it every zombie in a wave moves at exactly the same speed and the
   * horde arrives as a single rank, which reads as an animation rather than as a
   * crowd. It also means a train naturally strings out.
   */
  speedJitter: number;
  /** Randomised so a group does not lurch in unison. */
  lurchPhase: number;
}

/** Damage per swing. Flat across rounds — the threat is the number of them. */
export const ZOMBIE_MELEE_DAMAGE = 34;
export const ZOMBIE_MELEE_RANGE = 2.0;
export const ZOMBIE_MELEE_COOLDOWN = 1.1;

const _toTarget = vec3();
const _desired = vec3();

export class ZombieDirectorAI {
  private readonly brains = new Map<PlayerId, ZombieBrain>();

  constructor(
    private readonly nav: NavGraph,
    private readonly rng: Rng,
  ) {}

  register(id: PlayerId, position: Vec3): void {
    this.brains.set(id, {
      id,
      targetId: 0,
      path: [],
      pathCursor: 0,
      pathAge: 99,
      attackCooldown: 0,
      stuckTime: 0,
      lastPosition: vec3(position.x, position.y, position.z),
      speedJitter: this.rng.range(0.88, 1.12),
      lurchPhase: this.rng.range(0, Math.PI * 2),
    });
  }

  unregister(id: PlayerId): void {
    this.brains.delete(id);
  }

  get count(): number {
    return this.brains.size;
  }

  /** Per-zombie speed multiplier, so the caller can fold it into movement. */
  speedMultiplier(id: PlayerId): number {
    return this.brains.get(id)?.speedJitter ?? 1;
  }

  /**
   * Produce input for every zombie and hand it to the simulation.
   *
   * Returns the melee hits landed this tick; the caller applies the damage so
   * that it goes through the same path as everything else.
   */
  update(
    world: WorldState,
    dt: number,
    setInput: (id: PlayerId, cmd: InputCommand) => void,
  ): Array<{ zombie: PlayerId; victim: PlayerId }> {
    const hits: Array<{ zombie: PlayerId; victim: PlayerId }> = [];

    for (const [id, brain] of this.brains) {
      const zombie = world.players.get(id);
      if (!zombie) {
        this.brains.delete(id);
        continue;
      }

      const cmd = createEmptyInput();
      cmd.dt = dt;
      cmd.seq = world.tick;
      cmd.tick = world.tick;

      if (!zombie.alive) {
        setInput(id, cmd);
        continue;
      }

      brain.attackCooldown = Math.max(0, brain.attackCooldown - dt);
      brain.pathAge += dt;

      const target = this.pickTarget(world, zombie, brain);
      if (!target) {
        setInput(id, cmd);
        continue;
      }

      const distance = v3distance(zombie.position, target.position);

      // --- face the target -------------------------------------------------
      v3sub(_toTarget, target.position, zombie.position);
      v3normalize(_toTarget, _toTarget);
      const desiredYaw = forwardToYaw(_toTarget);
      // Turn fast but not instantly, so circling actually works.
      cmd.yaw = angleApproach(zombie.yaw, desiredYaw, 6.0 * dt);
      cmd.pitch = 0;

      // --- attack ----------------------------------------------------------
      if (distance <= ZOMBIE_MELEE_RANGE && brain.attackCooldown <= 0) {
        brain.attackCooldown = ZOMBIE_MELEE_COOLDOWN;
        hits.push({ zombie: id, victim: target.id });
      }

      // --- move ------------------------------------------------------------
      this.steer(world, zombie, brain, target, cmd, dt);

      setInput(id, cmd);
    }

    return hits;
  }

  /**
   * Chase the nearest living player, with hysteresis.
   *
   * Re-picking every tick makes a zombie between two players oscillate on the
   * spot; it only switches when the new target is meaningfully closer.
   */
  private pickTarget(
    world: WorldState,
    zombie: PlayerState,
    brain: ZombieBrain,
  ): PlayerState | null {
    const current = brain.targetId ? world.players.get(brain.targetId) : undefined;
    const currentDist =
      current && current.alive ? v3distance(zombie.position, current.position) : Infinity;

    let best: PlayerState | null = current && current.alive ? current : null;
    let bestDist = currentDist;

    for (const player of world.players.values()) {
      if (player.team === Team.Hostile) continue;
      if (!player.alive) continue;
      const d = v3distance(zombie.position, player.position);
      // 20% closer before it is worth switching.
      if (d < bestDist * 0.8) {
        best = player;
        bestDist = d;
      }
    }

    // Downed players are still valid targets, but only when nobody is standing:
    // otherwise a whole horde parks on a crawler and the round stalls.
    if (!best) {
      for (const player of world.players.values()) {
        if (player.team === Team.Hostile) continue;
        const d = v3distance(zombie.position, player.position);
        if (d < bestDist) {
          best = player;
          bestDist = d;
        }
      }
    }

    brain.targetId = best?.id ?? 0;
    return best;
  }

  /**
   * Path when far, steer directly when close.
   *
   * Nav-graph following is what gets a zombie out of the room it spawned in;
   * within a few metres the graph is too coarse and direct steering looks far
   * better. Switching between them at a fixed distance is the whole trick.
   */
  private steer(
    world: WorldState,
    zombie: PlayerState,
    brain: ZombieBrain,
    target: PlayerState,
    cmd: InputCommand,
    dt: number,
  ): void {
    const distance = v3distanceXZ(zombie.position, target.position);

    let goal: Vec3 = target.position;

    if (distance > 7) {
      if (brain.pathAge > 1.2 || brain.pathCursor >= brain.path.length) {
        const from = this.nav.nearestNode(zombie.position, 18);
        const to = this.nav.nearestNode(target.position, 18);
        if (from >= 0 && to >= 0) {
          this.nav.findPath(from, to, brain.path);
          brain.pathCursor = brain.path.length > 1 ? 1 : 0;
        }
        brain.pathAge = 0;
      }

      const nodeIndex = brain.path[brain.pathCursor];
      const node = nodeIndex !== undefined ? this.nav.nodes[nodeIndex] : undefined;
      if (node) {
        if (v3distanceXZ(zombie.position, node.position) < 2.0) {
          brain.pathCursor++;
        } else {
          goal = node.position;
        }
      }
    }

    v3sub(_desired, goal, zombie.position);
    _desired.y = 0;
    v3normalize(_desired, _desired);

    // A slow side-to-side lurch. Purely cosmetic, but it is most of what makes a
    // crowd of them read as undead rather than as homing missiles.
    const lurch = Math.sin(world.time * 2.2 + brain.lurchPhase) * 0.22;
    const cos = Math.cos(cmd.yaw);
    const sin = Math.sin(cmd.yaw);
    const forwardAmount = _desired.x * -sin + _desired.z * -cos;
    const rightAmount = _desired.x * cos + _desired.z * -sin;

    cmd.moveForward = clamp(forwardAmount, -1, 1);
    cmd.moveRight = clamp(rightAmount + lurch, -1, 1);

    // Zombies sprint from round one; the speed cap is applied by the caller as a
    // movement modifier, not by holding back the input.
    cmd.buttons |= InputFlag.Sprint;

    // --- unstick ----------------------------------------------------------
    const moved = v3distance(zombie.position, brain.lastPosition);
    v3set(brain.lastPosition, zombie.position.x, zombie.position.y, zombie.position.z);

    if (moved < 0.02 && distance > ZOMBIE_MELEE_RANGE) {
      brain.stuckTime += dt;
      // Try to climb whatever it is first, then give up and repath.
      if (brain.stuckTime > 0.3) cmd.buttons |= InputFlag.Jump;
      if (brain.stuckTime > 1.2) {
        brain.pathAge = 99;
        brain.stuckTime = 0;
      }
    } else {
      brain.stuckTime = 0;
    }
  }

  clear(): void {
    this.brains.clear();
  }
}

/** Seconds a zombie takes to close a given distance, for spawn pacing. */
export function estimatedTravelTime(distance: number, speed: number): number {
  return distance / Math.max(0.5, speed);
}

export { TICK_DT };
