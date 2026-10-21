/**
 * Held-vs-free responding (MG-08 Steady Hands).
 *
 * Every trial shows a target that must be tapped; on a seeded share of trials a distractor
 * (crowd flash, bird, bell) co-occurs (`params.distractor`, the scoring convention for trial type
 * `target`). Two counterbalanced blocks:
 *
 * - `free`: the hand moves freely between targets;
 * - `held`: the hand rests on a hold pad between targets and lifts only to respond.
 *
 * Restraint evidence is the count of unneeded actions per trial: premature / ISI / extra taps
 * (classified exactly like go/no-go taps) plus, in the held block, lifting the hand from the pad
 * before the target appeared (`holdBrokenEarly`, logged as a `premature` raw tap on the pad target
 * by the module so the scorer's `UNNEEDED_TAPS` set sees it).
 */
import type { CalibrationLevel, GameConfig } from '@shriii/contracts';
import type { SeededRng } from '../core/contracts.ts';
import type { TrialOverrideGenerator } from '../engine/scheduler.ts';
import {
  constraintNumber,
  drawJitter,
  type IndicatorBinding,
  ParadigmConfigError,
  placeWithRunLimit,
  requireTiming,
  timingNumber,
} from './common.ts';
import {
  classifyWindowTaps,
  type ResponseWindow,
  type TapInput,
  type WindowTapClassification,
} from './go-nogo.ts';

const PARADIGM = 'held_vs_free_responding';

export type HoldCondition = 'free' | 'held';

/** One scheduled Steady Hands trial. */
export interface HeldFreeStimulus {
  readonly index: number;
  readonly condition: HoldCondition;
  readonly distractor: boolean;
  readonly targetMs: number;
  readonly distractorMs: number | null;
  /** Distractor onset relative to the target onset (seeded within the target duration). */
  readonly distractorOffsetMs: number | null;
  readonly isiMs: number;
  readonly jitterMs: number;
}

export interface HeldFreeBlockOptions {
  readonly condition: HoldCondition;
  readonly trials: number;
  readonly distractorShare: number;
  readonly targetMs: number;
  readonly distractorMs: number;
  readonly isiMs: number;
  readonly isiJitterMs: number;
  /** Max consecutive distractor trials (default: no limit). */
  readonly maxConsecutiveDistractor?: number;
}

/** Block options from the config: `distractor_share`, timing `target_ms`, `distractor_ms`, `isi_ms`. */
export function heldFreeBlockOptions(
  config: GameConfig,
  level: CalibrationLevel,
  condition: HoldCondition,
  trials: number,
): HeldFreeBlockOptions {
  const share = constraintNumber(config, 'distractor_share');
  if (share === null) {
    throw new ParadigmConfigError(
      PARADIGM,
      `${config.module_id}: constraints.distractor_share missing`,
    );
  }
  const maxRun = constraintNumber(config, 'max_consecutive_distractor');
  return {
    condition,
    trials,
    distractorShare: share,
    targetMs: requireTiming(PARADIGM, config, level, 'target_ms'),
    distractorMs: requireTiming(PARADIGM, config, level, 'distractor_ms'),
    isiMs: requireTiming(PARADIGM, config, level, 'isi_ms'),
    isiJitterMs: timingNumber(config, level, 'isi_jitter_ms') ?? 0,
    ...(maxRun !== null ? { maxConsecutiveDistractor: maxRun } : {}),
  };
}

/** Build one seeded Steady Hands block. */
export function buildHeldFreeBlock(
  options: HeldFreeBlockOptions,
  rng: SeededRng,
): HeldFreeStimulus[] {
  const { trials } = options;
  if (!Number.isInteger(trials) || trials < 1) {
    throw new ParadigmConfigError(PARADIGM, `trials must be a positive integer, got ${trials}`);
  }
  if (!(options.distractorShare >= 0 && options.distractorShare <= 1)) {
    throw new ParadigmConfigError(PARADIGM, `distractor share must be in [0, 1]`);
  }
  if (options.distractorMs > options.targetMs) {
    throw new ParadigmConfigError(PARADIGM, 'distractor must fit inside the target duration');
  }
  const k = Math.round(trials * options.distractorShare);
  const mask = placeWithRunLimit(
    trials,
    k,
    options.maxConsecutiveDistractor ?? trials,
    rng.stream('placement'),
  );
  if (!mask)
    throw new ParadigmConfigError(PARADIGM, `cannot place ${k} distractors in ${trials} trials`);
  const jitterRng = rng.stream('jitter');
  const offsetRng = rng.stream('distractor_offset');
  return mask.map((distractor, index) => ({
    index,
    condition: options.condition,
    distractor,
    targetMs: options.targetMs,
    distractorMs: distractor ? options.distractorMs : null,
    distractorOffsetMs: distractor
      ? offsetRng.int(0, options.targetMs - options.distractorMs)
      : null,
    isiMs: options.isiMs,
    jitterMs: drawJitter(options.isiJitterMs, jitterRng),
  }));
}

/** Hold-pad state in a held trial: when the hand left the pad (null = never lifted in the trial). */
export interface HoldPadTrace {
  readonly releasedAtMs: number | null;
}

/** Classification of one Steady Hands trial. */
export interface HeldFreeTrialClassification extends WindowTapClassification {
  readonly condition: HoldCondition;
  readonly distractor: boolean;
  readonly responded: boolean;
  readonly correctness: boolean;
  readonly outcome: 'correct' | 'omission';
  /** Held block only: the hand left the pad before the target onset. */
  readonly holdBrokenEarly: boolean;
  /** Unneeded actions including an early hold break (restraint evidence). */
  readonly unneededActions: number;
}

/** Classify one trial. `prematureThresholdMs` from YAML/config. */
export function classifyHeldFreeTrial(
  stimulus: Pick<HeldFreeStimulus, 'condition' | 'distractor'>,
  window: ResponseWindow,
  taps: readonly TapInput[],
  prematureThresholdMs: number,
  hold: HoldPadTrace | null = null,
): HeldFreeTrialClassification {
  const w = classifyWindowTaps(window, taps, prematureThresholdMs);
  const holdBrokenEarly =
    stimulus.condition === 'held' &&
    hold !== null &&
    hold.releasedAtMs !== null &&
    hold.releasedAtMs < window.onsetMs;
  const responded = w.committing !== null;
  return {
    ...w,
    condition: stimulus.condition,
    distractor: stimulus.distractor,
    responded,
    correctness: responded,
    outcome: responded ? 'correct' : 'omission',
    holdBrokenEarly,
    unneededActions: w.unneededCount + (holdBrokenEarly ? 1 : 0),
  };
}

/**
 * Scheduler override generator for Steady Hands: maps the engine's `target`/`distractor` beats onto
 * the scoring convention (`params.distractor`, `params.hold_condition`) and seeds the distractor
 * onset offset inside the target duration (level table `target_ms`, `distractor_ms`).
 */
export const steadyHandsOverrides: TrialOverrideGenerator = ({ trial, block, config, rng }) => {
  const distractor = trial.trial_type === 'distractor';
  const condition: HoldCondition | null =
    block.condition_id === 'held' ? 'held' : block.condition_id === 'free' ? 'free' : null;
  // The engine stamps `stimulus_duration_ms` from `<type>_ms`, i.e. distractor_ms on distractor
  // trials; the target duration and distractor duration are therefore carried explicitly here.
  const timing = config.levels[trial.calibration_level].timing;
  const targetMs = timing.target_ms ?? null;
  const distractorMs = timing.distractor_ms ?? null;
  const offset =
    distractor && targetMs !== null && distractorMs !== null && distractorMs <= targetMs
      ? rng.int(0, targetMs - distractorMs)
      : null;
  return {
    expected_response: 'tap',
    vocabulary: ['tap'],
    voice_vocabulary: [],
    params: {
      distractor,
      hold_condition: condition,
      target_ms: targetMs,
      distractor_ms: distractor ? distractorMs : null,
      distractor_offset_ms: offset,
    },
  };
};

export const HELD_FREE_INDICATORS: readonly IndicatorBinding[] = [
  {
    moduleId: 'steady_hands',
    indicators: ['expressive_restraint.held_vs_free_slope', 'composure.distractor_slope'],
  },
];
