/**
 * The Campaign runtime.
 *
 * One interpreter for every mission, in the same spirit as `sim/objectives.ts`
 * driving five competitive modes. It owns the objective graph, the hostiles that
 * arrive with each objective, the squad, and the checkpoint — and it drives all
 * of it through the ordinary simulation. Campaign hostiles are `PlayerState` on
 * `Team.Hostile` running the same `BotController` as everything else, so there
 * is no second combat path to keep in sync and nothing a scripted enemy can do
 * that a player could not.
 *
 * The director never writes to the renderer or the HUD. It returns events and
 * exposes state; presentation reads it. That is what lets a whole mission be
 * played headless in a test, which is the only practical way to know that a
 * mission can actually be finished.
 */

import { TICK_DT } from '../constants.js';
import { v3distance, v3distanceXZ, vec3, type Vec3 } from '../math.js';
import type { Rng } from '../rng.js';
import {
  SimEventType,
  Team,
  type PlayerId,
  type PlayerState,
  type SimEvent,
} from '../types.js';
import { MatchPhase } from '../types.js';
import type { GameSimulation } from '../sim/game.js';
import type { NavGraph } from '../ai/navigation.js';
import { BotController, DIFFICULTIES } from '../ai/bot.js';
import { BOT_ARCHETYPES, botLoadout, type BotArchetype } from '../sim/loadout.js';
import {
  CAMPAIGN,
  FailureReason,
  MissionPhase,
  type CampaignHudObjective,
  type MissionDef,
  type Objective,
  type ObjectiveState,
  type Wave,
  type Zone,
} from './campaign-types.js';

/** A wave that has started arriving but has not finished. */
interface PendingWave {
  objectiveId: string;
  wave: Wave;
  remaining: number;
  timer: number;
}

/**
 * Everything a checkpoint restores.
 *
 * Deliberately not a snapshot of the world. Rewinding a whole simulation means
 * every system has to be serialisable forever, and it restores the player into
 * the exact firefight that just killed them. What a checkpoint should mean is
 * "you were here, this much was done, try that bit again" — so it stores the
 * progress and the place, and the mission rebuilds the situation from the
 * mission definition, which is the authority anyway.
 */
interface Checkpoint {
  completed: string[];
  position: Vec3;
  yaw: number;
  elapsed: number;
}

export interface MissionState {
  phase: MissionPhase;
  failure: FailureReason;
  /** Seconds since the mission became active. */
  elapsed: number;
  /** Counts up during the briefing and after a death. */
  transitionTimer: number;
  objectives: Map<string, ObjectiveState>;
  /** Times the player has had to restart from a checkpoint. */
  restarts: number;
  /** The last line of radio traffic, for the HUD to show. */
  lastLine: string;
}

export class CampaignDirector {
  readonly state: MissionState;

  /** Hostiles this director created, so it can clean them up on a restart. */
  private readonly hostiles = new Set<PlayerId>();
  /** Squad members by their authored id. */
  private readonly allies = new Map<string, PlayerId>();
  private readonly pending: PendingWave[] = [];
  private readonly events: SimEvent[] = [];
  private readonly using = new Set<PlayerId>();

  /** Bodies waiting to be removed, with the time left on each. */
  private readonly corpses = new Map<PlayerId, number>();
  private playerId: PlayerId = 0;
  private checkpoint: Checkpoint | null = null;
  private nextHostileName = 1;

  constructor(
    private readonly sim: GameSimulation,
    private readonly nav: NavGraph,
    private readonly bots: BotController,
    private readonly rng: Rng,
    readonly mission: MissionDef,
  ) {
    this.state = {
      phase: MissionPhase.Briefing,
      failure: FailureReason.None,
      elapsed: 0,
      transitionTimer: CAMPAIGN.briefingTime,
      objectives: new Map(
        mission.objectives.map((o) => [
          o.id,
          { id: o.id, active: false, complete: false, elapsed: 0, progress: 0, kills: 0 },
        ]),
      ),
      restarts: 0,
      lastLine: '',
    };

    // A campaign mission has no clock and no score limit: it ends when the
    // objectives do, or when you do.
    sim.world.match.phase = MatchPhase.Live;
    sim.world.match.timeRemaining = 0;
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  /** Place the player at the insertion point and stand the squad up around them. */
  begin(player: PlayerState): void {
    this.playerId = player.id;
    this.sim.spawnPlayer(player);
    this.placeAt(player, this.mission.insertion.position, this.mission.insertion.yaw);

    const difficulty = DIFFICULTIES[this.mission.difficulty] ?? DIFFICULTIES.regular!;

    for (const spec of this.mission.allies) {
      const bot = this.sim.addPlayer({
        name: spec.name,
        team: Team.Allies,
        isBot: true,
        botSkill: 0.65,
        loadout: botLoadout(spec.archetype, this.allies.size),
      });
      this.sim.spawnPlayer(bot);
      this.placeAt(bot, spec.spawn, this.mission.insertion.yaw);
      this.bots.register(bot.id, spec.archetype, difficulty);
      this.bots.setLeader(bot.id, player.id);
      this.allies.set(spec.id, bot.id);
    }

    for (const wave of this.mission.garrison ?? []) {
      this.pending.push({ objectiveId: '', wave, remaining: wave.count, timer: wave.delay ?? 0 });
    }
  }

  // -------------------------------------------------------------------------
  // Stepping
  // -------------------------------------------------------------------------

  /**
   * Advance the mission.
   *
   * `incoming` is the event stream the simulation just produced. The director
   * reads it rather than polling, so a kill is counted exactly once and at the
   * moment it happened.
   */
  step(dt: number, incoming: readonly SimEvent[]): SimEvent[] {
    this.events.length = 0;
    const s = this.state;

    if (s.phase === MissionPhase.Briefing) {
      s.transitionTimer -= dt;
      if (s.transitionTimer <= 0) {
        s.phase = MissionPhase.Active;
        this.activateReady();
      }
      return this.drain();
    }

    if (s.phase === MissionPhase.Failed) {
      s.transitionTimer -= dt;
      if (s.transitionTimer <= 0) this.restoreCheckpoint();
      return this.drain();
    }

    if (s.phase === MissionPhase.Complete) return this.drain();

    s.elapsed += dt;
    this.consume(incoming);
    this.reapCorpses(dt);
    this.stepWaves(dt);
    this.stepObjectives(dt);
    this.checkFailure();

    return this.drain();
  }

  /** Count kills and deaths against the mission. */
  private consume(incoming: readonly SimEvent[]): void {
    for (const e of incoming) {
      if (e.type !== SimEventType.Kill) continue;
      const victim = this.sim.world.players.get(e.victim);
      if (!victim) continue;

      if (victim.team === Team.Hostile) {
        this.hostiles.delete(e.victim);
        this.corpses.set(e.victim, CAMPAIGN.corpseLinger);
        // Credit every active objective. An objective that does not care about
        // kills simply never reads the counter.
        for (const os of this.state.objectives.values()) {
          if (os.active && !os.complete) os.kills++;
        }
      }
    }
  }

  /**
   * Take the bodies out of the world.
   *
   * Not cosmetic: `world.players` has a hard cap, and a mission that spawns
   * eighty hostiles across ten minutes will reach it and then silently stop
   * being able to spawn the ones its last objective depends on. Every hostile
   * this director creates is one it has to clean up.
   */
  private reapCorpses(dt: number): void {
    for (const [id, remaining] of this.corpses) {
      const left = remaining - dt;
      if (left > 0) {
        this.corpses.set(id, left);
        continue;
      }
      this.corpses.delete(id);
      this.bots.unregister(id);
      this.sim.removePlayer(id);
    }
  }

  /** Hostiles arrive on their own schedule, capped so a mission stays playable. */
  private stepWaves(dt: number): void {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i]!;

      // A wave attached to an objective stops the moment that objective is done.
      if (p.objectiveId) {
        const os = this.state.objectives.get(p.objectiveId);
        if (!os || !os.active || os.complete) {
          this.pending.splice(i, 1);
          continue;
        }
      }

      p.timer -= dt;
      if (p.timer > 0) continue;
      if (this.hostiles.size >= CAMPAIGN.maxConcurrentHostiles) {
        // Hold the queue rather than dropping it: the fight stays as long as it
        // was authored to be, it just does not become a wall of bodies.
        p.timer = 0.5;
        continue;
      }

      this.spawnHostile(p.wave);
      p.timer = p.wave.interval;

      if (!p.wave.endless) {
        p.remaining--;
        if (p.remaining <= 0) this.pending.splice(i, 1);
      }
    }
  }

  private stepObjectives(dt: number): void {
    let anyIncomplete = false;

    for (const def of this.mission.objectives) {
      const os = this.state.objectives.get(def.id)!;
      if (os.complete) continue;
      anyIncomplete = true;
      if (!os.active) continue;

      os.elapsed += dt;

      if (def.timeLimit && def.timeLimit > 0 && os.elapsed > def.timeLimit) {
        this.fail(FailureReason.OutOfTime);
        return;
      }

      if (this.evaluate(def, os, dt)) {
        os.complete = true;
        os.active = false;
        os.progress = 1;
        // Hand the escort back to the squad now they have arrived.
        if (def.trigger.kind === 'escort') {
          const id = this.allies.get(def.trigger.ally);
          if (id !== undefined) this.bots.orderTo(id, null);
        }

        this.emit(SimEventType.ObjectiveCaptured, { objective: def.id, label: def.label });

        if (def.checkpoint) this.saveCheckpoint();
        this.activateReady();
      }
    }

    if (!anyIncomplete) this.complete();
  }

  /**
   * Has this objective's trigger fired?
   *
   * Each arm answers using only what the simulation already knows. Nothing here
   * reaches into a system to ask it to behave differently.
   */
  private evaluate(def: Objective, os: ObjectiveState, dt: number): boolean {
    const t = def.trigger;
    const player = this.sim.world.players.get(this.playerId);

    switch (t.kind) {
      case 'reach': {
        if (!player || !player.alive) return false;
        os.progress = inZone(player.position, t.zone) ? 1 : 0;
        return os.progress === 1;
      }

      case 'eliminate': {
        os.progress = Math.min(1, os.kills / Math.max(1, t.count));
        return os.kills >= t.count;
      }

      case 'clear': {
        const queued = this.pending.some((p) => p.objectiveId === def.id);
        os.progress = this.hostiles.size === 0 && !queued ? 1 : 0;
        return os.progress === 1;
      }

      case 'survive': {
        os.progress = Math.min(1, os.elapsed / t.seconds);
        return os.elapsed >= t.seconds;
      }

      case 'hold': {
        if (player && player.alive && inZone(player.position, t.zone)) {
          // `progress` doubles as the accumulator, in seconds, normalised on read.
          os.progress = Math.min(1, os.progress + dt / t.seconds);
        }
        return os.progress >= 1;
      }

      case 'interact': {
        const inside = player && player.alive && inZone(player.position, t.zone);
        if (inside && this.using.has(this.playerId)) {
          os.progress = Math.min(1, os.progress + dt / t.seconds);
        }
        // Leaving pauses it and keeps what you have. Losing the progress would
        // make a contested plant unwinnable rather than tense.
        return os.progress >= 1;
      }

      case 'escort': {
        const id = this.allies.get(t.ally);
        const ally = id ? this.sim.world.players.get(id) : undefined;
        if (!ally || !ally.alive) return false;
        os.progress = inZone(ally.position, t.zone) ? 1 : 0;
        return os.progress === 1;
      }

      default:
        return false;
    }
  }

  /** Start every objective whose dependencies are now met. */
  private activateReady(): void {
    for (const def of this.mission.objectives) {
      const os = this.state.objectives.get(def.id)!;
      if (os.active || os.complete) continue;
      const ready = (def.after ?? []).every((d) => this.state.objectives.get(d)?.complete);
      if (!ready) continue;

      os.active = true;
      os.elapsed = 0;
      os.kills = 0;
      os.progress = 0;

      // An escort has to be told where it is being escorted to. Allies otherwise
      // follow the player, which is right for every other objective and exactly
      // wrong for this one: the mission waits for someone to reach a relay that
      // nobody has asked them to walk to.
      if (def.trigger.kind === 'escort') {
        const id = this.allies.get(def.trigger.ally);
        if (id !== undefined) this.bots.orderTo(id, def.trigger.zone.center);
      }

      for (const wave of def.waves ?? []) {
        this.pending.push({
          objectiveId: def.id,
          wave,
          remaining: wave.count,
          timer: wave.delay ?? 0,
        });
      }

      this.emit(SimEventType.ObjectiveContested, { objective: def.id, label: def.label });
      if (def.line) this.say(def.line);
    }
  }

  // -------------------------------------------------------------------------
  // Failure and checkpoints
  // -------------------------------------------------------------------------

  private checkFailure(): void {
    const player = this.sim.world.players.get(this.playerId);
    if (!player || (!player.alive && player.respawnTimer <= 0)) {
      this.fail(FailureReason.PlayerDown);
      return;
    }

    for (const spec of this.mission.allies) {
      if (!spec.essential) continue;
      const id = this.allies.get(spec.id);
      const ally = id ? this.sim.world.players.get(id) : undefined;
      if (!ally || !ally.alive) {
        this.fail(FailureReason.AllyLost);
        return;
      }
    }
  }

  private fail(reason: FailureReason): void {
    if (this.state.phase !== MissionPhase.Active) return;
    this.state.phase = MissionPhase.Failed;
    this.state.failure = reason;
    this.state.transitionTimer = CAMPAIGN.restartDelay;
    this.emit(SimEventType.RoundEnd, { failed: true, reason });
  }

  private complete(): void {
    this.state.phase = MissionPhase.Complete;
    this.emit(SimEventType.MatchStateChanged, { mission: this.mission.id, complete: true });
    this.say(this.mission.outro);
  }

  private saveCheckpoint(): void {
    const player = this.sim.world.players.get(this.playerId);
    if (!player) return;
    this.checkpoint = {
      completed: [...this.state.objectives.values()].filter((o) => o.complete).map((o) => o.id),
      position: vec3(player.position.x, player.position.y, player.position.z),
      yaw: player.yaw,
      elapsed: this.state.elapsed,
    };
    this.emit(SimEventType.RoundStart, { checkpoint: true });
  }

  /**
   * Put the mission back the way it was at the last checkpoint.
   *
   * Everything the director spawned is removed and the objective graph is reset
   * to the saved set, which re-queues that objective's waves through the normal
   * activation path. The fight the player lost is rebuilt from the mission
   * definition rather than restored from a snapshot, so it is the same fight but
   * not the same instant — which is what makes a second attempt feel like one.
   */
  private restoreCheckpoint(): void {
    const s = this.state;
    const cp = this.checkpoint;

    for (const id of this.hostiles) {
      this.bots.unregister(id);
      this.sim.removePlayer(id);
    }
    for (const id of this.corpses.keys()) {
      this.bots.unregister(id);
      this.sim.removePlayer(id);
    }
    this.hostiles.clear();
    this.corpses.clear();
    this.pending.length = 0;

    const done = new Set(cp?.completed ?? []);
    for (const os of s.objectives.values()) {
      os.complete = done.has(os.id);
      os.active = false;
      os.elapsed = 0;
      os.progress = 0;
      os.kills = 0;
    }

    const player = this.sim.world.players.get(this.playerId);
    if (player) {
      this.sim.spawnPlayer(player);
      if (cp) this.placeAt(player, cp.position, cp.yaw);
      else this.placeAt(player, this.mission.insertion.position, this.mission.insertion.yaw);
    }

    // The squad comes back with you. A mission that permanently loses a
    // squadmate to a checkpoint restart gets harder every time you fail it,
    // which is precisely backwards.
    for (const spec of this.mission.allies) {
      const id = this.allies.get(spec.id);
      const ally = id ? this.sim.world.players.get(id) : undefined;
      if (!ally) continue;
      if (!ally.alive) this.sim.spawnPlayer(ally);
      this.placeAt(ally, cp?.position ?? spec.spawn, cp?.yaw ?? this.mission.insertion.yaw);
    }

    s.elapsed = cp?.elapsed ?? 0;
    s.restarts++;
    s.failure = FailureReason.None;
    s.phase = MissionPhase.Active;

    if (!cp) {
      for (const wave of this.mission.garrison ?? []) {
        this.pending.push({ objectiveId: '', wave, remaining: wave.count, timer: wave.delay ?? 0 });
      }
    }

    this.activateReady();
  }

  // -------------------------------------------------------------------------
  // Hostiles
  // -------------------------------------------------------------------------

  private spawnHostile(wave: Wave): void {
    const archetypes = wave.archetypes ?? BOT_ARCHETYPES;
    const archetype = archetypes[this.rng.int(0, archetypes.length - 1)] as BotArchetype;
    const difficulty = DIFFICULTIES[this.mission.difficulty] ?? DIFFICULTIES.regular!;

    const bot = this.sim.addPlayer({
      name: `Hostile${this.nextHostileName++}`,
      team: Team.Hostile,
      isBot: true,
      botSkill: 0.5,
      loadout: botLoadout(archetype, this.nextHostileName),
    });
    this.sim.spawnPlayer(bot);

    // Scatter a little so a wave does not arrive as a stack of bodies on one
    // point, and drop onto real ground rather than trusting the authored Y.
    const spread = 1.6;
    const x = wave.spawn.x + this.rng.range(-spread, spread);
    const z = wave.spawn.z + this.rng.range(-spread, spread);
    const groundY = this.sim.collision.groundHeightAt(x, z, wave.spawn.y + 2, 8);
    this.placeAt(bot, vec3(x, Number.isFinite(groundY) ? groundY + 0.05 : wave.spawn.y, z), 0);

    this.bots.register(bot.id, archetype, difficulty);
    // Hold the ground you were put on. Without a post a hostile roams, and
    // roaming rewards distance — so it leaves the position it was spawned to
    // defend and follows the player around the map instead.
    this.bots.orderTo(bot.id, wave.post ?? wave.spawn);
    this.hostiles.add(bot.id);
  }

  private placeAt(player: PlayerState, position: Vec3, yaw: number): void {
    player.position.x = position.x;
    player.position.y = position.y;
    player.position.z = position.z;
    player.velocity.x = 0;
    player.velocity.y = 0;
    player.velocity.z = 0;
    player.yaw = yaw;
  }

  // -------------------------------------------------------------------------
  // Interface for the client
  // -------------------------------------------------------------------------

  /** Tell the director whether a player is holding the use key this tick. */
  setUsing(id: PlayerId, held: boolean): void {
    if (held) this.using.add(id);
    else this.using.delete(id);
  }

  /** The objectives to draw, in the order they were authored. */
  activeObjectives(): CampaignHudObjective[] {
    const out: CampaignHudObjective[] = [];
    for (const def of this.mission.objectives) {
      const os = this.state.objectives.get(def.id)!;
      if (!os.active || os.complete) continue;
      out.push({ label: def.label, progress: os.progress, position: triggerPosition(def) });
    }
    return out;
  }

  /** How far the squad has strayed, for a "regroup" cue. Infinity with no squad. */
  squadSpread(): number {
    const player = this.sim.world.players.get(this.playerId);
    if (!player) return Infinity;
    let worst = 0;
    for (const id of this.allies.values()) {
      const ally = this.sim.world.players.get(id);
      if (!ally || !ally.alive) continue;
      worst = Math.max(worst, v3distanceXZ(player.position, ally.position));
    }
    return worst;
  }

  /** Live hostile count, for the HUD and for tests. */
  get hostileCount(): number {
    return this.hostiles.size;
  }

  get allyIds(): PlayerId[] {
    return [...this.allies.values()];
  }

  // -------------------------------------------------------------------------

  private emit(type: SimEventType, data: Record<string, unknown>): void {
    this.events.push({ type, tick: this.sim.world.tick, data } as SimEvent);
  }

  private say(line: string): void {
    this.state.lastLine = line;
    this.events.push({
      type: SimEventType.Announce,
      tick: this.sim.world.tick,
      team: Team.Allies,
      line,
    });
  }

  private drain(): SimEvent[] {
    return this.events.length > 0 ? this.events.slice() : EMPTY;
  }
}

const EMPTY: SimEvent[] = [];

// ---------------------------------------------------------------------------

function inZone(p: Vec3, zone: Zone): boolean {
  return (
    Math.abs(p.x - zone.center.x) <= zone.size.x / 2 &&
    Math.abs(p.y - zone.center.y) <= zone.size.y / 2 &&
    Math.abs(p.z - zone.center.z) <= zone.size.z / 2
  );
}

/** Where to draw an objective marker, or null for the ones that have no place. */
function triggerPosition(def: Objective): Vec3 | null {
  const t = def.trigger;
  if (t.kind === 'reach' || t.kind === 'hold' || t.kind === 'interact' || t.kind === 'escort') {
    return t.zone.center;
  }
  return null;
}

export { TICK_DT, v3distance };
