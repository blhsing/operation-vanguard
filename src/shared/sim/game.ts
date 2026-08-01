/**
 * The simulation.
 *
 * One class owns the whole game tick, and it is transport-agnostic: the same
 * `GameSimulation` runs inside the browser for offline play against bots and
 * inside the Node server for online matches. That is the central architectural
 * bet of this project — there is exactly one implementation of "what happens
 * when you pull the trigger", so offline and online can never disagree about it.
 *
 * Everything the presentation layer needs comes out as a `SimEvent` stream. The
 * renderer, the audio engine, the HUD and the network layer all consume the same
 * events, so adding a new feedback channel never means touching gameplay code.
 */

import {
  HEALTH,
  MATCH,
  PERCEPTION,
  SCORE,
  TICK_DT,
  type HitLocation,
} from '../constants.js';
import {
  anglesToForward,
  clamp,
  clamp01,
  v3addScaled,
  v3copy,
  v3distance,
  v3lengthSq,
  v3normalize,
  v3scale,
  v3set,
  v3sub,
  vec3,
  type Vec3,
} from '../math.js';
import { Rng, mixSeeds } from '../rng.js';
import {
  DamageCause,
  InputFlag,
  MatchPhase,
  MoveState,
  ProjectileKind,
  SimEventType,
  SurfaceType,
  Team,
  WeaponAction,
  WeaponSlot,
  createEmptyInput,
  hasFlag,
  isEnemyTeam,
  opposingTeam,
  type DamageInfo,
  type EntityId,
  type InputCommand,
  type PlayerId,
  type PlayerState,
  type ProjectileState,
  type SimEvent,
  type WorldState,
} from '../types.js';
import { BrushCollisionWorld, type DynamicCollider } from '../collision/brush-collision.js';
import { CollisionLayer, type QueryFilter } from '../collision/collision-types.js';
import { getMap } from '../map/index.js';
import type { MapDef } from '../map/map-types.js';
import { getMode, type GameModeDef } from '../data/modes.js';
import { getWeapon, tryGetWeapon } from '../data/weapons.js';
import { WeaponClass, WeaponTrait, type WeaponDef } from '../data/weapon-types.js';
import { getEquipment, type EquipmentDef } from '../data/equipment.js';
import { KILLSTREAKS } from '../data/killstreaks.js';

import {
  applyDamage,
  applySpread,
  computeAssists,
  createTraceResult,
  findMeleeTarget,
  isBehind,
  resolveExplosion,
  traceShot,
  type ExplosionTarget,
  type TraceResult,
} from './combat.js';
import {
  currentEyeHeight,
  eyePosition,
  horizontalSpeed,
  resetStride,
  stepMovement,
  type MovementModifiers,
} from './movement.js';
import {
  activeWeapon,
  isSuppressed,
  resetWeaponRuntime,
  setTrigger,
  stepWeapon,
  type WeaponModifiers,
} from './weapon-system.js';
import {
  addDangerZone,
  createSpawnContext,
  noteDeath,
  respawnDelayFor,
  selectSpawn,
  tickSpawnContext,
  type SpawnContext,
} from './spawn.js';
import {
  applyLoadout,
  defaultLoadout,
  resolveLoadout,
  type Loadout,
  type ResolvedLoadout,
} from './loadout.js';
import {
  createObjectiveState,
  dropTag,
  objectiveSummary,
  resetRound,
  respawnAllowed,
  stepObjectives,
  type ObjectiveState,
} from './objectives.js';
import { setGroupWeights } from './spawn.js';
import {
  addPlayer as addPlayerToWorld,
  allocEntityId,
  addTeamScore,
  clampToBounds,
  createPlayer,
  createProjectile,
  createWorld,
  killPlayer,
  playerCapsule,
  removePlayer as removePlayerFromWorld,
  respawnPlayer,
} from './world.js';

// ---------------------------------------------------------------------------

export interface GameOptions {
  mapId: string;
  modeId: string;
  seed?: string;
  /** Friendly fire is off by default, as in every COD public playlist. */
  friendlyFire?: boolean;
}

/** Per-player data the simulation keeps but that isn't part of PlayerState. */
interface PlayerRuntime {
  loadout: Loadout;
  resolved: ResolvedLoadout;
  input: InputCommand;
  /** Set when the player has asked to respawn (or is a bot, which always has). */
  wantsRespawn: boolean;
  /** Accumulates toward the objective score tick. */
  objectiveTickAccum: number;
}

const _eye = vec3();
const _dir = vec3();
const _spreadDir = vec3();
const _tmp = vec3();
const _dmgDir = vec3();
const _trace: TraceResult = createTraceResult();
const _explosionTargets: ExplosionTarget[] = [];

const SIGHT_FILTER: QueryFilter = { layers: CollisionLayer.Sight };

export class GameSimulation {
  readonly world: WorldState;
  readonly map: MapDef;
  readonly mode: GameModeDef;
  readonly collision: BrushCollisionWorld;
  readonly rng: Rng;
  readonly spawnCtx: SpawnContext;
  readonly friendlyFire: boolean;
  readonly objectives: ObjectiveState;

  /** Events produced this tick. Cleared at the start of every step. */
  private events: SimEvent[] = [];
  private readonly runtimes = new Map<PlayerId, PlayerRuntime>();
  private readonly dynamicColliders: DynamicCollider[] = [];
  private nextPlayerId = 1;

  constructor(opts: GameOptions) {
    this.map = getMap(opts.mapId);
    this.mode = getMode(opts.modeId);
    this.world = createWorld({ mapId: opts.mapId, modeId: opts.modeId, seed: opts.seed });
    this.collision = new BrushCollisionWorld(this.map.brushes, this.map.bounds);
    this.rng = new Rng(this.world.rngState);
    this.spawnCtx = createSpawnContext();
    this.friendlyFire = opts.friendlyFire ?? false;
    this.objectives = createObjectiveState(this.map, this.mode);

    this.world.match.phase = MatchPhase.Warmup;
    this.world.match.timeRemaining = MATCH.warmupDuration;
  }

  // -------------------------------------------------------------------------
  // Players
  // -------------------------------------------------------------------------

  addPlayer(opts: {
    name: string;
    team: Team;
    isBot?: boolean;
    botSkill?: number;
    loadout?: Loadout;
    id?: PlayerId;
  }): PlayerState {
    const id = opts.id ?? this.nextPlayerId++;
    if (id >= this.nextPlayerId) this.nextPlayerId = id + 1;

    const player = createPlayer({
      id,
      name: opts.name,
      team: opts.team,
      isBot: opts.isBot,
      botSkill: opts.botSkill,
    });
    addPlayerToWorld(this.world, player);

    const loadout = opts.loadout ?? defaultLoadout();
    this.runtimes.set(id, {
      loadout,
      resolved: resolveLoadout(loadout),
      input: createEmptyInput(),
      wantsRespawn: true,
      objectiveTickAccum: 0,
    });

    // Dead until the first spawn pass picks them up, so they enter through the
    // same code path as every subsequent respawn.
    player.alive = false;
    player.respawnTimer = 0;
    return player;
  }

  removePlayer(id: PlayerId): void {
    removePlayerFromWorld(this.world, id);
    this.runtimes.delete(id);
    resetWeaponRuntime(id);
    resetStride(id);
  }

  setLoadout(id: PlayerId, loadout: Loadout): void {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    rt.loadout = loadout;
    rt.resolved = resolveLoadout(loadout);
    // Applied on next spawn, never mid-life — swapping guns from a menu would be
    // a balance hole.
  }

  setInput(id: PlayerId, input: InputCommand): void {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    rt.input = input;
    const player = this.world.players.get(id);
    if (player) player.lastProcessedInput = input.seq;
  }

  requestRespawn(id: PlayerId): void {
    const rt = this.runtimes.get(id);
    if (rt) rt.wantsRespawn = true;
  }

  getResolvedLoadout(id: PlayerId): ResolvedLoadout | undefined {
    return this.runtimes.get(id)?.resolved;
  }

  /** The effective weapon def a player is holding, with attachments applied. */
  activeWeaponDef(player: PlayerState): WeaponDef {
    const state = activeWeapon(player);
    if (!state) return getWeapon('p226');
    const rt = this.runtimes.get(player.id);
    if (rt) {
      if (rt.resolved.primary.id === state.defId) return rt.resolved.primary;
      if (rt.resolved.secondary.id === state.defId) return rt.resolved.secondary;
    }
    return tryGetWeapon(state.defId) ?? getWeapon('p226');
  }

  // -------------------------------------------------------------------------
  // Tick
  // -------------------------------------------------------------------------

  /** Advance the simulation by one tick and return the events it produced. */
  step(dt: number = TICK_DT): SimEvent[] {
    this.events = [];
    this.world.tick++;
    this.world.time += dt;
    this.rng.setState(this.world.rngState);

    this.updateDynamicColliders();
    tickSpawnContext(this.spawnCtx, dt, this.world.time);

    this.stepMatchPhase(dt);

    const live = this.world.match.phase === MatchPhase.Live ||
      this.world.match.phase === MatchPhase.Warmup ||
      this.world.match.phase === MatchPhase.Overtime;

    for (const player of this.world.players.values()) {
      const rt = this.runtimes.get(player.id);
      if (!rt) continue;

      if (!player.alive) {
        this.stepDeadPlayer(player, rt, dt, live);
        continue;
      }

      this.stepAlivePlayer(player, rt, dt, live);
    }

    this.stepProjectiles(dt);
    this.stepStatusEffects(dt);
    this.stepObjectiveMode(dt);

    this.world.rngState = this.rng.getState();
    return this.events;
  }

  /**
   * Advance the objective mode and fold its results back into the world.
   *
   * The objective engine is kept deliberately pure — it reads the world and
   * returns what should change — so the same code can later run server-side
   * against a replicated world without reaching into anything it does not own.
   */
  private stepObjectiveMode(dt: number): void {
    const result = stepObjectives(this.world, this.map, this.mode, this.objectives, dt);

    for (const [team, amount] of result.teamScore) {
      if (amount !== 0) addTeamScore(this.world, team, amount);
    }

    for (const award of result.playerScore) {
      const player = this.world.players.get(award.player);
      if (player) this.awardScore(player, award.amount, award.reason);
    }

    for (const event of result.events) {
      (event as { tick: number }).tick = this.world.tick;
      this.emit(event);
    }

    // Objective ownership decides which spawns are safe; this is what makes
    // Domination spawns flip when a flag changes hands.
    if (result.spawnWeights) setGroupWeights(this.spawnCtx, result.spawnWeights);

    if (result.roundWinner !== null) this.endRound(result.roundWinner);
  }

  /** Award a round to a team in a round-based mode, or end the match. */
  private endRound(winner: Team): void {
    const entry = this.world.match.scores.find((s) => s.team === winner);
    if (entry) entry.roundsWon++;

    this.emit({
      type: SimEventType.RoundEnd,
      tick: this.world.tick,
      team: winner,
      data: { round: this.world.match.round },
    });

    if ((entry?.roundsWon ?? 0) >= this.mode.roundsToWin) {
      this.endMatch(winner);
      return;
    }

    this.world.match.round++;
    this.world.match.timeRemaining = this.mode.roundTime;
    resetRound(this.objectives, this.mode, this.world.match.round);

    // Everyone comes back for the next round, wherever they fell.
    for (const player of this.world.players.values()) {
      const rt = this.runtimes.get(player.id);
      if (!rt) continue;
      rt.wantsRespawn = true;
      player.respawnTimer = 0;
      if (player.alive) killPlayer(player, 0);
    }
  }

  /** Snapshot of objective state for the HUD. */
  objectiveStatus(): ReturnType<typeof objectiveSummary> {
    return objectiveSummary(this.objectives);
  }

  // -------------------------------------------------------------------------
  // Match flow
  // -------------------------------------------------------------------------

  private stepMatchPhase(dt: number): void {
    const match = this.world.match;
    match.timeRemaining -= dt;

    switch (match.phase) {
      case MatchPhase.Warmup:
        if (match.timeRemaining <= 0) {
          match.phase = MatchPhase.Live;
          match.timeRemaining = this.mode.timeLimit > 0 ? this.mode.timeLimit : this.mode.roundTime;
          match.round = 1;
          this.emit({
            type: SimEventType.MatchStateChanged,
            tick: this.world.tick,
            data: { phase: MatchPhase.Live },
          });
          this.emit({
            type: SimEventType.Announce,
            tick: this.world.tick,
            team: Team.None,
            line: this.mode.introLine,
          });
        }
        break;

      case MatchPhase.Live:
      case MatchPhase.Overtime: {
        // Score limit.
        if (this.mode.scoreLimit > 0) {
          for (const entry of match.scores) {
            if (entry.score >= this.mode.scoreLimit) {
              this.endMatch(entry.team);
              return;
            }
          }
          // Free-for-all: individual score limit.
          if (!this.mode.teamBased) {
            for (const p of this.world.players.values()) {
              if (p.kills >= this.mode.scoreLimit) {
                this.endMatch(Team.None);
                return;
              }
            }
          }
        }

        if (match.timeRemaining <= 0) {
          this.endMatch(this.leadingTeam());
        }
        break;
      }

      case MatchPhase.MatchEnd:
        if (match.timeRemaining <= 0) {
          // Held here until the host restarts; the lobby drives what happens next.
          match.timeRemaining = 0;
        }
        break;

      default:
        break;
    }
  }

  private leadingTeam(): Team | null {
    if (!this.mode.teamBased) return Team.None;
    const allies = this.world.match.scores.find((s) => s.team === Team.Allies)?.score ?? 0;
    const axis = this.world.match.scores.find((s) => s.team === Team.Axis)?.score ?? 0;
    if (allies === axis) return null;
    return allies > axis ? Team.Allies : Team.Axis;
  }

  private endMatch(winner: Team | null): void {
    const match = this.world.match;
    if (match.phase === MatchPhase.MatchEnd) return;
    match.phase = MatchPhase.MatchEnd;
    match.winner = winner;
    match.timeRemaining = MATCH.outroDuration;
    this.emit({
      type: SimEventType.MatchStateChanged,
      tick: this.world.tick,
      data: { phase: MatchPhase.MatchEnd, winner },
    });
  }

  // -------------------------------------------------------------------------
  // Player stepping
  // -------------------------------------------------------------------------

  private stepDeadPlayer(
    player: PlayerState,
    rt: PlayerRuntime,
    dt: number,
    live: boolean,
  ): void {
    if (!live) return;
    if (!this.mode.respawn && this.world.match.phase === MatchPhase.Live) {
      // Round-based modes without respawn: the player stays down until the round
      // ends and the mode hook resets everyone.
      return;
    }

    player.respawnTimer -= dt;
    if (player.respawnTimer > 0) return;
    if (!rt.wantsRespawn) return;
    // Headquarters: the team holding the HQ does not respawn while they hold it.
    if (!respawnAllowed(this.mode, this.objectives, player)) return;

    this.spawnPlayer(player, rt);
  }

  spawnPlayer(player: PlayerState, rt?: PlayerRuntime): void {
    const runtime = rt ?? this.runtimes.get(player.id);
    if (!runtime) return;

    const choice = selectSpawn(
      this.world,
      this.map,
      this.collision,
      this.spawnCtx,
      player,
      this.rng,
    );
    if (!choice) return;

    respawnPlayer(player, choice.position, choice.yaw);
    applyLoadout(player, runtime.resolved);
    resetWeaponRuntime(player.id);
    resetStride(player.id);
    runtime.wantsRespawn = player.isBot;

    this.emit({
      type: SimEventType.Spawn,
      tick: this.world.tick,
      player: player.id,
      team: player.team,
      position: vec3(choice.position.x, choice.position.y, choice.position.z),
    });
  }

  private stepAlivePlayer(
    player: PlayerState,
    rt: PlayerRuntime,
    dt: number,
    live: boolean,
  ): void {
    const input = rt.input;
    const weaponDef = this.activeWeaponDef(player);
    const perks = rt.resolved.perks;

    // --- movement ---------------------------------------------------------
    const moveMods: MovementModifiers = {
      speedMultiplier: weaponDef.handling.movementSpeedMultiplier * (perks.movementSpeedMult ?? 1),
      adsSpeedMultiplier: weaponDef.handling.adsSpeedMultiplier,
      adsProgress: player.adsProgress,
      sprintBlocked: player.action === WeaponAction.Reloading && weaponDef.class === WeaponClass.Launcher,
      slideBlocked: false,
      // Concussion and flash slow the player; the effect decays with the status.
      slowMultiplier: 1 - clamp01(player.concussionAmount) * 0.45,
      fallDamageImmune: perks.fallDamageImmune ?? false,
    };

    const move = stepMovement(player, input, this.collision, dt, moveMods);

    if (move.jumped) {
      this.emit({ type: SimEventType.Jump, tick: this.world.tick, player: player.id, position: v3clone(player.position) });
    }
    if (move.landed) {
      this.emit({ type: SimEventType.Land, tick: this.world.tick, player: player.id, position: v3clone(player.position) });
      if (move.fallDamage > 0) {
        this.damagePlayer(player, {
          amount: move.fallDamage,
          attacker: player.id,
          victim: player.id,
          cause: DamageCause.Fall,
          weaponId: '',
          location: 'lowerLeg',
          position: v3clone(player.position),
          direction: vec3(0, 1, 0),
          distance: 0,
          ignoreArmor: true,
        });
      }
    }
    if (move.startedSlide) {
      this.emit({ type: SimEventType.Slide, tick: this.world.tick, player: player.id, position: v3clone(player.position) });
    }
    if (move.startedMantle) {
      this.emit({ type: SimEventType.Mantle, tick: this.world.tick, player: player.id, position: v3clone(player.position) });
    }
    if (move.footstep) {
      const surface = this.surfaceUnder(player.position);
      const silent = perks.silentMovement === true;
      this.emit({
        type: SimEventType.Footstep,
        tick: this.world.tick,
        player: player.id,
        position: v3clone(player.position),
        surface,
        loud: move.footstepLoud && !silent,
      });
    }

    // Out of bounds and world-fall recovery.
    if (clampToBounds(player.position, this.map.bounds)) {
      // Being shoved back inside is preferable to falling out of the world; if
      // a player somehow ends up under the map they get killed instead.
      if (player.position.y > this.map.bounds.max.y - 1) {
        this.killPlayerWith(player, player.id, DamageCause.OutOfBounds, '');
        return;
      }
    }

    // --- weapon -----------------------------------------------------------
    setTrigger(player, input);

    const weaponMods: WeaponModifiers = {
      reloadSpeedMult: 1 / (perks.reloadSpeedMult ?? 1),
      adsSpeedMult: 1 / (perks.adsSpeedMult ?? 1),
      swapSpeedMult: 1 / (perks.swapSpeedMult ?? 1),
      sprintOutMult: 1 / (perks.sprintOutMult ?? 1),
      hipSpreadMult: 1,
      fireBlocked: !live || this.world.match.phase === MatchPhase.MatchEnd,
    };

    const weaponResult = stepWeapon(
      player,
      input,
      this.world.time,
      dt,
      this.rng,
      (state) => this.resolveWeaponState(player, state.defId),
      weaponMods,
    );

    if (weaponResult.reloadStarted) {
      this.emit({ type: SimEventType.Reload, tick: this.world.tick, player: player.id, position: v3clone(player.position) });
    }
    if (weaponResult.reloadFinished) {
      this.emit({ type: SimEventType.ReloadComplete, tick: this.world.tick, player: player.id });
    }
    if (weaponResult.swapFinished) {
      this.emit({ type: SimEventType.WeaponSwap, tick: this.world.tick, player: player.id });
    }
    if (weaponResult.meleeSwing) {
      this.resolveMelee(player);
    }

    if (weaponResult.shotsFired > 0) {
      this.fireShots(player, weaponDef, weaponResult.shotsFired, weaponResult.pelletsPerShot, weaponResult.spread, weaponResult.shotIndexBase);
    }

    // --- equipment --------------------------------------------------------
    this.handleEquipment(player, rt, input, dt);

    // --- health regen -----------------------------------------------------
    player.timeSinceDamage += dt;
    const regenDelay = HEALTH.regenDelay * (perks.healthRegenDelayMult ?? 1);
    if (player.health < player.maxHealth && player.timeSinceDamage >= regenDelay) {
      const rate = HEALTH.regenRate * (perks.healthRegenRateMult ?? 1);
      player.health = Math.min(player.maxHealth, player.health + rate * dt);
    }

    // --- killstreak progress ----------------------------------------------
    this.updateKillstreaks(player, rt);
  }

  private resolveWeaponState(player: PlayerState, defId: string): WeaponDef {
    const rt = this.runtimes.get(player.id);
    if (rt) {
      if (rt.resolved.primary.id === defId) return rt.resolved.primary;
      if (rt.resolved.secondary.id === defId) return rt.resolved.secondary;
    }
    return tryGetWeapon(defId) ?? getWeapon('p226');
  }

  // -------------------------------------------------------------------------
  // Shooting
  // -------------------------------------------------------------------------

  private fireShots(
    player: PlayerState,
    weapon: WeaponDef,
    shots: number,
    pellets: number,
    spread: number,
    shotIndexBase: number,
  ): void {
    eyePosition(_eye, player);

    for (let shot = 0; shot < shots; shot++) {
      anglesToForward(_dir, player.yaw, player.pitch);

      this.emit({
        type: SimEventType.Shot,
        tick: this.world.tick,
        player: player.id,
        weaponId: weapon.id,
        origin: v3clone(_eye),
        direction: v3clone(_dir),
        suppressed: isSuppressed(weapon),
        shotIndex: shotIndexBase + shot,
      });

      // Explosive weapons launch a projectile instead of tracing.
      if (weapon.traits.includes(WeaponTrait.Explosive)) {
        this.launchWeaponProjectile(player, weapon, _eye, _dir);
        continue;
      }

      for (let pellet = 0; pellet < pellets; pellet++) {
        applySpread(_spreadDir, _dir, spread, this.rng);
        traceShot(this.world, this.collision, player, weapon, _eye, _spreadDir, _trace);
        this.applyTraceResult(player, weapon, _trace);
      }
    }
  }

  private applyTraceResult(shooter: PlayerState, weapon: WeaponDef, trace: TraceResult): void {
    if (trace.hitAnything && !trace.hitPlayer) {
      this.emit({
        type: SimEventType.Impact,
        tick: this.world.tick,
        position: v3clone(trace.point),
        normal: v3clone(trace.normal),
        surface: trace.surface,
        shooter: shooter.id,
        penetrated: trace.penetrations > 0,
      });
      return;
    }

    if (!trace.hitPlayer) {
      // Clean miss into the void — still worth an event so tracers terminate.
      this.emit({
        type: SimEventType.Impact,
        tick: this.world.tick,
        position: v3clone(trace.point),
        normal: v3clone(trace.normal),
        surface: SurfaceType.Concrete,
        shooter: shooter.id,
        penetrated: false,
      });
      return;
    }

    const victim = this.world.players.get(trace.victim);
    if (!victim || !victim.alive) return;

    v3sub(_dmgDir, victim.position, shooter.position);
    v3normalize(_dmgDir, _dmgDir);

    const info: DamageInfo = {
      amount: trace.damage,
      attacker: shooter.id,
      victim: victim.id,
      cause: DamageCause.Bullet,
      weaponId: weapon.id,
      location: trace.location,
      position: v3clone(trace.point),
      direction: v3clone(_dmgDir),
      distance: trace.distance,
      ignoreArmor: false,
    };

    const result = this.damagePlayer(victim, info);

    this.emit({
      type: SimEventType.Hit,
      tick: this.world.tick,
      attacker: shooter.id,
      victim: victim.id,
      location: trace.location,
      damage: result.applied,
      lethal: result.killed,
      position: v3clone(trace.point),
      weaponId: weapon.id,
    });

    if (trace.location === 'head') shooter.headshots++;
  }

  private launchWeaponProjectile(
    player: PlayerState,
    weapon: WeaponDef,
    origin: Vec3,
    dir: Vec3,
  ): void {
    const kind =
      weapon.id === 'gl40' ? ProjectileKind.GrenadeLauncher : ProjectileKind.Rocket;
    const speed = Number.isFinite(weapon.muzzleVelocity) ? weapon.muzzleVelocity : 60;
    v3scale(_tmp, dir, speed);
    // Inherit the shooter's motion so a rocket fired while running goes where it
    // looks like it should.
    _tmp.x += player.velocity.x;
    _tmp.z += player.velocity.z;

    const id = allocEntityId(this.world);
    const proj = createProjectile(id, kind, player.id, player.team, origin, _tmp, 12);
    proj.armed = true;
    this.world.projectiles.set(id, proj);
  }

  // -------------------------------------------------------------------------
  // Melee
  // -------------------------------------------------------------------------

  private resolveMelee(player: PlayerState): void {
    const target = findMeleeTarget(this.world, this.collision, player);
    this.emit({
      type: SimEventType.Melee,
      tick: this.world.tick,
      player: player.id,
      position: v3clone(player.position),
    });
    if (!target) return;

    const weapon = this.activeWeaponDef(player);
    // A backstab is an execution; a frontal bash is a solid but survivable hit.
    const backstab = isBehind(player, target);
    const damage = backstab ? 200 : weapon.meleeDamage;

    v3sub(_dmgDir, target.position, player.position);
    v3normalize(_dmgDir, _dmgDir);

    this.damagePlayer(target, {
      amount: damage,
      attacker: player.id,
      victim: target.id,
      cause: DamageCause.Melee,
      weaponId: weapon.id,
      location: 'chest',
      position: v3clone(target.position),
      direction: v3clone(_dmgDir),
      distance: v3distance(player.position, target.position),
      ignoreArmor: backstab,
    });
  }

  // -------------------------------------------------------------------------
  // Equipment
  // -------------------------------------------------------------------------

  private handleEquipment(
    player: PlayerState,
    rt: PlayerRuntime,
    input: InputCommand,
    dt: number,
  ): void {
    void dt;
    if (hasFlag(input.buttons, InputFlag.Lethal) && player.lethalCount > 0) {
      const def = rt.resolved.lethal;
      if (def) {
        this.throwEquipment(player, def);
        player.lethalCount--;
      }
    }
    if (hasFlag(input.buttons, InputFlag.Tactical) && player.tacticalCount > 0) {
      const def = rt.resolved.tactical;
      if (def) {
        this.throwEquipment(player, def);
        player.tacticalCount--;
      }
    }
  }

  private throwEquipment(player: PlayerState, def: EquipmentDef): void {
    eyePosition(_eye, player);
    anglesToForward(_dir, player.yaw, player.pitch);

    const speed = def.throwSpeed ?? 18;
    v3scale(_tmp, _dir, speed);
    // A small upward bias so a flat throw arcs rather than hitting the floor.
    _tmp.y += 2.2;
    _tmp.x += player.velocity.x * 0.5;
    _tmp.z += player.velocity.z * 0.5;

    const id = allocEntityId(this.world);
    const kind = def.projectileKind ?? ProjectileKind.Frag;
    const proj = createProjectile(id, kind, player.id, player.team, _eye, _tmp, def.fuse ?? 3.5);
    proj.armed = true;
    this.world.projectiles.set(id, proj);

    this.emit({
      type: SimEventType.ProjectileThrown,
      tick: this.world.tick,
      player: player.id,
      position: v3clone(_eye),
      data: { equipmentId: def.id, kind },
    });
  }

  // -------------------------------------------------------------------------
  // Projectiles
  // -------------------------------------------------------------------------

  private stepProjectiles(dt: number): void {
    const gravity = 21.5;

    for (const proj of Array.from(this.world.projectiles.values())) {
      proj.age += dt;

      if (!proj.stuck) {
        proj.velocity.y -= gravity * dt;

        v3scale(_tmp, proj.velocity, dt);
        const dist = Math.sqrt(v3lengthSq(_tmp));

        if (dist > 1e-5) {
          v3normalize(_dir, _tmp);
          const hit = this.collision.raycast(
            proj.position,
            _dir,
            dist,
            { layers: CollisionLayer.Projectile, ignoreEntities: [proj.owner] },
            _projHit,
          );

          if (hit.hit) {
            // Rockets and sticky equipment detonate or attach on contact;
            // everything else bounces with energy loss.
            if (this.detonatesOnImpact(proj.kind)) {
              v3copy(proj.position, hit.point);
              this.detonateProjectile(proj);
              continue;
            }
            if (this.sticksOnImpact(proj.kind)) {
              v3addScaled(proj.position, hit.point, hit.normal, 0.04);
              proj.stuck = true;
              v3set(proj.velocity, 0, 0, 0);
            } else {
              v3addScaled(proj.position, hit.point, hit.normal, 0.03);
              // Reflect with damping; the tangential term keeps grenades rolling
              // rather than stopping dead against a wall.
              const dot =
                proj.velocity.x * hit.normal.x +
                proj.velocity.y * hit.normal.y +
                proj.velocity.z * hit.normal.z;
              proj.velocity.x = (proj.velocity.x - 2 * dot * hit.normal.x) * 0.42;
              proj.velocity.y = (proj.velocity.y - 2 * dot * hit.normal.y) * 0.42;
              proj.velocity.z = (proj.velocity.z - 2 * dot * hit.normal.z) * 0.42;
              proj.bounces++;
            }
          } else {
            v3addScaled(proj.position, proj.position, _tmp, 1);
          }
        }
      }

      proj.fuse -= dt;
      if (proj.fuse <= 0 || proj.age > 20) {
        this.detonateProjectile(proj);
      }
    }
  }

  private detonatesOnImpact(kind: ProjectileKind): boolean {
    return (
      kind === ProjectileKind.Rocket ||
      kind === ProjectileKind.GrenadeLauncher ||
      kind === ProjectileKind.ThrowingKnife
    );
  }

  private sticksOnImpact(kind: ProjectileKind): boolean {
    return (
      kind === ProjectileKind.Semtex ||
      kind === ProjectileKind.ThermiteStick ||
      kind === ProjectileKind.C4
    );
  }

  private detonateProjectile(proj: ProjectileState): void {
    this.world.projectiles.delete(proj.id);

    const spec = PROJECTILE_EFFECTS[proj.kind] ?? PROJECTILE_EFFECTS[ProjectileKind.Frag]!;

    if (spec.damage > 0) {
      this.emit({
        type: SimEventType.Explosion,
        tick: this.world.tick,
        position: v3clone(proj.position),
        radius: spec.radius,
        owner: proj.owner,
        kind: proj.kind,
      });

      resolveExplosion(
        this.world,
        this.collision,
        proj.position,
        spec.radius,
        spec.damage,
        proj.owner,
        this.friendlyFire || proj.owner === 0,
        _explosionTargets,
      );

      for (const target of _explosionTargets) {
        // Self-damage always applies; that is what makes rockets risky indoors.
        const owner = this.world.players.get(proj.owner);
        if (owner && target.player.id !== proj.owner && !this.friendlyFire) {
          if (!isEnemyTeam(owner.team, target.player.team)) continue;
        }
        const rt = this.runtimes.get(target.player.id);
        const resist = rt?.resolved.perks.explosiveResistMult ?? 1;

        this.damagePlayer(target.player, {
          amount: target.damage * resist,
          attacker: proj.owner,
          victim: target.player.id,
          cause: DamageCause.Explosion,
          weaponId: '',
          location: 'chest',
          position: v3clone(proj.position),
          direction: v3clone(target.direction),
          distance: target.distance,
          ignoreArmor: false,
        });
      }

      // Explosions make an area unsafe to spawn into for a while.
      addDangerZone(this.spawnCtx, proj.position, spec.radius * 2, 6);
    }

    if (spec.flash > 0) {
      this.applyFlash(proj, spec);
    }
  }

  private applyFlash(proj: ProjectileState, spec: ProjectileEffect): void {
    this.emit({
      type: SimEventType.Flash,
      tick: this.world.tick,
      position: v3clone(proj.position),
      data: { radius: spec.radius },
    });

    for (const target of this.world.players.values()) {
      if (!target.alive) continue;
      const owner = this.world.players.get(proj.owner);
      if (owner && target.id !== proj.owner && !this.friendlyFire) {
        if (!isEnemyTeam(owner.team, target.team)) continue;
      }
      const rt = this.runtimes.get(target.id);
      if (rt?.resolved.perks.flashImmune) continue;

      const intensity = computeFlashFor(this.collision, target, proj.position, spec.radius);
      if (intensity <= 0) continue;

      if (spec.flash > 0) {
        target.flashAmount = Math.max(target.flashAmount, intensity * spec.flash);
      }
      if (spec.stun > 0) {
        target.concussionAmount = Math.max(target.concussionAmount, intensity * spec.stun);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Damage and death
  // -------------------------------------------------------------------------

  damagePlayer(victim: PlayerState, info: DamageInfo): { applied: number; killed: boolean } {
    if (!victim.alive) return { applied: 0, killed: false };

    // Friendly fire gate, applied here so every damage source obeys it.
    if (info.attacker !== victim.id && !this.friendlyFire) {
      const attacker = this.world.players.get(info.attacker);
      if (attacker && !isEnemyTeam(attacker.team, victim.team)) {
        return { applied: 0, killed: false };
      }
    }

    const result = applyDamage(victim, info);
    if (result.applied <= 0) return { applied: 0, killed: false };

    const attacker = this.world.players.get(info.attacker);
    if (attacker && attacker.id !== victim.id) {
      attacker.damageDealt += result.applied;
    }

    this.emit({
      type: SimEventType.Damage,
      tick: this.world.tick,
      victim: victim.id,
      attacker: info.attacker,
      amount: result.applied,
      direction: v3clone(info.direction),
      cause: info.cause,
    });

    if (result.killed) {
      this.killPlayerWith(victim, info.attacker, info.cause, info.weaponId, info.location);
    }

    return { applied: result.applied, killed: result.killed };
  }

  private killPlayerWith(
    victim: PlayerState,
    killerId: PlayerId,
    cause: DamageCause,
    weaponId: string,
    location: HitLocation = 'chest',
  ): void {
    const killer = this.world.players.get(killerId);
    const assists = computeAssists(victim, killerId);
    const distance = killer ? v3distance(killer.position, victim.position) : 0;

    victim.deaths++;
    victim.deathStreak++;

    const delay = respawnDelayFor(victim, this.mode.respawnDelay, MATCH.maxRespawnDelay);
    killPlayer(victim, delay);
    noteDeath(this.spawnCtx, victim.position, this.world.time);

    const rt = this.runtimes.get(victim.id);
    if (rt) rt.wantsRespawn = victim.isBot;

    // Suicide and team kills score negatively rather than not at all, so they
    // remain a real cost.
    const suicide = !killer || killer.id === victim.id;
    const teamKill = !!killer && killer.id !== victim.id && !isEnemyTeam(killer.team, victim.team);

    if (suicide) {
      victim.score = Math.max(0, victim.score - SCORE.kill);
    } else if (teamKill) {
      killer.score = Math.max(0, killer.score - SCORE.kill);
    } else if (killer) {
      killer.kills++;
      killer.killstreak++;
      killer.deathStreak = 0;
      killer.bestKillstreak = Math.max(killer.bestKillstreak, killer.killstreak);

      let award = this.mode.scoring.kill;
      if (location === 'head') award += SCORE.headshotBonus;
      if (distance > 45) award += SCORE.longshotBonus;
      this.awardScore(killer, award, 'kill');

      if (this.mode.teamScoresOnKill && this.mode.teamBased) {
        addTeamScore(this.world, killer.team, 1);
      }

      for (const assistId of assists) {
        const assister = this.world.players.get(assistId);
        if (assister && isEnemyTeam(assister.team, victim.team)) {
          assister.assists++;
          this.awardScore(assister, this.mode.scoring.assist, 'assist');
        }
      }
    }

    if (this.mode.id === 'kc') {
      const lifetime =
        typeof this.mode.params.tagLifetime === 'number' ? this.mode.params.tagLifetime : 30;
      dropTag(this.objectives, victim, killerId, lifetime);
    }

    this.emit({
      type: SimEventType.Kill,
      tick: this.world.tick,
      killer: killerId,
      victim: victim.id,
      assists,
      weaponId,
      headshot: location === 'head',
      cause,
      distance,
      killerWasLowHealth: !!killer && killer.health < 35,
      victimPosition: v3clone(victim.position),
      killerPosition: killer ? v3clone(killer.position) : v3clone(victim.position),
    });
  }

  private awardScore(player: PlayerState, amount: number, reason: string): void {
    if (amount === 0) return;
    player.score += amount;
    player.streakScore += amount;
    this.emit({
      type: SimEventType.ScoreAwarded,
      tick: this.world.tick,
      player: player.id,
      amount,
      reason,
    });
  }

  // -------------------------------------------------------------------------
  // Killstreaks
  // -------------------------------------------------------------------------

  private updateKillstreaks(player: PlayerState, rt: PlayerRuntime): void {
    if (!this.mode.killstreaksEnabled) return;

    for (const id of player.killstreaks) {
      if (player.killstreakInventory.includes(id)) continue;
      const def = KILLSTREAK_COSTS.get(id);
      if (!def) continue;

      const discount = rt.resolved.perks.killstreakCostMult ?? 1;
      const earned = this.mode.scorestreaksOnly
        ? player.streakScore >= def.scoreCost * discount
        : player.killstreak >= Math.max(1, Math.round(def.cost * discount));

      if (earned) {
        player.killstreakInventory.push(id);
        this.emit({
          type: SimEventType.KillstreakEarned,
          tick: this.world.tick,
          player: player.id,
          team: player.team,
          data: { killstreakId: id },
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Status effects
  // -------------------------------------------------------------------------

  private stepStatusEffects(dt: number): void {
    for (const player of this.world.players.values()) {
      // Flash fades fast at first then lingers, which is what makes it feel like
      // vision returning rather than a linear wipe.
      if (player.flashAmount > 0) {
        player.flashAmount = Math.max(0, player.flashAmount - dt * (0.35 + player.flashAmount * 0.6));
      }
      if (player.concussionAmount > 0) {
        player.concussionAmount = Math.max(0, player.concussionAmount - dt * 0.4);
      }
      if (player.empTime > 0) player.empTime = Math.max(0, player.empTime - dt);
    }
  }

  // -------------------------------------------------------------------------
  // Support
  // -------------------------------------------------------------------------

  private updateDynamicColliders(): void {
    this.dynamicColliders.length = 0;
    for (const player of this.world.players.values()) {
      if (!player.alive) continue;
      const capsule = playerCapsule(player);
      this.dynamicColliders.push({
        id: player.entityId,
        layer: CollisionLayer.Player,
        position: player.position,
        kind: 'capsule',
        height: capsule.height,
        radius: capsule.radius,
        active: true,
      });
    }
    this.collision.setDynamicColliders(this.dynamicColliders);
  }

  /** Surface directly beneath a player, for footstep audio and AI hearing. */
  private surfaceUnder(position: Vec3): SurfaceType {
    v3set(_tmp, position.x, position.y + 0.4, position.z);
    v3set(_dir, 0, -1, 0);
    const hit = this.collision.raycast(_tmp, _dir, 1.2, GROUND_QUERY, _projHit);
    return hit.hit ? hit.surface : SurfaceType.Concrete;
  }

  /** True if `observer` can see `target` right now. Used by AI and the minimap. */
  canSee(observer: PlayerState, target: PlayerState): boolean {
    v3set(_eye, observer.position.x, observer.position.y + currentEyeHeight(observer), observer.position.z);
    v3set(_tmp, target.position.x, target.position.y + currentEyeHeight(target) * 0.8, target.position.z);
    return this.collision.isVisible(_eye, _tmp, SIGHT_FILTER);
  }

  /** How far a player's gunfire carries, for AI hearing. */
  gunshotRadius(weapon: WeaponDef): number {
    return isSuppressed(weapon) ? PERCEPTION.suppressedGunshotRadius : PERCEPTION.gunshotRadius;
  }

  private emit(event: SimEvent): void {
    this.events.push(event);
  }

  /** Snapshot of scores for the HUD scoreboard, sorted the way COD sorts them. */
  scoreboard(): PlayerState[] {
    const list = Array.from(this.world.players.values());
    list.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.kills !== a.kills) return b.kills - a.kills;
      if (a.deaths !== b.deaths) return a.deaths - b.deaths;
      return a.id - b.id;
    });
    return list;
  }
}

// ---------------------------------------------------------------------------
// Helpers and tables
// ---------------------------------------------------------------------------

function v3clone(v: Vec3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

const GROUND_QUERY: QueryFilter = { layers: CollisionLayer.World | CollisionLayer.Breakable };

const _projHit = {
  hit: false,
  distance: 0,
  point: vec3(),
  normal: vec3(0, 1, 0),
  surface: SurfaceType.Concrete,
  entity: 0 as EntityId,
  brushIndex: -1,
  thickness: 0,
  layer: CollisionLayer.None,
};

interface ProjectileEffect {
  damage: number;
  radius: number;
  flash: number;
  stun: number;
}

/**
 * Blast characteristics per projectile kind.
 *
 * These deliberately live next to the projectile code rather than being read
 * from EquipmentDef, because several equipment items share one projectile body
 * (Snapshot rides the stun grenade, Decoy rides the flashbang) and the physics
 * of the body is what matters here.
 */
const PROJECTILE_EFFECTS: Partial<Record<ProjectileKind, ProjectileEffect>> = {
  [ProjectileKind.Frag]: { damage: 130, radius: 5.5, flash: 0, stun: 0 },
  [ProjectileKind.Semtex]: { damage: 130, radius: 4.8, flash: 0, stun: 0 },
  [ProjectileKind.C4]: { damage: 190, radius: 6.5, flash: 0, stun: 0 },
  [ProjectileKind.Molotov]: { damage: 25, radius: 4.0, flash: 0, stun: 0 },
  [ProjectileKind.ThermiteStick]: { damage: 30, radius: 3.2, flash: 0, stun: 0 },
  [ProjectileKind.Rocket]: { damage: 160, radius: 6.0, flash: 0, stun: 0 },
  [ProjectileKind.GrenadeLauncher]: { damage: 130, radius: 5.0, flash: 0, stun: 0 },
  [ProjectileKind.ThrowingKnife]: { damage: 150, radius: 0.6, flash: 0, stun: 0 },
  [ProjectileKind.Flashbang]: { damage: 0, radius: 12, flash: 1, stun: 0.25 },
  [ProjectileKind.StunGrenade]: { damage: 0, radius: 9, flash: 0.15, stun: 1 },
  [ProjectileKind.SmokeGrenade]: { damage: 0, radius: 8, flash: 0, stun: 0 },
  [ProjectileKind.ClaymoreProjectile]: { damage: 150, radius: 4.5, flash: 0, stun: 0 },
};

/**
 * Killstreak costs, flattened once at module load so the per-tick check doesn't
 * walk the registry.
 *
 * Built synchronously. An earlier version primed this from a dynamic import to
 * "avoid a cycle" that does not exist — killstreaks.ts imports nothing from the
 * simulation — and the async gap meant streaks could not be earned during the
 * opening seconds of a match.
 */
const KILLSTREAK_COSTS = new Map<string, { cost: number; scoreCost: number }>(
  Object.entries(KILLSTREAKS).map(([id, def]) => [
    id,
    { cost: def.cost, scoreCost: def.scoreCost },
  ]),
);

/** Flash intensity, wrapping the combat helper with the collision world. */
function computeFlashFor(
  collision: BrushCollisionWorld,
  target: PlayerState,
  flashPos: Vec3,
  radius: number,
): number {
  v3set(_tmp, target.position.x, target.position.y + currentEyeHeight(target), target.position.z);
  const dist = v3distance(flashPos, _tmp);
  if (dist > radius) return 0;
  if (!collision.isVisible(flashPos, _tmp, SIGHT_FILTER)) return 0;

  v3sub(_dir, flashPos, _tmp);
  v3normalize(_dir, _dir);
  anglesToForward(_eye, target.yaw, target.pitch);
  const facing = _dir.x * _eye.x + _dir.y * _eye.y + _dir.z * _eye.z;

  const angleFactor = clamp01(facing * 0.5 + 0.5) ** 1.6 * 0.9 + 0.1;
  const distFactor = 1 - clamp01(dist / radius);
  return clamp01(angleFactor * distFactor);
}
