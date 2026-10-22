/**
 * The Stall's trial plan (EPI-01): the engine's data-driven schedule (ENG-09) filled by the shared
 * customer-queue paradigm (`paradigms/stall-queue.ts`, `stallOverrides`), then expressed in the closed
 * vocabularies the indicator engine reads (`stats/scoring/.../conventions.py`):
 *
 * | block        | scheduler type | logged `trial_type` | committed code             | expected |
 * |--------------|----------------|---------------------|----------------------------|----------|
 * | practice     | `practice`     | `go` / `nogo`       | `serve` or timeout         | serve / withhold |
 * | service      | `go` / `nogo`  | `go` / `nogo`       | `serve` or timeout         | serve / withhold |
 * | tone_calm    | `tone_choice`  | `tone_choice`       | `warm` / `neutral` / `firm`| null     |
 * | timed_rush   | `go` / `nogo`  | `go` / `nogo`       | `serve` or timeout         | serve / withhold |
 * | rude_run     | `tone_choice`  | `tone_choice`       | `warm` / `neutral` / `firm`| null     |
 * | probe        | `probe_segment`| `probe`             | `safe` / `risky`           | null     |
 *
 * Content mapping (config-driven, deterministic, never re-drawn): the paradigm draws an item index from
 * its default catalogue; the pictured item is the same index in `constraints.serve_items`. No-go reasons
 * outside `constraints.dont_serve_reasons` are mapped onto the first allowed reason (both are no-go, the
 * trial type and position are unchanged). Probe trials get comparable segments of
 * `style.min_trials_per_segment` trials (`stall.probe_<k>`) and situation ids shared by every episode
 * (`probe_situation_<i>`). Every value the module shows is the value it logs.
 */
import type { BlockConfig, CalibrationLevel, GameConfig, GameTrialSpec } from '@shriii/contracts';
import type { SeededRng } from '../../core/contracts.ts';
import { DataDrivenTrialScheduler, type ScheduleResult } from '../../engine/scheduler.ts';
import { constraintStrings } from '../../paradigms/common.ts';
import { STALL_DEFAULTS } from '../../paradigms/content-defaults.ts';
import { stallOverrides, stallToneConfig } from '../../paradigms/stall-queue.ts';
import {
  FEEDBACK_WINDOW_TRIALS,
  HOSTILE_LEVEL_MIN,
  MIN_DISTINCT_TONE_LEVELS,
  PROBE_SEGMENT_TRIALS,
  TONE_CODES_BY_ORDINAL,
} from './params/params.generated.ts';

/** Thrown when the stall config cannot produce a valid plan (fail closed: the module will not run). */
export class StallPlanError extends Error {
  constructor(message: string) {
    super(`[stall] ${message}`);
    this.name = 'StallPlanError';
  }
}

/** Pictured stall goods (the `constraints.serve_items` catalogue). */
export type StallItem = 'mango' | 'banana' | 'laddoo' | 'jalebi' | 'samosa' | 'guava';
export const STALL_ITEMS: readonly StallItem[] = [
  'mango',
  'banana',
  'laddoo',
  'jalebi',
  'samosa',
  'guava',
];

export type ToneCode = 'warm' | 'neutral' | 'firm';
export type ProbeCode = 'safe' | 'risky';
export type CustomerToneLevel = 0 | 1 | 2 | 3 | 4;

/** How a customer looks (seeded, logged): appearance variant and cloth colourway. */
export interface CustomerLook {
  readonly variant: number;
  readonly cloth: number;
}

interface TrialBase {
  readonly spec: GameTrialSpec;
  readonly block: BlockConfig;
  /** Position within the block (0-based). */
  readonly withinBlock: number;
  /** Trial type written to `trial_start` (scoring convention). */
  readonly trialType: 'go' | 'nogo' | 'tone_choice' | 'probe';
  readonly expectedResponse: string | null;
  readonly stimulusId: string;
  /** Customer tone level written to `condition.customer_tone_level` (every trial carries one). */
  readonly toneLevel: CustomerToneLevel;
  /** Params joined to the trial by the scorer (`GameTrialSpec.params` plus the stall mapping). */
  readonly params: Readonly<Record<string, unknown>>;
  /** First trial under the context shift (logs `context_shift`). */
  readonly contextShift: boolean;
  readonly customer: CustomerLook;
}

/** A serving (go/no-go) trial: practice, service or timed rush. */
export interface ServeTrial extends TrialBase {
  readonly kind: 'serve';
  readonly trialType: 'go' | 'nogo';
  readonly item: StallItem;
  /** The plate holds a spoiled item (the no-go cue). */
  readonly spoiled: boolean;
  readonly dontServeReason: 'spoiled' | null;
  /** Scripted negative feedback: the customer grumbles whatever the player does. */
  readonly feedback: 'negative' | 'none';
  readonly rush: boolean;
  readonly practice: boolean;
}

/** A tone-choice trial: calm customers or the rude-customer run. */
export interface ToneTrial extends TrialBase {
  readonly kind: 'tone';
  readonly trialType: 'tone_choice';
  readonly provocation: boolean;
  readonly scriptId: string;
  /** Pre-recorded customer line voiced for this tone level (stimulus property). */
  readonly lineId: string;
  /** The item the customer collects after the exchange (decoration, not a response). */
  readonly item: StallItem;
}

/** A cross-episode probe: a quick pick between a sure handful of coins and a covered pot. */
export interface ProbeTrial extends TrialBase {
  readonly kind: 'probe';
  readonly trialType: 'probe';
  readonly probeIndex: number;
  readonly probeGroupId: string;
  readonly repeatGroupId: string;
  /** Coins in the sure offer (pictured, never written). */
  readonly sureCoins: number;
}

export type StallTrial = ServeTrial | ToneTrial | ProbeTrial;

/** The complete plan for one session. */
export interface StallPlan {
  readonly schedule: ScheduleResult;
  readonly trials: readonly StallTrial[];
  readonly blockOrder: readonly string[];
  readonly contextShiftIndex: number | null;
  readonly toneCodes: readonly ToneCode[];
  readonly probeCodes: readonly ProbeCode[];
  readonly serveItems: readonly StallItem[];
}

/** Customer lines per tone level (`content/i18n/lines.yaml`: calm = levels 0-1, hostile = 3-4). */
export const CALM_LINE = 'stall.customer.calm';
export const HOSTILE_LINE = 'stall.customer.hostile';

/** Line voiced for a customer tone level; level 2 (impatient) has no recording yet and reuses calm. */
export function lineForTone(level: number, hostileMin = HOSTILE_LEVEL_MIN): string {
  return level >= hostileMin ? HOSTILE_LINE : CALM_LINE;
}

function asToneLevel(v: unknown): CustomerToneLevel {
  if (v === 0 || v === 1 || v === 2 || v === 3 || v === 4) return v;
  throw new StallPlanError(`customer tone level ${String(v)} is outside 0..4`);
}

function serveItemsOf(config: GameConfig): StallItem[] {
  const list = constraintStrings(config, 'serve_items');
  if (!list || list.length !== STALL_DEFAULTS.serveItems.length) {
    throw new StallPlanError(
      `constraints.serve_items must list ${STALL_DEFAULTS.serveItems.length} items (one per paradigm item draw)`,
    );
  }
  for (const item of list) {
    if (!(STALL_ITEMS as readonly string[]).includes(item)) {
      throw new StallPlanError(`constraints.serve_items: no artwork for '${item}'`);
    }
  }
  return list as StallItem[];
}

function toneCodesOf(config: GameConfig): ToneCode[] {
  const options = stallToneConfig(config).options;
  const known: readonly string[] = TONE_CODES_BY_ORDINAL;
  for (const o of options) {
    if (!known.includes(o)) throw new StallPlanError(`tone option '${o}' is not in tone.ordinal`);
  }
  // Present warm .. firm (highest ordinal first), the order of the configured options when it matches.
  return [...options].sort((a, b) => known.indexOf(b) - known.indexOf(a)) as ToneCode[];
}

function probeCodesOf(config: GameConfig): ProbeCode[] {
  const list = constraintStrings(config, 'probe_options') ?? ['safe', 'risky'];
  if (list.length !== 2 || !list.includes('safe') || !list.includes('risky')) {
    throw new StallPlanError('constraints.probe_options must be ["safe", "risky"]');
  }
  return ['safe', 'risky'];
}

/**
 * Cloth colourways used for customers (0 = original clothes, then two kit colourways). Kept small so
 * every look in a session can be pre-baked before the first trial (no texture baking mid-trial).
 */
const CLOTH_VARIANTS = 3;

function lookFor(spec: GameTrialSpec, fallbackVariant: number): CustomerLook {
  const p = spec.params as Record<string, unknown>;
  const variant = typeof p.customer_variant === 'number' ? p.customer_variant : fallbackVariant;
  const seed = typeof p.variant === 'number' ? p.variant : 0;
  return { variant, cloth: seed % CLOTH_VARIANTS };
}

/**
 * Build the stall plan. Pure: the same (config, level, rng, form) always gives the same plan.
 * @throws StallPlanError / ScheduleConstraintError / ParadigmConfigError when the config is unusable.
 */
export function buildStallPlan(
  config: GameConfig,
  level: CalibrationLevel,
  rng: SeededRng,
  formId: string,
): StallPlan {
  if (config.module_id !== 'stall') throw new StallPlanError(`config is ${config.module_id}`);
  const serveItems = serveItemsOf(config);
  const toneCodes = toneCodesOf(config);
  const probeCodes = probeCodesOf(config);
  const allowedReasons = constraintStrings(config, 'dont_serve_reasons') ?? ['spoiled'];
  if (!allowedReasons.includes('spoiled')) {
    throw new StallPlanError('constraints.dont_serve_reasons must include "spoiled"');
  }
  const scheduler = new DataDrivenTrialScheduler({
    generators: {
      stall: stallOverrides({
        hostileLevelMin: HOSTILE_LEVEL_MIN,
        feedbackWindow: FEEDBACK_WINDOW_TRIALS,
      }),
    },
  });
  const schedule = scheduler.build(config, level, rng, formId);
  const blocks = new Map(config.blocks.map((b) => [b.block_id, b] as const));
  const trials: StallTrial[] = [];
  let prevLook: CustomerLook | null = null;
  let probeOrdinal = 0;
  for (const spec of schedule.trials) {
    const block = blocks.get(spec.block_id);
    if (!block) throw new StallPlanError(`unknown block ${spec.block_id}`);
    const withinBlock = Number(spec.trial_id.split('.').pop());
    const p = spec.params as Record<string, unknown>;
    let look = lookFor(spec, withinBlock % 8);
    if (prevLook && prevLook.variant === look.variant && prevLook.cloth === look.cloth) {
      look = { variant: look.variant, cloth: (look.cloth + 1) % CLOTH_VARIANTS };
    }
    prevLook = look;
    const contextShift = p.context_shift === true;
    const base = { spec, block, withinBlock, contextShift, customer: look };

    if (spec.trial_type === 'practice') {
      // Practice: one fresh item to serve, then one spoiled item to hold back (non-scorable).
      const nogo = withinBlock % 2 === 1;
      const item = serveItems[withinBlock % serveItems.length] as StallItem;
      trials.push({
        ...base,
        kind: 'serve',
        trialType: nogo ? 'nogo' : 'go',
        expectedResponse: nogo ? 'withhold' : 'serve',
        stimulusId: nogo ? `stall.spoiled.${item}` : `stall.${item}`,
        toneLevel: 0,
        item,
        spoiled: nogo,
        dontServeReason: nogo ? 'spoiled' : null,
        feedback: 'none',
        rush: false,
        practice: true,
        params: {
          ...p,
          feedback: 'none',
          item,
          dont_serve_reason: nogo ? 'spoiled' : null,
          customer_tone_level: 0,
          customer_variant: look.variant,
          customer_cloth: look.cloth,
          rush: false,
          practice: true,
        },
      });
      continue;
    }

    if (spec.trial_type === 'go' || spec.trial_type === 'nogo') {
      const drawn = String(p.item);
      const idx = (STALL_DEFAULTS.serveItems as readonly string[]).indexOf(drawn);
      if (idx < 0) throw new StallPlanError(`paradigm item '${drawn}' is not in the catalogue`);
      const item = serveItems[idx] as StallItem;
      const nogo = spec.trial_type === 'nogo';
      const drawnReason = p.dont_serve_reason;
      const reason: 'spoiled' | null = nogo ? 'spoiled' : null;
      const toneLevel = asToneLevel(p.customer_tone_level);
      const feedback = p.feedback === 'negative' ? 'negative' : 'none';
      trials.push({
        ...base,
        kind: 'serve',
        trialType: nogo ? 'nogo' : 'go',
        expectedResponse: nogo ? 'withhold' : 'serve',
        stimulusId: nogo ? `stall.spoiled.${item}` : `stall.${item}`,
        toneLevel,
        item,
        spoiled: nogo,
        dontServeReason: reason,
        feedback,
        rush: block.phase === 'pressure',
        practice: false,
        params: {
          ...p,
          item,
          paradigm_item: drawn,
          dont_serve_reason: reason,
          ...(nogo && drawnReason !== reason ? { paradigm_dont_serve_reason: drawnReason } : {}),
          customer_cloth: look.cloth,
        },
      });
      continue;
    }

    if (spec.trial_type === 'tone_choice') {
      const toneLevel = asToneLevel(p.customer_tone_level);
      const scriptId = String(p.script_id ?? spec.stimulus_id ?? `stall.tone.${withinBlock}`);
      const item = serveItems[(spec.trial_index + withinBlock) % serveItems.length] as StallItem;
      trials.push({
        ...base,
        kind: 'tone',
        trialType: 'tone_choice',
        expectedResponse: null,
        stimulusId: scriptId,
        toneLevel,
        provocation: p.provocation === true,
        scriptId,
        lineId: lineForTone(toneLevel),
        item,
        params: {
          ...p,
          line_id: lineForTone(toneLevel),
          customer_cloth: look.cloth,
          collected_item: item,
        },
      });
      continue;
    }

    if (spec.trial_type === 'probe_segment') {
      const probeIndex = typeof p.probe_index === 'number' ? p.probe_index : probeOrdinal;
      const segment = Math.floor(probeOrdinal / PROBE_SEGMENT_TRIALS) + 1;
      probeOrdinal += 1;
      const repeatGroupId = `probe_situation_${probeIndex}`;
      const sureCoins = 2 + (probeIndex % 3);
      trials.push({
        ...base,
        kind: 'probe',
        trialType: 'probe',
        expectedResponse: null,
        stimulusId: spec.stimulus_id ?? `probe.${probeIndex}`,
        toneLevel: 0,
        probeIndex,
        probeGroupId: `stall.probe_${segment}`,
        repeatGroupId,
        sureCoins,
        params: {
          ...p,
          repeat_group_id: repeatGroupId,
          probe_sure_coins: sureCoins,
          customer_tone_level: 0,
          customer_cloth: look.cloth,
        },
      });
      continue;
    }
    throw new StallPlanError(`unexpected trial type '${spec.trial_type}' in ${spec.trial_id}`);
  }

  // Integrity checks (EPI-01 ACs): fail closed rather than run an unmeasurable episode.
  const levels = new Set(
    trials.filter((t) => t.kind === 'tone' && t.spec.scorable).map((t) => t.toneLevel),
  );
  if (levels.size < MIN_DISTINCT_TONE_LEVELS) {
    throw new StallPlanError(
      `tone choices span ${levels.size} customer tone levels (< ${MIN_DISTINCT_TONE_LEVELS})`,
    );
  }
  const shifts = trials.filter((t) => t.contextShift);
  if (shifts.length !== 1 || shifts[0]?.block.phase !== 'shift_post') {
    throw new StallPlanError(
      `expected exactly one context shift at the rude run, got ${shifts.length}`,
    );
  }
  return {
    schedule,
    trials,
    blockOrder: schedule.blockOrder,
    contextShiftIndex: schedule.contextShiftIndex,
    toneCodes,
    probeCodes,
    serveItems,
  };
}

/** `trial_id -> params` for the scorer's join (`GameTrialSpec.params` as the module used them). */
export function trialParamsOf(plan: StallPlan): Record<string, Readonly<Record<string, unknown>>> {
  return Object.fromEntries(plan.trials.map((t) => [t.spec.trial_id, t.params]));
}
