/**
 * Warm-up calibration and level policy (ENG-10, ONB-05).
 *
 * The level is decided once per session from (in precedence order): retest lock (T1 level), forced
 * level (counterbalanced subsample), a11y slow-pace choice (L1, flagged), practice struggle (L1,
 * flagged), then the policy: `fixed_L2_with_L1_fallback` (pilot default) or `classifier` (rules from
 * `content/games/shared/calibration.json`). All cut-offs live in that file or in the warm-up config,
 * never in code. The rules file is validated at load (fail closed on a malformed file).
 *
 * Warm-up metrics are derived from the logged warm-up events themselves (`response`, `input.hold`),
 * so the warm-up module needs no side channel and the calibration is reproducible from raw events.
 */
import type {
  CalibrationLevel,
  CalibrationPolicy,
  EventEnvelope,
  GameConfig,
  PracticeSummaryPayload,
} from '@shriii/contracts';
import rulesJson from '../../../../../content/games/shared/calibration.json' with { type: 'json' };
import type { CalibrationDecision } from '../core/contracts.ts';

type Skill = 'tap' | 'hold' | 'choice' | 'drag';

/** Classifier rule condition (all present conditions must hold). */
export interface CalibrationCondition {
  readonly warmup_rt_ms_lt?: number;
  readonly warmup_rt_ms_gte?: number;
  readonly warmup_accuracy_lt?: number;
  readonly warmup_accuracy_gte?: number;
}

/** Shape of `content/games/shared/calibration.json`. */
export interface CalibrationRules {
  readonly version: string;
  readonly default_policy: CalibrationPolicy;
  readonly fixed_level: CalibrationLevel;
  readonly fallback_level: CalibrationLevel;
  readonly slow_pace_level: CalibrationLevel;
  readonly warmup: {
    readonly skill_blocks: Readonly<Record<string, string>>;
    readonly rt_blocks: readonly string[];
  };
  readonly classifier: {
    readonly rules: readonly {
      readonly level: CalibrationLevel;
      readonly when: CalibrationCondition;
    }[];
    readonly otherwise: CalibrationLevel;
  };
}

const LEVELS: ReadonlySet<string> = new Set(['L1', 'L2', 'L3']);
const POLICIES: ReadonlySet<string> = new Set([
  'fixed_L2_with_L1_fallback',
  'classifier',
  'forced',
  'retest_locked',
]);
const CONDITION_KEYS: ReadonlySet<string> = new Set([
  'warmup_rt_ms_lt',
  'warmup_rt_ms_gte',
  'warmup_accuracy_lt',
  'warmup_accuracy_gte',
]);

/**
 * Validate a raw calibration rules document (`content/games/shared/calibration.json`).
 * @throws TypeError naming the first invalid path.
 */
export function parseCalibrationRules(raw: unknown): CalibrationRules {
  const fail = (path: string, msg: string): never => {
    throw new TypeError(`calibration.json${path}: ${msg}`);
  };
  if (raw === null || typeof raw !== 'object') return fail('', 'must be an object');
  const r = raw as Record<string, unknown>;
  if (typeof r.version !== 'string') fail('/version', 'must be a string');
  if (typeof r.default_policy !== 'string' || !POLICIES.has(r.default_policy))
    fail('/default_policy', 'unknown policy');
  for (const k of ['fixed_level', 'fallback_level', 'slow_pace_level'] as const) {
    if (typeof r[k] !== 'string' || !LEVELS.has(r[k] as string)) fail(`/${k}`, 'must be L1|L2|L3');
  }
  const w = r.warmup as Record<string, unknown> | undefined;
  if (!w || typeof w !== 'object') return fail('/warmup', 'must be an object');
  const sb = w.skill_blocks;
  if (!sb || typeof sb !== 'object' || Object.values(sb).some((v) => typeof v !== 'string'))
    fail('/warmup/skill_blocks', 'must map skills to block ids');
  if (!Array.isArray(w.rt_blocks) || w.rt_blocks.some((v) => typeof v !== 'string'))
    fail('/warmup/rt_blocks', 'must be a list of block ids');
  const c = r.classifier as Record<string, unknown> | undefined;
  if (!c || typeof c !== 'object') return fail('/classifier', 'must be an object');
  if (!Array.isArray(c.rules)) return fail('/classifier/rules', 'must be a list');
  c.rules.forEach((rule: unknown, i: number) => {
    const rr = rule as { level?: unknown; when?: unknown } | null;
    if (!rr || typeof rr.level !== 'string' || !LEVELS.has(rr.level))
      fail(`/classifier/rules/${i}/level`, 'must be L1|L2|L3');
    const when = rr?.when;
    if (!when || typeof when !== 'object' || Object.keys(when).length === 0)
      fail(`/classifier/rules/${i}/when`, 'must hold at least one condition');
    for (const [k, v] of Object.entries(when as Record<string, unknown>)) {
      if (!CONDITION_KEYS.has(k)) fail(`/classifier/rules/${i}/when/${k}`, 'unknown condition');
      if (typeof v !== 'number' || !Number.isFinite(v))
        fail(`/classifier/rules/${i}/when/${k}`, 'must be a finite number');
    }
  });
  if (typeof c.otherwise !== 'string' || !LEVELS.has(c.otherwise))
    fail('/classifier/otherwise', 'must be L1|L2|L3');
  return raw as CalibrationRules;
}

/** The bundled rules from `content/games/shared/calibration.json` (validated at load). */
export const CALIBRATION_RULES: CalibrationRules = parseCalibrationRules(rulesJson);

/** Inputs for a calibration decision. */
export interface CalibrationInputs {
  readonly policy: CalibrationPolicy;
  readonly practiceStruggle: boolean;
  readonly slowPace: boolean;
  readonly warmupRtMs: number | null;
  readonly warmupAccuracy: number | null;
  /** `forced` policy: the assigned level. */
  readonly forcedLevel?: CalibrationLevel | null;
  /** `retest_locked` policy: the T1 level (linked by token or pid). */
  readonly retestLevel?: CalibrationLevel | null;
}

function matches(when: CalibrationCondition, rt: number | null, acc: number | null): boolean {
  if (when.warmup_rt_ms_lt !== undefined && !(rt !== null && rt < when.warmup_rt_ms_lt))
    return false;
  if (when.warmup_rt_ms_gte !== undefined && !(rt !== null && rt >= when.warmup_rt_ms_gte))
    return false;
  if (when.warmup_accuracy_lt !== undefined && !(acc !== null && acc < when.warmup_accuracy_lt)) {
    return false;
  }
  if (
    when.warmup_accuracy_gte !== undefined &&
    !(acc !== null && acc >= when.warmup_accuracy_gte)
  ) {
    return false;
  }
  return true;
}

/** Pure level decision. */
export function decideCalibration(
  inputs: CalibrationInputs,
  rules: CalibrationRules = CALIBRATION_RULES,
): CalibrationDecision {
  const { policy } = inputs;
  if (policy === 'retest_locked') {
    if (!inputs.retestLevel) throw new Error('retest_locked policy requires the T1 level');
    return { level: inputs.retestLevel, policy, reason: 'retest_lock' };
  }
  if (policy === 'forced') {
    if (!inputs.forcedLevel) throw new Error('forced policy requires a forced level');
    return { level: inputs.forcedLevel, policy, reason: 'forced' };
  }
  if (inputs.slowPace) return { level: rules.slow_pace_level, policy, reason: 'a11y_choice' };
  if (inputs.practiceStruggle) {
    return { level: rules.fallback_level, policy, reason: 'practice_struggle' };
  }
  if (policy === 'classifier') {
    for (const rule of rules.classifier.rules) {
      if (matches(rule.when, inputs.warmupRtMs, inputs.warmupAccuracy)) {
        return { level: rule.level, policy, reason: 'classifier' };
      }
    }
    return { level: rules.classifier.otherwise, policy, reason: 'classifier' };
  }
  return { level: rules.fixed_level, policy, reason: 'default' };
}

/** Warm-up metrics computed from warm-up events. */
export interface WarmupMetrics {
  readonly summary: PracticeSummaryPayload;
  readonly warmupRtMs: number | null;
  readonly warmupAccuracy: number | null;
}

/**
 * Derive practice/warm-up metrics from logged events of the warm-up module. A skill passes when it
 * reaches `passes_per_skill` correct trials; hitting `max_attempts_per_skill` without that sets
 * `practice_struggle` (ONB-05). Both numbers come from the warm-up config.
 */
export function warmupMetricsFromEvents(
  events: readonly EventEnvelope[],
  warmupConfig: GameConfig,
  rules: CalibrationRules = CALIBRATION_RULES,
): WarmupMetrics {
  const passesNeeded = warmupConfig.min_counts.passes_per_skill ?? 2;
  const maxAttempts = warmupConfig.min_counts.max_attempts_per_skill ?? 4;
  const blockToSkill = new Map<string, Skill>();
  for (const [skill, block] of Object.entries(rules.warmup.skill_blocks)) {
    if (skill === 'tap' || skill === 'hold' || skill === 'choice' || skill === 'drag') {
      blockToSkill.set(block, skill);
    }
  }
  const tally = new Map<Skill, { attempts: number; passes: number }>();
  const rts: number[] = [];
  let correct = 0;
  let judged = 0;
  let holdOk = 0;
  let holdAll = 0;
  for (const e of events) {
    const block = e.task?.block_id ?? null;
    if (e.task?.module_id !== warmupConfig.module_id || block === null) continue;
    const skill = blockToSkill.get(block);
    if (e.event_type === 'response') {
      const p = e.payload;
      if (skill && skill !== 'hold') {
        const t = tally.get(skill) ?? { attempts: 0, passes: 0 };
        t.attempts += 1;
        // Choice practice has no right answer: any committed choice passes unless marked incorrect.
        if (p.correctness === true || (p.correctness === null && p.response_value !== null))
          t.passes += 1;
        tally.set(skill, t);
      }
      if (p.correctness !== null) {
        judged += 1;
        if (p.correctness) correct += 1;
      }
      if (
        rules.warmup.rt_blocks.includes(block) &&
        p.latency_ms !== null &&
        p.latency_ms >= 0 &&
        p.correctness !== false
      ) {
        rts.push(p.latency_ms);
      }
    } else if (e.event_type === 'input.hold' && skill === 'hold') {
      const t = tally.get('hold') ?? { attempts: 0, passes: 0 };
      t.attempts += 1;
      holdAll += 1;
      if (e.payload.completed) {
        t.passes += 1;
        holdOk += 1;
      }
      tally.set('hold', t);
    }
  }
  const skills: PracticeSummaryPayload['skills'][number][] = [];
  let struggle = false;
  for (const skill of ['tap', 'hold', 'choice'] as const) {
    const t = tally.get(skill) ?? { attempts: 0, passes: 0 };
    const completed = t.passes >= passesNeeded;
    if (!completed && t.attempts >= maxAttempts) struggle = true;
    skills.push({ skill, attempts: t.attempts, passes: Math.min(t.passes, t.attempts), completed });
  }
  rts.sort((a, b) => a - b);
  const mid = Math.floor(rts.length / 2);
  const median =
    rts.length === 0
      ? null
      : rts.length % 2 === 1
        ? (rts[mid] ?? null)
        : ((rts[mid - 1] ?? 0) + (rts[mid] ?? 0)) / 2;
  const meanRt = rts.length > 0 ? rts.reduce((a, b) => a + b, 0) / rts.length : null;
  const summary: PracticeSummaryPayload = {
    skills: skills as PracticeSummaryPayload['skills'],
    practice_struggle: struggle,
    mean_tap_rt_ms: meanRt === null ? null : Math.round(meanRt * 10) / 10,
    hold_accuracy: holdAll > 0 ? holdOk / holdAll : null,
  };
  return {
    summary,
    warmupRtMs: median,
    warmupAccuracy: judged > 0 ? correct / judged : null,
  };
}

/** Holds the single locked level of a session (ENG-10 AC: exactly one level per session). */
export class CalibrationLock {
  private decision: CalibrationDecision | null = null;

  get current(): CalibrationDecision | null {
    return this.decision;
  }

  /** Lock the level; a second lock with a different level throws. */
  lock(decision: CalibrationDecision): CalibrationDecision {
    if (this.decision && this.decision.level !== decision.level) {
      throw new Error(`calibration already locked at ${this.decision.level}`);
    }
    this.decision ??= decision;
    return this.decision;
  }

  /** Dev/admin override (forced-level subsample or devtools); replaces the lock with reason `forced`. */
  force(level: CalibrationLevel): CalibrationDecision {
    this.decision = { level, policy: 'forced', reason: 'forced' };
    return this.decision;
  }

  reset(): void {
    this.decision = null;
  }
}
