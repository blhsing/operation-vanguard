/**
 * The client.
 *
 * Owns the frame loop and wires the simulation to everything that presents it.
 * The structure is deliberately one-directional:
 *
 *     input ──▶ simulation ──▶ events ──┬──▶ renderer
 *                    │                  ├──▶ audio
 *                    └──▶ world state ──┴──▶ HUD
 *
 * Nothing on the right ever writes back to the left. That is what makes the
 * whole match runnable headless in the test suite, and it is what will let the
 * networked build swap `GameSimulation` for a server connection without any of
 * the presentation code noticing.
 *
 * The loop itself is a fixed-timestep accumulator: the simulation only ever
 * advances in whole 64 Hz ticks regardless of display refresh rate, because a
 * variable-dt simulation is neither deterministic nor networkable.
 */

import * as THREE from 'three';

import { MAX_TICKS_PER_FRAME, RENDER, TICK_DT } from '@shared/constants.js';
import { anglesToForward, clamp, clamp01, damp, v3distance, vec3 } from '@shared/math.js';
import { Rng } from '@shared/rng.js';
import {
  InputFlag,
  MatchPhase,
  SimEventType,
  Team,
  isEnemyTeam,
  type PlayerId,
  type PlayerState,
  type SimEvent,
} from '@shared/types.js';
import { GameSimulation } from '@shared/sim/game.js';
import { currentEyeHeight, horizontalSpeed } from '@shared/sim/movement.js';
import { activeWeapon, adsFovScale, isSuppressed } from '@shared/sim/weapon-system.js';
import { BOT_ARCHETYPES, botLoadout, defaultLoadout, type BotArchetype, type Loadout } from '@shared/sim/loadout.js';
import { NavGraph } from '@shared/ai/navigation.js';
import {
  BotController,
  DIFFICULTIES,
  ENEMY_AGGRESSION_SCALE,
  ENEMY_DAMAGE_SCALE,
  ENEMY_MOVEMENT_SCALE,
  type BotDifficulty,
} from '@shared/ai/bot.js';
import { getMap } from '@shared/map/index.js';
import {
  CampaignDirector,
  MissionPhase,
  tryGetMission,
} from '@shared/campaign/index.js';
import {
  RoundPhase,
  ZombiesDirector,
  getZombiesMap,
  hasZombiesLayout,
} from '@shared/zombies/index.js';

import { NetClient } from './net/net-client.js';
import { InputManager, type InputSettings } from './input.js';
import { CameraShake, WorldRenderer, type RenderSettings } from './scene/world-renderer.js';
import { ViewmodelRig } from './scene/viewmodel.js';
import { EntityRenderer, ProjectileRenderer } from './scene/entities.js';
import { Hud, formatZombiePrompt, type HudOptions } from './hud/hud.js';
import { getAudioEngine } from './audio/index.js';

export interface MatchConfig {
  mapId: string;
  modeId: string;
  botCount: number;
  difficulty: keyof typeof DIFFICULTIES;
  playerName: string;
  loadout: Loadout;
  seed?: string;
  /** Which campaign mission to play. Only read when modeId is 'campaign'. */
  missionId?: string;
  /** Set to join a dedicated server instead of playing against local bots. */
  serverUrl?: string;
}

export interface ClientSettings {
  input: InputSettings;
  render: RenderSettings;
  hud: HudOptions;
  masterVolume: number;
  sfxVolume: number;
  musicVolume: number;
}

export type ClientState = 'loading' | 'playing' | 'paused' | 'match_end';

export class GameClient {
  readonly sim: GameSimulation;
  readonly renderer: WorldRenderer;
  readonly hud: Hud;
  readonly input: InputManager;

  private readonly nav: NavGraph;
  private readonly bots: BotController;
  private readonly viewmodel: ViewmodelRig;
  private readonly entities: EntityRenderer;
  private readonly projectiles: ProjectileRenderer;
  private readonly shake = new CameraShake();
  private readonly audio = getAudioEngine();

  /** Present only in Zombies. Owns rounds, the horde and the economy. */
  readonly zombies: ZombiesDirector | null = null;
  /** Present only in the Campaign. Owns the objective graph, the squad and the checkpoint. */
  readonly campaign: CampaignDirector | null = null;
  /** Present only online. Owns the socket, prediction and interpolation. */
  readonly net: NetClient | null = null;

  localId: PlayerId = 0;
  state: ClientState = 'loading';

  /** Edge detection for the interact key, so holding it does not spam purchases. */
  private usePressed = false;
  private accumulator = 0;
  private lastFrameTime = 0;
  private rafHandle = 0;
  private running = false;

  /** Smoothed camera height, so crouching is not a snap. */
  private cameraHeight = 1.62;
  /** Camera roll from strafing and sliding. */
  private cameraRoll = 0;
  /** Distance travelled since the last frame, for bob and footsteps. */
  private frameDistance = 0;
  private lastPosition = vec3();

  private settings: ClientSettings;

  /** Callbacks the shell (menus) subscribes to. */
  onPause: (() => void) | null = null;
  onMatchEnd: ((winner: Team | null) => void) | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    hudContainer: HTMLElement,
    private readonly config: MatchConfig,
    settings: ClientSettings,
  ) {
    this.settings = settings;

    this.sim = new GameSimulation({
      mapId: config.mapId,
      modeId: config.modeId,
      seed: config.seed,
    });

    const map = getMap(config.mapId);
    this.nav = new NavGraph(this.sim.map, this.sim.collision);
    this.bots = new BotController(this.sim, this.nav, new Rng(hashSeed(config.seed ?? config.mapId)));

    this.renderer = new WorldRenderer(canvas, settings.render);
    this.renderer.loadMap(map);

    this.viewmodel = new ViewmodelRig(this.renderer.viewmodelCamera);
    this.entities = new EntityRenderer(this.renderer.scene, this.renderer.camera);
    this.projectiles = new ProjectileRenderer(this.renderer.scene);

    this.hud = new Hud(hudContainer, map, settings.hud);
    this.input = new InputManager(canvas, settings.input);

    this.audio.setEnvironment(map.ambience);
    this.audio.setMasterVolume(settings.masterVolume);
    this.audio.setBusVolume('sfx', settings.sfxVolume);
    this.audio.setBusVolume('music', settings.musicVolume);

    if (config.modeId === 'zombies' && hasZombiesLayout(config.mapId)) {
      this.zombies = new ZombiesDirector(
        this.sim,
        this.nav,
        new Rng(hashSeed(`${config.seed ?? config.mapId}:zm`)),
        getZombiesMap(config.mapId),
      );
    }

    const mission = config.missionId ? tryGetMission(config.missionId) : undefined;
    if (config.modeId === 'campaign' && mission) {
      this.campaign = new CampaignDirector(
        this.sim,
        this.nav,
        this.bots,
        new Rng(hashSeed(`${config.seed ?? mission.id}:cmp`)),
        mission,
      );
    }

    if (config.serverUrl) {
      this.net = new NetClient({
        url: config.serverUrl,
        name: config.playerName,
        loadout: config.loadout,
        collision: this.sim.collision,
      });
    }

    this.populate(config);

    window.addEventListener('resize', this.onResize);
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  private populate(config: MatchConfig): void {
    // Zombies is co-op: everyone is on one team, and the opposition is spawned
    // by the director rather than added here.
    if (this.zombies) {
      this.populateZombies(config);
      return;
    }

    // The campaign director owns the squad and the opposition; all it needs from
    // here is the player.
    // Online: the server owns the roster. Nothing is added locally — the local
    // player arrives in the first snapshot with the id the welcome named, and
    // everyone else appears as they are seen.
    if (this.net) return;

    if (this.campaign) {
      const local = this.sim.addPlayer({
        name: config.playerName,
        team: Team.Allies,
        loadout: config.loadout,
      });
      this.localId = local.id;
      this.campaign.begin(local);
      return;
    }

    const teamBased = this.sim.mode.teamBased;

    const local = this.sim.addPlayer({
      name: config.playerName,
      team: teamBased ? Team.Allies : Team.None,
      loadout: config.loadout,
    });
    this.localId = local.id;

    const difficulty: BotDifficulty = DIFFICULTIES[config.difficulty] ?? DIFFICULTIES.regular!;

    for (let i = 0; i < config.botCount; i++) {
      // Alternate teams starting with the enemy, so the player's team is never
      // a man up in an odd-numbered lobby.
      const team = teamBased ? (i % 2 === 0 ? Team.Axis : Team.Allies) : Team.None;
      const archetype: BotArchetype = BOT_ARCHETYPES[i % BOT_ARCHETYPES.length]!;
      const bot = this.sim.addPlayer({
        name: BOT_NAMES[i % BOT_NAMES.length]!,
        team,
        isBot: true,
        botSkill: 0.5,
        loadout: botLoadout(archetype, i),
      });
      const enemy = isEnemyTeam(local.team, team);
      this.bots.register(
        bot.id,
        archetype,
        difficulty,
        enemy ? ENEMY_MOVEMENT_SCALE : 1,
        enemy ? ENEMY_AGGRESSION_SCALE : 1,
      );
      if (enemy) this.sim.setOutgoingDamageScale(bot.id, ENEMY_DAMAGE_SCALE);
    }
  }

  /** Local player plus optional co-op bots, all registered as survivors. */
  private populateZombies(config: MatchConfig): void {
    const director = this.zombies!;
    const data = getZombiesMap(config.mapId);

    const local = this.sim.addPlayer({
      name: config.playerName,
      team: Team.Allies,
      loadout: config.loadout,
    });
    this.localId = local.id;
    this.placeAtZombieSpawn(local, data.playerSpawns[0]);
    director.addSurvivor(local);

    // Co-op partners, capped at four in total by convention.
    const partners = Math.min(3, Math.max(0, config.botCount));
    const difficulty = DIFFICULTIES[config.difficulty] ?? DIFFICULTIES.regular!;

    for (let i = 0; i < partners; i++) {
      const bot = this.sim.addPlayer({
        name: BOT_NAMES[i % BOT_NAMES.length]!,
        team: Team.Allies,
        isBot: true,
        botSkill: 0.6,
        loadout: config.loadout,
      });
      this.placeAtZombieSpawn(bot, data.playerSpawns[(i + 1) % data.playerSpawns.length]);
      director.addSurvivor(bot);
      // The ordinary combat AI handles them: zombies are hostile to Allies, so
      // bots engage them with no zombies-specific behaviour needed.
      this.bots.register(bot.id, BOT_ARCHETYPES[i % BOT_ARCHETYPES.length]!, difficulty);
    }
  }

  private placeAtZombieSpawn(player: PlayerState, spawn: { x: number; y: number; z: number } | undefined): void {
    this.sim.spawnPlayer(player);
    if (!spawn) return;
    player.position.x = spawn.x;
    player.position.y = spawn.y;
    player.position.z = spawn.z;
  }

  // -------------------------------------------------------------------------
  // Loop
  // -------------------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    this.state = 'playing';
    this.lastFrameTime = performance.now();
    this.rafHandle = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
  }

  private frame = (now: number): void => {
    if (!this.running) return;
    this.rafHandle = requestAnimationFrame(this.frame);

    // Clamp the frame delta. A tab that was backgrounded for a minute must not
    // try to simulate a minute of game time in one frame.
    const rawDt = (now - this.lastFrameTime) / 1000;
    this.lastFrameTime = now;
    const dt = Math.min(rawDt, 0.25);

    if (this.input.takePauseRequest()) {
      this.togglePause();
    }

    if (this.state === 'playing') {
      this.accumulator += dt;

      let ticks = 0;
      while (this.accumulator >= TICK_DT && ticks < MAX_TICKS_PER_FRAME) {
        this.tick();
        this.accumulator -= TICK_DT;
        ticks++;
      }
      // If we blew the budget, drop the backlog rather than spiralling.
      if (ticks >= MAX_TICKS_PER_FRAME) this.accumulator = 0;
    }

    this.updatePresentation(dt);
    this.renderer.render();
  };

  /**
   * One fixed step of an online match.
   *
   * Nothing here advances the simulation: the server does that. The local player
   * is predicted so that pressing forward moves you on the frame you pressed it,
   * everyone else is written in from an interpolated snapshot, and the events
   * that drive the HUD and the audio come off the wire rather than out of a
   * local step.
   */
  private tickOnline(net: NetClient): void {
    // The local id is not known until the welcome lands, and until it does there
    // is nobody to predict. Adopting it here rather than guessing at construction
    // is what keeps `applySnapshot` from treating us as just another remote and
    // overwriting the prediction with a fifth-of-a-second-old copy of ourselves.
    if (net.localId !== 0 && this.localId !== net.localId) {
      this.localId = net.localId;
      if (!this.sim.world.players.has(net.localId)) {
        const me = this.sim.addPlayer({
          name: this.config.playerName,
          team: Team.None,
          loadout: this.config.loadout,
          id: net.localId,
        });
        me.alive = true;
      }
    }

    const local = this.sim.world.players.get(this.localId);
    const cmd = this.input.poll(TICK_DT, local?.adsProgress ?? 0);

    if (local && !local.alive && (cmd.buttons & InputFlag.Fire) !== 0) {
      net.requestRespawn();
    }

    net.tick(local, cmd);
    net.reconcile(local);
    this.applySnapshot(net);
    this.consumeEvents(net.drainEvents());
  }

  /**
   * Write the server's view of everyone else into the local world.
   *
   * The renderer, the HUD and the minimap all read `sim.world.players`, so the
   * cheapest correct thing is to keep populating it — remote players simply get
   * their transforms assigned rather than simulated. The local player is skipped
   * because prediction already owns them, and adopting the snapshot here would
   * undo the correction that was just reconciled.
   */
  private applySnapshot(net: NetClient): void {
    const players = net.remotePlayers(TICK_DT);
    if (players.length === 0) return;

    const seen = new Set<PlayerId>();
    for (const s of players) {
      seen.add(s.id);
      if (s.id === this.localId) continue;

      let p = this.sim.world.players.get(s.id);
      if (!p) {
        // Somebody joined, or was already here when we did. Ids come from the
        // server, so the local world uses them verbatim.
        p = this.sim.addPlayer({
          name: `Player ${s.id}`,
          team: s.team,
          isBot: s.isBot,
          id: s.id,
        });
      }
      p.position.x = s.x;
      p.position.y = s.y;
      p.position.z = s.z;
      p.velocity.x = s.vx;
      p.velocity.y = s.vy;
      p.velocity.z = s.vz;
      p.yaw = s.yaw;
      p.pitch = s.pitch;
      p.lean = s.lean;
      p.stance = s.stance;
      p.moveState = s.moveState;
      p.onGround = s.onGround;
      p.alive = s.alive;
      p.health = s.health;
      p.team = s.team;
    }

    for (const id of [...this.sim.world.players.keys()]) {
      if (id !== this.localId && !seen.has(id)) this.sim.removePlayer(id);
    }
  }

  /** One fixed simulation step. */
  private tick(): void {
    if (this.net) {
      this.tickOnline(this.net);
      return;
    }

    const local = this.sim.world.players.get(this.localId);

    // --- local input --------------------------------------------------------
    if (local) {
      const cmd = this.input.poll(TICK_DT, local.adsProgress);
      this.sim.setInput(this.localId, cmd);

      // Respawn on fire press, as COD does. Zombies has no respawns — you are
      // revived or you are not.
      if (!this.zombies && !local.alive && local.respawnTimer <= 0 && (cmd.buttons & 32) !== 0) {
        this.sim.requestRespawn(this.localId);
      }

      // Use key buys whatever the player is standing at.
      if (this.zombies && (cmd.buttons & InputFlag.Use) !== 0 && !this.usePressed) {
        const result = this.zombies.interact(this.localId);
        this.audio.playUi(result.ok ? 'equip' : 'error');
        if (result.message) this.hud.showAnnounce(formatZombiePrompt(result.message));
      }
      this.usePressed = this.zombies ? (cmd.buttons & InputFlag.Use) !== 0 : false;

      // The campaign wants the key *held*, not tapped: setting a charge is a
      // duration, so the director is told the state every tick rather than the
      // edge Zombies wants for a purchase.
      this.campaign?.setUsing(this.localId, (cmd.buttons & InputFlag.Use) !== 0);
    }

    // --- bots ---------------------------------------------------------------
    this.bots.update(TICK_DT);

    // --- simulate -----------------------------------------------------------
    const events = this.sim.step(TICK_DT);

    // The director reads the same events everything else does, and returns its
    // own (round changes, downs, purchases) for the HUD and audio to consume.
    if (this.zombies) {
      const zombieEvents = this.zombies.step(TICK_DT, events);
      for (const e of zombieEvents) events.push(e);
    }

    if (this.campaign) {
      for (const e of this.campaign.step(TICK_DT, events)) events.push(e);
    }

    this.consumeEvents(events);

    // --- track motion for bob and footsteps ---------------------------------
    if (local && local.alive) {
      this.frameDistance += v3distance(this.lastPosition, local.position);
      this.lastPosition.x = local.position.x;
      this.lastPosition.y = local.position.y;
      this.lastPosition.z = local.position.z;
    }

    if (
      this.campaign &&
      this.campaign.state.phase === MissionPhase.Complete &&
      this.state === 'playing'
    ) {
      this.state = 'match_end';
      this.input.releaseLock();
      this.onMatchEnd?.(null);
      return;
    }

    if (this.zombies && this.zombies.state.phase === RoundPhase.GameOver && this.state === 'playing') {
      this.state = 'match_end';
      this.input.releaseLock();
      this.onMatchEnd?.(null);
      return;
    }

    if (this.sim.world.match.phase === MatchPhase.MatchEnd && this.state === 'playing') {
      this.state = 'match_end';
      this.input.releaseLock();
      this.onMatchEnd?.(this.sim.world.match.winner);
    }
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  /**
   * Turn simulation events into sight and sound.
   *
   * Every branch here is presentation only — if this whole method were deleted
   * the match would play out identically, just silently and invisibly.
   */
  private consumeEvents(events: readonly SimEvent[]): void {
    const local = this.sim.world.players.get(this.localId);
    this.hud.handleEvents(events, this.sim.world, this.localId);

    for (const event of events) {
      switch (event.type) {
        case SimEventType.Shot: {
          const shooter = this.sim.world.players.get(event.player);
          const weapon = shooter ? this.sim.activeWeaponDef(shooter) : null;
          if (!weapon) break;

          const isLocal = event.player === this.localId;
          const distance = local ? v3distance(local.position, event.origin) : 0;

          this.audio.playGunshot(weapon, isLocal ? null : event.origin, distance);

          if (isLocal) {
            this.viewmodel.onShot(weapon, event.shotIndex);
            this.shake.add(weapon.recoil.cameraShake * 2.2);
            // Recoil moves the player's actual view, not just the model — that
            // is the difference between recoil you must fight and recoil that is
            // decoration.
            this.input.applyRecoil(
              weapon.recoil.pattern[Math.min(event.shotIndex, weapon.recoil.pattern.length - 1)]?.pitch ?? 0,
              weapon.recoil.pattern[Math.min(event.shotIndex, weapon.recoil.pattern.length - 1)]?.yaw ?? 0,
            );
            this.renderer.spawnMuzzleFlash(true, null, 1);
          } else {
            this.renderer.spawnMuzzleFlash(false, event.origin, 1);
            // Unsuppressed fire reveals the shooter on the minimap.
            if (!isSuppressed(weapon) && shooter && local && shooter.team !== local.team) {
              this.hud.pingEnemy(shooter.id, shooter.position.x, shooter.position.z);
            }
          }
          break;
        }

        case SimEventType.Impact: {
          this.renderer.spawnImpact(event.position, event.normal, event.surface);
          this.audio.playImpact(event.surface, event.position);
          // Draw the tracer from the shooter's muzzle to where the round stopped.
          const shooter = this.sim.world.players.get(event.shooter);
          if (shooter) {
            const origin = vec3(
              shooter.position.x,
              shooter.position.y + currentEyeHeight(shooter),
              shooter.position.z,
            );
            this.renderer.spawnTracer(origin, event.position, false);
          }
          break;
        }

        case SimEventType.Hit: {
          this.renderer.spawnBlood(event.position, vec3(0, 1, 0));
          if (event.attacker === this.localId) {
            this.audio.playHitmarker(event.lethal);
          }
          break;
        }

        case SimEventType.Explosion:
          this.renderer.spawnExplosion(event.position, event.radius);
          this.audio.playExplosion(event.position, event.radius);
          if (local) {
            // Shake scales with proximity, so a distant blast is felt but not
            // disorienting.
            const d = v3distance(local.position, event.position);
            this.shake.add(clamp01(1 - d / (event.radius * 3)) * 0.7);
          }
          break;

        case SimEventType.Footstep: {
          if (event.player === this.localId) {
            this.audio.playFootstep(event.surface, event.position, false);
          } else {
            this.audio.playFootstep(event.surface, event.position, event.loud);
          }
          break;
        }

        case SimEventType.Reload:
          if (event.player === this.localId) this.viewmodel.onReloadStart();
          if (event.position) {
            const p = this.sim.world.players.get(event.player ?? 0);
            const weapon = p ? this.sim.activeWeaponDef(p) : null;
            if (weapon) {
              this.audio.playReload(weapon, 'magOut', event.player === this.localId ? null : event.position);
            }
          }
          break;

        case SimEventType.ReloadComplete:
          if (event.player === this.localId) this.viewmodel.onReloadEnd();
          break;

        case SimEventType.Land:
          if (event.player === this.localId) {
            this.viewmodel.onLand(0.6);
            this.shake.add(0.08);
          }
          break;

        case SimEventType.Spawn:
          if (event.player === this.localId) {
            // Align the input view with the spawn facing so the player is not
            // instantly disoriented, and clear stale effects.
            const p = this.sim.world.players.get(this.localId);
            if (p) {
              this.input.setViewAngles(p.yaw, 0);
              this.lastPosition.x = p.position.x;
              this.lastPosition.y = p.position.y;
              this.lastPosition.z = p.position.z;
            }
            this.viewmodel.setVisible(true);
          }
          break;

        case SimEventType.Kill:
          if (event.victim === this.localId) {
            this.viewmodel.setVisible(false);
            this.shake.add(0.5);
          }
          break;

        case SimEventType.Announce:
          this.audio.playAnnouncer((event as { line: string }).line);
          break;

        default:
          break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Presentation
  // -------------------------------------------------------------------------

  private updatePresentation(dt: number): void {
    const local = this.sim.world.players.get(this.localId);

    this.shake.update(dt);
    this.renderer.update(dt);
    this.entities.update(this.sim.world, this.localId, dt, true);
    this.projectiles.update(this.sim.world);

    if (local) {
      this.updateCamera(local, dt);
      this.updateViewmodel(local, dt);
      this.updateAudioListener(local);
    }

    const weapon = local ? this.sim.activeWeaponDef(local) : null;
    const state = local ? activeWeapon(local) : undefined;
    const spread = state?.spread ?? 0;

    // The minimap only reveals enemies when the team has earned it.
    if (local) this.hud.setUav(this.sim.radarTime(local.team));

    // The campaign replaces the score bar with the objective board.
    if (this.campaign) {
      const objectives = this.campaign.activeObjectives();
      const interact = this.campaign.mission.objectives.find(
        (o) =>
          o.trigger.kind === 'interact' &&
          this.campaign!.state.objectives.get(o.id)?.active === true,
      );
      const verb =
        interact && interact.trigger.kind === 'interact' ? interact.trigger.verb : null;
      this.hud.setCampaignState({
        objectives: objectives.map((o) => ({ label: o.label, progress: o.progress })),
        prompt: verb ? `HOLD F — ${verb}` : null,
        failed: this.campaign.state.phase === MissionPhase.Failed,
      });
    }

    // Zombies replaces the score bar with round, points and the buy prompt.
    if (this.zombies && local) {
      const zs = this.zombies.players.get(this.localId);
      const near = this.zombies.interactableNear(this.localId);
      this.hud.setZombiesState({
        round: this.zombies.state.round,
        phase: this.zombies.state.phase,
        points: zs?.points ?? 0,
        perks: zs?.perks ?? [],
        downed: zs?.downed ?? false,
        bleedOut: zs?.bleedOut ?? 0,
        reviveProgress: zs?.reviveProgress ?? 0,
        zombiesAlive: Array.from(this.sim.world.players.values()).filter(
          (p) => p.team === Team.Hostile && p.alive,
        ).length,
        prompt: near
          ? {
              label: near.def.label,
              cost: near.cost,
              usable: near.usable,
              reason: near.reason,
            }
          : null,
      });
    }

    this.hud.setScoreboardVisible(this.input.scoreboardHeld || this.state === 'match_end');
    this.hud.update(
      this.sim.world,
      this.localId,
      weapon,
      spread,
      dt,
      this.renderer.camera.fov,
    );

    this.frameDistance = 0;
  }

  /**
   * Position the camera.
   *
   * The camera is placed from simulation state every frame rather than being
   * moved incrementally, so it can never drift out of sync with the hitbox the
   * player is actually shot in.
   */
  private updateCamera(local: PlayerState, dt: number): void {
    const cam = this.renderer.camera;
    const weapon = this.sim.activeWeaponDef(local);

    // Height eases so crouching reads as a movement rather than a teleport.
    this.cameraHeight = damp(this.cameraHeight, currentEyeHeight(local), 16, dt);

    cam.position.set(
      local.position.x,
      local.position.y + this.cameraHeight,
      local.position.z,
    );

    // Lean shifts the eye laterally.
    if (local.lean !== 0) {
      const right = anglesToForward(_camTmp, local.yaw - Math.PI / 2, 0);
      cam.position.x += right.x * local.lean * 0.42;
      cam.position.z += right.z * local.lean * 0.42;
    }

    this.shake.sample(_shakeOut);

    /*
     * Everything the camera does on its own, scaled by one accessibility knob.
     *
     * Shake, strafe roll and slide tilt are pure presentation — the simulation
     * has no idea they happen — and they are also the parts of a shooter most
     * likely to make somebody motion sick. At zero the camera goes exactly where
     * the player points it and nowhere else, and the game is otherwise
     * identical: same hitboxes, same recoil, same everything that decides a
     * fight.
     */
    const motion = this.settings.render.motionScale;
    _shakeOut.yaw *= motion;
    _shakeOut.pitch *= motion;
    _shakeOut.roll *= motion;

    // Roll from strafing and sliding: small, but it is most of what sells
    // movement without costing the player any information.
    const strafe = clamp(local.velocity.x * Math.cos(local.yaw) - local.velocity.z * Math.sin(local.yaw), -6, 6) / 6;
    const targetRoll =
      (-strafe * 0.02 + (local.moveState === 4 ? 0.12 : 0)) * motion + local.lean * 0.38;
    this.cameraRoll = damp(this.cameraRoll, targetRoll, 8, dt);

    cam.rotation.set(0, 0, 0);
    cam.rotateY(local.yaw + _shakeOut.yaw);
    cam.rotateX(-local.pitch + _shakeOut.pitch);
    cam.rotateZ(this.cameraRoll + _shakeOut.roll);

    // FOV: base plus a sprint widening, narrowed by ADS zoom.
    const sprintBoost =
      local.moveState === 2 || local.moveState === 3 ? 1.06 : 1.0;
    const adsScale = adsFovScale(weapon, local.adsProgress);
    const base = clamp(this.settings.render.fov * sprintBoost, RENDER.minFov, RENDER.maxFov);
    this.renderer.setFov(base, adsScale);

    this.renderer.viewmodelCamera.position.copy(cam.position);
    this.renderer.viewmodelCamera.quaternion.copy(cam.quaternion);
  }

  private updateViewmodel(local: PlayerState, dt: number): void {
    const weapon = this.sim.activeWeaponDef(local);
    const speedFraction = clamp01(horizontalSpeed(local) / 6);

    this.viewmodel.update(
      local,
      weapon,
      local.yaw,
      local.pitch,
      this.frameDistance,
      speedFraction,
      dt,
    );

    this.viewmodel.setVisible(local.alive);
  }

  private updateAudioListener(local: PlayerState): void {
    const cam = this.renderer.camera;
    cam.getWorldDirection(_camForward);
    this.audio.setListener(
      { x: cam.position.x, y: cam.position.y, z: cam.position.z },
      { x: _camForward.x, y: _camForward.y, z: _camForward.z },
      { x: 0, y: 1, z: 0 },
    );
    void local;
  }

  // -------------------------------------------------------------------------
  // Control
  // -------------------------------------------------------------------------

  togglePause(): void {
    if (this.state === 'playing') {
      this.state = 'paused';
      this.input.releaseLock();
      this.onPause?.();
    } else if (this.state === 'paused') {
      this.resume();
    }
  }

  resume(): void {
    if (this.state !== 'paused') return;
    this.state = 'playing';
    // Reset the accumulator so the pause doesn't produce a burst of catch-up ticks.
    this.accumulator = 0;
    this.lastFrameTime = performance.now();
    this.input.requestLock();
    void this.audio.resume();
  }

  applySettings(settings: ClientSettings): void {
    this.settings = settings;
    this.input.settings = settings.input;
    this.renderer.settings = settings.render;
    this.renderer.applyQuality();
    this.renderer.resize();
    this.hud.options = settings.hud;
    this.hud.applyOptions();
    this.hud.setFpsVisible(settings.render.showFps);
    this.audio.setMasterVolume(settings.masterVolume);
    this.audio.setBusVolume('sfx', settings.sfxVolume);
    this.audio.setBusVolume('music', settings.musicVolume);
  }

  private onResize = (): void => {
    this.renderer.resize();
  };

  dispose(): void {
    this.stop();
    window.removeEventListener('resize', this.onResize);
    this.input.dispose();
    this.viewmodel.dispose();
    this.entities.dispose();
    this.projectiles.dispose();
    this.hud.dispose();
    this.renderer.dispose();
  }
}

// ---------------------------------------------------------------------------

const _camTmp = vec3();
const _camForward = new THREE.Vector3();
const _shakeOut = { pitch: 0, yaw: 0, roll: 0 };

function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Bot names, so a lobby reads like a lobby rather than "Bot 4". */
const BOT_NAMES = [
  'Reyes', 'Vasquez', 'Kovac', 'Mori', 'Hale', 'Dunn', 'Bergman', 'Ives',
  'Cortez', 'Novak', 'Rhodes', 'Sato', 'Ferrari', 'Okonkwo', 'Lindqvist',
  'Petrov', 'Nakamura', 'Ackerman', 'Bauer', 'Mercer', 'Fontaine', 'Sokolov',
  'Delgado', 'Whitlock',
];
