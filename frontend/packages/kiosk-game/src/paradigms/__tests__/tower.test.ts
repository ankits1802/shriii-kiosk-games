import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { loadGameContent } from '../../engine/content.ts';
import { ParadigmStateError } from '../common.ts';
import {
  allStates,
  applyMove,
  buildTowerProblemSet,
  checkMove,
  isValidState,
  legalMoves,
  optimalMoves,
  practiceProblem,
  SOLVABLE_CAPACITIES,
  solve,
  stateKey,
  type TowerState,
  TowerTrial,
  towerProblemSetOptions,
  UNSOLVABLE_CAPACITIES,
  verifyProblem,
} from '../tower.ts';

const content = loadGameContent();
const tower = content.get('tower');

/** Independent brute force: iterative-deepening DFS over move sequences (no visited set across depths). */
function bruteForceMinMoves(
  start: TowerState,
  goal: TowerState,
  caps: readonly number[],
  maxDepth: number,
): number | null {
  const g = stateKey(goal);
  const dfs = (s: TowerState, depth: number): boolean => {
    if (stateKey(s) === g) return true;
    if (depth === 0) return false;
    for (const m of legalMoves(s, caps)) if (dfs(applyMove(s, caps, m), depth - 1)) return true;
    return false;
  };
  for (let d = 0; d <= maxDepth; d += 1) if (dfs(start, d)) return d;
  return null;
}

describe('state model and rules', () => {
  it('enumerates the classic 36 states and 18 one-free-slot states', () => {
    expect(allStates(SOLVABLE_CAPACITIES)).toHaveLength(36);
    for (const caps of UNSOLVABLE_CAPACITIES) expect(allStates(caps)).toHaveLength(18);
    for (const s of allStates(SOLVABLE_CAPACITIES))
      expect(isValidState(s, SOLVABLE_CAPACITIES)).toBe(true);
  });

  it.each([
    [{ from: 0, to: 0 }, 'same_basket'],
    [{ from: 2, to: 0 }, 'empty_source'],
    [{ from: 0, to: 1 }, 'destination_full'],
    [{ from: 5, to: 1 }, 'invalid_basket'],
  ] as const)('move %o is illegal: %s', (move, reason) => {
    const s: TowerState = [['pot_red'], ['pot_green', 'pot_blue'], []];
    const c = checkMove(s, SOLVABLE_CAPACITIES, move);
    expect(c.legal).toBe(false);
    if (!c.legal) expect(c.reason).toBe(reason);
  });

  it('only the top pot moves', () => {
    const s: TowerState = [['pot_red', 'pot_green'], ['pot_blue'], []];
    expect(applyMove(s, SOLVABLE_CAPACITIES, { from: 0, to: 2 })).toEqual([
      ['pot_red'],
      ['pot_blue'],
      ['pot_green'],
    ]);
  });
});

describe('BFS solver', () => {
  const states36 = allStates(SOLVABLE_CAPACITIES);
  it('is optimal against brute-force iterative deepening (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 35 }), fc.integer({ min: 0, max: 35 }), (a, b) => {
        const s = states36[a] as TowerState;
        const g = states36[b] as TowerState;
        const r = solve(s, g, SOLVABLE_CAPACITIES);
        expect(r.solvable).toBe(true);
        if (r.solvable) {
          expect(bruteForceMinMoves(s, g, SOLVABLE_CAPACITIES, 8)).toBe(r.minMoves);
          // The returned path replays to the goal.
          let cur = s;
          for (const m of r.path) cur = applyMove(cur, SOLVABLE_CAPACITIES, m);
          expect(stateKey(cur)).toBe(stateKey(g));
        }
      }),
      { numRuns: 200 },
    );
  });

  it('proves unsolvability by exhausting the reachable component (one free slot)', () => {
    const states = allStates([2, 1, 1]);
    let unsolvable = 0;
    for (const s of states) {
      for (const g of states) {
        const r = solve(s, g, [2, 1, 1]);
        if (!r.solvable) {
          unsolvable += 1;
          expect(r.explored).toBe(6); // component size
          expect(bruteForceMinMoves(s, g, [2, 1, 1], 7)).toBeNull();
        }
      }
    }
    expect(unsolvable).toBe(18 * 12);
  });
});

describe('problem sets', () => {
  it('builds verified sets from the config for both forms, with distinct unsolvable identities', () => {
    const sets = ['form_1', 'form_2'].map((f) =>
      buildTowerProblemSet(towerProblemSetOptions(tower, f)),
    );
    for (const set of sets) {
      expect(set.filter((p) => p.kind === 'solvable').map((p) => p.minMoves)).toEqual([2, 3, 4, 5]);
      expect(set.filter((p) => p.kind === 'unsolvable')).toHaveLength(2);
      expect(set[0]?.kind).toBe('solvable');
      for (let i = 1; i < set.length; i += 1) {
        if (set[i]?.kind === 'unsolvable') expect(set[i - 1]?.kind).toBe('solvable');
      }
      for (const p of set) expect(verifyProblem(p).ok).toBe(true);
    }
    const ident = (s: (typeof sets)[number]) =>
      s
        .filter((p) => p.kind === 'unsolvable')
        .map((p) => `${p.capacities.join('')}:${stateKey(p.start)}>${stateKey(p.goal)}`);
    expect(ident(sets[0] ?? [])).not.toEqual(ident(sets[1] ?? []));
    expect(buildTowerProblemSet(towerProblemSetOptions(tower, 'form_1'))).toEqual(sets[0]);
    expect(verifyProblem(practiceProblem(tower.config_id, 'form_1')).ok).toBe(true);
  });

  it('verifyProblem rejects a mislabelled problem', () => {
    const p = practiceProblem(tower.config_id, 'form_1');
    expect(verifyProblem({ ...p, minMoves: 3 }).ok).toBe(false);
    expect(verifyProblem({ ...p, kind: 'unsolvable', minMoves: null }).ok).toBe(false);
  });
});

describe('TowerTrial classification', () => {
  it('optimal play: zero excess moves, planning time from onset to first attempt', () => {
    const set = buildTowerProblemSet(towerProblemSetOptions(tower, 'form_1'));
    for (const p of set.filter((x) => x.kind === 'solvable')) {
      const t = new TowerTrial(p, 1000);
      let ms = 3500;
      for (const m of optimalMoves(p)) {
        t.attempt(m, ms);
        ms += 1000;
      }
      const s = t.summary();
      expect(s.solved).toBe(true);
      expect(s.excessMoves).toBe(0);
      expect(s.planningTimeMs).toBe(2500);
      expect(s.illegalAttempts).toBe(0);
    }
  });

  it('records illegal attempts with move indices, and skip on unsolvable items', () => {
    const set = buildTowerProblemSet(towerProblemSetOptions(tower, 'form_1'));
    const u = set.find((p) => p.kind === 'unsolvable');
    if (!u) throw new Error('no unsolvable item');
    const t = new TowerTrial(u, 0);
    const legal = legalMoves(t.state, u.capacities)[0];
    if (!legal) throw new Error('no legal move');
    const r1 = t.attempt({ from: legal.from, to: legal.from }, 1200); // same basket
    const r2 = t.attempt(legal, 2000);
    expect(r1.legal).toBe(false);
    expect(r1.rejection).toBe('same_basket');
    expect(t.movePayload(r1)).toMatchObject({ legal: false, move_index: 0, problem_id: u.id });
    expect(t.movePayload(r2)).toMatchObject({ legal: true, move_index: 1 });
    expect(t.skipIconVisible(14_999, 15_000)).toBe(false);
    expect(t.skipIconVisible(15_000, 15_000)).toBe(true);
    t.skip(16_000);
    const s = t.summary();
    expect(s).toMatchObject({
      skipped: true,
      solved: false,
      legalMoves: 1,
      illegalAttempts: 1,
      excessMoves: null,
      timeOnItemMs: 16_000,
      planningTimeMs: 1200,
    });
    expect(() => t.attempt(legal, 17_000)).toThrow(ParadigmStateError);
  });
});
