/**
 * Procedural texture generation.
 *
 * The game ships as code only — there are no image files anywhere in the build.
 * Every texture here is rasterised at runtime into an OffscreenCanvas (falling
 * back to a DOM canvas) and cached, because a 263-brush map that regenerated a
 * 512x512 texture per brush would spend seconds on the main thread and gigabytes
 * on the GPU.
 *
 * Albedo and height are painted by *separate* routines per surface rather than
 * deriving height from albedo luminance. Luminance is a lie for most materials:
 * brick mortar is lighter than the brick but sits recessed, and a light speckle
 * on concrete is a pit as often as a pebble. Painting a real height field and
 * running Sobel over it is the only way the normal map agrees with the albedo.
 */

import * as THREE from 'three';
import { SurfaceType } from '@shared/types.js';
import { SURFACE_COLORS } from '@shared/collision/collision-types.js';

/** Default albedo/normal resolution. Large enough to read close-up over iron sights. */
const DEFAULT_SIZE = 512;

// ---------------------------------------------------------------------------
// Canvas plumbing
// ---------------------------------------------------------------------------

interface Raster {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  ctx: CanvasRenderingContext2D;
}

/**
 * Returns null when no 2D canvas implementation exists (node, used by tests and
 * by any headless geometry tooling). Callers fall back to a flat DataTexture so
 * that geometry construction never depends on a browser being present.
 */
function makeRaster(width: number, height: number): Raster | null {
  let canvas: HTMLCanvasElement | OffscreenCanvas;
  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(width, height);
  } else if (typeof document !== 'undefined') {
    const el = document.createElement('canvas');
    el.width = width;
    el.height = height;
    canvas = el;
  } else {
    return null;
  }
  // The two context flavours expose an identical drawing surface for everything
  // used here; the DOM type is the more convenient one to program against.
  const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D | null;
  if (!ctx) return null;
  return { canvas, ctx };
}

function finishColorTexture(raster: Raster): THREE.Texture {
  const tex = new THREE.CanvasTexture(raster.canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  applyTiling(tex);
  return tex;
}

function applyTiling(tex: THREE.Texture): void {
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  // 4x is the sweet spot: grazing floors stay legible without the fill cost of 16x.
  tex.anisotropy = 4;
  tex.needsUpdate = true;
}

function applyClamped(tex: THREE.Texture): void {
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
}

function solidTexture(rgb: number, alpha = 255, srgb = true): THREE.Texture {
  const data = new Uint8Array([(rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff, alpha]);
  const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Deterministic noise
//
// Textures are cached by key, so generation must be reproducible: two calls with
// the same arguments in different sessions have to produce the same pixels or a
// hot-reloaded material would visibly pop.
// ---------------------------------------------------------------------------

type Rng = () => number;

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Tiling value noise: the lattice wraps, so the resulting field is seamless. */
function valueNoise(size: number, cells: number, seed: number): Float32Array {
  const rand = mulberry32(seed);
  const lattice = new Float32Array(cells * cells);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rand();

  const out = new Float32Array(size * size);
  const step = cells / size;
  for (let y = 0; y < size; y++) {
    const fy = y * step;
    const yi = Math.floor(fy);
    const ty = smoothstep(fy - yi);
    const y0 = ((yi % cells) + cells) % cells;
    const y1 = (y0 + 1) % cells;
    for (let x = 0; x < size; x++) {
      const fx = x * step;
      const xi = Math.floor(fx);
      const tx = smoothstep(fx - xi);
      const x0 = ((xi % cells) + cells) % cells;
      const x1 = (x0 + 1) % cells;
      const a = lattice[y0 * cells + x0];
      const b = lattice[y0 * cells + x1];
      const c = lattice[y1 * cells + x0];
      const d = lattice[y1 * cells + x1];
      out[y * size + x] = lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
    }
  }
  return out;
}

/** Fractal sum of value noise, normalised to roughly 0..1. */
function fbm(size: number, cells: number, octaves: number, seed: number): Float32Array {
  const out = new Float32Array(size * size);
  let amplitude = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const layer = valueNoise(size, Math.max(2, cells << o), seed + o * 7919);
    for (let i = 0; i < out.length; i++) out[i] += layer[i] * amplitude;
    total += amplitude;
    amplitude *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

// ---------------------------------------------------------------------------
// Colour helpers — everything works on packed 0xRRGGBB so the per-pixel loops
// never allocate.
// ---------------------------------------------------------------------------

function pack(r: number, g: number, b: number): number {
  const ri = r < 0 ? 0 : r > 255 ? 255 : r | 0;
  const gi = g < 0 ? 0 : g > 255 ? 255 : g | 0;
  const bi = b < 0 ? 0 : b > 255 ? 255 : b | 0;
  return (ri << 16) | (gi << 8) | bi;
}

function scale(color: number, f: number): number {
  return pack(((color >> 16) & 0xff) * f, ((color >> 8) & 0xff) * f, (color & 0xff) * f);
}

function mix(a: number, b: number, t: number): number {
  return pack(
    lerp((a >> 16) & 0xff, (b >> 16) & 0xff, t),
    lerp((a >> 8) & 0xff, (b >> 8) & 0xff, t),
    lerp(a & 0xff, b & 0xff, t),
  );
}

function css(color: number, alpha = 1): string {
  return `rgba(${(color >> 16) & 0xff},${(color >> 8) & 0xff},${color & 0xff},${alpha})`;
}

function grey(v: number): number {
  const g = clamp01(v) * 255;
  return pack(g, g, g);
}

/** Rasterise a whole field in one putImageData — far cheaper than 262k fillRects. */
function paintField(ctx: CanvasRenderingContext2D, size: number, fn: (x: number, y: number) => number): void {
  const img = ctx.createImageData(size, size);
  const d = img.data;
  let i = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = fn(x, y);
      d[i++] = (c >> 16) & 0xff;
      d[i++] = (c >> 8) & 0xff;
      d[i++] = c & 0xff;
      d[i++] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * Draw a small shape so that it wraps across the tile boundary. Without this,
 * every pebble and rivet near an edge gets sliced in half and the seam is
 * obvious the moment the texture repeats.
 */
function wrapped(size: number, x: number, y: number, r: number, draw: (cx: number, cy: number) => void): void {
  draw(x, y);
  const dx = x < r ? size : x > size - r ? -size : 0;
  const dy = y < r ? size : y > size - r ? -size : 0;
  if (dx !== 0) draw(x + dx, y);
  if (dy !== 0) draw(x, y + dy);
  if (dx !== 0 && dy !== 0) draw(x + dx, y + dy);
}

function speckle(
  ctx: CanvasRenderingContext2D,
  size: number,
  rng: Rng,
  count: number,
  minR: number,
  maxR: number,
  colorFor: (n: number) => string,
): void {
  for (let i = 0; i < count; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = lerp(minR, maxR, rng());
    ctx.fillStyle = colorFor(rng());
    wrapped(size, x, y, r + 1, (cx, cy) => {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    });
  }
}

// ---------------------------------------------------------------------------
// Per-surface recipes
// ---------------------------------------------------------------------------

type Painter = (ctx: CanvasRenderingContext2D, size: number, base: number, rng: Rng, seed: number) => void;

interface Recipe {
  albedo: Painter;
  /** Greyscale height field: white is proud of the surface, black is recessed. */
  height: Painter;
  /** Sobel gain. Rough granular surfaces need more than sheet materials. */
  bump: number;
}

// --- concrete ---------------------------------------------------------------

const concreteAlbedo: Painter = (ctx, size, base, rng, seed) => {
  const mottle = fbm(size, 6, 4, seed);
  const grain = valueNoise(size, size >> 1, seed + 31);
  paintField(ctx, size, (x, y) => {
    const i = y * size + x;
    return scale(base, 0.78 + mottle[i] * 0.38 + (grain[i] - 0.5) * 0.1);
  });
  speckle(ctx, size, rng, 2600, 0.4, 1.6, (n) => (n < 0.5 ? 'rgba(30,30,30,0.30)' : 'rgba(240,240,235,0.22)'));
  // Hairline cracks: concrete without cracks reads as painted cardboard.
  ctx.lineCap = 'round';
  for (let c = 0; c < 5; c++) {
    let x = rng() * size;
    let y = rng() * size;
    let angle = rng() * Math.PI * 2;
    ctx.strokeStyle = 'rgba(40,38,36,0.35)';
    ctx.lineWidth = 0.8 + rng();
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let s = 0; s < 14; s++) {
      angle += (rng() - 0.5) * 1.1;
      x += Math.cos(angle) * size * 0.035;
      y += Math.sin(angle) * size * 0.035;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
};

const concreteHeight: Painter = (ctx, size, _base, rng, seed) => {
  const mottle = fbm(size, 6, 4, seed);
  const grain = valueNoise(size, size >> 1, seed + 31);
  paintField(ctx, size, (x, y) => {
    const i = y * size + x;
    return grey(0.42 + mottle[i] * 0.28 + (grain[i] - 0.5) * 0.12);
  });
  speckle(ctx, size, rng, 2600, 0.4, 1.6, (n) => (n < 0.5 ? 'rgba(0,0,0,0.35)' : 'rgba(255,255,255,0.30)'));
};

// --- brick ------------------------------------------------------------------

const BRICK_COLS = 4;
const BRICK_ROWS = 8;

/**
 * Running bond. Rows alternate a half-brick offset and the row count is even, so
 * the pattern is periodic over the full tile and repeats without a visible seam.
 */
function forEachBrick(size: number, fn: (x: number, y: number, w: number, h: number, index: number) => void): void {
  const bw = size / BRICK_COLS;
  const bh = size / BRICK_ROWS;
  for (let row = 0; row < BRICK_ROWS; row++) {
    const offset = row % 2 === 0 ? 0 : bw / 2;
    for (let col = -1; col <= BRICK_COLS; col++) {
      fn(col * bw + offset, row * bh, bw, bh, row * (BRICK_COLS + 2) + col + 1);
    }
  }
}

const brickAlbedo: Painter = (ctx, size, base, rng, seed) => {
  const mortar = 0xa8a29a;
  const mottle = fbm(size, 10, 3, seed);
  paintField(ctx, size, (x, y) => {
    const i = y * size + x;
    return scale(mortar, 0.85 + mottle[i] * 0.3);
  });
  const gap = Math.max(2, size / 96);
  forEachBrick(size, (bx, by, bw, bh) => {
    const tint = 0.82 + rng() * 0.36;
    ctx.fillStyle = css(scale(base, tint));
    ctx.fillRect(bx + gap, by + gap, bw - gap * 2, bh - gap * 2);
    // Weathering along the top edge of each brick where water sits.
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(bx + gap, by + gap, bw - gap * 2, Math.max(1, bh * 0.12));
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    ctx.fillRect(bx + gap, by + bh - gap - Math.max(1, bh * 0.1), bw - gap * 2, Math.max(1, bh * 0.1));
  });
  speckle(ctx, size, rng, 3000, 0.4, 1.3, (n) => (n < 0.5 ? 'rgba(20,10,8,0.20)' : 'rgba(255,240,225,0.14)'));
};

const brickHeight: Painter = (ctx, size, _base, rng) => {
  ctx.fillStyle = css(grey(0.28));
  ctx.fillRect(0, 0, size, size);
  const gap = Math.max(2, size / 96);
  forEachBrick(size, (bx, by, bw, bh) => {
    ctx.fillStyle = css(grey(0.62 + rng() * 0.16));
    ctx.fillRect(bx + gap, by + gap, bw - gap * 2, bh - gap * 2);
    // Chamfer: a thin brighter inset turns the flat face into a rounded edge.
    ctx.fillStyle = css(grey(0.82));
    ctx.fillRect(bx + gap * 2, by + gap * 2, bw - gap * 4, bh - gap * 4);
  });
  speckle(ctx, size, rng, 2000, 0.4, 1.2, (n) => (n < 0.5 ? 'rgba(0,0,0,0.25)' : 'rgba(255,255,255,0.20)'));
};

// --- wood -------------------------------------------------------------------

const WOOD_PLANKS = 4;

const woodAlbedo: Painter = (ctx, size, base, rng, seed) => {
  const plank = size / WOOD_PLANKS;
  const mottle = fbm(size, 4, 3, seed);
  paintField(ctx, size, (x, y) => {
    const i = y * size + x;
    return scale(base, 0.85 + mottle[i] * 0.25);
  });

  for (let p = 0; p < WOOD_PLANKS; p++) {
    const top = p * plank;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, size, plank);
    ctx.clip();

    ctx.fillStyle = css(scale(base, 0.86 + rng() * 0.3), 0.55);
    ctx.fillRect(0, top, size, plank);

    // Grain: long streaks parallel to the plank, warped by a low-frequency sine
    // so the wood reads as sawn rather than as pinstripes.
    const phase = rng() * Math.PI * 2;
    for (let g = 0; g < 90; g++) {
      const gy = top + rng() * plank;
      const dark = rng() < 0.55;
      ctx.strokeStyle = dark ? `rgba(50,30,16,${0.06 + rng() * 0.14})` : `rgba(230,196,150,${0.05 + rng() * 0.1})`;
      ctx.lineWidth = 0.6 + rng() * 1.6;
      ctx.beginPath();
      const amp = plank * 0.06 * rng();
      const freq = 1 + Math.floor(rng() * 3);
      for (let x = 0; x <= size; x += 8) {
        const yy = gy + Math.sin((x / size) * Math.PI * 2 * freq + phase) * amp;
        if (x === 0) ctx.moveTo(x, yy);
        else ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }

    // A knot or two per plank.
    const knots = rng() < 0.6 ? 1 : 0;
    for (let k = 0; k < knots; k++) {
      const kx = rng() * size;
      const ky = top + plank * (0.3 + rng() * 0.4);
      const kr = plank * (0.1 + rng() * 0.1);
      wrapped(size, kx, ky, kr * 2.5, (cx, cy) => {
        for (let ring = 5; ring >= 1; ring--) {
          ctx.strokeStyle = `rgba(56,34,18,${0.1 + ring * 0.05})`;
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.ellipse(cx, cy, kr * ring * 0.38, kr * ring * 0.24, 0, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.fillStyle = 'rgba(44,26,14,0.85)';
        ctx.beginPath();
        ctx.ellipse(cx, cy, kr * 0.3, kr * 0.19, 0, 0, Math.PI * 2);
        ctx.fill();
      });
    }
    ctx.restore();

    // Seam between planks.
    ctx.fillStyle = 'rgba(28,16,8,0.75)';
    ctx.fillRect(0, top - 1, size, 2.5);
  }
};

const woodHeight: Painter = (ctx, size, _base, rng, seed) => {
  const plank = size / WOOD_PLANKS;
  const grain = fbm(size, 3, 3, seed + 5);
  paintField(ctx, size, (x, y) => {
    const i = y * size + x;
    // Stretch the noise along the plank so the height streaks follow the grain.
    return grey(0.5 + (grain[i] - 0.5) * 0.35);
  });
  for (let p = 0; p < WOOD_PLANKS; p++) {
    const top = p * plank;
    ctx.fillStyle = css(grey(0.05));
    ctx.fillRect(0, top - 1, size, 2.5);
    ctx.fillStyle = css(grey(0.62), 0.5);
    ctx.fillRect(0, top + 3, size, plank - 6);
    for (let g = 0; g < 40; g++) {
      const gy = top + rng() * plank;
      ctx.strokeStyle = `rgba(0,0,0,${0.05 + rng() * 0.12})`;
      ctx.lineWidth = 0.7 + rng();
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(size, gy);
      ctx.stroke();
    }
  }
};

// --- metal ------------------------------------------------------------------

const METAL_PANELS = 2;

function metalRivets(size: number, fn: (x: number, y: number, r: number) => void): void {
  const panel = size / METAL_PANELS;
  const r = Math.max(2, size / 110);
  const inset = r * 3;
  for (let py = 0; py < METAL_PANELS; py++) {
    for (let px = 0; px < METAL_PANELS; px++) {
      const x0 = px * panel;
      const y0 = py * panel;
      const steps = 5;
      for (let s = 0; s < steps; s++) {
        const t = s / (steps - 1);
        fn(x0 + inset + t * (panel - inset * 2), y0 + inset, r);
        fn(x0 + inset + t * (panel - inset * 2), y0 + panel - inset, r);
        fn(x0 + inset, y0 + inset + t * (panel - inset * 2), r);
        fn(x0 + panel - inset, y0 + inset + t * (panel - inset * 2), r);
      }
    }
  }
}

const metalAlbedo: Painter = (ctx, size, base, rng, seed) => {
  const mottle = fbm(size, 5, 3, seed);
  paintField(ctx, size, (x, y) => {
    const i = y * size + x;
    return scale(base, 0.88 + mottle[i] * 0.22);
  });

  // Brushed finish: dense full-width strokes. They span the tile edge to edge so
  // they wrap for free.
  for (let i = 0; i < 1400; i++) {
    const y = rng() * size;
    const light = rng() < 0.5;
    ctx.strokeStyle = light ? `rgba(255,255,255,${0.02 + rng() * 0.06})` : `rgba(0,0,0,${0.02 + rng() * 0.07})`;
    ctx.lineWidth = 0.5 + rng() * 1.4;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y);
    ctx.stroke();
  }

  // Panel seams.
  const panel = size / METAL_PANELS;
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = Math.max(1.5, size / 200);
  for (let p = 0; p < METAL_PANELS; p++) {
    ctx.beginPath();
    ctx.moveTo(p * panel, 0);
    ctx.lineTo(p * panel, size);
    ctx.moveTo(0, p * panel);
    ctx.lineTo(size, p * panel);
    ctx.stroke();
  }

  metalRivets(size, (x, y, r) => {
    wrapped(size, x, y, r + 2, (cx, cy) => {
      const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, 0, cx, cy, r);
      g.addColorStop(0, css(scale(base, 1.55)));
      g.addColorStop(0.65, css(scale(base, 1.05)));
      g.addColorStop(1, css(scale(base, 0.55)));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    });
  });

  // Rust/scuff blooms keep large metal walls from looking like flat plastic.
  speckle(ctx, size, rng, 40, size / 60, size / 22, () => `rgba(120,72,40,${0.05 + rng() * 0.1})`);
};

const metalHeight: Painter = (ctx, size, _base, rng, seed) => {
  const mottle = valueNoise(size, 64, seed + 3);
  paintField(ctx, size, (x, y) => grey(0.5 + (mottle[y * size + x] - 0.5) * 0.08));
  for (let i = 0; i < 900; i++) {
    const y = rng() * size;
    ctx.strokeStyle = rng() < 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
    ctx.lineWidth = 0.5 + rng();
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y);
    ctx.stroke();
  }
  const panel = size / METAL_PANELS;
  ctx.strokeStyle = css(grey(0.1));
  ctx.lineWidth = Math.max(1.5, size / 200);
  for (let p = 0; p < METAL_PANELS; p++) {
    ctx.beginPath();
    ctx.moveTo(p * panel, 0);
    ctx.lineTo(p * panel, size);
    ctx.moveTo(0, p * panel);
    ctx.lineTo(size, p * panel);
    ctx.stroke();
  }
  metalRivets(size, (x, y, r) => {
    wrapped(size, x, y, r + 2, (cx, cy) => {
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, css(grey(0.95)));
      g.addColorStop(0.7, css(grey(0.7)));
      g.addColorStop(1, css(grey(0.45)));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    });
  });
};

// --- granular family (dirt / sand / gravel) ---------------------------------

const dirtAlbedo: Painter = (ctx, size, base, rng, seed) => {
  const coarse = fbm(size, 4, 4, seed);
  const fine = valueNoise(size, size >> 2, seed + 91);
  paintField(ctx, size, (x, y) => {
    const i = y * size + x;
    return scale(base, 0.7 + coarse[i] * 0.5 + (fine[i] - 0.5) * 0.18);
  });
  speckle(ctx, size, rng, 900, 1, 3.5, (n) => (n < 0.6 ? 'rgba(48,38,28,0.45)' : 'rgba(190,172,146,0.35)'));
  speckle(ctx, size, rng, 25, size / 40, size / 12, () => 'rgba(30,22,14,0.16)');
};

const dirtHeight: Painter = (ctx, size, _base, rng, seed) => {
  const coarse = fbm(size, 4, 4, seed);
  const fine = valueNoise(size, size >> 2, seed + 91);
  paintField(ctx, size, (x, y) => {
    const i = y * size + x;
    return grey(0.35 + coarse[i] * 0.4 + (fine[i] - 0.5) * 0.2);
  });
  speckle(ctx, size, rng, 900, 1, 3.5, (n) => (n < 0.5 ? 'rgba(0,0,0,0.4)' : 'rgba(255,255,255,0.45)'));
};

const sandAlbedo: Painter = (ctx, size, base, rng, seed) => {
  const grainField = valueNoise(size, size >> 1, seed);
  const dunes = fbm(size, 3, 3, seed + 17);
  paintField(ctx, size, (x, y) => {
    const i = y * size + x;
    // Wind ripples: a low-amplitude sine across the tile, whole cycles only so it wraps.
    const ripple = Math.sin((y / size) * Math.PI * 2 * 6 + dunes[i] * 4) * 0.05;
    return scale(base, 0.9 + (grainField[i] - 0.5) * 0.16 + dunes[i] * 0.14 + ripple);
  });
  speckle(ctx, size, rng, 1800, 0.4, 1.1, (n) => (n < 0.5 ? 'rgba(90,72,44,0.28)' : 'rgba(255,246,220,0.3)'));
};

const sandHeight: Painter = (ctx, size, _base, rng, seed) => {
  const grainField = valueNoise(size, size >> 1, seed);
  const dunes = fbm(size, 3, 3, seed + 17);
  paintField(ctx, size, (x, y) => {
    const i = y * size + x;
    const ripple = Math.sin((y / size) * Math.PI * 2 * 6 + dunes[i] * 4) * 0.18;
    return grey(0.5 + (grainField[i] - 0.5) * 0.22 + ripple);
  });
  speckle(ctx, size, rng, 1400, 0.4, 1.1, (n) => (n < 0.5 ? 'rgba(0,0,0,0.3)' : 'rgba(255,255,255,0.35)'));
};

const gravelAlbedo: Painter = (ctx, size, base, rng, seed) => {
  const bed = fbm(size, 8, 3, seed);
  paintField(ctx, size, (x, y) => scale(base, 0.42 + bed[y * size + x] * 0.3));
  // Pebbles, largest first so smaller stones settle into the gaps.
  for (let pass = 0; pass < 3; pass++) {
    const count = [180, 320, 700][pass];
    const rMin = [size / 55, size / 90, size / 170][pass];
    const rMax = [size / 30, size / 55, size / 95][pass];
    for (let i = 0; i < count; i++) {
      const x = rng() * size;
      const y = rng() * size;
      const r = lerp(rMin, rMax, rng());
      const tone = scale(base, 0.7 + rng() * 0.75);
      wrapped(size, x, y, r + 2, (cx, cy) => {
        const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.05, cx, cy, r);
        g.addColorStop(0, css(scale(tone, 1.35)));
        g.addColorStop(0.7, css(tone));
        g.addColorStop(1, css(scale(tone, 0.5)));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(cx, cy, r, r * (0.72 + rng() * 0.28), rng() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
      });
    }
  }
};

const gravelHeight: Painter = (ctx, size, _base, rng, seed) => {
  const bed = fbm(size, 8, 3, seed);
  paintField(ctx, size, (x, y) => grey(0.22 + bed[y * size + x] * 0.2));
  for (let pass = 0; pass < 3; pass++) {
    const count = [180, 320, 700][pass];
    const rMin = [size / 55, size / 90, size / 170][pass];
    const rMax = [size / 30, size / 55, size / 95][pass];
    for (let i = 0; i < count; i++) {
      const x = rng() * size;
      const y = rng() * size;
      const r = lerp(rMin, rMax, rng());
      wrapped(size, x, y, r + 2, (cx, cy) => {
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        g.addColorStop(0, css(grey(0.85)));
        g.addColorStop(0.65, css(grey(0.6)));
        g.addColorStop(1, css(grey(0.2)));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(cx, cy, r, r * 0.85, rng() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
      });
    }
  }
};

// --- organics ---------------------------------------------------------------

const grassAlbedo: Painter = (ctx, size, base, rng, seed) => {
  const patches = fbm(size, 5, 4, seed);
  paintField(ctx, size, (x, y) => {
    const i = y * size + x;
    return scale(base, 0.62 + patches[i] * 0.6);
  });
  // Blades: short strokes at varied angles. Density is what sells grass.
  for (let i = 0; i < 7000; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const len = size * (0.006 + rng() * 0.014);
    const angle = -Math.PI / 2 + (rng() - 0.5) * 1.4;
    const tone = scale(base, 0.55 + rng() * 1.0);
    ctx.strokeStyle = css(tone, 0.5 + rng() * 0.4);
    ctx.lineWidth = 0.6 + rng() * 0.8;
    wrapped(size, x, y, len + 2, (cx, cy) => {
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(angle) * len, cy + Math.sin(angle) * len);
      ctx.stroke();
    });
  }
};

const grassHeight: Painter = (ctx, size, _base, rng, seed) => {
  const patches = fbm(size, 5, 4, seed);
  paintField(ctx, size, (x, y) => grey(0.4 + patches[y * size + x] * 0.25));
  for (let i = 0; i < 3000; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const len = size * (0.006 + rng() * 0.012);
    const angle = -Math.PI / 2 + (rng() - 0.5) * 1.4;
    ctx.strokeStyle = rng() < 0.5 ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(angle) * len, y + Math.sin(angle) * len);
    ctx.stroke();
  }
};

const foliageAlbedo: Painter = (ctx, size, base, rng, seed) => {
  const depth = fbm(size, 4, 3, seed);
  paintField(ctx, size, (x, y) => scale(base, 0.28 + depth[y * size + x] * 0.3));
  for (let i = 0; i < 700; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = size * (0.018 + rng() * 0.035);
    const tone = scale(base, 0.55 + rng() * 1.1);
    ctx.fillStyle = css(tone, 0.85);
    wrapped(size, x, y, r * 2, (cx, cy) => {
      ctx.beginPath();
      ctx.ellipse(cx, cy, r, r * 0.45, rng() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    });
  }
};

const foliageHeight: Painter = (ctx, size, _base, rng, seed) => {
  const depth = fbm(size, 4, 3, seed);
  paintField(ctx, size, (x, y) => grey(0.3 + depth[y * size + x] * 0.25));
  for (let i = 0; i < 700; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = size * (0.018 + rng() * 0.035);
    ctx.fillStyle = css(grey(0.45 + rng() * 0.5), 0.75);
    wrapped(size, x, y, r * 2, (cx, cy) => {
      ctx.beginPath();
      ctx.ellipse(cx, cy, r, r * 0.45, rng() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    });
  }
};

const fleshAlbedo: Painter = (ctx, size, base, rng, seed) => {
  const blotch = fbm(size, 5, 4, seed);
  paintField(ctx, size, (x, y) => {
    const i = y * size + x;
    return mix(scale(base, 0.7), scale(base, 1.25), blotch[i]);
  });
  for (let i = 0; i < 60; i++) {
    let x = rng() * size;
    let y = rng() * size;
    let a = rng() * Math.PI * 2;
    ctx.strokeStyle = `rgba(90,26,26,${0.1 + rng() * 0.2})`;
    ctx.lineWidth = 0.6 + rng() * 1.4;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let s = 0; s < 6; s++) {
      a += (rng() - 0.5) * 1.4;
      x += Math.cos(a) * size * 0.03;
      y += Math.sin(a) * size * 0.03;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
};

const fleshHeight: Painter = (ctx, size, _base, _rng, seed) => {
  const blotch = fbm(size, 6, 4, seed);
  paintField(ctx, size, (x, y) => grey(0.45 + blotch[y * size + x] * 0.2));
};

// --- sheet materials --------------------------------------------------------

const glassAlbedo: Painter = (ctx, size, base, rng, seed) => {
  const sheen = fbm(size, 2, 2, seed);
  paintField(ctx, size, (x, y) => scale(base, 0.94 + sheen[y * size + x] * 0.14));
  // Faint diagonal streaks: cleaning marks. Anything stronger reads as frost.
  for (let i = 0; i < 24; i++) {
    const off = rng() * size;
    ctx.strokeStyle = `rgba(255,255,255,${0.02 + rng() * 0.04})`;
    ctx.lineWidth = size * (0.01 + rng() * 0.03);
    ctx.beginPath();
    ctx.moveTo(off - size, 0);
    ctx.lineTo(off + size, size);
    ctx.stroke();
  }
};

const glassHeight: Painter = (ctx, size, _base, _rng, seed) => {
  const sheen = valueNoise(size, 8, seed);
  paintField(ctx, size, (x, y) => grey(0.5 + (sheen[y * size + x] - 0.5) * 0.05));
};

const waterAlbedo: Painter = (ctx, size, base, _rng, seed) => {
  const swell = fbm(size, 4, 3, seed);
  paintField(ctx, size, (x, y) => {
    const i = y * size + x;
    const u = (x / size) * Math.PI * 2;
    const v = (y / size) * Math.PI * 2;
    const wave = Math.sin(u * 3 + swell[i] * 5) * 0.5 + Math.sin(v * 4 - swell[i] * 4) * 0.5;
    return scale(base, 0.9 + wave * 0.12 + swell[i] * 0.16);
  });
};

const waterHeight: Painter = (ctx, size, _base, _rng, seed) => {
  const swell = fbm(size, 4, 3, seed);
  paintField(ctx, size, (x, y) => {
    const i = y * size + x;
    const u = (x / size) * Math.PI * 2;
    const v = (y / size) * Math.PI * 2;
    const wave = Math.sin(u * 3 + swell[i] * 5) * 0.5 + Math.sin(v * 4 - swell[i] * 4) * 0.5;
    return grey(0.5 + wave * 0.22);
  });
};

const plasticAlbedo: Painter = (ctx, size, base, rng, seed) => {
  const n = valueNoise(size, 128, seed);
  paintField(ctx, size, (x, y) => scale(base, 0.95 + (n[y * size + x] - 0.5) * 0.12));
  speckle(ctx, size, rng, 1200, 0.4, 1.0, (v) => (v < 0.5 ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.07)'));
};

const plasticHeight: Painter = (ctx, size, _base, _rng, seed) => {
  const n = valueNoise(size, 128, seed);
  paintField(ctx, size, (x, y) => grey(0.5 + (n[y * size + x] - 0.5) * 0.1));
};

const carpetAlbedo: Painter = (ctx, size, base, rng, seed) => {
  const n = fbm(size, 16, 3, seed);
  paintField(ctx, size, (x, y) => scale(base, 0.8 + n[y * size + x] * 0.35));
  // Fibres. High count, tiny marks — carpet is defined by its noise floor.
  for (let i = 0; i < 22000; i++) {
    const x = rng() * size;
    const y = rng() * size;
    ctx.fillStyle = rng() < 0.5 ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.08)';
    ctx.fillRect(x, y, 1, 1 + rng());
  }
  const weave = Math.max(3, size / 64);
  ctx.strokeStyle = 'rgba(0,0,0,0.05)';
  ctx.lineWidth = 1;
  for (let p = 0; p < size; p += weave) {
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, size);
    ctx.moveTo(0, p);
    ctx.lineTo(size, p);
    ctx.stroke();
  }
};

const carpetHeight: Painter = (ctx, size, _base, rng, seed) => {
  const n = fbm(size, 24, 3, seed);
  paintField(ctx, size, (x, y) => grey(0.45 + n[y * size + x] * 0.2));
  for (let i = 0; i < 12000; i++) {
    ctx.fillStyle = rng() < 0.5 ? 'rgba(0,0,0,0.15)' : 'rgba(255,255,255,0.15)';
    ctx.fillRect(rng() * size, rng() * size, 1, 1);
  }
};

const snowAlbedo: Painter = (ctx, size, base, rng, seed) => {
  const drift = fbm(size, 4, 4, seed);
  paintField(ctx, size, (x, y) => {
    const i = y * size + x;
    // Snow shadows are blue, not grey — that is what makes it read as snow.
    return mix(scale(base, 0.86), 0xffffff, clamp01(drift[i] * 1.15));
  });
  for (let i = 0; i < 220; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = size * (0.03 + rng() * 0.09);
    wrapped(size, x, y, r * 1.2, (cx, cy) => {
      const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.35, 0, cx, cy, r);
      g.addColorStop(0, 'rgba(255,255,255,0.35)');
      g.addColorStop(1, 'rgba(196,214,236,0.0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    });
  }
  speckle(ctx, size, rng, 1500, 0.4, 1.0, () => 'rgba(255,255,255,0.7)');
};

const snowHeight: Painter = (ctx, size, _base, rng, seed) => {
  const drift = fbm(size, 4, 4, seed);
  paintField(ctx, size, (x, y) => grey(0.4 + drift[y * size + x] * 0.3));
  for (let i = 0; i < 220; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = size * (0.03 + rng() * 0.09);
    wrapped(size, x, y, r * 1.2, (cx, cy) => {
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, 'rgba(255,255,255,0.3)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    });
  }
};

const TILE_GRID = 4;

const tileAlbedo: Painter = (ctx, size, base, rng, seed) => {
  const grout = scale(base, 0.55);
  const n = valueNoise(size, 64, seed);
  paintField(ctx, size, (x, y) => scale(grout, 0.9 + (n[y * size + x] - 0.5) * 0.2));
  const cell = size / TILE_GRID;
  const gap = Math.max(2, size / 128);
  for (let ty = 0; ty < TILE_GRID; ty++) {
    for (let tx = 0; tx < TILE_GRID; tx++) {
      const x0 = tx * cell;
      const y0 = ty * cell;
      const tone = scale(base, 0.92 + rng() * 0.18);
      const g = ctx.createLinearGradient(x0, y0, x0 + cell, y0 + cell);
      g.addColorStop(0, css(scale(tone, 1.06)));
      g.addColorStop(0.5, css(tone));
      g.addColorStop(1, css(scale(tone, 0.93)));
      ctx.fillStyle = g;
      ctx.fillRect(x0 + gap, y0 + gap, cell - gap * 2, cell - gap * 2);
      // Specular streak across each tile so a moving light sweeps the floor.
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = cell * 0.08;
      ctx.beginPath();
      ctx.moveTo(x0 + cell * 0.15, y0 + cell * 0.85);
      ctx.lineTo(x0 + cell * 0.85, y0 + cell * 0.15);
      ctx.stroke();
    }
  }
  speckle(ctx, size, rng, 500, 0.4, 1.0, (v) => (v < 0.5 ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.06)'));
};

const tileHeight: Painter = (ctx, size, _base, _rng) => {
  ctx.fillStyle = css(grey(0.22));
  ctx.fillRect(0, 0, size, size);
  const cell = size / TILE_GRID;
  const gap = Math.max(2, size / 128);
  for (let ty = 0; ty < TILE_GRID; ty++) {
    for (let tx = 0; tx < TILE_GRID; tx++) {
      ctx.fillStyle = css(grey(0.7));
      ctx.fillRect(tx * cell + gap, ty * cell + gap, cell - gap * 2, cell - gap * 2);
      ctx.fillStyle = css(grey(0.85));
      ctx.fillRect(tx * cell + gap * 2, ty * cell + gap * 2, cell - gap * 4, cell - gap * 4);
    }
  }
};

const RECIPES: Record<SurfaceType, Recipe> = {
  [SurfaceType.Concrete]: { albedo: concreteAlbedo, height: concreteHeight, bump: 1.4 },
  [SurfaceType.Metal]: { albedo: metalAlbedo, height: metalHeight, bump: 1.1 },
  [SurfaceType.Wood]: { albedo: woodAlbedo, height: woodHeight, bump: 1.3 },
  [SurfaceType.Dirt]: { albedo: dirtAlbedo, height: dirtHeight, bump: 2.0 },
  [SurfaceType.Grass]: { albedo: grassAlbedo, height: grassHeight, bump: 1.8 },
  [SurfaceType.Sand]: { albedo: sandAlbedo, height: sandHeight, bump: 1.6 },
  [SurfaceType.Water]: { albedo: waterAlbedo, height: waterHeight, bump: 0.8 },
  [SurfaceType.Glass]: { albedo: glassAlbedo, height: glassHeight, bump: 0.15 },
  [SurfaceType.Foliage]: { albedo: foliageAlbedo, height: foliageHeight, bump: 1.7 },
  [SurfaceType.Flesh]: { albedo: fleshAlbedo, height: fleshHeight, bump: 0.7 },
  [SurfaceType.Carpet]: { albedo: carpetAlbedo, height: carpetHeight, bump: 1.0 },
  [SurfaceType.Gravel]: { albedo: gravelAlbedo, height: gravelHeight, bump: 2.4 },
  [SurfaceType.Snow]: { albedo: snowAlbedo, height: snowHeight, bump: 1.2 },
  [SurfaceType.Tile]: { albedo: tileAlbedo, height: tileHeight, bump: 1.5 },
  [SurfaceType.Plastic]: { albedo: plasticAlbedo, height: plasticHeight, bump: 0.4 },
  [SurfaceType.Brick]: { albedo: brickAlbedo, height: brickHeight, bump: 2.2 },
};

/** Stable per-surface seed so a surface looks identical every run. */
function surfaceSeed(surface: SurfaceType): number {
  return 0x9e3779b1 ^ ((surface + 1) * 2654435761);
}

// ---------------------------------------------------------------------------
// Height field -> normal map
// ---------------------------------------------------------------------------

/**
 * Sobel the height canvas into a tangent-space normal map.
 *
 * Sign convention: three.js uploads textures with flipY, so image row 0 ends up
 * at v = 1. That makes dh/dv = -dh/drow, hence the green channel takes +gy while
 * red takes -gx. Get this backwards and every bump lights as a dent.
 */
function heightToNormal(height: Float32Array, size: number, strength: number): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const at = (x: number, y: number): number => {
    const xi = ((x % size) + size) % size;
    const yi = ((y % size) + size) % size;
    return height[yi * size + xi];
  };
  let o = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tl = at(x - 1, y - 1);
      const t = at(x, y - 1);
      const tr = at(x + 1, y - 1);
      const l = at(x - 1, y);
      const r = at(x + 1, y);
      const bl = at(x - 1, y + 1);
      const b = at(x, y + 1);
      const br = at(x + 1, y + 1);
      const gx = tl + 2 * l + bl - (tr + 2 * r + br);
      const gy = tl + 2 * t + tr - (bl + 2 * b + br);
      let nx = gx * strength;
      let ny = -gy * strength;
      const nz = 1;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= inv;
      ny *= inv;
      out[o++] = (nx * 0.5 + 0.5) * 255;
      out[o++] = (ny * 0.5 + 0.5) * 255;
      out[o++] = (nz * inv * 0.5 + 0.5) * 255;
      out[o++] = 255;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const cache = new Map<string, THREE.Texture>();

function cached(key: string, build: () => THREE.Texture): THREE.Texture {
  const hit = cache.get(key);
  if (hit) return hit;
  const tex = build();
  tex.name = key;
  cache.set(key, tex);
  return tex;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Tiling albedo for a surface. Cached by (surface, size) — every brush of a
 * given surface shares one GPU upload.
 */
export function surfaceTexture(surface: SurfaceType, size: number = DEFAULT_SIZE): THREE.Texture {
  return cached(`surface:${surface}:${size}`, () => {
    const raster = makeRaster(size, size);
    if (!raster) return solidTexture(SURFACE_COLORS[surface]);
    const recipe = RECIPES[surface];
    const seed = surfaceSeed(surface);
    recipe.albedo(raster.ctx, size, SURFACE_COLORS[surface], mulberry32(seed), seed);
    return finishColorTexture(raster);
  });
}

/** Normal map matching `surfaceTexture` for the same surface and size. */
export function surfaceNormalMap(surface: SurfaceType, size: number = DEFAULT_SIZE): THREE.Texture {
  return cached(`normal:${surface}:${size}`, () => {
    const raster = makeRaster(size, size);
    // 0x8080ff is the flat tangent-space normal; safe default when headless.
    if (!raster) return solidTexture(0x8080ff, 255, false);
    const recipe = RECIPES[surface];
    const seed = surfaceSeed(surface);
    recipe.height(raster.ctx, size, SURFACE_COLORS[surface], mulberry32(seed), seed);

    const img = raster.ctx.getImageData(0, 0, size, size);
    const field = new Float32Array(size * size);
    for (let i = 0; i < field.length; i++) field[i] = img.data[i * 4] / 255;

    const data = heightToNormal(field, size, recipe.bump);
    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    applyTiling(tex);
    return tex;
  });
}

/**
 * Greyscale fractal noise. Emitted as a DataTexture rather than through a canvas
 * because it is pure pixel data — a rasteriser would only add a copy.
 */
export function noiseTexture(size: number, scaleCells: number, seed: number): THREE.Texture {
  return cached(`noise:${size}:${scaleCells}:${seed}`, () => {
    const cells = Math.max(2, Math.round(scaleCells));
    const field = fbm(size, cells, 4, seed);
    const data = new Uint8Array(size * size * 4);
    for (let i = 0; i < field.length; i++) {
      const v = clamp01(field[i]) * 255;
      data[i * 4] = v;
      data[i * 4 + 1] = v;
      data[i * 4 + 2] = v;
      data[i * 4 + 3] = 255;
    }
    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    applyTiling(tex);
    return tex;
  });
}

/** Vertical two-stop gradient, used for the sky dome and HUD washes. */
export function gradientTexture(top: number, bottom: number): THREE.Texture {
  return cached(`gradient:${top}:${bottom}`, () => {
    const height = 256;
    const raster = makeRaster(4, height);
    if (!raster) return solidTexture(mix(bottom, top, 0.5));
    const g = raster.ctx.createLinearGradient(0, 0, 0, height);
    g.addColorStop(0, css(top));
    g.addColorStop(1, css(bottom));
    raster.ctx.fillStyle = g;
    raster.ctx.fillRect(0, 0, 4, height);
    const tex = new THREE.CanvasTexture(raster.canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    applyClamped(tex);
    return tex;
  });
}

export type DecalKind = 'bullet_concrete' | 'bullet_metal' | 'bullet_wood' | 'blood' | 'scorch';

/** Transparent decal sprite. Clamped, never tiled. */
export function decalTexture(kind: DecalKind): THREE.Texture {
  return cached(`decal:${kind}`, () => {
    const size = 128;
    const raster = makeRaster(size, size);
    if (!raster) return solidTexture(0x000000, 0, false);
    const ctx = raster.ctx;
    const rng = mulberry32(0xdeca1 ^ kind.length * 7919 ^ kind.charCodeAt(0) * 31);
    const c = size / 2;
    ctx.clearRect(0, 0, size, size);

    switch (kind) {
      case 'bullet_concrete': {
        // Pulverised halo, then the hole, then radial spall lines.
        const halo = ctx.createRadialGradient(c, c, size * 0.05, c, c, size * 0.42);
        halo.addColorStop(0, 'rgba(226,224,218,0.85)');
        halo.addColorStop(0.55, 'rgba(190,188,182,0.35)');
        halo.addColorStop(1, 'rgba(160,158,152,0)');
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(c, c, size * 0.42, 0, Math.PI * 2);
        ctx.fill();
        for (let i = 0; i < 18; i++) {
          const a = rng() * Math.PI * 2;
          const len = size * (0.14 + rng() * 0.24);
          ctx.strokeStyle = `rgba(70,68,64,${0.2 + rng() * 0.3})`;
          ctx.lineWidth = 0.6 + rng() * 1.2;
          ctx.beginPath();
          ctx.moveTo(c, c);
          ctx.lineTo(c + Math.cos(a) * len, c + Math.sin(a) * len);
          ctx.stroke();
        }
        const hole = ctx.createRadialGradient(c, c, 0, c, c, size * 0.14);
        hole.addColorStop(0, 'rgba(16,14,12,0.98)');
        hole.addColorStop(0.7, 'rgba(40,38,34,0.9)');
        hole.addColorStop(1, 'rgba(70,66,60,0)');
        ctx.fillStyle = hole;
        ctx.beginPath();
        ctx.arc(c, c, size * 0.14, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'bullet_metal': {
        // Bright torn lip around a dark punch-through.
        for (let i = 0; i < 12; i++) {
          const a = rng() * Math.PI * 2;
          const len = size * (0.1 + rng() * 0.16);
          ctx.strokeStyle = `rgba(226,232,238,${0.25 + rng() * 0.45})`;
          ctx.lineWidth = 1 + rng() * 2.5;
          ctx.beginPath();
          ctx.moveTo(c + Math.cos(a) * size * 0.08, c + Math.sin(a) * size * 0.08);
          ctx.lineTo(c + Math.cos(a) * len, c + Math.sin(a) * len);
          ctx.stroke();
        }
        const lip = ctx.createRadialGradient(c, c, size * 0.06, c, c, size * 0.2);
        lip.addColorStop(0, 'rgba(20,20,22,0.95)');
        lip.addColorStop(0.6, 'rgba(180,188,196,0.7)');
        lip.addColorStop(1, 'rgba(140,148,156,0)');
        ctx.fillStyle = lip;
        ctx.beginPath();
        ctx.arc(c, c, size * 0.2, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'bullet_wood': {
        const halo = ctx.createRadialGradient(c, c, size * 0.04, c, c, size * 0.34);
        halo.addColorStop(0, 'rgba(84,54,28,0.9)');
        halo.addColorStop(1, 'rgba(120,86,50,0)');
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(c, c, size * 0.34, 0, Math.PI * 2);
        ctx.fill();
        // Splinters: long, mostly along the grain axis.
        for (let i = 0; i < 22; i++) {
          const a = (rng() - 0.5) * 0.8 + (rng() < 0.5 ? 0 : Math.PI);
          const len = size * (0.15 + rng() * 0.3);
          ctx.strokeStyle = `rgba(58,36,18,${0.3 + rng() * 0.4})`;
          ctx.lineWidth = 0.8 + rng() * 2;
          ctx.beginPath();
          ctx.moveTo(c, c);
          ctx.lineTo(c + Math.cos(a) * len, c + Math.sin(a) * len * 0.4);
          ctx.stroke();
        }
        ctx.fillStyle = 'rgba(18,10,4,0.95)';
        ctx.beginPath();
        ctx.arc(c, c, size * 0.1, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'blood': {
        const core = ctx.createRadialGradient(c, c, 0, c, c, size * 0.3);
        core.addColorStop(0, 'rgba(122,10,10,0.95)');
        core.addColorStop(0.7, 'rgba(96,6,6,0.7)');
        core.addColorStop(1, 'rgba(70,4,4,0)');
        ctx.fillStyle = core;
        ctx.beginPath();
        ctx.arc(c, c, size * 0.3, 0, Math.PI * 2);
        ctx.fill();
        for (let i = 0; i < 40; i++) {
          const a = rng() * Math.PI * 2;
          const d = size * (0.12 + rng() * 0.34);
          const r = size * (0.008 + rng() * 0.045);
          ctx.fillStyle = `rgba(108,8,8,${0.35 + rng() * 0.5})`;
          ctx.beginPath();
          ctx.ellipse(c + Math.cos(a) * d, c + Math.sin(a) * d, r, r * (0.5 + rng()), a, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      }
      case 'scorch': {
        const g = ctx.createRadialGradient(c, c, 0, c, c, size * 0.48);
        g.addColorStop(0, 'rgba(10,8,6,0.92)');
        g.addColorStop(0.45, 'rgba(26,20,16,0.6)');
        g.addColorStop(0.8, 'rgba(40,32,26,0.22)');
        g.addColorStop(1, 'rgba(50,40,32,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(c, c, size * 0.48, 0, Math.PI * 2);
        ctx.fill();
        for (let i = 0; i < 26; i++) {
          const a = rng() * Math.PI * 2;
          const len = size * (0.2 + rng() * 0.28);
          ctx.strokeStyle = `rgba(12,10,8,${0.1 + rng() * 0.3})`;
          ctx.lineWidth = 1 + rng() * 4;
          ctx.beginPath();
          ctx.moveTo(c, c);
          ctx.lineTo(c + Math.cos(a) * len, c + Math.sin(a) * len);
          ctx.stroke();
        }
        break;
      }
    }

    const tex = new THREE.CanvasTexture(raster.canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    applyClamped(tex);
    return tex;
  });
}

/** White crosshair sprite on transparent black; tinted per-material at use site. */
export function crosshairTexture(): THREE.Texture {
  return cached('crosshair', () => {
    const size = 64;
    const raster = makeRaster(size, size);
    if (!raster) return solidTexture(0xffffff, 0, false);
    const ctx = raster.ctx;
    const c = size / 2;
    ctx.clearRect(0, 0, size, size);
    ctx.lineCap = 'butt';

    const arm = size * 0.28;
    const gap = size * 0.09;
    const draw = (color: string, width: number): void => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(c, c - gap);
      ctx.lineTo(c, c - gap - arm);
      ctx.moveTo(c, c + gap);
      ctx.lineTo(c, c + gap + arm);
      ctx.moveTo(c - gap, c);
      ctx.lineTo(c - gap - arm, c);
      ctx.moveTo(c + gap, c);
      ctx.lineTo(c + gap + arm, c);
      ctx.stroke();
    };
    // Dark underlay first: a pure white crosshair vanishes against snow and sky.
    draw('rgba(0,0,0,0.55)', 4.5);
    draw('rgba(255,255,255,0.95)', 2);

    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath();
    ctx.arc(c, c, 2.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.beginPath();
    ctx.arc(c, c, 1.1, 0, Math.PI * 2);
    ctx.fill();

    const tex = new THREE.CanvasTexture(raster.canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    applyClamped(tex);
    return tex;
  });
}

/** Frees every generated texture. Call on renderer teardown / hot reload. */
export function disposeTextureCache(): void {
  for (const tex of cache.values()) tex.dispose();
  cache.clear();
}
