import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkSessionSequence, type EventEnvelope, validateEvent } from '@shriii/contracts';
import { describe, expect, it } from 'vitest';
import { MEDIAN_ROAD_BOT } from '../bot.ts';
import { VIEW_BEATS } from '../view/beats.ts';
import { runHeadless } from './headless-run.ts';

function byType(events: readonly EventEnvelope[], type: string): EventEnvelope[] {
  return events.filter((e) => e.event_type === type);
}

function payload(e: EventEnvelope): Record<string, unknown> {
  return e.payload as unknown as Record<string, unknown>;
}

function trialTypes(events: readonly EventEnvelope[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of byType(events, 'trial_start')) {
    m.set(String(e.task?.trial_id), String(payload(e).trial_type));
  }
  return m;
}

describe('Road Home headless bot run (ENG-05, EPI-03)', () => {
  it('completes with a valid, gapless event stream that follows the scoring conventions', async () => {
    const run = await runHeadless({ beats: VIEW_BEATS });
    const { events, result, plan } = run;
    expect(result.endedReason).toBe('completed');
    expect(byType(events, 'invalid')).toHaveLength(0);
    for (const e of events) expect(validateEvent(e).ok, e.event_type).toBe(true);
    expect(checkSessionSequence(events)).toEqual([]);

    // Every planned trial ran, in order, with the scorer's trial types.
    const starts = byType(events, 'trial_start');
    expect(starts.map((e) => e.task?.trial_id)).toEqual(plan.trials.map((t) => t.spec.trial_id));
    const types = [...trialTypes(events).values()];
    const count = (t: string) => types.filter((x) => x === t).length;
    expect(count('errand_map')).toBe(3);
    expect(count('optional_opportunity')).toBe(5);
    expect(count('blocked_route')).toBe(2);
    expect(count('fork_choice')).toBe(1 + 10 + 12);
    expect(count('fuel_round')).toBe(6);
    expect(count('effort_hold')).toBe(4);
    expect(count('probe')).toBe(4);
    expect(byType(events, 'trial_end')).toHaveLength(plan.trials.length);

    // The unannounced reversal: one context_shift right before the first reversed fork.
    const shifts = byType(events, 'context_shift');
    expect(shifts).toHaveLength(1);
    const shift = shifts[0] as EventEnvelope;
    expect(payload(shift)).toMatchObject({
      kind: 'rule_reversal',
      announced: false,
      shift_index: plan.shiftIndex,
    });
    const next = events[events.indexOf(shift) + 1] as EventEnvelope;
    expect(next.event_type).toBe('trial_start');
    expect(next.task?.trial_index).toBe(plan.shiftIndex);
    expect(result.contextShiftIndex).toBe(plan.shiftIndex);

    // Route steps belong to map trials; fodder rounds carry contribution + partner_action.
    const tt = trialTypes(events);
    for (const e of byType(events, 'route_step')) {
      expect(['errand_map', 'blocked_route', 'fork_choice']).toContain(
        tt.get(String(e.task?.trial_id)),
      );
    }
    expect(byType(events, 'contribution')).toHaveLength(6);
    expect(byType(events, 'partner_action')).toHaveLength(6);
    expect(byType(events, 'partner_action').some((e) => payload(e).is_error === true)).toBe(true);
    expect(byType(events, 'input.hold').length).toBeGreaterThanOrEqual(4);
    // Blocked attempts happened and the flood ended with the fallback (rest) response.
    expect(byType(events, 'route_step').some((e) => payload(e).blocked === true)).toBe(true);
    expect(byType(events, 'response').some((e) => payload(e).response_value === 'fallback')).toBe(
      true,
    );
    // Practice is never scorable; everything after it is.
    for (const e of events.filter((x) => x.task?.block_id === 'practice')) {
      expect(e.timing.scorable).toBe(false);
    }
    // Nothing of the module follows its module_end.
    const end = events.findIndex((e) => e.event_type === 'module_end');
    expect(events.slice(end + 1).every((e) => e.task === null || e.task.trial_id === null)).toBe(
      true,
    );

    // Pacing: a median player finishes inside the soft cap at the view's nominal beats.
    expect(result.wrappedUp ?? false).toBe(false);
    expect(result.durationMs).toBeLessThan(194_000);

    const dir = process.env.ROAD_HOME_EXPORT_DIR;
    if (dir) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'events.ndjson'),
        `${events.map((e) => JSON.stringify(e)).join('\n')}\n`,
      );
      writeFileSync(
        join(dir, 'trial_params.json'),
        JSON.stringify({ [run.sessionId]: plan.trialParams }, null, 2),
      );
    }
  }, 60_000);

  it('is deterministic for a seed and differs across seeds', async () => {
    const a = await runHeadless({ seedHex: '00000000000000aa' });
    const b = await runHeadless({ seedHex: '00000000000000aa' });
    const c = await runHeadless({ seedHex: '00000000000000bb' });
    const strip = (r: typeof a) =>
      r.events.map((e) => [e.event_type, e.task?.trial_id ?? null, JSON.stringify(e.payload)]);
    expect(strip(a)).toEqual(strip(b));
    expect(JSON.stringify(c.plan.trialParams)).not.toEqual(JSON.stringify(a.plan.trialParams));
  }, 60_000);

  it('a slower player loses skippable trials first (adaptive pacing + soft-cap wrap-up)', async () => {
    const slow = {
      ...MEDIAN_ROAD_BOT,
      planningMs: 3600,
      stepGapMs: 1150,
      choiceMs: 1350,
      routeOptimality: 0.75,
    };
    const run = await runHeadless({ beats: VIEW_BEATS, bot: slow });
    expect(['completed', 'time_cap']).toContain(run.result.endedReason);
    const ran = new Map<string, number>();
    for (const e of run.events.filter((x) => x.event_type === 'trial_end')) {
      const b = String(e.task?.block_id);
      ran.set(b, (ran.get(b) ?? 0) + 1);
    }
    // Every block before the probes keeps its minimum; only beyond-minimum trials were dropped.
    const mins: Record<string, number> = {
      practice: 1,
      errand_maps: 13,
      blocked_road: 5,
      reversal: 10,
      fuel_pot: 6,
      uphill: 4,
    };
    for (const [b, min] of Object.entries(mins)) expect(ran.get(b) ?? 0, b).toBe(min);
    expect(ran.get('probe') ?? 0).toBeGreaterThanOrEqual(3);
  }, 60_000);

  it('a walkaway aborts cleanly with an interrupted trial_end', async () => {
    const run = await runHeadless({ abortAtMs: 40_000 });
    expect(run.result.endedReason).toBe('walkaway');
    const ends = run.events.filter((e) => e.event_type === 'trial_end');
    const last = ends.at(-1) as EventEnvelope;
    expect(payload(last).outcome).toBe('aborted');
    expect(last.timing.interrupted).toBe(true);
    expect(checkSessionSequence(run.events)).toEqual([]);
  }, 60_000);
});
