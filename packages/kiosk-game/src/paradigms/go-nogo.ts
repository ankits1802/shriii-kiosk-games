/**
 * Go/No-Go trial streams and response classification (MG-02 Don't-Tap, EPI-01 Stall serving,
 * MG-08 Steady Hands reuses the tap classifier).
 *
 * Stream generation: a block of `n` trials with a no-go count (from a share and/or a per-block
 * minimum), a maximum no-go run, fixed-paced timing from the level table and a seeded ISI jitter.
 *
 * Classification (per trial, fixed-paced): every raw tap is classified exactly like the
 * `input.raw_tap.classification` enum, never debounced (ENG-06):
 *
 * | tap time / target                                   | classification              | commits? |
 * |-----------------------------------------------------|-----------------------------|----------|
 * | palm / ghost filtered by the input layer            | `filtered_palm`             | no       |
 * | >= 2 active points (outside co-play zones)          | `multi_touch_interference`  | no       |
 * | before the stimulus onset (inter-stimulus interval) | `during_isi`                | no       |
 * | after the response window closed                    | `during_isi`                | no       |
 * | inside the window, off every response target        | `off_target` (`extra` after commit) | no |
 * | first on-target tap, offset < premature threshold   | `premature`                 | yes      |
 * | first on-target tap, offset >= premature threshold  | `on_target`                 | yes      |
 * | any tap after the committing tap                    | `extra`                     | no       |
 *
 * Outcomes: go + commit = `correct` (hit); go + none = `omission`; no-go + commit = `commission`;
 * no-go + none = `correct` (withholding is logged as a timeout response with correctness true, the
 * Python scorer's convention). The premature threshold is an argument: callers read it from the
 * module config (`constraints.premature_threshold_ms`) or from `shared.yaml` (`anticipatory_response`).
 */
import type {
  BlockConfig,
  CalibrationLevel,
  GameConfig,
  InputRawTapPayload,
  Phase,
  TrialEndPayload,
} from '@shriii/contracts';
import type { SeededRng } from '../core/contracts.ts';
import type { TrialOverrideGenerator } from '../engine/scheduler.ts';
import {
  constraintNumber,
  drawJitter,
  type IndicatorBinding,
  longestRun,
  ParadigmConfigError,
  placeWithRunLimit,
  requireTiming,
  timingNumber,
} from './common.ts';

const PARADIGM = 'go_nogo';

export type GngKind = 'go' | 'nogo';

/** Raw-tap classification codes (the `input.raw_tap` payload enum). */
export type TapClassification = InputRawTapPayload['classification'];

/** Options for one fixed-paced go/no-go block. All numbers come from the config (see {@link goNoGoBlockOptions}). */
export interface GngStreamOptions {
  readonly trials: number;
  /** Explicit no-go count; else `round(trials * nogoShare)`, raised to `minNogo`. */
  readonly nogoCount?: number;
  readonly nogoShare?: number;
  readonly minNogo?: number;
  readonly maxConsecutiveNogo: number;
  readonly stimulusMs: number;
  readonly responseWindowMs: number;
  readonly isiMs: number;
  readonly isiJitterMs: number;
}

/** One scheduled go/no-go stimulus. `effectiveIsiMs = isiMs + jitterMs` precedes the stimulus. */
export interface GngStimulus {
  readonly index: number;
  readonly kind: GngKind;
  readonly stimulusMs: number;
  readonly responseWindowMs: number;
  readonly isiMs: number;
  readonly jitterMs: number;
  readonly effectiveIsiMs: number;
}

/** Resolve the no-go count for a block (share and per-block minimum), validating feasibility. */
export function resolveNogoCount(options: GngStreamOptions): number {
  const { trials } = options;
  if (!Number.isInteger(trials) || trials < 1) {
    throw new ParadigmConfigError(PARADIGM, `trials must be a positive integer, got ${trials}`);
  }
  let k: number;
  if (options.nogoCount !== undefined) {
    k = options.nogoCount;
  } else if (options.nogoShare !== undefined) {
    if (!(options.nogoShare >= 0 && options.nogoShare <= 1)) {
      throw new ParadigmConfigError(
        PARADIGM,
        `nogo share must be in [0, 1], got ${options.nogoShare}`,
      );
    }
    k = Math.round(trials * options.nogoShare);
  } else {
    throw new ParadigmConfigError(PARADIGM, 'either nogoCount or nogoShare is required');
  }
  if (options.minNogo !== undefined) k = Math.max(k, options.minNogo);
  if (!Number.isInteger(k) || k < 0 || k > trials) {
    throw new ParadigmConfigError(PARADIGM, `no-go count ${k} is not within [0, ${trials}]`);
  }
  return k;
}

/**
 * Build a seeded go/no-go stream. Deterministic for a given rng state; the no-go run limit always
 * holds (uniform placement over the gaps between go trials); throws when the limit is infeasible.
 */
export function buildGoNoGoStream(options: GngStreamOptions, rng: SeededRng): GngStimulus[] {
  const k = resolveNogoCount(options);
  const mask = placeWithRunLimit(
    options.trials,
    k,
    options.maxConsecutiveNogo,
    rng.stream('placement'),
  );
  if (!mask) {
    throw new ParadigmConfigError(
      PARADIGM,
      `${k} no-go trials cannot satisfy max_consecutive_nogo=${options.maxConsecutiveNogo} in ${options.trials} trials`,
    );
  }
  for (const v of [options.stimulusMs, options.responseWindowMs, options.isiMs]) {
    if (!(v > 0)) throw new ParadigmConfigError(PARADIGM, `timings must be positive, got ${v}`);
  }
  const jitterRng = rng.stream('jitter');
  return mask.map((isNogo, index) => {
    const jitterMs = drawJitter(options.isiJitterMs, jitterRng);
    return {
      index,
      kind: isNogo ? 'nogo' : 'go',
      stimulusMs: options.stimulusMs,
      responseWindowMs: options.responseWindowMs,
      isiMs: options.isiMs,
      jitterMs,
      effectiveIsiMs: options.isiMs + jitterMs,
    };
  });
}

/**
 * Stream options for a Don't-Tap style block from the config (no hard-coded numbers): `nogo_share`,
 * `max_consecutive_nogo`, `planned_counts.nogo_per_block`, and the level timing keys `stimulus_ms`,
 * `response_window_ms`, `isi_ms` (`pressure_isi_ms` in a pressure phase) and `isi_jitter_ms`.
 */
export function goNoGoBlockOptions(
  config: GameConfig,
  level: CalibrationLevel,
  block: Pick<BlockConfig, 'trials' | 'phase'>,
): GngStreamOptions {
  const share = constraintNumber(config, 'nogo_share');
  const maxRun = constraintNumber(config, 'max_consecutive_nogo');
  if (share === null)
    throw new ParadigmConfigError(PARADIGM, `${config.module_id}: constraints.nogo_share missing`);
  if (maxRun === null) {
    throw new ParadigmConfigError(
      PARADIGM,
      `${config.module_id}: constraints.max_consecutive_nogo missing`,
    );
  }
  const perBlock = config.planned_counts.nogo_per_block;
  const pressureIsi =
    block.phase === 'pressure' ? timingNumber(config, level, 'pressure_isi_ms') : null;
  return {
    trials: block.trials,
    nogoShare: share,
    ...(perBlock !== undefined ? { minNogo: perBlock } : {}),
    maxConsecutiveNogo: maxRun,
    stimulusMs: requireTiming(PARADIGM, config, level, 'stimulus_ms'),
    responseWindowMs: requireTiming(PARADIGM, config, level, 'response_window_ms'),
    isiMs: pressureIsi ?? requireTiming(PARADIGM, config, level, 'isi_ms'),
    isiJitterMs: timingNumber(config, level, 'isi_jitter_ms') ?? 0,
  };
}

/** Summary statistics of a stream (scheduler QA and tests). */
export function gngStreamStats(stream: readonly GngStimulus[]): {
  readonly go: number;
  readonly nogo: number;
  readonly maxNogoRun: number;
} {
  const flags = stream.map((s) => s.kind === 'nogo');
  const nogo = flags.filter(Boolean).length;
  return { go: stream.length - nogo, nogo, maxNogoRun: longestRun(flags) };
}

/* ------------------------------------------------------------------------------------------------
 * Tap classification (shared by every fixed-paced response-window paradigm)
 * ---------------------------------------------------------------------------------------------- */

/** A raw tap as seen by the paradigm (session ms, touch offset already applied by the input layer). */
export interface TapInput {
  readonly tMs: number;
  /** True when the tap hit a response target of this trial (e.g. the serve hand, the target). */
  readonly onTarget: boolean;
  /** Input-layer filtering (palm/ghost, multi-touch interference); default `none`. */
  readonly filtered?: 'none' | 'palm' | 'multi_touch_interference';
}

/** Timing frame of one response-window trial on the session clock. */
export interface ResponseWindow {
  /** Presented stimulus onset (latency anchor). */
  readonly onsetMs: number;
  readonly responseWindowMs: number;
}

/** A classified tap with its signed offset from the latency anchor. */
export interface ClassifiedTap {
  readonly tap: TapInput;
  readonly classification: TapClassification;
  /** `tMs - onsetMs` (negative before onset). */
  readonly anchorOffsetMs: number;
  /** True for the single tap that committed the trial's response. */
  readonly committing: boolean;
}

/** Classification of all taps in one response window. */
export interface WindowTapClassification {
  readonly taps: readonly ClassifiedTap[];
  readonly committing: ClassifiedTap | null;
  /** Latency of the committing tap from the onset; null when nothing committed. */
  readonly latencyMs: number | null;
  readonly prematureCount: number;
  readonly duringIsiCount: number;
  readonly extraCount: number;
  readonly offTargetCount: number;
  /** Taps a restraint indicator counts as unneeded (`premature`, `during_isi`, `extra`). */
  readonly unneededCount: number;
}

/**
 * Classify the taps of one response-window trial. `prematureThresholdMs` comes from YAML/config.
 * Taps are processed in time order; the input array is not modified.
 */
export function classifyWindowTaps(
  window: ResponseWindow,
  taps: readonly TapInput[],
  prematureThresholdMs: number,
): WindowTapClassification {
  if (!(prematureThresholdMs >= 0)) {
    throw new RangeError(`premature threshold must be >= 0, got ${prematureThresholdMs}`);
  }
  const closeMs = window.onsetMs + window.responseWindowMs;
  const ordered = [...taps].sort((a, b) => a.tMs - b.tMs);
  const out: ClassifiedTap[] = [];
  let committing: ClassifiedTap | null = null;
  for (const tap of ordered) {
    const offset = tap.tMs - window.onsetMs;
    let classification: TapClassification;
    let commits = false;
    if (tap.filtered === 'palm') classification = 'filtered_palm';
    else if (tap.filtered === 'multi_touch_interference')
      classification = 'multi_touch_interference';
    else if (tap.tMs < window.onsetMs || tap.tMs > closeMs) classification = 'during_isi';
    else if (committing) classification = 'extra';
    else if (!tap.onTarget) classification = 'off_target';
    else {
      classification = offset < prematureThresholdMs ? 'premature' : 'on_target';
      commits = true;
    }
    const c: ClassifiedTap = { tap, classification, anchorOffsetMs: offset, committing: commits };
    if (commits) committing = c;
    out.push(c);
  }
  const count = (cls: TapClassification): number =>
    out.filter((t) => t.classification === cls).length;
  const premature = count('premature');
  const duringIsi = count('during_isi');
  const extra = count('extra');
  return {
    taps: out,
    committing,
    latencyMs: committing ? committing.anchorOffsetMs : null,
    prematureCount: premature,
    duringIsiCount: duringIsi,
    extraCount: extra,
    offTargetCount: count('off_target'),
    unneededCount: premature + duringIsi + extra,
  };
}

/** Signal-detection category of a go/no-go trial. */
export type GngSignalDetection = 'hit' | 'miss' | 'false_alarm' | 'correct_rejection';

/** Full classification of one go/no-go trial. */
export interface GngTrialClassification extends WindowTapClassification {
  readonly kind: GngKind;
  readonly responded: boolean;
  readonly outcome: Extract<TrialEndPayload['outcome'], 'correct' | 'omission' | 'commission'>;
  readonly correctness: boolean;
  readonly signalDetection: GngSignalDetection;
}

/** Classify a go/no-go trial (see the module table). */
export function classifyGngTrial(
  kind: GngKind,
  window: ResponseWindow,
  taps: readonly TapInput[],
  prematureThresholdMs: number,
): GngTrialClassification {
  const w = classifyWindowTaps(window, taps, prematureThresholdMs);
  const responded = w.committing !== null;
  if (kind === 'go') {
    return {
      ...w,
      kind,
      responded,
      outcome: responded ? 'correct' : 'omission',
      correctness: responded,
      signalDetection: responded ? 'hit' : 'miss',
    };
  }
  return {
    ...w,
    kind,
    responded,
    outcome: responded ? 'commission' : 'correct',
    correctness: !responded,
    signalDetection: responded ? 'false_alarm' : 'correct_rejection',
  };
}

/**
 * The `response` payload fields a go/no-go trial produces. The committed code defaults to `serve`
 * (scoring convention `RESPONSE_CODES.go/nogo`); withholding is a timeout with null value/latency.
 */
export function gngResponseFields(
  c: GngTrialClassification,
  responseCode = 'serve',
): {
  readonly response_value: string | null;
  readonly correctness: boolean;
  readonly latency_ms: number | null;
  readonly input_mode: 'touch' | 'timeout';
  readonly tap_count: number;
} {
  const counted = c.taps.filter(
    (t) => t.classification !== 'filtered_palm' && t.classification !== 'multi_touch_interference',
  ).length;
  return {
    response_value: c.responded ? responseCode : null,
    correctness: c.correctness,
    latency_ms: c.latencyMs,
    input_mode: c.responded ? 'touch' : 'timeout',
    tap_count: counted,
  };
}

/* ------------------------------------------------------------------------------------------------
 * Scheduler integration
 * ---------------------------------------------------------------------------------------------- */

/** Phase helper: pressure blocks carry the timer/noise beats. */
export function isPressurePhase(phase: Phase): boolean {
  return phase === 'pressure';
}

/**
 * Scheduler override generator for Don't-Tap: adds `params.feedback` (`none`; Don't-Tap has no
 * scripted negative feedback) and a level-independent `params.stimulus_variant` for the art kit.
 * Trial types (`go`/`nogo`), counts, run limits and jitter come from the engine scheduler.
 */
export const dontTapOverrides: TrialOverrideGenerator = ({ trial, rng }) => ({
  stimulus_id:
    trial.trial_type === 'go' || trial.trial_type === 'nogo'
      ? `dont_tap.${trial.trial_type}`
      : null,
  params: { feedback: 'none', stimulus_variant: rng.int(0, 3) },
});

/** Dictionary indicators that consume go/no-go events (trial types `go`/`nogo`, raw-tap classes). */
export const GO_NOGO_INDICATORS: readonly IndicatorBinding[] = [
  {
    moduleId: 'dont_tap',
    indicators: [
      'self_control.nogo_commission_rate',
      'self_control.ezd_drift_nogo',
      'composure.pressure_slope_accuracy',
      'composure.pressure_slope_rt',
      'composure.error_type_shift',
      'response_consistency.rt_rvi',
      'expressive_restraint.premature_taps',
      'expressive_restraint.extra_taps',
      'expressive_restraint.iti_rvi',
      'stability.shift_slope_pressure',
    ],
  },
  {
    moduleId: 'stall',
    indicators: [
      'self_control.nogo_commission_rate',
      'self_control.ezd_drift_nogo',
      'composure.pressure_slope_accuracy',
      'composure.pressure_slope_rt',
      'composure.error_type_shift',
      'response_consistency.rt_rvi',
      'expressive_restraint.premature_taps',
      'expressive_restraint.extra_taps',
      'expressive_restraint.iti_rvi',
      'emotional_regulation.recovery_after_feedback',
    ],
  },
];
