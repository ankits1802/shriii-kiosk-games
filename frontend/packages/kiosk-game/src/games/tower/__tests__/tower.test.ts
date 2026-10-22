import { checkSessionSequence } from '@shriii/contracts';
import { describe, expect, it } from 'vitest';
import { solve, type TowerState } from '../../../paradigms/tower.ts';
import { runHeadless } from '../../dont-tap/kit/testing/headless.ts';
import { createTower } from '../TowerModule.ts';

const run = (seed: number, level: 'L1' | 'L2' | 'L3' = 'L2', formId?: string) =>
  runHeadless({
    moduleId: 'tower',
    factory: () => createTower(),
    seed,
    level,
    ...(formId ? { formId } : {}),
  });

describe('Tower (MG-04) headless bot playthrough', () => {
  it('runs 4 proven solvable and 2 proven unsolvable items with move events', async () => {
    const r = await run(123);
    expect(r.result.endedReason).toBe('completed');
    expect(r.invalidEvents).toBe(0);
    expect(checkSessionSequence(r.events)).toEqual([]);
    const starts = r.events.filter(
      (e) => e.event_type === 'trial_start' && e.task?.block_id === 'problems',
    );
    const kinds = starts.map((e) => (e.payload as { trial_type: string }).trial_type);
    expect(kinds.filter((k) => k === 'solvable')).toHaveLength(4);
    expect(kinds.filter((k) => k === 'unsolvable')).toHaveLength(2);
    for (const e of starts) {
      const p = r.trialParams[e.task?.trial_id as string] as {
        capacities: number[];
        start: TowerState;
        goal: TowerState;
        min_moves?: number;
        skip_icon_ms: number;
        cap_ms: number;
      };
      const s = solve(p.start, p.goal, p.capacities);
      if ((e.payload as { trial_type: string }).trial_type === 'solvable') {
        expect(s.solvable && s.minMoves).toBe(p.min_moves);
        expect(p.min_moves).toBeGreaterThanOrEqual(2);
        expect(p.min_moves).toBeLessThanOrEqual(5);
      } else {
        expect(s.solvable).toBe(false);
      }
      expect(p.skip_icon_ms).toBe(15000);
    }
    const moves = r.events.filter((e) => e.event_type === 'move');
    expect(moves.length).toBeGreaterThan(10);
    for (const m of moves) {
      const p = m.payload as {
        from_slot: string;
        to_slot: string;
        legal: boolean;
        move_index: number;
      };
      expect(p.from_slot).toMatch(/^basket_[123]$/);
      expect(p.to_slot).toMatch(/^basket_[123]$/);
      expect(typeof p.legal).toBe('boolean');
    }
    const skips = r.events.filter(
      (e) =>
        e.event_type === 'response' &&
        (e.payload as { response_value: string }).response_value === 'skip',
    );
    expect(skips.every((e) => (e.payload as { latency_ms: number }).latency_ms >= 15000)).toBe(
      true,
    );
    expect(r.durationMs).toBeGreaterThan(60_000);
    expect(r.durationMs).toBeLessThan(100_000);
  }, 60_000);

  it('uses a different unsolvable identity per form', async () => {
    const a = await run(9, 'L2', 'form_1');
    const b = await run(9, 'L2', 'form_2');
    const unsolvable = (x: typeof a) =>
      Object.values(x.trialParams)
        .filter((p) => String((p as { problem_id?: string }).problem_id).includes('.u'))
        .map((p) =>
          JSON.stringify([(p as { start: unknown }).start, (p as { goal: unknown }).goal]),
        );
    expect(unsolvable(a)).not.toEqual(unsolvable(b));
  }, 120_000);
});
