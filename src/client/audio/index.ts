/**
 * Public surface of the procedural audio system.
 *
 * The rest of the client should import from here rather than reaching into
 * ./audio-engine.js or ./synth.js, so the internal split between "game meaning"
 * and "raw synthesis" stays free to move.
 */

export { AudioEngine, MAX_AUDIO_VOICES, audioDistanceCutoff } from './audio-engine.js';
export type {
  Ambience,
  BusName,
  MusicKind,
  ReloadStage,
  UiSoundKind,
} from './audio-engine.js';

export {
  applyEnvelope,
  createImpulseResponse,
  createNoiseBuffer,
  envelopeTail,
  getSharedNoise,
  playClick,
  playGunshot,
  playNoiseBurst,
  playTone,
} from './synth.js';
export type {
  BasicOscillatorType,
  ClickOptions,
  EnvelopeSpec,
  GunshotSpec,
  NoiseBurstOptions,
  NoiseKind,
  ToneOptions,
} from './synth.js';

import { AudioEngine } from './audio-engine.js';

let singleton: AudioEngine | null = null;

/**
 * The engine every system shares.
 *
 * Lazy rather than eagerly constructed at module scope so that importing anything
 * from this barrel — in a test, in a headless server build, in a tool — costs
 * nothing. The engine itself still touches no Web Audio API until `resume()`.
 */
export function getAudioEngine(): AudioEngine {
  if (!singleton) singleton = new AudioEngine();
  return singleton;
}

/** Tears down the shared engine. Primarily for tests and hot-reload. */
export function disposeAudioEngine(): void {
  if (!singleton) return;
  singleton.dispose();
  singleton = null;
}
