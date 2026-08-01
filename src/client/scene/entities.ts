/**
 * Rendering other players.
 *
 * Remote players are drawn from interpolated state, never from raw snapshots.
 * Even offline — where the "remote" players are bots being simulated in the same
 * process at 64 Hz — the render position is smoothed toward the simulation
 * position, because a 64 Hz sim displayed on a 144 Hz screen otherwise shows
 * visible stepping on anything moving quickly.
 *
 * Nameplates and the animation state are deliberately cheap: a full skeletal
 * animation system would be a lot of machinery for characters the player mostly
 * sees for under a second before shooting them.
 */

import * as THREE from 'three';

import { TEAM_COLORS } from '@shared/constants.js';
import { clamp01, damp, lerp, wrapAngle } from '@shared/math.js';
import {
  MoveState,
  Stance,
  Team,
  isEnemyTeam,
  type PlayerId,
  type PlayerState,
  type WorldState,
} from '@shared/types.js';
import { buildCharacterModel, disposeCharacterModel, type CharacterModel } from '@client/render/character-model.js';

interface RenderedPlayer {
  model: CharacterModel;
  nameplate: THREE.Sprite | null;
  /** Smoothed transform, so rendering is decoupled from the tick rate. */
  position: THREE.Vector3;
  yaw: number;
  /** Walk cycle phase, advanced by distance moved. */
  gait: number;
  /** Blended crouch amount, 0..1. */
  crouch: number;
  /** Last simulation position, to derive distance travelled. */
  lastSimPosition: THREE.Vector3;
  team: Team;
  enemy: boolean;
  visible: boolean;
}

export class EntityRenderer {
  private readonly rendered = new Map<PlayerId, RenderedPlayer>();
  private readonly nameplateCanvasCache = new Map<string, THREE.Texture>();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
  ) {}

  /**
   * Sync the rendered set with the simulation and advance the animation.
   *
   * `localId` is excluded: the local player is represented by the camera and the
   * viewmodel, and drawing their body would put a torso in front of the lens.
   */
  update(world: WorldState, localId: PlayerId, dt: number, showNameplates = true): void {
    const localPlayer = world.players.get(localId);
    const localTeam = localPlayer?.team ?? Team.None;

    // Remove anyone who left.
    for (const [id, entry] of this.rendered) {
      if (!world.players.has(id)) {
        this.destroy(id, entry);
      }
    }

    for (const player of world.players.values()) {
      if (player.id === localId) {
        const existing = this.rendered.get(player.id);
        if (existing) this.destroy(player.id, existing);
        continue;
      }

      let entry = this.rendered.get(player.id);
      const enemy = isEnemyTeam(localTeam, player.team);

      if (!entry) {
        entry = this.create(player, enemy, showNameplates);
        this.rendered.set(player.id, entry);
      } else if (entry.enemy !== enemy || entry.team !== player.team) {
        // Team changed mid-match (autobalance) — rebuild so the silhouette is right.
        this.destroy(player.id, entry);
        entry = this.create(player, enemy, showNameplates);
        this.rendered.set(player.id, entry);
      }

      this.advance(entry, player, dt);
    }
  }

  private create(player: PlayerState, enemy: boolean, showNameplates: boolean): RenderedPlayer {
    const model = buildCharacterModel(player.team, enemy);
    this.scene.add(model.root);

    const entry: RenderedPlayer = {
      model,
      nameplate: showNameplates && !enemy ? this.makeNameplate(player.name) : null,
      position: new THREE.Vector3(player.position.x, player.position.y, player.position.z),
      yaw: player.yaw,
      gait: 0,
      crouch: 0,
      lastSimPosition: new THREE.Vector3(player.position.x, player.position.y, player.position.z),
      team: player.team,
      enemy,
      visible: player.alive,
    };

    if (entry.nameplate) {
      entry.nameplate.position.set(0, 2.05, 0);
      model.root.add(entry.nameplate);
    }
    return entry;
  }

  private destroy(id: PlayerId, entry: RenderedPlayer): void {
    this.scene.remove(entry.model.root);
    disposeCharacterModel(entry.model);
    if (entry.nameplate) {
      (entry.nameplate.material as THREE.Material).dispose();
    }
    this.rendered.delete(id);
  }

  private advance(entry: RenderedPlayer, player: PlayerState, dt: number): void {
    entry.visible = player.alive;
    entry.model.root.visible = player.alive;
    if (!player.alive) return;

    // Distance the simulation moved this frame drives the walk cycle. Using
    // distance rather than time keeps the feet in sync at any speed, and means a
    // player pressed against a wall stops animating instead of moonwalking.
    const simPos = _tmpVec.set(player.position.x, player.position.y, player.position.z);
    const travelled = simPos.distanceTo(entry.lastSimPosition);
    entry.lastSimPosition.copy(simPos);

    // Smooth toward the simulation position. The rate is high enough that the
    // model never visibly lags a hitbox — a body that renders behind where it
    // can be shot is the single most infuriating thing in a shooter.
    const rate = 26;
    entry.position.x = damp(entry.position.x, simPos.x, rate, dt);
    entry.position.y = damp(entry.position.y, simPos.y, rate, dt);
    entry.position.z = damp(entry.position.z, simPos.z, rate, dt);

    // Snap rather than smooth on a teleport (respawn), or the body streaks
    // across the map.
    if (entry.position.distanceToSquared(simPos) > 9) {
      entry.position.copy(simPos);
      entry.gait = 0;
    }

    entry.yaw = wrapAngle(entry.yaw + wrapAngle(player.yaw - entry.yaw) * clamp01(rate * dt));

    entry.model.root.position.copy(entry.position);
    entry.model.root.rotation.y = entry.yaw;

    // --- stance -------------------------------------------------------------
    const crouchTarget =
      player.stance === Stance.Prone ? 1 : player.stance === Stance.Crouch ? 0.6 : 0;
    entry.crouch = damp(entry.crouch, crouchTarget, 10, dt);

    entry.model.hips.position.y = 0.95 - entry.crouch * 0.5;
    entry.model.torso.rotation.x = entry.crouch * 0.35 + clamp01(-player.pitch) * 0.1;
    // The head tracks pitch so you can tell where someone is looking.
    entry.model.head.rotation.x = player.pitch * 0.6;

    // --- gait ---------------------------------------------------------------
    const sprinting =
      player.moveState === MoveState.Sprint || player.moveState === MoveState.TacticalSprint;
    entry.gait += travelled * (sprinting ? 2.1 : 2.6);

    const swing = Math.sin(entry.gait);
    const stride = clamp01(travelled / (dt * 6)) * (1 - entry.crouch * 0.5);

    entry.model.leftLeg.rotation.x = swing * 0.7 * stride;
    entry.model.rightLeg.rotation.x = -swing * 0.7 * stride;
    // Arms counter-swing, but far less: they are holding a weapon.
    entry.model.leftArm.rotation.x = -swing * 0.18 * stride;
    entry.model.rightArm.rotation.x = swing * 0.12 * stride;

    // Lean into a sprint, and roll with a slide.
    entry.model.torso.rotation.z = player.moveState === MoveState.Slide ? 0.35 : 0;
    entry.model.root.position.y -= player.moveState === MoveState.Slide ? 0.25 : 0;

    // --- nameplate ----------------------------------------------------------
    if (entry.nameplate) {
      // Fade with distance so a busy scene doesn't become a wall of text.
      const dist = this.camera.position.distanceTo(entry.position);
      const mat = entry.nameplate.material as THREE.SpriteMaterial;
      mat.opacity = clamp01(1 - (dist - 25) / 25);
      entry.nameplate.visible = mat.opacity > 0.02;
    }
  }

  private makeNameplate(name: string): THREE.Sprite {
    let texture = this.nameplateCanvasCache.get(name);
    if (!texture) {
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 64;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, 256, 64);
        ctx.font = 'bold 30px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        // Outline first so the name stays legible against any background.
        ctx.lineWidth = 6;
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.strokeText(name, 128, 32);
        ctx.fillStyle = `#${TEAM_COLORS.friendly.toString(16).padStart(6, '0')}`;
        ctx.fillText(name, 128, 32);
      }
      texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      this.nameplateCanvasCache.set(name, texture);
    }

    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        fog: false,
      }),
    );
    sprite.scale.set(1.1, 0.28, 1);
    return sprite;
  }

  /** World position of a rendered player, for the killcam and spectator. */
  getRenderPosition(id: PlayerId): THREE.Vector3 | null {
    return this.rendered.get(id)?.position ?? null;
  }

  clear(): void {
    for (const [id, entry] of Array.from(this.rendered)) this.destroy(id, entry);
  }

  dispose(): void {
    this.clear();
    for (const tex of this.nameplateCanvasCache.values()) tex.dispose();
    this.nameplateCanvasCache.clear();
  }
}

const _tmpVec = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Projectiles and world entities
// ---------------------------------------------------------------------------

/**
 * Grenades, rockets and placed equipment.
 *
 * Small enough that a shared sphere/box geometry pool covers everything; the
 * important part is that live grenades are *visible* — a frag you cannot see
 * bouncing toward you is not a fair mechanic.
 */
export class ProjectileRenderer {
  private readonly meshes = new Map<number, THREE.Mesh>();
  private readonly geometry = new THREE.SphereGeometry(0.075, 8, 6);
  private readonly material = new THREE.MeshStandardMaterial({
    color: 0x2f3a2a,
    roughness: 0.7,
    metalness: 0.3,
  });
  private readonly hotMaterial = new THREE.MeshBasicMaterial({ color: 0xff7a2a });

  constructor(private readonly scene: THREE.Scene) {}

  update(world: WorldState): void {
    for (const [id, mesh] of this.meshes) {
      if (!world.projectiles.has(id)) {
        this.scene.remove(mesh);
        this.meshes.delete(id);
      }
    }

    for (const proj of world.projectiles.values()) {
      let mesh = this.meshes.get(proj.id);
      if (!mesh) {
        // Rockets glow; thrown equipment does not.
        const isRocket = proj.kind === 7 || proj.kind === 8;
        mesh = new THREE.Mesh(this.geometry, isRocket ? this.hotMaterial : this.material);
        mesh.scale.setScalar(isRocket ? 1.6 : 1);
        mesh.castShadow = true;
        this.scene.add(mesh);
        this.meshes.set(proj.id, mesh);
      }
      mesh.position.set(proj.position.x, proj.position.y, proj.position.z);
      // Tumble in flight so a grenade reads as a thrown object.
      if (!proj.stuck) {
        mesh.rotation.x += 0.3;
        mesh.rotation.z += 0.2;
      }
    }
  }

  clear(): void {
    for (const mesh of this.meshes.values()) this.scene.remove(mesh);
    this.meshes.clear();
  }

  dispose(): void {
    this.clear();
    this.geometry.dispose();
    this.material.dispose();
    this.hotMaterial.dispose();
  }
}
