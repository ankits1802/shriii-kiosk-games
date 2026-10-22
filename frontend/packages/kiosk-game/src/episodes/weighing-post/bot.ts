/**
 * Scripted bot for headless and screenshot runs (ENG-05). The bot taps through the SAME input path as a
 * player: pointer samples are injected into the input layer at the centre of the target's rect, so
 * `input.raw_tap` classification, revisions, inspections and latencies are produced by the real code.
 *
 * The bot cannot see the private luck die (nothing in the module can): its luck reports follow its own
 * policy (uniform by default), never the drawn face.
 */
import type { Application } from 'pixi.js';
import type { Clock, InputService, Rect, SeededRng } from '../../core/contracts.ts';
import type { WeighDecision } from '../../paradigms/weighing-post.ts';
import type { ChoiceAnchor } from './decision.ts';
import type { EpisodeTrial } from './schedule.ts';

/** Pointer sample accepted by the engine's DOM input service (`DomInputService.inject`). */
interface InjectableInput {
  inject(sample: {
    readonly kind: 'down' | 'up' | 'cancel';
    readonly pointerId: number;
    readonly clientX: number;
    readonly clientY: number;
    readonly timeStamp: number;
    readonly pointerType: 'touch' | 'pen' | 'mouse';
    readonly width?: number;
    readonly height?: number;
  }): void;
}

function isInjectable(input: InputService): input is InputService & InjectableInput {
  return typeof (input as Partial<InjectableInput>).inject === 'function';
}

/** Bot behaviour (probabilities and timing). */
export interface BotPolicy {
  /** Median decision latency from the anchor (ms). */
  readonly decisionMs: number;
  /** Log-normal spread of decision latencies. */
  readonly decisionLogSd: number;
  readonly weighAccuracy: number;
  /** Probability of inspecting an ambiguous reading before deciding. */
  readonly inspectAmbiguous: number;
  /** Probability of an extra (unneeded) inspection. */
  readonly inspectExtra: number;
  /** Probability of changing the selection once before confirming. */
  readonly revise: number;
  readonly bribeAccept: number;
  readonly overpaymentReturn: number;
  readonly blameWeights: Readonly<Record<'self' | 'assistant' | 'shared' | 'chance', number>>;
  readonly creditWeights: Readonly<Record<'self' | 'assistant' | 'shared', number>>;
  readonly gamble: number;
  /** Probability of reporting the top face regardless of the roll (group-level over-report). */
  readonly overReport: number;
  readonly probeRisky: number;
  readonly probeMs: number;
}

export const MEDIAN_BOT: BotPolicy = {
  decisionMs: 1150,
  decisionLogSd: 0.3,
  weighAccuracy: 0.85,
  inspectAmbiguous: 0.85,
  inspectExtra: 0.08,
  revise: 0.18,
  bribeAccept: 0.25,
  overpaymentReturn: 0.7,
  blameWeights: { self: 0.5, assistant: 0.2, shared: 0.2, chance: 0.1 },
  creditWeights: { self: 0.3, assistant: 0.3, shared: 0.4 },
  gamble: 0.5,
  overReport: 0.2,
  probeRisky: 0.5,
  probeMs: 560,
};

/** A plan of taps for one choice. */
export interface BotScript {
  /** Target ids in order with the delay before each (ms). */
  readonly steps: readonly { readonly targetId: string; readonly afterMs: number }[];
}

export class WeighingBot {
  private readonly rng: SeededRng;
  private readonly policy: BotPolicy;
  private readonly input: InputService;
  private readonly clock: Clock;
  private readonly app: Application;
  private readonly stageSize: () => { width: number; height: number };
  private pointerId = 900;

  constructor(opts: {
    readonly rng: SeededRng;
    readonly input: InputService;
    readonly clock: Clock;
    readonly app: Application;
    readonly stageSize: () => { width: number; height: number };
    readonly policy?: BotPolicy;
  }) {
    this.rng = opts.rng;
    this.input = opts.input;
    this.clock = opts.clock;
    this.app = opts.app;
    this.stageSize = opts.stageSize;
    this.policy = opts.policy ?? MEDIAN_BOT;
  }

  /** True when the input layer accepts injected pointer samples. */
  get canTap(): boolean {
    return isInjectable(this.input);
  }

  private latency(medianMs: number, sd: number): number {
    // Box-Muller on the seeded stream.
    const u1 = Math.max(1e-9, this.rng.next());
    const u2 = this.rng.next();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.max(220, medianMs * Math.exp(sd * z));
  }

  private weighted<K extends string>(weights: Readonly<Record<K, number>>): K {
    const keys = Object.keys(weights) as K[];
    return this.rng.weighted(
      keys,
      keys.map((k) => weights[k]),
    );
  }

  /** Decide the committed code and the tap script for a trial. */
  script(
    trial: EpisodeTrial,
    ids: {
      readonly option: (code: string) => string;
      readonly confirm: string;
      readonly inspect: string;
    },
  ): BotScript {
    const p = this.policy;
    const t = this.latency(p.decisionMs, p.decisionLogSd);
    const steps: { targetId: string; afterMs: number }[] = [];
    const confirmGap = (): number => 180 + this.rng.int(0, 220);
    switch (trial.kind) {
      case 'weigh': {
        const all: WeighDecision[] = ['approve', 'warn', 'fine'];
        let lead = t * 0.45;
        if (trial.item.ambiguous && this.rng.bool(p.inspectAmbiguous)) {
          steps.push({ targetId: ids.inspect, afterMs: lead });
          lead = 900 + this.rng.int(0, 300);
        }
        if (this.rng.bool(p.inspectExtra)) {
          steps.push({ targetId: ids.inspect, afterMs: lead });
          lead = 900 + this.rng.int(0, 300);
        }
        const code = this.rng.bool(p.weighAccuracy)
          ? trial.expected
          : this.rng.pick(all.filter((c) => c !== trial.expected));
        if (this.rng.bool(p.revise)) {
          steps.push({
            targetId: ids.option(this.rng.pick(all.filter((c) => c !== code))),
            afterMs: lead,
          });
          lead = 260 + this.rng.int(0, 260);
        }
        steps.push({ targetId: ids.option(code), afterMs: steps.length ? lead : t });
        steps.push({ targetId: ids.confirm, afterMs: confirmGap() });
        return { steps };
      }
      case 'bribe':
      case 'overpayment':
      case 'assistant_mistake':
      case 'fraud_found': {
        let code: string;
        if (trial.kind === 'bribe') code = this.rng.bool(p.bribeAccept) ? 'accept' : 'decline';
        else if (trial.kind === 'overpayment')
          code = this.rng.bool(p.overpaymentReturn) ? 'return' : 'keep';
        else if (trial.kind === 'assistant_mistake') code = this.weighted(p.blameWeights);
        else code = this.weighted(p.creditWeights);
        if (this.rng.bool(p.revise * 0.5)) {
          const other = this.rng.pick(trial.codes.filter((c) => c !== code));
          steps.push({ targetId: ids.option(other), afterMs: t * 0.6 });
          steps.push({ targetId: ids.option(code), afterMs: 300 + this.rng.int(0, 300) });
        } else {
          steps.push({ targetId: ids.option(code), afterMs: t * 1.25 });
        }
        steps.push({ targetId: ids.confirm, afterMs: confirmGap() });
        return { steps };
      }
      case 'gamble':
        steps.push({
          targetId: ids.option(this.rng.bool(p.gamble) ? 'gamble' : 'inspect'),
          afterMs: t,
        });
        steps.push({ targetId: ids.confirm, afterMs: confirmGap() });
        return { steps };
      case 'luck': {
        const face = this.rng.bool(p.overReport) ? trial.faces : this.rng.int(1, trial.faces);
        steps.push({ targetId: ids.option(`face_${face}`), afterMs: 700 + this.rng.int(0, 500) });
        return { steps };
      }
      case 'probe':
        steps.push({
          targetId: ids.option(this.rng.bool(p.probeRisky) ? 'risky' : 'safe'),
          afterMs: Math.min(1000, this.latency(p.probeMs, 0.2)),
        });
        return { steps };
      default: {
        const never: never = trial;
        throw new Error(`bot: unknown trial ${String(never)}`);
      }
    }
  }

  /**
   * Play a script once the anchor is known. `rectOf` resolves a target id to its stage rect at tap
   * time. Resolves after the last tap (or on abort).
   */
  async play(
    script: BotScript,
    anchor: Promise<ChoiceAnchor>,
    rectOf: (targetId: string) => Rect | null,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.canTap) return;
    try {
      await anchor;
      for (const step of script.steps) {
        await this.clock.delay(step.afterMs, signal);
        const rect = rectOf(step.targetId);
        if (rect) this.tapAt(rect);
      }
    } catch {
      // aborted: nothing to clean up
    }
  }

  /** Inject one tap at the centre of a stage rect (small seeded jitter). */
  tapAt(rect: Rect): void {
    if (!isInjectable(this.input)) return;
    const sx = rect.x + rect.width * (0.5 + (this.rng.next() - 0.5) * 0.3);
    const sy = rect.y + rect.height * (0.5 + (this.rng.next() - 0.5) * 0.3);
    const { clientX, clientY } = this.toClient(sx, sy);
    const id = this.pointerId++;
    const ts = this.clock.anchorPerfMs + this.clock.now() + this.clock.profile.touchOffsetMs;
    const base = {
      pointerId: id,
      clientX,
      clientY,
      pointerType: 'touch' as const,
      width: 9,
      height: 9,
    };
    this.input.inject({ ...base, kind: 'down', timeStamp: ts });
    this.input.inject({ ...base, kind: 'up', timeStamp: ts + 70 });
  }

  private toClient(x: number, y: number): { clientX: number; clientY: number } {
    const canvas = (this.app as Partial<Application>).canvas as HTMLCanvasElement | undefined;
    if (canvas && typeof canvas.getBoundingClientRect === 'function') {
      const r = canvas.getBoundingClientRect();
      const size = this.stageSize();
      if (r.width > 0 && r.height > 0 && size.width > 0 && size.height > 0) {
        return {
          clientX: r.left + (x * r.width) / size.width,
          clientY: r.top + (y * r.height) / size.height,
        };
      }
    }
    return { clientX: x, clientY: y };
  }
}
