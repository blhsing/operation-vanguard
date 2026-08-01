/**
 * The renderer.
 *
 * Draws the simulation. It never writes to the simulation — every visual here is
 * derived from `WorldState` plus the `SimEvent` stream, so the game is identical
 * whether or not anything is on screen. That separation is what lets the whole
 * match run headless in the test suite.
 *
 * Structure worth knowing about:
 *
 *  - **Two render passes.** The world is drawn with the player's FOV; the
 *    first-person weapon is drawn afterwards with a narrower FOV and its own
 *    near plane, into the same buffer with the depth cleared. Drawing the
 *    viewmodel in the world pass makes it clip through walls, and shrinking its
 *    near plane instead wrecks depth precision across the whole scene.
 *  - **Everything is pooled.** Tracers, impacts, decals and particles come from
 *    fixed-size pools allocated once. A firefight can produce hundreds of
 *    effects a second, and allocating per effect turns into a GC stutter at
 *    exactly the moment the player is most sensitive to one.
 */

import * as THREE from 'three';

import { DECAL_LIFETIME, MAX_DECALS, RENDER } from '@shared/constants.js';
import { clamp01, damp, lerp } from '@shared/math.js';
import { SurfaceType } from '@shared/types.js';
import type { Vec3 } from '@shared/math.js';
import type { MapDef } from '@shared/map/map-types.js';
import { buildMapGeometry, disposeMapGeometry, type MapGeometry } from '@client/render/map-geometry.js';

export type QualityTier = 'low' | 'medium' | 'high' | 'ultra';

export interface RenderSettings {
  fov: number;
  quality: QualityTier;
  shadows: boolean;
  /** Render scale, 0.5..1 — the cheapest meaningful performance lever. */
  resolutionScale: number;
  showFps: boolean;
  motionBlur: boolean;
  filmGrain: boolean;
  /** Extra brightness for players on poor displays. */
  brightness: number;
}

export const DEFAULT_RENDER_SETTINGS: RenderSettings = {
  fov: RENDER.defaultFov,
  quality: 'high',
  shadows: true,
  resolutionScale: 1,
  showFps: false,
  motionBlur: false,
  filmGrain: true,
  brightness: 1,
};

/**
 * Quality tiers.
 *
 * `maxLights` is deliberately generous even at the bottom tier. Dropping a map's
 * point lights makes its dark corners darker, and on a night map that is not a
 * visual downgrade — it is a competitive one, because a player on Low literally
 * cannot see into places a player on Ultra can. Shadow resolution and particle
 * count are the levers that are safe to scale; illumination is not.
 *
 * Non-shadow-casting point lights are cheap: they are per-fragment arithmetic,
 * not extra passes. The expensive setting here is `shadowMap`.
 */
const QUALITY: Record<QualityTier, { shadowMap: number; maxLights: number; particles: number; anisotropy: number }> = {
  low: { shadowMap: 0, maxLights: 16, particles: 200, anisotropy: 1 },
  medium: { shadowMap: 1024, maxLights: 16, particles: 800, anisotropy: 2 },
  high: { shadowMap: 2048, maxLights: 24, particles: 2000, anisotropy: 4 },
  ultra: { shadowMap: 4096, maxLights: 32, particles: 4000, anisotropy: 8 },
};

// ---------------------------------------------------------------------------

export class WorldRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  /** Separate scene and camera for the first-person weapon. */
  readonly viewmodelScene = new THREE.Scene();
  readonly viewmodelCamera: THREE.PerspectiveCamera;

  settings: RenderSettings;

  private mapGeometry: MapGeometry | null = null;
  private sun: THREE.DirectionalLight;
  private ambient: THREE.HemisphereLight;
  private readonly mapLights: THREE.PointLight[] = [];

  private readonly tracers: TracerPool;
  private readonly impacts: ImpactPool;
  private readonly decals: DecalPool;
  private readonly particles: ParticlePool;
  private readonly muzzleFlash: MuzzleFlash;

  private disposed = false;

  constructor(canvas: HTMLCanvasElement, settings: RenderSettings = DEFAULT_RENDER_SETTINGS) {
    this.settings = { ...settings };

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: settings.quality !== 'low',
      powerPreference: 'high-performance',
      // The depth buffer is shared between passes; stencil is unused.
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.shadowMap.enabled = settings.shadows && settings.quality !== 'low';
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // The viewmodel pass clears depth itself; auto-clear would wipe the world.
    this.renderer.autoClear = false;

    this.camera = new THREE.PerspectiveCamera(
      settings.fov,
      1,
      RENDER.nearPlane,
      RENDER.farPlane,
    );
    this.viewmodelCamera = new THREE.PerspectiveCamera(
      RENDER.viewmodelFov,
      1,
      RENDER.viewmodelNear,
      RENDER.viewmodelFar,
    );

    this.sun = new THREE.DirectionalLight(0xffffff, 1.4);
    this.sun.castShadow = true;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.ambient = new THREE.HemisphereLight(0xbfd4ea, 0x50483c, 0.7);
    this.scene.add(this.ambient);

    // The viewmodel gets its own lighting so it reads clearly regardless of
    // where the player is standing — a gun that disappears in shadow is a
    // usability problem, not a realism win.
    const vmKey = new THREE.DirectionalLight(0xffffff, 2.2);
    vmKey.position.set(-0.6, 1.2, 0.8);
    this.viewmodelScene.add(vmKey);
    const vmFill = new THREE.HemisphereLight(0x9fb4d0, 0x2a2620, 1.1);
    this.viewmodelScene.add(vmFill);

    this.tracers = new TracerPool(this.scene, 96);
    this.impacts = new ImpactPool(this.scene, 64);
    this.decals = new DecalPool(this.scene, MAX_DECALS);
    this.particles = new ParticlePool(this.scene, QUALITY[settings.quality].particles);
    this.muzzleFlash = new MuzzleFlash(this.viewmodelScene, this.scene);

    this.applyQuality();
    this.resize();
  }

  // -------------------------------------------------------------------------
  // Map
  // -------------------------------------------------------------------------

  loadMap(map: MapDef): void {
    this.unloadMap();

    this.mapGeometry = buildMapGeometry(map);
    this.scene.add(this.mapGeometry.root);

    const L = map.lighting;
    this.sun.position.set(-L.sunDirection.x * 80, -L.sunDirection.y * 80, -L.sunDirection.z * 80);
    this.sun.target.position.set(0, 0, 0);
    this.sun.color.setHex(L.sunColor);
    this.sun.intensity = L.sunIntensity;
    this.configureSunShadow(map);

    // `ambientColor` is the LIGHT arriving from above; `skyTop` is only the
    // colour of the sky gradient the player sees. Using skyTop here conflates
    // the two, which happens to work on a daylight map with a bright sky and
    // renders a night map completely black — the sky is the thing that is dark.
    this.ambient.color.setHex(L.ambientColor);
    // Bounce off the ground is the same light, dimmer and warmer-shifted.
    _ambientGround.setHex(L.ambientColor);
    _ambientGround.multiplyScalar(0.35);
    this.ambient.groundColor.copy(_ambientGround);
    this.ambient.intensity = L.ambientIntensity;

    this.scene.fog = new THREE.Fog(L.fogColor, L.fogNear, L.fogFar);
    this.scene.background = makeSkyTexture(L.skyTop, L.skyBottom);
    this.renderer.toneMappingExposure = L.exposure * this.settings.brightness;

    // Point lights are expensive; honour the quality budget.
    const budget = QUALITY[this.settings.quality].maxLights;
    for (const spec of (L.lights ?? []).slice(0, budget)) {
      const light = new THREE.PointLight(spec.color, spec.intensity, spec.distance, 2);
      light.position.set(spec.position.x, spec.position.y, spec.position.z);
      light.castShadow = false; // Shadow-casting point lights are six passes each.
      this.scene.add(light);
      this.mapLights.push(light);
    }
  }

  private configureSunShadow(map: MapDef): void {
    const size = QUALITY[this.settings.quality].shadowMap;
    if (size === 0) {
      this.sun.castShadow = false;
      return;
    }
    this.sun.castShadow = this.settings.shadows;
    this.sun.shadow.mapSize.set(size, size);

    // Fit the orthographic shadow frustum to the map, so resolution isn't wasted
    // on empty space outside it.
    const extent = Math.max(
      map.bounds.max.x - map.bounds.min.x,
      map.bounds.max.z - map.bounds.min.z,
    ) * 0.6;
    const cam = this.sun.shadow.camera;
    cam.left = -extent;
    cam.right = extent;
    cam.top = extent;
    cam.bottom = -extent;
    cam.near = 1;
    cam.far = 260;
    cam.updateProjectionMatrix();
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.03;
  }

  private unloadMap(): void {
    if (this.mapGeometry) {
      this.scene.remove(this.mapGeometry.root);
      disposeMapGeometry(this.mapGeometry);
      this.mapGeometry = null;
    }
    for (const light of this.mapLights) this.scene.remove(light);
    this.mapLights.length = 0;
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  resize(): void {
    const scale = clamp01(this.settings.resolutionScale) || 1;
    const w = Math.max(1, Math.floor(window.innerWidth * scale));
    const h = Math.max(1, Math.floor(window.innerHeight * scale));

    this.renderer.setSize(w, h, false);
    const aspect = w / h;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.viewmodelCamera.aspect = aspect;
    this.viewmodelCamera.updateProjectionMatrix();

    const canvas = this.renderer.domElement;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
  }

  applyQuality(): void {
    const q = QUALITY[this.settings.quality];
    this.renderer.shadowMap.enabled = this.settings.shadows && q.shadowMap > 0;
    this.particles.setBudget(q.particles);
    THREE.Cache.enabled = true;
  }

  /** Effective vertical FOV, folding in the ADS zoom. */
  setFov(baseFov: number, adsScale: number): void {
    const target = baseFov * adsScale;
    if (Math.abs(this.camera.fov - target) > 0.01) {
      this.camera.fov = target;
      this.camera.updateProjectionMatrix();
    }
  }

  update(dt: number): void {
    this.tracers.update(dt);
    this.impacts.update(dt);
    this.decals.update(dt);
    this.particles.update(dt);
    this.muzzleFlash.update(dt);
  }

  render(): void {
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);

    // Second pass: weapon on top, depth cleared so it can never clip a wall.
    this.renderer.clearDepth();
    this.renderer.render(this.viewmodelScene, this.viewmodelCamera);
  }

  // -------------------------------------------------------------------------
  // Effects — called from the SimEvent stream
  // -------------------------------------------------------------------------

  spawnTracer(from: Vec3, to: Vec3, suppressed: boolean): void {
    this.tracers.spawn(from, to, suppressed);
  }

  spawnImpact(position: Vec3, normal: Vec3, surface: SurfaceType): void {
    this.impacts.spawn(position, normal, surface);
    this.decals.spawn(position, normal, surface);
    this.particles.burst(position, normal, surface, 6);
  }

  spawnMuzzleFlash(local: boolean, position: Vec3 | null, scale: number): void {
    this.muzzleFlash.fire(local, position, scale);
  }

  spawnExplosion(position: Vec3, radius: number): void {
    this.particles.explosion(position, radius);
    this.impacts.spawnExplosion(position, radius);
  }

  spawnBlood(position: Vec3, direction: Vec3): void {
    this.particles.blood(position, direction);
  }

  clearEffects(): void {
    this.tracers.clear();
    this.impacts.clear();
    this.decals.clear();
    this.particles.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unloadMap();
    this.tracers.dispose();
    this.impacts.dispose();
    this.decals.dispose();
    this.particles.dispose();
    this.muzzleFlash.dispose();
    this.renderer.dispose();
  }
}

// ---------------------------------------------------------------------------
// Sky
// ---------------------------------------------------------------------------

const _ambientGround = new THREE.Color();

const skyCache = new Map<string, THREE.Texture>();

function makeSkyTexture(top: number, bottom: number): THREE.Texture {
  const key = `${top}:${bottom}`;
  const cached = skyCache.get(key);
  if (cached) return cached;

  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, `#${top.toString(16).padStart(6, '0')}`);
  grad.addColorStop(1, `#${bottom.toString(16).padStart(6, '0')}`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 4, 256);

  const tex = new THREE.CanvasTexture(canvas);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  skyCache.set(key, tex);
  return tex;
}

// ---------------------------------------------------------------------------
// Tracers
// ---------------------------------------------------------------------------

/**
 * Bullet tracers.
 *
 * Only a fraction of real rounds are tracers, and drawing one per shot turns a
 * firefight into a laser show. More importantly they are the player's main cue
 * for *where fire is coming from*, so they are drawn bright, thin, and short-lived.
 */
class TracerPool {
  private readonly meshes: THREE.Mesh[] = [];
  private readonly lives: number[] = [];
  private cursor = 0;
  private readonly geometry: THREE.CylinderGeometry;
  private readonly material: THREE.MeshBasicMaterial;

  constructor(private readonly scene: THREE.Scene, count: number) {
    // A unit cylinder along Y, scaled and oriented per tracer.
    this.geometry = new THREE.CylinderGeometry(0.012, 0.012, 1, 5, 1, true);
    this.material = new THREE.MeshBasicMaterial({
      color: 0xffd08a,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });

    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(this.geometry, this.material.clone());
      mesh.visible = false;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.meshes.push(mesh);
      this.lives.push(0);
    }
  }

  spawn(from: Vec3, to: Vec3, suppressed: boolean): void {
    const mesh = this.meshes[this.cursor];
    if (!mesh) return;
    this.lives[this.cursor] = suppressed ? 0.05 : 0.09;
    this.cursor = (this.cursor + 1) % this.meshes.length;

    const start = new THREE.Vector3(from.x, from.y, from.z);
    const end = new THREE.Vector3(to.x, to.y, to.z);
    const dir = end.clone().sub(start);
    const length = dir.length();
    if (length < 0.01) return;

    mesh.position.copy(start).addScaledVector(dir, 0.5);
    mesh.scale.set(1, length, 1);
    // Cylinders are built along +Y; rotate that onto the shot direction.
    mesh.quaternion.setFromUnitVectors(UP, dir.normalize());
    mesh.visible = true;
    (mesh.material as THREE.MeshBasicMaterial).opacity = suppressed ? 0.35 : 0.85;
  }

  update(dt: number): void {
    for (let i = 0; i < this.meshes.length; i++) {
      if (this.lives[i]! <= 0) continue;
      this.lives[i]! -= dt;
      const mesh = this.meshes[i]!;
      if (this.lives[i]! <= 0) {
        mesh.visible = false;
      } else {
        const mat = mesh.material as THREE.MeshBasicMaterial;
        mat.opacity = Math.max(0, mat.opacity - dt * 9);
      }
    }
  }

  clear(): void {
    for (let i = 0; i < this.meshes.length; i++) {
      this.meshes[i]!.visible = false;
      this.lives[i] = 0;
    }
  }

  dispose(): void {
    for (const mesh of this.meshes) {
      this.scene.remove(mesh);
      (mesh.material as THREE.Material).dispose();
    }
    this.geometry.dispose();
    this.material.dispose();
  }
}

const UP = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------------------
// Impacts
// ---------------------------------------------------------------------------

/** Short-lived sprites at bullet impacts — the sparks and dust puff. */
class ImpactPool {
  private readonly sprites: THREE.Sprite[] = [];
  private readonly lives: number[] = [];
  private readonly maxLives: number[] = [];
  private cursor = 0;
  private readonly material: THREE.SpriteMaterial;

  constructor(private readonly scene: THREE.Scene, count: number) {
    this.material = new THREE.SpriteMaterial({
      color: 0xffffff,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });

    for (let i = 0; i < count; i++) {
      const sprite = new THREE.Sprite(this.material.clone());
      sprite.visible = false;
      sprite.frustumCulled = false;
      scene.add(sprite);
      this.sprites.push(sprite);
      this.lives.push(0);
      this.maxLives.push(0.12);
    }
  }

  spawn(position: Vec3, normal: Vec3, surface: SurfaceType): void {
    const sprite = this.sprites[this.cursor];
    if (!sprite) return;

    sprite.position.set(
      position.x + normal.x * 0.02,
      position.y + normal.y * 0.02,
      position.z + normal.z * 0.02,
    );
    const size = surface === SurfaceType.Metal ? 0.28 : 0.2;
    sprite.scale.setScalar(size);
    sprite.visible = true;

    const mat = sprite.material as THREE.SpriteMaterial;
    // Metal throws bright sparks; everything else puffs dust in its own colour.
    mat.color.setHex(IMPACT_COLORS[surface] ?? 0xc8bda8);
    mat.opacity = 1;

    this.lives[this.cursor] = 0.12;
    this.maxLives[this.cursor] = 0.12;
    this.cursor = (this.cursor + 1) % this.sprites.length;
  }

  spawnExplosion(position: Vec3, radius: number): void {
    const sprite = this.sprites[this.cursor];
    if (!sprite) return;
    sprite.position.set(position.x, position.y, position.z);
    sprite.scale.setScalar(radius * 1.4);
    sprite.visible = true;
    const mat = sprite.material as THREE.SpriteMaterial;
    mat.color.setHex(0xffa83c);
    mat.opacity = 1;
    this.lives[this.cursor] = 0.35;
    this.maxLives[this.cursor] = 0.35;
    this.cursor = (this.cursor + 1) % this.sprites.length;
  }

  update(dt: number): void {
    for (let i = 0; i < this.sprites.length; i++) {
      if (this.lives[i]! <= 0) continue;
      this.lives[i]! -= dt;
      const sprite = this.sprites[i]!;
      if (this.lives[i]! <= 0) {
        sprite.visible = false;
        continue;
      }
      const t = this.lives[i]! / this.maxLives[i]!;
      (sprite.material as THREE.SpriteMaterial).opacity = t;
      sprite.scale.multiplyScalar(1 + dt * 2.5);
    }
  }

  clear(): void {
    for (let i = 0; i < this.sprites.length; i++) {
      this.sprites[i]!.visible = false;
      this.lives[i] = 0;
    }
  }

  dispose(): void {
    for (const sprite of this.sprites) {
      this.scene.remove(sprite);
      (sprite.material as THREE.Material).dispose();
    }
    this.material.dispose();
  }
}

const IMPACT_COLORS: Partial<Record<SurfaceType, number>> = {
  [SurfaceType.Metal]: 0xffd88a,
  [SurfaceType.Concrete]: 0xd8d2c6,
  [SurfaceType.Brick]: 0xc89a86,
  [SurfaceType.Wood]: 0xc8a070,
  [SurfaceType.Dirt]: 0x9a8468,
  [SurfaceType.Sand]: 0xd8c79a,
  [SurfaceType.Glass]: 0xdff0ff,
  [SurfaceType.Flesh]: 0xc23a3a,
  [SurfaceType.Snow]: 0xffffff,
};

// ---------------------------------------------------------------------------
// Decals
// ---------------------------------------------------------------------------

/**
 * Bullet holes.
 *
 * Implemented as camera-independent quads offset slightly along the surface
 * normal rather than as projected decals: projection is far more correct but
 * needs a render target and a second pass, and at the sizes involved nobody can
 * tell the difference while a firefight is happening.
 */
class DecalPool {
  private readonly meshes: THREE.Mesh[] = [];
  private readonly lives: number[] = [];
  private cursor = 0;
  private readonly geometry = new THREE.PlaneGeometry(1, 1);
  private readonly materials = new Map<SurfaceType, THREE.MeshBasicMaterial>();

  constructor(private readonly scene: THREE.Scene, count: number) {
    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(this.geometry, this.materialFor(SurfaceType.Concrete));
      mesh.visible = false;
      mesh.frustumCulled = true;
      scene.add(mesh);
      this.meshes.push(mesh);
      this.lives.push(0);
    }
  }

  private materialFor(surface: SurfaceType): THREE.MeshBasicMaterial {
    let mat = this.materials.get(surface);
    if (!mat) {
      mat = new THREE.MeshBasicMaterial({
        color: 0x1a1a1a,
        transparent: true,
        opacity: 0.75,
        depthWrite: false,
        // Pull the decal toward the camera so it never z-fights its surface.
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
      });
      this.materials.set(surface, mat);
    }
    return mat;
  }

  spawn(position: Vec3, normal: Vec3, surface: SurfaceType): void {
    // Glass shatters instead of pockmarking, and flesh does not take holes.
    if (surface === SurfaceType.Flesh || surface === SurfaceType.Water) return;

    const mesh = this.meshes[this.cursor];
    if (!mesh) return;

    mesh.position.set(
      position.x + normal.x * 0.012,
      position.y + normal.y * 0.012,
      position.z + normal.z * 0.012,
    );
    mesh.quaternion.setFromUnitVectors(
      FORWARD,
      new THREE.Vector3(normal.x, normal.y, normal.z),
    );
    const size = 0.09 + Math.random() * 0.05;
    mesh.scale.set(size, size, 1);
    mesh.rotateZ(Math.random() * Math.PI * 2);
    mesh.material = this.materialFor(surface);
    mesh.visible = true;

    this.lives[this.cursor] = DECAL_LIFETIME;
    this.cursor = (this.cursor + 1) % this.meshes.length;
  }

  update(dt: number): void {
    for (let i = 0; i < this.meshes.length; i++) {
      if (this.lives[i]! <= 0) continue;
      this.lives[i]! -= dt;
      if (this.lives[i]! <= 0) {
        this.meshes[i]!.visible = false;
      } else if (this.lives[i]! < 2) {
        // Fade out over the last couple of seconds so decals never pop away.
        this.meshes[i]!.scale.multiplyScalar(1 - dt * 0.2);
      }
    }
  }

  clear(): void {
    for (let i = 0; i < this.meshes.length; i++) {
      this.meshes[i]!.visible = false;
      this.lives[i] = 0;
    }
  }

  dispose(): void {
    for (const mesh of this.meshes) this.scene.remove(mesh);
    this.geometry.dispose();
    for (const mat of this.materials.values()) mat.dispose();
  }
}

const FORWARD = new THREE.Vector3(0, 0, 1);

// ---------------------------------------------------------------------------
// Particles
// ---------------------------------------------------------------------------

/**
 * One `THREE.Points` cloud for every particle in the game.
 *
 * A single draw call for all debris, smoke, blood and explosion sparks. The
 * alternative — a mesh per effect — is what turns a grenade into a frame spike.
 */
class ParticlePool {
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly velocities: Float32Array;
  private readonly lives: Float32Array;
  private readonly maxLives: Float32Array;
  private readonly sizes: Float32Array;
  private readonly points: THREE.Points;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.PointsMaterial;
  private cursor = 0;
  private budget: number;

  constructor(private readonly scene: THREE.Scene, capacity: number) {
    this.budget = capacity;
    this.positions = new Float32Array(capacity * 3);
    this.colors = new Float32Array(capacity * 3);
    this.velocities = new Float32Array(capacity * 3);
    this.lives = new Float32Array(capacity);
    this.maxLives = new Float32Array(capacity);
    this.sizes = new Float32Array(capacity);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.geometry.setAttribute('size', new THREE.BufferAttribute(this.sizes, 1));

    this.material = new THREE.PointsMaterial({
      size: 0.06,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      sizeAttenuation: true,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    scene.add(this.points);

    // Park every particle far below the map until it is used.
    for (let i = 0; i < capacity; i++) this.positions[i * 3 + 1] = -9999;
  }

  setBudget(n: number): void {
    this.budget = Math.min(n, this.lives.length);
  }

  private emit(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    r: number, g: number, b: number,
    life: number, size: number,
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.budget;

    this.positions[i * 3] = x;
    this.positions[i * 3 + 1] = y;
    this.positions[i * 3 + 2] = z;
    this.velocities[i * 3] = vx;
    this.velocities[i * 3 + 1] = vy;
    this.velocities[i * 3 + 2] = vz;
    this.colors[i * 3] = r;
    this.colors[i * 3 + 1] = g;
    this.colors[i * 3 + 2] = b;
    this.lives[i] = life;
    this.maxLives[i] = life;
    this.sizes[i] = size;
  }

  burst(position: Vec3, normal: Vec3, surface: SurfaceType, count: number): void {
    const hex = IMPACT_COLORS[surface] ?? 0xa89a86;
    const r = ((hex >> 16) & 255) / 255;
    const g = ((hex >> 8) & 255) / 255;
    const b = (hex & 255) / 255;

    for (let i = 0; i < count; i++) {
      // Spray along the surface normal with a wide cone — debris comes back out
      // of the hole, not through the wall.
      const spread = 2.2;
      this.emit(
        position.x, position.y, position.z,
        normal.x * 2 + (Math.random() - 0.5) * spread,
        normal.y * 2 + Math.random() * spread,
        normal.z * 2 + (Math.random() - 0.5) * spread,
        r, g, b,
        0.35 + Math.random() * 0.3,
        0.03 + Math.random() * 0.03,
      );
    }
  }

  blood(position: Vec3, direction: Vec3): void {
    for (let i = 0; i < 10; i++) {
      this.emit(
        position.x, position.y, position.z,
        direction.x * 3 + (Math.random() - 0.5) * 2,
        direction.y * 3 + Math.random() * 1.5,
        direction.z * 3 + (Math.random() - 0.5) * 2,
        0.62, 0.06, 0.06,
        0.4 + Math.random() * 0.3,
        0.04,
      );
    }
  }

  explosion(position: Vec3, radius: number): void {
    const count = Math.min(60, Math.floor(radius * 10));
    for (let i = 0; i < count; i++) {
      const speed = 4 + Math.random() * 10;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const t = Math.random();
      this.emit(
        position.x, position.y, position.z,
        Math.sin(phi) * Math.cos(theta) * speed,
        Math.abs(Math.cos(phi)) * speed * 0.8,
        Math.sin(phi) * Math.sin(theta) * speed,
        1, lerp(0.75, 0.25, t), lerp(0.3, 0.05, t),
        0.5 + Math.random() * 0.6,
        0.08 + Math.random() * 0.1,
      );
    }
  }

  update(dt: number): void {
    let anyAlive = false;
    for (let i = 0; i < this.budget; i++) {
      if (this.lives[i]! <= 0) continue;
      anyAlive = true;
      this.lives[i]! -= dt;

      if (this.lives[i]! <= 0) {
        this.positions[i * 3 + 1] = -9999;
        continue;
      }

      this.velocities[i * 3 + 1]! -= 14 * dt; // gravity
      // Air drag, so debris settles instead of flying forever.
      const drag = 1 - 2.2 * dt;
      this.velocities[i * 3]! *= drag;
      this.velocities[i * 3 + 1]! *= drag;
      this.velocities[i * 3 + 2]! *= drag;

      this.positions[i * 3]! += this.velocities[i * 3]! * dt;
      this.positions[i * 3 + 1]! += this.velocities[i * 3 + 1]! * dt;
      this.positions[i * 3 + 2]! += this.velocities[i * 3 + 2]! * dt;
    }

    if (anyAlive) {
      this.geometry.attributes.position!.needsUpdate = true;
      this.geometry.attributes.color!.needsUpdate = true;
    }
  }

  clear(): void {
    for (let i = 0; i < this.lives.length; i++) {
      this.lives[i] = 0;
      this.positions[i * 3 + 1] = -9999;
    }
    this.geometry.attributes.position!.needsUpdate = true;
  }

  dispose(): void {
    this.scene.remove(this.points);
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// Muzzle flash
// ---------------------------------------------------------------------------

/**
 * The flash lives in both scenes: a sprite on the viewmodel for the local
 * player, and a world-space sprite plus a brief point light for everyone else.
 * The light is what makes night maps read — a muzzle flash that doesn't
 * illuminate its surroundings looks pasted on.
 */
class MuzzleFlash {
  private readonly localSprite: THREE.Sprite;
  private readonly worldSprite: THREE.Sprite;
  private readonly light: THREE.PointLight;
  private localLife = 0;
  private worldLife = 0;

  constructor(
    private readonly viewmodelScene: THREE.Scene,
    private readonly worldScene: THREE.Scene,
  ) {
    const material = new THREE.SpriteMaterial({
      color: 0xffd9a0,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });

    this.localSprite = new THREE.Sprite(material.clone());
    this.localSprite.visible = false;
    this.localSprite.frustumCulled = false;
    viewmodelScene.add(this.localSprite);

    this.worldSprite = new THREE.Sprite(material.clone());
    this.worldSprite.visible = false;
    this.worldSprite.frustumCulled = false;
    worldScene.add(this.worldSprite);

    this.light = new THREE.PointLight(0xffc478, 0, 12, 2);
    this.light.visible = false;
    worldScene.add(this.light);
  }

  fire(local: boolean, position: Vec3 | null, scale: number): void {
    if (local) {
      this.localSprite.visible = true;
      this.localSprite.scale.setScalar(0.16 * scale);
      // Slight random roll so consecutive shots don't look like one static image.
      this.localSprite.material.rotation = Math.random() * Math.PI * 2;
      this.localLife = 0.045;
    }
    if (position) {
      this.worldSprite.visible = true;
      this.worldSprite.position.set(position.x, position.y, position.z);
      this.worldSprite.scale.setScalar(0.4 * scale);
      this.worldSprite.material.rotation = Math.random() * Math.PI * 2;
      this.light.position.set(position.x, position.y, position.z);
      this.light.intensity = 14 * scale;
      this.light.visible = true;
      this.worldLife = 0.05;
    }
  }

  /** Attach the local flash to the weapon's muzzle anchor. */
  setLocalAnchor(anchor: THREE.Object3D | null): void {
    if (!anchor) return;
    anchor.add(this.localSprite);
    this.localSprite.position.set(0, 0, 0);
  }

  update(dt: number): void {
    if (this.localLife > 0) {
      this.localLife -= dt;
      if (this.localLife <= 0) this.localSprite.visible = false;
    }
    if (this.worldLife > 0) {
      this.worldLife -= dt;
      // Exponential decay, never a `1 - dt * k` multiplier: past a 55 ms frame
      // that factor goes negative, and a light with negative intensity SUBTRACTS
      // illumination — it turns the surrounding scene black.
      this.light.intensity = Math.max(0, this.light.intensity * Math.exp(-18 * dt));
      if (this.worldLife <= 0) {
        this.worldSprite.visible = false;
        this.light.visible = false;
        this.light.intensity = 0;
      }
    }
  }

  dispose(): void {
    this.viewmodelScene.remove(this.localSprite);
    this.worldScene.remove(this.worldSprite);
    this.worldScene.remove(this.light);
    (this.localSprite.material as THREE.Material).dispose();
    (this.worldSprite.material as THREE.Material).dispose();
  }
}

// ---------------------------------------------------------------------------
// Camera helpers
// ---------------------------------------------------------------------------

/**
 * Camera shake, driven by weapon fire, explosions and landing.
 *
 * Decays exponentially and is applied as a rotation offset rather than a
 * position offset, because translating the camera inside geometry lets the
 * player see through walls.
 */
export class CameraShake {
  private trauma = 0;
  private time = 0;

  add(amount: number): void {
    this.trauma = clamp01(this.trauma + amount);
  }

  update(dt: number): void {
    this.time += dt;
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
  }

  /** Rotation offsets in radians: pitch, yaw, roll. */
  sample(out: { pitch: number; yaw: number; roll: number }): void {
    // Squaring makes small shakes subtle and big ones dramatic.
    const t = this.trauma * this.trauma;
    const f = this.time * 32;
    out.pitch = Math.sin(f * 1.07) * t * 0.05;
    out.yaw = Math.sin(f * 0.93 + 1.7) * t * 0.05;
    out.roll = Math.sin(f * 1.31 + 3.1) * t * 0.06;
  }

  get value(): number {
    return this.trauma;
  }
}

/** View bob while walking, tied to distance travelled rather than to time. */
export class ViewBob {
  private phase = 0;

  update(distance: number, speedFraction: number, dt: number): void {
    void dt;
    this.phase += distance * 1.9;
    this.amount = damp(this.amount, speedFraction, 8, 1 / 60);
  }

  private amount = 0;

  sample(out: { x: number; y: number; roll: number }, adsProgress: number): void {
    // Bob is heavily suppressed while aiming — it is a movement cue, and when
    // the player is aiming it becomes an obstacle instead.
    const scale = this.amount * (1 - adsProgress * 0.88);
    out.x = Math.sin(this.phase) * 0.021 * scale;
    out.y = Math.abs(Math.cos(this.phase)) * -0.016 * scale;
    out.roll = Math.sin(this.phase) * 0.005 * scale;
  }
}
