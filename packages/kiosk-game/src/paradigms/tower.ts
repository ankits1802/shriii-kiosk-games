/**
 * Tower of London (MG-04 Tower Puzzle): state model, legal moves, BFS optimal solver with
 * unsolvability proofs, seeded per-form problem sets, and move / illegal-attempt classification.
 *
 * Pots (`pot_red`, `pot_green`, `pot_blue`; colour is always paired with a pattern in the art kit)
 * sit in baskets (`basket_1..3`) of limited capacity; only the top pot of a basket can move.
 *
 * - Solvable problems use the classic capacities `[3, 2, 1]` (all 36 states mutually reachable);
 *   the minimum move counts are proven by breadth-first search.
 * - Unsolvable items use capacities with exactly one free slot (e.g. `[2, 1, 1]`): the state space
 *   splits into disconnected components, so a goal that fits the baskets can still be unreachable.
 *   Unsolvability is proven by exhausting the reachable set. Each form has a different unsolvable
 *   identity (ENG-14).
 *
 * Planning time is the time from problem onset to the first move ATTEMPT (legal or not), matching
 * the scorer's `tower.planning_time`. Every attempt (legal or illegal) gets a `move_index`.
 */
import type { GameConfig, MovePayload } from '@shriii/contracts';
import type { SeededRng } from '../core/contracts.ts';
import { createKeyedRng } from '../engine/rng.ts';
import type { TrialOverrideGenerator } from '../engine/scheduler.ts';
import {
  constraintNumber,
  constraintWindow,
  type IndicatorBinding,
  ParadigmConfigError,
  ParadigmStateError,
} from './common.ts';

const PARADIGM = 'tower_of_london';

export const POTS = ['pot_red', 'pot_green', 'pot_blue'] as const;
export type PotId = (typeof POTS)[number];

/** Baskets bottom-to-top. */
export type TowerState = readonly (readonly PotId[])[];

export interface TowerMove {
  /** 0-based basket indices. */
  readonly from: number;
  readonly to: number;
}

export interface TowerProblem {
  readonly id: string;
  readonly kind: 'solvable' | 'unsolvable';
  readonly capacities: readonly number[];
  readonly start: TowerState;
  readonly goal: TowerState;
  /** Proven minimum moves (solvable) or null (unsolvable). */
  readonly minMoves: number | null;
}

export function basketId(index: number): string {
  return `basket_${index + 1}`;
}

export function stateKey(state: TowerState): string {
  return state.map((b) => b.join(',')).join('|');
}

export function statesEqual(a: TowerState, b: TowerState): boolean {
  return stateKey(a) === stateKey(b);
}

/** True when the state respects capacities and holds each pot exactly once. */
export function isValidState(
  state: TowerState,
  capacities: readonly number[],
  pots: readonly PotId[] = POTS,
): boolean {
  if (state.length !== capacities.length) return false;
  const seen: string[] = [];
  for (let i = 0; i < state.length; i += 1) {
    const b = state[i] as readonly PotId[];
    if (b.length > (capacities[i] ?? 0)) return false;
    seen.push(...b);
  }
  return (
    seen.length === pots.length &&
    new Set(seen).size === pots.length &&
    pots.every((p) => seen.includes(p))
  );
}

export type MoveRejection = 'invalid_basket' | 'same_basket' | 'empty_source' | 'destination_full';

export type MoveCheck =
  | { readonly legal: true; readonly item: PotId }
  | { readonly legal: false; readonly reason: MoveRejection; readonly item: PotId | null };

/** Check one move attempt against the rules. */
export function checkMove(
  state: TowerState,
  capacities: readonly number[],
  move: TowerMove,
): MoveCheck {
  const n = state.length;
  const valid = (i: number): boolean => Number.isInteger(i) && i >= 0 && i < n;
  if (!valid(move.from) || !valid(move.to))
    return { legal: false, reason: 'invalid_basket', item: null };
  const src = state[move.from] as readonly PotId[];
  const item = src.length > 0 ? (src[src.length - 1] as PotId) : null;
  if (move.from === move.to) return { legal: false, reason: 'same_basket', item };
  if (item === null) return { legal: false, reason: 'empty_source', item: null };
  if ((state[move.to] as readonly PotId[]).length >= (capacities[move.to] ?? 0)) {
    return { legal: false, reason: 'destination_full', item };
  }
  return { legal: true, item };
}

/** Apply a legal move (throws on an illegal one). */
export function applyMove(
  state: TowerState,
  capacities: readonly number[],
  move: TowerMove,
): TowerState {
  const c = checkMove(state, capacities, move);
  if (!c.legal)
    throw new ParadigmStateError(PARADIGM, `illegal move ${move.from}->${move.to}: ${c.reason}`);
  return state.map((b, i) => {
    if (i === move.from) return b.slice(0, -1);
    if (i === move.to) return [...b, c.item];
    return b;
  });
}

/** All legal moves from a state, in a fixed order (from, then to). */
export function legalMoves(state: TowerState, capacities: readonly number[]): TowerMove[] {
  const out: TowerMove[] = [];
  for (let from = 0; from < state.length; from += 1) {
    for (let to = 0; to < state.length; to += 1) {
      if (checkMove(state, capacities, { from, to }).legal) out.push({ from, to });
    }
  }
  return out;
}

export type SolveResult =
  | {
      readonly solvable: true;
      readonly minMoves: number;
      readonly path: readonly TowerMove[];
      readonly explored: number;
    }
  | { readonly solvable: false; readonly explored: number };

/**
 * Breadth-first search from `start` to `goal`. Optimal (BFS explores by depth) and, when the goal is
 * absent, a proof of unsolvability (the whole reachable component was exhausted).
 */
export function solve(
  start: TowerState,
  goal: TowerState,
  capacities: readonly number[],
): SolveResult {
  if (!isValidState(start, capacities) || !isValidState(goal, capacities)) {
    throw new ParadigmConfigError(
      PARADIGM,
      'start and goal must be valid states for the capacities',
    );
  }
  const goalKey = stateKey(goal);
  const parent = new Map<
    string,
    { prev: string | null; move: TowerMove | null; state: TowerState }
  >();
  parent.set(stateKey(start), { prev: null, move: null, state: start });
  const queue: TowerState[] = [start];
  for (let head = 0; head < queue.length; head += 1) {
    const s = queue[head] as TowerState;
    const k = stateKey(s);
    if (k === goalKey) {
      const path: TowerMove[] = [];
      let cur: string | null = k;
      while (cur !== null) {
        const node = parent.get(cur);
        if (!node || node.move === null) break;
        path.push(node.move);
        cur = node.prev;
      }
      path.reverse();
      return { solvable: true, minMoves: path.length, path, explored: parent.size };
    }
    for (const m of legalMoves(s, capacities)) {
      const next = applyMove(s, capacities, m);
      const nk = stateKey(next);
      if (!parent.has(nk)) {
        parent.set(nk, { prev: k, move: m, state: next });
        queue.push(next);
      }
    }
  }
  return { solvable: false, explored: parent.size };
}

/** Every valid state for the capacities and pots (enumeration order is deterministic). */
export function allStates(
  capacities: readonly number[],
  pots: readonly PotId[] = POTS,
): TowerState[] {
  const out: TowerState[] = [];
  const rec = (i: number, remaining: readonly PotId[], acc: PotId[][]): void => {
    if (i === capacities.length) {
      if (remaining.length === 0) out.push(acc.map((b) => [...b]));
      return;
    }
    const cap = capacities[i] ?? 0;
    const orderings = (k: number, pool: readonly PotId[]): PotId[][] => {
      if (k === 0) return [[]];
      const res: PotId[][] = [];
      for (const p of pool) {
        for (const rest of orderings(
          k - 1,
          pool.filter((x) => x !== p),
        ))
          res.push([p, ...rest]);
      }
      return res;
    };
    for (let k = 0; k <= Math.min(cap, remaining.length); k += 1) {
      for (const chosen of orderings(k, remaining)) {
        rec(
          i + 1,
          remaining.filter((p) => !chosen.includes(p)),
          [...acc, chosen],
        );
      }
    }
  };
  rec(0, pots, []);
  return out;
}

/** Verify a problem's declared kind and minimum moves with the solver (build-time check, MG-04 AC). */
export function verifyProblem(p: TowerProblem): { readonly ok: boolean; readonly detail: string } {
  const r = solve(p.start, p.goal, p.capacities);
  if (p.kind === 'unsolvable') {
    return r.solvable
      ? { ok: false, detail: `${p.id}: declared unsolvable but solvable in ${r.minMoves}` }
      : { ok: true, detail: `${p.id}: unsolvable (explored ${r.explored} states)` };
  }
  if (!r.solvable) return { ok: false, detail: `${p.id}: declared solvable but unreachable` };
  return r.minMoves === p.minMoves
    ? { ok: true, detail: `${p.id}: ${r.minMoves} moves` }
    : { ok: false, detail: `${p.id}: declared ${String(p.minMoves)} moves, solver ${r.minMoves}` };
}

/* ------------------------------------------------------------------------------------------------
 * Problem sets
 * ---------------------------------------------------------------------------------------------- */

export const SOLVABLE_CAPACITIES: readonly number[] = [3, 2, 1];
/** One-free-slot capacity variants for unsolvable items. */
export const UNSOLVABLE_CAPACITIES: readonly (readonly number[])[] = [
  [2, 1, 1],
  [1, 2, 1],
  [1, 1, 2],
];

export interface TowerProblemSetOptions {
  readonly configId: string;
  readonly formId: string;
  readonly minMovesRange: readonly [number, number];
  readonly solvable: number;
  readonly unsolvable: number;
  /** Item order (indices of solvable/unsolvable positions); default interleaves like the simulator. */
  readonly order?: readonly ('solvable' | 'unsolvable')[];
}

/** Options from the config: `min_moves_range`, `min_counts.solvable/unsolvable`, `baskets`. */
export function towerProblemSetOptions(config: GameConfig, formId: string): TowerProblemSetOptions {
  const range = constraintWindow(config, 'min_moves_range');
  const baskets = constraintNumber(config, 'baskets');
  const solvable = config.planned_counts.solvable;
  const unsolvable = config.planned_counts.unsolvable;
  if (!range || solvable === undefined || unsolvable === undefined) {
    throw new ParadigmConfigError(
      PARADIGM,
      'min_moves_range and planned_counts.solvable/unsolvable are required',
    );
  }
  if (baskets !== null && baskets !== 3) {
    throw new ParadigmConfigError(PARADIGM, `only 3 baskets are supported, config has ${baskets}`);
  }
  return { configId: config.config_id, formId, minMovesRange: range, solvable, unsolvable };
}

function defaultOrder(solvable: number, unsolvable: number): ('solvable' | 'unsolvable')[] {
  // Unsolvable items never come first and never back-to-back (recovery-after-failure contrast).
  const out: ('solvable' | 'unsolvable')[] = [];
  let s = solvable;
  let u = unsolvable;
  while (s > 0 || u > 0) {
    const last = out[out.length - 1];
    if (u > 0 && out.length > 0 && last !== 'unsolvable' && (s <= u || out.length % 2 === 1)) {
      out.push('unsolvable');
      u -= 1;
    } else if (s > 0) {
      out.push('solvable');
      s -= 1;
    } else {
      out.push('unsolvable');
      u -= 1;
    }
  }
  return out;
}

/**
 * Deterministic problem set for a form (identical across sessions and levels; `order_fixed_per_form`).
 * Solvable minimum moves are spread across the range (ascending difficulty); each problem is proven.
 */
export function buildTowerProblemSet(options: TowerProblemSetOptions): TowerProblem[] {
  const [lo, hi] = options.minMovesRange;
  if (!(lo >= 1 && hi >= lo))
    throw new ParadigmConfigError(PARADIGM, `bad min_moves_range [${lo}, ${hi}]`);
  const rng = createKeyedRng(`${options.configId}|${options.formId}|tower`, 'problems');
  const states = allStates(SOLVABLE_CAPACITIES);
  // Targets: evenly spread over [lo, hi].
  const targets: number[] = [];
  for (let i = 0; i < options.solvable; i += 1) {
    targets.push(
      options.solvable === 1 ? lo : Math.round(lo + ((hi - lo) * i) / (options.solvable - 1)),
    );
  }
  const used = new Set<string>();
  const solvable: TowerProblem[] = targets.map((target, i) => {
    for (let attempt = 0; attempt < 5000; attempt += 1) {
      const start = rng.pick(states);
      const goal = rng.pick(states);
      const key = `${stateKey(start)}>${stateKey(goal)}`;
      if (used.has(key)) continue;
      const r = solve(start, goal, SOLVABLE_CAPACITIES);
      if (r.solvable && r.minMoves === target) {
        used.add(key);
        return {
          id: `tower.${options.formId}.s${i}`,
          kind: 'solvable',
          capacities: SOLVABLE_CAPACITIES,
          start,
          goal,
          minMoves: target,
        };
      }
    }
    throw new ParadigmConfigError(PARADIGM, `no solvable problem with ${target} minimum moves`);
  });
  const unsolvable: TowerProblem[] = [];
  const formRng = createKeyedRng(
    `${options.configId}|${options.formId}|tower_unsolvable`,
    'problems',
  );
  for (let i = 0; i < options.unsolvable; i += 1) {
    let made: TowerProblem | null = null;
    for (let attempt = 0; attempt < 5000 && !made; attempt += 1) {
      const caps = formRng.pick(UNSOLVABLE_CAPACITIES);
      const pool = allStates(caps);
      const start = formRng.pick(pool);
      const goal = formRng.pick(pool);
      const key = `${caps.join('')}:${stateKey(start)}>${stateKey(goal)}`;
      if (used.has(key)) continue;
      if (!solve(start, goal, caps).solvable) {
        used.add(key);
        made = {
          id: `tower.${options.formId}.u${i}`,
          kind: 'unsolvable',
          capacities: caps,
          start,
          goal,
          minMoves: null,
        };
      }
    }
    if (!made) throw new ParadigmConfigError(PARADIGM, 'could not construct an unsolvable item');
    unsolvable.push(made);
  }
  const order = options.order ?? defaultOrder(options.solvable, options.unsolvable);
  const out: TowerProblem[] = [];
  let si = 0;
  let ui = 0;
  for (const kind of order) {
    const p = kind === 'solvable' ? solvable[si++] : unsolvable[ui++];
    if (!p) throw new ParadigmConfigError(PARADIGM, 'order does not match the problem counts');
    out.push(p);
  }
  if (si !== solvable.length || ui !== unsolvable.length) {
    throw new ParadigmConfigError(PARADIGM, 'order does not use every problem');
  }
  return out;
}

/** Practice problem (2 moves, classic capacities), fixed per form. */
export function practiceProblem(configId: string, formId: string): TowerProblem {
  const rng = createKeyedRng(`${configId}|${formId}|tower_practice`, 'problems');
  const states = allStates(SOLVABLE_CAPACITIES);
  for (let attempt = 0; attempt < 5000; attempt += 1) {
    const start = rng.pick(states);
    const goal = rng.pick(states);
    const r = solve(start, goal, SOLVABLE_CAPACITIES);
    if (r.solvable && r.minMoves === 2) {
      return {
        id: `tower.${formId}.practice`,
        kind: 'solvable',
        capacities: SOLVABLE_CAPACITIES,
        start,
        goal,
        minMoves: 2,
      };
    }
  }
  throw new ParadigmConfigError(PARADIGM, 'no practice problem');
}

/* ------------------------------------------------------------------------------------------------
 * Runtime trial state and classification
 * ---------------------------------------------------------------------------------------------- */

export interface MoveAttemptRecord {
  readonly moveIndex: number;
  readonly tMs: number;
  readonly from: number;
  readonly to: number;
  readonly legal: boolean;
  readonly rejection: MoveRejection | null;
  readonly item: PotId | null;
  /** True when this legal move reached the goal. */
  readonly solvedNow: boolean;
}

export interface TowerTrialSummary {
  readonly problemId: string;
  readonly kind: TowerProblem['kind'];
  readonly solved: boolean;
  readonly skipped: boolean;
  readonly legalMoves: number;
  readonly illegalAttempts: number;
  /** Legal moves beyond the optimum on a solved problem; null otherwise. */
  readonly excessMoves: number | null;
  /** Onset to first attempt (legal or illegal); null when nothing was attempted. */
  readonly planningTimeMs: number | null;
  /** Onset to solve / skip / end. */
  readonly timeOnItemMs: number | null;
  readonly endedBy: 'solved' | 'skip' | 'cap' | 'aborted' | null;
}

/** Live state of one Tower problem. Pure; the module renders and logs from the returned records. */
export class TowerTrial {
  readonly problem: TowerProblem;
  readonly onsetMs: number;
  private current: TowerState;
  private readonly attempts: MoveAttemptRecord[] = [];
  private endedBy: TowerTrialSummary['endedBy'] = null;
  private endMs: number | null = null;

  constructor(problem: TowerProblem, onsetMs: number) {
    this.problem = problem;
    this.onsetMs = onsetMs;
    this.current = problem.start;
  }

  get state(): TowerState {
    return this.current;
  }

  get ended(): boolean {
    return this.endedBy !== null;
  }

  /** Attempt a move; illegal attempts are recorded and leave the state unchanged. */
  attempt(move: TowerMove, tMs: number): MoveAttemptRecord {
    if (this.ended) throw new ParadigmStateError(PARADIGM, `${this.problem.id} already ended`);
    const c = checkMove(this.current, this.problem.capacities, move);
    let solvedNow = false;
    if (c.legal) {
      this.current = applyMove(this.current, this.problem.capacities, move);
      solvedNow = statesEqual(this.current, this.problem.goal);
    }
    const rec: MoveAttemptRecord = {
      moveIndex: this.attempts.length,
      tMs,
      from: move.from,
      to: move.to,
      legal: c.legal,
      rejection: c.legal ? null : c.reason,
      item: c.item,
      solvedNow,
    };
    this.attempts.push(rec);
    if (solvedNow) {
      this.endedBy = 'solved';
      this.endMs = tMs;
    }
    return rec;
  }

  /** The player tapped the skip icon (`response_value: skip`). */
  skip(tMs: number): void {
    if (this.ended) throw new ParadigmStateError(PARADIGM, `${this.problem.id} already ended`);
    this.endedBy = 'skip';
    this.endMs = tMs;
  }

  /** The item cap elapsed (`unsolvable_cap_ms` / `solvable_cap_ms`) or the module was aborted. */
  end(reason: 'cap' | 'aborted', tMs: number): void {
    if (this.ended) return;
    this.endedBy = reason;
    this.endMs = tMs;
  }

  /** Whether the skip icon is visible at `tMs` (`skip_icon_after_ms` from the level table). */
  skipIconVisible(tMs: number, skipIconAfterMs: number): boolean {
    return tMs - this.onsetMs >= skipIconAfterMs;
  }

  log(): readonly MoveAttemptRecord[] {
    return this.attempts;
  }

  /** The `move` event payload for an attempt. */
  movePayload(rec: MoveAttemptRecord): MovePayload {
    return {
      problem_id: this.problem.id,
      item_id: rec.item ?? 'none',
      from_slot: basketId(rec.from),
      to_slot: basketId(rec.to),
      legal: rec.legal,
      move_index: rec.moveIndex,
    };
  }

  summary(): TowerTrialSummary {
    const legal = this.attempts.filter((a) => a.legal).length;
    const solved = this.endedBy === 'solved';
    const first = this.attempts[0];
    return {
      problemId: this.problem.id,
      kind: this.problem.kind,
      solved,
      skipped: this.endedBy === 'skip',
      legalMoves: legal,
      illegalAttempts: this.attempts.length - legal,
      excessMoves:
        solved && this.problem.minMoves !== null
          ? Math.max(0, legal - this.problem.minMoves)
          : null,
      planningTimeMs: first ? first.tMs - this.onsetMs : null,
      timeOnItemMs: this.endMs !== null ? this.endMs - this.onsetMs : null,
      endedBy: this.endedBy,
    };
  }
}

/** Optimal-play bot: the solver path (used by headless bots and the "optimal bot = 0 excess" test). */
export function optimalMoves(problem: TowerProblem): readonly TowerMove[] {
  const r = solve(problem.start, problem.goal, problem.capacities);
  return r.solvable ? r.path : [];
}

/* ------------------------------------------------------------------------------------------------
 * Scheduler integration
 * ---------------------------------------------------------------------------------------------- */

/** Serializable problem params for the trial spec (scoring keys `problem_id`, `min_moves`, `skip_icon_ms`, `cap_ms`). */
export function towerTrialParams(
  problem: TowerProblem,
  timing: { readonly skipIconMs: number; readonly capMs: number },
): Record<string, unknown> {
  return {
    problem_id: problem.id,
    ...(problem.minMoves !== null ? { min_moves: problem.minMoves } : {}),
    skip_icon_ms: timing.skipIconMs,
    cap_ms: timing.capMs,
    capacities: [...problem.capacities],
    start: problem.start.map((b) => [...b]),
    goal: problem.goal.map((b) => [...b]),
  };
}

/**
 * Scheduler override generator: the k-th `solvable`/`unsolvable` trial of a form gets the k-th
 * problem of that kind from {@link buildTowerProblemSet} (solvable problems therefore appear in
 * ascending difficulty); practice gets {@link practiceProblem}. Timing keys: `skip_icon_after_ms`,
 * `solvable_cap_ms`, `unsolvable_cap_ms` (level table).
 *
 * The generator is stateful: it relies on the engine scheduler materialising trials in trial-index
 * order and resets its counters whenever trial index 0 is materialised (a new schedule build).
 */
export function towerOverrides(level: 'L1' | 'L2' | 'L3'): TrialOverrideGenerator {
  const sets = new Map<string, TowerProblem[]>();
  let used = { solvable: 0, unsolvable: 0 };
  return ({ trial, block, config }) => {
    if (trial.trial_index === 0) used = { solvable: 0, unsolvable: 0 };
    if (trial.trial_type === 'probe_segment') return {};
    const timing = config.levels[level].timing;
    const skipIconMs = timing.skip_icon_after_ms;
    if (skipIconMs === undefined)
      throw new ParadigmConfigError(PARADIGM, 'skip_icon_after_ms missing');
    if (block.phase === 'practice') {
      const p = practiceProblem(config.config_id, trial.form_id);
      const cap = timing.solvable_cap_ms;
      if (cap === undefined) throw new ParadigmConfigError(PARADIGM, 'solvable_cap_ms missing');
      return {
        stimulus_id: p.id,
        vocabulary: ['skip'],
        voice_vocabulary: [],
        response_window_ms: cap,
        params: towerTrialParams(p, { skipIconMs, capMs: cap }),
      };
    }
    const setKey = `${config.config_id}|${trial.form_id}`;
    let set = sets.get(setKey);
    if (!set) {
      set = buildTowerProblemSet(towerProblemSetOptions(config, trial.form_id));
      sets.set(setKey, set);
    }
    const kind = trial.trial_type === 'unsolvable' ? 'unsolvable' : 'solvable';
    const ofKind = set.filter((p) => p.kind === kind);
    if (ofKind.length === 0)
      throw new ParadigmConfigError(PARADIGM, `no ${kind} problems in the set`);
    const problem = ofKind[used[kind] % ofKind.length] as TowerProblem;
    used = { ...used, [kind]: used[kind] + 1 };
    const cap = kind === 'unsolvable' ? timing.unsolvable_cap_ms : timing.solvable_cap_ms;
    if (cap === undefined) throw new ParadigmConfigError(PARADIGM, `${kind}_cap_ms missing`);
    return {
      stimulus_id: problem.id,
      vocabulary: ['skip'],
      voice_vocabulary: [],
      response_window_ms: cap,
      params: towerTrialParams(problem, { skipIconMs, capMs: cap }),
    };
  };
}

/** A uniformly random legal move (exploring headless bots). */
export function randomLegalMove(
  state: TowerState,
  capacities: readonly number[],
  rng: SeededRng,
): TowerMove {
  const moves = legalMoves(state, capacities);
  if (moves.length === 0) throw new ParadigmStateError(PARADIGM, 'no legal move');
  return rng.pick(moves);
}

export const TOWER_INDICATORS: readonly IndicatorBinding[] = [
  {
    moduleId: 'tower',
    indicators: [
      'problem_solving.excess_moves',
      'problem_solving.planning_time',
      'problem_solving.recovery_after_failure',
      'initiative.planning_time_before_first_move',
      'persistence.time_on_unsolvable',
      'persistence.give_up',
      'task_organisation.illegal_move_attempts',
    ],
  },
];
