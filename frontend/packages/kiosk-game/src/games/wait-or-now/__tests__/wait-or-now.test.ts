import { checkSessionSequence } from '@shriii/contracts';
import { describe, expect, it } from 'vitest';
import { staticLayout } from '../../../art/layout.ts';
import { CSS_PX_PER_MM } from '../../../input/metrics.ts';
import { MEDIAN_PERSONA } from '../../dont-tap/kit/bot.ts';
import { runHeadless } from '../../dont-tap/kit/testing/headless.ts';
import { waitOrNowGeometry } from '../geometry.ts';
import { createWaitOrNow } from '../WaitOrNowModule.ts';

const run = (seed: number, level: 'L1' | 'L2' | 'L3' = 'L2') =>
  runHeadless({ moduleId: 'wait_or_now', factory: () => createWaitOrNow(), seed, level });

type Params = Record<string, number | string | boolean>;

describe('Wait-or-Now (MG-07) headless bot playthrough', () => {
  it('runs practice, 8 delay and 4 effort choices with the scoring conventions', async () => {
    const r = await run(123);
    expect(r.result.endedReason).toBe('completed');
    expect(r.invalidEvents).toBe(0);
    expect(checkSessionSequence(r.events)).toEqual([]);
    const starts = r.events.filter((e) => e.event_type === 'trial_start');
    const byBlock = (b: string) => starts.filter((e) => e.task?.block_id === b);
    expect(byBlock('practice')).toHaveLength(1);
    expect(byBlock('delay')).toHaveLength(8);
    expect(byBlock('effort')).toHaveLength(4);
    expect(byBlock('probe')).toHaveLength(4);
    // Practice before scored trials; practice never scorable.
    const firstScored = starts.findIndex((e) => e.timing.scorable);
    expect(starts.findIndex((e) => e.task?.block_id === 'practice')).toBeLessThan(firstScored);
    expect(byBlock('practice').every((e) => !e.timing.scorable)).toBe(true);
    // Trial types and params per scoring conventions.
    for (const e of byBlock('delay')) {
      expect((e.payload as { trial_type: string }).trial_type).toBe('delay_choice');
      const p = r.trialParams[e.task?.trial_id as string] as Params;
      for (const k of ['ss_amount', 'ss_delay', 'll_amount', 'll_delay'])
        expect(typeof p[k]).toBe('number');
      expect(p.ss_amount as number).toBeGreaterThan(0);
      expect(p.ss_amount as number).toBeLessThan(p.ll_amount as number);
    }
    for (const e of byBlock('effort')) {
      expect((e.payload as { trial_type: string }).trial_type).toBe('effort_choice');
      const p = r.trialParams[e.task?.trial_id as string] as Params;
      for (const k of ['easy_amount', 'easy_effort', 'hard_amount', 'hard_effort'])
        expect(typeof p[k]).toBe('number');
    }
    // Every delay track is visited twice (4 delays x 2 passes).
    const delays = byBlock('delay').map(
      (e) => (r.trialParams[String(e.task?.trial_id)] as Params).ll_delay,
    );
    expect([...new Set(delays)].sort()).toEqual([1, 2, 4, 8]);
    // Responses: closed vocabularies only.
    const resp = r.events.filter((e) => e.event_type === 'response');
    for (const e of resp) {
      const v = (e.payload as { response_value: string | null }).response_value;
      const b = e.task?.block_id;
      if (v === null) continue;
      if (b === 'delay' || b === 'practice') expect(['now', 'wait']).toContain(v);
      if (b === 'effort') expect(['easy', 'hard']).toContain(v);
    }
    // Each hard choice is followed by a hold logged on the same trial.
    const hardTrials = resp
      .filter((e) => (e.payload as { response_value: string }).response_value === 'hard')
      .map((e) => e.task?.trial_id);
    const holds = r.events.filter((e) => e.event_type === 'input.hold');
    for (const id of hardTrials) expect(holds.some((h) => h.task?.trial_id === id)).toBe(true);
    for (const h of holds) {
      const p = h.payload as { required_hold_ms: number; completed: boolean; hold_ms: number };
      expect(p.required_hold_ms).toBe(2500);
      expect(p.completed).toBe(p.hold_ms >= p.required_hold_ms);
    }
    expect(r.durationMs).toBeGreaterThan(55_000);
    expect(r.durationMs).toBeLessThan(r.result.durationMs + 1000);
    expect(r.durationMs).toBeLessThan(85_000);
  }, 120_000);

  it('logs an explicit non-start when the churn is chosen but never pressed', async () => {
    const r = await runHeadless({
      moduleId: 'wait_or_now',
      factory: () =>
        createWaitOrNow({ persona: { ...MEDIAN_PERSONA, patience: 0.95, effortNonStart: 1 } }),
      seed: 77,
      level: 'L2',
    });
    expect(r.result.endedReason).toBe('completed');
    expect(r.invalidEvents).toBe(0);
    const hard = r.events
      .filter(
        (e) =>
          e.event_type === 'response' &&
          (e.payload as { response_value: string | null }).response_value === 'hard',
      )
      .map((e) => e.task?.trial_id);
    expect(hard.length).toBeGreaterThan(0);
    for (const id of hard) {
      const holds = r.events.filter(
        (e) => e.event_type === 'input.hold' && e.task?.trial_id === id,
      );
      expect(holds).toHaveLength(1);
      expect(holds[0]?.payload).toMatchObject({ hold_ms: 0, completed: false });
      // The non-start lands inside the trial (before its trial_end).
      const end = r.events.findIndex(
        (e) => e.event_type === 'trial_end' && e.task?.trial_id === id,
      );
      expect(r.events.indexOf(holds[0] as (typeof r.events)[number])).toBeLessThan(end);
    }
  }, 120_000);

  it('titrates: the next offer on a track moves toward the choice made', async () => {
    const r = await run(9);
    const resp = new Map(
      r.events
        .filter((e) => e.event_type === 'response')
        .map((e) => [
          e.task?.trial_id,
          (e.payload as { response_value: string | null }).response_value,
        ]),
    );
    const trials = Object.entries(r.trialParams)
      .filter(([id]) => id.startsWith('wait_or_now.delay.'))
      .map(([id, p]) => ({
        id,
        d: (p as Params).ll_delay as number,
        ss: (p as Params).ss_amount as number,
      }));
    for (const d of [1, 2, 4, 8]) {
      const [a, b] = trials.filter((t) => t.d === d);
      if (!a || !b) throw new Error('track missing');
      const c = resp.get(a.id);
      if (c === 'wait') expect(b.ss).toBeGreaterThan(a.ss);
      if (c === 'now') expect(b.ss).toBeLessThan(a.ss);
      if (c === null) expect(b.ss).toBe(a.ss);
    }
  }, 120_000);

  it('lays out targets of at least 20 mm, apart, on screen in both orientations', () => {
    for (const [w, h] of [
      [1920, 1080],
      [1080, 1920],
    ] as const) {
      const L = staticLayout(w, h, CSS_PX_PER_MM);
      const g = waitOrNowGeometry(L);
      const rects = [g.left, g.right, g.churn];
      for (const r of rects) {
        expect(Math.min(r.width, r.height)).toBeGreaterThanOrEqual(L.metrics.minTargetPx);
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.x + r.width).toBeLessThanOrEqual(w);
        expect(r.y + r.height).toBeLessThanOrEqual(h);
      }
      const gap = (a: (typeof rects)[number], b: (typeof rects)[number]) =>
        Math.max(
          b.x - (a.x + a.width),
          a.x - (b.x + b.width),
          b.y - (a.y + a.height),
          a.y - (b.y + b.height),
        );
      expect(gap(g.left, g.right)).toBeGreaterThanOrEqual(8 * CSS_PX_PER_MM);
      expect(gap(g.left, g.churn)).toBeGreaterThanOrEqual(8 * CSS_PX_PER_MM);
      expect(gap(g.right, g.churn)).toBeGreaterThanOrEqual(8 * CSS_PX_PER_MM);
    }
  });
});
