/**
 * Bot AI.
 *
 * The goal is not a bot that wins — a bot that wins is trivial, because it can
 * snap to a headshot in one tick. The goal is a bot that *loses like a person*:
 * one that has to see you before it can shoot you, takes a moment to react,
 * misses the first burst, and gets flanked when it commits to an angle.
 *
 * So the difficulty knobs are all perceptual and mechanical rather than
 * damage-based. A Recruit bot and a Veteran bot use identical weapons and take
 * identical damage; what changes is reaction time, aim error, how long they can
 * track a strafing target, and how well they read cover. Scaling damage instead
 * would be simpler and would feel terrible.
 *
 * Bots drive the simulation through exactly the same InputCommand a human sends,
 * so there is no separate code path for them and no possibility of a bot doing
 * something a player physically could not.
 */

import { PERCEPTION, TICK_DT } from '../constants.js';
import {
  angleApproach,
  angleDelta,
  anglesToForward,
  clamp,
  clamp01,
  forwardToPitch,
  forwardToYaw,
  v3distance,
  v3distanceXZ,
  v3normalize,
  v3set,
  v3sub,
  vec3,
  wrapAngle,
  type Vec3,
} from '../math.js';
import type { Rng } from '../rng.js';
import {
  InputFlag,
  MoveState,
  Stance,
  WeaponAction,
  createEmptyInput,
  isEnemyTeam,
  type InputCommand,
  type PlayerId,
  type PlayerState,
} from '../types.js';
import { FireMode, WeaponClass, fireInterval, type WeaponDef } from '../data/weapon-types.js';
import { hitboxCenter } from '../sim/combat.js';
import { currentEyeHeight } from '../sim/movement.js';
import { activeWeapon } from '../sim/weapon-system.js';
import { archetypeRange, type BotArchetype } from '../sim/loadout.js';
import type { GameSimulation } from '../sim/game.js';
import type { NavGraph, NavNode } from './navigation.js';

// ---------------------------------------------------------------------------
// Difficulty
// ---------------------------------------------------------------------------

export interface BotDifficulty {
  name: string;
  /** Seconds between an enemy becoming visible and the bot beginning to react. */
  reactionTime: number;
  /** Standard deviation of aim error at 20 m, in radians. */
  aimError: number;
  /** How fast the bot slews onto target, radians/second. */
  turnSpeed: number;
  /**
   * Fraction of a strafing target's velocity the bot leads. 1 = perfect
   * tracking, 0 = always shooting where the target was.
   */
  leadFactor: number;
  /** How far the bot can see, before line-of-sight. */
  viewDistance: number;
  /** Half-angle of the bot's attention cone, radians. */
  fov: number;
  /** Probability per second of choosing to take cover when hurt. */
  coverInstinct: number;
  /** Probability per second of throwing a grenade at a known enemy position. */
  grenadeInstinct: number;
  /** Multiplier on how long the bot keeps firing after losing sight. */
  persistence: number;
  /** Chance the bot pre-aims at a corner it is approaching. */
  preAim: number;
  /** Fraction of shots deliberately thrown wide, simulating panic. */
  panicSpray: number;
}

export const DIFFICULTIES: Record<string, BotDifficulty> = {
  recruit: {
    name: 'Recruit',
    reactionTime: 0.62,
    aimError: 0.075,
    turnSpeed: 2.4,
    leadFactor: 0.1,
    viewDistance: 45,
    fov: 1.15,
    coverInstinct: 0.15,
    grenadeInstinct: 0.02,
    persistence: 0.5,
    preAim: 0.05,
    panicSpray: 0.45,
  },
  regular: {
    name: 'Regular',
    reactionTime: 0.42,
    aimError: 0.042,
    turnSpeed: 4.2,
    leadFactor: 0.35,
    viewDistance: 65,
    fov: 1.3,
    coverInstinct: 0.35,
    grenadeInstinct: 0.06,
    persistence: 0.8,
    preAim: 0.2,
    panicSpray: 0.25,
  },
  hardened: {
    name: 'Hardened',
    reactionTime: 0.26,
    aimError: 0.022,
    turnSpeed: 6.5,
    leadFactor: 0.6,
    viewDistance: 90,
    fov: 1.45,
    coverInstinct: 0.6,
    grenadeInstinct: 0.12,
    persistence: 1.1,
    preAim: 0.45,
    panicSpray: 0.12,
  },
  veteran: {
    name: 'Veteran',
    reactionTime: 0.16,
    aimError: 0.011,
    turnSpeed: 9.0,
    leadFactor: 0.85,
    viewDistance: 120,
    fov: 1.6,
    coverInstinct: 0.8,
    grenadeInstinct: 0.18,
    persistence: 1.4,
    preAim: 0.7,
    panicSpray: 0.05,
  },
};

export const DIFFICULTY_IDS = ['recruit', 'regular', 'hardened', 'veteran'] as const;
export type DifficultyId = (typeof DIFFICULTY_IDS)[number];

export function difficultyFromSkill(skill: number): BotDifficulty {
  const idx = clamp(Math.floor(skill * DIFFICULTY_IDS.length), 0, DIFFICULTY_IDS.length - 1);
  return DIFFICULTIES[DIFFICULTY_IDS[idx]!]!;
}

// ---------------------------------------------------------------------------
// Bot state
// ---------------------------------------------------------------------------

export enum BotGoal {
  /** No target: move toward the objective or roam the map. */
  Advance = 'advance',
  /** Target visible: fight. */
  Engage = 'engage',
  /** Target was visible recently: press toward its last known position. */
  Hunt = 'hunt',
  /** Hurt or reloading: break line of sight. */
  TakeCover = 'cover',
  /** Holding a strong position, waiting. */
  Hold = 'hold',
  /** Reloading in safety. */
  Regroup = 'regroup',
}

export interface BotBrain {
  playerId: PlayerId;
  archetype: BotArchetype;
  difficulty: BotDifficulty;

  goal: BotGoal;
  /** Seconds spent in the current goal, so behaviours can't thrash. */
  goalTime: number;

  targetId: PlayerId;
  /** Seconds the current target has been continuously visible. */
  visibleTime: number;
  /** Seconds since the target was last seen. */
  lostTime: number;
  /** Where the bot last saw or heard the target. */
  lastKnownPosition: Vec3;
  /** True once the reaction delay has elapsed and the bot may shoot. */
  reacted: boolean;
  reactionTimer: number;

  /** Current aim, slewed toward the desired aim each tick. */
  aimYaw: number;
  aimPitch: number;
  /** Persistent per-target aim bias, resampled occasionally, so error is not white noise. */
  biasYaw: number;
  biasPitch: number;
  biasTimer: number;

  /** Path through the nav graph, as node indices. */
  path: number[];
  pathCursor: number;
  /** Node the bot is currently heading to, or -1. */
  destination: number;
  /** Seconds since the path was computed, so we can refresh it. */
  pathAge: number;
  /** Guards against recomputing a path every tick when one can't be found. */
  pathCooldown: number;

  /** Strafe direction while fighting, flipped periodically. */
  strafeDir: number;
  strafeTimer: number;

  /**
   * Seconds until the bot may pull a non-automatic trigger again.
   *
   * Semi-automatic and bolt-action weapons fire on the trigger's rising edge, so
   * a bot that simply holds Fire would get exactly one shot. Humans click; bots
   * have to as well, at a human-plausible rate.
   */
  triggerCooldown: number;
  /** Time until the bot may throw equipment again. */
  grenadeCooldown: number;
  /** Accumulates so per-second probabilities work on a per-tick loop. */
  decisionAccum: number;

  /** Position the bot is holding, when in Hold. */
  holdNode: number;
  /** Randomised so a squad of bots doesn't move as one organism. */
  personalityOffset: number;
}

export function createBrain(
  playerId: PlayerId,
  archetype: BotArchetype,
  difficulty: BotDifficulty,
  rng: Rng,
): BotBrain {
  return {
    playerId,
    archetype,
    difficulty,
    goal: BotGoal.Advance,
    goalTime: 0,
    targetId: 0,
    visibleTime: 0,
    lostTime: Infinity,
    lastKnownPosition: vec3(),
    reacted: false,
    reactionTimer: 0,
    aimYaw: 0,
    aimPitch: 0,
    biasYaw: 0,
    biasPitch: 0,
    biasTimer: 0,
    path: [],
    pathCursor: 0,
    destination: -1,
    pathAge: 0,
    pathCooldown: 0,
    strafeDir: rng.chance(0.5) ? 1 : -1,
    strafeTimer: 0,
    triggerCooldown: 0,
    grenadeCooldown: rng.range(2, 8),
    decisionAccum: 0,
    holdNode: -1,
    personalityOffset: rng.range(0, 1000),
  };
}

// ---------------------------------------------------------------------------
// Scratch
// ---------------------------------------------------------------------------

const _eye = vec3();
const _targetPoint = vec3();
const _toTarget = vec3();
const _forward = vec3();
const _desired = vec3();
const _steer = vec3();

// ---------------------------------------------------------------------------
// The controller
// ---------------------------------------------------------------------------

export class BotController {
  private readonly brains = new Map<PlayerId, BotBrain>();

  constructor(
    private readonly sim: GameSimulation,
    private readonly nav: NavGraph,
    private readonly rng: Rng,
  ) {}

  register(playerId: PlayerId, archetype: BotArchetype, difficulty: BotDifficulty): void {
    this.brains.set(playerId, createBrain(playerId, archetype, difficulty, this.rng));
  }

  unregister(playerId: PlayerId): void {
    this.brains.delete(playerId);
  }

  getBrain(playerId: PlayerId): BotBrain | undefined {
    return this.brains.get(playerId);
  }

  /**
   * Produce one tick of input for every registered bot and feed it to the sim.
   * Called once per tick, before `GameSimulation.step`.
   */
  update(dt: number): void {
    for (const [id, brain] of this.brains) {
      const player = this.sim.world.players.get(id);
      if (!player) continue;

      const input = createEmptyInput();
      input.dt = dt;
      input.seq = this.sim.world.tick;
      input.tick = this.sim.world.tick;

      if (player.alive) {
        this.think(player, brain, input, dt);
      } else {
        // Dead bots keep their last aim so the killcam doesn't snap.
        input.yaw = brain.aimYaw;
        input.pitch = brain.aimPitch;
      }

      this.sim.setInput(id, input);
    }
  }

  // -------------------------------------------------------------------------

  private think(player: PlayerState, brain: BotBrain, input: InputCommand, dt: number): void {
    brain.goalTime += dt;
    brain.pathAge += dt;
    brain.grenadeCooldown = Math.max(0, brain.grenadeCooldown - dt);
    brain.triggerCooldown = Math.max(0, brain.triggerCooldown - dt);
    brain.pathCooldown = Math.max(0, brain.pathCooldown - dt);
    brain.biasTimer -= dt;
    brain.strafeTimer -= dt;
    brain.decisionAccum += dt;

    const weapon = this.sim.activeWeaponDef(player);

    this.perceive(player, brain, dt);
    this.chooseGoal(player, brain, weapon, dt);
    this.aim(player, brain, weapon, input, dt);
    this.move(player, brain, weapon, input, dt);
    this.act(player, brain, weapon, input);
  }

  // -------------------------------------------------------------------------
  // Perception
  // -------------------------------------------------------------------------

  /**
   * Decide what the bot can see.
   *
   * A target must be inside the view cone, within view distance, and have clear
   * line of sight — and then the bot still cannot shoot until its reaction timer
   * has elapsed. That delay is the single most important number for making bots
   * feel fair: without it they return fire on the same tick they are shot at,
   * which reads as cheating even when their aim is poor.
   */
  private perceive(player: PlayerState, brain: BotBrain, dt: number): void {
    const d = brain.difficulty;
    v3set(_eye, player.position.x, player.position.y + currentEyeHeight(player), player.position.z);
    anglesToForward(_forward, brain.aimYaw, brain.aimPitch);

    let bestId: PlayerId = 0;
    let bestScore = -Infinity;

    for (const other of this.sim.world.players.values()) {
      if (!other.alive || other.id === player.id) continue;
      if (!isEnemyTeam(player.team, other.team)) continue;

      const dist = v3distance(player.position, other.position);
      if (dist > d.viewDistance) continue;

      v3sub(_toTarget, other.position, player.position);
      v3normalize(_toTarget, _toTarget);
      const facing = _toTarget.x * _forward.x + _toTarget.z * _forward.z;
      const inFov = facing >= Math.cos(d.fov);

      // Enemies who are shooting or sprinting nearby are noticed regardless of
      // where the bot is looking — that is what ears are for.
      const audible =
        dist < PERCEPTION.footstepRadiusSprint &&
        (other.moveState === MoveState.Sprint || other.moveState === MoveState.TacticalSprint);

      if (!inFov && !audible) continue;
      if (!this.sim.canSee(player, other)) continue;

      // Prefer close, centred, low-health targets.
      const score = 100 - dist * 0.8 + facing * 40 + (100 - other.health) * 0.25;
      if (score > bestScore) {
        bestScore = score;
        bestId = other.id;
      }
    }

    if (bestId !== 0) {
      if (brain.targetId !== bestId) {
        // New target: restart the reaction clock and resample the aim bias, so
        // switching targets costs the bot the same beat it costs a human.
        brain.targetId = bestId;
        brain.reacted = false;
        brain.reactionTimer = d.reactionTime * this.rng.range(0.75, 1.3);
        brain.visibleTime = 0;
        this.resampleBias(brain);
      }
      brain.visibleTime += dt;
      brain.lostTime = 0;

      const target = this.sim.world.players.get(bestId);
      if (target) {
        brain.lastKnownPosition.x = target.position.x;
        brain.lastKnownPosition.y = target.position.y;
        brain.lastKnownPosition.z = target.position.z;
      }

      if (!brain.reacted) {
        brain.reactionTimer -= dt;
        if (brain.reactionTimer <= 0) brain.reacted = true;
      }
    } else {
      brain.lostTime += dt;
      brain.visibleTime = 0;
      // Keep the target for a while so the bot pushes the last known position
      // instead of instantly forgetting.
      if (brain.lostTime > 4 * brain.difficulty.persistence) {
        brain.targetId = 0;
        brain.reacted = false;
      }
    }

    if (brain.biasTimer <= 0) this.resampleBias(brain);
  }

  /**
   * Aim error is a slowly-drifting bias rather than per-tick noise.
   *
   * White noise averages out over a burst and makes bots weirdly accurate at
   * sustained fire; a persistent offset that only resamples every second or so
   * produces the human pattern of missing consistently in one direction, then
   * correcting.
   */
  private resampleBias(brain: BotBrain): void {
    const d = brain.difficulty;
    brain.biasYaw = this.rng.gaussian(0, d.aimError);
    brain.biasPitch = this.rng.gaussian(0, d.aimError * 0.7);
    brain.biasTimer = this.rng.range(0.35, 1.1);
  }

  // -------------------------------------------------------------------------
  // Goal selection
  // -------------------------------------------------------------------------

  private chooseGoal(
    player: PlayerState,
    brain: BotBrain,
    weapon: WeaponDef,
    dt: number,
  ): void {
    void dt;
    const d = brain.difficulty;
    const previous = brain.goal;
    const hasTarget = brain.targetId !== 0;
    const healthFrac = player.health / Math.max(1, player.maxHealth);
    const state = activeWeapon(player);
    const lowAmmo = state ? state.ammoInMag <= Math.max(1, weapon.magSize * 0.15) : false;

    // Reloading with no magazine while an enemy is looking at you is how bots
    // die stupidly, so it takes priority over everything except having a shot.
    if (state && state.ammoInMag === 0 && state.ammoReserve > 0) {
      brain.goal = hasTarget && brain.visibleTime > 0 ? BotGoal.TakeCover : BotGoal.Regroup;
    } else if (hasTarget && brain.lostTime < 0.35) {
      // Hurt bots break contact rather than trading to the death.
      const wantsCover =
        healthFrac < 0.4 && this.chance(brain, d.coverInstinct) && brain.goalTime > 0.8;
      brain.goal = wantsCover ? BotGoal.TakeCover : BotGoal.Engage;
    } else if (hasTarget) {
      brain.goal = BotGoal.Hunt;
    } else if (lowAmmo && player.action !== WeaponAction.Reloading) {
      brain.goal = BotGoal.Regroup;
    } else if (
      brain.archetype === 'sniper' &&
      brain.goalTime > 3 &&
      brain.holdNode >= 0 &&
      this.rng.chance(0.6)
    ) {
      brain.goal = BotGoal.Hold;
    } else {
      brain.goal = BotGoal.Advance;
    }

    if (brain.goal !== previous) {
      brain.goalTime = 0;
      // Force a path refresh so the bot doesn't keep walking its old route.
      brain.pathAge = 99;
    }
  }

  /** Convert a per-second probability into a per-tick roll. */
  private chance(brain: BotBrain, perSecond: number): boolean {
    void brain;
    return this.rng.next() < perSecond * TICK_DT;
  }

  // -------------------------------------------------------------------------
  // Aiming
  // -------------------------------------------------------------------------

  private aim(
    player: PlayerState,
    brain: BotBrain,
    weapon: WeaponDef,
    input: InputCommand,
    dt: number,
  ): void {
    const d = brain.difficulty;
    v3set(_eye, player.position.x, player.position.y + currentEyeHeight(player), player.position.z);

    let desiredYaw = brain.aimYaw;
    let desiredPitch = brain.aimPitch;

    const target = brain.targetId ? this.sim.world.players.get(brain.targetId) : undefined;

    if (target && target.alive) {
      // Aim at the chest by default; better bots go for the head as the target
      // stays visible and they settle.
      const settled = clamp01(brain.visibleTime / 0.9);
      const wantsHead = settled > 0.6 && this.rng.next() < 0.35 + d.leadFactor * 0.4;
      hitboxCenter(_targetPoint, target, wantsHead ? 'head' : 'chest');

      // Lead a moving target. Perfect leading feels robotic, so leadFactor
      // scales it and the residual becomes part of why low-skill bots miss.
      const dist = v3distance(_eye, _targetPoint);
      const travel = Number.isFinite(weapon.muzzleVelocity)
        ? dist / weapon.muzzleVelocity
        : 0;
      const leadTime = (travel + dt) * d.leadFactor;
      _targetPoint.x += target.velocity.x * leadTime;
      _targetPoint.z += target.velocity.z * leadTime;

      v3sub(_toTarget, _targetPoint, _eye);
      v3normalize(_toTarget, _toTarget);
      desiredYaw = forwardToYaw(_toTarget);
      desiredPitch = forwardToPitch(_toTarget);

      // Error scales with distance and with how hard the target is to track.
      const targetSpeed = Math.hypot(target.velocity.x, target.velocity.z);
      const errorScale = (dist / 20) * (1 + targetSpeed * 0.06) * (1 - settled * 0.45);
      desiredYaw += brain.biasYaw * errorScale;
      desiredPitch += brain.biasPitch * errorScale;
    } else if (brain.lostTime < 6 && brain.targetId !== 0) {
      v3sub(_toTarget, brain.lastKnownPosition, _eye);
      v3normalize(_toTarget, _toTarget);
      desiredYaw = forwardToYaw(_toTarget);
      desiredPitch = forwardToPitch(_toTarget);
    } else {
      // No target: look where we are going, with a slow idle scan so the bot
      // doesn't read as a turret.
      const node = this.currentPathNode(brain);
      if (node) {
        v3sub(_toTarget, node.position, player.position);
        _toTarget.y = 0;
        if (Math.hypot(_toTarget.x, _toTarget.z) > 0.3) {
          v3normalize(_toTarget, _toTarget);
          desiredYaw = forwardToYaw(_toTarget);
        }
      }
      desiredPitch = 0;
      const t = this.sim.world.time + brain.personalityOffset;
      desiredYaw += Math.sin(t * 0.55) * 0.28;
    }

    // Slew rather than snap. Turn speed is the other half of what makes a bot
    // beatable: a bot that can turn 180 degrees instantly cannot be flanked.
    const maxTurn = d.turnSpeed * dt * (target && brain.reacted ? 1 : 0.6);
    brain.aimYaw = angleApproach(brain.aimYaw, desiredYaw, maxTurn);
    brain.aimPitch = clamp(
      angleApproach(brain.aimPitch, desiredPitch, maxTurn),
      -1.2,
      1.2,
    );

    input.yaw = brain.aimYaw;
    input.pitch = brain.aimPitch;
  }

  // -------------------------------------------------------------------------
  // Movement
  // -------------------------------------------------------------------------

  private move(
    player: PlayerState,
    brain: BotBrain,
    weapon: WeaponDef,
    input: InputCommand,
    dt: number,
  ): void {
    void dt;
    this.ensurePath(player, brain, weapon);

    const node = this.currentPathNode(brain);
    let wantX = 0;
    let wantZ = 0;

    if (node) {
      const dist = v3distanceXZ(player.position, node.position);
      if (dist < 1.4) {
        brain.pathCursor++;
      } else {
        v3sub(_desired, node.position, player.position);
        _desired.y = 0;
        v3normalize(_desired, _desired);
        wantX = _desired.x;
        wantZ = _desired.z;
      }
    }

    // Combat footwork: strafe across the target rather than walking at it.
    if (brain.goal === BotGoal.Engage && brain.targetId !== 0) {
      const target = this.sim.world.players.get(brain.targetId);
      if (target) {
        const range = archetypeRange(brain.archetype);
        const dist = v3distanceXZ(player.position, target.position);

        v3sub(_desired, target.position, player.position);
        _desired.y = 0;
        v3normalize(_desired, _desired);

        // Close if too far, back off if too close, otherwise hold and strafe.
        let approach = 0;
        if (dist > range.max) approach = 1;
        else if (dist < range.min * 0.6) approach = -1;

        if (brain.strafeTimer <= 0) {
          brain.strafeDir = -brain.strafeDir;
          brain.strafeTimer = this.rng.range(0.6, 1.7);
        }

        // Perpendicular to the line of engagement.
        const strafeX = -_desired.z * brain.strafeDir;
        const strafeZ = _desired.x * brain.strafeDir;

        wantX = _desired.x * approach + strafeX * 0.85;
        wantZ = _desired.z * approach + strafeZ * 0.85;
      }
    }

    // Convert a world-space desire into local move axes.
    const cosYaw = Math.cos(brain.aimYaw);
    const sinYaw = Math.sin(brain.aimYaw);
    // forward = (-sin(yaw), 0, -cos(yaw)); right = (cos(yaw), 0, -sin(yaw))
    const forwardAmount = wantX * -sinYaw + wantZ * -cosYaw;
    const rightAmount = wantX * cosYaw + wantZ * -sinYaw;

    input.moveForward = clamp(forwardAmount, -1, 1);
    input.moveRight = clamp(rightAmount, -1, 1);

    // Sprint when travelling with no immediate threat.
    const shouldSprint =
      (brain.goal === BotGoal.Advance || brain.goal === BotGoal.Regroup || brain.goal === BotGoal.Hunt) &&
      input.moveForward > 0.6 &&
      brain.lostTime > 1.2;
    if (shouldSprint) input.buttons |= InputFlag.Sprint;

    // Crouch when holding a cover position that asks for it.
    if (brain.goal === BotGoal.Hold && node?.crouch) {
      input.buttons |= InputFlag.Crouch;
    }

    // Bots vault and mantle by holding jump into an obstruction; the movement
    // controller decides whether it is actually possible.
    if (
      player.moveState !== MoveState.Mantle &&
      player.onGround &&
      Math.abs(input.moveForward) > 0.5 &&
      Math.hypot(player.velocity.x, player.velocity.z) < 0.6 &&
      brain.goalTime > 0.4
    ) {
      // Stuck against something while trying to move: try to get over it.
      input.buttons |= InputFlag.Jump;
    }
  }

  // -------------------------------------------------------------------------
  // Pathing
  // -------------------------------------------------------------------------

  private ensurePath(player: PlayerState, brain: BotBrain, weapon: WeaponDef): void {
    const needsRefresh =
      brain.path.length === 0 ||
      brain.pathCursor >= brain.path.length ||
      brain.pathAge > 2.5;

    if (!needsRefresh || brain.pathCooldown > 0) return;

    const goalNode = this.chooseDestination(player, brain, weapon);
    if (goalNode < 0) {
      brain.pathCooldown = 0.5;
      return;
    }

    const start = this.nav.nearestNode(player.position, 14);
    if (start < 0) {
      brain.pathCooldown = 0.5;
      return;
    }

    this.nav.findPath(start, goalNode, brain.path);
    brain.pathCursor = brain.path.length > 1 ? 1 : 0;
    brain.pathAge = 0;
    brain.destination = goalNode;
    if (brain.path.length === 0) brain.pathCooldown = 0.75;
  }

  private chooseDestination(player: PlayerState, brain: BotBrain, weapon: WeaponDef): number {
    switch (brain.goal) {
      case BotGoal.TakeCover: {
        const threat = brain.targetId
          ? this.sim.world.players.get(brain.targetId)?.position ?? brain.lastKnownPosition
          : brain.lastKnownPosition;
        const cover = this.nav.findCover(player.position, threat, 28);
        if (cover) {
          brain.holdNode = cover.id;
          return cover.id;
        }
        return this.roamDestination(player, brain);
      }

      case BotGoal.Hold: {
        if (brain.holdNode >= 0 && brain.holdNode < this.nav.nodes.length) return brain.holdNode;
        const cover = this.nav.findCover(player.position, brain.lastKnownPosition, 35);
        if (cover) {
          brain.holdNode = cover.id;
          return cover.id;
        }
        return this.roamDestination(player, brain);
      }

      case BotGoal.Hunt:
        return this.nav.nearestNode(brain.lastKnownPosition, 20);

      case BotGoal.Engage: {
        // While engaging, path toward a position at the archetype's preferred
        // range rather than at the enemy — a sniper should not close to 5 m.
        const target = brain.targetId ? this.sim.world.players.get(brain.targetId) : undefined;
        if (!target) return this.roamDestination(player, brain);
        const range = archetypeRange(brain.archetype);
        const dist = v3distanceXZ(player.position, target.position);
        if (dist >= range.min && dist <= range.max) {
          // Already at a good distance: stay put and let footwork handle it.
          return this.nav.nearestNode(player.position, 10);
        }
        return this.nav.nearestNode(target.position, 25);
      }

      case BotGoal.Regroup: {
        const threat = brain.lastKnownPosition;
        const cover = this.nav.findCover(player.position, threat, 22);
        return cover ? cover.id : this.roamDestination(player, brain);
      }

      default:
        void weapon;
        return this.roamDestination(player, brain);
    }
  }

  /**
   * Where to go with nothing to shoot at.
   *
   * Bots head for the objective when there is one, and otherwise pick a
   * high-value node on the far side of the map — which produces the constant
   * cross-map pressure a deathmatch needs, rather than bots milling around
   * their own spawn.
   */
  private roamDestination(player: PlayerState, brain: BotBrain): number {
    const objective = this.pickObjective(player);
    if (objective) {
      const node = this.nav.nearestNode(objective, 25);
      if (node >= 0) return node;
    }

    // Deterministic wandering: hash the bot and the current time bucket so each
    // bot picks a different corner and they all re-pick together occasionally.
    const bucket = Math.floor(this.sim.world.time / 12) + Math.floor(brain.personalityOffset);
    const count = this.nav.nodes.length;
    if (count === 0) return -1;

    let best = -1;
    let bestScore = -Infinity;
    // Sample rather than scan: 24 candidates is plenty to find somewhere far
    // away and worth being, and it keeps this cheap with 20 bots.
    for (let i = 0; i < 24; i++) {
      const idx = (bucket * 7919 + i * 104729) % count;
      const node = this.nav.nodes[idx]!;
      const dist = v3distanceXZ(node.position, player.position);
      const score = node.value * 6 + dist * 0.35 - node.exposure * 3;
      if (score > bestScore) {
        bestScore = score;
        best = idx;
      }
    }
    return best;
  }

  private pickObjective(player: PlayerState): Vec3 | null {
    const objectives = this.sim.map.objectives.filter(
      (o) => o.kind === this.sim.mode.objectiveKind,
    );
    if (objectives.length === 0) return null;

    // Head for the nearest objective, biased by team so the two sides converge
    // from opposite ends rather than all piling onto one flag.
    let best: Vec3 | null = null;
    let bestDist = Infinity;
    for (const obj of objectives) {
      const d = v3distanceXZ(obj.position, player.position);
      if (d < bestDist) {
        bestDist = d;
        best = obj.position;
      }
    }
    return best;
  }

  /** The nav node the bot is currently walking toward, if any. */
  private currentPathNode(brain: BotBrain): NavNode | undefined {
    if (brain.pathCursor < 0 || brain.pathCursor >= brain.path.length) return undefined;
    const idx = brain.path[brain.pathCursor]!;
    return this.nav.nodes[idx];
  }

  // -------------------------------------------------------------------------
  // Trigger discipline
  // -------------------------------------------------------------------------

  private act(
    player: PlayerState,
    brain: BotBrain,
    weapon: WeaponDef,
    input: InputCommand,
  ): void {
    // Spend an earned killstreak. Bots deliberately hold it for a beat rather
    // than firing it the instant it lands, so a streak arriving reads as a
    // decision rather than as a scripted consequence of the previous kill.
    if (player.killstreakInventory.length > 0 && brain.goal !== BotGoal.Engage) {
      if (this.chance(brain, 0.35)) {
        input.killstreakSlot = 0;
      }
    }

    const state = activeWeapon(player);

    // Reload when safe, or when empty regardless.
    if (state) {
      const empty = state.ammoInMag === 0;
      const low = state.ammoInMag <= weapon.magSize * 0.25;
      const safe = brain.goal !== BotGoal.Engage || brain.lostTime > 1.5;
      if (state.ammoReserve > 0 && (empty || (low && safe))) {
        input.buttons |= InputFlag.Reload;
      }
    }

    const target = brain.targetId ? this.sim.world.players.get(brain.targetId) : undefined;
    if (!target || !target.alive) return;
    if (!brain.reacted) return;
    if (brain.lostTime > 0.25) return;

    const dist = v3distance(player.position, target.position);

    // Aim down sights past close range — hipfire beyond a few metres is what
    // makes low bots harmless and high bots look careless.
    const range = archetypeRange(brain.archetype);
    if (dist > 8 || weapon.class === WeaponClass.SniperRifle) {
      input.buttons |= InputFlag.Ads;
    }

    // Only pull the trigger when actually pointed at the target. Without this
    // check bots spray at walls while turning, which looks broken and is the
    // most common tell of a cheap AI.
    v3set(_eye, player.position.x, player.position.y + currentEyeHeight(player), player.position.z);
    hitboxCenter(_targetPoint, target, 'chest');
    v3sub(_toTarget, _targetPoint, _eye);
    v3normalize(_toTarget, _toTarget);
    const desiredYaw = forwardToYaw(_toTarget);
    const desiredPitch = forwardToPitch(_toTarget);

    const yawError = Math.abs(angleDelta(brain.aimYaw, desiredYaw));
    const pitchError = Math.abs(brain.aimPitch - desiredPitch);

    // Tolerance widens with distance because the angular size of a target
    // shrinks — a fixed tolerance would make bots refuse to fire at range.
    const tolerance = Math.atan2(1.0, Math.max(2, dist)) + 0.02;

    let wantsFire = false;
    if (yawError < tolerance && pitchError < tolerance) {
      // Panic spray: low-skill bots sometimes fire when they shouldn't quite.
      wantsFire = this.rng.next() > brain.difficulty.panicSpray * 0.35;
    } else if (dist < 6 && this.rng.next() < brain.difficulty.panicSpray) {
      // Close range panic: fire anyway, badly.
      wantsFire = true;
    }

    if (wantsFire) this.pullTrigger(brain, weapon, input);

    // Melee when practically touching.
    if (dist < 2.0 && this.rng.chance(0.04)) {
      input.buttons |= InputFlag.Melee;
    }

    // Grenades at a target that is holding still behind cover.
    if (
      brain.grenadeCooldown <= 0 &&
      player.lethalCount > 0 &&
      dist > 8 &&
      dist < 30 &&
      this.chance(brain, brain.difficulty.grenadeInstinct)
    ) {
      input.buttons |= InputFlag.Lethal;
      brain.grenadeCooldown = this.rng.range(8, 20);
    }

    void range;
  }

  /**
   * Set the fire flag with the cadence the weapon actually needs.
   *
   * Automatics are held down. Everything else is pulsed with at least one tick
   * of release between shots so the rising edge registers, rate-limited to a
   * plausible human click speed — a bot that clicks a semi-auto at the tick rate
   * would out-DPS every automatic in the game.
   */
  private pullTrigger(brain: BotBrain, weapon: WeaponDef, input: InputCommand): void {
    if (weapon.fireMode === FireMode.Auto) {
      input.buttons |= InputFlag.Fire;
      return;
    }

    if (brain.triggerCooldown > 0) return;

    input.buttons |= InputFlag.Fire;

    // Faster bots click faster, but nobody beats the weapon's own cycle rate.
    const skill = 1 - brain.difficulty.aimError / 0.075;
    const humanClickInterval = 0.34 - skill * 0.18;
    brain.triggerCooldown = Math.max(fireInterval(weapon), humanClickInterval) + TICK_DT;
  }
}
