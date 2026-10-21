/**
 * Shared helpers for the paradigm logic core (pure TypeScript, no rendering, no DOM, no Pixi).
 *
 * Every paradigm in this directory is used by BOTH Pathway B micro-games and Pathway A episodes
 * (ENG-05 AC: "paradigm logic packages are shared between B and A"). Rules for this directory:
 *
 * - Randomness only through {@link SeededRng} (ENG-03). The single deliberate exception is the
 *   private-report true outcome (see `private-report.ts`), which must NOT be reproducible from the
 *   logged session seed.
 * - No scientific thresholds in code: thresholds (premature cut-off, reacquisition run, ...) are
 *   arguments read by the caller from YAML (`scoring/**`) or from the module config. Stimulus-design
 *   values that the content configs do not (yet) carry are resolved through {@link Resolved} so the
 *   value's source is logged alongside it (see `content-defaults.ts`).
 * - Nothing here produces a player-visible number (ENG-11): quantities are pictured tokens, needles
 *   and piles; the numeric fields exist only for logging and research scoring.
 */
import type { CalibrationLevel, GameConfig } from '@shriii/contracts';
import type { IndicatorId, ModuleId, SeededRng } from '../core/contracts.ts';

/** Thrown when a config (or caller-supplied option) makes a paradigm impossible to run. Fail closed. */
export class ParadigmConfigError extends Error {
  readonly paradigm: string;
  constructor(paradigm: string, message: string) {
    super(`[${paradigm}] ${message}`);
    this.name = 'ParadigmConfigError';
    this.paradigm = paradigm;
  }
}

/** Thrown when a runtime method is called in the wrong state (e.g. pumping a burst balloon). */
export class ParadigmStateError extends Error {
  readonly paradigm: string;
  constructor(paradigm: string, message: string) {
    super(`[${paradigm}] ${message}`);
    this.name = 'ParadigmStateError';
    this.paradigm = paradigm;
  }
}

/** Where a resolved stimulus-design value came from (logged with the value). */
export type ValueSource = 'level_timing' | 'constraints' | 'argument' | 'paradigm_default';

/** A value plus its provenance, so a defaulted value can never silently pass as configured. */
export interface Resolved<T> {
  readonly value: T;
  readonly source: ValueSource;
  /** Config key (or default id) the value was read from. */
  readonly key: string;
}

/** Documents which scoring-dictionary indicators consume a paradigm's events/params in one module. */
export interface IndicatorBinding {
  readonly moduleId: ModuleId;
  /** Indicator ids exactly as in `scoring/dictionary/dictionary.{A,B}.yaml`. */
  readonly indicators: readonly IndicatorId[];
}

/* ------------------------------------------------------------------------------------------------
 * Config readers (never invent a number: absent -> null, the caller decides)
 * ---------------------------------------------------------------------------------------------- */

function constraintsOf(config: GameConfig): Readonly<Record<string, unknown>> {
  return config.constraints as Readonly<Record<string, unknown>>;
}

/** A finite number from `config.constraints[key]`, or null. */
export function constraintNumber(config: GameConfig, key: string): number | null {
  const v = constraintsOf(config)[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** A boolean from `config.constraints[key]`, or null. */
export function constraintBoolean(config: GameConfig, key: string): boolean | null {
  const v = constraintsOf(config)[key];
  return typeof v === 'boolean' ? v : null;
}

/** A string from `config.constraints[key]`, or null. */
export function constraintString(config: GameConfig, key: string): string | null {
  const v = constraintsOf(config)[key];
  return typeof v === 'string' ? v : null;
}

/** A `[lo, hi]` pair from `config.constraints[key]`, or null. */
export function constraintWindow(
  config: GameConfig,
  key: string,
): readonly [number, number] | null {
  const v = constraintsOf(config)[key];
  if (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number')) {
    return [v[0] as number, v[1] as number];
  }
  return null;
}

/** A string list from `config.constraints[key]`, or null. */
export function constraintStrings(config: GameConfig, key: string): readonly string[] | null {
  const v = constraintsOf(config)[key];
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
}

/** A number list from `config.constraints[key]`, or null. */
export function constraintNumbers(config: GameConfig, key: string): readonly number[] | null {
  const v = constraintsOf(config)[key];
  return Array.isArray(v) && v.every((x) => typeof x === 'number' && Number.isFinite(x))
    ? (v as number[])
    : null;
}

/** A level-table timing value (`levels[level].timing[key]`), or null. */
export function timingNumber(
  config: GameConfig,
  level: CalibrationLevel,
  key: string,
): number | null {
  const v = config.levels[level].timing[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** A level-table timing value that must exist (throws {@link ParadigmConfigError}). */
export function requireTiming(
  paradigm: string,
  config: GameConfig,
  level: CalibrationLevel,
  key: string,
): number {
  const v = timingNumber(config, level, key);
  if (v === null) {
    throw new ParadigmConfigError(
      paradigm,
      `${config.module_id}: levels.${level}.timing.${key} is missing`,
    );
  }
  return v;
}

/**
 * Resolve a value from the first source that has it: level timing keys, then constraint keys, then a
 * documented paradigm default (content default, never a scientific threshold).
 */
export function resolveNumber(
  config: GameConfig,
  level: CalibrationLevel,
  sources: {
    readonly timing?: readonly string[];
    readonly constraints?: readonly string[];
    readonly fallback?: { readonly key: string; readonly value: number };
  },
): Resolved<number> | null {
  for (const key of sources.timing ?? []) {
    const v = timingNumber(config, level, key);
    if (v !== null) return { value: v, source: 'level_timing', key };
  }
  for (const key of sources.constraints ?? []) {
    const v = constraintNumber(config, key);
    if (v !== null) return { value: v, source: 'constraints', key };
  }
  if (sources.fallback) {
    return { value: sources.fallback.value, source: 'paradigm_default', key: sources.fallback.key };
  }
  return null;
}

/* ------------------------------------------------------------------------------------------------
 * Small numeric helpers shared by several paradigms
 * ---------------------------------------------------------------------------------------------- */

/**
 * ISI jitter drawn as `rng.int(0, amplitude)` and added to the base ISI (the engine scheduler's
 * convention for `GameTrialSpec.timing.jitter_ms`). Amplitude 0 gives no jitter.
 */
export function drawJitter(amplitudeMs: number, rng: SeededRng): number {
  if (!Number.isFinite(amplitudeMs) || amplitudeMs < 0) {
    throw new RangeError(`jitter amplitude must be a non-negative number, got ${amplitudeMs}`);
  }
  const amp = Math.floor(amplitudeMs);
  return amp === 0 ? 0 : rng.int(0, amp);
}

/**
 * 1-based position of the trial completing the first run of `run` consecutive correct responses;
 * `{ position: n + 1, reached: false }` when never reached. Identical to the Python scorer's
 * `flexibility.trials_to_criterion` (parity).
 */
export function trialsToCriterion(
  correct: readonly boolean[],
  run: number,
): { readonly position: number; readonly reached: boolean } {
  if (!Number.isInteger(run) || run < 1)
    throw new RangeError(`run must be a positive integer, got ${run}`);
  let streak = 0;
  for (let i = 0; i < correct.length; i += 1) {
    streak = correct[i] ? streak + 1 : 0;
    if (streak >= run) return { position: i + 1, reached: true };
  }
  return { position: correct.length + 1, reached: false };
}

/** Levenshtein edit distance between two sequences (unit costs). */
export function levenshtein<T>(a: readonly T[], b: readonly T[]): number {
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = cur;
  }
  return prev[n] ?? 0;
}

/**
 * Place `k` marked items among `n` slots so that no run of marked items exceeds `maxRun`, uniformly
 * over the gaps between unmarked items. Returns null when infeasible.
 */
export function placeWithRunLimit(
  n: number,
  k: number,
  maxRun: number,
  rng: SeededRng,
): boolean[] | null {
  if (k < 0 || k > n || maxRun < 0) return null;
  if (k === 0) return new Array<boolean>(n).fill(false);
  if (maxRun === 0) return null;
  const gaps = n - k + 1;
  if (k > maxRun * gaps) return null;
  const fill = new Array<number>(gaps).fill(0);
  for (let placed = 0; placed < k; placed += 1) {
    const open: number[] = [];
    for (let g = 0; g < gaps; g += 1) if ((fill[g] ?? 0) < maxRun) open.push(g);
    const g = rng.pick(open);
    fill[g] = (fill[g] ?? 0) + 1;
  }
  const out: boolean[] = [];
  for (let g = 0; g < gaps; g += 1) {
    for (let j = 0; j < (fill[g] ?? 0); j += 1) out.push(true);
    if (g < gaps - 1) out.push(false);
  }
  return out;
}

/** Longest run of consecutive `true` values. */
export function longestRun(flags: readonly boolean[]): number {
  let best = 0;
  let cur = 0;
  for (const f of flags) {
    cur = f ? cur + 1 : 0;
    if (cur > best) best = cur;
  }
  return best;
}

/** Exhaustiveness guard for discriminated unions. */
export function assertNever(value: never, what = 'value'): never {
  throw new Error(`unexpected ${what}: ${JSON.stringify(value)}`);
}
