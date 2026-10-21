/**
 * Constraint-based, data-driven trial scheduler (ENG-09, ENG-14).
 *
 * Everything numeric comes from the module config (`content/games/**`): block lengths and minimums,
 * shares (`<type>_share`), per-block and module counts (`planned_counts`, `min_counts`), run limits
 * (`max_consecutive_<type>`), placement windows (`<type>_window`, `switch_window`, `context_shift`),
 * anchor counts (`anchor_trials`) and all timings (level table). The schedule is a pure function of
 * (config, level, session seed stream, form): the same inputs always give the same trials.
 *
 * Level independence: block lengths, trial types and their order never depend on the calibration
 * level; only the level timing table does. Anchor trials (`anchor_trials` positions plus the probe
 * block) use the anchor level's timing, so they are identical across levels apart from the
 * `calibration_level` stamp.
 */
import type { BlockConfig, CalibrationLevel, GameConfig, GameTrialSpec } from '@shriii/contracts';
import type { SeededRng, TrialScheduler } from '../core/contracts.ts';
import { createKeyedRng } from './rng.ts';
import {
  COMPLEMENT_TYPES,
  defaultTrialLatencyAnchor,
  defaultVocabulary,
  MODIFIER_BEATS,
  PRIVATE_REPORT_TYPES,
  PROBE_BEAT,
  resolveWindowKey,
  voiceAllowed,
} from './trial-defaults.ts';

/** Per-trial overrides a module may supply (e.g. stimulus ids, explosion points, tone levels). */
export interface TrialOverrides {
  readonly stimulus_id?: string | null;
  readonly expected_response?: string | null;
  readonly vocabulary?: readonly [string, ...string[]];
  readonly voice_vocabulary?: readonly string[];
  readonly audio_keys?: readonly string[];
  readonly response_window_ms?: number | null;
  readonly params?: Readonly<Record<string, unknown>>;
}

/** Generates module-specific trial content from a dedicated, level-independent substream. */
export type TrialOverrideGenerator = (input: {
  readonly trial: Readonly<GameTrialSpec>;
  readonly block: BlockConfig;
  readonly config: GameConfig;
  readonly rng: SeededRng;
}) => TrialOverrides;

/** Thrown when a schedule cannot satisfy its config (fail closed: the module will not run). */
export class ScheduleConstraintError extends Error {
  readonly moduleId: string;
  readonly violations: readonly string[];
  constructor(moduleId: string, violations: readonly string[]) {
    super(`schedule for ${moduleId} violates constraints:\n  ${violations.join('\n  ')}`);
    this.name = 'ScheduleConstraintError';
    this.moduleId = moduleId;
    this.violations = violations;
  }
}

/** Full scheduler output including metadata for logging (`context_shift.shift_index`) and checks. */
export interface ScheduleResult {
  readonly moduleId: string;
  readonly level: CalibrationLevel;
  readonly formId: string;
  readonly trials: readonly GameTrialSpec[];
  readonly blockOrder: readonly string[];
  readonly blockLengths: Readonly<Record<string, number>>;
  readonly contextShiftIndex: number | null;
  readonly contextShiftKind: string | null;
  /** Resolved `min_counts` keys with their scheduled counts. */
  readonly counts: Readonly<Record<string, number>>;
  /** `min_counts` keys that depend on runtime behaviour (e.g. `non_exploded`) and are checked by indicators. */
  readonly runtimeCountKeys: readonly string[];
}

interface BlockPlan {
  readonly block: BlockConfig;
  length: number;
  start: number;
  readonly isProbe: boolean;
}

function isProbeBlock(block: BlockConfig): boolean {
  return block.beats.includes(PROBE_BEAT) || block.condition_id === 'probe';
}

function isNonScorePhase(block: BlockConfig): boolean {
  return block.phase === 'practice' || block.phase === 'warmup';
}

function trialTypesOf(block: BlockConfig): string[] {
  return block.beats.filter((b) => !MODIFIER_BEATS.has(b) && b !== PROBE_BEAT);
}

function numberAt(record: Readonly<Record<string, unknown>>, key: string): number | null {
  const v = record[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function windowAt(record: Readonly<Record<string, unknown>>, key: string): [number, number] | null {
  const v = record[key];
  if (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number')) {
    return [v[0] as number, v[1] as number];
  }
  return null;
}

/** Does a count key (e.g. `free_rider_rounds`, `balloons`) name this trial type? */
export function countKeyMatchesType(key: string, type: string): boolean {
  const base = type.replace(/_round$/, '');
  return (
    key === type ||
    key === `${type}s` ||
    key === `${type}es` ||
    key === `${type}_rounds` ||
    key === `${base}_rounds` ||
    key === `${base}s`
  );
}

/** Does a count key name a block (`balloons`, `rounds`, `decisions` -> `decisions_pre|post`)? */
function blockMatchesKey(block: BlockConfig, key: string): boolean {
  return (
    block.block_id === key ||
    block.condition_id === key ||
    block.block_id.startsWith(`${key}_`) ||
    `${block.block_id}s` === key
  );
}

function keyNamesBlock(key: string, plans: readonly BlockPlan[]): boolean {
  return plans.some((p) => p.block.scorable && blockMatchesKey(p.block, key));
}

/** Largest-remainder apportionment of `total` over `weights`. */
function apportion(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const floors = raw.map(Math.floor);
  let rest = total - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (rest <= 0) break;
    floors[i] = (floors[i] ?? 0) + 1;
    rest -= 1;
  }
  return floors;
}

/**
 * Place `k` copies of `special` among `n` slots so no run exceeds `maxRun` (uniformly over gaps,
 * always valid when feasible); other slots get `null`.
 */
function placeWithRunLimit(n: number, k: number, maxRun: number, rng: SeededRng): boolean[] | null {
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

function maxRunOf(seq: readonly string[], type: string): number {
  let best = 0;
  let cur = 0;
  for (const t of seq) {
    cur = t === type ? cur + 1 : 0;
    if (cur > best) best = cur;
  }
  return best;
}

/** The engine's {@link TrialScheduler}. */
export class DataDrivenTrialScheduler implements TrialScheduler {
  private readonly generators: Readonly<Record<string, TrialOverrideGenerator | undefined>>;
  private readonly anchorLevel: CalibrationLevel;

  constructor(
    options: {
      readonly generators?: Readonly<Record<string, TrialOverrideGenerator | undefined>>;
      /** Level whose timing anchor trials use (default L2, the pilot level). */
      readonly anchorLevel?: CalibrationLevel;
    } = {},
  ) {
    this.generators = options.generators ?? {};
    this.anchorLevel = options.anchorLevel ?? 'L2';
  }

  schedule(
    config: GameConfig,
    level: CalibrationLevel,
    rng: SeededRng,
    formId: string,
  ): readonly GameTrialSpec[] {
    return this.build(config, level, rng, formId).trials;
  }

  /** Build the schedule with metadata. Throws {@link ScheduleConstraintError} on any violation. */
  build(
    config: GameConfig,
    level: CalibrationLevel,
    rng: SeededRng,
    formId: string,
  ): ScheduleResult {
    const form = config.forms.includes(formId) ? formId : config.forms[0];
    const constraints = config.constraints as Readonly<Record<string, unknown>>;

    // 1. Block order (optional counterbalancing of the scorable main blocks).
    const plans: BlockPlan[] = this.orderBlocks(config, rng).map((block) => ({
      block,
      length: block.trials,
      start: 0,
      isProbe: isProbeBlock(block),
    }));

    // 2. Block lengths and the context-shift position.
    const shift = this.resolveShift(config, plans, rng);
    let cursor = 0;
    for (const p of plans) {
      p.start = cursor;
      cursor += p.length;
    }

    // 3. Trial types per block.
    const moduleQuotas = this.moduleQuotas(config, plans);
    const types: string[][] = plans.map((p, i) =>
      this.allocateTypes(config, p, moduleQuotas.get(i), rng, form),
    );

    // 4. Placement windows for single-event types (e.g. `error_round_window`).
    for (const [pi, p] of plans.entries()) {
      const seq = types[pi] ?? [];
      for (const t of new Set(seq)) {
        const w = windowAt(constraints, `${t}_window`);
        if (!w) continue;
        const lo = Math.max(w[0], p.start);
        const hi = Math.min(w[1], p.start + p.length - 1);
        if (lo > hi) {
          throw new ScheduleConstraintError(config.module_id, [
            `${t}_window [${w[0]}, ${w[1]}] does not intersect block ${p.block.block_id}`,
          ]);
        }
        const target = rng.stream(`window.${t}`).int(lo, hi) - p.start;
        const first = seq.indexOf(t);
        const tmp = seq[target] as string;
        seq[target] = t;
        seq[first] = tmp;
      }
    }

    // 5. Anchor positions (form-keyed so they are identical across levels and sessions' levels).
    const anchorCount = numberAt(constraints, 'anchor_trials') ?? 0;
    const anchorSet = new Set<number>();
    if (anchorCount > 0) {
      const candidates: number[] = [];
      for (const p of plans) {
        if (!p.block.scorable || p.isProbe || isNonScorePhase(p.block)) continue;
        for (let i = 0; i < p.length; i += 1) candidates.push(p.start + i);
      }
      const keyed = createKeyedRng(`${config.config_id}|${form}`, 'anchors');
      for (const idx of keyed.shuffle(candidates).slice(0, anchorCount)) anchorSet.add(idx);
    }

    // 6. Materialise trial specs.
    const trials: GameTrialSpec[] = [];
    for (const [pi, p] of plans.entries()) {
      const seq = types[pi] ?? [];
      for (let i = 0; i < p.length; i += 1) {
        const index = p.start + i;
        const type = seq[i] ?? p.block.condition_id;
        const probeIndex = p.isProbe ? i : null;
        const anchor = p.isProbe || anchorSet.has(index);
        trials.push(
          this.materialise(config, p.block, {
            index,
            withinBlock: i,
            type,
            level,
            timingLevel: anchor ? this.anchorLevel : level,
            form,
            anchor: anchor && p.block.scorable && config.scorable && !isNonScorePhase(p.block),
            probeIndex,
            shift: shift.index === index,
            rng,
          }),
        );
      }
    }

    // 7. Verify every constraint and minimum.
    const { counts, runtimeKeys, violations } = this.verify(config, plans, trials, shift);
    if (violations.length > 0) throw new ScheduleConstraintError(config.module_id, violations);

    const blockLengths: Record<string, number> = {};
    for (const p of plans) blockLengths[p.block.block_id] = p.length;
    return {
      moduleId: config.module_id,
      level,
      formId: form,
      trials,
      blockOrder: plans.map((p) => p.block.block_id),
      blockLengths,
      contextShiftIndex: shift.index,
      contextShiftKind: config.context_shift?.kind ?? null,
      counts,
      runtimeCountKeys: runtimeKeys,
    };
  }

  private orderBlocks(config: GameConfig, rng: SeededRng): BlockConfig[] {
    const blocks = [...config.blocks];
    if (config.constraints.counterbalanced_block_order !== true) return blocks;
    // Counterbalance the contiguous run of scorable, non-probe main blocks.
    const idx = blocks
      .map((b, i) => ({ b, i }))
      .filter(({ b }) => b.scorable && !isProbeBlock(b) && b.phase === 'main')
      .map(({ i }) => i);
    if (idx.length < 2) return blocks;
    const shuffled = rng.stream('block_order').shuffle(idx.map((i) => blocks[i] as BlockConfig));
    idx.forEach((i, k) => {
      blocks[i] = shuffled[k] as BlockConfig;
    });
    return blocks;
  }

  /** Decide block lengths so the context shift falls inside its window; returns the shift index. */
  private resolveShift(
    config: GameConfig,
    plans: BlockPlan[],
    rng: SeededRng,
  ): { index: number | null } {
    const cs = config.context_shift;
    if (!cs) return { index: null };
    const [w0, w1] = cs.window;
    const startOf = (k: number): number => plans.slice(0, k).reduce((a, p) => a + p.length, 0);

    // a) A shift_post block, else a pressure block, is the shift.
    let target = plans.findIndex((p) => p.block.phase === 'shift_post');
    if (target < 0) target = plans.findIndex((p) => p.block.phase === 'pressure');
    if (target > 0) {
      const switchWindow = windowAt(config.constraints as Record<string, unknown>, 'switch_window');
      const prev = plans[target - 1] as BlockPlan;
      if (switchWindow) {
        // Seeded switch position: the preceding block's length is drawn within its own bounds,
        // the switch window and the context-shift window.
        const base = startOf(target - 1);
        const lo = Math.max(prev.block.min_trials, switchWindow[0], w0 - base);
        const hi = Math.min(prev.block.trials, switchWindow[1], w1 - base);
        if (lo > hi) {
          throw new ScheduleConstraintError(config.module_id, [
            `no switch position satisfies switch_window and context_shift.window`,
          ]);
        }
        prev.length = rng.stream('switch_position').int(lo, hi);
        return { index: startOf(target) };
      }
      let start = startOf(target);
      // Too late: shrink earlier scorable blocks towards their minimums (never below).
      for (let k = target - 1; k >= 0 && start > w1; k -= 1) {
        const p = plans[k] as BlockPlan;
        if (isNonScorePhase(p.block)) continue;
        const cut = Math.min(p.length - p.block.min_trials, start - w1);
        p.length -= cut;
        start -= cut;
      }
      if (start < w0 || start > w1) {
        throw new ScheduleConstraintError(config.module_id, [
          `context shift at ${start} cannot be placed in window [${w0}, ${w1}]`,
        ]);
      }
      return { index: start };
    }

    // b) A single-event type with its own window (e.g. share_pot error_round_window).
    const constraints = config.constraints as Readonly<Record<string, unknown>>;
    for (const p of plans) {
      for (const t of trialTypesOf(p.block)) {
        const w = windowAt(constraints, `${t}_window`);
        if (w) {
          // The placement step (4) puts the event inside this window; recompute after placement.
          return { index: -1 };
        }
      }
    }

    // c) A block boundary inside the window (e.g. steady_hands free -> held).
    for (let k = 1; k < plans.length; k += 1) {
      const p = plans[k] as BlockPlan;
      if (p.isProbe || isNonScorePhase(p.block)) continue;
      const s = startOf(k);
      if (s >= w0 && s <= w1) return { index: s };
    }
    throw new ScheduleConstraintError(config.module_id, [
      `no block boundary or windowed event for context shift window [${w0}, ${w1}]`,
    ]);
  }

  /** Module-level planned counts per type, apportioned to the blocks containing that type. */
  private moduleQuotas(
    config: GameConfig,
    plans: readonly BlockPlan[],
  ): Map<number, Map<string, number>> {
    const out = new Map<number, Map<string, number>>();
    const constraints = config.constraints as Readonly<Record<string, unknown>>;
    const allTypes = new Set<string>();
    for (const p of plans) for (const t of trialTypesOf(p.block)) allTypes.add(t);
    for (const t of allTypes) {
      if (numberAt(constraints, `${t}_share`) !== null) continue; // share-based types are per block
      const key = Object.keys(config.planned_counts).find(
        (k) => !k.endsWith('_per_block') && !keyNamesBlock(k, plans) && countKeyMatchesType(k, t),
      );
      if (!key) continue;
      const total = config.planned_counts[key] ?? 0;
      const holders = plans
        .map((p, i) => ({ p, i }))
        .filter(
          ({ p }) => !isNonScorePhase(p.block) && !p.isProbe && trialTypesOf(p.block).includes(t),
        );
      const shares = apportion(
        total,
        holders.map(({ p }) => p.length),
      );
      holders.forEach(({ i }, k) => {
        const m = out.get(i) ?? new Map<string, number>();
        m.set(t, shares[k] ?? 0);
        out.set(i, m);
      });
    }
    return out;
  }

  private allocateTypes(
    config: GameConfig,
    plan: BlockPlan,
    blockQuota: ReadonlyMap<string, number> | undefined,
    rng: SeededRng,
    form: string,
  ): string[] {
    const { block, length: n } = plan;
    if (plan.isProbe) return new Array<string>(n).fill(PROBE_BEAT);
    const types = isNonScorePhase(block) && block.phase === 'practice' ? [] : trialTypesOf(block);
    if (types.length === 0) {
      return new Array<string>(n).fill(
        block.phase === 'practice' ? 'practice' : block.condition_id,
      );
    }
    const constraints = config.constraints as Readonly<Record<string, unknown>>;
    const quotas = new Map<string, number>();
    for (const t of types) {
      const share = numberAt(constraints, `${t}_share`);
      if (share !== null) {
        let q = Math.round(n * share);
        const perBlock = config.planned_counts[`${t}_per_block`];
        if (typeof perBlock === 'number') q = Math.max(q, perBlock);
        quotas.set(t, Math.min(n, q));
        continue;
      }
      const q = blockQuota?.get(t);
      if (q !== undefined) quotas.set(t, Math.min(n, q));
    }
    let assigned = [...quotas.values()].reduce((a, b) => a + b, 0);
    if (assigned > n) {
      throw new ScheduleConstraintError(config.module_id, [
        `block ${block.block_id}: planned counts (${assigned}) exceed block length (${n})`,
      ]);
    }
    let fillers = types.filter((t) => !quotas.has(t));
    if (fillers.length === 0) {
      const complements = [...quotas.keys()]
        .map((t) => COMPLEMENT_TYPES[t])
        .filter((t): t is string => !!t);
      fillers = complements.length > 0 ? [...new Set(complements)] : [];
    }
    const remaining = n - assigned;
    if (remaining > 0) {
      if (fillers.length === 0) fillers = [block.condition_id];
      const base = Math.floor(remaining / fillers.length);
      const extra = remaining % fillers.length;
      const lucky = new Set(rng.stream(`extra.${block.block_id}`).shuffle(fillers).slice(0, extra));
      for (const t of fillers) {
        const q = base + (lucky.has(t) ? 1 : 0);
        quotas.set(t, (quotas.get(t) ?? 0) + q);
        assigned += q;
      }
    }

    // Arrange: fixed per form when required (e.g. Tower), else from the session stream.
    const arrangeRng =
      config.constraints.order_fixed_per_form === true
        ? createKeyedRng(`${config.config_id}|${form}|${block.block_id}`, 'order')
        : rng.stream(`arrange.${block.block_id}`);
    const limited = [...quotas.keys()].filter(
      (t) => numberAt(constraints, `max_consecutive_${t}`) !== null && (quotas.get(t) ?? 0) > 0,
    );
    if (limited.length === 1) {
      const special = limited[0] as string;
      const maxRun = numberAt(constraints, `max_consecutive_${special}`) ?? n;
      const k = quotas.get(special) ?? 0;
      const mask = placeWithRunLimit(n, k, maxRun, arrangeRng);
      if (!mask) {
        throw new ScheduleConstraintError(config.module_id, [
          `block ${block.block_id}: ${k} x ${special} cannot satisfy max_consecutive_${special}=${maxRun} in ${n} trials`,
        ]);
      }
      const others: string[] = [];
      for (const [t, q] of quotas) if (t !== special) for (let i = 0; i < q; i += 1) others.push(t);
      const shuffledOthers = arrangeRng.shuffle(others);
      let o = 0;
      return mask.map((isSpecial) => (isSpecial ? special : (shuffledOthers[o++] as string)));
    }
    const pool: string[] = [];
    for (const [t, q] of quotas) for (let i = 0; i < q; i += 1) pool.push(t);
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const seq = arrangeRng.shuffle(pool);
      const ok = limited.every(
        (t) => maxRunOf(seq, t) <= (numberAt(constraints, `max_consecutive_${t}`) ?? n),
      );
      if (ok) return seq;
    }
    throw new ScheduleConstraintError(config.module_id, [
      `block ${block.block_id}: could not satisfy run limits for ${limited.join(', ')}`,
    ]);
  }

  private materialise(
    config: GameConfig,
    block: BlockConfig,
    t: {
      index: number;
      withinBlock: number;
      type: string;
      level: CalibrationLevel;
      timingLevel: CalibrationLevel;
      form: string;
      anchor: boolean;
      probeIndex: number | null;
      shift: boolean;
      rng: SeededRng;
    },
  ): GameTrialSpec {
    const timing = config.levels[t.timingLevel].timing;
    const privateReport =
      block.condition_id === 'private_report' || PRIVATE_REPORT_TYPES.has(t.type);
    const { vocabulary, expected } = defaultVocabulary(config, block, t.type);
    const windowKey = resolveWindowKey(config, block, t.type, timing);
    const scorable = block.scorable && config.scorable && !isNonScorePhase(block);
    const trialId = `${config.module_id}.${block.block_id}.${t.withinBlock}`;
    // Content streams are level-independent: same seed + trial id => same stimulus at every level.
    const contentRng =
      t.probeIndex !== null
        ? createKeyedRng(`probe|${t.probeIndex}`, 'probe')
        : t.rng.stream(`trial.${block.block_id}.${t.withinBlock}`);
    const jitterAmp = timing.isi_jitter_ms ?? 0;
    const jitterRng = t.rng.stream(`jitter.${block.block_id}.${t.withinBlock}`);
    const stimulusDuration = timing[`${t.type}_ms`] ?? timing.stimulus_ms ?? null;
    const isi =
      (block.phase === 'pressure' ? timing.pressure_isi_ms : undefined) ??
      timing.isi_ms ??
      timing.iti_ms ??
      timing.customer_isi_ms ??
      null;
    const params: Record<string, unknown> = {
      beats: block.beats.filter((b) => MODIFIER_BEATS.has(b)),
      variant: contentRng.nextUint32(),
    };
    if (t.shift) params.context_shift = true;
    if (t.probeIndex !== null) params.probe_index = t.probeIndex;

    const spec: GameTrialSpec = {
      schema_version: '1.0',
      trial_id: trialId,
      module_id: config.module_id,
      episode_id: config.kind === 'episode' ? config.module_id : null,
      block_id: block.block_id,
      trial_index: t.index,
      trial_type: t.type,
      phase: block.phase,
      condition_id: block.condition_id,
      calibration_level: t.level,
      response_window_ms:
        t.probeIndex !== null && block.budget_trial_ms !== null
          ? block.budget_trial_ms
          : windowKey
            ? (timing[windowKey] ?? null)
            : null,
      stimulus_id: t.probeIndex !== null ? `probe.${t.probeIndex}` : null,
      vocabulary,
      voice_vocabulary: voiceAllowed(t.type, privateReport) ? [...vocabulary] : [],
      audio_keys: config.audio_keys.filter((k) => k.startsWith(`${config.module_id}.${t.type}`)),
      private_report: privateReport,
      anchor_trial: t.anchor,
      form_id: t.form,
      probe_group_id: t.probeIndex !== null ? `probe.${t.probeIndex}` : null,
      scorable,
      expected_response: expected,
      latency_anchor: defaultTrialLatencyAnchor(t.type),
      timing: {
        stimulus_duration_ms: stimulusDuration,
        isi_ms: isi,
        jitter_ms: jitterAmp > 0 ? jitterRng.int(0, jitterAmp) : null,
      },
      params,
    };
    const generator = this.generators[config.module_id];
    if (!generator) return spec;
    const o = generator({ trial: spec, block, config, rng: contentRng.stream('module') });
    return {
      ...spec,
      ...(o.stimulus_id !== undefined ? { stimulus_id: o.stimulus_id } : {}),
      ...(o.expected_response !== undefined ? { expected_response: o.expected_response } : {}),
      ...(o.vocabulary ? { vocabulary: [...o.vocabulary] as [string, ...string[]] } : {}),
      ...(o.voice_vocabulary ? { voice_vocabulary: [...o.voice_vocabulary] } : {}),
      ...(o.audio_keys ? { audio_keys: [...o.audio_keys] } : {}),
      ...(o.response_window_ms !== undefined ? { response_window_ms: o.response_window_ms } : {}),
      params: { ...params, ...(o.params ?? {}) },
    };
  }

  private verify(
    config: GameConfig,
    plans: readonly BlockPlan[],
    trials: readonly GameTrialSpec[],
    shift: { index: number | null },
  ): { counts: Record<string, number>; runtimeKeys: string[]; violations: string[] } {
    const violations: string[] = [];
    const constraints = config.constraints as Readonly<Record<string, unknown>>;
    for (const p of plans) {
      if (p.length < p.block.min_trials) {
        violations.push(
          `block ${p.block.block_id}: ${p.length} trials < min_trials ${p.block.min_trials}`,
        );
      }
    }
    // Shift index for windowed single events is the placed event.
    if (shift.index === -1) {
      const kindType = trials.find((t) => windowAt(constraints, `${t.trial_type}_window`) !== null);
      shift.index = kindType ? kindType.trial_index : null;
      if (kindType) (kindType.params as Record<string, unknown>).context_shift = true;
    }
    const cs = config.context_shift;
    if (cs) {
      if (shift.index === null || shift.index < cs.window[0] || shift.index > cs.window[1]) {
        violations.push(
          `context shift index ${String(shift.index)} outside window [${cs.window.join(', ')}]`,
        );
      }
    }
    const scorable = trials.filter((t) => t.scorable);
    const byType = new Map<string, number>();
    for (const t of scorable) byType.set(t.trial_type, (byType.get(t.trial_type) ?? 0) + 1);

    // Run limits hold within each block.
    for (const key of Object.keys(constraints)) {
      const m = /^max_consecutive_(.+)$/.exec(key);
      if (!m) continue;
      const type = m[1] as string;
      const limit = numberAt(constraints, key) ?? Number.POSITIVE_INFINITY;
      for (const p of plans) {
        const seq = trials.filter((t) => t.block_id === p.block.block_id).map((t) => t.trial_type);
        if (maxRunOf(seq, type) > limit)
          violations.push(`block ${p.block.block_id}: run of ${type} exceeds ${limit}`);
      }
    }

    const counts: Record<string, number> = {};
    const runtimeKeys: string[] = [];
    const shiftPost = plans.filter((p) => p.block.phase === 'shift_post');
    for (const [key, min] of Object.entries(config.min_counts)) {
      if (min === undefined) continue;
      let value: number | null = null;
      const perBlock = /^(.+)_per_block$/.exec(key);
      if (perBlock) {
        const type = perBlock[1] as string;
        const holders = plans.filter(
          (p) => p.block.scorable && trialTypesOf(p.block).includes(type),
        );
        if (holders.length > 0) {
          value = Math.min(
            ...holders.map(
              (p) =>
                trials.filter((t) => t.block_id === p.block.block_id && t.trial_type === type)
                  .length,
            ),
          );
        }
      } else if (key === 'gng') {
        value = (byType.get('go') ?? 0) + (byType.get('nogo') ?? 0);
      } else if (key === 'switches') {
        value = shiftPost.length;
      } else if (/_per_switch$/.test(key) && shiftPost.length > 0) {
        value = Math.min(...shiftPost.map((p) => p.length));
      } else if (/^post_(shift|switch|reversal)$/.test(key) && shiftPost.length > 0) {
        value = shiftPost.reduce((a, p) => a + p.length, 0);
      } else {
        // Block names win over type names (`choices` is the Four Stalls block, not the filler type).
        const blocks = plans.filter((p) => p.block.scorable && blockMatchesKey(p.block, key));
        if (blocks.length > 0) {
          value = blocks.reduce((a, p) => a + p.length, 0);
        } else {
          const typeHit = [...byType.keys()].filter((t) => countKeyMatchesType(key, t));
          if (typeHit.length > 0) value = typeHit.reduce((a, t) => a + (byType.get(t) ?? 0), 0);
        }
      }
      if (value === null) {
        runtimeKeys.push(key);
        continue;
      }
      counts[key] = value;
      if (value < min) violations.push(`min_counts.${key}: scheduled ${value} < ${min}`);
    }
    return { counts, runtimeKeys, violations };
  }
}
