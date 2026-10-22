/**
 * Trial recorder: every trial-level event of a kit module goes through here so the envelope, the
 * scorer conventions and the timing rules are applied in exactly one place.
 *
 * Per trial: (`context_shift`) -> `trial_start` -> `stimulus_onset` (frame-committed) -> `response`
 * (one committed response, timeouts included) -> `trial_end`. While a trial is open the input layer's
 * `input.raw_tap` / `input.hold` logging is routed to the trial-scoped logger, so taps (premature,
 * extra, during the ISI) carry the trial's `task.trial_id` and attach to it in the scorer. The
 * routing lasts until {@link ActiveTrial.release} (after the ISI that follows the trial).
 *
 * The recorder also keeps `trial_id -> GameTrialSpec.params` for the session (the scoring engine joins
 * params by `(session_id, trial_id)`; see `exportTrialParams`).
 */
import type {
  ContextShiftPayload,
  EventCondition,
  EventTaskPosition,
  LatencyAnchor,
  TrialEndPayload,
} from '@shriii/contracts';
import type { EventLogger, ModuleContext } from '../../../core/contracts.ts';
import { type PresentedOnset, presentStimulus } from '../../../engine/timing.ts';
import type { KitInput, KitTrial } from './types.ts';

/** Round to microseconds (the logger's convention for measured times). */
export function round3(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}

/** Response fields a module supplies; the recorder fills anchor defaults and the stimulus id. */
export interface ResponseFields {
  readonly value: string | null;
  readonly correctness: boolean | null;
  /** Signed latency from the anchor; null only for timeouts. */
  readonly latencyMs: number | null;
  readonly latencyAnchor?: LatencyAnchor;
  readonly holdMs?: number | null;
  readonly tapCount?: number;
  readonly revisions?: readonly { readonly value: string; readonly tMs: number }[];
  readonly touchXyNorm?: readonly [number, number] | null;
  /** Defaults to `touch` when a value is committed and `timeout` otherwise. */
  readonly inputMode?: 'touch' | 'timeout' | 'voice' | 'voice_then_touch_confirm' | 'none';
}

/** Records the session's trials for one module. */
export class TrialRecorder {
  private readonly ctx: ModuleContext;
  private readonly input: KitInput;
  private readonly params = new Map<string, Readonly<Record<string, unknown>>>();
  private open: ActiveTrial | null = null;
  private routed: ActiveTrial | null = null;
  private completed = 0;
  private scorable = 0;
  private shiftIndex: number | null = null;

  constructor(ctx: ModuleContext) {
    this.ctx = ctx;
    this.input = ctx.input as KitInput;
  }

  /** Trials that reached `trial_end` (not aborted). */
  get trialsCompleted(): number {
    return this.completed;
  }

  get scorableTrials(): number {
    return this.scorable;
  }

  /** Trial index of the first logged context shift (ModuleResult.contextShiftIndex). */
  get contextShiftIndex(): number | null {
    return this.shiftIndex;
  }

  /** The currently open trial (between `trial_start` and `trial_end`). */
  get current(): ActiveTrial | null {
    return this.open;
  }

  /** `trial_id -> params` for every trial started this session. */
  trialParams(): Readonly<Record<string, Readonly<Record<string, unknown>>>> {
    return Object.fromEntries(this.params);
  }

  /** Begin a trial: logs `trial_start` (and routes raw-tap logging to it). */
  begin(trial: KitTrial): ActiveTrial {
    if (this.open) this.open.abort('aborted');
    this.releaseRouting();
    this.params.set(trial.trialId, trial.params);
    const t = new ActiveTrial(this, this.ctx, trial);
    this.open = t;
    this.routed = t;
    this.input.setLogger?.(t.log);
    this.input.markIsi?.();
    t.logStart();
    return t;
  }

  /** Log the context shift that takes effect at `trial` (call before {@link begin}). */
  shift(trial: KitTrial, kind: ContextShiftPayload['kind'], announced: boolean): void {
    const log = this.ctx.logger.child({
      task: taskOf(trial, this.ctx),
      condition: conditionOf(trial, this.ctx),
      scorable: trial.scorable,
    });
    log.log('context_shift', { kind, announced, shift_index: trial.trialIndex });
    if (this.shiftIndex === null) this.shiftIndex = trial.trialIndex;
  }

  /** Close the open trial as aborted (walkaway, exit, hard cap). */
  abortOpen(): void {
    this.open?.abort('aborted');
    this.releaseRouting();
  }

  /** Restore the module-level raw-tap logger (after the post-trial ISI). */
  releaseRouting(): void {
    if (!this.routed) return;
    this.routed = null;
    this.input.setLogger?.(this.ctx.logger);
    this.input.markIdle?.();
  }

  /** @internal */
  closed(t: ActiveTrial, counted: boolean): void {
    if (this.open === t) this.open = null;
    if (counted) {
      this.completed += 1;
      if (t.trial.scorable) this.scorable += 1;
    }
  }

  /** @internal */
  isRouted(t: ActiveTrial): boolean {
    return this.routed === t;
  }
}

function taskOf(trial: KitTrial, ctx: ModuleContext): EventTaskPosition {
  return {
    episode_id: null,
    module_id: ctx.config.module_id,
    block_id: trial.blockId,
    trial_id: trial.trialId,
    trial_index: trial.trialIndex,
    probe_group_id: trial.probeGroupId,
    form_id: trial.formId,
    anchor_trial: trial.anchor,
  };
}

function conditionOf(trial: KitTrial, ctx: ModuleContext): EventCondition {
  return {
    phase: trial.phase,
    condition_id: trial.conditionId,
    shift_active: trial.shiftActive,
    timer: trial.timer,
    noise: trial.noise,
    calibration_level: ctx.level,
    variant_seed: ((trial.variant ?? 0) >>> 0).toString(16),
  };
}

/** One open trial. */
export class ActiveTrial {
  readonly trial: KitTrial;
  readonly log: EventLogger;
  readonly startMs: number;
  private readonly recorder: TrialRecorder;
  private readonly ctx: ModuleContext;
  private onset: PresentedOnset | null = null;
  private responded = false;
  private ended = false;

  constructor(recorder: TrialRecorder, ctx: ModuleContext, trial: KitTrial) {
    this.recorder = recorder;
    this.ctx = ctx;
    this.trial = trial;
    this.startMs = ctx.clock.now();
    this.log = ctx.logger.child({
      task: taskOf(trial, ctx),
      condition: conditionOf(trial, ctx),
      scorable: trial.scorable,
    });
  }

  /** Presented onset of the stimulus (session ms), or null before {@link present}. */
  get onsetMs(): number | null {
    return this.onset?.presentedOnsetMs ?? null;
  }

  get timingFlag(): PresentedOnset['timingFlag'] {
    return this.onset?.timingFlag ?? 'ok';
  }

  get isEnded(): boolean {
    return this.ended;
  }

  /** @internal */
  logStart(): void {
    this.log.log('trial_start', {
      trial_type: this.trial.trialType,
      stimulus_id: this.trial.stimulusId,
      response_window_ms: this.trial.responseWindowMs,
      private_report: this.trial.privateReport ?? false,
      expected_response: this.trial.expectedResponse,
    });
  }

  /**
   * Commit the stimulus on the next frame and log `stimulus_onset` with the presented onset (rAF
   * after commit plus the SKU display offset). `render` must make the stimulus visible synchronously;
   * nothing (animation, voice) may delay it.
   */
  async present(
    render: () => void,
    options: { readonly durationMs: number | null; readonly version: string },
  ): Promise<PresentedOnset> {
    const p = await presentStimulus(this.ctx.clock, render);
    this.onset = p;
    this.log.log(
      'stimulus_onset',
      {
        stimulus_id: this.trial.stimulusId ?? `${this.trial.trialId}`,
        stimulus_version: options.version,
        requested_onset_ms: round3(p.requestedOnsetMs),
        presented_onset_ms: round3(p.presentedOnsetMs),
        audio_onset_ms: null,
        onset_source: 'raf_commit',
        duration_ms: options.durationMs,
      },
      { timingFlag: p.timingFlag },
    );
    return p;
  }

  /** Log the committed response (exactly once per trial; timeouts too). */
  respond(r: ResponseFields): void {
    if (this.responded || this.ended) return;
    this.responded = true;
    const committed = r.value !== null && r.inputMode !== 'timeout';
    const latency = committed && r.latencyMs !== null ? round3(r.latencyMs) : null;
    this.log.log(
      'response',
      {
        stimulus_id: this.trial.stimulusId,
        response_value: committed ? r.value : null,
        correctness: r.correctness,
        input_mode: r.inputMode ?? (committed ? 'touch' : 'timeout'),
        latency_ms: latency,
        latency_anchor: r.latencyAnchor ?? 'visual_onset',
        barge_in: latency !== null && latency < 0,
        hold_ms: r.holdMs === undefined || r.holdMs === null ? null : round3(r.holdMs),
        tap_count: r.tapCount ?? (committed ? 1 : 0),
        revisions: (r.revisions ?? []).map((v) => ({ value: v.value, t_ms: round3(v.tMs) })),
        touch_xy_norm: r.touchXyNorm ? [r.touchXyNorm[0], r.touchXyNorm[1]] : null,
      },
      { timingFlag: this.timingFlag },
    );
  }

  /** Log `trial_end`. Raw-tap routing stays on this trial until {@link release}. */
  end(
    outcome: TrialEndPayload['outcome'],
    correctness: boolean | null,
    responseCount: number,
  ): void {
    if (this.ended) return;
    this.ended = true;
    this.log.log('trial_end', {
      outcome,
      correctness,
      response_count: responseCount,
      duration_ms: round3(Math.max(0, this.ctx.clock.now() - this.startMs)),
    });
    this.recorder.closed(this, outcome !== 'aborted');
  }

  /** @internal Close as aborted (interrupted). */
  abort(outcome: 'aborted'): void {
    if (this.ended) return;
    this.ended = true;
    this.log.log(
      'trial_end',
      {
        outcome,
        correctness: null,
        response_count: 0,
        duration_ms: round3(Math.max(0, this.ctx.clock.now() - this.startMs)),
      },
      { interrupted: true },
    );
    this.recorder.closed(this, false);
  }

  /** Stop routing raw taps to this trial (call after its ISI). */
  release(): void {
    if (this.recorder.isRouted(this)) this.recorder.releaseRouting();
  }
}
