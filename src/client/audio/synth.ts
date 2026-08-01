/**
 * Procedural synthesis primitives.
 *
 * Everything the game hears is built here from oscillators and noise. There are no
 * sample assets anywhere in the project, which is a deliberate product constraint:
 * the whole game ships as code, so audio has to be describable as parameters.
 *
 * This module knows nothing about weapons, maps or players. It takes numbers and
 * produces sound. Game meaning lives one layer up in audio-engine.ts.
 *
 * Two invariants hold for every helper here:
 *   1. Nothing throws. A missing/closed context must degrade to silence, never to
 *      an exception in the middle of a frame.
 *   2. Every node created is disconnected once its source ends. A 10-minute match
 *      fires tens of thousands of one-shots; leaking even a few nodes per shot
 *      kills the tab.
 */

export type NoiseKind = 'white' | 'pink' | 'brown';

/** Oscillator types that need no PeriodicWave. 'custom' throws when assigned. */
export type BasicOscillatorType = 'sine' | 'square' | 'sawtooth' | 'triangle';

/**
 * Web Audio refuses to ramp a param exponentially to exactly zero, so envelopes
 * decay to this instead and are hard-zeroed afterwards.
 */
const SILENCE = 1e-4;

/** Scheduling two automation events at an identical timestamp is undefined-ish. */
const MIN_TIME = 1e-3;

/** Length of the shared noise beds. Long enough that loops are not audible. */
const SHARED_NOISE_SECONDS = 2;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Filters above Nyquist misbehave differently per browser; keep them legal. */
function safeFreq(ctx: BaseAudioContext, hz: number): number {
  return clamp(hz, 10, Math.min(20000, ctx.sampleRate * 0.5 - 100));
}

// ---------------------------------------------------------------------------
// Buffers
// ---------------------------------------------------------------------------

/**
 * Fills a mono buffer with noise.
 *
 * Mono rather than stereo because these beds are fed into PannerNodes, and a
 * stereo source would fight the spatialisation for control of the image.
 */
export function createNoiseBuffer(
  ctx: BaseAudioContext,
  seconds: number,
  kind: 'white' | 'pink' | 'brown',
): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(sampleRate * Math.max(seconds, 1 / sampleRate)));
  const buffer = ctx.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);

  switch (kind) {
    case 'white': {
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
      break;
    }
    case 'pink': {
      // Paul Kellet's refined filter bank: -3 dB/octave to within a fraction of a
      // dB across the audible band, at a handful of multiply-adds per sample.
      let b0 = 0;
      let b1 = 0;
      let b2 = 0;
      let b3 = 0;
      let b4 = 0;
      let b5 = 0;
      let b6 = 0;
      for (let i = 0; i < length; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.016898;
        data[i] = clamp((b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11, -1, 1);
        b6 = w * 0.115926;
      }
      break;
    }
    case 'brown': {
      // Leaky integration of white noise: -6 dB/octave. This is the rumble bed for
      // explosions, wind and gunshot tails.
      let last = 0;
      for (let i = 0; i < length; i++) {
        const w = Math.random() * 2 - 1;
        last = (last + 0.02 * w) / 1.02;
        data[i] = clamp(last * 3.5, -1, 1);
      }
      break;
    }
  }

  return buffer;
}

/**
 * Synthesised room response for a ConvolverNode.
 *
 * `decay` is the exponent on the amplitude envelope, not a time: higher values
 * collapse the tail faster, which is what separates a tiled interior from a canyon
 * even when both are given the same `seconds`.
 */
export function createImpulseResponse(
  ctx: BaseAudioContext,
  seconds: number,
  decay: number,
  reverse = false,
): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(sampleRate * clamp(seconds, 0.02, 12)));
  const ir = ctx.createBuffer(2, length, sampleRate);
  const power = Math.max(decay, 0.1);

  for (let channel = 0; channel < 2; channel++) {
    const data = ir.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      const n = reverse ? length - i : i;
      // Uncorrelated noise per channel is what gives the tail its stereo width;
      // sharing one channel would collapse the reverb to the centre of the head.
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - n / length, power);
    }
  }
  return ir;
}

const NOISE_CACHE = new WeakMap<BaseAudioContext, Map<NoiseKind, AudioBuffer>>();

/**
 * Cached noise bed, generated once per context per kind.
 *
 * Generating a fresh buffer per shot would allocate and fill a multi-megabyte
 * Float32Array twenty times a second under full-auto fire. Voices instead start at
 * a random offset into one shared, looping bed, which is indistinguishable by ear.
 */
export function getSharedNoise(ctx: BaseAudioContext, kind: NoiseKind): AudioBuffer {
  let perContext = NOISE_CACHE.get(ctx);
  if (!perContext) {
    perContext = new Map<NoiseKind, AudioBuffer>();
    NOISE_CACHE.set(ctx, perContext);
  }
  let buffer = perContext.get(kind);
  if (!buffer) {
    buffer = createNoiseBuffer(ctx, SHARED_NOISE_SECONDS, kind);
    perContext.set(kind, buffer);
  }
  return buffer;
}

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

export interface EnvelopeSpec {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  peak?: number;
}

/**
 * Schedules an ADSR on a param.
 *
 * `duration` is the length of the note *before* the release, so the total time the
 * param is non-silent is `duration + release`. Callers stop their source at that
 * point; see `envelopeTail`.
 */
export function applyEnvelope(
  param: AudioParam,
  t0: number,
  env: EnvelopeSpec,
  duration: number,
): void {
  const peak = Math.max(env.peak ?? 1, SILENCE);
  const attack = Math.max(env.attack, MIN_TIME * 0.2);
  const decay = Math.max(env.decay, MIN_TIME * 0.2);
  const release = Math.max(env.release, MIN_TIME);
  const sustain = Math.max(clamp(env.sustain, 0, 1) * peak, SILENCE);

  const tAttack = t0 + attack;
  const tDecay = tAttack + decay;
  const tSustainEnd = Math.max(tDecay, t0 + Math.max(duration, attack));
  const tRelease = tSustainEnd + release;

  param.cancelScheduledValues(t0);
  param.setValueAtTime(0, t0);
  param.linearRampToValueAtTime(peak, tAttack);
  param.exponentialRampToValueAtTime(sustain, tDecay);
  if (tSustainEnd > tDecay) param.setValueAtTime(sustain, tSustainEnd);
  param.exponentialRampToValueAtTime(SILENCE, tRelease);
  // Exponential ramps can only approach zero; pin it so an idling param does not
  // leave a DC-ish trickle running through the graph.
  param.setValueAtTime(0, tRelease);
}

/** Total seconds a note occupies, given its body length. */
export function envelopeTail(env: EnvelopeSpec, duration: number): number {
  return Math.max(duration, env.attack) + Math.max(env.release, MIN_TIME);
}

function resolveEnvelope(partial: Partial<EnvelopeSpec> | undefined, duration: number): EnvelopeSpec {
  return {
    attack: partial?.attack ?? 0.002,
    decay: partial?.decay ?? duration * 0.5,
    sustain: partial?.sustain ?? 0.15,
    release: partial?.release ?? Math.max(0.03, duration * 0.4),
    peak: partial?.peak ?? 1,
  };
}

/**
 * Disconnects a one-shot's private node chain once its source finishes.
 *
 * This is the single most important line of the audio system: without it a match
 * accumulates thousands of live nodes and the tab stops rendering.
 */
function autoRelease(source: AudioScheduledSourceNode, nodes: AudioNode[]): void {
  source.onended = (): void => {
    for (const node of nodes) {
      try {
        node.disconnect();
      } catch {
        // Already torn down by a dispose() or a stolen voice. Nothing to do.
      }
    }
  };
}

// ---------------------------------------------------------------------------
// One-shot generators
// ---------------------------------------------------------------------------

export interface NoiseBurstOptions {
  /** Context time to start at. Defaults to now. */
  when?: number;
  /** Length of the burst before its release, seconds. */
  duration: number;
  gain?: number;
  kind?: NoiseKind;
  filter?: BiquadFilterType;
  frequency?: number;
  /** Sweeps the filter to this cutoff across the burst. */
  endFrequency?: number;
  q?: number;
  playbackRate?: number;
  env?: Partial<EnvelopeSpec>;
}

/** Filtered noise with an envelope — impacts, cracks, wind, debris, static. */
export function playNoiseBurst(
  ctx: BaseAudioContext,
  dest: AudioNode,
  opts: NoiseBurstOptions,
): void {
  const t0 = opts.when ?? ctx.currentTime;
  const duration = Math.max(opts.duration, MIN_TIME);
  const env = resolveEnvelope(opts.env, duration);
  env.peak = (env.peak ?? 1) * Math.max(opts.gain ?? 1, 0);
  const total = envelopeTail(env, duration);

  const buffer = getSharedNoise(ctx, opts.kind ?? 'white');
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  // Looping lets a burst outlast the shared bed without a dedicated buffer.
  source.loop = true;
  source.playbackRate.value = clamp(opts.playbackRate ?? 1, 0.05, 8);

  const amp = ctx.createGain();
  amp.gain.value = 0;
  applyEnvelope(amp.gain, t0, env, duration);

  const owned: AudioNode[] = [source, amp];
  let node: AudioNode = source;

  if (opts.filter) {
    const biquad = ctx.createBiquadFilter();
    biquad.type = opts.filter;
    const start = safeFreq(ctx, opts.frequency ?? 1000);
    biquad.frequency.setValueAtTime(start, t0);
    if (opts.endFrequency !== undefined) {
      biquad.frequency.exponentialRampToValueAtTime(safeFreq(ctx, opts.endFrequency), t0 + total);
    }
    biquad.Q.value = clamp(opts.q ?? 1, 0.0001, 40);
    node.connect(biquad);
    node = biquad;
    owned.push(biquad);
  }

  node.connect(amp);
  amp.connect(dest);

  // A random read offset stops repeated shots from phase-locking into a buzz.
  const offset = Math.random() * Math.max(0.01, buffer.duration - 0.05);
  source.start(t0, offset);
  source.stop(t0 + total + 0.02);
  autoRelease(source, owned);
}

export interface ToneOptions {
  when?: number;
  duration: number;
  frequency: number;
  /** Sweeps pitch to this value across the note — the core of a gunshot's body. */
  endFrequency?: number;
  type?: BasicOscillatorType;
  gain?: number;
  detune?: number;
  filter?: BiquadFilterType;
  filterFrequency?: number;
  filterEndFrequency?: number;
  q?: number;
  env?: Partial<EnvelopeSpec>;
}

/** Oscillator with pitch and amplitude envelopes. */
export function playTone(ctx: BaseAudioContext, dest: AudioNode, opts: ToneOptions): void {
  const t0 = opts.when ?? ctx.currentTime;
  const duration = Math.max(opts.duration, MIN_TIME);
  const env = resolveEnvelope(opts.env, duration);
  env.peak = (env.peak ?? 1) * Math.max(opts.gain ?? 1, 0);
  const total = envelopeTail(env, duration);

  const osc = ctx.createOscillator();
  osc.type = opts.type ?? 'sine';
  osc.detune.value = opts.detune ?? 0;
  const startFreq = safeFreq(ctx, opts.frequency);
  osc.frequency.setValueAtTime(startFreq, t0);
  if (opts.endFrequency !== undefined) {
    // Exponential rather than linear: pitch is perceived logarithmically, and a
    // linear sweep on a gunshot body sounds like a slide whistle.
    osc.frequency.exponentialRampToValueAtTime(safeFreq(ctx, opts.endFrequency), t0 + total);
  }

  const amp = ctx.createGain();
  amp.gain.value = 0;
  applyEnvelope(amp.gain, t0, env, duration);

  const owned: AudioNode[] = [osc, amp];
  let node: AudioNode = osc;

  if (opts.filter) {
    const biquad = ctx.createBiquadFilter();
    biquad.type = opts.filter;
    biquad.frequency.setValueAtTime(safeFreq(ctx, opts.filterFrequency ?? 2000), t0);
    if (opts.filterEndFrequency !== undefined) {
      biquad.frequency.exponentialRampToValueAtTime(
        safeFreq(ctx, opts.filterEndFrequency),
        t0 + total,
      );
    }
    biquad.Q.value = clamp(opts.q ?? 1, 0.0001, 40);
    node.connect(biquad);
    node = biquad;
    owned.push(biquad);
  }

  node.connect(amp);
  amp.connect(dest);

  osc.start(t0);
  osc.stop(t0 + total + 0.02);
  autoRelease(osc, owned);
}

export interface ClickOptions {
  when?: number;
  gain?: number;
  /** Highpass corner. Higher reads as smaller/tighter metal. */
  frequency?: number;
  duration?: number;
  q?: number;
  kind?: NoiseKind;
}

/**
 * A mechanical transient: bolts, mag catches, safeties, UI ticks.
 *
 * Deliberately capped in length — anything past ~30 ms stops reading as a click
 * and starts reading as a whoosh, which is the usual way mechanical layers get
 * accidentally ruined.
 */
export function playClick(ctx: BaseAudioContext, dest: AudioNode, opts: ClickOptions = {}): void {
  const duration = clamp(opts.duration ?? 0.006, 0.001, 0.03);
  playNoiseBurst(ctx, dest, {
    when: opts.when,
    duration,
    kind: opts.kind ?? 'white',
    filter: 'highpass',
    frequency: opts.frequency ?? 2400,
    q: opts.q ?? 0.8,
    gain: opts.gain ?? 1,
    env: { attack: 0.0004, decay: duration, sustain: 0, release: 0.012 },
  });
}

// ---------------------------------------------------------------------------
// Gunshots
// ---------------------------------------------------------------------------

export interface GunshotSpec {
  /** Centre frequency of the chest-thump, Hz. */
  bodyFreq: number;
  /** Length of the supersonic snap, seconds. Defines perceived sharpness. */
  crackDuration: number;
  /** Low-end weight, 0..1. */
  boom: number;
  /** Mechanical action noise, 0..1. */
  mech: number;
  /** Length of the excitation fed into the environment tail, seconds. */
  tail: number;
  suppressed: boolean;

  when?: number;
  gain?: number;
  /** 0 at the muzzle, 1 at the edge of audibility. Removes the crack with range. */
  distanceFactor?: number;
  /** Per-shot pitch jitter, 0..1, so full-auto does not sound like a loop. */
  variation?: number;
  /**
   * Where the environment-tail layer goes. Null skips it entirely, which is how
   * sustained automatic fire is kept inside its node budget.
   */
  tailDest?: AudioNode | null;
}

/**
 * The three-layer gunshot.
 *
 * Real gunfire is not one sound, and modelling it as one is why synthesised guns
 * usually sound like a toy. It is a supersonic CRACK from the projectile, a BODY
 * from the muzzle blast expanding, and a MECH layer from the action cycling —
 * three events with different spectra, different lengths and different distance
 * behaviour. Every WeaponDef.audio field maps onto exactly one of them, so
 * changing `boom` or `crackDuration` in the weapon table changes the gun's
 * character rather than just its volume.
 *
 * @returns total seconds this shot occupies, for voice-lifetime bookkeeping.
 */
export function playGunshot(ctx: BaseAudioContext, dest: AudioNode, spec: GunshotSpec): number {
  const t0 = spec.when ?? ctx.currentTime;
  const gain = Math.max(spec.gain ?? 1, 0);
  const df = clamp(spec.distanceFactor ?? 0, 0, 1);
  const variation = clamp(spec.variation ?? 0.05, 0, 0.5);
  const jitter = 1 + (Math.random() * 2 - 1) * variation;
  const boom = clamp(spec.boom, 0, 1);
  const mech = clamp(spec.mech, 0, 1);
  const bodyFreq = clamp(spec.bodyFreq * jitter, 30, 4000);
  const crackDuration = clamp(spec.crackDuration, 0.003, 0.25);

  // --- 1. CRACK ------------------------------------------------------------
  if (spec.suppressed) {
    // A suppressor does not "quieten" the shot so much as delete its high end: the
    // gas is bled off subsonically, so the snap is replaced by a dull lowpassed
    // thump with no edge at all.
    playNoiseBurst(ctx, dest, {
      when: t0,
      duration: Math.max(crackDuration * 2.5, 0.03),
      kind: 'brown',
      filter: 'lowpass',
      frequency: 520 * jitter,
      endFrequency: 180,
      q: 0.9,
      gain: gain * 0.5 * (1 - df * 0.55),
      env: { attack: 0.0012, decay: 0.03, sustain: 0.08, release: 0.06 },
    });
  } else {
    // The crack is almost entirely 2-8 kHz energy, which is exactly what air
    // absorbs first. Falling off as 1/(1+9d²) is what turns a 60 m shot into a
    // thud instead of merely a quieter version of a close one.
    const crackGain = (gain * 1.05) / (1 + df * df * 9);
    playNoiseBurst(ctx, dest, {
      when: t0,
      duration: crackDuration,
      kind: 'white',
      filter: 'highpass',
      frequency: 2600 - df * 1200,
      endFrequency: 1100,
      q: 0.7,
      gain: crackGain,
      env: { attack: 0.0003, decay: crackDuration * 0.8, sustain: 0, release: crackDuration * 1.3 },
    });
    // A narrow band an octave above the crack gives it "edge" without the broadband
    // hiss you get from simply turning the highpass layer up.
    playNoiseBurst(ctx, dest, {
      when: t0,
      duration: crackDuration * 0.6,
      kind: 'white',
      filter: 'bandpass',
      frequency: 5200,
      q: 1.5,
      gain: crackGain * 0.45,
      env: { attack: 0.0002, decay: crackDuration * 0.5, sustain: 0, release: crackDuration },
    });
  }

  // --- 2. BODY -------------------------------------------------------------
  // The muzzle blast: a fast downward pitch sweep (the pressure front expanding
  // and cooling) plus resonant noise at the same centre. `boom` scales both.
  const bodyDuration = 0.06 + boom * 0.16;
  const bodyGain = gain * (0.28 + boom * 0.72) * (spec.suppressed ? 0.6 : 1);

  playTone(ctx, dest, {
    when: t0,
    duration: bodyDuration,
    frequency: bodyFreq * 2.4,
    endFrequency: bodyFreq * 0.45,
    type: 'sawtooth',
    gain: bodyGain,
    filter: 'lowpass',
    filterFrequency: 2200 + boom * 1600,
    filterEndFrequency: 500 + boom * 500,
    q: 0.9,
    env: { attack: 0.0008, decay: bodyDuration * 0.55, sustain: 0.04, release: bodyDuration * 0.9 },
  });

  playNoiseBurst(ctx, dest, {
    when: t0,
    duration: bodyDuration * 1.15,
    kind: 'pink',
    filter: 'bandpass',
    frequency: bodyFreq * 1.6,
    endFrequency: bodyFreq * 0.7,
    q: 1.1,
    gain: bodyGain * 0.7,
    env: { attack: 0.001, decay: bodyDuration * 0.6, sustain: 0.06, release: bodyDuration },
  });

  // Only heavy weapons get a dedicated sub layer; adding it to everything is how
  // an arsenal ends up with twelve guns that all sound like the same cannon.
  if (boom > 0.35) {
    playTone(ctx, dest, {
      when: t0,
      duration: bodyDuration * 1.4,
      frequency: bodyFreq * 0.55,
      endFrequency: bodyFreq * 0.28,
      type: 'sine',
      gain: gain * boom * 0.65,
      env: { attack: 0.002, decay: bodyDuration, sustain: 0.1, release: bodyDuration * 1.2 },
    });
  }

  // --- 3. MECH -------------------------------------------------------------
  // The bolt does not move instantly; the unlock, the carrier hitting the buffer
  // and the return are separate transients spread over ~50 ms. Spacing them is
  // what makes a weapon sound mechanical rather than electronic.
  if (mech > 0.02) {
    playClick(ctx, dest, {
      when: t0 + 0.004,
      frequency: 3200,
      gain: gain * mech * 0.5,
      duration: 0.005,
    });
    playClick(ctx, dest, {
      when: t0 + 0.026 + Math.random() * 0.012,
      frequency: 2000,
      gain: gain * mech * 0.42,
      duration: 0.009,
    });
    playNoiseBurst(ctx, dest, {
      when: t0 + 0.018,
      duration: 0.05,
      kind: 'white',
      filter: 'bandpass',
      frequency: 1500,
      endFrequency: 900,
      q: 3.2,
      gain: gain * mech * 0.22,
      env: { attack: 0.002, decay: 0.03, sustain: 0.05, release: 0.04 },
    });
  }

  // --- 4. TAIL -------------------------------------------------------------
  // Excitation for the environment. It carries the weapon's own tail length while
  // the room's character comes from the convolver this is eventually sent to.
  // A suppressed weapon has almost nothing left to excite the environment with.
  const tail = clamp(spec.tail, 0, 6) * (spec.suppressed ? 0.15 : 1);
  if (spec.tailDest && tail > 0.02) {
    playNoiseBurst(ctx, spec.tailDest, {
      when: t0 + 0.012,
      duration: tail,
      kind: 'brown',
      filter: 'lowpass',
      frequency: 1500 - df * 950,
      endFrequency: 380,
      q: 0.7,
      // Distance inverts the balance: close up you hear the gun, far away you
      // mostly hear what the gun did to the map.
      gain: gain * (0.3 + df * 0.7) * (0.4 + boom * 0.6),
      env: { attack: 0.005, decay: tail * 0.5, sustain: 0.22, release: tail * 0.9 },
    });
  }

  return Math.max(bodyDuration * 2.4, tail * 1.9, crackDuration * 3, 0.3) + 0.05;
}
