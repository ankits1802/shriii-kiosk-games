/**
 * Procedural market ambience beds: crowd murmur (formant-filtered pink noise with drifting levels plus
 * faint vowel-like chatter), distant temple bells, birds, crickets and evening wind, cart rumble.
 * Each bed has its own mix; beds cross-fade.
 */

import { ArtRandom } from '../art/rand.ts';
import type { AmbienceId } from '../core/contracts.ts';
import { bell, birdCall, cleanupOnEnd, noiseSource, percEnv, type SynthKit } from './synth.ts';
import { SA_HZ } from './theory.ts';

export interface AmbienceMix {
  readonly murmur: number;
  readonly chatter: number;
  readonly birds: number;
  readonly bells: number;
  readonly crickets: number;
  readonly wind: number;
  readonly carts: number;
}

export const AMBIENCE_MIXES: Readonly<Record<AmbienceId, AmbienceMix>> = {
  market_day: {
    murmur: 0.5,
    chatter: 0.35,
    birds: 0.6,
    bells: 0.3,
    crickets: 0,
    wind: 0.1,
    carts: 0.2,
  },
  market_busy: {
    murmur: 0.9,
    chatter: 0.7,
    birds: 0.3,
    bells: 0.25,
    crickets: 0,
    wind: 0.05,
    carts: 0.5,
  },
  road_evening: {
    murmur: 0.1,
    chatter: 0.05,
    birds: 0.25,
    bells: 0.35,
    crickets: 0.6,
    wind: 0.35,
    carts: 0.15,
  },
  quiet: { murmur: 0.08, chatter: 0, birds: 0.35, bells: 0.15, crickets: 0, wind: 0.25, carts: 0 },
};

const BANDS = [380, 640, 1050, 1750] as const;

/** One running bed. */
class Bed {
  readonly out: GainNode;
  private readonly loops: AudioBufferSourceNode[] = [];
  private readonly bandGains: GainNode[] = [];
  private readonly windGain: GainNode;
  private nextEvents = { bird: 0, bell: 0, chatter: 0, cricket: 0, cart: 0, drift: 0 };
  private readonly rnd: ArtRandom;
  stopped = false;

  constructor(
    private readonly kit: SynthKit,
    dest: AudioNode,
    private readonly mix: AmbienceMix,
    id: AmbienceId,
    fadeS: number,
  ) {
    const ctx = kit.ctx;
    const t = ctx.currentTime;
    this.rnd = new ArtRandom(`amb:${id}`);
    this.out = ctx.createGain();
    this.out.gain.setValueAtTime(0.0001, t);
    this.out.gain.exponentialRampToValueAtTime(1, t + Math.max(0.05, fadeS));
    this.out.connect(dest);
    // Murmur: looping pink noise through four speech-band filters with drifting gains.
    if (mix.murmur > 0) {
      for (const [i, f] of BANDS.entries()) {
        const src = noiseSource(kit, 'pink', true);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.setValueAtTime(f, t);
        bp.Q.setValueAtTime(1.6 + i * 0.4, t);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.05 * mix.murmur, t);
        const pan = ctx.createStereoPanner();
        pan.pan.setValueAtTime([-0.5, 0.4, -0.2, 0.6][i] ?? 0, t);
        src.connect(bp).connect(g).connect(pan).connect(this.out);
        src.start(t, i * 0.37);
        this.loops.push(src);
        this.bandGains.push(g);
      }
    }
    // Wind: looping brown noise, low-passed.
    const w = noiseSource(kit, 'brown', true);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(380, t);
    this.windGain = ctx.createGain();
    this.windGain.gain.setValueAtTime(0.12 * mix.wind, t);
    w.connect(lp).connect(this.windGain).connect(this.out);
    w.start(t, 0.5);
    this.loops.push(w);
  }

  schedule(now: number, horizon: number): void {
    if (this.stopped) return;
    const r = this.rnd;
    const m = this.mix;
    const ctx = this.kit.ctx;
    if (now >= this.nextEvents.drift) {
      this.nextEvents.drift = now + r.range(0.15, 0.4);
      for (const g of this.bandGains)
        g.gain.setTargetAtTime(0.05 * m.murmur * r.range(0.35, 1.2), now, 0.25);
      this.windGain.gain.setTargetAtTime(0.12 * m.wind * r.range(0.5, 1.3), now, 0.8);
    }
    if (m.birds > 0 && this.nextEvents.bird < horizon) {
      const at = Math.max(now, this.nextEvents.bird);
      const dur = birdCall(this.kit, this.out, at, r, 0.035 * m.birds);
      this.nextEvents.bird = at + dur + r.range(1.5, 6) / Math.max(0.3, m.birds);
    }
    if (m.bells > 0 && this.nextEvents.bell < horizon) {
      const at = Math.max(now, this.nextEvents.bell);
      if (this.nextEvents.bell > 0)
        bell(
          this.kit,
          this.out,
          at,
          SA_HZ * r.pick([4, 3, 6]),
          0.03 * m.bells,
          3.5,
          r.range(-0.7, 0.7),
        );
      this.nextEvents.bell = at + r.range(6, 15);
    }
    if (m.chatter > 0 && this.nextEvents.chatter < horizon) {
      const at = Math.max(now, this.nextEvents.chatter);
      this.vowel(at, 0.018 * m.chatter);
      this.nextEvents.chatter = at + r.range(0.25, 1.2) / m.chatter;
    }
    if (m.crickets > 0 && this.nextEvents.cricket < horizon) {
      const at = Math.max(now, this.nextEvents.cricket);
      this.cricket(at, 0.012 * m.crickets);
      this.nextEvents.cricket = at + r.range(0.7, 1.4);
    }
    if (m.carts > 0 && this.nextEvents.cart < horizon) {
      const at = Math.max(now, this.nextEvents.cart);
      if (this.nextEvents.cart > 0) this.cart(at, 0.05 * m.carts);
      this.nextEvents.cart = at + r.range(12, 25);
    }
    void ctx;
  }

  /** A faint distant syllable: buzzy source through two moving formants. */
  private vowel(t: number, gain: number): void {
    const ctx = this.kit.ctx;
    const r = this.rnd;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    const f0 = r.range(110, 240);
    o.frequency.setValueAtTime(f0, t);
    o.frequency.linearRampToValueAtTime(f0 * r.range(0.85, 1.2), t + 0.3);
    const vowels = [
      [700, 1200],
      [400, 2100],
      [300, 800],
      [600, 1700],
      [500, 1000],
    ] as const;
    const [a, b] = r.pick(vowels);
    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass';
    f1.frequency.setValueAtTime(a, t);
    f1.Q.setValueAtTime(6, t);
    const f2 = ctx.createBiquadFilter();
    f2.type = 'bandpass';
    f2.frequency.setValueAtTime(b, t);
    f2.Q.setValueAtTime(8, t);
    const g = ctx.createGain();
    const len = r.range(0.15, 0.4);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1800, t);
    const pan = ctx.createStereoPanner();
    pan.pan.setValueAtTime(r.range(-0.9, 0.9), t);
    o.connect(f1).connect(g);
    o.connect(f2).connect(g);
    g.connect(lp).connect(pan).connect(this.out);
    o.start(t);
    o.stop(t + len + 0.05);
    cleanupOnEnd(o, [o, f1, f2, g, lp, pan]);
  }

  private cricket(t: number, gain: number): void {
    const ctx = this.kit.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(4600 + this.rnd.range(-200, 200), t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    const pulses = this.rnd.int(3, 6);
    for (let i = 0; i < pulses; i++) {
      const at = t + i * 0.045;
      g.gain.setValueAtTime(gain, at);
      g.gain.setValueAtTime(0, at + 0.025);
    }
    const pan = ctx.createStereoPanner();
    pan.pan.setValueAtTime(this.rnd.range(-0.8, 0.8), t);
    o.connect(g).connect(pan).connect(this.out);
    o.start(t);
    o.stop(t + pulses * 0.045 + 0.05);
    cleanupOnEnd(o, [o, g, pan]);
  }

  private cart(t: number, gain: number): void {
    const ctx = this.kit.ctx;
    const n = noiseSource(this.kit, 'brown');
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(220, t);
    const g = ctx.createGain();
    const len = 3.5;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + 1.2);
    g.gain.linearRampToValueAtTime(0.0001, t + len);
    const pan = ctx.createStereoPanner();
    pan.pan.setValueAtTime(-0.8, t);
    pan.pan.linearRampToValueAtTime(0.8, t + len);
    n.connect(lp).connect(g).connect(pan).connect(this.out);
    n.start(t, 0.2);
    n.stop(t + len + 0.1);
    cleanupOnEnd(n, [n, lp, g, pan]);
    // Wheel creaks.
    for (let i = 0; i < 6; i++) {
      const at = t + 0.5 + i * 0.45;
      const c = ctx.createOscillator();
      c.type = 'triangle';
      c.frequency.setValueAtTime(320, at);
      c.frequency.linearRampToValueAtTime(260, at + 0.12);
      const cg = ctx.createGain();
      percEnv(cg.gain, at, gain * 0.25, 0.01, 0.12);
      c.connect(cg).connect(pan);
      c.start(at);
      c.stop(at + 0.15);
    }
  }

  stop(fadeS: number): void {
    if (this.stopped) return;
    this.stopped = true;
    const t = this.kit.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setValueAtTime(Math.max(0.0001, this.out.gain.value), t);
    this.out.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.05, fadeS));
    for (const l of this.loops) {
      try {
        l.stop(t + fadeS + 0.1);
      } catch {
        // ignore
      }
    }
    setTimeout(
      () => {
        try {
          this.out.disconnect();
        } catch {
          // ignore
        }
      },
      (fadeS + 0.3) * 1000,
    );
  }
}

/** Ambience controller with cross-fading beds. */
export class AmbienceController {
  private bed: Bed | null = null;
  private currentId: AmbienceId | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly kit: SynthKit,
    private readonly dest: AudioNode,
  ) {}

  get current(): AmbienceId | null {
    return this.currentId;
  }

  set(id: AmbienceId | null, fadeMs = 2000): void {
    if (id === this.currentId) return;
    this.bed?.stop(fadeMs / 1000);
    this.bed = null;
    this.currentId = id;
    if (id === null) {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      return;
    }
    this.bed = new Bed(this.kit, this.dest, AMBIENCE_MIXES[id], id, fadeMs / 1000);
    if (!this.timer) this.timer = setInterval(() => this.tick(), 100);
    this.tick();
  }

  tick(): void {
    const now = this.kit.ctx.currentTime;
    this.bed?.schedule(now, now + 0.3);
  }

  kill(): void {
    this.bed?.stop(0.03);
    this.bed = null;
    this.currentId = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
