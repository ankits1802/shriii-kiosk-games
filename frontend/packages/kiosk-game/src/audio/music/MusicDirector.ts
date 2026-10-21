/**
 * Lookahead music scheduler ("a tale of two clocks"): a JS timer wakes every 25 ms and schedules every
 * musical event that falls in the next 150 ms on the AudioContext timeline, so timing stays tight even
 * when the main thread is busy.
 *
 * Layers per cue: tanpura drone (Pa-Sa-Sa-Sa cycle), tabla theka with humanised timing and fills,
 * a seeded bansuri melody generator (pentatonic random walk with meend and kan ornaments, phrased in
 * call-and-response), ghungroo shimmer, and a tension layer (shaker + low pulse) for timed rushes.
 * Cue changes cross-fade.
 */

import { ArtRandom, hashString } from '../../art/rand.ts';
import type { MusicCueId } from '../../core/contracts.ts';
import {
  cleanupOnEnd,
  fluteNote,
  noiseSource,
  percEnv,
  type SynthKit,
  tablaStroke,
  tanpuraPluck,
} from '../synth.ts';
import { beatSeconds, degreeHz, SA_HZ } from '../theory.ts';
import { CUES, type CueDef } from './cues.ts';

const LOOKAHEAD_S = 0.15;
const TICK_MS = 25;

interface ActiveCue {
  readonly id: MusicCueId;
  readonly def: CueDef;
  readonly out: GainNode;
  readonly rnd: ArtRandom;
  nextBeatTime: number;
  beat: number;
  stopping: boolean;
  lastDegree: number;
  phraseQueue: { t: number; deg: number; dur: number; glide: boolean; kan: boolean }[];
}

export class MusicDirector {
  private active: ActiveCue[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private tension = 0;
  private variation = 0;

  constructor(
    private readonly kit: SynthKit,
    private readonly dest: AudioNode,
  ) {}

  /** Id of the cue currently fading in or playing. */
  get current(): MusicCueId | null {
    const live = this.active.filter((c) => !c.stopping);
    return live[live.length - 1]?.id ?? null;
  }

  /** Extra tension blend 0..1 by block condition (timer on/off), never by performance. */
  setTension(level: number): void {
    this.tension = Math.max(0, Math.min(1, level));
  }

  play(id: MusicCueId, fadeMs = 1500): void {
    const ctx = this.kit.ctx;
    if (this.current === id) return;
    const now = ctx.currentTime;
    for (const c of this.active) this.fadeOut(c, fadeMs);
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, now);
    out.gain.exponentialRampToValueAtTime(1, now + Math.max(0.05, fadeMs / 1000));
    out.connect(this.dest);
    this.variation++;
    const cue: ActiveCue = {
      id,
      def: CUES[id],
      out,
      rnd: new ArtRandom(hashString(id) + this.variation * 7919),
      nextBeatTime: now + 0.05,
      beat: 0,
      stopping: false,
      lastDegree: 5,
      phraseQueue: [],
    };
    this.active.push(cue);
    this.ensureTimer();
  }

  stop(fadeMs = 1200): void {
    for (const c of this.active) this.fadeOut(c, fadeMs);
  }

  /** Immediate stop (wipe). */
  kill(): void {
    for (const c of this.active) {
      try {
        c.out.gain.cancelScheduledValues(this.kit.ctx.currentTime);
        c.out.gain.setValueAtTime(0, this.kit.ctx.currentTime);
        c.out.disconnect();
      } catch {
        // ignore
      }
    }
    this.active = [];
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Run the scheduler once (exposed for tests with a fake clock). */
  tick(): void {
    const ctx = this.kit.ctx;
    const horizon = ctx.currentTime + LOOKAHEAD_S;
    for (const c of this.active) {
      if (c.stopping) continue;
      while (c.nextBeatTime < horizon) {
        this.scheduleBeat(c, c.nextBeatTime);
        c.nextBeatTime += beatSeconds(c.def.bpm);
        c.beat++;
      }
      // Flush melody notes inside the horizon.
      while (
        c.phraseQueue.length > 0 &&
        (c.phraseQueue[0]?.t ?? Number.POSITIVE_INFINITY) < horizon
      ) {
        const n = c.phraseQueue.shift();
        if (n) this.playMelodyNote(c, n);
      }
    }
    if (this.active.length === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  private fadeOut(c: ActiveCue, fadeMs: number): void {
    if (c.stopping) return;
    c.stopping = true;
    const ctx = this.kit.ctx;
    const now = ctx.currentTime;
    c.out.gain.cancelScheduledValues(now);
    c.out.gain.setValueAtTime(Math.max(0.0001, c.out.gain.value), now);
    c.out.gain.exponentialRampToValueAtTime(0.0001, now + Math.max(0.05, fadeMs / 1000));
    setTimeout(() => {
      try {
        c.out.disconnect();
      } catch {
        // ignore
      }
      this.active = this.active.filter((x) => x !== c);
    }, fadeMs + 4500);
  }

  private scheduleBeat(c: ActiveCue, t: number): void {
    const d = c.def;
    const spb = beatSeconds(d.bpm);
    const r = c.rnd;
    // Drone: one pluck per beat on a 4-beat Pa-Sa-Sa-Sa(low) cycle, slower for fast cues.
    if (d.drone > 0) {
      const droneEvery = d.bpm > 95 ? 2 : 1;
      if (c.beat % droneEvery === 0) {
        const k = (c.beat / droneEvery) % 4;
        const freqs = [SA_HZ * 0.75, SA_HZ, SA_HZ, SA_HZ * 0.5];
        const pans = [-0.35, -0.1, 0.1, 0.3];
        tanpuraPluck(
          this.kit,
          c.out,
          t + r.range(0, 0.012),
          freqs[k] ?? SA_HZ,
          0.11 * d.drone,
          pans[k] ?? 0,
          spb * droneEvery * 4.2,
        );
      }
    }
    // Tabla: pattern cycle with humanised timing and an occasional fill.
    const tablaLevel = d.tabla + this.tension * 0.4;
    if (tablaLevel > 0) {
      const pat = d.pattern;
      const beatsInCycle = pat.strokes.length / pat.subdivisions;
      const beatInCycle = c.beat % beatsInCycle;
      const cycle = Math.floor(c.beat / beatsInCycle);
      const fill = cycle % 4 === 3 && beatInCycle === beatsInCycle - 1;
      for (let s = 0; s < pat.subdivisions; s++) {
        let stroke = pat.strokes[beatInCycle * pat.subdivisions + s] ?? null;
        if (fill) stroke = s % 2 === 0 ? 'tit' : 'na';
        if (!stroke) continue;
        const tt = t + (s * spb) / pat.subdivisions + r.range(-0.006, 0.008);
        const accent = beatInCycle === 0 && s === 0 ? 1.15 : 1;
        tablaStroke(
          this.kit,
          c.out,
          tt,
          stroke,
          0.32 * tablaLevel * accent * r.range(0.82, 1.05),
          SA_HZ * 2,
        );
      }
    }
    // Ghungroo shimmer on off-beats.
    if (d.ghungroo > 0 && r.chance(0.55)) this.ghungroo(c, t + spb / 2, 0.05 * d.ghungroo);
    // Tension layer: shaker sixteenths + low pulse on beats.
    const tension = Math.max(d.tension, this.tension);
    if (tension > 0.01) {
      for (let s = 0; s < 4; s++)
        this.shaker(c, t + (s * spb) / 4, (s === 0 ? 0.07 : 0.04) * tension);
      this.pulse(c, t, 0.18 * tension);
    }
    // Melody phrases on 2-bar boundaries (8 beats).
    if (d.melody > 0 && c.beat % 8 === 0 && r.chance(d.melodyDensity))
      this.composePhrase(c, t, spb);
  }

  private composePhrase(c: ActiveCue, t: number, spb: number): void {
    const r = c.rnd;
    const rhythms: readonly (readonly number[])[] = [
      [1, 1, 2, 1, 1, 2],
      [2, 1, 1, 4],
      [1.5, 0.5, 1, 1, 4],
      [1, 1, 1, 1, 2, 2],
      [3, 1, 2, 2],
      [0.5, 0.5, 1, 2, 4],
    ];
    const rhythm = r.pick(rhythms);
    let at = t;
    let deg = c.lastDegree;
    rhythm.forEach((beats, i) => {
      const last = i === rhythm.length - 1;
      if (last) {
        // Resolve to Sa or Pa of the middle register.
        deg = r.chance(0.6) ? 5 : 3;
      } else {
        const step = r.pick([-2, -1, -1, 1, 1, 2, 0, 1]);
        deg = Math.max(2, Math.min(10, deg + step));
      }
      c.phraseQueue.push({
        t: at,
        deg,
        dur: beats * spb * 0.95,
        glide: i > 0 && r.chance(0.35),
        kan: !last && r.chance(0.2),
      });
      at += beats * spb;
    });
    c.lastDegree = deg;
    c.phraseQueue.sort((a, b) => a.t - b.t);
  }

  private playMelodyNote(
    c: ActiveCue,
    n: { t: number; deg: number; dur: number; glide: boolean; kan: boolean },
  ): void {
    const d = c.def;
    const freq = degreeHz(d.raga, n.deg, d.melodyOctave);
    const prev = degreeHz(d.raga, n.deg + (n.deg > 5 ? -1 : 1), d.melodyOctave);
    fluteNote(this.kit, c.out, {
      t: n.t,
      freq,
      duration: n.dur,
      gain: 0.085 * d.melody,
      ...(n.glide ? { fromFreq: prev, glideS: Math.min(0.14, n.dur * 0.3) } : {}),
      ...(n.kan ? { kan: degreeHz(d.raga, n.deg + 1, d.melodyOctave) } : {}),
      pan: 0.12,
    });
  }

  private ghungroo(c: ActiveCue, t: number, gain: number): void {
    const ctx = this.kit.ctx;
    const n = noiseSource(this.kit, 'white');
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(7200, t);
    bp.Q.setValueAtTime(3, t);
    const g = ctx.createGain();
    percEnv(g.gain, t, gain, 0.002, 0.12);
    n.connect(bp).connect(g).connect(c.out);
    n.start(t, (t * 7.31) % 1.5);
    n.stop(t + 0.16);
    cleanupOnEnd(n, [n, bp, g]);
  }

  private shaker(c: ActiveCue, t: number, gain: number): void {
    const ctx = this.kit.ctx;
    const n = noiseSource(this.kit, 'white');
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.setValueAtTime(5200, t);
    const g = ctx.createGain();
    percEnv(g.gain, t, gain, 0.008, 0.05);
    n.connect(hp).connect(g).connect(c.out);
    n.start(t, (t * 3.17) % 1.5);
    n.stop(t + 0.08);
    cleanupOnEnd(n, [n, hp, g]);
  }

  private pulse(c: ActiveCue, t: number, gain: number): void {
    const ctx = this.kit.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(SA_HZ / 2, t);
    const g = ctx.createGain();
    percEnv(g.gain, t, gain, 0.01, 0.22);
    o.connect(g).connect(c.out);
    o.start(t);
    o.stop(t + 0.3);
    cleanupOnEnd(o, [o, g]);
  }
}
