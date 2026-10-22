/**
 * Scripted bot for headless runs of The Stall (ENG-05 "any module runs headlessly with a scripted
 * bot"). The bot answers through the REAL input path: it injects pointer samples at the centres of the
 * live targets, so raw-tap logging, classification (premature / during-ISI / extra), latencies and
 * response windows are exercised exactly as for a player.
 *
 * Behaviour is a small generative model with person-level parameters drawn from the session seed
 * (speed, accuracy, restraint, tone warmth, mirroring, drift, risk), so a batch of bot sessions has the
 * between-person variance the scoring engine's hierarchical models need. It is a test fixture, not a
 * model of real players.
 */
import type { Clock, Point, SeededRng } from '../../core/contracts.ts';
import type { PointerSample } from '../../input/input-service.ts';
import type { StallGeometry } from './layout.ts';
import type { ProbeCode, ProbeTrial, ServeTrial, ToneCode, ToneTrial } from './schedule.ts';

/** Anything that accepts injected pointer samples (the engine's `DomInputService`). */
export interface PointerInjector {
  inject(sample: PointerSample): void;
}

/** Person-level parameters of the bot. */
export interface StallBotPolicy {
  /** Median go RT (ms) outside the rush. */
  readonly rtMedianMs: number;
  /** Log-normal spread of RTs. */
  readonly rtSigma: number;
  /** RT multiplier under the timed rush (< 1 = hurries). */
  readonly rushRtFactor: number;
  /** Probability of serving a fresh item (go hit) when the RT fits the window. */
  readonly hitRate: number;
  /** Probability of serving a spoiled item (commission) outside the rush. */
  readonly commission: number;
  /** Added commission probability under the rush. */
  readonly rushCommission: number;
  /** Expected premature taps per trial (during the customer's approach). */
  readonly prematureRate: number;
  /** Probability of an extra tap after a serve. */
  readonly extraRate: number;
  /** Accuracy lapse (probability) on the trials right after scripted negative feedback. */
  readonly feedbackLapse: number;
  /** Tone warmth location (latent units; thresholds at 0.5 and 1.5). */
  readonly toneLocation: number;
  /** Mirroring: drop in warmth per customer tone level. */
  readonly mirroring: number;
  /** Drift over the rude run (latent units per 10 trials; negative = deteriorates). */
  readonly drift: number;
  /** Median tone decision time after the customer's line ends (ms). */
  readonly toneRtMs: number;
  /** Probability of a barge-in (answering before the customer finishes). */
  readonly bargeIn: number;
  /** Probability of picking the risky probe offer. */
  readonly risk: number;
  /** Median probe pick time (ms). */
  readonly probeRtMs: number;
}

/** A typical player. */
export const MEDIAN_STALL_BOT: StallBotPolicy = {
  rtMedianMs: 520,
  rtSigma: 0.22,
  rushRtFactor: 0.88,
  hitRate: 0.95,
  commission: 0.18,
  rushCommission: 0.12,
  prematureRate: 0.06,
  extraRate: 0.08,
  feedbackLapse: 0.08,
  toneLocation: 1.25,
  mirroring: 0.3,
  drift: -0.2,
  toneRtMs: 900,
  bargeIn: 0.1,
  risk: 0.4,
  probeRtMs: 620,
};

/** Draw a person-level policy around {@link MEDIAN_STALL_BOT} from a seeded stream. */
export function sampleStallBotPolicy(rng: SeededRng): StallBotPolicy {
  const n = (): number => {
    // Box-Muller from the seeded stream.
    const u = Math.max(1e-9, rng.next());
    const v = rng.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
  const m = MEDIAN_STALL_BOT;
  return {
    rtMedianMs: clamp(m.rtMedianMs * Math.exp(0.15 * n()), 330, 900),
    rtSigma: clamp(m.rtSigma * Math.exp(0.25 * n()), 0.1, 0.45),
    rushRtFactor: clamp(m.rushRtFactor + 0.06 * n(), 0.7, 1.05),
    hitRate: clamp(m.hitRate + 0.03 * n(), 0.8, 0.995),
    commission: clamp(m.commission + 0.1 * n(), 0.02, 0.6),
    rushCommission: clamp(m.rushCommission + 0.08 * n(), -0.05, 0.4),
    prematureRate: clamp(m.prematureRate * Math.exp(0.6 * n()), 0.005, 0.4),
    extraRate: clamp(m.extraRate * Math.exp(0.6 * n()), 0.005, 0.5),
    feedbackLapse: clamp(m.feedbackLapse + 0.06 * n(), 0, 0.35),
    toneLocation: m.toneLocation + 0.45 * n(),
    mirroring: clamp(m.mirroring + 0.18 * n(), -0.1, 0.9),
    drift: m.drift + 0.35 * n(),
    toneRtMs: clamp(m.toneRtMs * Math.exp(0.25 * n()), 350, 3000),
    bargeIn: clamp(m.bargeIn + 0.08 * n(), 0, 0.4),
    risk: clamp(m.risk + 0.2 * n(), 0.05, 0.95),
    probeRtMs: clamp(m.probeRtMs * Math.exp(0.15 * n()), 380, 1000),
  };
}

/** The scripted bot. One instance per module run. */
export class StallBot {
  private sinceFeedback = Number.POSITIVE_INFINITY;
  private pointerId = 100;

  constructor(
    private readonly policy: StallBotPolicy,
    private readonly rng: SeededRng,
    private readonly clock: Clock,
    private readonly injector: PointerInjector,
    private readonly geometry: StallGeometry,
  ) {}

  /** During the customer's approach: occasional premature taps on the plate. */
  async approach(isiMs: number, signal: AbortSignal): Promise<void> {
    if (!this.rng.bool(Math.min(0.95, this.policy.prematureRate))) return;
    const at = this.rng.next() * Math.max(0, isiMs - 40);
    await this.after(at, signal);
    this.tap(this.geometry.plate.center);
  }

  /** Answer a serving trial; resolves when the bot is done tapping. */
  async serve(trial: ServeTrial, windowMs: number, signal: AbortSignal): Promise<void> {
    const p = this.policy;
    const lapse = this.sinceFeedback <= 3 ? p.feedbackLapse : 0;
    this.sinceFeedback = trial.feedback === 'negative' ? 1 : this.sinceFeedback + 1;
    const rt = this.logNormal(p.rtMedianMs * (trial.rush ? p.rushRtFactor : 1), p.rtSigma);
    let respond: boolean;
    if (trial.trialType === 'go') respond = this.rng.bool(Math.max(0, p.hitRate - lapse));
    else
      respond = this.rng.bool(
        Math.min(0.95, Math.max(0, p.commission + (trial.rush ? p.rushCommission : 0) + lapse)),
      );
    if (!respond || rt >= windowMs) return;
    await this.after(rt, signal);
    this.tap(this.geometry.plate.center);
    if (this.rng.bool(p.extraRate)) {
      await this.after(60 + this.rng.next() * 120, signal);
      this.tap(this.geometry.plate.center);
    }
  }

  /** Answer a tone trial: barge in sometimes, otherwise answer after the line ends. */
  async tone(
    trial: ToneTrial,
    codes: readonly ToneCode[],
    audioEnd: Promise<number>,
    runPosition: number | null,
    signal: AbortSignal,
  ): Promise<void> {
    const p = this.policy;
    const logistic = (): number => {
      const u = Math.min(1 - 1e-9, Math.max(1e-9, this.rng.next()));
      return 0.5 * Math.log(u / (1 - u));
    };
    let latent = p.toneLocation - p.mirroring * (trial.toneLevel - 2) + logistic();
    if (runPosition !== null) latent += (p.drift * runPosition) / 10;
    const code: ToneCode = latent < 0.5 ? 'firm' : latent < 1.5 ? 'neutral' : 'warm';
    const index = codes.indexOf(code);
    const face = this.geometry.toneFaces[index >= 0 ? index : 1];
    if (!face) return;
    if (this.rng.bool(p.bargeIn)) {
      await this.after(250 + this.rng.next() * 300, signal);
    } else {
      await this.race(audioEnd, signal);
      await this.after(this.logNormal(p.toneRtMs, 0.3), signal);
    }
    this.tap(face.center);
  }

  /** Answer a probe within its window. */
  async probe(
    _trial: ProbeTrial,
    codes: readonly ProbeCode[],
    windowMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    const p = this.policy;
    const code: ProbeCode = this.rng.bool(p.risk) ? 'risky' : 'safe';
    const rt = this.logNormal(p.probeRtMs, 0.25);
    if (rt >= windowMs) return;
    const target = this.geometry.probes[codes.indexOf(code)];
    if (!target) return;
    await this.after(rt, signal);
    this.tap(target.center);
  }

  private logNormal(median: number, sigma: number): number {
    const u = Math.max(1e-9, this.rng.next());
    const v = this.rng.next();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return median * Math.exp(sigma * z);
  }

  private after(ms: number, signal: AbortSignal): Promise<void> {
    return this.clock.delay(Math.max(0, ms), signal);
  }

  private race<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const onAbort = (): void => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      p.then(
        (v) => {
          signal.removeEventListener('abort', onAbort);
          resolve(v);
        },
        (e: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(e);
        },
      );
    });
  }

  private tap(point: Point): void {
    const jitter = 6 * this.geometry.unit;
    const x = point.x + (this.rng.next() - 0.5) * jitter;
    const y = point.y + (this.rng.next() - 0.5) * jitter;
    const t = this.clock.anchorPerfMs + this.clock.now() + this.clock.profile.touchOffsetMs;
    const id = this.pointerId++;
    const base = {
      pointerId: id,
      clientX: x,
      clientY: y,
      pointerType: 'touch' as const,
      width: 8,
      height: 8,
    };
    this.injector.inject({ ...base, kind: 'down', timeStamp: t });
    this.injector.inject({ ...base, kind: 'up', timeStamp: t + 60 });
  }
}
