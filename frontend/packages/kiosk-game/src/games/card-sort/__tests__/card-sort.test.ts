import { checkSessionSequence } from '@shriii/contracts';
import { describe, expect, it } from 'vitest';
import { classifySort, type Dimension, type Pile } from '../../../paradigms/card-sort.ts';
import { runHeadless } from '../../dont-tap/kit/testing/headless.ts';
import { createCardSort } from '../CardSortModule.ts';

const run = (seed: number, level: 'L1' | 'L2' | 'L3' = 'L2', formId?: string) =>
  runHeadless({
    moduleId: 'card_sort',
    factory: () => createCardSort(),
    seed,
    level,
    ...(formId ? { formId } : {}),
  });

describe('Card Sort (MG-03) headless bot playthrough', () => {
  it('completes with valid events, an unannounced switch and a reversal', async () => {
    const r = await run(123);
    expect(r.result.endedReason).toBe('completed');
    expect(r.invalidEvents).toBe(0);
    expect(checkSessionSequence(r.events)).toEqual([]);
    const shifts = r.events.filter((e) => e.event_type === 'context_shift');
    expect(shifts.map((e) => (e.payload as { kind: string }).kind)).toEqual([
      'rule_switch',
      'rule_reversal',
    ]);
    expect(shifts.every((e) => (e.payload as { announced: boolean }).announced === false)).toBe(
      true,
    );
    const first = (shifts[0]?.payload as { shift_index: number } | undefined)?.shift_index;
    expect(first).toBeGreaterThanOrEqual(9);
    expect(first).toBeLessThanOrEqual(15);
    const starts = r.events.filter((e) => e.event_type === 'trial_start');
    const sorts = starts.filter((e) => (e.payload as { trial_type: string }).trial_type === 'sort');
    // >= 10 post-switch trials per switch.
    for (const block of ['switch_1', 'reversal']) {
      expect(sorts.filter((e) => e.task?.block_id === block).length).toBeGreaterThanOrEqual(10);
    }
    // Responses are pile codes; params carry rule/previous_rule/matches consistent with correctness.
    const responses = r.events.filter((e) => e.event_type === 'response');
    for (const res of responses) {
      const id = res.task?.trial_id as string;
      const p = r.trialParams[id] as {
        rule?: Dimension;
        previous_rule?: Dimension | null;
        matches?: Record<Dimension, Pile>;
      };
      if (!p.rule || !p.matches) continue;
      const v = (res.payload as { response_value: Pile | null }).response_value;
      const c = classifySort({
        rule: p.rule,
        previousRule: p.previous_rule ?? null,
        matches: p.matches,
        response: v,
      });
      expect((res.payload as { correctness: boolean | null }).correctness).toBe(c.correct);
      if (p.previous_rule) expect(p.matches[p.rule]).not.toBe(p.matches[p.previous_rule]);
    }
    expect(r.durationMs).toBeGreaterThan(60_000);
    expect(r.durationMs).toBeLessThan(100_000);
  }, 60_000);

  it('uses different rule pairs per form and keeps the shift window at every level', async () => {
    const a = await run(5, 'L1', 'form_1');
    const b = await run(5, 'L3', 'form_2');
    const ruleOf = (x: typeof a) =>
      Object.values(x.trialParams)
        .map((p) => (p as { rule?: string }).rule)
        .filter(Boolean);
    expect(new Set(ruleOf(a))).not.toEqual(new Set(['x']));
    const pairA = [...new Set(ruleOf(a))].join(',');
    const pairB = [...new Set(ruleOf(b))].join(',');
    expect(pairA).not.toBe(pairB);
    for (const x of [a, b]) {
      expect(x.result.endedReason).toBe('completed');
      const idx = (
        x.events.find((e) => e.event_type === 'context_shift')?.payload as
          | { shift_index: number }
          | undefined
      )?.shift_index;
      expect(idx).toBeGreaterThanOrEqual(9);
      expect(idx).toBeLessThanOrEqual(15);
    }
  }, 120_000);
});
