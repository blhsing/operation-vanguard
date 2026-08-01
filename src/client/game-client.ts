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
  MatchPhase,
  SimEventType,
  Team,
  type PlayerId,
  type PlayerState,
  type SimEvent,
} from '@shared/types.js';
import { GameSimulation } from '@shared/sim/game.js';
import { currentEyeHeight, horizontalSpeed } from '@shared/sim/movement.js';
import { activeWeapon, adsFovScale, isSuppressed } from '@shared/sim/weapon-system.js';
import { BOT_ARCHETYPES, botLoadout, defaultLoadout, type BotArchetype, type Loadout } from '@shared/sim/loadout.js';
import { NavGraph } from '@shared/ai/navigation.js';
import { BotController, DIFFICULTIES, type BotDifficulty } from '@shared/ai/bot.js';
import { getMap } from '@shared/map/index.js';

import { InputManager, type InputSettings } from './input.js';
import { CameraShake, WorldRenderer, type RenderSettings } from './scene/world-renderer.js';
import { ViewmodelRig } from './scene/viewmodel.js';
import { EntityRenderer, ProjectileRenderer } from './scene/entities.js';
import { Hud, type HudOptions } from './hud/hud.js';
import { getAudioEngine } from './audio/index.js';

export interface MatchConfig {
  mapId: string;
  modeId: string;
  botCount: number;
  difficulty: keyof typeof DIFFICULTIES;
  playerName: string;
  loadout: Loadout;
  seed?: string;
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

  localId: PlayerId = 0;
  state: ClientState = 'loading';

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
    config: MatchConfig,
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

    this.populate(config);

    window.addEventListener('resize', this.onResize);
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  private populate(config: MatchConfig): void {
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
      this.bots.register(bot.id, archetype, difficulty);
    }
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

  /** One fixed simulation step. */
  private tick(): void {
    const local = this.sim.world.players.get(this.localId);

    // --- local input --------------------------------------------------------
    if (local) {
      const cmd = this.input.poll(TICK_DT, local.adsProgress);
      this.sim.setInput(this.localId, cmd);

      // Respawn on fire press, as COD does.
      if (!local.alive && local.respawnTimer <= 0 && (cmd.buttons & 32) !== 0) {
        this.sim.requestRespawn(this.localId);
      }
    }

    // --- bots ---------------------------------------------------------------
    this.bots.update(TICK_DT);

    // --- simulate -----------------------------------------------------------
    const events = this.sim.step(TICK_DT);
    this.consumeEvents(events);

    // --- track motion for bob and footsteps ---------------------------------
    if (local && local.alive) {
      this.frameDistance += v3distance(this.lastPosition, local.position);
      this.lastPosition.x = local.position.x;
      this.lastPosition.y = local.position.y;
      this.lastPosition.z = local.position.z;
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

    // Roll from strafing and sliding: small, but it is most of what sells
    // movement without costing the player any information.
    const strafe = clamp(local.velocity.x * Math.cos(local.yaw) - local.velocity.z * Math.sin(local.yaw), -6, 6) / 6;
    const targetRoll = -strafe * 0.02 + (local.moveState === 4 ? 0.12 : 0) + local.lean * 0.38;
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
