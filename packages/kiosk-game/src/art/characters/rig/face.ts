/**
 * Facial life: eye blinks with randomised timing, saccades and look-at, and lip-flap visemes driven by
 * the amplitude of the voice that is playing.
 *
 * - Blinks: intervals drawn from a skewed distribution (mostly 2-5 s, occasionally longer), 120-170 ms
 *   long, with ~15 % double blinks; a blink may also accompany a large gaze shift or an expression change.
 * - Saccades: fixations of 0.35-2.8 s, then a fast jump (~40 ms) to a new point near the expression's
 *   resting gaze; with a look-at target the eyes hold it with tiny micro-saccades.
 * - Visemes: an envelope follower (fast attack, slower release) on the amplitude picks a mouth shape at
 *   each syllable peak (open "aa", rounded "oh"/"oo", spread "ee", closed "mbp" at sharp drops, rest in
 *   pauses) and the mouth eases towards it. The amplitude comes from the playing clip (an analyser, a
 *   timing track or a callback); without one a seeded speech-like envelope keeps the lips moving.
 *
 * Decorative randomness only (ArtRandom with a per-character seed); never game logic.
 */
import { ArtRandom } from '../../rand.ts';

export type Viseme = 'rest' | 'mbp' | 'ee' | 'aa' | 'oh' | 'oo';

export interface VisemeShape {
  /** Opening 0..1. */
  readonly open: number;
  /** Width factor. */
  readonly width: number;
  /** Lip rounding 0..1. */
  readonly round: number;
}

export const VISEMES: Readonly<Record<Viseme, VisemeShape>> = {
  rest: { open: 0, width: 1, round: 0 },
  mbp: { open: 0, width: 0.88, round: 0.1 },
  ee: { open: 0.28, width: 1.22, round: 0 },
  aa: { open: 0.88, width: 1.04, round: 0.1 },
  oh: { open: 0.62, width: 0.74, round: 0.7 },
  oo: { open: 0.3, width: 0.56, round: 1 },
};

/** Amplitude in 0..1 sampled each frame. */
export type AmplitudeSource = () => number;

export interface FaceState {
  /** Eyelid closure 0 (open) .. 1 (closed). */
  readonly blink: number;
  readonly gazeX: number;
  readonly gazeY: number;
  readonly viseme: Viseme;
  /** Mouth shape after smoothing. */
  readonly mouthOpen: number;
  readonly mouthWidth: number;
  readonly mouthRound: number;
  /** Speech envelope 0..1 (0 when silent). */
  readonly envelope: number;
}

export interface BlinkTiming {
  readonly minInterval: number;
  readonly maxInterval: number;
  readonly doubleChance: number;
}

const BLINK: BlinkTiming = { minInterval: 1.4, maxInterval: 7.5, doubleChance: 0.15 };

/** Blink, gaze and mouth controller (pure; advanced with `update(dt)`). */
export class FaceController {
  blinkEnabled = true;
  saccadesEnabled = true;
  private readonly rnd: ArtRandom;
  private blinkT = -1;
  private blinkDur = 0.14;
  private nextBlink: number;
  private pendingDouble = false;
  /** Seconds since the last blink ended (a short refractory period avoids eyelid flutter). */
  private sinceBlink = 10;
  private fixation: number;
  private gaze = { x: 0, y: 0 };
  private gazeTarget = { x: 0, y: 0 };
  private restGaze = { x: 0, y: 0 };
  private look: { x: number; y: number } | null = null;
  private env = 0;
  private prevAmp = 0;
  private rising = false;
  private visemeHold = 0;
  private viseme: Viseme = 'rest';
  private mouth = { open: 0, width: 1, round: 0 };
  private amplitude: AmplitudeSource | null = null;
  private synthetic: SyntheticSpeech | null = null;
  private talking = false;
  /** Count of blinks started (diagnostics/tests). */
  blinks = 0;

  constructor(seed: number) {
    this.rnd = new ArtRandom(seed ^ 0x5bd1e995);
    this.nextBlink = this.rnd.range(0.6, 3.2);
    this.fixation = this.rnd.range(0.4, 2);
  }

  /** Expression's resting gaze (eyes drift back here between saccades). */
  setRestGaze(x: number, y: number): void {
    this.restGaze = { x, y };
  }

  /** Look at a point given as gaze offsets (-1..1); null releases. */
  setLook(target: { x: number; y: number } | null): void {
    const prev = this.look;
    this.look = target ? { x: clamp1(target.x), y: clamp1(target.y) } : null;
    if (this.look) {
      const jump = prev
        ? Math.hypot(prev.x - this.look.x, prev.y - this.look.y)
        : Math.hypot(this.gaze.x - this.look.x, this.gaze.y - this.look.y);
      this.gazeTarget = { ...this.look };
      if (jump > 0.8 && this.rnd.chance(0.35)) this.triggerBlink();
    }
  }

  get lookTarget(): { x: number; y: number } | null {
    return this.look;
  }

  /** Start a blink now (if not already blinking). */
  triggerBlink(): void {
    if (!this.blinkEnabled || this.blinkT >= 0 || this.sinceBlink < 0.12) return;
    this.blinkT = 0;
    this.blinkDur = this.rnd.range(0.12, 0.17);
    this.blinks++;
  }

  /** Start or stop speech; `amplitude` drives the lips (synthetic envelope when omitted). */
  setTalking(talking: boolean, amplitude?: AmplitudeSource): void {
    this.talking = talking;
    this.amplitude = talking ? (amplitude ?? null) : null;
    this.synthetic = talking && !amplitude ? new SyntheticSpeech(this.rnd.int(1, 1 << 30)) : null;
  }

  get isTalking(): boolean {
    return this.talking;
  }

  update(dt: number): FaceState {
    const step = Math.max(0, Math.min(0.1, dt));
    this.updateBlink(step);
    this.updateGaze(step);
    this.updateMouth(step);
    const blink =
      this.blinkT < 0 ? 0 : Math.sin(Math.min(1, this.blinkT / this.blinkDur) * Math.PI) ** 0.7;
    return {
      blink,
      gazeX: this.gaze.x,
      gazeY: this.gaze.y,
      viseme: this.viseme,
      mouthOpen: this.mouth.open,
      mouthWidth: this.mouth.width,
      mouthRound: this.mouth.round,
      envelope: this.env,
    };
  }

  /** Next blink interval (s), skewed towards 2-5 s. */
  sampleInterval(): number {
    const u = this.rnd.next();
    const v = this.rnd.next();
    // Log-normal-ish: median ~3.2 s.
    const z = Math.sqrt(-2 * Math.log(Math.max(1e-9, u))) * Math.cos(2 * Math.PI * v);
    const t = Math.exp(Math.log(3.2) + 0.38 * z);
    return Math.min(BLINK.maxInterval, Math.max(BLINK.minInterval, t));
  }

  private updateBlink(dt: number): void {
    this.sinceBlink += dt;
    if (this.blinkT >= 0) {
      this.sinceBlink = 0;
      this.blinkT += dt;
      if (this.blinkT >= this.blinkDur) {
        this.blinkT = -1;
        if (this.pendingDouble) {
          this.pendingDouble = false;
          this.nextBlink = this.rnd.range(0.18, 0.3);
        } else {
          this.nextBlink = this.sampleInterval();
          this.pendingDouble = this.rnd.chance(BLINK.doubleChance);
        }
      }
      return;
    }
    if (!this.blinkEnabled) return;
    this.nextBlink -= dt;
    if (this.nextBlink <= 0) this.triggerBlink();
  }

  private updateGaze(dt: number): void {
    this.fixation -= dt;
    if (this.fixation <= 0) {
      if (this.look) {
        this.gazeTarget = {
          x: clamp1(this.look.x + this.rnd.range(-0.05, 0.05)),
          y: clamp1(this.look.y + this.rnd.range(-0.04, 0.04)),
        };
        this.fixation = this.rnd.range(0.3, 1.1);
      } else if (this.saccadesEnabled) {
        const far = this.rnd.chance(0.2);
        const amp = far ? 0.6 : 0.22;
        const nx = clamp1(this.restGaze.x + this.rnd.range(-amp, amp));
        const ny = clamp1(this.restGaze.y + this.rnd.range(-amp * 0.6, amp * 0.6));
        const jump = Math.hypot(nx - this.gazeTarget.x, ny - this.gazeTarget.y);
        this.gazeTarget = { x: nx, y: ny };
        if (jump > 0.45 && this.rnd.chance(0.3)) this.triggerBlink();
        this.fixation = this.rnd.range(0.35, 2.8);
      } else {
        this.gazeTarget = { ...this.restGaze };
        this.fixation = 0.5;
      }
    }
    // Saccades are fast: close most of the gap within ~40 ms.
    const k = 1 - Math.exp(-dt * 38);
    this.gaze.x += (this.gazeTarget.x - this.gaze.x) * k;
    this.gaze.y += (this.gazeTarget.y - this.gaze.y) * k;
  }

  private updateMouth(dt: number): void {
    let amp = 0;
    if (this.talking) {
      amp = this.amplitude ? clamp01(this.amplitude()) : (this.synthetic?.next(dt) ?? 0);
    }
    const attack = 1 - Math.exp(-dt * 40);
    const release = 1 - Math.exp(-dt * 14);
    const prevEnv = this.env;
    this.env += (amp - this.env) * (amp > this.env ? attack : release);
    this.visemeHold -= dt;
    const wasRising = this.rising;
    this.rising = this.env >= prevEnv;
    const peak = wasRising && !this.rising;
    if (this.env < 0.06) {
      if (this.visemeHold <= 0) this.viseme = 'rest';
    } else if (this.prevAmp - amp > 0.3 && amp < 0.15 && this.visemeHold <= 0) {
      this.viseme = 'mbp';
      this.visemeHold = 0.06;
    } else if ((peak || this.viseme === 'rest') && this.visemeHold <= 0) {
      this.viseme = this.pickViseme(this.env);
      this.visemeHold = 0.07;
    }
    this.prevAmp = amp;
    const target = VISEMES[this.viseme];
    const level = this.viseme === 'rest' || this.viseme === 'mbp' ? 1 : 0.45 + 0.75 * this.env;
    const k = 1 - Math.exp(-dt * 28);
    this.mouth.open += (Math.min(1, target.open * level) - this.mouth.open) * k;
    this.mouth.width += (target.width - this.mouth.width) * k;
    this.mouth.round += (target.round - this.mouth.round) * k;
  }

  private pickViseme(level: number): Viseme {
    const r = this.rnd.next();
    if (level > 0.6) return r < 0.6 ? 'aa' : r < 0.85 ? 'oh' : 'ee';
    if (level > 0.3) return r < 0.4 ? 'oh' : r < 0.75 ? 'ee' : 'aa';
    return r < 0.5 ? 'ee' : r < 0.8 ? 'oo' : 'oh';
  }
}

/** Seeded speech-like amplitude envelope (syllables 120-260 ms, word gaps, phrase pauses). */
export class SyntheticSpeech {
  private readonly rnd: ArtRandom;
  private t = 0;
  private segEnd = 0;
  private segStart = 0;
  private peak = 0;
  private gap = false;
  private syllablesLeft = 0;

  constructor(seed: number) {
    this.rnd = new ArtRandom(seed);
    this.newWord();
  }

  next(dt: number): number {
    this.t += dt;
    while (this.t >= this.segEnd) this.advance();
    if (this.gap) return 0.02;
    const u = (this.t - this.segStart) / Math.max(1e-3, this.segEnd - this.segStart);
    return this.peak * Math.sin(Math.PI * u) ** 0.8;
  }

  private newWord(): void {
    this.syllablesLeft = this.rnd.int(1, 4);
  }

  private advance(): void {
    this.segStart = this.segEnd;
    if (!this.gap && this.syllablesLeft <= 0) {
      this.gap = true;
      this.segEnd =
        this.segStart +
        (this.rnd.chance(0.15) ? this.rnd.range(0.3, 0.5) : this.rnd.range(0.06, 0.16));
      this.newWord();
      return;
    }
    this.gap = false;
    this.syllablesLeft--;
    this.peak = this.rnd.range(0.35, 1);
    this.segEnd = this.segStart + this.rnd.range(0.12, 0.26);
  }
}

/** Amplitude from a Web Audio analyser (RMS of the time-domain signal, ~0.25 RMS = fully open). */
export function analyserAmplitude(analyser: AnalyserNode, gain = 4): AmplitudeSource {
  const buf = new Float32Array(analyser.fftSize);
  return () => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i] ?? 0;
      sum += v * v;
    }
    return clamp01(Math.sqrt(sum / Math.max(1, buf.length)) * gain);
  };
}

/**
 * Amplitude from a pre-computed timing track (VOX-03 "timing-track mouth sync"): `[ms, amplitude]`
 * pairs sorted by time, read against a clock returning ms since the clip started.
 */
export function trackAmplitude(
  track: readonly (readonly [number, number])[],
  clockMs: () => number,
): AmplitudeSource {
  let idx = 0;
  return () => {
    const t = clockMs();
    if (track.length === 0) return 0;
    if (idx > 0 && (track[idx - 1]?.[0] ?? 0) > t) idx = 0;
    while (idx < track.length - 1 && (track[idx + 1]?.[0] ?? Number.POSITIVE_INFINITY) <= t) idx++;
    const a = track[idx];
    const b = track[idx + 1];
    if (!a) return 0;
    if (!b || t <= a[0]) return clamp01(t < a[0] ? 0 : a[1]);
    const u = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
    return clamp01(a[1] + (b[1] - a[1]) * u);
  };
}

/**
 * Optional amplitude hooks a voice playback may expose (duck-typed so the voice service can add them
 * without a contract change): `amplitude()` / `level()` returning 0..1, or an `analyser` node.
 */
export interface AmplitudeCapable {
  readonly amplitude?: () => number;
  readonly level?: () => number;
  readonly analyser?: AnalyserNode;
}

/** Resolve an amplitude source from a playback object if it offers one. */
export function amplitudeOf(playback: object): AmplitudeSource | undefined {
  const p = playback as AmplitudeCapable;
  if (typeof p.amplitude === 'function') return () => clamp01(p.amplitude?.() ?? 0);
  if (typeof p.level === 'function') return () => clamp01(p.level?.() ?? 0);
  if (p.analyser && typeof p.analyser.getFloatTimeDomainData === 'function')
    return analyserAmplitude(p.analyser);
  return undefined;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0;
}

function clamp1(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}
