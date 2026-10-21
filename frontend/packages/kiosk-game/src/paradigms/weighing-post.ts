/**
 * Weighing-post decision model (EPI-02 The Weighing Post, Weighmaster).
 *
 * Goods arrive with a declared weight on their tag (spoken by the seller, pictured as a tag needle)
 * and a true weight shown on the balance (needle and pans). Weights are integer needle ticks; no
 * numeral is ever needed (`requires_numeracy: false`). The player decides `approve`, `warn` or
 * `fine`, optionally after "inspect more" (an ambiguous, wobbling needle settles after one
 * inspection: `required_inspections`).
 *
 * Rule sets compare the discrepancy `declared - true` (positive = short weight, the buyer is cheated):
 * `<= approveWithin` -> approve, `<= warnWithin` -> warn, else fine; when `shortWeightOnly` is false
 * the absolute discrepancy is used (under-declaring is also an offence). The announced "new market
 * rule" (`context_shift: new_market_rule`) swaps the rule set mid-episode; forms carry different
 * new-rule content (ENG-14). Post-shift items are drawn so that most of them are rule-diagnostic
 * (the old and new rules disagree), which is what `adaptability.rule_compliance_post_shift` needs.
 *
 * Dilemmas (>= 3 per type, EPI-02): bribe (`accept`/`decline`), overpayment (`return`/`keep`),
 * assistant's mistake and fraud found (credit/blame allocation: `self`, `assistant`, `shared`,
 * `chance`), and a gamble inspection (`gamble`/`inspect`). Integrity outputs are restricted research
 * indicators and never an individual dishonesty label.
 */
import type { CreditAllocationPayload, GameConfig } from '@shriii/contracts';
import type { SeededRng } from '../core/contracts.ts';
import type { TrialOverrideGenerator } from '../engine/scheduler.ts';
import { type IndicatorBinding, ParadigmConfigError, ParadigmStateError } from './common.ts';
import { WEIGHING_DEFAULTS } from './content-defaults.ts';

const PARADIGM = 'weighing_decision';

export type WeighDecision = 'approve' | 'warn' | 'fine';
export const WEIGH_DECISIONS: readonly WeighDecision[] = ['approve', 'warn', 'fine'];

export interface WeighRule {
  readonly id: string;
  readonly approveWithin: number;
  readonly warnWithin: number;
  /** True: only short weight (declared > true) counts; false: absolute discrepancy. */
  readonly shortWeightOnly: boolean;
}

/** The goods catalogue (art-kit ids; pictured, never named in text). */
export const GOODS = [
  'rice_sack',
  'onion_basket',
  'lentil_bag',
  'jaggery_block',
  'potato_sack',
  'chilli_bundle',
] as const;
export type GoodId = (typeof GOODS)[number];

export interface WeighItem {
  readonly good: GoodId;
  readonly trueWeight: number;
  readonly declaredWeight: number;
  /** The needle wobbles until one "inspect more" (requires one inspection). */
  readonly ambiguous: boolean;
}

/** Baseline rule (before the shift). */
export const BASE_RULE: WeighRule = { id: 'base', ...WEIGHING_DEFAULTS.baseRule };

/**
 * New market rule per form (ENG-14: different new-rule content per form, equal difficulty):
 * odd forms tighten short-weight tolerance; even forms make under-declaring an offence too.
 */
export function newRuleForForm(formId: string): WeighRule {
  const m = /(\d+)$/.exec(formId);
  const k = m ? Number(m[1]) : 1;
  if (k % 2 === 1) return { id: 'new_rule.zero_tolerance', ...WEIGHING_DEFAULTS.newRule };
  return { id: 'new_rule.both_directions', ...WEIGHING_DEFAULTS.baseRule, shortWeightOnly: false };
}

/** The decision the rule requires for an item. */
export function correctDecision(
  item: Pick<WeighItem, 'trueWeight' | 'declaredWeight'>,
  rule: WeighRule,
): WeighDecision {
  if (rule.approveWithin < 0 || rule.warnWithin < rule.approveWithin) {
    throw new ParadigmConfigError(PARADIGM, `rule ${rule.id} has inconsistent tolerances`);
  }
  const d = item.declaredWeight - item.trueWeight;
  const disc = rule.shortWeightOnly ? Math.max(0, d) : Math.abs(d);
  if (disc <= rule.approveWithin) return 'approve';
  if (disc <= rule.warnWithin) return 'warn';
  return 'fine';
}

/** Compliant responses (scoring param `compliant_responses`): exactly the rule's decision. */
export function compliantResponses(item: WeighItem, rule: WeighRule): WeighDecision[] {
  return [correctDecision(item, rule)];
}

/** Draw an item. `diagnosticAgainst`: require the decision to differ under that other rule. */
export function drawWeighItem(
  rng: SeededRng,
  options: { readonly rule: WeighRule; readonly diagnosticAgainst?: WeighRule | null },
): WeighItem {
  const { minWeight, maxWeight, honestShare, ambiguousShare } = WEIGHING_DEFAULTS;
  for (let attempt = 0; attempt < 256; attempt += 1) {
    const trueWeight = rng.int(minWeight, maxWeight);
    const honest = rng.bool(honestShare);
    const delta = honest ? 0 : rng.pick([-2, -1, 1, 2, 3]);
    const declaredWeight = trueWeight + delta;
    if (declaredWeight < 1) continue;
    const item: WeighItem = {
      good: rng.pick(GOODS),
      trueWeight,
      declaredWeight,
      ambiguous: rng.bool(ambiguousShare),
    };
    if (
      options.diagnosticAgainst &&
      correctDecision(item, options.rule) === correctDecision(item, options.diagnosticAgainst)
    ) {
      continue;
    }
    return item;
  }
  throw new ParadigmStateError(
    PARADIGM,
    'could not draw a weighing item satisfying the constraints',
  );
}

/** Record of one weighing decision. */
export interface WeighDecisionRecord {
  readonly decision: WeighDecision | null;
  readonly correct: boolean | null;
  readonly inspections: number;
  readonly requiredInspections: number;
  readonly excessInspections: number;
  /** Decisions changed before confirm (from `revisions[]`). */
  readonly revisions: number;
}

/** Classify a weighing decision (`null` decision = timeout). */
export function classifyWeighDecision(
  item: WeighItem,
  rule: WeighRule,
  response: {
    readonly decision: WeighDecision | null;
    readonly inspections: number;
    readonly revisions: number;
  },
): WeighDecisionRecord {
  const required = item.ambiguous ? 1 : 0;
  return {
    decision: response.decision,
    correct: response.decision === null ? null : response.decision === correctDecision(item, rule),
    inspections: response.inspections,
    requiredInspections: required,
    excessInspections: Math.max(0, response.inspections - required),
    revisions: response.revisions,
  };
}

/* ------------------------------------------------------------------------------------------------
 * Dilemmas and credit/blame allocation
 * ---------------------------------------------------------------------------------------------- */

export type DilemmaType = 'bribe' | 'overpayment' | 'assistant_mistake' | 'fraud_found';
export const DILEMMA_TYPES: readonly DilemmaType[] = [
  'bribe',
  'overpayment',
  'assistant_mistake',
  'fraud_found',
];

/** Closed response codes per dilemma (scoring convention). */
export const DILEMMA_CODES: Readonly<
  Record<DilemmaType | 'gamble_inspection', readonly [string, ...string[]]>
> = {
  bribe: ['accept', 'decline'],
  overpayment: ['return', 'keep'],
  assistant_mistake: ['self', 'assistant', 'shared', 'chance'],
  fraud_found: ['self', 'assistant', 'shared'],
  gamble_inspection: ['gamble', 'inspect'],
};

export type AllocationTarget = CreditAllocationPayload['target'];

/** Self share of credit/blame for an allocation target (self 1, shared 0.5, others 0). */
export function selfShareOf(target: AllocationTarget): number {
  switch (target) {
    case 'self':
      return 1;
    case 'shared':
      return 0.5;
    case 'assistant':
    case 'partner':
    case 'chance':
      return 0;
    default: {
      const never: never = target;
      throw new ParadigmConfigError(PARADIGM, `unknown target ${String(never)}`);
    }
  }
}

/** `credit_allocation` payload for an assistant-mistake (failure) or fraud-found (success) dilemma. */
export function creditAllocationPayload(
  context: 'assistant_mistake' | 'fraud_found',
  target: AllocationTarget,
): CreditAllocationPayload {
  const allowed = DILEMMA_CODES[context];
  if (!allowed.includes(target)) {
    throw new ParadigmStateError(PARADIGM, `target ${target} is not an option for ${context}`);
  }
  return {
    allocation_context: context,
    outcome: context === 'fraud_found' ? 'success' : 'failure',
    target,
    self_share: selfShareOf(target),
  };
}

/** Per-dilemma content: pictured coin counts (1-3), scripted and seeded. */
export interface DilemmaContent {
  readonly type: DilemmaType;
  /** Bribe size or overpayment as pictured coins; null for allocation dilemmas. */
  readonly coins: number | null;
  /** Scene variant for the art kit. */
  readonly variant: number;
}

export function drawDilemma(type: DilemmaType, rng: SeededRng): DilemmaContent {
  return {
    type,
    coins: type === 'bribe' || type === 'overpayment' ? rng.int(1, 3) : null,
    variant: rng.int(0, 2),
  };
}

/** Gamble inspection: `gamble` risks a pictured fine with probability `catchProbability` (seeded resolution). */
export function resolveGamble(
  choice: 'gamble' | 'inspect',
  catchProbability: number,
  rng: SeededRng,
): 'caught' | 'safe' {
  if (!(catchProbability >= 0 && catchProbability <= 1)) {
    throw new ParadigmConfigError(PARADIGM, 'catch probability must be in [0, 1]');
  }
  if (choice === 'inspect') return 'safe';
  return rng.bool(catchProbability) ? 'caught' : 'safe';
}

/* ------------------------------------------------------------------------------------------------
 * Scheduler integration
 * ---------------------------------------------------------------------------------------------- */

function isPostShiftBlock(blockId: string, phase: string): boolean {
  return phase === 'shift_post' || blockId === 'decisions_post';
}

/**
 * Scheduler override generator for the Weighing Post: weighing items (rule-aware, diagnostic after
 * the shift), dilemma content and response codes. `diagnosticShare` of post-shift items (default
 * 0.75) are rule-diagnostic.
 */
export function weighingPostOverrides(
  options: { readonly diagnosticShare?: number } = {},
): TrialOverrideGenerator {
  const share = options.diagnosticShare ?? 0.75;
  if (!(share >= 0 && share <= 1))
    throw new ParadigmConfigError(PARADIGM, 'diagnosticShare must be in [0, 1]');
  return ({ trial, block, rng }) => {
    const t = trial.trial_type;
    if (t === 'weigh' || block.block_id.startsWith('decisions') || block.phase === 'practice') {
      if (t === 'probe_segment') return {};
      const post = isPostShiftBlock(block.block_id, block.phase);
      const newRule = newRuleForForm(trial.form_id);
      const rule = post ? newRule : BASE_RULE;
      const item = drawWeighItem(rng, {
        rule,
        diagnosticAgainst: post && rng.bool(share) ? BASE_RULE : null,
      });
      return {
        stimulus_id: `weighing_post.${item.good}`,
        vocabulary: [...WEIGH_DECISIONS] as [string, ...string[]],
        voice_vocabulary: trial.voice_vocabulary.length > 0 ? [...WEIGH_DECISIONS] : [],
        expected_response: correctDecision(item, rule),
        params: {
          good_id: item.good,
          true_weight_ticks: item.trueWeight,
          declared_weight_ticks: item.declaredWeight,
          ambiguous: item.ambiguous,
          required_inspections: item.ambiguous ? 1 : 0,
          compliant_responses: compliantResponses(item, rule),
          rule_id: rule.id,
        },
      };
    }
    if ((DILEMMA_TYPES as readonly string[]).includes(t)) {
      const d = drawDilemma(t as DilemmaType, rng);
      const codes = DILEMMA_CODES[t as DilemmaType];
      return {
        stimulus_id: `weighing_post.${t}.${d.variant}`,
        vocabulary: [...codes] as [string, ...string[]],
        voice_vocabulary: t === 'bribe' || trial.voice_vocabulary.length === 0 ? [] : [...codes],
        expected_response: null,
        params: { pictured_coins: d.coins, variant: d.variant },
      };
    }
    if (t === 'gamble_inspection') {
      return {
        vocabulary: [...DILEMMA_CODES.gamble_inspection] as [string, ...string[]],
        voice_vocabulary:
          trial.voice_vocabulary.length > 0 ? [...DILEMMA_CODES.gamble_inspection] : [],
        expected_response: null,
        params: { variant: rng.int(0, 2) },
      };
    }
    return {};
  };
}

/** Validate that a config declares the shift this model implements. */
export function assertWeighingConfig(config: GameConfig): void {
  if (config.context_shift && config.context_shift.kind !== 'new_market_rule') {
    throw new ParadigmConfigError(
      PARADIGM,
      `unexpected context shift ${config.context_shift.kind}`,
    );
  }
}

export const WEIGHING_POST_INDICATORS: readonly IndicatorBinding[] = [
  {
    moduleId: 'weighing_post',
    indicators: [
      'decisiveness.time_to_commit',
      'decisiveness.reversals_before_confirm',
      'decisiveness.info_gathered',
      'decisiveness.commit_rvi',
      'adaptability.rule_compliance_post_shift',
      'stability.shift_slope_new_rule',
      'judgement.credit_taking',
      'judgement.blame_shifting',
      'judgement.consistency_across_dilemmas',
      'integrity.bribe_acceptance',
      'integrity.overpayment_return',
      'risk_preference.gamble_rate',
    ],
  },
];
