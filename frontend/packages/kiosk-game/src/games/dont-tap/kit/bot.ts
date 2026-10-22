/**
 * Headless scripted bot (ENG-05 AC: any module runs headlessly with a scripted bot). The bot never
 * decides inside game logic: it injects pointer samples through the engine's input layer (the same
 * path a finger takes), so raw taps, holds, latencies and classifications are produced by the real
 * code. Persona parameters are seeded from `ctx.rng.stream('bot')`, so a seed reproduces a run.
 */
import type { ModuleContext, Point, Rect, SeededRng } from '../../../core/contracts.ts';
import type { KitInput } from './types.ts';

/** Behavioural knobs of a scripted player (all probabilities 0..1, times in ms). */
export interface BotPersona {
  /** Median latency of speeded responses. */
  readonly rtMs: number;
  /** Log-normal spread of latencies. */
  readonly rtSd: number;
  /** Probability of a correct response on rule-based trials. */
  readonly accuracy: number;
  /** Probability of responding on a no-go trial (commission). */
  readonly commission: number;
  /** Rate (per trial) of an extra tap after the response. */
  readonly extraTapRate: number;
  /** Rate (per trial) of an anticipatory tap during the ISI. */
  readonly prematureRate: number;
  /** Risk appetite 0 (cautious) .. 1 (bold): balloon pumps, probe choices. */
  readonly risk: number;
  /** Patience 0..1: wait/hard choices, time on unsolvable items. */
  readonly patience: number;
  /** Deliberation before self-paced choices. */
  readonly thinkMs: number;
}

/** Median scripted player used by the playthrough checks. */
export const MEDIAN_PERSONA: BotPersona = {
  rtMs: 430,
  rtSd: 0.22,
  accuracy: 0.86,
  commission: 0.22,
  extraTapRate: 0.06,
  prematureRate: 0.04,
  risk: 0.5,
  patience: 0.55,
  thinkMs: 1400,
};

/** Draw a persona around the median (population variation for multi-session checks). */
export function samplePersona(rng: SeededRng): BotPersona {
  const n = (): number => {
    // Box-Muller from the seeded stream (deterministic).
    const u = Math.max(1e-9, rng.next());
    const v = rng.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const clamp01 = (x: number): number => Math.min(0.98, Math.max(0.02, x));
  return {
    rtMs: Math.max(260, MEDIAN_PERSONA.rtMs * Math.exp(0.18 * n())),
    rtSd: Math.max(0.08, MEDIAN_PERSONA.rtSd * Math.exp(0.25 * n())),
    accuracy: clamp01(MEDIAN_PERSONA.accuracy + 0.07 * n()),
    commission: clamp01(MEDIAN_PERSONA.commission + 0.1 * n()),
    extraTapRate: clamp01(MEDIAN_PERSONA.extraTapRate * Math.exp(0.5 * n())),
    prematureRate: clamp01(MEDIAN_PERSONA.prematureRate * Math.exp(0.5 * n())),
    risk: clamp01(MEDIAN_PERSONA.risk + 0.18 * n()),
    patience: clamp01(MEDIAN_PERSONA.patience + 0.18 * n()),
    thinkMs: Math.max(500, MEDIAN_PERSONA.thinkMs * Math.exp(0.3 * n())),
  };
}

/** Centre of a rect. */
export function centreOf(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** Injects taps and holds at session times. */
export class BotDriver {
  readonly persona: BotPersona;
  readonly rng: SeededRng;
  private readonly ctx: ModuleContext;
  private readonly input: KitInput;
  private pointerId = 100;
  private readonly timers = new Set<AbortController>();

  constructor(ctx: ModuleContext, persona?: BotPersona) {
    this.ctx = ctx;
    this.input = ctx.input as KitInput;
    this.rng = ctx.rng.stream('bot');
    this.persona = persona ?? MEDIAN_PERSONA;
  }

  /** True when the engine input supports injection (always, for `DomInputService`). */
  get available(): boolean {
    return typeof this.input.inject === 'function';
  }

  /** A log-normal latency around `medianMs` with the persona's spread. */
  latency(medianMs = this.persona.rtMs, floorMs = 120): number {
    const u = Math.max(1e-9, this.rng.next());
    const v = this.rng.next();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return Math.max(floorMs, medianMs * Math.exp(this.persona.rtSd * z));
  }

  chance(p: number): boolean {
    return this.rng.next() < p;
  }

  /** Tap at `point` now. */
  tapNow(point: Point): void {
    if (!this.input.inject) return;
    const id = this.pointerId++;
    const ts = this.ctx.clock.anchorPerfMs + this.ctx.clock.now();
    this.input.inject({
      kind: 'down',
      pointerId: id,
      clientX: point.x,
      clientY: point.y,
      timeStamp: ts,
      pointerType: 'touch',
    });
    this.input.inject({
      kind: 'up',
      pointerId: id,
      clientX: point.x,
      clientY: point.y,
      timeStamp: ts + 60,
      pointerType: 'touch',
    });
  }

  /** Tap at `point` after `delayMs` (cancelled on abort or {@link cancelAll}). */
  tapAfter(point: Point, delayMs: number): Promise<void> {
    return this.after(delayMs, () => this.tapNow(point));
  }

  /** Press at `point` after `delayMs` and release `holdMs` later. */
  holdAfter(point: Point, delayMs: number, holdMs: number): Promise<void> {
    if (!this.input.inject) return Promise.resolve();
    const id = this.pointerId++;
    return this.after(delayMs, () => {
      const ts = this.ctx.clock.anchorPerfMs + this.ctx.clock.now();
      this.input.inject?.({
        kind: 'down',
        pointerId: id,
        clientX: point.x,
        clientY: point.y,
        timeStamp: ts,
        pointerType: 'touch',
      });
    }).then(() =>
      this.after(holdMs, () => {
        const ts = this.ctx.clock.anchorPerfMs + this.ctx.clock.now();
        this.input.inject?.({
          kind: 'up',
          pointerId: id,
          clientX: point.x,
          clientY: point.y,
          timeStamp: ts,
          pointerType: 'touch',
        });
      }),
    );
  }

  /** Cancel every pending injection (end of trial). */
  cancelAll(): void {
    for (const t of this.timers) t.abort();
    this.timers.clear();
  }

  private after(delayMs: number, fn: () => void): Promise<void> {
    const ac = new AbortController();
    this.timers.add(ac);
    const onAbort = (): void => ac.abort();
    this.ctx.signal.addEventListener('abort', onAbort, { once: true });
    return this.ctx.clock.delay(Math.max(0, delayMs), ac.signal).then(
      () => {
        this.timers.delete(ac);
        this.ctx.signal.removeEventListener('abort', onAbort);
        fn();
      },
      () => {
        this.timers.delete(ac);
        this.ctx.signal.removeEventListener('abort', onAbort);
      },
    );
  }
}
