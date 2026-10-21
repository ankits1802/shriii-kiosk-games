/**
 * Procedural sound effects in the fixed key. Feedback sounds are gentle: `incorrect` is a soft wooden
 * "oops" (a rounded falling bloop), never a buzzer or anything punitive.
 */
import type { SfxId } from '../../core/contracts.ts';
import { bell, cleanupOnEnd, noiseSource, percEnv, type SynthKit, tablaStroke } from '../synth.ts';
import { SA_HZ, swaraHz } from '../theory.ts';

/** Synthesise one effect into `dest` at time `t`; returns its duration in seconds. */
export type SfxSynth = (kit: SynthKit, dest: AudioNode, t: number) => number;

function tone(
  kit: SynthKit,
  dest: AudioNode,
  t: number,
  type: OscillatorType,
  f0: number,
  f1: number,
  gain: number,
  attack: number,
  decay: number,
): void {
  const ctx = kit.ctx;
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + attack + decay * 0.7);
  const g = ctx.createGain();
  percEnv(g.gain, t, gain, attack, decay);
  o.connect(g).connect(dest);
  o.start(t);
  o.stop(t + attack + decay + 0.05);
  cleanupOnEnd(o, [o, g]);
}

function noiseBurst(
  kit: SynthKit,
  dest: AudioNode,
  t: number,
  type: BiquadFilterType,
  f0: number,
  f1: number,
  q: number,
  gain: number,
  attack: number,
  decay: number,
  color: 'white' | 'pink' | 'brown' = 'white',
): void {
  const ctx = kit.ctx;
  const n = noiseSource(kit, color);
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(f1, t + attack + decay);
  f.Q.setValueAtTime(q, t);
  const g = ctx.createGain();
  percEnv(g.gain, t, gain, attack, decay);
  n.connect(f).connect(g).connect(dest);
  n.start(t, (t * 3.3) % 1.5);
  n.stop(t + attack + decay + 0.05);
  cleanupOnEnd(n, [n, f, g]);
}

export const SFX: Readonly<Record<SfxId, SfxSynth>> = {
  tap: (k, d, t) => {
    tone(k, d, t, 'sine', 980, 620, 0.32, 0.002, 0.07);
    noiseBurst(k, d, t, 'bandpass', 2600, 2600, 2, 0.12, 0.001, 0.02);
    return 0.1;
  },
  tap_soft: (k, d, t) => {
    tone(k, d, t, 'sine', 820, 600, 0.16, 0.003, 0.06);
    return 0.08;
  },
  confirm: (k, d, t) => {
    bell(k, d, t, swaraHz('Sa', 2), 0.14, 1.2);
    bell(k, d, t + 0.11, swaraHz('Pa', 2), 0.12, 1.4);
    return 1.5;
  },
  cancel: (k, d, t) => {
    tone(k, d, t, 'triangle', swaraHz('Pa', 1), swaraHz('Pa', 1), 0.14, 0.01, 0.18);
    tone(k, d, t + 0.12, 'triangle', swaraHz('Sa', 1), swaraHz('Sa', 1), 0.14, 0.01, 0.3);
    return 0.5;
  },
  correct: (k, d, t) => {
    const notes = [swaraHz('Sa', 2), swaraHz('Ga', 2), swaraHz('Pa', 2), swaraHz('Sa', 3)];
    notes.forEach((f, i) => {
      bell(k, d, t + i * 0.07, f, 0.09, 0.9);
    });
    return 1.2;
  },
  incorrect: (k, d, t) => {
    // Gentle "oops": a soft wooden bloop sliding down a fourth. Never harsh.
    tone(k, d, t, 'sine', swaraHz('Pa', 1), swaraHz('Re', 1), 0.2, 0.01, 0.28);
    tone(k, d, t, 'triangle', swaraHz('Pa', 0), swaraHz('Re', 0), 0.06, 0.01, 0.25);
    return 0.35;
  },
  whoosh: (k, d, t) => {
    noiseBurst(k, d, t, 'bandpass', 300, 2400, 1.2, 0.22, 0.18, 0.35, 'pink');
    return 0.6;
  },
  pop: (k, d, t) => {
    tone(k, d, t, 'sine', 900, 260, 0.3, 0.002, 0.08);
    return 0.12;
  },
  pump: (k, d, t) => {
    noiseBurst(k, d, t, 'lowpass', 900, 1600, 0.7, 0.18, 0.04, 0.16, 'pink');
    tone(k, d, t, 'sine', 300, 420, 0.08, 0.04, 0.16);
    return 0.25;
  },
  balloon_burst: (k, d, t) => {
    noiseBurst(k, d, t, 'lowpass', 3000, 400, 0.6, 0.32, 0.002, 0.18, 'white');
    tone(k, d, t, 'sine', 180, 70, 0.22, 0.002, 0.15);
    for (let i = 0; i < 5; i++)
      bell(
        k,
        d,
        t + 0.08 + i * 0.05,
        swaraHz(['Sa', 'Re', 'Ga', 'Pa', 'Dha'][i] as 'Sa', 3),
        0.025,
        0.4,
      );
    return 0.6;
  },
  coin_drop: (k, d, t) => {
    let at = t;
    let gap = 0.12;
    for (let i = 0; i < 4; i++) {
      bell(k, d, at, 2350 * (1 + i * 0.01), 0.08 * (1 - i * 0.2), 0.35);
      at += gap;
      gap *= 0.62;
    }
    return 0.7;
  },
  jar_fill: (k, d, t) => {
    for (let i = 0; i < 4; i++)
      tone(k, d, t + i * 0.06, 'sine', 500 + i * 120, 700 + i * 140, 0.08, 0.005, 0.07);
    return 0.4;
  },
  card_flip: (k, d, t) => {
    noiseBurst(k, d, t, 'highpass', 1800, 4000, 0.8, 0.14, 0.004, 0.06);
    return 0.1;
  },
  pot_place: (k, d, t) => {
    tone(k, d, t, 'sine', 210, 150, 0.32, 0.004, 0.22);
    noiseBurst(k, d, t, 'lowpass', 600, 300, 0.7, 0.18, 0.002, 0.06, 'brown');
    return 0.3;
  },
  dice_shake: (k, d, t) => {
    for (let i = 0; i < 9; i++)
      noiseBurst(
        k,
        d,
        t + i * 0.045 + (i % 2) * 0.012,
        'bandpass',
        2400 + (i % 3) * 400,
        2400,
        3,
        0.1,
        0.001,
        0.03,
      );
    return 0.5;
  },
  scale_creak: (k, d, t) => {
    // Brass scale clank + a wooden creak.
    bell(k, d, t, 640, 0.09, 0.6);
    bell(k, d, t + 0.01, 1290, 0.05, 0.4);
    const ctx = k.ctx;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(140, t + 0.05);
    o.frequency.linearRampToValueAtTime(95, t + 0.4);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(900, t + 0.05);
    bp.frequency.linearRampToValueAtTime(600, t + 0.4);
    bp.Q.setValueAtTime(7, t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.06, t + 0.12);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    o.connect(bp).connect(g).connect(d);
    o.start(t + 0.05);
    o.stop(t + 0.5);
    cleanupOnEnd(o, [o, bp, g]);
    return 0.7;
  },
  cart_roll: (k, d, t) => {
    noiseBurst(k, d, t, 'lowpass', 260, 200, 0.7, 0.22, 0.2, 0.8, 'brown');
    for (let i = 0; i < 5; i++) tablaStroke(k, d, t + i * 0.18, 'ke', 0.12, SA_HZ * 2);
    return 1.1;
  },
  bell: (k, d, t) => {
    bell(k, d, t, swaraHz('Sa', 3), 0.16, 2.6);
    return 2.6;
  },
  chime: (k, d, t) => {
    const fs = [
      swaraHz('Sa', 3),
      swaraHz('Re', 3),
      swaraHz('Ga', 3),
      swaraHz('Pa', 3),
      swaraHz('Dha', 3),
    ];
    fs.forEach((f, i) => {
      bell(k, d, t + i * 0.09 + (i % 2) * 0.02, f, 0.05, 1.6, (i - 2) * 0.25);
    });
    return 2;
  },
  timer_tick: (k, d, t) => {
    tone(k, d, t, 'sine', 1400, 1100, 0.07, 0.001, 0.03);
    return 0.05;
  },
  transition: (k, d, t) => {
    noiseBurst(k, d, t, 'bandpass', 400, 3000, 1, 0.16, 0.25, 0.4, 'pink');
    const fs = [swaraHz('Pa', 2), swaraHz('Sa', 3), swaraHz('Re', 3)];
    fs.forEach((f, i) => {
      bell(k, d, t + 0.25 + i * 0.06, f, 0.04, 1.2);
    });
    return 1.4;
  },
};
