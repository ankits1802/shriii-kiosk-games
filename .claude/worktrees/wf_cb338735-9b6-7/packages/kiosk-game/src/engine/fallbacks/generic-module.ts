/**
 * Generic, config-driven fallback module. It runs any module config through the real engine path
 * (seeded schedule → trial_start → stimulus_onset on the next frame → response/timeout → trial_end)
 * with one large icon target per trial, so the kiosk is playable end to end and every module's
 * logging contract can be exercised before its bespoke implementation exists. In `dev.headless`
 * mode a seeded scripted bot answers instead of the player (ENG-05: any module runs headlessly).
 *
 * It is a stand-in, not a paradigm implementation: it never claims to measure the module's construct
 * (the trials are real, scorable-flagged events, but the stimuli are placeholders).
 */
import type { ContextShiftPayload, GameTrialSpec } from '@shriii/contracts';
import type {
  ConstructId,
  GameModule,
  IndicatorId,
  ModuleContext,
  ModuleId,
  ModuleResult,
  Rect,
  TargetHandle,
  UiButton,
} from '../../core/contracts.ts';
import { abortReasonOf } from '../../core/contracts.ts';
import { DataDrivenTrialScheduler, type ScheduleResult } from '../scheduler.ts';
import { presentStimulus } from '../timing.ts';

const SHIFT_KINDS: ReadonlySet<string> = new Set<ContextShiftPayload['kind']>([
  'rule_switch',
  'rule_reversal',
  'pressure_on',
  'pressure_off',
  'rude_customer_run',
  'new_market_rule',
  'route_blocked',
  'partner_error',
  'held_block',
  'free_block',
]);

/** Scripted bot behaviour for headless runs. */
export interface BotPolicy {
  /** Median response latency (ms). */
  readonly latencyMs: number;
  /** Probability of a correct response. */
  readonly accuracy: number;
}

export const MEDIAN_BOT: BotPolicy = { latencyMs: 450, accuracy: 0.9 };

export class GenericModule implements GameModule {
  readonly id: ModuleId;
  readonly kind: 'micro' | 'episode' | 'warmup';
  readonly constructs: readonly ConstructId[];
  readonly indicators: readonly IndicatorId[];
  private ctx: ModuleContext | null = null;
  private schedule: ScheduleResult | null = null;
  private button: UiButton | null = null;
  private target: TargetHandle | null = null;
  private readonly bot: BotPolicy;

  constructor(
    id: ModuleId,
    kind: 'micro' | 'episode' | 'warmup',
    constructs: readonly ConstructId[] = [],
    indicators: readonly IndicatorId[] = [],
    bot: BotPolicy = MEDIAN_BOT,
  ) {
    this.id = id;
    this.kind = kind;
    this.constructs = constructs;
    this.indicators = indicators;
    this.bot = bot;
  }

  async init(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
    this.schedule = new DataDrivenTrialScheduler().build(
      ctx.config,
      ctx.level,
      ctx.rng.stream('schedule'),
      ctx.session.formId,
    );
    if (!ctx.dev.headless) {
      const sizeMm = 40;
      const px = sizeMm * ctx.layout.metrics.pxPerMm;
      const sa = ctx.layout.safeArea;
      // Targets live in the lower two-thirds of the screen (KSK-06).
      const bounds: Rect = {
        x: sa.x + sa.width / 2 - px / 2,
        y: sa.y + sa.height * (2 / 3) - px / 2,
        width: px,
        height: px,
      };
      this.button = ctx.art.createButton({
        id: `${this.id}.target`,
        iconId: 'hand',
        audioKey: `${this.id}.replay`,
        variant: 'primary',
        sizeMm,
      });
      this.button.view.position.set(bounds.x + px / 2, bounds.y + px / 2);
      this.button.view.visible = false;
      ctx.stage.addChild(this.button.view);
      this.target = ctx.input.registerTarget({
        id: `${this.id}.target`,
        bounds,
        audioKey: `${this.id}.replay`,
        kind: 'tap',
        enabled: false,
      });
    }
  }

  async run(): Promise<ModuleResult> {
    const ctx = this.ctx;
    const schedule = this.schedule;
    if (!ctx || !schedule) throw new Error('GenericModule.run before init');
    const startMs = ctx.clock.now();
    const intro = ctx.config.audio_keys.find((k) => k.endsWith('.intro'));
    if (intro) await ctx.voice.play(intro, { signal: ctx.signal }).ended;
    let completed = 0;
    let scorable = 0;
    const softCap = ctx.config.budget.soft_cap_ms;
    const blockMin = new Map(ctx.config.blocks.map((b) => [b.block_id, b.min_trials] as const));
    const doneInBlock = new Map<string, number>();
    const botRng = ctx.rng.stream('bot');

    for (const trial of schedule.trials) {
      if (ctx.signal.aborted) break;
      const inBlock = doneInBlock.get(trial.block_id) ?? 0;
      // Soft cap: graceful wrap-up keeps each block's minimum (ENG-05).
      if (ctx.clock.now() - startMs > softCap && inBlock >= (blockMin.get(trial.block_id) ?? 0))
        continue;
      const outcome = await this.runTrial(ctx, trial, schedule, botRng);
      if (outcome === 'aborted') break;
      completed += 1;
      if (trial.scorable) scorable += 1;
      doneInBlock.set(trial.block_id, inBlock + 1);
    }
    const reason = abortReasonOf(ctx.signal);
    return {
      moduleId: this.id,
      endedReason: reason ? (reason.kind === 'crash' ? 'error' : reason.kind) : 'completed',
      durationMs: ctx.clock.now() - startMs,
      trialsCompleted: completed,
      scorableTrials: scorable,
      contextShiftIndex: schedule.contextShiftIndex,
    };
  }

  private async runTrial(
    ctx: ModuleContext,
    trial: GameTrialSpec,
    schedule: ScheduleResult,
    botRng: ModuleContext['rng'],
  ): Promise<'done' | 'aborted'> {
    const block = ctx.config.blocks.find((b) => b.block_id === trial.block_id);
    const task = {
      episode_id: trial.episode_id,
      module_id: trial.module_id,
      block_id: trial.block_id,
      trial_id: trial.trial_id,
      trial_index: trial.trial_index,
      probe_group_id: trial.probe_group_id,
      form_id: trial.form_id,
      anchor_trial: trial.anchor_trial,
    };
    const condition = {
      phase: trial.phase,
      condition_id: trial.condition_id,
      shift_active: block?.conditions.shift_active ?? false,
      timer: block?.conditions.timer ?? false,
      noise: block?.conditions.noise ?? false,
      calibration_level: trial.calibration_level,
      variant_seed: String((trial.params as { variant?: number }).variant ?? 0),
    };
    const log = ctx.logger.child({ task, condition, scorable: trial.scorable });
    const trialStart = ctx.clock.now();
    const params = trial.params as { context_shift?: boolean };
    const shiftKind = schedule.contextShiftKind;
    if (
      params.context_shift &&
      shiftKind &&
      SHIFT_KINDS.has(shiftKind) &&
      ctx.config.context_shift
    ) {
      log.log('context_shift', {
        kind: shiftKind as ContextShiftPayload['kind'],
        announced: ctx.config.context_shift.announced,
        shift_index: trial.trial_index,
      });
    }
    log.log('trial_start', {
      trial_type: trial.trial_type,
      stimulus_id: trial.stimulus_id,
      response_window_ms: trial.response_window_ms,
      private_report: trial.private_report,
      expected_response: trial.expected_response,
    });

    const stimulusId = trial.stimulus_id ?? `${trial.module_id}.${trial.trial_type}`;
    const button = this.button;
    const presented = await presentStimulus(ctx.clock, () => {
      if (button) button.view.visible = true;
      this.target?.setEnabled(true);
    });
    log.log(
      'stimulus_onset',
      {
        stimulus_id: stimulusId,
        stimulus_version: 'generic.1',
        requested_onset_ms: presented.requestedOnsetMs,
        presented_onset_ms: presented.presentedOnsetMs,
        audio_onset_ms: null,
        onset_source: 'raf_commit',
        duration_ms: trial.timing.stimulus_duration_ms,
      },
      { timingFlag: presented.timingFlag },
    );

    const isHold = trial.trial_type === 'hold' || trial.trial_type.startsWith('hold_');
    const window = trial.response_window_ms;
    let responded = false;
    let latency: number | null = null;
    let xy: readonly [number, number] | null = null;
    let holdMs: number | null = null;
    if (ctx.dev.headless) {
      const wantsTap = trial.expected_response !== 'no_tap';
      const correct = botRng.bool(this.bot.accuracy);
      const respond = wantsTap ? correct : !correct;
      const l = Math.max(120, this.bot.latencyMs * (0.7 + botRng.next() * 0.6));
      const wait = window !== null ? Math.min(l, window + 1) : l;
      try {
        await ctx.clock.delay(wait, ctx.signal);
      } catch {
        return this.endAborted(log, trialStart);
      }
      if (respond && (window === null || l <= window)) {
        responded = true;
        latency = Math.round(l);
        xy = [0.5, 0.67];
        if (isHold) {
          const required = ctx.levelConfig.timing.hold_required_ms ?? 1000;
          holdMs = required * (correct ? 1.1 : 0.5);
          log.log('input.hold', {
            target_id: `${this.id}.target`,
            hold_ms: holdMs,
            required_hold_ms: required,
            completed: holdMs >= required,
          });
        }
      }
    } else if (isHold && this.target) {
      const r = await ctx.input.waitForHold(this.target.id, {
        requiredMs: ctx.levelConfig.timing.hold_required_ms ?? 1000,
        windowMs: window,
        signal: ctx.signal,
      });
      if (r.kind === 'aborted') return this.endAborted(log, trialStart);
      if (r.kind === 'hold') {
        responded = true;
        latency = Math.round((r.startMs - presented.presentedOnsetMs) * 1000) / 1000;
        holdMs = r.holdMs;
      }
    } else if (this.target) {
      const r = await ctx.input.waitForTap([this.target.id], {
        anchorMs: presented.presentedOnsetMs,
        windowMs: window,
        signal: ctx.signal,
      });
      if (r.kind === 'aborted') return this.endAborted(log, trialStart);
      if (r.kind === 'tap') {
        responded = true;
        latency = r.latencyMs;
        xy = r.tap.xyNorm;
      }
    }
    if (button) button.view.visible = false;
    this.target?.setEnabled(false);

    const expected = trial.expected_response;
    const value = responded ? (isHold ? 'hold' : 'tap') : null;
    const requiredHold = ctx.levelConfig.timing.hold_required_ms ?? 0;
    const holdOk = isHold && holdMs !== null ? holdMs >= requiredHold : true;
    let correctness: boolean | null;
    let outcome: 'correct' | 'incorrect' | 'omission' | 'commission' | 'timeout' | 'not_applicable';
    if (expected === 'no_tap') {
      correctness = !responded;
      outcome = responded ? 'commission' : 'correct';
    } else if (expected === 'tap' || expected === 'hold') {
      correctness = responded && holdOk;
      outcome = responded ? (correctness ? 'correct' : 'incorrect') : 'omission';
    } else {
      correctness = null;
      outcome = responded ? 'not_applicable' : 'timeout';
    }
    log.log(
      'response',
      {
        stimulus_id: stimulusId,
        response_value: value,
        correctness: responded ? correctness : null,
        input_mode: responded ? 'touch' : 'timeout',
        latency_ms: responded ? latency : null,
        latency_anchor: 'visual_onset',
        barge_in: responded && latency !== null && latency < 0,
        hold_ms: holdMs,
        tap_count: responded ? 1 : 0,
        revisions: [],
        touch_xy_norm: xy ? [xy[0], xy[1]] : null,
      },
      { timingFlag: presented.timingFlag },
    );
    log.log('trial_end', {
      outcome,
      correctness,
      response_count: responded ? 1 : 0,
      duration_ms: Math.round((ctx.clock.now() - trialStart) * 1000) / 1000,
    });
    const isi = Math.max(0, (trial.timing.isi_ms ?? 300) + (trial.timing.jitter_ms ?? 0));
    (ctx.input as { markIsi?: () => void }).markIsi?.();
    try {
      await ctx.clock.delay(isi, ctx.signal);
    } catch {
      return 'aborted';
    }
    return 'done';
  }

  private endAborted(log: ModuleContext['logger'], trialStart: number): 'aborted' {
    if (this.button) this.button.view.visible = false;
    this.target?.setEnabled(false);
    log.log(
      'trial_end',
      {
        outcome: 'aborted',
        correctness: null,
        response_count: 0,
        duration_ms: Math.round((this.ctx?.clock.now() ?? trialStart) - trialStart),
      },
      { interrupted: true },
    );
    return 'aborted';
  }

  destroy(): void {
    this.target?.remove();
    this.target = null;
    this.button?.destroy();
    this.button = null;
  }
}

/** Fallback factory for {@link ModuleHost}: a generic module for any configured module id. */
export function genericModuleFallback(
  content: {
    has(id: ModuleId): boolean;
    get(id: ModuleId): {
      kind: 'micro' | 'episode' | 'warmup';
      constructs: ConstructId[];
      indicators: string[];
    };
  },
  bot?: BotPolicy,
): (id: ModuleId) => GameModule | null {
  return (id) => {
    if (!content.has(id)) return null;
    const c = content.get(id);
    return new GenericModule(id, c.kind, c.constructs, c.indicators as IndicatorId[], bot);
  };
}
