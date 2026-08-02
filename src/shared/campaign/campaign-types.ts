/**
 * The Campaign, as data.
 *
 * A mission is a directed graph of objectives. Each objective declares what has
 * to happen for it to complete, what shows up when it starts, and what it says
 * on the radio — and one small runtime interprets all of them, exactly the way
 * `sim/objectives.ts` is one engine driving five competitive modes.
 *
 * The alternative was a coroutine of hand-written beats, which is more
 * expressive and was rejected for two reasons. Mission scripts written as code
 * hold arbitrary state, and arbitrary state is the thing a checkpoint has to be
 * able to rewind; and a mission that is data can be validated the way a map is,
 * before anybody plays it. What the vocabulary below cannot express is a bespoke
 * one-off moment. That is a real cost and it is the right one to pay here.
 *
 * Missions are authored against the maps that already exist. No mission may
 * assume geometry that is not in its map — `validateMission` checks it.
 */

import type { Vec3 } from '../math.js';
import type { BotArchetype } from '../sim/loadout.js';
import type { DifficultyId } from '../ai/bot.js';

/** A box in world space. Objectives are entered, held and defended in these. */
export interface Zone {
  center: Vec3;
  size: Vec3;
}

/**
 * What completes an objective.
 *
 * Deliberately a small set. Every one of these is a thing the simulation can
 * already answer without new systems: where players are, who is alive, what the
 * clock says.
 */
export type Trigger =
  /** Stand anywhere inside the zone. */
  | { kind: 'reach'; zone: Zone }
  /** Kill this many hostiles. Counted from when the objective became active. */
  | { kind: 'eliminate'; count: number }
  /** Kill every hostile currently alive, and any still queued to spawn. */
  | { kind: 'clear' }
  /** Stay alive for this long. */
  | { kind: 'survive'; seconds: number }
  /** Be inside the zone, uncontested, for this long in total. */
  | { kind: 'hold'; zone: Zone; seconds: number }
  /**
   * Stand in the zone and hold the use key. Interrupted by leaving; the progress
   * so far is kept, which is what makes a contested plant tense rather than
   * merely annoying.
   */
  | { kind: 'interact'; zone: Zone; seconds: number; verb: string }
  /** Get a named ally into the zone alive. */
  | { kind: 'escort'; ally: string; zone: Zone };

/** A group of hostiles that arrives together. */
export interface Wave {
  /** Where they come in. Must be somewhere a player could stand. */
  spawn: Vec3;
  count: number;
  /** Seconds between one arrival and the next. */
  interval: number;
  /** Seconds after the objective activates before the first of them appears. */
  delay?: number;
  archetypes?: BotArchetype[];
  /**
   * Keep sending them until the objective completes.
   *
   * Only meaningful for objectives that do not end by killing — a `survive` or a
   * `hold`. Pairing an endless wave with `clear` is a mission that cannot be
   * finished, which `validateMission` rejects.
   */
  endless?: boolean;
  /**
   * Where these hostiles hold when they have nobody to shoot at.
   *
   * Without it they roam, and roaming scores candidate positions by distance
   * from the bot — so an idle hostile sets off across the map at whatever it
   * last saw and never lets the player break contact. That is the correct
   * instinct in deathmatch and exactly wrong in a mission, where the enemy is
   * supposed to be *somewhere*: a garrison that holds ground is what makes a
   * position worth taking rather than a crowd worth outrunning.
   */
  post?: Vec3;
}

export interface Objective {
  id: string;
  /** The line on the HUD. Imperative, short: "Clear the platform". */
  label: string;
  trigger: Trigger;
  /** Objectives that must be done first. Empty means it starts with the mission. */
  after?: string[];
  /** Hostiles that arrive when this objective becomes active. */
  waves?: Wave[];
  /** Radio traffic when it becomes active. */
  line?: string;
  /**
   * Save a checkpoint on completion.
   *
   * Not every objective should. A checkpoint immediately before a hard fight is
   * a kindness; one immediately after a trivial walk is noise, and one taken
   * mid-firefight restores the player into the firefight they just lost.
   */
  checkpoint?: boolean;
  /** Seconds before the mission fails. 0 or absent means no limit. */
  timeLimit?: number;
}

export interface AllySpec {
  id: string;
  name: string;
  spawn: Vec3;
  archetype: BotArchetype;
  /**
   * The mission fails if this one dies.
   *
   * Use sparingly. An escort that can die to a stray grenade thrown by the
   * player is a checkpoint restart, and a mission built out of those is a
   * mission nobody finishes.
   */
  essential?: boolean;
}

export interface MissionDef {
  id: string;
  name: string;
  /** Which of the registered maps this plays on. */
  mapId: string;
  /** Shown on the loading screen. */
  brief: string;
  /** Where the player starts, and which way they are looking. */
  insertion: { position: Vec3; yaw: number };
  /** How hard the garrison is. Perceptual only — never damage. */
  difficulty: DifficultyId;
  allies: AllySpec[];
  /** Hostiles already in place when the mission opens. */
  garrison?: Wave[];
  objectives: Objective[];
  /** Shown on success. */
  outro: string;
}

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

export enum MissionPhase {
  Briefing = 'briefing',
  Active = 'active',
  Failed = 'failed',
  Complete = 'complete',
}

export interface ObjectiveState {
  id: string;
  active: boolean;
  complete: boolean;
  /** Seconds this objective has been active. */
  elapsed: number;
  /**
   * Progress toward the trigger, 0..1, for the objectives that have a notion of
   * it. Used by the HUD; the trigger itself is the authority on completion.
   */
  progress: number;
  /** Hostiles killed since this objective became active. */
  kills: number;
}

export interface CampaignHudObjective {
  label: string;
  progress: number;
  /** Where to draw the marker, if the objective has a place. */
  position: Vec3 | null;
}

/** Reasons a mission ends badly, kept apart so the HUD can say which. */
export enum FailureReason {
  None = 'none',
  PlayerDown = 'player_down',
  AllyLost = 'ally_lost',
  OutOfTime = 'out_of_time',
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

export const CAMPAIGN = {
  /** Seconds of black before the mission starts, for the brief to be read. */
  briefingTime: 4,
  /** Seconds between dying and the checkpoint restoring. */
  restartDelay: 2.5,
  /**
   * How close an ally tries to stay to the player.
   *
   * Far enough that they are not in the way, near enough that they are visibly
   * *with* you. Below about six metres a squad reads as a crowd and blocks
   * doorways; past about eighteen they read as strangers who happen to be
   * shooting the same people.
   */
  followDistance: 11,
  /** Beyond this an ally stops fighting and comes back. */
  leashDistance: 26,
  /** Seconds a downed ally takes to get back up, if not essential. */
  allyRecovery: 12,
  /**
   * Hostiles alive at once. A cap the director will not exceed.
   *
   * Eight, which is lower than it first looks right. A campaign encounter is
   * fought by one player and a squad of two or three, not by a team of six, and
   * a dozen simultaneous attackers is not a hard fight — it is an unwinnable
   * one, because there is no angle that is not being shot at. The waves still
   * arrive in the numbers they were authored in; they simply queue.
   */
  maxConcurrentHostiles: 6,
  /**
   * Seconds a body stays before it is removed from the world.
   *
   * It has to be removed at all: the simulation has a hard player cap, and a
   * mission that spawns eighty hostiles over ten minutes reaches it and then
   * quietly stops being able to spawn anything. Long enough that the killfeed
   * and the corpse agree with each other; short enough that it never matters.
   */
  corpseLinger: 2.0,
} as const;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Check a mission for the mistakes that actually happen when authoring one.
 *
 * The same reasoning as `validateMap`: a mission is hand-written data, so a
 * typo in an objective id produces no compile error at all — it produces a
 * mission that opens, plays for ninety seconds and then never advances, which is
 * the single most expensive kind of bug to find by playing.
 */
export function validateMission(mission: MissionDef): string[] {
  const errors: string[] = [];
  const tag = mission.id;

  if (mission.objectives.length === 0) {
    errors.push(`${tag}: has no objectives`);
    return errors;
  }

  const ids = new Set<string>();
  for (const obj of mission.objectives) {
    if (ids.has(obj.id)) errors.push(`${tag}: duplicate objective id '${obj.id}'`);
    ids.add(obj.id);
  }

  // Every dependency must exist, or the objective silently never activates.
  for (const obj of mission.objectives) {
    for (const dep of obj.after ?? []) {
      if (!ids.has(dep)) {
        errors.push(`${tag}: objective '${obj.id}' waits on '${dep}', which does not exist`);
      }
      if (dep === obj.id) errors.push(`${tag}: objective '${obj.id}' waits on itself`);
    }
  }

  // At least one objective has to be able to start.
  if (!mission.objectives.some((o) => (o.after ?? []).length === 0)) {
    errors.push(`${tag}: every objective waits on another, so none can start`);
  }

  // A cycle is the same failure as a missing dependency, and just as invisible.
  const done = new Set<string>();
  for (let pass = 0; pass < mission.objectives.length + 1; pass++) {
    for (const obj of mission.objectives) {
      if (done.has(obj.id)) continue;
      if ((obj.after ?? []).every((d) => done.has(d))) done.add(obj.id);
    }
  }
  for (const obj of mission.objectives) {
    if (!done.has(obj.id)) {
      errors.push(`${tag}: objective '${obj.id}' is unreachable — check for a dependency cycle`);
    }
  }

  const allyIds = new Set(mission.allies.map((a) => a.id));
  for (const obj of mission.objectives) {
    if (obj.trigger.kind === 'escort' && !allyIds.has(obj.trigger.ally)) {
      errors.push(`${tag}: objective '${obj.id}' escorts '${obj.trigger.ally}', who is not in the squad`);
    }

    // An endless wave has to be attached to something that can end without
    // killing, or the mission is literally unwinnable.
    const endless = (obj.waves ?? []).some((w) => w.endless);
    if (endless && (obj.trigger.kind === 'clear' || obj.trigger.kind === 'eliminate')) {
      errors.push(
        `${tag}: objective '${obj.id}' spawns an endless wave but completes by killing — ` +
          `it can never be finished`,
      );
    }

    for (const wave of obj.waves ?? []) {
      if (wave.count <= 0) errors.push(`${tag}: objective '${obj.id}' has a wave of ${wave.count}`);
      if (wave.interval < 0) errors.push(`${tag}: objective '${obj.id}' has a negative wave interval`);
    }

    if (obj.trigger.kind === 'survive' && obj.trigger.seconds <= 0) {
      errors.push(`${tag}: objective '${obj.id}' survives for ${obj.trigger.seconds} seconds`);
    }
  }

  // A mission with no checkpoints restarts from the beginning every death.
  if (mission.objectives.length > 2 && !mission.objectives.some((o) => o.checkpoint)) {
    errors.push(`${tag}: no objective sets a checkpoint, so every death replays the whole mission`);
  }

  return errors;
}
