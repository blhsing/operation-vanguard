/**
 * The first-person weapon rig.
 *
 * This is almost entirely feel. The gun is never where the maths says it should
 * be: it lags behind the camera when you turn, dips when you land, kicks when
 * you fire, and slides into the sight line when you aim. Every one of those is a
 * lie that makes the weapon feel like an object with mass rather than a decal
 * glued to the near plane.
 *
 * The one place it is not a lie is ADS alignment. When `adsProgress` reaches 1
 * the weapon's rear and front sight anchors sit exactly on the camera's forward
 * axis, so what the sights show is genuinely where the bullet goes.
 */

import * as THREE from 'three';

import { clamp, clamp01, damp, lerp } from '@shared/math.js';
import { WeaponAction, type PlayerState } from '@shared/types.js';
import { WeaponClass, type WeaponDef } from '@shared/data/weapon-types.js';
import { buildWeaponModel, disposeWeaponModel, type WeaponModel } from '@client/render/weapon-model.js';

/** Where the weapon sits when hip-firing, in camera space. */
const HIP_POSITION = new THREE.Vector3(0.17, -0.16, -0.34);
const HIP_ROTATION = new THREE.Euler(0.02, -0.06, 0.015);

/** Where it sits while sprinting — canted down and across. */
const SPRINT_POSITION = new THREE.Vector3(0.2, -0.22, -0.3);
const SPRINT_ROTATION = new THREE.Euler(-0.35, 0.62, 0.28);

/** Lowered during a mantle, so the player's hands are visibly on the ledge. */
const MANTLE_POSITION = new THREE.Vector3(0.24, -0.34, -0.28);
const MANTLE_ROTATION = new THREE.Euler(-0.7, 0.5, 0.4);

export interface ViewmodelPose {
  position: THREE.Vector3;
  rotation: THREE.Euler;
}

export class ViewmodelRig {
  /** Root attached to the viewmodel camera. */
  readonly root = new THREE.Group();

  private model: WeaponModel | null = null;
  private currentWeaponId = '';
  private currentDef: WeaponDef | null = null;

  // --- animation state -----------------------------------------------------
  private readonly position = HIP_POSITION.clone();
  private readonly rotation = HIP_ROTATION.clone();

  /** Sway from view rotation, in radians of accumulated lag. */
  private swayYaw = 0;
  private swayPitch = 0;

  /** Recoil, applied as a kick that decays back. */
  private recoilPitch = 0;
  private recoilYaw = 0;
  private recoilZ = 0;

  /** Vertical offset from landing impacts. */
  private landDip = 0;

  /** Walk cycle phase, advanced by distance travelled. */
  private bobPhase = 0;
  private bobAmount = 0;

  /** 0..1 progress through the current reload, for the magazine animation. */
  private reloadProgress = 0;
  private reloadActive = false;

  /** Bolt cycling, 0..1, triggered per shot on manually-cycled weapons. */
  private boltCycle = 0;

  private lastYaw = 0;
  private lastPitch = 0;
  private initialised = false;

  constructor(private readonly viewmodelCamera: THREE.PerspectiveCamera) {
    viewmodelCamera.add(this.root);
  }

  // -------------------------------------------------------------------------

  /** Swap the displayed weapon. Rebuilds the model only when the id changes. */
  setWeapon(def: WeaponDef): void {
    if (def.id === this.currentWeaponId) return;
    this.currentWeaponId = def.id;
    this.currentDef = def;

    if (this.model) {
      this.root.remove(this.model.root);
      disposeWeaponModel(this.model);
    }
    this.model = buildWeaponModel(def);
    this.root.add(this.model.root);
  }

  get muzzleAnchor(): THREE.Object3D | null {
    return this.model?.muzzle ?? null;
  }

  get ejectionAnchor(): THREE.Object3D | null {
    return this.model?.ejectionPort ?? null;
  }

  /** Called on every shot. `index` is the shot's position in the burst. */
  onShot(def: WeaponDef, index: number): void {
    const r = def.recoil;
    const step = r.pattern.length > 0 ? r.pattern[Math.min(index, r.pattern.length - 1)]! : { pitch: 0, yaw: 0 };

    // The viewmodel kicks harder than the view does; that difference is most of
    // what makes a gun feel powerful without making it unusable.
    this.recoilPitch += step.pitch * r.viewKickMultiplier * 2.6;
    this.recoilYaw += step.yaw * r.viewKickMultiplier * 2.2;
    this.recoilZ += 0.018 * r.viewKickMultiplier;

    if (def.fireMode === 'bolt') this.boltCycle = 1;
  }

  onLand(impact: number): void {
    this.landDip = Math.min(0.09, this.landDip + impact * 0.05);
  }

  onReloadStart(): void {
    this.reloadActive = true;
    this.reloadProgress = 0;
  }

  onReloadEnd(): void {
    this.reloadActive = false;
    this.reloadProgress = 0;
  }

  // -------------------------------------------------------------------------

  /**
   * Advance the rig.
   *
   * `yaw`/`pitch` are the camera's current angles; the rig compares them to last
   * frame to derive sway. Everything else comes from player state.
   */
  update(
    player: PlayerState,
    def: WeaponDef,
    yaw: number,
    pitch: number,
    distanceMoved: number,
    speedFraction: number,
    dt: number,
  ): void {
    if (!this.initialised) {
      this.lastYaw = yaw;
      this.lastPitch = pitch;
      this.initialised = true;
    }

    this.setWeapon(def);

    const ads = clamp01(player.adsProgress);
    const sprinting = player.moveState === 2 || player.moveState === 3;
    const mantling = player.mantleTime > 0;

    // --- sway ---------------------------------------------------------------
    // The weapon lags the camera. Clamped so a fast 180 doesn't fling it
    // off-screen, and heavily damped while aiming.
    let dYaw = yaw - this.lastYaw;
    // Wrap so crossing the ±PI seam doesn't produce a huge spurious delta.
    if (dYaw > Math.PI) dYaw -= Math.PI * 2;
    if (dYaw < -Math.PI) dYaw += Math.PI * 2;
    const dPitch = pitch - this.lastPitch;
    this.lastYaw = yaw;
    this.lastPitch = pitch;

    const swayScale = lerp(1, 0.18, ads) * def.handling.swayAmount * 34;
    this.swayYaw = clamp(this.swayYaw + dYaw * swayScale, -0.09, 0.09);
    this.swayPitch = clamp(this.swayPitch + dPitch * swayScale, -0.07, 0.07);
    this.swayYaw = damp(this.swayYaw, 0, 9, dt);
    this.swayPitch = damp(this.swayPitch, 0, 9, dt);

    // --- bob ----------------------------------------------------------------
    this.bobPhase += distanceMoved * 1.85;
    this.bobAmount = damp(this.bobAmount, speedFraction, 7, dt);
    const bobScale = this.bobAmount * lerp(1, 0.1, ads);
    const bobX = Math.sin(this.bobPhase) * 0.014 * bobScale;
    const bobY = Math.abs(Math.cos(this.bobPhase)) * -0.011 * bobScale;
    const bobRoll = Math.sin(this.bobPhase) * 0.012 * bobScale;

    // --- recoil decay -------------------------------------------------------
    this.recoilPitch = damp(this.recoilPitch, 0, def.recoil.recoverySpeed * 1.4, dt);
    this.recoilYaw = damp(this.recoilYaw, 0, def.recoil.recoverySpeed * 1.4, dt);
    this.recoilZ = damp(this.recoilZ, 0, 12, dt);
    this.landDip = damp(this.landDip, 0, 10, dt);
    this.boltCycle = Math.max(0, this.boltCycle - dt * 4);

    // --- target pose --------------------------------------------------------
    let targetPos: THREE.Vector3;
    let targetRot: THREE.Euler;

    if (mantling) {
      targetPos = MANTLE_POSITION;
      targetRot = MANTLE_ROTATION;
    } else if (sprinting && ads < 0.2) {
      targetPos = SPRINT_POSITION;
      targetRot = SPRINT_ROTATION;
    } else {
      targetPos = HIP_POSITION;
      targetRot = HIP_ROTATION;
    }

    // How fast the weapon moves between poses. ADS uses the weapon's own ADS
    // time so the visual and the mechanical transition finish together — if the
    // gun is still sliding into place when the spread has already tightened,
    // players learn to distrust the sights.
    const poseRate = ads > 0.01 ? 1 / Math.max(0.05, def.handling.adsTime) : 12;

    this.position.x = damp(this.position.x, targetPos.x, poseRate, dt);
    this.position.y = damp(this.position.y, targetPos.y, poseRate, dt);
    this.position.z = damp(this.position.z, targetPos.z, poseRate, dt);
    this.rotation.x = damp(this.rotation.x, targetRot.x, poseRate, dt);
    this.rotation.y = damp(this.rotation.y, targetRot.y, poseRate, dt);
    this.rotation.z = damp(this.rotation.z, targetRot.z, poseRate, dt);

    // --- ADS alignment ------------------------------------------------------
    // Blend from the animated hip pose toward a pose that puts the sights on the
    // camera axis. Computed from the model's actual anchors rather than a magic
    // offset, so a weapon with taller sights aligns correctly with no per-gun tuning.
    const aimOffset = this.computeAdsOffset(def);

    const finalX = lerp(this.position.x + bobX + this.swayYaw, aimOffset.x, ads);
    const finalY = lerp(
      this.position.y + bobY - this.landDip + this.swayPitch,
      aimOffset.y,
      ads,
    );
    const finalZ = lerp(this.position.z + this.recoilZ, aimOffset.z + this.recoilZ * 0.6, ads);

    this.root.position.set(finalX, finalY, finalZ);

    // Rotation: sway and bob roll fade out under ADS; recoil never does.
    this.root.rotation.set(
      lerp(this.rotation.x, 0, ads) + this.recoilPitch + this.swayPitch * 0.6,
      lerp(this.rotation.y, 0, ads) + this.recoilYaw + this.swayYaw * 0.6,
      lerp(this.rotation.z + bobRoll, 0, ads),
    );

    // --- action animations --------------------------------------------------
    this.animateAction(player, def, dt);
  }

  /**
   * Offset that puts the weapon's sights on the camera's forward axis.
   *
   * The model builder guarantees `sightRear` and `sightFront` share X and Y in
   * model space, so aligning is a matter of cancelling the rear sight's local
   * offset and pushing the weapon far enough forward to be readable.
   */
  private computeAdsOffset(def: WeaponDef): THREE.Vector3 {
    if (!this.model) return HIP_POSITION;

    const rear = this.model.sightRear;
    // Anchor positions are in the model's local space; the rig root is what we
    // move, so the correction is simply their negation.
    _adsOffset.set(-rear.position.x, -rear.position.y, HIP_POSITION.z - 0.06);

    // Scoped weapons pull back further so the scope body fills more of the view.
    if (def.scoped) _adsOffset.z += 0.04;
    if (def.class === WeaponClass.Melee) return HIP_POSITION;

    return _adsOffset;
  }

  /**
   * Reload, swap and bolt animations.
   *
   * Driven by the player's action timer rather than by a separate clock, so the
   * animation and the mechanics can never drift apart — the magazine is back in
   * the gun exactly when the ammo count updates.
   */
  private animateAction(player: PlayerState, def: WeaponDef, dt: number): void {
    if (!this.model) return;

    const mag = this.model.magazine;
    const bolt = this.model.boltCarrier;

    if (player.action === WeaponAction.Reloading) {
      const total = Math.max(0.01, def.handling.reloadEmptyTime);
      this.reloadProgress = clamp01(1 - player.actionTimer / total);

      // Magazine drops away, then a fresh one rises back in.
      const p = this.reloadProgress;
      const drop = p < 0.45 ? p / 0.45 : 1 - clamp01((p - 0.5) / 0.35);
      mag.position.y = -0.14 * drop;
      mag.rotation.z = -0.5 * drop;

      // The whole weapon tilts toward the player while reloading.
      this.root.rotation.x += 0.22 * Math.sin(p * Math.PI);
      this.root.rotation.z += 0.16 * Math.sin(p * Math.PI);
      this.root.position.y -= 0.05 * Math.sin(p * Math.PI);
    } else {
      mag.position.y = damp(mag.position.y, 0, 14, dt);
      mag.rotation.z = damp(mag.rotation.z, 0, 14, dt);
    }

    if (player.action === WeaponAction.Swapping) {
      // Weapon dips off the bottom of the screen and comes back up.
      const t = clamp01(player.actionTimer / Math.max(0.01, def.handling.holsterTime));
      this.root.position.y -= 0.35 * t;
      this.root.rotation.x -= 0.9 * t;
    }

    // Bolt carrier reciprocates on every shot.
    const cycle = Math.sin(this.boltCycle * Math.PI);
    bolt.position.z = 0.05 * cycle;
  }

  /** Hide the weapon entirely — used while dead and in the killcam. */
  setVisible(visible: boolean): void {
    this.root.visible = visible;
  }

  dispose(): void {
    if (this.model) {
      this.root.remove(this.model.root);
      disposeWeaponModel(this.model);
      this.model = null;
    }
    this.viewmodelCamera.remove(this.root);
  }
}

const _adsOffset = new THREE.Vector3();
