/**
 * Material cache.
 *
 * Materials are shared aggressively and keyed by every parameter that can differ
 * between call sites. A unique material per mesh would defeat three.js's program
 * cache and its state sorting: each distinct material is a shader bind, and on a
 * map with a few hundred brushes that alone costs more than the geometry.
 *
 * Nothing here is mutated after construction. Callers that need a one-off tweak
 * should ask for a different key rather than writing to a shared instance.
 */

import * as THREE from 'three';
import { SurfaceType, Team } from '@shared/types.js';
import {
  SURFACE_COLORS,
  SURFACE_METALNESS,
  SURFACE_ROUGHNESS,
} from '@shared/collision/collision-types.js';
import { surfaceNormalMap, surfaceTexture } from './textures.js';

const materialCache = new Map<string, THREE.Material>();
/** Texture clones that carry a non-default repeat, keyed by (surface, scale). */
const scaledTextureCache = new Map<string, THREE.Texture>();

function cached<T extends THREE.Material>(key: string, build: () => T): T {
  const hit = materialCache.get(key);
  if (hit) return hit as T;
  const mat = build();
  mat.name = key;
  materialCache.set(key, mat);
  return mat;
}

/**
 * Clone shares the underlying `Texture.source`, so this costs one extra sampler
 * descriptor rather than a second GPU upload.
 */
function repeated(tex: THREE.Texture, cacheKey: string, repeat: number): THREE.Texture {
  if (repeat === 1) return tex;
  const key = `${cacheKey}:${repeat}`;
  const hit = scaledTextureCache.get(key);
  if (hit) return hit;
  const clone = tex.clone();
  clone.repeat.set(repeat, repeat);
  clone.needsUpdate = true;
  scaledTextureCache.set(key, clone);
  return clone;
}

export interface SurfaceMaterialOptions {
  color?: number;
  roughness?: number;
  metalness?: number;
  emissive?: number;
  textureScale?: number;
  /**
   * Take albedo tint from a per-vertex `color` attribute instead of the material.
   * This is what lets map geometry merge brushes that differ only in colour into
   * one draw call; `color` then only tints the emissive term.
   */
  vertexColors?: boolean;
}

/** Surfaces that need alpha. Everything else stays fully opaque so it sorts cheaply. */
const SURFACE_OPACITY: Partial<Record<SurfaceType, number>> = {
  [SurfaceType.Glass]: 0.34,
  [SurfaceType.Water]: 0.62,
};

/**
 * Standard PBR material for world geometry.
 *
 * `textureScale` here drives `Texture.repeat`. Note that map geometry bakes its
 * tiling into the UVs instead (see map-geometry.ts) so that brushes of wildly
 * different sizes can still share one merged draw call; this option exists for
 * props and one-off meshes that use unit-UV primitives.
 */
export function surfaceMaterial(surface: SurfaceType, opts: SurfaceMaterialOptions = {}): THREE.Material {
  const color = opts.color ?? SURFACE_COLORS[surface];
  const roughness = opts.roughness ?? SURFACE_ROUGHNESS[surface];
  const metalness = opts.metalness ?? SURFACE_METALNESS[surface];
  const emissive = opts.emissive ?? 0;
  const textureScale = opts.textureScale ?? 1;
  const vertexColors = opts.vertexColors ?? false;

  const key = `surf|${surface}|${color}|${roughness}|${metalness}|${emissive}|${textureScale}|${vertexColors ? 1 : 0}`;
  return cached(key, () => {
    const map = repeated(surfaceTexture(surface), `map:${surface}`, textureScale);
    const normalMap = repeated(surfaceNormalMap(surface), `nrm:${surface}`, textureScale);
    const opacity = SURFACE_OPACITY[surface] ?? 1;

    const mat = new THREE.MeshStandardMaterial({
      map,
      normalMap,
      // White base so the vertex attribute is the only tint when it is in play.
      color: vertexColors ? 0xffffff : color,
      vertexColors,
      roughness,
      metalness,
      transparent: opacity < 1,
      opacity,
      // Two-sided glass and water avoid a hole when the player is inside the volume.
      side: opacity < 1 ? THREE.DoubleSide : THREE.FrontSide,
    });
    mat.normalScale.set(1, 1);
    if (emissive > 0) {
      mat.emissive = new THREE.Color(color);
      mat.emissiveIntensity = emissive;
      // Signage should still read at full brightness in shadow.
      mat.emissiveMap = map;
    }
    return mat;
  });
}

/**
 * Base fatigues for a soldier.
 *
 * Team identity and hostility are separate axes: `team` picks the uniform, and
 * `enemy` pushes it warm/red or cool/blue so friend-or-foe survives colourblind
 * settings, low light and peripheral vision. Silhouette accents are applied by
 * character-model.ts on top of this.
 */
export function teamMaterial(team: Team, enemy: boolean): THREE.Material {
  const key = `team|${team}|${enemy ? 1 : 0}`;
  return cached(key, () => {
    const base = TEAM_BASE_COLOR[team];
    const tint = enemy ? 0xb02f28 : 0x3f7fd0;
    const color = new THREE.Color(base).lerp(new THREE.Color(tint), enemy ? 0.32 : 0.26);
    return new THREE.MeshStandardMaterial({
      color,
      roughness: 0.85,
      metalness: 0.04,
    });
  });
}

const TEAM_BASE_COLOR: Record<Team, number> = {
  [Team.None]: 0x4c4c4c,
  [Team.Allies]: 0x3b4653,
  [Team.Axis]: 0x574b3a,
  [Team.Hostile]: 0x33302b,
};

/** Untextured PBR for viewmodel and character parts. Cached per colour triple. */
export function weaponMaterial(color: number, metalness: number, roughness: number): THREE.Material {
  const key = `weapon|${color}|${metalness}|${roughness}`;
  return cached(key, () =>
    new THREE.MeshStandardMaterial({
      color,
      metalness,
      roughness,
      // Viewmodel parts are small and read better with slightly crisper normals.
      flatShading: false,
    }),
  );
}

/**
 * Bullet tracers. Additive and depth-write-free so overlapping tracers stack
 * into a brighter streak instead of z-fighting, and unaffected by tone mapping
 * so they stay hot regardless of map exposure.
 */
export function tracerMaterial(): THREE.Material {
  return cached('tracer', () =>
    new THREE.MeshBasicMaterial({
      color: 0xffc46a,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    }),
  );
}

/** Muzzle flash quads/cones. Same additive treatment, biased white-hot. */
export function muzzleFlashMaterial(): THREE.Material {
  return cached('muzzleFlash', () =>
    new THREE.MeshBasicMaterial({
      color: 0xffe2ac,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    }),
  );
}

/**
 * Frees every cached material and every scaled texture clone.
 * Textures owned by textures.ts are left alone — dispose that cache separately.
 */
export function disposeMaterialCache(): void {
  for (const mat of materialCache.values()) mat.dispose();
  materialCache.clear();
  for (const tex of scaledTextureCache.values()) tex.dispose();
  scaledTextureCache.clear();
}
