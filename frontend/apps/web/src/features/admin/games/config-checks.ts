/**
 * Checks for an edited game configuration before it can become a draft version:
 *
 * 1. **Schema**: the canonical `game-config.v1` JSON Schema (strict writer validator from
 *    `@shriii/contracts`; unknown properties are rejected).
 * 2. **Invariants** the restricted schema profile cannot express (budget ordering, trial counts not
 *    below their minimum, min/planned count key parity, unique block ids).
 * 3. **Change control** against the base version: identity and science fields are locked (minimum
 *    counts, indicator and construct lists, scorability come from the frozen scoring dictionary and
 *    change only through a signed PLT-09 amendment), and any change needs a higher `version`.
 *
 * Nothing here holds a scientific threshold: minimums are read from the config being checked.
 */
import { runValidator, type ValidationIssue, validateGameConfig } from '@shriii/contracts';
import {
  compareVersions,
  type DiffEntry,
  isPlainObject,
  jsonDiff,
  pointerWithin,
} from '../shared/canonical-json';

export type IssueSeverity = 'error' | 'warning';

export interface ConfigIssue {
  readonly severity: IssueSeverity;
  readonly source: 'schema' | 'invariant' | 'change-control';
  /** JSON pointer into the config ('' = whole document). */
  readonly path: string;
  readonly message: string;
}

/**
 * Fields an editor may not change. Patterns use `*` for one pointer segment.
 * Science fields mirror the scoring dictionary; identity fields tie the config to its game row.
 */
export const LOCKED_FIELDS: readonly { readonly pattern: string; readonly reason: string }[] = [
  { pattern: '/module_id', reason: 'identity: a config belongs to one game' },
  { pattern: '/kind', reason: 'identity: module kind is fixed per game' },
  { pattern: '/schema_version', reason: 'contract version is set by the contracts package' },
  { pattern: '/pathways', reason: 'science: pathway membership is fixed by the dictionary freeze' },
  {
    pattern: '/constructs',
    reason: 'science: construct mapping comes from the scoring dictionary',
  },
  { pattern: '/indicators', reason: 'science: indicator list comes from the scoring dictionary' },
  { pattern: '/scorable', reason: 'science: scorability comes from the scoring dictionary' },
  { pattern: '/min_counts', reason: 'science: minimum counts are dictionary thresholds' },
  { pattern: '/blocks/*/min_trials', reason: 'science: minimum trials are dictionary thresholds' },
  { pattern: '/blocks/*/scorable', reason: 'science: block scorability comes from the dictionary' },
  { pattern: '/requires_numeracy', reason: 'no decision may depend on reading digits (ENG-11)' },
  { pattern: '/slot', reason: 'identity: slot membership is fixed by the session plan' },
  {
    pattern: '/paradigms',
    reason: 'measurement: paradigm defines the event model indicators read',
  },
  {
    pattern: '/blocks/*/block_id',
    reason: 'measurement: block ids tag trial events used by the dictionary',
  },
  {
    pattern: '/blocks/*/phase',
    reason: 'measurement: phase tags (condition.phase) select trials for indicators',
  },
  {
    pattern: '/blocks/*/condition_id',
    reason: 'measurement: condition ids tag trial events used by the dictionary',
  },
  {
    pattern: '/blocks/*/conditions',
    reason: 'measurement: timer/noise/shift tagging defines the pressure and shift phases',
  },
  {
    pattern: '/context_shift',
    reason: 'measurement: the context shift and its window define shift_post indicators',
  },
  {
    pattern: '/constraints/premature_threshold_ms',
    reason: 'science: the anticipatory-response cut-off is a dictionary threshold',
  },
  {
    pattern: '/constraints/integrity_dice_mode',
    reason: 'privacy: private-dice mode is fixed (group-level only, PRV-01)',
  },
  {
    pattern: '/constraints/true_outcome_logged',
    reason: 'privacy: the true dice outcome is never stored',
  },
  {
    pattern: '/constraints/luck_tokens_group_only',
    reason: 'privacy: luck outcomes are analysed at group level only',
  },
  { pattern: '/constraints/voice_forbidden', reason: 'privacy: no voice capture in this game' },
  {
    pattern: '/constraints/headset_required_open_public',
    reason: 'privacy: open-public sites need a headset for this game',
  },
  {
    pattern: '/constraints/site_mode_required',
    reason: 'safeguarding: this game runs only at the stated site mode',
  },
  {
    pattern: '/constraints/separate_consent_per_player',
    reason: 'consent: each player consents separately',
  },
];

/**
 * Fields whose change is allowed in a new version but alters measurement (stimulus onset timing,
 * response windows, scheduler mix). They are reported as warnings so the reviewer records the
 * change in the amendment log; timing-sensitive indicators compare only within one version.
 */
export const MEASUREMENT_FIELDS: readonly { readonly pattern: string; readonly reason: string }[] =
  [
    {
      pattern: '/levels/*/timing',
      reason:
        'stimulus timing / response window changed: timing-sensitive indicators are not comparable across versions',
    },
    {
      pattern: '/levels/*/seconds_per_trial',
      reason: 'pacing changed: re-run the trial budget tool',
    },
    {
      pattern: '/constraints',
      reason: 'scheduler constraint changed (ENG-09): trial mix differs from the previous version',
    },
  ];

/** True when `path` lies at or under `pattern` (`*` matches one segment). */
function matchesPattern(path: string, pattern: string): boolean {
  const p = path.split('/');
  const q = pattern.split('/');
  if (p.length < q.length) return false;
  return q.every((seg, i) => seg === '*' || seg === p[i]);
}

/**
 * True when `path` is a strict ancestor of something `pattern` matches. A diff entry at an ancestor
 * (a whole block added or removed, an object replaced by another type) necessarily changes the
 * locked descendant, so it must not slip past the lock.
 */
function ancestorOfPattern(path: string, pattern: string): boolean {
  const p = path === '/' ? [''] : path.split('/');
  const q = pattern.split('/');
  if (p.length >= q.length) return false;
  return p.every((seg, i) => q[i] === '*' || q[i] === seg);
}

function findRule(
  rules: readonly { readonly pattern: string; readonly reason: string }[],
  path: string,
): { readonly pattern: string; readonly reason: string } | null {
  return (
    rules.find((f) => matchesPattern(path, f.pattern)) ??
    rules.find((f) => ancestorOfPattern(path, f.pattern)) ??
    null
  );
}

export function lockedReason(path: string): string | null {
  return findRule(LOCKED_FIELDS, path)?.reason ?? null;
}

function schemaIssues(errors: readonly ValidationIssue[]): ConfigIssue[] {
  return errors.map((e) => ({
    severity: 'error' as const,
    source: 'schema' as const,
    path: e.path,
    message: e.message,
  }));
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Semantic invariants on a config object (run even when the schema fails, where shapes allow). */
export function invariantIssues(config: unknown): ConfigIssue[] {
  const out: ConfigIssue[] = [];
  if (!isPlainObject(config)) return out;
  const push = (path: string, message: string, severity: IssueSeverity = 'error') =>
    out.push({ severity, source: 'invariant', path, message });

  const budget = config.budget;
  if (isPlainObject(budget)) {
    const target = num(budget.target_ms_l2);
    const soft = num(budget.soft_cap_ms);
    const hard = num(budget.hard_cap_ms);
    if (target !== null && soft !== null && target > soft) {
      push('/budget/target_ms_l2', 'L2 target must not exceed the soft cap.');
    }
    if (soft !== null && hard !== null && soft > hard) {
      push('/budget/soft_cap_ms', 'Soft cap must not exceed the hard cap.');
    }
  }

  const blocks = Array.isArray(config.blocks) ? config.blocks : [];
  const seen = new Set<string>();
  blocks.forEach((b, i) => {
    if (!isPlainObject(b)) return;
    const id = typeof b.block_id === 'string' ? b.block_id : null;
    if (id) {
      if (seen.has(id)) push(`/blocks/${i}/block_id`, `Duplicate block id "${id}".`);
      seen.add(id);
    }
    const trials = num(b.trials);
    const min = num(b.min_trials);
    if (trials !== null && min !== null && trials < min) {
      push(
        `/blocks/${i}/trials`,
        `Block "${id ?? i}" schedules ${trials} trials, below its minimum of ${min}.`,
      );
    }
    if (b.scorable === true && trials !== null && trials === 0) {
      push(`/blocks/${i}/trials`, 'A scorable block needs at least one trial.');
    }
  });

  const minCounts = isPlainObject(config.min_counts) ? config.min_counts : {};
  const planned = isPlainObject(config.planned_counts) ? config.planned_counts : {};
  for (const key of Object.keys(minCounts)) {
    if (!(key in planned)) {
      push(`/planned_counts`, `planned_counts is missing "${key}" (required by min_counts).`);
      continue;
    }
    const m = num(minCounts[key]);
    const p = num(planned[key]);
    if (m !== null && p !== null && p < m) {
      push(`/planned_counts/${key}`, `Planned "${key}" (${p}) is below the minimum (${m}).`);
    }
  }
  for (const key of Object.keys(planned)) {
    if (!(key in minCounts)) {
      push(`/planned_counts/${key}`, `"${key}" has no matching min_counts entry.`, 'warning');
    }
  }

  const constraints = isPlainObject(config.constraints) ? config.constraints : {};
  if (constraints.true_outcome_logged === true) {
    push(
      '/constraints/true_outcome_logged',
      'The true private-dice outcome must never be logged (group-level analysis only).',
    );
  }

  const levels = isPlainObject(config.levels) ? config.levels : {};
  const hard = isPlainObject(budget) ? num(budget.hard_cap_ms) : null;
  for (const [level, cfg] of Object.entries(levels)) {
    if (!isPlainObject(cfg) || !isPlainObject(cfg.estimated_duration_ms) || hard === null) continue;
    const slow = num(cfg.estimated_duration_ms.slow_trimmed) ?? num(cfg.estimated_duration_ms.slow);
    if (slow !== null && slow > hard) {
      push(
        `/levels/${level}/estimated_duration_ms`,
        `${level} slow-player estimate (${slow} ms) exceeds the hard cap (${hard} ms); re-run the trial budget tool.`,
        'warning',
      );
    }
  }
  return out;
}

/** Locked-field and version-bump checks of `edited` against `base`. */
export function changeControlIssues(
  base: unknown,
  edited: unknown,
  diff?: readonly DiffEntry[],
): ConfigIssue[] {
  const out: ConfigIssue[] = [];
  const changes = diff ?? jsonDiff(base, edited);
  const reported = new Set<string>();
  for (const c of changes) {
    const locked = findRule(LOCKED_FIELDS, c.path);
    if (locked) {
      const label = locked.pattern.includes('*') ? c.path : locked.pattern;
      if (reported.has(label)) continue;
      reported.add(label);
      out.push({
        severity: 'error',
        source: 'change-control',
        path: c.path,
        message: `Locked field changed (${locked.reason}).`,
      });
      continue;
    }
    const measured = findRule(MEASUREMENT_FIELDS, c.path);
    if (measured) {
      const level = c.path.split('/')[2] ?? '';
      const label = measured.pattern.replaceAll('*', level);
      if (reported.has(label)) continue;
      reported.add(label);
      out.push({
        severity: 'warning',
        source: 'change-control',
        path: c.path,
        message: `Measurement change: ${measured.reason}. Record it in the amendment log.`,
      });
    }
  }
  const contentChanged = changes.some((c) => !pointerWithin(c.path, '/version'));
  if (contentChanged && isPlainObject(base) && isPlainObject(edited)) {
    const bv = typeof base.version === 'string' ? base.version : null;
    const ev = typeof edited.version === 'string' ? edited.version : null;
    if (bv && ev && compareVersions(ev, bv) <= 0) {
      out.push({
        severity: 'error',
        source: 'change-control',
        path: '/version',
        message: `A changed config needs a higher version than ${bv} (versions are immutable once synced).`,
      });
    }
  }
  return out;
}

export interface ConfigCheckResult {
  readonly valid: boolean;
  readonly issues: readonly ConfigIssue[];
  readonly diff: readonly DiffEntry[];
}

/** Run every check. `base` is the version being edited (null for a standalone validation). */
export function checkGameConfig(edited: unknown, base: unknown | null): ConfigCheckResult {
  const result = runValidator(validateGameConfig, edited);
  const issues: ConfigIssue[] = [
    ...(result.ok ? [] : schemaIssues(result.errors)),
    ...invariantIssues(edited),
  ];
  const diff = base === null ? [] : jsonDiff(base, edited);
  if (base !== null) issues.push(...changeControlIssues(base, edited, diff));
  return { valid: !issues.some((i) => i.severity === 'error'), issues, diff };
}
