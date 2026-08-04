/**
 * The procedural audio engine.
 *
 * Owns one AudioContext, a fixed bus graph, an environment convolver rebuilt from
 * the current map's ambience, and a bounded pool of one-shot voices. Everything it
 * plays is synthesised on demand by ./synth.ts — there are no audio assets.
 *
 * Three constraints shape the whole design:
 *
 *   1. Browsers block audio until a user gesture, so nothing may touch an
 *      AudioContext before `resume()`. The engine constructs, accepts settings and
 *      accepts play calls at any time; before it is ready those calls are silent
 *      no-ops rather than errors. Callers must never have to check.
 *
 *   2. Distance is the primary expressive dimension in a shooter. A gunshot 80 m
 *      away is not a quiet gunshot, it is a *different sound* — no crack, no
 *      mechanical detail, mostly the map's response arriving late. That is
 *      implemented here, not in the weapon table.
 *
 *   3. A 1200 rpm weapon fires 20 times a second and every shot is ~10 nodes. Node
 *      allocation must be bounded by construction, not by hoping the GC keeps up.
 */

import type { WeaponDef } from '@shared/data/weapon-types.js';
import type { MapDef } from '@shared/map/map-types.js';
import type { Vec3 } from '@shared/math.js';
import { PERCEPTION } from '@shared/constants.js';
import { SurfaceType } from '@shared/types.js';

import {
  createImpulseResponse,
  getSharedNoise,
  playClick,
  playGunshot as synthGunshot,
  playNoiseBurst,
  playTone,
  type NoiseKind,
} from './synth.js';

// ---------------------------------------------------------------------------
// Public vocabulary
// ---------------------------------------------------------------------------

export type BusName = 'sfx' | 'music' | 'voice' | 'ui';
export type MusicKind = 'menu' | 'victory' | 'defeat' | 'tension';
export type UiSoundKind = 'hover' | 'click' | 'back' | 'error' | 'equip' | 'levelup';
export type ReloadStage = 'magOut' | 'magIn' | 'charge';
export type Ambience = MapDef['ambience'];

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * Hard ceiling on simultaneous one-shots. Chosen so the worst realistic case —
 * a dozen bots in full-auto plus impacts — stays inside a few hundred live nodes.
 */
const MAX_VOICES = 32;

/** Nothing is worth a voice past this range once the lowpass has had its way. */
const MAX_AUDIBLE_DISTANCE = 260;

const SPEED_OF_SOUND = 343;

/**
 * Propagation delay is a huge realism win at range, but past half a second it
 * reads as a bug ("my gun is lagging"), so it is capped well short of real physics.
 */
const MAX_PROPAGATION_DELAY = 0.5;

/**
 * Two shots of the same weapon closer together than this count as sustained fire.
 * At 1200 rpm shots are 50 ms apart, so an auto weapon is always in this regime.
 */
const SUSTAINED_FIRE_INTERVAL = 0.14;

/** Below this the event stream is duplicating shots; no weapon fires this fast. */
const MIN_SHOT_INTERVAL = 0.02;

/** How far ahead the music scheduler queues notes, seconds. */
const MUSIC_LOOKAHEAD = 0.45;

const DEFAULT_AMBIENCE: Ambience = {
  reverbTime: 1.6,
  reverbMix: 0.3,
  wind: 0.2,
  mood: 'urban',
};

/**
 * Voice priorities. Anything the player needs in order to play — their own gun,
 * hitmarkers, announcements — outranks scenery and can never be stolen by it.
 */
const PRIORITY = {
  ui: 10,
  hitmarker: 10,
  explosion: 9,
  announcer: 9,
  gunshotNear: 8,
  whizz: 6,
  gunshotFar: 5,
  reload: 4,
  impact: 3,
  footstep: 2,
} as const;

/**
 * Per-mood room character. `decay` is the IR envelope exponent: higher collapses
 * the tail faster, so an interior stays tight even at a long reverbTime, while a
 * desert bleeds out slowly. `preDelay` is the gap before the first reflection,
 * which is the cue the ear actually uses to judge room size.
 */
interface MoodProfile {
  decay: number;
  preDelay: number;
  wet: number;
  /** Lowpass on the wet return. Interiors are absorbent and therefore dark. */
  tone: number;
  windTone: number;
}

const MOOD_PROFILES: Record<Ambience['mood'], MoodProfile> = {
  interior: { decay: 3.4, preDelay: 0.006, wet: 1.25, tone: 2400, windTone: 220 },
  urban: { decay: 2.0, preDelay: 0.024, wet: 1.0, tone: 4200, windTone: 520 },
  industrial: { decay: 1.6, preDelay: 0.014, wet: 1.2, tone: 3400, windTone: 380 },
  desert: { decay: 2.6, preDelay: 0.048, wet: 0.7, tone: 5200, windTone: 900 },
  forest: { decay: 3.6, preDelay: 0.03, wet: 0.6, tone: 2800, windTone: 700 },
  arctic: { decay: 3.0, preDelay: 0.052, wet: 0.75, tone: 3000, windTone: 1150 },
};

interface SurfaceProfile {
  impactFreq: number;
  impactEndFreq: number;
  impactQ: number;
  impactDuration: number;
  impactKind: NoiseKind;
  impactFilter: BiquadFilterType;
  impactGain: number;
  /** Resonant partial for materials that ring. 0 = dead material. */
  ring: number;
  ringGain: number;
  stepFreq: number;
  stepDuration: number;
  stepKind: NoiseKind;
  stepGain: number;
}

const SURFACES: Record<SurfaceType, SurfaceProfile> = {
  [SurfaceType.Concrete]: { impactFreq: 2400, impactEndFreq: 900, impactQ: 1.2, impactDuration: 0.09, impactKind: 'white', impactFilter: 'bandpass', impactGain: 0.9, ring: 0, ringGain: 0, stepFreq: 900, stepDuration: 0.07, stepKind: 'white', stepGain: 0.55 },
  [SurfaceType.Metal]: { impactFreq: 3200, impactEndFreq: 1400, impactQ: 2.0, impactDuration: 0.07, impactKind: 'white', impactFilter: 'bandpass', impactGain: 0.95, ring: 1850, ringGain: 0.5, stepFreq: 1500, stepDuration: 0.06, stepKind: 'white', stepGain: 0.7 },
  [SurfaceType.Wood]: { impactFreq: 900, impactEndFreq: 400, impactQ: 1.6, impactDuration: 0.11, impactKind: 'pink', impactFilter: 'bandpass', impactGain: 0.85, ring: 320, ringGain: 0.3, stepFreq: 620, stepDuration: 0.08, stepKind: 'pink', stepGain: 0.6 },
  [SurfaceType.Dirt]: { impactFreq: 480, impactEndFreq: 220, impactQ: 0.8, impactDuration: 0.12, impactKind: 'brown', impactFilter: 'lowpass', impactGain: 0.7, ring: 0, ringGain: 0, stepFreq: 300, stepDuration: 0.09, stepKind: 'brown', stepGain: 0.45 },
  [SurfaceType.Grass]: { impactFreq: 700, impactEndFreq: 340, impactQ: 0.7, impactDuration: 0.11, impactKind: 'pink', impactFilter: 'bandpass', impactGain: 0.55, ring: 0, ringGain: 0, stepFreq: 1200, stepDuration: 0.1, stepKind: 'white', stepGain: 0.35 },
  [SurfaceType.Sand]: { impactFreq: 1400, impactEndFreq: 700, impactQ: 0.6, impactDuration: 0.13, impactKind: 'white', impactFilter: 'highpass', impactGain: 0.55, ring: 0, ringGain: 0, stepFreq: 1800, stepDuration: 0.12, stepKind: 'white', stepGain: 0.32 },
  [SurfaceType.Water]: { impactFreq: 700, impactEndFreq: 260, impactQ: 1.1, impactDuration: 0.18, impactKind: 'pink', impactFilter: 'lowpass', impactGain: 0.8, ring: 1100, ringGain: 0.25, stepFreq: 500, stepDuration: 0.16, stepKind: 'pink', stepGain: 0.6 },
  [SurfaceType.Glass]: { impactFreq: 5200, impactEndFreq: 2600, impactQ: 1.2, impactDuration: 0.16, impactKind: 'white', impactFilter: 'highpass', impactGain: 1.0, ring: 3400, ringGain: 0.7, stepFreq: 3000, stepDuration: 0.05, stepKind: 'white', stepGain: 0.5 },
  [SurfaceType.Foliage]: { impactFreq: 2600, impactEndFreq: 1200, impactQ: 0.6, impactDuration: 0.14, impactKind: 'white', impactFilter: 'bandpass', impactGain: 0.5, ring: 0, ringGain: 0, stepFreq: 2400, stepDuration: 0.13, stepKind: 'white', stepGain: 0.38 },
  [SurfaceType.Flesh]: { impactFreq: 260, impactEndFreq: 120, impactQ: 1.4, impactDuration: 0.1, impactKind: 'brown', impactFilter: 'lowpass', impactGain: 0.95, ring: 0, ringGain: 0, stepFreq: 220, stepDuration: 0.07, stepKind: 'brown', stepGain: 0.3 },
  [SurfaceType.Carpet]: { impactFreq: 520, impactEndFreq: 240, impactQ: 0.7, impactDuration: 0.08, impactKind: 'pink', impactFilter: 'lowpass', impactGain: 0.45, ring: 0, ringGain: 0, stepFreq: 380, stepDuration: 0.06, stepKind: 'brown', stepGain: 0.22 },
  [SurfaceType.Gravel]: { impactFreq: 1900, impactEndFreq: 800, impactQ: 0.9, impactDuration: 0.13, impactKind: 'white', impactFilter: 'bandpass', impactGain: 0.8, ring: 0, ringGain: 0, stepFreq: 1600, stepDuration: 0.11, stepKind: 'white', stepGain: 0.6 },
  [SurfaceType.Snow]: { impactFreq: 900, impactEndFreq: 400, impactQ: 0.8, impactDuration: 0.12, impactKind: 'pink', impactFilter: 'lowpass', impactGain: 0.5, ring: 0, ringGain: 0, stepFreq: 1100, stepDuration: 0.12, stepKind: 'pink', stepGain: 0.3 },
  [SurfaceType.Tile]: { impactFreq: 3600, impactEndFreq: 1600, impactQ: 2.2, impactDuration: 0.1, impactKind: 'white', impactFilter: 'bandpass', impactGain: 0.9, ring: 2600, ringGain: 0.55, stepFreq: 2200, stepDuration: 0.05, stepKind: 'white', stepGain: 0.65 },
  [SurfaceType.Plastic]: { impactFreq: 1600, impactEndFreq: 700, impactQ: 1.4, impactDuration: 0.06, impactKind: 'white', impactFilter: 'bandpass', impactGain: 0.6, ring: 900, ringGain: 0.25, stepFreq: 1000, stepDuration: 0.05, stepKind: 'white', stepGain: 0.4 },
  [SurfaceType.Brick]: { impactFreq: 2100, impactEndFreq: 850, impactQ: 1.1, impactDuration: 0.1, impactKind: 'white', impactFilter: 'bandpass', impactGain: 0.88, ring: 0, ringGain: 0, stepFreq: 850, stepDuration: 0.07, stepKind: 'white', stepGain: 0.55 },
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function distanceBetween(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function midiToFreq(note: number): number {
  return 440 * Math.pow(2, (note - 69) / 12);
}

/** FNV-1a. Stable across sessions, so a given announcer line always sounds the same. */
function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Air absorption, approximated as halving the cutoff every 18 m.
 *
 * This is the core of the distance model. It is not physically exact, but it puts
 * the corner at ~5 kHz by 36 m and ~2.5 kHz by 54 m, which is precisely the band
 * where the crack lives — so a shot crosses from "snap" to "thud" over the 40 m
 * mark, exactly where a player expects it to.
 */
function distanceCutoff(distance: number): number {
  return clamp(20000 * Math.pow(0.5, distance / 18), 380, 20000);
}

/**
 * Wet/dry balance versus distance. Close up you hear the source; far away you
 * mostly hear the environment's answer to it, which is why distant firefights
 * sound like rolling thunder rather than small gunshots.
 */
function distanceSend(distance: number, mix: number): number {
  return clamp(0.12 + distance / 70, 0.12, 1.4) * clamp(mix, 0.08, 1);
}

/** Extra path length travelled by the first strong reflection — the slapback. */
function slapbackDelay(distance: number): number {
  return clamp(0.012 + distance / 240, 0.012, 0.32);
}

/**
 * Derived from WaveShaperNode rather than written as `Float32Array` because newer
 * TypeScript lib.dom parameterises typed arrays by their backing buffer, and the
 * bare form widens to ArrayBufferLike, which `curve` rejects.
 */
type ShaperCurve = NonNullable<WaveShaperNode['curve']>;

function makeSoftClipCurve(amount: number): ShaperCurve {
  const n = 1024;
  const curve = new Float32Array(n);
  const norm = Math.tanh(amount);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * amount) / norm;
  }
  return curve;
}

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

/** Never references a bare `AudioContext` identifier, so this is safe under node. */
function getAudioContextCtor(): AudioContextCtor | null {
  const scope = globalThis as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

/**
 * Spatial nodes have two generations of API: AudioParams (current) and setPosition
 * / setOrientation (Safari and older Chrome). Both are addressed structurally so
 * neither a missing param nor a missing method can throw.
 */
interface LegacySpatial {
  positionX?: AudioParam;
  positionY?: AudioParam;
  positionZ?: AudioParam;
  forwardX?: AudioParam;
  forwardY?: AudioParam;
  forwardZ?: AudioParam;
  upX?: AudioParam;
  upY?: AudioParam;
  upZ?: AudioParam;
  setPosition?(x: number, y: number, z: number): void;
  setOrientation?(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void;
}

function setSpatialPosition(target: object, v: Vec3, when: number): void {
  const node = target as LegacySpatial;
  if (node.positionX && node.positionY && node.positionZ) {
    node.positionX.setValueAtTime(v.x, when);
    node.positionY.setValueAtTime(v.y, when);
    node.positionZ.setValueAtTime(v.z, when);
  } else if (node.setPosition) {
    node.setPosition(v.x, v.y, v.z);
  }
}

function setSpatialOrientation(target: object, forward: Vec3, up: Vec3, when: number): void {
  const node = target as LegacySpatial;
  if (node.forwardX && node.forwardY && node.forwardZ && node.upX && node.upY && node.upZ) {
    node.forwardX.setValueAtTime(forward.x, when);
    node.forwardY.setValueAtTime(forward.y, when);
    node.forwardZ.setValueAtTime(forward.z, when);
    node.upX.setValueAtTime(up.x, when);
    node.upY.setValueAtTime(up.y, when);
    node.upZ.setValueAtTime(up.z, when);
  } else if (node.setOrientation) {
    node.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
  }
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface AudioGraph {
  ctx: AudioContext;
  master: GainNode;
  compressor: DynamicsCompressorNode;
  buses: Record<BusName, GainNode>;
  /** Sits after the sfx bus so explosion ducking never clobbers the user's setting. */
  sfxDuck: GainNode;
  reverbInput: DelayNode;
  reverb: ConvolverNode;
  reverbTone: BiquadFilterNode;
  reverbReturn: GainNode;
  windSource: AudioBufferSourceNode | null;
  windFilter: BiquadFilterNode;
  windGain: GainNode;
  radioCurve: ShaperCurve;
  /** HRTF is unavailable in some embedded webviews; resolved once at build time. */
  panningModel: PanningModelType;
}

interface Voice {
  input: GainNode;
  /** Nodes this voice owns downstream of `input`; all disconnected together. */
  extra: AudioNode[];
  endsAt: number;
  priority: number;
  distance: number;
  /** Stolen voices are fading out and no longer count against the budget. */
  stealing: boolean;
}

interface MusicState {
  kind: MusicKind;
  gain: GainNode;
  nextStepTime: number;
  step: number;
  stepSeconds: number;
  steps: number;
  loop: boolean;
}

/** Lower is stolen first: priority dominates, distance breaks ties within a tier. */
function voiceScore(priority: number, distance: number): number {
  return priority * 1000 - Math.min(distance, 999);
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class AudioEngine {
  private graph: AudioGraph | null = null;
  private disposed = false;

  private readonly voices: Voice[] = [];
  private music: MusicState | null = null;
  /** Requested before the context existed; started as soon as it does. */
  private pendingMusic: MusicKind | null = null;

  private ambience: Ambience = { ...DEFAULT_AMBIENCE };

  private masterVolume = 1;
  private readonly busVolumes: Record<BusName, number> = { sfx: 1, music: 0.55, voice: 0.9, ui: 0.8 };

  private listenerPos: Vec3 = { x: 0, y: 0, z: 0 };
  private listenerForward: Vec3 = { x: 0, y: 0, z: -1 };
  private listenerUp: Vec3 = { x: 0, y: 1, z: 0 };

  /** Context time of the last shot per weapon id, for sustained-fire detection. */
  private readonly lastShotAt = new Map<string, number>();

  private time = 0;
  private windAccumulator = 0;
  private windLevel = 0;

  /** Deliberately empty: constructing an AudioContext before a gesture is illegal. */
  constructor() {}

  // -- lifecycle ------------------------------------------------------------

  /**
   * Creates the context on first call and resumes it. Safe to call on every user
   * gesture; safe to call in environments with no Web Audio at all, where it
   * simply leaves the engine permanently not-ready.
   */
  async resume(): Promise<void> {
    if (this.disposed) return;

    if (!this.graph) {
      this.graph = this.build();
      if (!this.graph) return;
      this.applyVolumes(this.graph);
      this.applyAmbience(this.graph);
      this.applyListener(this.graph);
      if (this.pendingMusic) {
        this.startMusic(this.graph, this.pendingMusic);
        this.pendingMusic = null;
      }
    }

    if (this.graph.ctx.state !== 'running') {
      try {
        await this.graph.ctx.resume();
      } catch {
        // Gesture was not trusted, or the context died. Stay silent.
      }
    }
  }

  get ready(): boolean {
    return this.graph !== null && this.graph.ctx.state === 'running';
  }

  dispose(): void {
    this.disposed = true;
    const g = this.graph;
    this.graph = null;
    this.music = null;
    this.pendingMusic = null;
    if (!g) return;

    for (const voice of this.voices) this.disconnectVoice(voice);
    this.voices.length = 0;
    this.lastShotAt.clear();

    try {
      g.windSource?.stop();
    } catch {
      // Already stopped.
    }
    // Every node in the static graph, not just the obvious ones. ctx.close() would
    // reclaim these anyway, but leaving edges behind keeps the whole graph reachable
    // from any caller that still holds the engine, which defeats the point.
    const staticNodes: Array<AudioNode | null> = [
      g.master,
      g.compressor,
      g.sfxDuck,
      g.buses.sfx,
      g.buses.music,
      g.buses.voice,
      g.buses.ui,
      g.reverbInput,
      g.reverb,
      g.reverbTone,
      g.reverbReturn,
      g.windSource,
      g.windFilter,
      g.windGain,
    ];
    for (const node of staticNodes) {
      try {
        node?.disconnect();
      } catch {
        // Torn down out from under us; the context close below covers it.
      }
    }
    void g.ctx.close().catch(() => undefined);
  }

  private build(): AudioGraph | null {
    const Ctor = getAudioContextCtor();
    if (!Ctor) return null;

    try {
      const ctx = new Ctor({ latencyHint: 'interactive' });

      // master -> compressor -> destination. The compressor is the safety net that
      // stops a grenade landing during a firefight from clipping the output.
      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -14;
      compressor.knee.value = 24;
      compressor.ratio.value = 8;
      compressor.attack.value = 0.004;
      compressor.release.value = 0.22;
      compressor.connect(ctx.destination);

      const master = ctx.createGain();
      master.connect(compressor);

      const sfxDuck = ctx.createGain();
      sfxDuck.connect(master);

      const buses: Record<BusName, GainNode> = {
        sfx: ctx.createGain(),
        music: ctx.createGain(),
        voice: ctx.createGain(),
        ui: ctx.createGain(),
      };
      buses.sfx.connect(sfxDuck);
      buses.music.connect(master);
      buses.voice.connect(master);
      buses.ui.connect(master);

      // Reverb send: preDelay -> convolver -> tone -> return -> sfx bus. The return
      // lands on the sfx bus rather than master so reverb follows the sfx slider,
      // and because nothing downstream of it feeds the send there is no loop.
      const reverbInput = ctx.createDelay(0.5);
      const reverb = ctx.createConvolver();
      reverb.normalize = true;
      const reverbTone = ctx.createBiquadFilter();
      reverbTone.type = 'lowpass';
      reverbTone.Q.value = 0.7;
      const reverbReturn = ctx.createGain();
      reverbInput.connect(reverb);
      reverb.connect(reverbTone);
      reverbTone.connect(reverbReturn);
      reverbReturn.connect(buses.sfx);

      // Wind bed: one permanent looping source, never reallocated.
      const windFilter = ctx.createBiquadFilter();
      windFilter.type = 'lowpass';
      windFilter.Q.value = 0.8;
      const windGain = ctx.createGain();
      windGain.gain.value = 0;
      windFilter.connect(windGain);
      windGain.connect(buses.sfx);

      let windSource: AudioBufferSourceNode | null = null;
      try {
        windSource = ctx.createBufferSource();
        windSource.buffer = getSharedNoise(ctx, 'brown');
        windSource.loop = true;
        windSource.connect(windFilter);
        windSource.start();
      } catch {
        windSource = null;
      }

      // HRTF is worth a lot for a shooter but is absent in some webviews.
      let panningModel: PanningModelType = 'equalpower';
      try {
        const probe = ctx.createPanner();
        probe.panningModel = 'HRTF';
        if (probe.panningModel === 'HRTF') panningModel = 'HRTF';
        probe.disconnect();
      } catch {
        panningModel = 'equalpower';
      }

      return {
        ctx,
        master,
        compressor,
        buses,
        sfxDuck,
        reverbInput,
        reverb,
        reverbTone,
        reverbReturn,
        windSource,
        windFilter,
        windGain,
        radioCurve: makeSoftClipCurve(3.2),
        panningModel,
      };
    } catch {
      return null;
    }
  }

  // -- settings -------------------------------------------------------------

  setMasterVolume(v: number): void {
    this.masterVolume = clamp(v, 0, 2);
    if (this.graph) this.applyVolumes(this.graph);
  }

  setBusVolume(bus: BusName, v: number): void {
    this.busVolumes[bus] = clamp(v, 0, 2);
    if (this.graph) this.applyVolumes(this.graph);
  }

  private applyVolumes(g: AudioGraph): void {
    const now = g.ctx.currentTime;
    // Short ramps rather than direct assignment: a volume slider dragged during a
    // firefight otherwise produces an audible zipper on every step.
    g.master.gain.setTargetAtTime(this.masterVolume, now, 0.02);
    for (const name of Object.keys(g.buses) as BusName[]) {
      g.buses[name].gain.setTargetAtTime(this.busVolumes[name], now, 0.02);
    }
  }

  setListener(position: Vec3, forward: Vec3, up: Vec3): void {
    this.listenerPos = { x: position.x, y: position.y, z: position.z };
    this.listenerForward = { x: forward.x, y: forward.y, z: forward.z };
    this.listenerUp = { x: up.x, y: up.y, z: up.z };
    if (this.graph) this.applyListener(this.graph);
  }

  private applyListener(g: AudioGraph): void {
    const now = g.ctx.currentTime;
    setSpatialPosition(g.ctx.listener, this.listenerPos, now);
    setSpatialOrientation(g.ctx.listener, this.listenerForward, this.listenerUp, now);
  }

  /**
   * Rebuilds the room. Called on map load and whenever the player transitions
   * between spaces; regenerating the IR is a few milliseconds of Math.random, which
   * is cheap enough to do at a doorway.
   */
  setEnvironment(ambience: Ambience): void {
    this.ambience = { ...ambience };
    if (this.graph) this.applyAmbience(this.graph);
  }

  private applyAmbience(g: AudioGraph): void {
    const profile = MOOD_PROFILES[this.ambience.mood] ?? MOOD_PROFILES.urban;
    const now = g.ctx.currentTime;

    try {
      g.reverb.buffer = createImpulseResponse(
        g.ctx,
        clamp(this.ambience.reverbTime, 0.05, 8),
        profile.decay,
      );
    } catch {
      // A convolver that refuses its buffer just means a dry map, not a crash.
    }

    g.reverbInput.delayTime.setTargetAtTime(profile.preDelay, now, 0.05);
    g.reverbTone.frequency.setTargetAtTime(profile.tone, now, 0.05);
    g.reverbReturn.gain.setTargetAtTime(clamp(this.ambience.reverbMix, 0, 1) * profile.wet, now, 0.1);

    this.windLevel = clamp(this.ambience.wind, 0, 1) * 0.07;
    g.windFilter.frequency.setTargetAtTime(profile.windTone, now, 0.5);
    g.windGain.gain.setTargetAtTime(this.windLevel, now, 0.5);
  }

  // -- per-frame ------------------------------------------------------------

  update(dt: number): void {
    const g = this.graph;
    if (!g) return;
    this.time += Math.max(dt, 0);

    this.sweepVoices(g);
    this.pumpMusic(g);

    // Gusts, throttled to a few automation events per second. Two incommensurate
    // rates keep the wind from settling into an audible cycle.
    this.windAccumulator += Math.max(dt, 0);
    if (this.windAccumulator >= 0.25 && this.windLevel > 0) {
      this.windAccumulator = 0;
      const gust = 0.55 + 0.45 * (Math.sin(this.time * 0.21) * 0.6 + Math.sin(this.time * 0.073) * 0.4);
      g.windGain.gain.setTargetAtTime(this.windLevel * gust, g.ctx.currentTime, 0.4);
    }
  }

  // -- voice pool -----------------------------------------------------------

  /**
   * Retires every voice whose scheduled lifetime has elapsed.
   *
   * Voices also self-disconnect via `onended` inside synth.ts, but that fires only
   * for source nodes; the per-voice gain, filter, panner and delay are owned here
   * and would otherwise stay connected to the bus forever.
   */
  private sweepVoices(g: AudioGraph): void {
    const now = g.ctx.currentTime;
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const voice = this.voices[i];
      if (voice.endsAt <= now) {
        this.disconnectVoice(voice);
        this.voices.splice(i, 1);
      }
    }
  }

  private disconnectVoice(voice: Voice): void {
    try {
      voice.input.disconnect();
      for (const node of voice.extra) node.disconnect();
    } catch {
      // Context already closed.
    }
    voice.extra.length = 0;
  }

  /**
   * Reserves a slot in the voice pool.
   *
   * Over budget, the least valuable *live* voice is stolen — quietest and most
   * distant first — but only if the incoming sound is worth more than it. A distant
   * footstep arriving while 32 close gunshots are playing is simply dropped, which
   * is what keeps allocation bounded no matter how many events the sim emits.
   */
  private acquireVoice(
    g: AudioGraph,
    priority: number,
    distance: number,
    duration: number,
  ): Voice | null {
    this.sweepVoices(g);
    const now = g.ctx.currentTime;

    let live = 0;
    for (const voice of this.voices) if (!voice.stealing) live++;

    if (live >= MAX_VOICES) {
      const incoming = voiceScore(priority, distance);
      let worstIndex = -1;
      let worstScore = incoming;
      for (let i = 0; i < this.voices.length; i++) {
        const voice = this.voices[i];
        if (voice.stealing) continue;
        const score = voiceScore(voice.priority, voice.distance);
        if (score < worstScore) {
          worstScore = score;
          worstIndex = i;
        }
      }
      if (worstIndex < 0) return null;

      const victim = this.voices[worstIndex];
      victim.stealing = true;
      victim.endsAt = now + 0.02;
      // Fade rather than cut: an instant disconnect mid-waveform is a click.
      try {
        victim.input.gain.cancelScheduledValues(now);
        victim.input.gain.setTargetAtTime(0, now, 0.004);
      } catch {
        // Fall through; the sweep will disconnect it regardless.
      }
    }

    let input: GainNode;
    try {
      input = g.ctx.createGain();
    } catch {
      return null;
    }
    const voice: Voice = {
      input,
      extra: [],
      endsAt: now + Math.max(duration, 0.05) + 0.05,
      priority,
      distance,
      stealing: false,
    };
    this.voices.push(voice);
    return voice;
  }

  private createPanner(
    g: AudioGraph,
    position: Vec3,
    refDistance: number,
    maxDistance: number,
  ): PannerNode {
    const panner = g.ctx.createPanner();
    panner.panningModel = g.panningModel;
    panner.distanceModel = 'inverse';
    panner.refDistance = Math.max(refDistance, 0.5);
    panner.maxDistance = Math.max(maxDistance, refDistance + 1);
    panner.rolloffFactor = 1;
    setSpatialPosition(panner, position, g.ctx.currentTime);
    return panner;
  }

  /**
   * Wires a voice into the bus graph.
   *
   * Order matters: distance lowpass, then the reverb tap, then the panner. Tapping
   * the send *after* the lowpass means the echo inherits the same air absorption as
   * the direct sound — a reverb tail brighter than the thing that caused it is the
   * single clearest tell of fake spatial audio.
   */
  private route(
    g: AudioGraph,
    voice: Voice,
    position: Vec3 | null,
    cfg: {
      bus: BusName;
      lowpassHz?: number;
      refDistance?: number;
      maxDistance?: number;
      send?: number;
      sendDelay?: number;
    },
  ): void {
    let node: AudioNode = voice.input;

    if (cfg.lowpassHz !== undefined && cfg.lowpassHz < 19000) {
      const lowpass = g.ctx.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = clamp(cfg.lowpassHz, 60, 20000);
      lowpass.Q.value = 0.6;
      node.connect(lowpass);
      node = lowpass;
      voice.extra.push(lowpass);
    }

    const sendSource = node;

    if (position) {
      const panner = this.createPanner(
        g,
        position,
        cfg.refDistance ?? 4,
        cfg.maxDistance ?? MAX_AUDIBLE_DISTANCE,
      );
      node.connect(panner);
      node = panner;
      voice.extra.push(panner);
    }
    node.connect(g.buses[cfg.bus]);

    const send = cfg.send ?? 0;
    if (send > 0.001) {
      const sendGain = g.ctx.createGain();
      sendGain.gain.value = send;
      sendSource.connect(sendGain);
      voice.extra.push(sendGain);

      const delaySeconds = cfg.sendDelay ?? 0;
      if (delaySeconds > 0.001) {
        const delay = g.ctx.createDelay(0.5);
        delay.delayTime.value = clamp(delaySeconds, 0, 0.49);
        sendGain.connect(delay);
        delay.connect(g.reverbInput);
        voice.extra.push(delay);
      } else {
        sendGain.connect(g.reverbInput);
      }
    }
  }

  /** Distance from the listener, for the calls that only supply a position. */
  private distanceTo(position: Vec3): number {
    return distanceBetween(this.listenerPos, position);
  }

  // -- game one-shots -------------------------------------------------------

  /**
   * The signature sound of the game.
   *
   * `distance` is passed explicitly rather than derived from `position` because the
   * local player's own weapon must be treated as zero-distance even though its
   * muzzle is a metre away from the listener.
   */
  playGunshot(def: WeaponDef, position: Vec3 | null, distance: number): void {
    const g = this.graph;
    if (!g) return;

    const audio = def.audio;
    const d = clamp(distance, 0, MAX_AUDIBLE_DISTANCE * 2);
    // Audibility is anchored to the same ranges the AI hears with, so what a bot
    // reacts to and what the player hears never disagree.
    const range = audio.suppressed
      ? PERCEPTION.suppressedGunshotRadius
      : PERCEPTION.gunshotRadius;
    if (d > Math.min(MAX_AUDIBLE_DISTANCE, range * 2.5)) return;

    const now = g.ctx.currentTime;
    const last = this.lastShotAt.get(def.id);
    const sinceLast = last === undefined ? Infinity : now - last;
    // Defensive: duplicated shot events must not each buy a voice.
    if (sinceLast < MIN_SHOT_INTERVAL) return;
    this.lastShotAt.set(def.id, now);
    const sustained = sinceLast < SUSTAINED_FIRE_INTERVAL;

    const distanceFactor = clamp(d / Math.max(range, 1), 0, 1);
    const tail = sustained ? audio.tail * 0.35 : audio.tail;
    const duration = 0.35 + tail * 1.9;
    const priority = d < 12 ? PRIORITY.gunshotNear : PRIORITY.gunshotFar;

    const voice = this.acquireVoice(g, priority, d, duration);
    if (!voice) return;

    this.route(g, voice, position, {
      bus: 'sfx',
      lowpassHz: distanceCutoff(d),
      refDistance: 6,
      maxDistance: range * 2,
      send: distanceSend(d, this.ambience.reverbMix),
      sendDelay: slapbackDelay(d),
    });

    // Sound arrives late from across the map. Free to implement (a start offset)
    // and it is most of what makes a distant firefight read as distant.
    const propagation = Math.min(d / SPEED_OF_SOUND, MAX_PROPAGATION_DELAY);
    const when = now + propagation;

    const total = synthGunshot(g.ctx, voice.input, {
      bodyFreq: audio.bodyFreq,
      crackDuration: audio.crackDuration,
      boom: audio.boom,
      mech: audio.mech,
      tail,
      suppressed: audio.suppressed,
      when,
      gain: 0.9,
      distanceFactor,
      // More jitter under sustained fire so a held trigger never turns into a loop.
      variation: sustained ? 0.09 : 0.045,
      // Sustained fire skips the tail layer entirely: real automatic fire smears its
      // tails together anyway, and it halves the node cost of a 1200 rpm weapon.
      tailDest: sustained ? null : voice.input,
    });

    voice.endsAt = when + total + 0.1;
  }

  playImpact(surface: SurfaceType, position: Vec3): void {
    const g = this.graph;
    if (!g) return;
    const d = this.distanceTo(position);
    if (d > 90) return;

    const profile = SURFACES[surface] ?? SURFACES[SurfaceType.Concrete];
    const voice = this.acquireVoice(g, PRIORITY.impact, d, 0.4);
    if (!voice) return;

    this.route(g, voice, position, {
      bus: 'sfx',
      lowpassHz: distanceCutoff(d),
      refDistance: 3,
      maxDistance: 90,
      send: distanceSend(d, this.ambience.reverbMix) * 0.6,
      sendDelay: slapbackDelay(d),
    });

    const ctx = g.ctx;
    const t0 = ctx.currentTime + Math.min(d / SPEED_OF_SOUND, 0.25);

    playNoiseBurst(ctx, voice.input, {
      when: t0,
      duration: profile.impactDuration,
      kind: profile.impactKind,
      filter: profile.impactFilter,
      frequency: profile.impactFreq,
      endFrequency: profile.impactEndFreq,
      q: profile.impactQ,
      gain: profile.impactGain * 0.8,
      env: {
        attack: 0.0006,
        decay: profile.impactDuration * 0.5,
        sustain: 0.04,
        release: profile.impactDuration,
      },
    });

    // Materials that ring get a decaying partial; without it metal and concrete are
    // indistinguishable once the noise layer has decayed.
    if (profile.ring > 0) {
      playTone(ctx, voice.input, {
        when: t0,
        duration: profile.impactDuration * 2.2,
        frequency: profile.ring * (0.94 + Math.random() * 0.12),
        endFrequency: profile.ring * 0.88,
        type: 'triangle',
        gain: profile.ringGain * 0.5,
        env: { attack: 0.001, decay: profile.impactDuration * 1.6, sustain: 0.08, release: 0.18 },
      });
    }

    voice.endsAt = t0 + profile.impactDuration * 3 + 0.3;
  }

  playFootstep(surface: SurfaceType, position: Vec3, loud: boolean): void {
    const g = this.graph;
    if (!g) return;

    const range = loud ? PERCEPTION.footstepRadiusSprint : PERCEPTION.footstepRadiusWalk;
    const d = this.distanceTo(position);
    // Footsteps are the cheapest and most numerous event in the game; culling them
    // at the AI hearing radius is the difference between 6 live voices and 60.
    if (d > range * 1.25) return;

    const profile = SURFACES[surface] ?? SURFACES[SurfaceType.Concrete];
    const voice = this.acquireVoice(g, PRIORITY.footstep, d, 0.35);
    if (!voice) return;

    this.route(g, voice, position, {
      bus: 'sfx',
      lowpassHz: distanceCutoff(d),
      refDistance: 2,
      maxDistance: range * 1.5,
      send: distanceSend(d, this.ambience.reverbMix) * 0.35,
    });

    const ctx = g.ctx;
    const t0 = ctx.currentTime;
    const gain = profile.stepGain * (loud ? 1 : 0.55);
    const jitter = 0.9 + Math.random() * 0.2;

    playNoiseBurst(ctx, voice.input, {
      when: t0,
      duration: profile.stepDuration,
      kind: profile.stepKind,
      filter: 'bandpass',
      frequency: profile.stepFreq * jitter,
      endFrequency: profile.stepFreq * 0.45,
      q: 0.9,
      gain,
      env: { attack: 0.001, decay: profile.stepDuration * 0.6, sustain: 0.05, release: 0.08 },
    });

    // The heel is a separate, lower transient landing a few ms after the sole; one
    // undifferentiated burst reads as a slap rather than a step.
    playTone(ctx, voice.input, {
      when: t0 + 0.006,
      duration: 0.05,
      frequency: 110 * jitter,
      endFrequency: 62,
      type: 'sine',
      gain: gain * 0.5,
      env: { attack: 0.001, decay: 0.03, sustain: 0.02, release: 0.05 },
    });

    voice.endsAt = t0 + profile.stepDuration + 0.25;
  }

  playReload(def: WeaponDef, stage: ReloadStage, position: Vec3 | null): void {
    const g = this.graph;
    if (!g) return;

    const d = position ? this.distanceTo(position) : 0;
    const range = PERCEPTION.reloadRadius;
    if (d > range * 2) return;

    const voice = this.acquireVoice(g, PRIORITY.reload, d, 0.55);
    if (!voice) return;

    this.route(g, voice, position, {
      bus: 'sfx',
      lowpassHz: distanceCutoff(d),
      refDistance: 1.5,
      maxDistance: range * 2,
      send: distanceSend(d, this.ambience.reverbMix) * 0.3,
    });

    const ctx = g.ctx;
    const t0 = ctx.currentTime;
    // Weapons with a heavier action have louder reloads; reusing `mech` keeps the
    // reload consistent with how the same gun sounds when it fires.
    const mech = clamp(def.audio.mech, 0.1, 1);
    const heft = clamp(def.model.length / 0.9, 0.6, 1.6);

    switch (stage) {
      case 'magOut': {
        playClick(ctx, voice.input, { when: t0, frequency: 2600, gain: mech * 0.7 });
        playNoiseBurst(ctx, voice.input, {
          when: t0 + 0.03,
          duration: 0.09,
          filter: 'bandpass',
          frequency: 1300 / heft,
          endFrequency: 700,
          q: 2.4,
          gain: mech * 0.35,
          env: { attack: 0.002, decay: 0.05, sustain: 0.1, release: 0.09 },
        });
        break;
      }
      case 'magIn': {
        playNoiseBurst(ctx, voice.input, {
          when: t0,
          duration: 0.05,
          filter: 'bandpass',
          frequency: 900 / heft,
          q: 1.8,
          gain: mech * 0.4,
          env: { attack: 0.002, decay: 0.03, sustain: 0.05, release: 0.05 },
        });
        // The seat: a low thunk, then the catch clicking home.
        playTone(ctx, voice.input, {
          when: t0 + 0.02,
          duration: 0.07,
          frequency: 190 / heft,
          endFrequency: 90,
          type: 'triangle',
          gain: mech * 0.55,
          env: { attack: 0.001, decay: 0.04, sustain: 0.05, release: 0.07 },
        });
        playClick(ctx, voice.input, { when: t0 + 0.075, frequency: 3400, gain: mech * 0.6 });
        break;
      }
      case 'charge': {
        // Slide back (rasping, pitch rising), then the bolt slamming forward.
        playNoiseBurst(ctx, voice.input, {
          when: t0,
          duration: 0.11,
          filter: 'bandpass',
          frequency: 1600,
          endFrequency: 2900,
          q: 3.0,
          gain: mech * 0.4,
          env: { attack: 0.006, decay: 0.06, sustain: 0.3, release: 0.06 },
        });
        playClick(ctx, voice.input, { when: t0 + 0.13, frequency: 3000, gain: mech * 0.85 });
        playTone(ctx, voice.input, {
          when: t0 + 0.13,
          duration: 0.06,
          frequency: 240 / heft,
          endFrequency: 110,
          type: 'square',
          gain: mech * 0.4,
          filter: 'lowpass',
          filterFrequency: 900,
          env: { attack: 0.0008, decay: 0.035, sustain: 0.04, release: 0.06 },
        });
        break;
      }
    }

    voice.endsAt = t0 + 0.6;
  }

  playExplosion(position: Vec3, radius: number): void {
    const g = this.graph;
    if (!g) return;

    const d = this.distanceTo(position);
    if (d > PERCEPTION.explosionRadius * 1.5) return;

    const scale = clamp(radius / 6, 0.5, 3);
    const duration = 1.6 + scale * 0.9;
    const voice = this.acquireVoice(g, PRIORITY.explosion, d, duration);
    if (!voice) return;

    this.route(g, voice, position, {
      bus: 'sfx',
      // Explosions are already low-frequency, so the distance lowpass is opened up
      // relative to gunfire — a far blast still reaches you, just without the debris.
      lowpassHz: distanceCutoff(d * 0.55),
      refDistance: 10,
      maxDistance: PERCEPTION.explosionRadius,
      send: distanceSend(d, this.ambience.reverbMix) * 1.4,
      sendDelay: slapbackDelay(d),
    });

    const ctx = g.ctx;
    const t0 = ctx.currentTime + Math.min(d / SPEED_OF_SOUND, MAX_PROPAGATION_DELAY);

    // Sub: the pressure wave. Sweeping down rather than sitting still is what makes
    // it feel like something expanded rather than a bass note being played.
    playTone(ctx, voice.input, {
      when: t0,
      duration: 0.5 * scale,
      frequency: 110 * scale,
      endFrequency: 26,
      type: 'sine',
      gain: 1.0,
      env: { attack: 0.004, decay: 0.35 * scale, sustain: 0.15, release: 0.7 * scale },
    });

    // Blast: broadband, sweeping dark as the fireball cools.
    playNoiseBurst(ctx, voice.input, {
      when: t0,
      duration: 0.4 * scale,
      kind: 'brown',
      filter: 'lowpass',
      frequency: 3200,
      endFrequency: 220,
      q: 0.8,
      gain: 0.9,
      env: { attack: 0.002, decay: 0.2 * scale, sustain: 0.2, release: 0.6 * scale },
    });

    // Crack: the sharp front, mostly lost with distance.
    playNoiseBurst(ctx, voice.input, {
      when: t0,
      duration: 0.05,
      filter: 'highpass',
      frequency: 1800,
      q: 0.7,
      gain: 0.7 / (1 + (d / 30) * (d / 30)),
      env: { attack: 0.0004, decay: 0.03, sustain: 0, release: 0.05 },
    });

    // Debris: a handful of scattered ticks, capped so a cluster strike cannot turn
    // into hundreds of nodes.
    const debris = Math.min(6, Math.round(3 + scale * 2));
    for (let i = 0; i < debris; i++) {
      playClick(ctx, voice.input, {
        when: t0 + 0.12 + Math.random() * 0.8 * scale,
        frequency: 1400 + Math.random() * 2600,
        gain: 0.14,
        duration: 0.008,
      });
    }

    // Duck the sfx bus so the blast has room. Applied after the user's slider so it
    // restores to whatever they set, not to 1.
    const duck = clamp(1 - 0.35 * scale * (1 - clamp(d / 60, 0, 0.8)), 0.35, 1);
    g.sfxDuck.gain.cancelScheduledValues(t0);
    g.sfxDuck.gain.setTargetAtTime(duck, t0, 0.03);
    g.sfxDuck.gain.setTargetAtTime(1, t0 + 0.25 * scale, 0.35);

    voice.endsAt = t0 + duration + 0.4;
  }

  /** Near-miss supersonic crack. Deliberately dry — it happens at your ear. */
  playWhizzBy(position: Vec3): void {
    const g = this.graph;
    if (!g) return;

    const d = this.distanceTo(position);
    if (d > 25) return;

    const voice = this.acquireVoice(g, PRIORITY.whizz, d, 0.2);
    if (!voice) return;

    this.route(g, voice, position, {
      bus: 'sfx',
      refDistance: 1,
      maxDistance: 30,
      send: 0.05,
    });

    const ctx = g.ctx;
    const t0 = ctx.currentTime;
    // A downward sweep, not a static band: the Doppler shift as the round passes is
    // the entire character of the sound.
    playNoiseBurst(ctx, voice.input, {
      when: t0,
      duration: 0.07,
      filter: 'bandpass',
      frequency: 4200 + Math.random() * 1200,
      endFrequency: 700,
      q: 4.5,
      gain: 0.6,
      env: { attack: 0.004, decay: 0.03, sustain: 0.35, release: 0.05 },
    });
    playNoiseBurst(ctx, voice.input, {
      when: t0 + 0.01,
      duration: 0.03,
      filter: 'highpass',
      frequency: 3000,
      q: 0.7,
      gain: 0.3,
      env: { attack: 0.0004, decay: 0.02, sustain: 0, release: 0.03 },
    });

    voice.endsAt = t0 + 0.3;
  }

  playHitmarker(lethal: boolean): void {
    const g = this.graph;
    if (!g) return;
    const voice = this.acquireVoice(g, PRIORITY.hitmarker, 0, 0.35);
    if (!voice) return;

    // Never panned and never reverbed: this is feedback, not an event in the world.
    this.route(g, voice, null, { bus: 'ui' });

    const ctx = g.ctx;
    const t0 = ctx.currentTime;

    playClick(ctx, voice.input, { when: t0, frequency: lethal ? 4200 : 3000, gain: 0.5 });
    playTone(ctx, voice.input, {
      when: t0,
      duration: 0.035,
      frequency: lethal ? 1500 : 1050,
      endFrequency: lethal ? 1900 : 900,
      type: 'square',
      gain: 0.3,
      env: { attack: 0.0006, decay: 0.02, sustain: 0.1, release: 0.04 },
    });
    if (lethal) {
      // The kill confirm is a second, higher note: an interval the ear reads as
      // resolution, so a kill is distinguishable from a hit without looking.
      playTone(ctx, voice.input, {
        when: t0 + 0.045,
        duration: 0.09,
        frequency: 2400,
        type: 'triangle',
        gain: 0.28,
        env: { attack: 0.001, decay: 0.06, sustain: 0.2, release: 0.1 },
      });
    }

    voice.endsAt = t0 + 0.4;
  }

  playUi(kind: UiSoundKind): void {
    const g = this.graph;
    if (!g) return;
    const voice = this.acquireVoice(g, PRIORITY.ui, 0, 0.8);
    if (!voice) return;
    this.route(g, voice, null, { bus: 'ui' });

    const ctx = g.ctx;
    const t0 = ctx.currentTime;
    let end = t0 + 0.3;

    switch (kind) {
      case 'hover': {
        playTone(ctx, voice.input, { when: t0, duration: 0.03, frequency: 1400, type: 'sine', gain: 0.12, env: { attack: 0.002, decay: 0.02, sustain: 0.05, release: 0.04 } });
        break;
      }
      case 'click': {
        playClick(ctx, voice.input, { when: t0, frequency: 3600, gain: 0.3 });
        playTone(ctx, voice.input, { when: t0, duration: 0.05, frequency: 900, endFrequency: 1600, type: 'triangle', gain: 0.2, env: { attack: 0.001, decay: 0.03, sustain: 0.1, release: 0.05 } });
        break;
      }
      case 'back': {
        // Inverted contour of 'click'. Direction of pitch is how a menu tells you
        // whether you went forward or backward without any other cue.
        playTone(ctx, voice.input, { when: t0, duration: 0.06, frequency: 1500, endFrequency: 700, type: 'triangle', gain: 0.2, env: { attack: 0.001, decay: 0.04, sustain: 0.1, release: 0.06 } });
        break;
      }
      case 'error': {
        playTone(ctx, voice.input, { when: t0, duration: 0.09, frequency: 220, type: 'square', gain: 0.22, filter: 'lowpass', filterFrequency: 1400, env: { attack: 0.002, decay: 0.05, sustain: 0.3, release: 0.07 } });
        playTone(ctx, voice.input, { when: t0 + 0.1, duration: 0.11, frequency: 165, type: 'square', gain: 0.22, filter: 'lowpass', filterFrequency: 1200, env: { attack: 0.002, decay: 0.06, sustain: 0.3, release: 0.09 } });
        end = t0 + 0.4;
        break;
      }
      case 'equip': {
        playNoiseBurst(ctx, voice.input, { when: t0, duration: 0.07, filter: 'bandpass', frequency: 2200, endFrequency: 1100, q: 2.2, gain: 0.28, env: { attack: 0.002, decay: 0.04, sustain: 0.1, release: 0.06 } });
        playClick(ctx, voice.input, { when: t0 + 0.06, frequency: 2800, gain: 0.35 });
        break;
      }
      case 'levelup': {
        const notes = [72, 76, 79, 84];
        for (let i = 0; i < notes.length; i++) {
          playTone(ctx, voice.input, {
            when: t0 + i * 0.075,
            duration: i === notes.length - 1 ? 0.4 : 0.09,
            frequency: midiToFreq(notes[i]),
            type: 'triangle',
            gain: 0.2,
            env: { attack: 0.003, decay: 0.08, sustain: 0.4, release: 0.35 },
          });
        }
        end = t0 + 0.9;
        break;
      }
    }

    voice.endsAt = end;
  }

  /**
   * A radio stinger, not speech.
   *
   * SpeechSynthesis is deliberately not used: voices vary wildly per platform, it
   * is unavailable in many embedded contexts, and a TTS voice reading "enemy UAV
   * above" sounds like a screen reader rather than a squad. Instead each line is
   * hashed into a short tone sequence behind a comms filter, so a given line always
   * produces the same recognisable motif and different lines are distinguishable.
   */
  playAnnouncer(line: string): void {
    const g = this.graph;
    if (!g) return;
    const voice = this.acquireVoice(g, PRIORITY.announcer, 0, 1.2);
    if (!voice) return;

    const ctx = g.ctx;

    // Comms channel: band-limited to roughly a radio's passband and soft-clipped.
    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 420;
    highpass.Q.value = 0.8;
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 2900;
    lowpass.Q.value = 0.9;
    const shaper = ctx.createWaveShaper();
    shaper.curve = g.radioCurve;
    shaper.oversample = '2x';

    voice.input.connect(highpass);
    highpass.connect(lowpass);
    lowpass.connect(shaper);
    shaper.connect(g.buses.voice);
    voice.extra.push(highpass, lowpass, shaper);

    const hash = hashString(line);
    const t0 = ctx.currentTime + 0.01;

    // Squelch open.
    playClick(ctx, voice.input, { when: t0, frequency: 1800, gain: 0.45, duration: 0.008 });
    playNoiseBurst(ctx, voice.input, {
      when: t0,
      duration: 0.05,
      filter: 'bandpass',
      frequency: 1600,
      q: 0.8,
      gain: 0.25,
      env: { attack: 0.002, decay: 0.03, sustain: 0.15, release: 0.05 },
    });

    // Pentatonic so any hash produces something that sounds intentional.
    const scale = [0, 3, 5, 7, 10, 12];
    const count = 3 + (hash % 3);
    let cursor = t0 + 0.07;
    for (let i = 0; i < count; i++) {
      const bits = (hash >>> (i * 5)) & 0x1f;
      const note = 62 + scale[bits % scale.length] + ((bits & 8) !== 0 ? 12 : 0);
      const duration = 0.06 + ((bits >>> 2) & 3) * 0.02;
      playTone(ctx, voice.input, {
        when: cursor,
        duration,
        frequency: midiToFreq(note),
        type: 'square',
        gain: 0.2,
        env: { attack: 0.004, decay: duration * 0.5, sustain: 0.6, release: 0.04 },
      });
      cursor += duration + 0.018;
    }

    // Squelch close — the burst of static on release is what sells "transmission".
    playNoiseBurst(ctx, voice.input, {
      when: cursor + 0.02,
      duration: 0.045,
      filter: 'bandpass',
      frequency: 1900,
      q: 0.7,
      gain: 0.2,
      env: { attack: 0.001, decay: 0.02, sustain: 0.1, release: 0.05 },
    });
    playClick(ctx, voice.input, { when: cursor + 0.05, frequency: 1400, gain: 0.3, duration: 0.01 });

    voice.endsAt = cursor + 0.35;
  }

  // -- music ----------------------------------------------------------------

  playMusic(kind: MusicKind): void {
    const g = this.graph;
    if (!g) {
      this.pendingMusic = kind;
      return;
    }
    this.startMusic(g, kind);
  }

  private startMusic(g: AudioGraph, kind: MusicKind): void {
    this.stopMusic(0.3);

    const gain = g.ctx.createGain();
    gain.gain.value = 0;
    gain.connect(g.buses.music);
    gain.gain.setTargetAtTime(1, g.ctx.currentTime, 0.4);

    const shape: Record<MusicKind, { stepSeconds: number; steps: number; loop: boolean }> = {
      menu: { stepSeconds: 1.1, steps: 8, loop: true },
      tension: { stepSeconds: 0.34, steps: 16, loop: true },
      victory: { stepSeconds: 0.18, steps: 10, loop: false },
      defeat: { stepSeconds: 0.5, steps: 8, loop: false },
    };
    const cfg = shape[kind];

    this.music = {
      kind,
      gain,
      nextStepTime: g.ctx.currentTime + 0.05,
      step: 0,
      stepSeconds: cfg.stepSeconds,
      steps: cfg.steps,
      loop: cfg.loop,
    };
  }

  stopMusic(fadeSeconds = 1.2): void {
    this.pendingMusic = null;
    const music = this.music;
    const g = this.graph;
    this.music = null;
    if (!music || !g) return;

    const now = g.ctx.currentTime;
    const fade = Math.max(fadeSeconds, 0.02);
    music.gain.gain.cancelScheduledValues(now);
    music.gain.gain.setTargetAtTime(0, now, fade / 3);

    // The music gain is not a pooled voice, so it gets its own disposal: park it in
    // the pool as a silent placeholder whose sweep will disconnect it.
    this.voices.push({
      input: music.gain,
      extra: [],
      endsAt: now + fade + 0.2,
      priority: 0,
      distance: 0,
      // Marked stealing so a fading-out music bus can never crowd out gameplay.
      stealing: true,
    });
  }

  /**
   * Schedules music a fixed horizon ahead.
   *
   * Notes are written straight into the WebAudio clock rather than triggered from
   * rAF, so tempo is immune to frame drops. The step guard bounds work if
   * `currentTime` jumps (tab restore), which would otherwise schedule thousands of
   * notes in one call.
   */
  private pumpMusic(g: AudioGraph): void {
    const music = this.music;
    if (!music) return;

    const horizon = g.ctx.currentTime + MUSIC_LOOKAHEAD;
    let guard = 0;
    while (music.nextStepTime < horizon && guard < 16) {
      guard++;
      this.scheduleMusicStep(g, music, music.nextStepTime);
      music.nextStepTime += music.stepSeconds;
      music.step++;
      if (music.step >= music.steps) {
        if (music.loop) {
          music.step = 0;
        } else {
          this.stopMusic(1.6);
          return;
        }
      }
    }
    // Clock jumped far ahead (tab was backgrounded): resync instead of catching up.
    if (music.nextStepTime < g.ctx.currentTime) {
      music.nextStepTime = g.ctx.currentTime + 0.02;
    }
  }

  private scheduleMusicStep(g: AudioGraph, music: MusicState, when: number): void {
    const ctx = g.ctx;
    const out = music.gain;
    const step = music.step;

    switch (music.kind) {
      case 'menu': {
        // Slow minor pad. Two-step chords so the harmony moves half as fast as the
        // melody, which is what keeps a loop from feeling like a loop.
        const chords = [
          [45, 52, 57, 64],
          [43, 50, 55, 62],
          [41, 48, 53, 60],
          [40, 47, 55, 59],
        ];
        if (step % 2 === 0) {
          const chord = chords[(step >> 1) % chords.length];
          for (const note of chord) {
            playTone(ctx, out, {
              when,
              duration: music.stepSeconds * 1.9,
              frequency: midiToFreq(note),
              type: 'sawtooth',
              gain: 0.05,
              detune: (Math.random() * 2 - 1) * 9,
              filter: 'lowpass',
              filterFrequency: 720,
              filterEndFrequency: 360,
              q: 1.4,
              env: { attack: 0.5, decay: 0.9, sustain: 0.7, release: 1.1 },
            });
          }
        } else {
          const bells = [76, 79, 74, 81, 76, 72, 79, 74];
          playTone(ctx, out, {
            when,
            duration: 0.45,
            frequency: midiToFreq(bells[step % bells.length]),
            type: 'sine',
            gain: 0.05,
            env: { attack: 0.005, decay: 0.3, sustain: 0.05, release: 0.5 },
          });
        }
        break;
      }
      case 'tension': {
        playTone(ctx, out, {
          when,
          duration: 0.26,
          frequency: midiToFreq(step % 4 === 0 ? 33 : 31),
          type: 'triangle',
          gain: 0.09,
          filter: 'lowpass',
          filterFrequency: 240,
          env: { attack: 0.004, decay: 0.12, sustain: 0.25, release: 0.2 },
        });
        if (step % 8 === 4) {
          playClick(ctx, out, { when, frequency: 5200, gain: 0.05 });
        }
        if (step === 0) {
          // One long swell per bar, riding under the pulse.
          playNoiseBurst(ctx, out, {
            when,
            duration: music.stepSeconds * 12,
            kind: 'pink',
            filter: 'bandpass',
            frequency: 380,
            endFrequency: 1500,
            q: 1.6,
            gain: 0.05,
            env: { attack: music.stepSeconds * 9, decay: 0.5, sustain: 0.8, release: music.stepSeconds * 3 },
          });
        }
        break;
      }
      case 'victory': {
        const notes = [60, 64, 67, 72, 67, 72, 76, 79, 84, 79];
        playTone(ctx, out, {
          when,
          duration: 0.16,
          frequency: midiToFreq(notes[step % notes.length]),
          type: 'square',
          gain: 0.08,
          filter: 'lowpass',
          filterFrequency: 3200,
          env: { attack: 0.004, decay: 0.09, sustain: 0.35, release: 0.12 },
        });
        if (step === music.steps - 1) {
          for (const note of [60, 67, 72, 76]) {
            playTone(ctx, out, {
              when: when + 0.18,
              duration: 2.2,
              frequency: midiToFreq(note),
              type: 'sawtooth',
              gain: 0.06,
              detune: (Math.random() * 2 - 1) * 8,
              filter: 'lowpass',
              filterFrequency: 2400,
              filterEndFrequency: 900,
              env: { attack: 0.02, decay: 1.0, sustain: 0.5, release: 1.4 },
            });
          }
        }
        break;
      }
      case 'defeat': {
        const notes = [55, 53, 51, 48, 46, 43, 41, 36];
        playTone(ctx, out, {
          when,
          duration: 0.85,
          frequency: midiToFreq(notes[step % notes.length]),
          type: 'sawtooth',
          gain: 0.08,
          filter: 'lowpass',
          filterFrequency: 620,
          filterEndFrequency: 260,
          q: 1.2,
          env: { attack: 0.03, decay: 0.5, sustain: 0.35, release: 0.6 },
        });
        if (step === 0) {
          playTone(ctx, out, {
            when,
            duration: 3.4,
            frequency: midiToFreq(24),
            type: 'sine',
            gain: 0.07,
            env: { attack: 0.4, decay: 1.5, sustain: 0.6, release: 1.6 },
          });
        }
        break;
      }
    }
  }
}

/** Exported for tests and for tools that want to reason about the pool size. */
export const MAX_AUDIO_VOICES = MAX_VOICES;

/** Exported so the renderer can visualise the same falloff the mixer hears. */
export { distanceCutoff as audioDistanceCutoff };
