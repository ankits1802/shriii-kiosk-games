/**
 * The Weighing Post trial plan: the engine's data-driven scheduler (ENG-09) with the shared weighing
 * paradigm generator (`paradigms/weighing-post.ts`), mapped onto the event conventions the indicator
 * engine reads (`stats/scoring/src/shriii_scoring/conventions.py`):
 *
 * | scheduler type          | logged `trial_type`     | committed codes                         |
 * |-------------------------|-------------------------|-----------------------------------------|
 * | `practice`, `weigh`     | `weigh_decision`        | `approve` / `warn` / `fine`             |
 * | `bribe`                 | `bribe`                 | `accept` / `decline`                    |
 * | `overpayment`           | `overpayment`           | `return` / `keep`                       |
 * | `assistant_mistake`     | `assistant_mistake`     | `self`/`assistant`/`shared`/`chance` + credit_allocation |
 * | `fraud_found`           | `fraud_found`           | `self`/`assistant`/`shared` + credit_allocation |
 * | `gamble_inspection`     | `gamble_inspection`     | `gamble` / `inspect`                    |
 * | `luck_token`            | `luck_token`            | `face_1..face_6` + report (value only)  |
 * | `probe_segment`         | `probe`                 | `safe` / `risky`                        |
 *
 * Probe segments follow the cross-episode convention: two comparable segments per episode
 * (`weighing_post.probe_1`, `weighing_post.probe_2`, two trials each) and repeat groups
 * `probe_situation_<position>` shared with the other episodes (choice entropy over repeats).
 *
 * The plan is a pure function of (config, level, seed stream, form): trial order, items, dilemma
 * content and the context-shift index never depend on the level or the language.
 */
import type { BlockConfig, CalibrationLevel, GameConfig, GameTrialSpec } from '@shriii/contracts';
import type { SeededRng } from '../../core/contracts.ts';
import { DataDrivenTrialScheduler, type ScheduleResult } from '../../engine/scheduler.ts';
import { reportVocabulary } from '../../paradigms/private-report.ts';
import {
  BASE_RULE,
  DILEMMA_CODES,
  GOODS,
  type GoodId,
  newRuleForForm,
  type WeighDecision,
  type WeighItem,
  type WeighRule,
  weighingPostOverrides,
} from '../../paradigms/weighing-post.ts';
import type { EpisodeParams, ProbeSituation } from './params.ts';

export const MODULE_ID = 'weighing_post';

export type DilemmaKind = 'bribe' | 'overpayment' | 'assistant_mistake' | 'fraud_found';
export type AllocationCode = 'self' | 'assistant' | 'shared' | 'chance';

interface TrialBase {
  /** Scheduler spec with the logged trial type, vocabulary and scoring params. */
  readonly spec: GameTrialSpec;
  readonly block: BlockConfig;
  /** Seeded scene variant (customer look, dialogue staging). */
  readonly variant: number;
  /** True on the first trial under the new market rule (log `context_shift` before it). */
  readonly contextShift: boolean;
}

export interface WeighTrial extends TrialBase {
  readonly kind: 'weigh';
  readonly item: WeighItem;
  readonly rule: WeighRule;
  readonly expected: WeighDecision;
  readonly practice: boolean;
}

export interface DilemmaTrial extends TrialBase {
  readonly kind: DilemmaKind;
  /** Bribe size / overpayment as pictured coins (bribe, overpayment), else null. */
  readonly coins: number | null;
  readonly codes: readonly string[];
}

export interface GambleTrial extends TrialBase {
  readonly kind: 'gamble';
  readonly safeCoins: number;
  readonly winCoins: number;
  readonly catchProbability: number;
}

export interface LuckTrial extends TrialBase {
  readonly kind: 'luck';
  /** 0-based report index within the episode. */
  readonly reportIndex: number;
  readonly faces: number;
}

export interface ProbeTrial extends TrialBase {
  readonly kind: 'probe';
  readonly position: number;
  readonly situation: ProbeSituation;
}

export type EpisodeTrial = WeighTrial | DilemmaTrial | GambleTrial | LuckTrial | ProbeTrial;

export interface EpisodePlan {
  readonly trials: readonly EpisodeTrial[];
  readonly schedule: ScheduleResult;
  readonly baseRule: WeighRule;
  readonly newRule: WeighRule;
  /** Trial index of the first trial under the new market rule. */
  readonly shiftIndex: number | null;
}

/** Thrown when the scheduler output does not match what the episode can present (fail closed). */
export class EpisodePlanError extends Error {
  constructor(message: string) {
    super(`weighing_post plan: ${message}`);
    this.name = 'EpisodePlanError';
  }
}

const DILEMMA_KINDS: ReadonlySet<string> = new Set([
  'bribe',
  'overpayment',
  'assistant_mistake',
  'fraud_found',
]);

/** Number of probe trials per comparable probe segment (cross-episode convention). */
export const PROBE_SEGMENT_TRIALS = 2;

function isGood(v: unknown): v is GoodId {
  return typeof v === 'string' && (GOODS as readonly string[]).includes(v);
}

function intParam(params: Readonly<Record<string, unknown>>, key: string): number {
  const v = params[key];
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new EpisodePlanError(`trial param ${key} must be an integer`);
  }
  return v;
}

function variantOf(params: Readonly<Record<string, unknown>>): number {
  const v = params.variant;
  return typeof v === 'number' && Number.isFinite(v) ? v >>> 0 : 0;
}

/** Build the episode plan. Throws {@link EpisodePlanError} / `ScheduleConstraintError` when invalid. */
export function buildEpisodePlan(
  config: GameConfig,
  level: CalibrationLevel,
  rng: SeededRng,
  formId: string,
  params: EpisodeParams,
): EpisodePlan {
  if (config.module_id !== MODULE_ID) {
    throw new EpisodePlanError(`config is for ${config.module_id}, not ${MODULE_ID}`);
  }
  if (config.context_shift && config.context_shift.kind !== 'new_market_rule') {
    throw new EpisodePlanError(`unexpected context shift ${config.context_shift.kind}`);
  }
  const schedule = new DataDrivenTrialScheduler({
    generators: { [MODULE_ID]: weighingPostOverrides() },
  }).build(config, level, rng, formId);
  const blocks = new Map(config.blocks.map((b) => [b.block_id, b] as const));
  const newRule = newRuleForForm(formId);
  let luckIndex = 0;
  let probePosition = 0;
  let shiftIndex: number | null = null;
  const trials: EpisodeTrial[] = [];

  for (const spec of schedule.trials) {
    const block = blocks.get(spec.block_id);
    if (!block) throw new EpisodePlanError(`trial ${spec.trial_id} has unknown block`);
    const p = spec.params as Readonly<Record<string, unknown>>;
    const variant = variantOf(p);
    const contextShift = p.context_shift === true;
    if (contextShift) shiftIndex = spec.trial_index;
    const base = { block, variant, contextShift };
    const t = spec.trial_type;

    if (t === 'weigh' || t === 'practice') {
      const good = p.good_id;
      if (!isGood(good)) throw new EpisodePlanError(`trial ${spec.trial_id} has no good`);
      const item: WeighItem = {
        good,
        trueWeight: intParam(p, 'true_weight_ticks'),
        declaredWeight: intParam(p, 'declared_weight_ticks'),
        ambiguous: p.ambiguous === true,
      };
      const rule = p.rule_id === newRule.id ? newRule : BASE_RULE;
      const expected = spec.expected_response as WeighDecision | null;
      if (expected !== 'approve' && expected !== 'warn' && expected !== 'fine') {
        throw new EpisodePlanError(`trial ${spec.trial_id} has no expected decision`);
      }
      trials.push({
        ...base,
        kind: 'weigh',
        item,
        rule,
        expected,
        practice: block.phase === 'practice',
        spec: { ...spec, trial_type: 'weigh_decision' },
      });
      continue;
    }
    if (DILEMMA_KINDS.has(t)) {
      const kind = t as DilemmaKind;
      const coins = typeof p.pictured_coins === 'number' ? p.pictured_coins : null;
      trials.push({
        ...base,
        kind,
        coins,
        codes: DILEMMA_CODES[kind],
        spec,
      });
      continue;
    }
    if (t === 'gamble_inspection') {
      trials.push({
        ...base,
        kind: 'gamble',
        safeCoins: params.gambleSafeCoins,
        winCoins: params.gambleWinCoins,
        catchProbability: params.gambleCatchProbability,
        spec: {
          ...spec,
          stimulus_id: `${MODULE_ID}.gamble.${intParam(p, 'variant') % 3}`,
          params: {
            ...p,
            safe_coins: params.gambleSafeCoins,
            win_coins: params.gambleWinCoins,
            catch_probability: params.gambleCatchProbability,
          },
        },
      });
      continue;
    }
    if (t === 'luck_token') {
      const vocabulary = reportVocabulary(params.luckFaces);
      trials.push({
        ...base,
        kind: 'luck',
        reportIndex: luckIndex,
        faces: params.luckFaces,
        spec: {
          ...spec,
          stimulus_id: `${MODULE_ID}.luck_token`,
          vocabulary,
          voice_vocabulary: [],
          private_report: true,
          expected_response: null,
          params: { ...p, report_index: luckIndex, faces: params.luckFaces },
        },
      });
      luckIndex += 1;
      continue;
    }
    if (t === 'probe_segment') {
      const position = probePosition;
      probePosition += 1;
      const situation =
        params.probeSituations[position % params.probeSituations.length] ??
        params.probeSituations[0];
      if (!situation) throw new EpisodePlanError('no probe situations configured');
      const segment = Math.floor(position / PROBE_SEGMENT_TRIALS) + 1;
      trials.push({
        ...base,
        kind: 'probe',
        position,
        situation,
        spec: {
          ...spec,
          trial_type: 'probe',
          vocabulary: ['safe', 'risky'],
          voice_vocabulary: [],
          expected_response: null,
          probe_group_id: `${MODULE_ID}.probe_${segment}`,
          params: {
            ...p,
            repeat_group_id: `probe_situation_${position}`,
            safe_items: situation.safeItems,
            risky_items: situation.riskyItems,
          },
        },
      });
      continue;
    }
    throw new EpisodePlanError(`unsupported trial type ${t} (${spec.trial_id})`);
  }
  if (config.context_shift && shiftIndex === null) {
    throw new EpisodePlanError('the configured new-market-rule shift was not scheduled');
  }
  return { trials, schedule, baseRule: BASE_RULE, newRule, shiftIndex };
}

/** `session_id`-free view of the trial params the scoring engine joins by `trial_id`. */
export function trialParamsOf(
  plan: EpisodePlan,
): Record<string, Readonly<Record<string, unknown>>> {
  const out: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const t of plan.trials) out[t.spec.trial_id] = t.spec.params as Record<string, unknown>;
  return out;
}

/** Pictured discrepancy in needle ticks: positive = short weight (the weights pan sinks). */
export function discrepancyTicks(item: Pick<WeighItem, 'trueWeight' | 'declaredWeight'>): number {
  return item.declaredWeight - item.trueWeight;
}

/** Closed codes of a dilemma kind (typed). */
export function allocationCodes(
  kind: 'assistant_mistake' | 'fraud_found',
): readonly AllocationCode[] {
  return DILEMMA_CODES[kind] as readonly AllocationCode[];
}
