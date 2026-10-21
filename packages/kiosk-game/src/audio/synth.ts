/**
 * Web Audio synthesis primitives (all original, no samples): shared noise buffers, a generated
 * courtyard reverb impulse, envelopes, a tanpura pluck with a sweeping jawari resonance, a breathy
 * bansuri voice with vibrato and meend, tabla strokes, temple bells and bird chirps.
 *
 * Every voice cleans itself up: sources stop at a scheduled time and nodes disconnect on `ended`.
 */
import { ArtRandom } from '../art/rand.ts';

/** Context-scoped shared resources. */
export interface SynthKit {
  readonly ctx: BaseAudioContext;
  readonly white: AudioBuffer;
  readonly pink: AudioBuffer;
  readonly brown: AudioBuffer;
  readonly tanpuraWave: PeriodicWave;
  readonly fluteWave: PeriodicWave;
}

/** Create the shared synthesis resources for a context. */
export function createSynthKit(ctx: BaseAudioContext): SynthKit {
  const len = Math.floor(ctx.sampleRate * 2);
  const white = ctx.createBuffer(1, len, ctx.sampleRate);
  const pink = ctx.createBuffer(1, len, ctx.sampleRate);
  const brown = ctx.createBuffer(1, len, ctx.sampleRate);
  const w = white.getChannelData(0);
  const p = pink.getChannelData(0);
  const b = brown.getChannelData(0);
  const rnd = new ArtRandom('noise-buffers');
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  let last = 0;
  for (let i = 0; i < len; i++) {
    const x = rnd.next() * 2 - 1;
    w[i] = x;
    // Paul Kellet's refined pink filter.
    b0 = 0.99886 * b0 + x * 0.0555179;
    b1 = 0.99332 * b1 + x * 0.0750759;
    b2 = 0.969 * b2 + x * 0.153852;
    b3 = 0.8665 * b3 + x * 0.3104856;
    b4 = 0.55 * b4 + x * 0.5329522;
    b5 = -0.7616 * b5 - x * 0.016898;
    p[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + x * 0.5362) * 0.11;
    b6 = x * 0.115926;
    last = (last + 0.02 * x) / 1.02;
    b[i] = last * 3.5;
  }
  // Tanpura: dense harmonic spectrum with gently falling amplitudes.
  const N = 28;
  const re = new Float32Array(N + 1);
  const im = new Float32Array(N + 1);
  for (let n = 1; n <= N; n++) im[n] = 1 / n ** 0.72;
  const tanpuraWave = ctx.createPeriodicWave(re, im);
  // Bansuri: nearly pure with a little 2nd/3rd harmonic.
  const fr = new Float32Array(5);
  const fi = new Float32Array([0, 1, 0.16, 0.06, 0.02]);
  const fluteWave = ctx.createPeriodicWave(fr, fi);
  return { ctx, white, pink, brown, tanpuraWave, fluteWave };
}

/** Generated stereo courtyard reverb impulse (~2.2 s, warm, soft early reflections). */
export function createReverbImpulse(ctx: BaseAudioContext, seconds = 2.2): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  const rnd = new ArtRandom('reverb');
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / ctx.sampleRate;
      const env = Math.exp(-t * 3.1) * (t < 0.012 ? t / 0.012 : 1);
      const x = rnd.next() * 2 - 1;
      lp = lp + (x - lp) * (0.35 - 0.25 * Math.min(1, t / seconds)); // darker tail
      d[i] = lp * env * 0.6;
    }
    // Early reflections from courtyard walls.
    for (const [ms, g] of [
      [11, 0.5],
      [23, 0.32],
      [37, 0.24],
      [53, 0.16],
    ] as const) {
      const at = Math.floor(((ms + ch * 3) / 1000) * ctx.sampleRate);
      if (at < len) d[at] = (d[at] ?? 0) + g;
    }
  }
  return buf;
}

/** Stop and disconnect a set of nodes when `source` ends. */
export function cleanupOnEnd(source: AudioScheduledSourceNode, nodes: readonly AudioNode[]): void {
  source.onended = () => {
    for (const n of nodes) {
      try {
        n.disconnect();
      } catch {
        // already disconnected
      }
    }
  };
}

/** A noise source playing from a random offset. */
export function noiseSource(
  kit: SynthKit,
  kind: 'white' | 'pink' | 'brown',
  loop = false,
): AudioBufferSourceNode {
  const src = kit.ctx.createBufferSource();
  src.buffer = kind === 'white' ? kit.white : kind === 'pink' ? kit.pink : kit.brown;
  src.loop = loop;
  return src;
}

/** Percussive envelope on a gain param: fast attack, exponential decay. */
export function percEnv(
  param: AudioParam,
  t: number,
  peak: number,
  attack: number,
  decay: number,
): void {
  param.cancelScheduledValues(t);
  param.setValueAtTime(0.0001, t);
  param.linearRampToValueAtTime(Math.max(0.0001, peak), t + attack);
  param.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

/** Tanpura string pluck with a sweeping "jawari" resonance (the buzzing shimmer). */
export function tanpuraPluck(
  kit: SynthKit,
  dest: AudioNode,
  t: number,
  freq: number,
  gain: number,
  pan: number,
  duration = 4.2,
): void {
  const { ctx } = kit;
  const osc = ctx.createOscillator();
  osc.setPeriodicWave(kit.tanpuraWave);
  osc.frequency.setValueAtTime(freq, t);
  osc.detune.setValueAtTime(-3, t);
  osc.detune.linearRampToValueAtTime(2, t + duration);
  const jawari = ctx.createBiquadFilter();
  jawari.type = 'peaking';
  jawari.Q.setValueAtTime(5, t);
  jawari.gain.setValueAtTime(9, t);
  jawari.frequency.setValueAtTime(freq * 18, t);
  jawari.frequency.exponentialRampToValueAtTime(freq * 4, t + duration * 0.8);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(4200, t);
  lp.frequency.exponentialRampToValueAtTime(1600, t + duration);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.012);
  g.gain.exponentialRampToValueAtTime(gain * 0.45, t + 0.6);
  g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  const p = ctx.createStereoPanner();
  p.pan.setValueAtTime(pan, t);
  osc.connect(jawari).connect(lp).connect(g).connect(p).connect(dest);
  osc.start(t);
  osc.stop(t + duration + 0.05);
  cleanupOnEnd(osc, [osc, jawari, lp, g, p]);
}

/** Options for one bansuri note. */
export interface FluteNote {
  readonly t: number;
  readonly freq: number;
  readonly duration: number;
  readonly gain: number;
  /** Glide (meend) from this frequency over `glideS`. */
  readonly fromFreq?: number;
  readonly glideS?: number;
  /** Grace note (kan) frequency played briefly before the note. */
  readonly kan?: number;
  readonly pan?: number;
}

/** Breathy bansuri-like note with delayed vibrato, chiff and breath noise. */
export function fluteNote(kit: SynthKit, dest: AudioNode, n: FluteNote): void {
  const { ctx } = kit;
  const { t, duration } = n;
  const osc = ctx.createOscillator();
  osc.setPeriodicWave(kit.fluteWave);
  const f = osc.frequency;
  if (n.kan) {
    f.setValueAtTime(n.kan, t);
    f.setValueAtTime(n.freq, t + 0.05);
  } else if (n.fromFreq && n.glideS) {
    f.setValueAtTime(n.fromFreq, t);
    f.exponentialRampToValueAtTime(n.freq, t + n.glideS);
  } else {
    f.setValueAtTime(n.freq, t);
  }
  // Vibrato grows after the attack (like a real player).
  const vib = ctx.createOscillator();
  vib.frequency.setValueAtTime(5.1, t);
  const vibDepth = ctx.createGain();
  vibDepth.gain.setValueAtTime(0, t);
  vibDepth.gain.linearRampToValueAtTime(n.freq * 0.006, t + Math.min(duration, 0.45));
  vib.connect(vibDepth).connect(osc.frequency);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(Math.min(9000, n.freq * 6), t);
  const g = ctx.createGain();
  const rel = Math.min(0.22, duration * 0.4);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(n.gain, t + 0.08);
  g.gain.setValueAtTime(n.gain * 0.92, t + Math.max(0.09, duration - rel));
  g.gain.exponentialRampToValueAtTime(0.0001, t + duration + 0.05);
  // Breath noise around the note.
  const br = noiseSource(kit, 'white');
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(n.freq * 2.2, t);
  bp.Q.setValueAtTime(1.4, t);
  const bg = ctx.createGain();
  bg.gain.setValueAtTime(0.0001, t);
  bg.gain.linearRampToValueAtTime(n.gain * 0.22, t + 0.03);
  bg.gain.exponentialRampToValueAtTime(n.gain * 0.06, t + 0.18);
  bg.gain.exponentialRampToValueAtTime(0.0001, t + duration + 0.05);
  const p = ctx.createStereoPanner();
  p.pan.setValueAtTime(n.pan ?? 0.1, t);
  osc.connect(lp).connect(g).connect(p);
  br.connect(bp).connect(bg).connect(p);
  p.connect(dest);
  const end = t + duration + 0.1;
  osc.start(t);
  vib.start(t);
  br.start(t, (t * 7.31) % 1.5);
  osc.stop(end);
  vib.stop(end);
  br.stop(end);
  cleanupOnEnd(osc, [osc, vib, vibDepth, lp, g, br, bp, bg, p]);
}

export type TablaStroke = 'dha' | 'dhin' | 'ge' | 'na' | 'ta' | 'tin' | 'ti' | 'ke' | 'tit';

/** Synthesised tabla stroke (bayan bass with pressure glide, dayan tuned to Sa with harmonic modes). */
export function tablaStroke(
  kit: SynthKit,
  dest: AudioNode,
  t: number,
  stroke: TablaStroke,
  velocity: number,
  dayanHz: number,
): void {
  const { ctx } = kit;
  const nodes: AudioNode[] = [];
  const out = ctx.createGain();
  out.gain.setValueAtTime(velocity, t);
  out.connect(dest);
  nodes.push(out);
  let last: AudioScheduledSourceNode | null = null;
  const bayan = (decay: number, bend: boolean): void => {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(72, t + 0.07);
    if (bend) o.frequency.exponentialRampToValueAtTime(96, t + decay * 0.6);
    const g = ctx.createGain();
    percEnv(g.gain, t, 0.85, 0.004, decay);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + decay + 0.05);
    nodes.push(o, g);
    last = o;
  };
  const dayan = (decay: number, partials: readonly number[]): void => {
    partials.forEach((mult, i) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(dayanHz * mult, t);
      const g = ctx.createGain();
      percEnv(g.gain, t, 0.42 / (i + 1), 0.002, decay / (1 + i * 0.6));
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + decay + 0.05);
      nodes.push(o, g);
      last = o;
    });
    // Finger click.
    const n = noiseSource(kit, 'white');
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(3800, t);
    bp.Q.setValueAtTime(1.8, t);
    const g = ctx.createGain();
    percEnv(g.gain, t, 0.35, 0.001, 0.025);
    n.connect(bp).connect(g).connect(out);
    n.start(t, (t * 5.77) % 1.5);
    n.stop(t + 0.06);
    nodes.push(n, bp, g);
  };
  const slap = (): void => {
    const n = noiseSource(kit, 'brown');
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(420, t);
    const g = ctx.createGain();
    percEnv(g.gain, t, 0.9, 0.002, 0.06);
    n.connect(lp).connect(g).connect(out);
    n.start(t, (t * 5.77) % 1.5);
    n.stop(t + 0.1);
    nodes.push(n, lp, g);
    last = n;
  };
  switch (stroke) {
    case 'dha':
      bayan(0.55, false);
      dayan(0.45, [1, 2, 3]);
      break;
    case 'dhin':
      bayan(0.7, true);
      dayan(0.7, [1, 2, 3, 4]);
      break;
    case 'ge':
      bayan(0.5, Math.floor(t * 10) % 3 === 0);
      break;
    case 'na':
      dayan(0.42, [1, 2, 3]);
      break;
    case 'ta':
      dayan(0.3, [2, 3]);
      break;
    case 'tin':
      dayan(0.5, [2, 3, 4]);
      break;
    case 'ti':
    case 'tit':
      dayan(0.1, [2, 3]);
      break;
    case 'ke':
      slap();
      break;
  }
  if (last) cleanupOnEnd(last, nodes);
}

/** FM temple bell (inharmonic partials, long decay). */
export function bell(
  kit: SynthKit,
  dest: AudioNode,
  t: number,
  freq: number,
  gain: number,
  decay = 3,
  pan = 0,
): void {
  const { ctx } = kit;
  const p = ctx.createStereoPanner();
  p.pan.setValueAtTime(pan, t);
  p.connect(dest);
  const nodes: AudioNode[] = [p];
  let last: OscillatorNode | null = null;
  for (const [ratio, amp, dec] of [
    [1, 1, 1],
    [2.76, 0.45, 0.6],
    [5.4, 0.25, 0.4],
    [8.93, 0.12, 0.25],
  ] as const) {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq * ratio, t);
    const g = ctx.createGain();
    percEnv(g.gain, t, gain * amp, 0.003, decay * dec);
    o.connect(g).connect(p);
    o.start(t);
    o.stop(t + decay + 0.1);
    nodes.push(o, g);
    last = o;
  }
  if (last) cleanupOnEnd(last, nodes);
}

/** Series of quick bird chirps (rising FM sweeps). */
export function birdCall(
  kit: SynthKit,
  dest: AudioNode,
  t: number,
  rnd: ArtRandom,
  gain: number,
): number {
  const { ctx } = kit;
  const p = ctx.createStereoPanner();
  p.pan.setValueAtTime(rnd.range(-0.8, 0.8), t);
  p.connect(dest);
  const count = rnd.int(2, 5);
  const base = rnd.range(2600, 4200);
  let at = t;
  let last: OscillatorNode | null = null;
  const nodes: AudioNode[] = [p];
  for (let i = 0; i < count; i++) {
    const o = ctx.createOscillator();
    o.type = 'sine';
    const len = rnd.range(0.05, 0.11);
    o.frequency.setValueAtTime(base * rnd.range(0.85, 1.0), at);
    o.frequency.exponentialRampToValueAtTime(base * rnd.range(1.15, 1.45), at + len * 0.7);
    o.frequency.exponentialRampToValueAtTime(base * rnd.range(0.9, 1.1), at + len);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(gain, at + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, at + len);
    o.connect(g).connect(p);
    o.start(at);
    o.stop(at + len + 0.02);
    nodes.push(o, g);
    last = o;
    at += len + rnd.range(0.04, 0.12);
  }
  if (last) cleanupOnEnd(last, nodes);
  return at - t;
}
