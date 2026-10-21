/**
 * Customer-queue model for The Stall (EPI-01, Table for One).
 *
 * - Serving (go/no-go, MG-02 logic, classified with `classifyGngTrial`): customers ask for an item;
 *   fresh, in-turn items are served (go); spoiled items and out-of-turn customers are not
 *   (no-go, "don't-serve items").
 * - Rush block (`timed_rush`, phase `pressure`): the same serving with a timer and crowd noise; the
 *   shorter serve window comes from the level table (`rush_serve_window_ms`).
 * - Tone choices: the player answers a customer by tapping a warm, neutral or firm face. Customer
 *   tone is a STIMULUS property (pre-recorded voice variant and animated face at a manifest tone
 *   level `0..4`, `constraints.customer_tone_levels`); it is never sensing of the player.
 * - Rude-run sequence (the episode's single context shift, `rude_customer_run`, unannounced):
 *   `planned_counts.provocations` hostile customers (tone level >= the hostile threshold, a YAML
 *   parameter `tone.hostile_level_min` passed in by the caller) plus mid-level customers. The tone
 *   level sequence is identical across forms; the customer scripts (voice/face variants) differ per
 *   form at equal tone levels (ENG-14).
 * - Scripted negative feedback (`params.feedback = negative`): a customer grumbles regardless of the
 *   player's action on `planned_counts.feedback_events` serving trials, each followed by a complete
 *   recovery window (`feedback_recovery.window_trials`, YAML) inside the service block.
 */
import type { GameConfig } from '@shriii/contracts';
import type { SeededRng } from '../core/contracts.ts';
import { createKeyedRng } from '../engine/rng.ts';
import type { TrialOverrideGenerator } from '../engine/scheduler.ts';
import {
  constraintNumbers,
  constraintStrings,
  type IndicatorBinding,
  ParadigmConfigError,
} from './common.ts';
import { STALL_DEFAULTS } from './content-defaults.ts';

const PARADIGM = 'stall_queue';

export type ToneOption = 'warm' | 'neutral' | 'firm';
export type ServeItem = (typeof STALL_DEFAULTS.serveItems)[number];
export type DontServeReason = 'spoiled' | 'out_of_turn';

export interface ServeCustomer {
  readonly kind: 'go' | 'nogo';
  readonly item: ServeItem;
  readonly dontServeReason: DontServeReason | null;
  readonly toneLevel: number;
  readonly variant: number;
}

export interface ToneCustomer {
  readonly toneLevel: number;
  readonly provocation: boolean;
  /** Voice/face script id (form-specific at equal tone levels). */
  readonly scriptId: string;
  readonly variant: number;
}

/** Tone levels and options from the config (`customer_tone_levels`, `tone_options`). */
export function stallToneConfig(config: GameConfig): {
  readonly levels: readonly number[];
  readonly options: readonly string[];
} {
  const levels = constraintNumbers(config, 'customer_tone_levels');
  const options = constraintStrings(config, 'tone_options');
  if (!levels || levels.length < 3 || levels.some((l) => !Number.isInteger(l) || l < 0 || l > 4)) {
    throw new ParadigmConfigError(
      PARADIGM,
      'constraints.customer_tone_levels must list >= 3 levels in 0..4',
    );
  }
  if (!options || options.length < 2)
    throw new ParadigmConfigError(PARADIGM, 'constraints.tone_options missing');
  return { levels: [...levels].sort((a, b) => a - b), options };
}

/** A serving customer for a go/no-go trial. Calm tone (lowest two levels). */
export function drawServeCustomer(
  kind: 'go' | 'nogo',
  levels: readonly number[],
  rng: SeededRng,
): ServeCustomer {
  const calm = levels.slice(0, 2);
  return {
    kind,
    item: rng.pick(STALL_DEFAULTS.serveItems),
    dontServeReason: kind === 'nogo' ? (rng.bool() ? 'spoiled' : 'out_of_turn') : null,
    toneLevel: rng.pick(calm),
    variant: rng.int(0, 7),
  };
}

/**
 * Calm-block tone levels: the levels below the hostile threshold, balanced over `n` trials
 * (counts differ by at most one) in a seeded order.
 */
export function calmToneSequence(
  n: number,
  levels: readonly number[],
  hostileMin: number,
  rng: SeededRng,
): number[] {
  const calm = levels.filter((l) => l < hostileMin);
  if (calm.length === 0)
    throw new ParadigmConfigError(PARADIGM, 'no tone level below the hostile threshold');
  const seq: number[] = [];
  for (let i = 0; i < n; i += 1) seq.push(calm[i % calm.length] as number);
  return rng.shuffle(seq);
}

/**
 * Rude-run tone levels: `provocations` hostile customers (levels >= `hostileMin`, balanced) and the
 * rest at the highest non-hostile level; the run never starts with a non-hostile customer.
 * Keyed by `configId` only, so every form has the same tone-level sequence.
 */
export function rudeRunToneSequence(
  configId: string,
  n: number,
  provocations: number,
  levels: readonly number[],
  hostileMin: number,
): number[] {
  const hostile = levels.filter((l) => l >= hostileMin);
  const mid = levels.filter((l) => l < hostileMin);
  if (hostile.length === 0)
    throw new ParadigmConfigError(PARADIGM, 'no hostile tone level in customer_tone_levels');
  const k = Math.min(n, provocations);
  if (k < n && mid.length === 0)
    throw new ParadigmConfigError(PARADIGM, 'no non-hostile level for the rest of the run');
  const rng = createKeyedRng(`${configId}|rude_run`, 'stall');
  const hostileSeq: number[] = [];
  for (let i = 0; i < k; i += 1) hostileSeq.push(hostile[i % hostile.length] as number);
  const midLevel = mid[mid.length - 1] as number;
  const rest = new Array<number>(n - k).fill(midLevel);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const seq = rng.shuffle([...rng.shuffle(hostileSeq), ...rest]);
    if (n === 0 || (seq[0] as number) >= hostileMin) return seq;
  }
  return [...hostileSeq, ...rest];
}

/** Rude-run customers: tone levels from {@link rudeRunToneSequence}, scripts keyed by form. */
export function buildRudeRun(options: {
  readonly configId: string;
  readonly formId: string;
  readonly length: number;
  readonly provocations: number;
  readonly levels: readonly number[];
  readonly hostileMin: number;
}): ToneCustomer[] {
  const tones = rudeRunToneSequence(
    options.configId,
    options.length,
    options.provocations,
    options.levels,
    options.hostileMin,
  );
  const scripts = createKeyedRng(`${options.configId}|${options.formId}|rude_scripts`, 'stall');
  return tones.map((toneLevel, i) => ({
    toneLevel,
    provocation: toneLevel >= options.hostileMin,
    scriptId: `stall.${options.formId}.rude.${i}`,
    variant: scripts.int(0, 7),
  }));
}

/**
 * Positions (within a block) of scripted negative-feedback events: `count` events, at least `minGap`
 * trials apart, each followed by `window` trials inside the first `usableLength` trials.
 */
export function placeFeedbackEvents(
  usableLength: number,
  count: number,
  window: number,
  minGap: number,
  rng: SeededRng,
): number[] {
  const last = usableLength - 1 - window;
  if (count === 0) return [];
  if (last < 0 || minGap < 1)
    throw new ParadigmConfigError(PARADIGM, 'feedback events do not fit the block');
  const slack = last - (count - 1) * minGap;
  if (slack < 0)
    throw new ParadigmConfigError(
      PARADIGM,
      `${count} feedback events with gap ${minGap} do not fit ${usableLength} trials`,
    );
  // Distribute the slack over count + 1 gaps (stars and bars), seeded.
  const cuts = Array.from({ length: count }, () => rng.int(0, slack)).sort((a, b) => a - b);
  return cuts.map((c, i) => c + i * minGap);
}

/** Tone ordinal for logging QA (`tone.ordinal` lives in YAML; this only orders the options as listed). */
export function toneCode(option: string, options: readonly string[]): ToneOption | null {
  return options.includes(option) &&
    (option === 'warm' || option === 'neutral' || option === 'firm')
    ? option
    : null;
}

/**
 * Scheduler override generator for The Stall. Thresholds come from YAML via the caller:
 * `hostileLevelMin` (`tone.hostile_level_min`) and `feedbackWindow` (`feedback_recovery.window_trials`).
 * Stateful per schedule build (resets at trial index 0); relies on in-order materialisation.
 */
export function stallOverrides(options: {
  readonly hostileLevelMin: number;
  readonly feedbackWindow: number;
}): TrialOverrideGenerator {
  let feedback: Set<number> | null = null;
  let rude: ToneCustomer[] | null = null;
  return ({ trial, block, config, rng }) => {
    if (trial.trial_index === 0) {
      feedback = null;
      rude = null;
    }
    const tone = stallToneConfig(config);
    const within = Number(trial.trial_id.split('.').pop());
    const t = trial.trial_type;
    if (t === 'go' || t === 'nogo') {
      const c = drawServeCustomer(t, tone.levels, rng);
      let fb = 'none';
      if (block.block_id === 'service') {
        if (!feedback) {
          const count = config.planned_counts.feedback_events ?? 0;
          const placeRng = createKeyedRng(`${config.config_id}|${trial.form_id}|feedback`, 'stall');
          feedback = new Set(
            placeFeedbackEvents(block.min_trials, count, options.feedbackWindow, 2, placeRng),
          );
        }
        if (feedback.has(within)) fb = 'negative';
      }
      return {
        stimulus_id: `stall.${c.kind === 'nogo' ? (c.dontServeReason ?? 'spoiled') : c.item}`,
        params: {
          feedback: fb,
          item: c.item,
          dont_serve_reason: c.dontServeReason,
          customer_tone_level: c.toneLevel,
          customer_variant: c.variant,
          rush: block.phase === 'pressure',
        },
      };
    }
    if (t === 'tone_choice') {
      let customer: ToneCustomer;
      if (block.block_id === 'rude_run' || block.phase === 'shift_post') {
        if (!rude) {
          rude = buildRudeRun({
            configId: config.config_id,
            formId: trial.form_id,
            length: block.trials,
            provocations: config.planned_counts.provocations ?? block.trials,
            levels: tone.levels,
            hostileMin: options.hostileLevelMin,
          });
        }
        customer = rude[within] as ToneCustomer;
      } else {
        const seq = calmToneSequence(
          block.trials,
          tone.levels,
          options.hostileLevelMin,
          createKeyedRng(`${config.config_id}|calm`, 'stall'),
        );
        const level = seq[within] as number;
        customer = {
          toneLevel: level,
          provocation: false,
          scriptId: `stall.${trial.form_id}.calm.${within}`,
          variant: rng.int(0, 7),
        };
      }
      return {
        stimulus_id: customer.scriptId,
        vocabulary: [...tone.options] as [string, ...string[]],
        voice_vocabulary: trial.voice_vocabulary.length > 0 ? [...tone.options] : [],
        expected_response: null,
        params: {
          customer_tone_level: customer.toneLevel,
          provocation: customer.provocation,
          script_id: customer.scriptId,
          customer_variant: customer.variant,
        },
      };
    }
    return {};
  };
}

export const STALL_INDICATORS: readonly IndicatorBinding[] = [
  {
    moduleId: 'stall',
    indicators: [
      'emotional_regulation.tone_after_provocation',
      'emotional_regulation.mirroring',
      'emotional_regulation.drift_slope_difficult_run',
      'emotional_regulation.recovery_after_feedback',
      'stability.shift_slope_rude_run',
      'self_control.nogo_commission_rate',
      'composure.pressure_slope_accuracy',
      'composure.pressure_slope_rt',
      'composure.error_type_shift',
      'expressive_restraint.premature_taps',
    ],
  },
];
