import { checkSessionSequence } from '@shriii/contracts';
import { describe, expect, it } from 'vitest';
import { runHeadless } from '../../dont-tap/kit/testing/headless.ts';
import { createBalloon } from '../BalloonModule.ts';

const run = (seed: number, level: 'L1' | 'L2' | 'L3' = 'L2') =>
  runHeadless({ moduleId: 'balloon', factory: () => createBalloon(), seed, level });

describe('Balloon (MG-01) headless bot playthrough', () => {
  it('pumps, collects and pops with the scoring conventions', async () => {
    const r = await run(123);
    expect(r.result.endedReason).toBe('completed');
    expect(r.invalidEvents).toBe(0);
    expect(
      checkSessionSequence(r.events)
        .map((v) => JSON.stringify(v))
        .slice(0, 3),
    ).toEqual([]);
    const balloons = r.events.filter(
      (e) => e.event_type === 'trial_start' && e.task?.block_id === 'balloons',
    );
    expect(balloons.length).toBeGreaterThanOrEqual(15);
    const pumps = r.events.filter((e) => e.event_type === 'pump');
    for (const b of balloons) {
      const id = b.task?.trial_id;
      const p = r.trialParams[id as string] as {
        risk_colour: string;
        explosion_point: number;
        max_pumps: number;
      };
      const own = pumps
        .filter((e) => e.task?.trial_id === id)
        .map((e) => e.payload as { exploded: boolean; collected: boolean });
      const exploded = own.some((x) => x.exploded);
      const collected = own.some((x) => x.collected);
      expect(exploded !== collected).toBe(true); // exactly one ending
      const n = own.filter((x) => !x.collected).length;
      if (exploded) expect(n).toBe(p.explosion_point);
      else expect(n).toBeLessThan(p.explosion_point);
      expect(n).toBeLessThanOrEqual(p.max_pumps);
    }
    // Explosion schedule: stratified per colour (each colour's points cover its range).
    const pts = (c: string) =>
      Object.entries(r.trialParams)
        .filter(
          ([id, p]) =>
            id.startsWith('balloon.balloons.') && (p as { risk_colour?: string }).risk_colour === c,
        )
        .map(([, p]) => (p as { explosion_point: number }).explosion_point)
        .sort((a, b) => a - b);
    const low = pts('low_risk');
    expect(low.length).toBe(8);
    expect(Math.min(...low)).toBeLessThanOrEqual(4);
    expect(Math.max(...low)).toBeGreaterThanOrEqual(28);
    const collects = r.events.filter(
      (e) => e.event_type === 'response' && e.task?.block_id !== 'probe',
    );
    expect(
      collects.every((e) => (e.payload as { response_value: string }).response_value === 'collect'),
    ).toBe(true);
    expect(r.durationMs).toBeGreaterThan(60_000);
    expect(r.durationMs).toBeLessThan(100_000);
  }, 60_000);

  it('explosion schedules reproduce from the seed', async () => {
    const a = await run(77);
    const b = await run(77, 'L3');
    const sched = (x: typeof a) =>
      Object.entries(x.trialParams)
        .filter(([id]) => id.startsWith('balloon.balloons'))
        .map(
          ([, p]) =>
            `${(p as { risk_colour: string }).risk_colour}:${(p as { explosion_point: number }).explosion_point}`,
        );
    expect(sched(a)).toEqual(sched(b));
  }, 120_000);
});
