/**
 * Engine-level defaults that map config beats onto trial specs: which beats are trial types and which
 * are modifiers, closed response vocabularies, latency anchors and response-window keys.
 *
 * These are naming and protocol conventions, not scientific thresholds: every number (shares, counts,
 * windows, durations) still comes from the module config in `content/games/**`. A module can override
 * any default per trial through a scheduler {@link TrialOverrideGenerator}.
 */
import type { BlockConfig, GameConfig, LatencyAnchor } from '@shriii/contracts';

/** Beats that decorate a trial (context, phase of a trial, or option) rather than define its type. */
export const MODIFIER_BEATS: ReadonlySet<string> = new Set([
  'timer',
  'crowd_noise',
  'provocation',
  'feedback_recovery',
  'dont_serve',
  'inspect_more',
  'new_rule',
  'errand',
  'optional_action',
  'replan',
  'unannounced_switch',
  'reversal',
  'hold',
  'partner_error',
  'cupped_hand_reveal',
  'picture_report',
]);

/** Beat that marks the cross-module probe block (style-trait comparable segments). */
export const PROBE_BEAT = 'probe_segment';

/** Binary trial types whose complement fills the rest of the block (share-based allocation). */
export const COMPLEMENT_TYPES: Readonly<Record<string, string>> = {
  nogo: 'go',
  distractor: 'target',
  repeat_probe: 'choice',
};

/** Trial types that are private reports (touch only, never voiced, headset rules apply). */
export const PRIVATE_REPORT_TYPES: ReadonlySet<string> = new Set(['private_report', 'luck_token']);

/** Trial types whose choices are on the never-voice list (KSK-05) even if not private reports. */
export const VOICE_FORBIDDEN_TYPES: ReadonlySet<string> = new Set(['bribe']);

/** Types answered by a spoken-prompt choice (latency anchored on audio end, voice allowed). */
const SPOKEN_CHOICE_TYPES: ReadonlySet<string> = new Set([
  'tone_choice',
  'weigh',
  'bribe',
  'overpayment',
  'assistant_mistake',
  'fraud_found',
  'gamble_inspection',
  'sun_moon_delay',
  'credit_allocation',
]);

function range(prefix: string, from: number, to: number): string[] {
  const out: string[] = [];
  for (let i = from; i <= to; i += 1) out.push(`${prefix}${i}`);
  return out;
}

function numberConstraint(config: GameConfig, key: string): number | null {
  const v = config.constraints[key];
  return typeof v === 'number' ? v : null;
}

function stringListConstraint(config: GameConfig, key: string): string[] | null {
  const v = config.constraints[key];
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
}

/** Closed response vocabulary and expected response for a trial type. */
export function defaultVocabulary(
  config: GameConfig,
  block: BlockConfig,
  trialType: string,
): { readonly vocabulary: [string, ...string[]]; readonly expected: string | null } {
  switch (trialType) {
    case 'go':
    case 'target':
      return { vocabulary: ['tap', 'no_tap'], expected: 'tap' };
    case 'nogo':
    case 'distractor':
      return { vocabulary: ['tap', 'no_tap'], expected: 'no_tap' };
    case 'probe_segment':
      return { vocabulary: ['tap', 'no_tap'], expected: 'tap' };
    case 'tone_choice': {
      const opts = stringListConstraint(config, 'tone_options') ?? ['warm', 'neutral', 'firm'];
      return { vocabulary: opts as [string, ...string[]], expected: null };
    }
    case 'low_risk':
    case 'high_risk':
      return { vocabulary: ['pump', 'collect'], expected: null };
    case 'solvable':
    case 'unsolvable':
      return { vocabulary: ['move', 'skip'], expected: null };
    case 'cooperative':
    case 'free_rider':
    case 'error_round': {
      const max = numberConstraint(config, 'endowment_tokens') ?? 10;
      return { vocabulary: range('tokens_', 0, max) as [string, ...string[]], expected: null };
    }
    case 'choice':
      if (config.kind === 'warmup') return { vocabulary: ['option_a', 'option_b'], expected: null };
      return {
        vocabulary: range('stall_', 1, numberConstraint(config, 'stalls') ?? 4) as [
          string,
          ...string[],
        ],
        expected: null,
      };
    case 'repeat_probe': {
      const stalls = numberConstraint(config, 'stalls') ?? 4;
      return { vocabulary: range('stall_', 1, stalls) as [string, ...string[]], expected: null };
    }
    case 'private_report':
      return { vocabulary: range('face_', 1, 6) as [string, ...string[]], expected: null };
    case 'luck_token':
      return { vocabulary: ['found', 'not_found'], expected: null };
    case 'sun_moon_delay':
      return { vocabulary: ['now', 'wait'], expected: null };
    case 'hold_to_earn':
    case 'hold_to_push':
      return { vocabulary: ['hold', 'skip'], expected: null };
    case 'weigh':
      return { vocabulary: ['accept', 'reject', 'inspect_more'], expected: null };
    case 'bribe':
    case 'overpayment':
    case 'assistant_mistake':
    case 'fraud_found':
      return { vocabulary: ['accept', 'refuse', 'report'], expected: null };
    case 'gamble_inspection':
      return { vocabulary: ['inspect', 'skip'], expected: null };
    case 'route_step':
    case 'rule_reversed':
      return { vocabulary: ['step', 'wait'], expected: null };
    case 'blocked_route':
      return { vocabulary: ['replan', 'wait'], expected: null };
    case 'contribution': {
      const max = numberConstraint(config, 'endowment_tokens') ?? 10;
      return { vocabulary: range('tokens_', 0, max) as [string, ...string[]], expected: null };
    }
    case 'turn_taking':
      return { vocabulary: ['act', 'wait'], expected: null };
    case 'credit_allocation':
      return { vocabulary: ['self', 'partner', 'shared', 'chance'], expected: null };
    case 'look_away':
      return { vocabulary: ['ready'], expected: 'ready' };
    case 'tap':
    case 'rt_probe':
    case 'practice':
      return { vocabulary: ['tap'], expected: 'tap' };
    case 'hold':
      return { vocabulary: ['hold'], expected: 'hold' };
    default:
      if (config.paradigms.includes('card_sort') || /^rule_\d/.test(trialType)) {
        return { vocabulary: ['pile_1', 'pile_2', 'pile_3', 'pile_4'], expected: null };
      }
      if (block.condition_id === 'choice') {
        return { vocabulary: ['option_a', 'option_b'], expected: null };
      }
      return { vocabulary: ['tap'], expected: 'tap' };
  }
}

/** Default latency anchor for a trial type (ENG-01: spoken prompts anchor on audio end). */
export function defaultTrialLatencyAnchor(trialType: string): LatencyAnchor {
  return SPOKEN_CHOICE_TYPES.has(trialType) ? 'audio_end' : 'visual_onset';
}

/** True when a type's closed vocabulary may also be answered by voice (VOX-04; touch always works). */
export function voiceAllowed(trialType: string, privateReport: boolean): boolean {
  if (privateReport || VOICE_FORBIDDEN_TYPES.has(trialType)) return false;
  return SPOKEN_CHOICE_TYPES.has(trialType);
}

/**
 * Response-window key overrides where the generic resolution is ambiguous, keyed by
 * `<module_id>:<block_id>`. Values are keys into `levels.Lx.timing`, never numbers.
 */
export const WINDOW_KEY_OVERRIDES: Readonly<Record<string, string>> = {
  'stall:practice': 'serve_window_ms',
  'stall:service': 'serve_window_ms',
  'stall:timed_rush': 'rush_serve_window_ms',
  'stall:tone_calm': 'tone_window_ms',
  'stall:rude_run': 'tone_window_ms',
  'weighing_post:dilemmas': 'dilemma_window_ms',
};

/** Generic window keys tried in order after the type/block specific ones. */
const GENERIC_WINDOW_KEYS: readonly string[] = [
  'response_window_ms',
  'decision_window_ms',
  'choice_window_ms',
  'step_window_ms',
  'report_window_ms',
  'turn_window_ms',
  'tap_window_ms',
];

function singular(word: string): string {
  return word.endsWith('s') ? word.slice(0, -1) : word;
}

/** Resolve the timing-table key holding a trial's response window (null for untimed trials). */
export function resolveWindowKey(
  config: GameConfig,
  block: BlockConfig,
  trialType: string,
  timing: Readonly<Record<string, number | undefined>>,
): string | null {
  const override = WINDOW_KEY_OVERRIDES[`${config.module_id}:${block.block_id}`];
  if (override && timing[override] !== undefined) return override;
  const firstToken = trialType.split('_')[0] ?? trialType;
  const candidates = [
    `${trialType}_window_ms`,
    `${firstToken}_window_ms`,
    `${block.condition_id}_window_ms`,
    `${singular(block.block_id)}_window_ms`,
    `${block.block_id}_window_ms`,
    ...(block.phase === 'pressure' ? ['pressure_window_ms', 'rush_window_ms'] : []),
    ...GENERIC_WINDOW_KEYS,
  ];
  for (const key of candidates) if (timing[key] !== undefined) return key;
  const windowKeys = Object.keys(timing).filter((k) => k.endsWith('_window_ms'));
  return windowKeys.length === 1 ? (windowKeys[0] ?? null) : null;
}
