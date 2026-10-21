/**
 * Two-choice rule reversal at forks in the road (EPI-03 Road Home, MindShift).
 *
 * At each fork a marker cue (a blue flag and an orange flag, colour paired with flag shape) stands
 * on the left or right branch (seeded side). The initial rule is "take the branch with the blue
 * flag"; after the unannounced reversal (no audio cue refers to it, EPI-03 AC) it becomes "take the
 * orange flag". `rule_option` is the branch correct under the current rule and `old_rule_option`
 * the branch the other rule picks (the scoring convention params for trial type `fork_choice`).
 *
 * Post-reversal choices of `old_rule_option` are perseverative (`reversal.perseverative_error_rate`);
 * trials to reacquire use the same consecutive-correct criterion as the card sort (run from YAML).
 */
import type { SeededRng } from '../core/contracts.ts';
import type { TrialOverrideGenerator } from '../engine/scheduler.ts';
import { type IndicatorBinding, ParadigmConfigError, trialsToCriterion } from './common.ts';

const PARADIGM = 'rule_reversal';

export type Branch = 'left' | 'right';
export type ForkCue = 'blue_flag' | 'orange_flag';

export interface ForkTrial {
  readonly index: number;
  /** Side of the blue flag (the orange flag is on the other side). */
  readonly blueSide: Branch;
  readonly reversed: boolean;
  readonly ruleCue: ForkCue;
  readonly ruleOption: Branch;
  readonly oldRuleOption: Branch;
}

function other(b: Branch): Branch {
  return b === 'left' ? 'right' : 'left';
}

/** Build one fork trial. */
export function forkTrial(index: number, blueSide: Branch, reversed: boolean): ForkTrial {
  const ruleCue: ForkCue = reversed ? 'orange_flag' : 'blue_flag';
  const ruleOption = reversed ? other(blueSide) : blueSide;
  return { index, blueSide, reversed, ruleCue, ruleOption, oldRuleOption: other(ruleOption) };
}

/**
 * Seeded fork sequence of `n` trials with the reversal at `shiftIndex` (first reversed trial).
 * Cue sides are balanced within each phase (difference <= 1) and never repeat more than `maxSameSide`
 * times in a row, so a side bias cannot pass for rule learning.
 */
export function buildForkSequence(
  n: number,
  shiftIndex: number,
  rng: SeededRng,
  maxSameSide = 3,
): ForkTrial[] {
  if (!Number.isInteger(n) || n < 2)
    throw new ParadigmConfigError(PARADIGM, 'need at least 2 fork trials');
  if (!Number.isInteger(shiftIndex) || shiftIndex < 1 || shiftIndex >= n) {
    throw new ParadigmConfigError(PARADIGM, `shift index ${shiftIndex} must be inside 1..${n - 1}`);
  }
  const phase = (len: number, r: SeededRng): Branch[] => {
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const half = Math.floor(len / 2);
      const pool: Branch[] = [
        ...new Array<Branch>(half).fill('left'),
        ...new Array<Branch>(len - half).fill('right'),
      ];
      const seq = r.shuffle(pool);
      let run = 1;
      let ok = true;
      for (let i = 1; i < seq.length && ok; i += 1) {
        run = seq[i] === seq[i - 1] ? run + 1 : 1;
        if (run > maxSameSide) ok = false;
      }
      if (ok) return seq;
    }
    throw new ParadigmConfigError(PARADIGM, 'could not balance fork sides');
  };
  const sides = [
    ...phase(shiftIndex, rng.stream('pre')),
    ...phase(n - shiftIndex, rng.stream('post')),
  ];
  return sides.map((s, i) => forkTrial(i, s, i >= shiftIndex));
}

export interface ForkClassification {
  readonly correct: boolean;
  readonly perseverative: boolean;
  readonly timeout: boolean;
}

/** Classify one fork choice (`null` = timeout). */
export function classifyForkChoice(trial: ForkTrial, choice: Branch | null): ForkClassification {
  if (choice === null) return { correct: false, perseverative: false, timeout: true };
  const correct = choice === trial.ruleOption;
  return {
    correct,
    perseverative: trial.reversed && choice === trial.oldRuleOption,
    timeout: false,
  };
}

/** Post-reversal summary: perseverative errors and trials to reacquire (`run` from YAML). */
export function reversalSummary(
  trials: readonly ForkTrial[],
  choices: readonly (Branch | null)[],
  run: number,
): {
  readonly postTrials: number;
  readonly perseverativeErrors: number;
  readonly trialsToReacquire: number;
  readonly reached: boolean;
} {
  if (choices.length !== trials.length)
    throw new ParadigmConfigError(PARADIGM, 'one choice per trial is required');
  const post = trials.map((t, i) => ({ t, c: choices[i] ?? null })).filter(({ t }) => t.reversed);
  const cls = post.map(({ t, c }) => classifyForkChoice(t, c));
  const ttc = trialsToCriterion(
    cls.map((x) => x.correct),
    run,
  );
  return {
    postTrials: post.length,
    perseverativeErrors: cls.filter((x) => x.perseverative).length,
    trialsToReacquire: ttc.position,
    reached: ttc.reached,
  };
}

/**
 * Scheduler override generator for Road Home forks: trials in the `reversal` block (condition
 * `rule_reversed`) are reversed forks; fork trials before it follow the initial rule. Cue side is
 * drawn from the trial stream. Only trials whose type is in `forkTypes` get fork params.
 */
export function forkOverrides(
  forkTypes: readonly string[] = ['rule_reversed', 'fork_choice'],
): TrialOverrideGenerator {
  return ({ trial, block, rng }) => {
    if (!forkTypes.includes(trial.trial_type)) return {};
    const reversed = block.condition_id === 'rule_reversed';
    const f = forkTrial(trial.trial_index, rng.bool() ? 'left' : 'right', reversed);
    return {
      vocabulary: ['left', 'right'],
      voice_vocabulary: [],
      expected_response: f.ruleOption,
      params: {
        rule_option: f.ruleOption,
        old_rule_option: f.oldRuleOption,
        blue_side: f.blueSide,
        rule_cue: f.ruleCue,
      },
    };
  };
}

export const REVERSAL_INDICATORS: readonly IndicatorBinding[] = [
  {
    moduleId: 'road_home',
    indicators: [
      'adaptability.post_reversal_errors',
      'adaptability.reversal_trials_to_reacquire',
      'stability.shift_slope_reversal',
    ],
  },
];
