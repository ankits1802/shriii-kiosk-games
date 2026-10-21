/**
 * Card-sort rule engine (MG-03 Card Sort; criterion card sort parity).
 *
 * Dimensions (`constraints.dimensions`): `colour_pattern` (colour always paired with a pattern, so
 * colour is never the only cue), `shape`, and `count` (a pictured quantity of 1-4 objects; never a
 * numeral). Four key cards (piles) each carry a distinct value on every dimension.
 *
 * A card's `matches` maps each dimension to the pile whose key card shares that value (the scoring
 * convention param). The rule sequence is `[r1, r2, r1]`: an unannounced switch (`rule_switch`)
 * followed by a reversal back to the first rule (`rule_reversal`). Rule dimensions are fixed per
 * form and differ between forms (ENG-14 parallel forms).
 *
 * Classification:
 * - {@link classifySort}: correctness, matched dimensions, `other` responses, and the simple
 *   perseverative error used by the Python scorer (`matches[previous_rule]` chosen and not
 *   `matches[rule]`) - parity.
 * - {@link classifyHeaton}: Heaton-style (WCST manual, 1993) perseveration adapted to a short form:
 *   perseverated-to principle, unambiguous vs ambiguous responses, sandwich rule, principle shift
 *   after three consecutive unambiguous errors to a new dimension.
 * - {@link trialsToReacquire}: per shift, trials until `run` consecutive correct (run from YAML,
 *   `reacquisition.consecutive_correct`).
 */
import type { GameConfig } from '@shriii/contracts';
import type { SeededRng } from '../core/contracts.ts';
import { createKeyedRng } from '../engine/rng.ts';
import type { TrialOverrideGenerator } from '../engine/scheduler.ts';
import {
  constraintNumber,
  constraintStrings,
  type IndicatorBinding,
  ParadigmConfigError,
  ParadigmStateError,
  trialsToCriterion,
} from './common.ts';

const PARADIGM = 'card_sort';

export type Dimension = 'colour_pattern' | 'shape' | 'count';
export const DIMENSIONS: readonly Dimension[] = ['colour_pattern', 'shape', 'count'];
export type Pile = 'pile_1' | 'pile_2' | 'pile_3' | 'pile_4';
export const PILES: readonly Pile[] = ['pile_1', 'pile_2', 'pile_3', 'pile_4'];

/** Pictured attribute values (art-kit ids). `count` is a pictured quantity (1-4 objects). */
export const COLOUR_PATTERNS = [
  'red_dots',
  'green_stripes',
  'yellow_checks',
  'blue_plain',
] as const;
export const SHAPES = ['mango', 'pot', 'star', 'leaf'] as const;
export const COUNTS = [1, 2, 3, 4] as const;

export interface Card {
  /** Value index 0..3 on each dimension. */
  readonly colour_pattern: number;
  readonly shape: number;
  readonly count: number;
}

export type Matches = Readonly<Record<Dimension, Pile>>;

/** Key cards: `keyCards[p]` is the card on pile `PILES[p]`. Every dimension is a permutation of 0..3. */
export type KeyCards = readonly [Card, Card, Card, Card];

function isDimension(x: string): x is Dimension {
  return (DIMENSIONS as readonly string[]).includes(x);
}

/** Dimensions declared in the config (must be exactly the three supported, any order). */
export function configDimensions(config: GameConfig): readonly Dimension[] {
  const dims = constraintStrings(config, 'dimensions');
  if (!dims) return DIMENSIONS;
  if (dims.length !== 3 || !dims.every(isDimension) || new Set(dims).size !== 3) {
    throw new ParadigmConfigError(
      PARADIGM,
      `constraints.dimensions must be ${DIMENSIONS.join(', ')}`,
    );
  }
  return dims;
}

/** Seeded key cards: each dimension's values are an independent permutation over the piles. */
export function makeKeyCards(rng: SeededRng): KeyCards {
  const perms = DIMENSIONS.map((d) => rng.stream(`key.${d}`).shuffle([0, 1, 2, 3]));
  const card = (p: number): Card => ({
    colour_pattern: perms[0]?.[p] as number,
    shape: perms[1]?.[p] as number,
    count: perms[2]?.[p] as number,
  });
  return [card(0), card(1), card(2), card(3)];
}

/** Which pile matches the card on each dimension. */
export function matchesOf(card: Card, keys: KeyCards): Matches {
  const pileFor = (d: Dimension): Pile => {
    const i = keys.findIndex((k) => k[d] === card[d]);
    if (i < 0) throw new ParadigmStateError(PARADIGM, `no key card has ${d}=${card[d]}`);
    return PILES[i] as Pile;
  };
  return {
    colour_pattern: pileFor('colour_pattern'),
    shape: pileFor('shape'),
    count: pileFor('count'),
  };
}

/** Number of distinct piles the card's dimensions point to (3 = unambiguous card). */
export function distinctMatchPiles(m: Matches): number {
  return new Set(DIMENSIONS.map((d) => m[d])).size;
}

/**
 * Draw a stimulus card. `unambiguous` cards point to three different piles (so every response
 * identifies at most one dimension); otherwise exactly two dimensions share a pile, never all three
 * (a card identical to a key card is never drawn). When `rule` and `previousRule` are given, the
 * two always point to different piles (an informative post-switch trial).
 */
export function drawCard(
  rng: SeededRng,
  keys: KeyCards,
  options: {
    readonly unambiguous: boolean;
    readonly rule?: Dimension;
    readonly previousRule?: Dimension | null;
  },
): Card {
  for (let attempt = 0; attempt < 512; attempt += 1) {
    const card: Card = {
      colour_pattern: rng.int(0, 3),
      shape: rng.int(0, 3),
      count: rng.int(0, 3),
    };
    const m = matchesOf(card, keys);
    const distinct = distinctMatchPiles(m);
    if (options.unambiguous ? distinct !== 3 : distinct !== 2) continue;
    if (options.rule && options.previousRule && m[options.rule] === m[options.previousRule])
      continue;
    return card;
  }
  throw new ParadigmStateError(PARADIGM, 'could not draw a card satisfying the constraints');
}

/* ------------------------------------------------------------------------------------------------
 * Rules per form and condition
 * ---------------------------------------------------------------------------------------------- */

/** The rule sequence of a session: initial rule, switched rule, reversal (back to the initial rule). */
export interface RulePlan {
  readonly initial: Dimension;
  readonly switched: Dimension;
}

/**
 * Rule dimensions per form: the six ordered pairs of dimensions are shuffled once by `config_id`
 * and form `k` (1-based from `form_k`) takes pair `(k - 1) mod 6`, so different forms always use
 * different rule pairs (ENG-14) and the same form is identical across sessions and levels.
 */
export function rulePlanForForm(
  configId: string,
  formId: string,
  dims: readonly Dimension[] = DIMENSIONS,
): RulePlan {
  const pairs: [Dimension, Dimension][] = [];
  for (const a of dims) for (const b of dims) if (a !== b) pairs.push([a, b]);
  const shuffled = createKeyedRng(`${configId}|rule_pairs`, 'card_sort').shuffle(pairs);
  const m = /(\d+)$/.exec(formId);
  const k = m ? Number(m[1]) : 1;
  const pair = shuffled[(((k - 1) % pairs.length) + pairs.length) % pairs.length] as [
    Dimension,
    Dimension,
  ];
  return { initial: pair[0], switched: pair[1] };
}

/** Active and previous rule for a block condition (`rule_1`, `rule_2`, `rule_1_reversed`, practice). */
export function rulesForCondition(
  conditionId: string,
  plan: RulePlan,
): { readonly rule: Dimension; readonly previousRule: Dimension | null } {
  switch (conditionId) {
    case 'rule_2':
      return { rule: plan.switched, previousRule: plan.initial };
    case 'rule_1_reversed':
      return { rule: plan.initial, previousRule: plan.switched };
    default:
      return { rule: plan.initial, previousRule: null };
  }
}

/* ------------------------------------------------------------------------------------------------
 * Contingent rule engine ("switch after N correct" within a window)
 * ---------------------------------------------------------------------------------------------- */

export interface ContingentSwitchPolicy {
  /** Consecutive correct sorts that trigger a switch (`constraints.switch_after_correct`). */
  readonly afterCorrect: number;
  /** Minimum and maximum trials under one rule before the switch (`constraints.switch_window`). */
  readonly window: readonly [number, number];
  /** Number of switches (`min_counts.switches`); the 2nd is the reversal. */
  readonly switches: number;
}

/** Policy from the config (no defaults: all three keys are required). */
export function contingentPolicyFromConfig(config: GameConfig): ContingentSwitchPolicy {
  const after = constraintNumber(config, 'switch_after_correct');
  const w = config.constraints.switch_window;
  const switches = config.planned_counts.switches;
  if (after === null || !Array.isArray(w) || w.length !== 2 || switches === undefined) {
    throw new ParadigmConfigError(
      PARADIGM,
      'switch_after_correct, switch_window and planned_counts.switches are required',
    );
  }
  return { afterCorrect: after, window: [Number(w[0]), Number(w[1])], switches };
}

export type ShiftKind = 'rule_switch' | 'rule_reversal';

/** A switch decided by the contingent engine (logged as `context_shift`, unannounced). */
export interface RuleShift {
  readonly kind: ShiftKind;
  /** Index (within the sorting trials) of the first trial under the new rule. */
  readonly atTrial: number;
  readonly from: Dimension;
  readonly to: Dimension;
}

/**
 * Tracks the active rule and switches after `afterCorrect` consecutive correct sorts once
 * `window[0]` trials have passed under the rule, or unconditionally after `window[1]` trials.
 */
export class CardSortRuleEngine {
  private readonly sequence: readonly Dimension[];
  private ruleIndex = 0;
  private trialsUnderRule = 0;
  private streak = 0;
  private trial = 0;
  private readonly shiftLog: RuleShift[] = [];
  private readonly policy: ContingentSwitchPolicy;

  constructor(plan: RulePlan, policy: ContingentSwitchPolicy) {
    this.policy = policy;
    if (policy.afterCorrect < 1 || policy.window[0] > policy.window[1] || policy.window[0] < 1) {
      throw new ParadigmConfigError(PARADIGM, 'invalid contingent switch policy');
    }
    const seq: Dimension[] = [plan.initial];
    for (let s = 0; s < policy.switches; s += 1)
      seq.push(s % 2 === 0 ? plan.switched : plan.initial);
    this.sequence = seq;
  }

  get rule(): Dimension {
    return this.sequence[this.ruleIndex] as Dimension;
  }

  get previousRule(): Dimension | null {
    return this.ruleIndex === 0 ? null : (this.sequence[this.ruleIndex - 1] as Dimension);
  }

  get switchesDone(): number {
    return this.ruleIndex;
  }

  /** Record a sort outcome; returns the shift that takes effect from the next trial, if any. */
  record(correct: boolean): RuleShift | null {
    this.trial += 1;
    this.trialsUnderRule += 1;
    this.streak = correct ? this.streak + 1 : 0;
    if (this.ruleIndex >= this.sequence.length - 1) return null;
    const [lo, hi] = this.policy.window;
    const due =
      (this.trialsUnderRule >= lo && this.streak >= this.policy.afterCorrect) ||
      this.trialsUnderRule >= hi;
    if (!due) return null;
    const from = this.rule;
    this.ruleIndex += 1;
    this.trialsUnderRule = 0;
    this.streak = 0;
    const shift: RuleShift = {
      kind: this.ruleIndex === 1 ? 'rule_switch' : 'rule_reversal',
      atTrial: this.trial,
      from,
      to: this.rule,
    };
    this.shiftLog.push(shift);
    return shift;
  }

  shifts(): readonly RuleShift[] {
    return this.shiftLog;
  }
}

/* ------------------------------------------------------------------------------------------------
 * Classification
 * ---------------------------------------------------------------------------------------------- */

/** One sort as recorded (response null = timeout). */
export interface SortRecord {
  readonly rule: Dimension;
  readonly previousRule: Dimension | null;
  readonly matches: Matches;
  readonly response: Pile | null;
}

export interface SortClassification {
  readonly correct: boolean;
  /** Dimensions the chosen pile matches (empty for an `other` response or a timeout). */
  readonly matchedDimensions: readonly Dimension[];
  readonly other: boolean;
  readonly timeout: boolean;
  /** Python-parity perseverative error: previous-rule pile chosen and not the current-rule pile. */
  readonly simplePerseverativeError: boolean;
}

/** Classify a single sort. */
export function classifySort(r: SortRecord): SortClassification {
  if (r.response === null) {
    return {
      correct: false,
      matchedDimensions: [],
      other: false,
      timeout: true,
      simplePerseverativeError: false,
    };
  }
  const matched = DIMENSIONS.filter((d) => r.matches[d] === r.response);
  const correct = r.matches[r.rule] === r.response;
  return {
    correct,
    matchedDimensions: matched,
    other: matched.length === 0,
    timeout: false,
    simplePerseverativeError:
      r.previousRule !== null && r.response === r.matches[r.previousRule] && !correct,
  };
}

/** Heaton-style per-trial result. */
export interface HeatonTrial extends SortClassification {
  /** Perseverated-to principle in force when the response was made (null when none yet). */
  readonly principle: Dimension | null;
  /** Response matched exactly one dimension. */
  readonly unambiguous: boolean;
  readonly perseverativeResponse: boolean;
  readonly perseverativeError: boolean;
  readonly nonPerseverativeError: boolean;
}

export interface HeatonSummary {
  readonly trials: readonly HeatonTrial[];
  readonly perseverativeResponses: number;
  readonly perseverativeErrors: number;
  readonly nonPerseverativeErrors: number;
  readonly errors: number;
}

/**
 * Heaton-style perseveration scoring adapted to a short form without category completion:
 *
 * 1. Principle. Before the first switch the perseverated-to principle is set by the first
 *    unambiguous error (its matched dimension). At each rule change the principle becomes the
 *    previous rule.
 * 2. Unambiguous responses (matching exactly one dimension) that match the principle are
 *    perseverative.
 * 3. Sandwich rule. An ambiguous response that matches the principle is perseverative only when it
 *    lies between two unambiguous perseverative responses (same principle) with no unambiguous
 *    non-perseverative response in between.
 * 4. Principle shift. Three consecutive unambiguous errors to the same dimension D (D not the
 *    principle and not the current rule) make D the new principle; the second and third of those
 *    errors are scored perseverative, the first is not.
 * 5. Timeouts and `other` responses are non-perseverative errors and break sandwiches and runs; any
 *    response other than an unambiguous error to the same new dimension breaks a run (step 4).
 *
 * A perseverative response may be correct (an ambiguous card whose principle pile is also the
 * rule pile); only incorrect perseverative responses are perseverative errors.
 */
export function classifyHeaton(records: readonly SortRecord[]): HeatonSummary {
  const base = records.map(classifySort);
  const principle: (Dimension | null)[] = new Array<Dimension | null>(records.length).fill(null);
  const pers: boolean[] = new Array<boolean>(records.length).fill(false);
  const unamb = base.map((c) => c.matchedDimensions.length === 1);

  let current: Dimension | null = null;
  let lastRule: Dimension | null = null;
  let run: { dim: Dimension; idx: number[] } | null = null;
  for (let i = 0; i < records.length; i += 1) {
    const r = records[i] as SortRecord;
    const c = base[i] as SortClassification;
    if (lastRule !== null && r.rule !== lastRule) {
      current = lastRule;
      run = null;
    }
    lastRule = r.rule;
    principle[i] = current;
    const matchedOne = unamb[i] ? (c.matchedDimensions[0] as Dimension) : null;
    if (matchedOne !== null && current !== null && matchedOne === current) {
      pers[i] = true;
      run = null;
      continue;
    }
    if (matchedOne !== null && !c.correct) {
      // Unambiguous error to a non-principle dimension.
      if (current === null && r.previousRule === null) {
        current = matchedOne; // first unambiguous error before any switch sets the principle
        run = null;
        continue;
      }
      if (run && run.dim === matchedOne) run.idx.push(i);
      else run = { dim: matchedOne, idx: [i] };
      if (run.idx.length >= 3) {
        current = matchedOne;
        for (const j of run.idx.slice(1)) {
          pers[j] = true;
          principle[j] = current;
        }
        run = null;
      }
      continue;
    }
    // Any other response (correct, ambiguous, other, timeout) breaks a run of consecutive errors.
    run = null;
  }

  // Sandwich rule for ambiguous responses that match their principle.
  for (let i = 0; i < records.length; i += 1) {
    const c = base[i] as SortClassification;
    const p = principle[i] ?? null;
    if (unamb[i] || c.timeout || c.other || p === null || !c.matchedDimensions.includes(p))
      continue;
    const bounded = (step: 1 | -1): boolean => {
      for (let j = i + step; j >= 0 && j < records.length; j += step) {
        if ((principle[j] ?? null) !== p) return false;
        const cj = base[j] as SortClassification;
        if (cj.timeout || cj.other) return false;
        if (unamb[j]) return pers[j] === true;
      }
      return false;
    };
    if (bounded(-1) && bounded(1)) pers[i] = true;
  }

  const trials: HeatonTrial[] = base.map((c, i) => ({
    ...c,
    principle: principle[i] ?? null,
    unambiguous: unamb[i] === true,
    perseverativeResponse: pers[i] === true,
    perseverativeError: pers[i] === true && !c.correct,
    nonPerseverativeError: !c.correct && pers[i] !== true,
  }));
  return {
    trials,
    perseverativeResponses: trials.filter((t) => t.perseverativeResponse).length,
    perseverativeErrors: trials.filter((t) => t.perseverativeError).length,
    nonPerseverativeErrors: trials.filter((t) => t.nonPerseverativeError).length,
    errors: trials.filter((t) => !t.correct).length,
  };
}

/**
 * Trials to reacquire per rule change: for each run of trials after a change of `rule`, the 1-based
 * position completing `run` consecutive correct sorts (`reached: false` -> length + 1, as Python).
 */
export function trialsToReacquire(
  records: readonly SortRecord[],
  run: number,
): readonly { readonly shiftAt: number; readonly position: number; readonly reached: boolean }[] {
  const out: { shiftAt: number; position: number; reached: boolean }[] = [];
  let start: number | null = null;
  const flush = (end: number): void => {
    if (start === null) return;
    const correct = records.slice(start, end).map((r) => classifySort(r).correct);
    out.push({ shiftAt: start, ...trialsToCriterion(correct, run) });
  };
  for (let i = 1; i < records.length; i += 1) {
    if ((records[i] as SortRecord).rule !== (records[i - 1] as SortRecord).rule) {
      flush(i);
      start = i;
    }
  }
  flush(records.length);
  return out;
}

/* ------------------------------------------------------------------------------------------------
 * Scheduler integration
 * ---------------------------------------------------------------------------------------------- */

/** Key cards for a form (identical across sessions and levels for comparability). */
export function keyCardsForForm(configId: string, formId: string): KeyCards {
  return makeKeyCards(createKeyedRng(`${configId}|${formId}|key_cards`, 'card_sort'));
}

/**
 * Scheduler override generator: per-trial card, `rule`, `previous_rule` and `matches` (scoring
 * params), the pictured attributes for the art kit, and pile vocabulary. Practice trials use the
 * initial rule. Post-switch cards always separate the rule pile from the previous-rule pile.
 * `ambiguousShare` (default 0) mixes in cards with two dimensions on one pile.
 */
export function cardSortOverrides(
  options: { readonly ambiguousShare?: number } = {},
): TrialOverrideGenerator {
  const share = options.ambiguousShare ?? 0;
  if (!(share >= 0 && share <= 1))
    throw new ParadigmConfigError(PARADIGM, 'ambiguousShare must be in [0, 1]');
  return ({ trial, block, config, rng }) => {
    if (trial.trial_type === 'probe_segment') return {};
    const dims = configDimensions(config);
    const plan = rulePlanForForm(config.config_id, trial.form_id, dims);
    const keys = keyCardsForForm(config.config_id, trial.form_id);
    const { rule, previousRule } = rulesForCondition(block.condition_id, plan);
    const card = drawCard(rng, keys, { unambiguous: !rng.bool(share), rule, previousRule });
    const matches = matchesOf(card, keys);
    return {
      stimulus_id: `card_sort.card.${card.colour_pattern}${card.shape}${card.count}`,
      vocabulary: [...PILES] as [string, ...string[]],
      voice_vocabulary: [],
      expected_response: matches[rule],
      params: {
        rule,
        previous_rule: previousRule,
        matches,
        card: {
          colour_pattern: COLOUR_PATTERNS[card.colour_pattern],
          shape: SHAPES[card.shape],
          pictured_count: COUNTS[card.count],
        },
      },
    };
  };
}

export const CARD_SORT_INDICATORS: readonly IndicatorBinding[] = [
  {
    moduleId: 'card_sort',
    indicators: [
      'adaptability.perseverative_errors',
      'adaptability.trials_to_reacquire',
      'adaptability.switch_cost_slope',
      'stability.shift_slope_rule_switch',
    ],
  },
];
