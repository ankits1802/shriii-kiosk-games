import type { EventEnvelope } from '@shriii/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionRng } from '../../../engine/rng.ts';
import { expectValidModuleStream } from '../../hub/__tests__/conventions.ts';
import { content, runHeadless, trialStarts } from '../../hub/__tests__/headless.ts';
import { sharePotGeometry } from '../geometry.ts';
import { buildSharePotPlan, planIsValid } from '../plan.ts';

const config = content.get('share_pot');

describe('Share-the-Pot plan (MG-05)', () => {
  it('places 3 free riders and the error round inside its window, last round cooperative', () => {
    for (let s = 1; s <= 200; s++) {
      const plan = buildSharePotPlan(
        config,
        createSessionRng(s.toString(16).padStart(16, '0')).stream('share_pot').stream('plan'),
      );
      expect(plan.rounds).toHaveLength(8);
      expect(plan.rounds.filter((r) => r.partnerType === 'free_rider')).toHaveLength(3);
      const errs = plan.rounds.filter((r) => r.errorRound);
      expect(errs).toHaveLength(1);
      expect(errs[0]?.round).toBeGreaterThanOrEqual(4);
      expect(errs[0]?.round).toBeLessThanOrEqual(6);
      expect(planIsValid(plan.rounds, true)).toBe(true);
      expect(plan.rounds[0]?.partnerType).toBe('cooperative');
    }
  });

  it('is a pure function of the seed', () => {
    const a = buildSharePotPlan(config, createSessionRng('00000000000000ff').stream('x'));
    const b = buildSharePotPlan(config, createSessionRng('00000000000000ff').stream('x'));
    expect(a).toEqual(b);
  });

  it('lays out >= 24 mm coin targets with >= 8 mm gaps in both orientations', () => {
    for (const [w, h] of [
      [1920, 1080],
      [1080, 1920],
    ] as const) {
      const pxPerMm = 96 / 25.4;
      const g = sharePotGeometry(
        {
          width: w,
          height: h,
          orientation: w > h ? 'landscape' : 'portrait',
          metrics: { pxPerMm },
        },
        10,
      );
      expect(g.slots).toHaveLength(11);
      const rects = [...g.slots, g.confirm];
      for (const r of rects) {
        expect(r.width).toBeGreaterThanOrEqual(20 * pxPerMm);
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.x + r.width).toBeLessThanOrEqual(w);
        expect(r.y + r.height).toBeLessThanOrEqual(h);
      }
      for (let i = 0; i < rects.length; i++)
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i];
          const b = rects[j];
          if (!a || !b) continue;
          const gap = Math.max(
            b.x - (a.x + a.width),
            a.x - (b.x + b.width),
            b.y - (a.y + a.height),
            a.y - (b.y + b.height),
          );
          expect(gap).toBeGreaterThanOrEqual(8 * pxPerMm - 0.5);
        }
    }
  });
});

describe('Share-the-Pot headless bot run', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('completes and emits the contribution / partner / tone / probe stream the scorer reads', async () => {
    const run = await runHeadless({ modules: ['share_pot'], seed: '0000000000000101' });
    expect(run.invalidEvents).toBe(0);
    const [res] = run.results;
    expect(res?.endedReason).toBe('completed');
    expect(res?.durationMs).toBeLessThanOrEqual(config.budget.hard_cap_ms);
    expectValidModuleStream(run.events, run.params, 'share_pot');
    const starts = trialStarts(run.events, 'share_pot');
    const types = starts.map((s) => (s.payload as { trial_type: string }).trial_type);
    expect(types.filter((t) => t === 'round')).toHaveLength(9); // practice + 8
    expect(types.filter((t) => t === 'tone_choice')).toHaveLength(1);
    // Practice first, unscored.
    expect(starts[0]?.condition?.phase).toBe('practice');
    expect(starts[0]?.timing.scorable).toBe(false);
    const mainRounds = starts.filter((s) => s.task?.block_id === 'share_pot.rounds');
    expect(mainRounds).toHaveLength(8);
    const inTrial = (tid: string, type: string): EventEnvelope[] =>
      run.events.filter((e) => e.task?.trial_id === tid && e.event_type === type);
    let freeRiders = 0;
    let errorTid: string | null = null;
    for (const s of mainRounds) {
      const tid = s.task?.trial_id as string;
      const pa = inTrial(tid, 'partner_action');
      expect(pa).toHaveLength(1);
      const p = pa[0]?.payload as { partner_type: string; is_error: boolean };
      if (p.partner_type === 'free_rider') freeRiders += 1;
      if (p.is_error) errorTid = tid;
      const resp = inTrial(tid, 'response')[0]?.payload as {
        input_mode: string;
        revisions: { value: string }[];
      };
      if (resp.input_mode !== 'timeout') {
        expect(inTrial(tid, 'contribution')).toHaveLength(1);
        for (const r of resp.revisions) expect(r.value).toMatch(/^tokens_(10|[0-9])$/);
      }
      expect(s.condition?.partner_type).toBe(p.partner_type);
    }
    expect(freeRiders).toBe(3);
    expect(errorTid).not.toBeNull();
    // The unannounced partner-error shift points at the error round.
    const shift = run.events.find((e) => e.event_type === 'context_shift');
    expect(shift?.payload).toMatchObject({ kind: 'partner_error', announced: false });
    const errIndex = run.events.find((e) => e.task?.trial_id === errorTid)?.task?.trial_index;
    expect((shift?.payload as { shift_index: number } | undefined)?.shift_index).toBe(errIndex);
    // Tone probe after the scripted unfair loss.
    const tone = starts.find(
      (s) => (s.payload as { trial_type: string }).trial_type === 'tone_choice',
    );
    const toneTid = tone?.task?.trial_id as string;
    expect(inTrial(toneTid, 'partner_action')[0]?.payload).toMatchObject({
      action: 'grab',
      partner_type: 'free_rider',
    });
    expect(tone?.task?.block_id).toBe('share_pot.tone_probe');
  });

  it('ends with explicit_exit and closes the open trial as interrupted when aborted', async () => {
    const run = await runHeadless({
      modules: ['share_pot'],
      seed: '0000000000000102',
      abortAtMs: 30_000,
    });
    expect(run.results[0]?.endedReason).toBe('explicit_exit');
    const ends = run.events.filter((e) => e.event_type === 'trial_end');
    const last = ends.at(-1);
    expect(last?.payload).toMatchObject({ outcome: 'aborted' });
    expect(last?.timing.interrupted).toBe(true);
    const moduleEnd = run.events.find((e) => e.event_type === 'module_end');
    expect(moduleEnd?.payload).toMatchObject({ ended_reason: 'explicit_exit' });
  });
});
