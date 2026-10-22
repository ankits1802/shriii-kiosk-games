/**
 * Trial recording for the set-2 micro-games: one {@link ActiveTrial} per trial writes
 * `trial_start` -> `stimulus_onset` (on the frame the stimulus is committed) -> trial events ->
 * `response` -> `trial_end` through the module-scoped logger, with the task position and condition
 * the scoring engine joins on (`stats/scoring/src/shriii_scoring/conventions.py`):
 *
 * - `task.block_id` is `"<module_id>.<block_id>"`; `task.trial_id` is `"<module_id>.tNNN"`;
 * - `task.trial_index` counts every trial of the module from 0, practice included;
 * - `context_shift.shift_index` is the index of the first trial under the new condition.
 *
 * The recorder also keeps each trial's `GameTrialSpec.params` (scheduler/solver output joined by the
 * indicator engine on `(session_id, trial_id)`), exported through {@link TrialRecorder.trialParams}.
 */
import type {
  ContextShiftPayload,
  EventCondition,
  EventTaskPosition,
  EventType,
  LatencyAnchor,
  PartnerType,
  PayloadOf,
  Phase,
  TrialEndPayload,
} from '@shriii/contracts';
import type {
  EventLogger,
  LoggedEvent,
  ResponsePayload,
  TimingFlag,
} from '../../../core/contracts.ts';
import { type PresentedOnset, presentStimulus } from '../../../engine/timing.ts';
import { type GameRuntime, round3 } from './runtime.ts';

/** Everything needed to open a trial. */
export interface TrialSpec {
  /** Block id from the module config (without the module prefix). */
  readonly blockId: string;
  readonly phase: Phase;
  readonly conditionId: string;
  /** Scoring-convention trial type (`round`, `target`, `choice`, `report`, `probe`, ...). */
  readonly trialType: string;
  readonly stimulusId: string;
  /** Exact response window from the level table (null = untimed). */
  readonly responseWindowMs: number | null;
  readonly expectedResponse: string | null;
  readonly scorable: boolean;
  readonly privateReport?: boolean;
  readonly probeGroupId?: string | null;
  readonly shiftActive?: boolean;
  readonly timer?: boolean;
  readonly noise?: boolean;
  readonly partnerType?: PartnerType | null;
  /** `GameTrialSpec.params` for this trial (scoring-convention keys plus design provenance). */
  readonly params: Readonly<Record<string, unknown>>;
}

/** Committed (or timed-out) response of a trial, mapped 1:1 onto the `response` payload. */
export interface ResponseRecord {
  readonly stimulusId: string | null;
  /** Committed code, null on timeout. */
  readonly value: string | null;
  readonly correctness: boolean | null;
  /** Signed latency from the anchor; null on timeout. */
  readonly latencyMs: number | null;
  readonly anchor: LatencyAnchor;
  readonly tapCount: number;
  readonly revisions: readonly { readonly value: string; readonly tMs: number }[];
  readonly xy: readonly [number, number] | null;
  readonly holdMs?: number | null;
}

/** Build the `response` payload (timeouts: `input_mode: timeout`, null value and latency). */
export function responsePayload(r: ResponseRecord): ResponsePayload {
  const timeout = r.value === null;
  return {
    stimulus_id: r.stimulusId,
    response_value: timeout ? null : r.value,
    correctness: timeout ? null : r.correctness,
    input_mode: timeout ? 'timeout' : 'touch',
    latency_ms: timeout || r.latencyMs === null ? null : round3(r.latencyMs),
    latency_anchor: r.anchor,
    barge_in: !timeout && r.latencyMs !== null && r.latencyMs < 0,
    hold_ms: r.holdMs ?? null,
    tap_count: r.tapCount,
    revisions: r.revisions.map((v) => ({ value: v.value, t_ms: round3(Math.max(0, v.tMs)) })),
    touch_xy_norm: timeout || !r.xy ? null : [r.xy[0], r.xy[1]],
  };
}

/** Stable variant seed (1-16 hex chars) for a trial, derived from the module's seeded stream. */
function variantSeed(rt: GameRuntime, index: number): string {
  return rt.ctx.rng.stream(`variant.${index}`).nextUint32().toString(16);
}

export class TrialRecorder {
  private nextIndex = 0;
  private readonly params = new Map<string, Record<string, unknown>>();
  private open: ActiveTrial | null = null;
  /** Trials that reached `trial_end` (any outcome but `aborted`). */
  completed = 0;
  /** Completed trials flagged scorable. */
  scorableCompleted = 0;

  constructor(readonly rt: GameRuntime) {}

  /** Index the next trial will get. */
  get index(): number {
    return this.nextIndex;
  }

  /** The trial between `trial_start` and `trial_end`, if any. */
  get current(): ActiveTrial | null {
    return this.open;
  }

  /** Module-level position (no block, no trial) for module events such as `context_shift`. */
  moduleTask(): EventTaskPosition {
    const { config, session } = this.rt.ctx;
    return {
      episode_id: null,
      module_id: config.module_id,
      block_id: null,
      trial_id: null,
      trial_index: null,
      probe_group_id: null,
      form_id: config.forms.includes(session.formId) ? session.formId : (config.forms[0] ?? null),
      anchor_trial: false,
    };
  }

  /** Log a controlled condition change (the only valid source of switch points for scoring). */
  contextShift(kind: ContextShiftPayload['kind'], announced: boolean, shiftIndex: number): void {
    this.rt.check();
    this.rt.ctx.logger.log(
      'context_shift',
      { kind, announced, shift_index: shiftIndex },
      { task: this.moduleTask(), condition: null, scorable: this.rt.ctx.config.scorable },
    );
  }

  /** Open the next trial and log `trial_start`. */
  begin(spec: TrialSpec): ActiveTrial {
    this.rt.check();
    if (this.open) throw new Error(`trial ${this.open.id} is still open`);
    const index = this.nextIndex;
    this.nextIndex += 1;
    const moduleId = this.rt.ctx.config.module_id;
    const id = `${moduleId}.t${String(index).padStart(3, '0')}`;
    this.params.set(id, { ...spec.params });
    const trial = new ActiveTrial(this, spec, index, id, variantSeed(this.rt, index));
    this.open = trial;
    // Every raw tap and hold during the trial (ISI, window, extra taps) belongs to it.
    this.rt.routeInput(trial.log);
    return trial;
  }

  /** @internal called by {@link ActiveTrial} when it closes. */
  closed(trial: ActiveTrial, counted: boolean): void {
    if (this.open === trial) {
      this.open = null;
      this.rt.routeInput(null);
    }
    if (counted) {
      this.completed += 1;
      if (trial.spec.scorable) this.scorableCompleted += 1;
    }
  }

  /** @internal merge a param into a trial's record (outcomes known only after the response). */
  setParam(trialId: string, key: string, value: unknown): void {
    const p = this.params.get(trialId);
    if (p) p[key] = value;
  }

  /** `GameTrialSpec.params` by trial id (copy). */
  trialParams(): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {};
    for (const [k, v] of this.params) out[k] = { ...v };
    return out;
  }
}

export class ActiveTrial {
  readonly index: number;
  readonly id: string;
  readonly spec: TrialSpec;
  readonly log: EventLogger;
  readonly startMs: number;
  /** Presented onset of the trial's main stimulus (session ms), once shown. */
  onsetMs: number | null = null;
  /** Timing flag of the main stimulus onset. */
  onsetFlag: TimingFlag = 'ok';
  private readonly recorder: TrialRecorder;
  private closedFlag = false;
  private responded = false;

  constructor(
    recorder: TrialRecorder,
    spec: TrialSpec,
    index: number,
    id: string,
    variant: string,
  ) {
    this.recorder = recorder;
    this.spec = spec;
    this.index = index;
    this.id = id;
    const rt = recorder.rt;
    const base = recorder.moduleTask();
    const task: EventTaskPosition = {
      ...base,
      block_id: `${rt.ctx.config.module_id}.${spec.blockId}`,
      trial_id: id,
      trial_index: index,
      probe_group_id: spec.probeGroupId ?? null,
    };
    const condition: EventCondition = {
      phase: spec.phase,
      condition_id: spec.conditionId,
      shift_active: spec.shiftActive ?? false,
      timer: spec.timer ?? false,
      noise: spec.noise ?? false,
      calibration_level: rt.ctx.level,
      variant_seed: variant,
      ...(spec.partnerType !== undefined ? { partner_type: spec.partnerType } : {}),
    };
    const nonScore = spec.phase === 'practice' || spec.phase === 'warmup';
    this.log = rt.ctx.logger.child({ task, condition, scorable: spec.scorable && !nonScore });
    this.startMs = rt.now();
    this.log.log('trial_start', {
      trial_type: spec.trialType,
      stimulus_id: spec.stimulusId,
      response_window_ms: spec.responseWindowMs,
      private_report: spec.privateReport ?? false,
      expected_response: spec.expectedResponse,
    });
  }

  get closed(): boolean {
    return this.closedFlag;
  }

  /**
   * Render the trial's main stimulus inside the next animation frame and log `stimulus_onset` with
   * the presented onset (the frame where the change is on screen, display offset applied).
   */
  async present(
    render: () => void,
    options: {
      readonly stimulusId?: string;
      readonly version: string;
      readonly durationMs: number | null;
    },
  ): Promise<PresentedOnset> {
    const rt = this.recorder.rt;
    rt.check();
    const presented = await presentStimulus(rt.ctx.clock, render);
    rt.check();
    if (this.onsetMs === null) {
      this.onsetMs = presented.presentedOnsetMs;
      this.onsetFlag = presented.timingFlag;
    }
    this.logOnset(options.stimulusId ?? this.spec.stimulusId, presented, options);
    return presented;
  }

  /** Log an additional onset (e.g. a distractor) measured by the caller. */
  logOnset(
    stimulusId: string,
    presented: PresentedOnset,
    options: { readonly version: string; readonly durationMs: number | null },
  ): void {
    this.log.log(
      'stimulus_onset',
      {
        stimulus_id: stimulusId,
        stimulus_version: options.version,
        requested_onset_ms: round3(Math.max(0, presented.requestedOnsetMs)),
        presented_onset_ms: round3(Math.max(0, presented.presentedOnsetMs)),
        audio_onset_ms: null,
        onset_source: 'raf_commit',
        duration_ms: options.durationMs,
      },
      { timingFlag: presented.timingFlag },
    );
  }

  /** Log a typed trial event (contribution, partner action, report, hold, ...). */
  event<T extends EventType>(type: T, payload: PayloadOf<T>): LoggedEvent {
    return this.log.log(type, payload);
  }

  /** Log the committed (or timed-out) response. Only one response per trial is logged. */
  respond(record: ResponseRecord): void {
    if (this.responded) throw new Error(`trial ${this.id} already has a response`);
    this.responded = true;
    this.log.log('response', responsePayload(record));
  }

  /** Merge a param into this trial's `GameTrialSpec.params` record. */
  setParam(key: string, value: unknown): void {
    this.recorder.setParam(this.id, key, value);
  }

  /** Close the trial with `trial_end`. */
  end(
    outcome: TrialEndPayload['outcome'],
    correctness: boolean | null,
    responseCount: number,
  ): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.log.log('trial_end', {
      outcome,
      correctness,
      response_count: responseCount,
      duration_ms: round3(Math.max(0, this.recorder.rt.now() - this.startMs)),
    });
    this.recorder.closed(this, outcome !== 'aborted');
  }

  /** Close an interrupted trial (`outcome: aborted`, `interrupted: true`). Safe after abort. */
  abort(): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    try {
      this.log.log(
        'trial_end',
        {
          outcome: 'aborted',
          correctness: null,
          response_count: 0,
          duration_ms: round3(Math.max(0, this.recorder.rt.now() - this.startMs)),
        },
        { interrupted: true },
      );
    } catch {
      // the module logger may already be gated after module_end
    }
    this.recorder.closed(this, false);
  }
}
