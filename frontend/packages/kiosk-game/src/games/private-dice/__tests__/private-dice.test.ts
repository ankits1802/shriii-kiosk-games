import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameModuleRegistry } from '../../../engine/registry.ts';
import {
  assertNoTrueOutcome,
  type EntropySource,
  FORBIDDEN_TRUE_OUTCOME_KEYS,
} from '../../../paradigms/private-report.ts';
import { expectValidModuleStream } from '../../hub/__tests__/conventions.ts';
import { content, runHeadless, trialStarts } from '../../hub/__tests__/headless.ts';
import { set2ModuleFactories } from '../../hub/modules.ts';
import { privateDiceGeometry } from '../geometry.ts';
import { PrivateDiceModule } from '../PrivateDiceModule.ts';

const config = content.get('private_dice');

/** Entropy that always yields face `f` and counts how often it was asked. */
function fixedEntropy(f: number): EntropySource & { draws: number } {
  const src = {
    draws: 0,
    fill(out: Uint32Array) {
      src.draws += 1;
      out[0] = f - 1; // (w % 6) + 1 === f, well under the rejection limit
    },
  };
  return src;
}

describe('Private Dice geometry', () => {
  it('lays out six report pictures and the onlooker button in the lower part of the screen', () => {
    const pxPerMm = 96 / 25.4;
    for (const [w, h] of [
      [1920, 1080],
      [1080, 1920],
    ] as const) {
      const g = privateDiceGeometry(
        {
          width: w,
          height: h,
          orientation: w > h ? 'landscape' : 'portrait',
          metrics: { pxPerMm },
        },
        6,
      );
      expect(g.faces).toHaveLength(6);
      for (const r of g.faces) {
        expect(r.width).toBeGreaterThanOrEqual(30 * pxPerMm - 0.5);
        expect(r.y).toBeGreaterThan(h / 3);
      }
      expect(g.onlooker.y).toBeGreaterThan(h / 2);
    }
  });
});

describe('Private Dice headless bot run (MG-06, mode a)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('logs only reported values: the true face never reaches events, params or the module', async () => {
    const entropy = fixedEntropy(3);
    const modules: PrivateDiceModule[] = [];
    const registry = new GameModuleRegistry({
      ...set2ModuleFactories(),
      private_dice: () => {
        const m = new PrivateDiceModule({ entropy });
        modules.push(m);
        return m;
      },
    });
    const run = await runHeadless({
      modules: ['private_dice'],
      seed: '0000000000000401',
      registry,
    });
    expect(run.invalidEvents).toBe(0);
    expect(run.results[0]?.endedReason).toBe('completed');
    expect(run.results[0]?.durationMs).toBeLessThanOrEqual(config.budget.hard_cap_ms);
    const params = modules[0]?.trialParams() ?? {};
    expectValidModuleStream(run.events, params, 'private_dice');
    // 1 practice + 10 scored reports, each drawn once from the (non-seeded) entropy source.
    expect(entropy.draws).toBe(11);
    const reports = run.events.filter((e) => e.event_type === 'report');
    expect(reports).toHaveLength(11);
    const scored = reports.filter((r) => r.timing.scorable);
    expect(scored).toHaveLength(10);
    for (const r of reports) {
      assertNoTrueOutcome(r.payload);
      const p = r.payload as {
        reported_value: number;
        headset: boolean;
        onlooker_reported: boolean;
      };
      expect(Object.keys(r.payload).sort()).toEqual([
        'headset',
        'onlooker_reported',
        'report_context',
        'report_index',
        'reported_value',
      ]);
      // The reported value is the touched picture, never a copy of the drawn face.
      const resp = run.events.find(
        (e) => e.task?.trial_id === r.task?.trial_id && e.event_type === 'response',
      );
      expect((resp?.payload as { response_value: string } | undefined)?.response_value).toBe(
        `face_${p.reported_value}`,
      );
      expect(
        r.task?.block_id === 'private_dice.reports' || r.task?.block_id === 'private_dice.practice',
      ).toBe(true);
    }
    // Private-report trials are flagged and carry no outcome in params or anywhere in the stream.
    for (const s of trialStarts(run.events, 'private_dice').filter(
      (t) => t.task?.block_id !== 'private_dice.probe',
    )) {
      expect((s.payload as { private_report: boolean }).private_report).toBe(true);
    }
    for (const e of run.events) assertNoTrueOutcome(e.payload);
    assertNoTrueOutcome(params);
    // Memory: the module instance holds no field named like a true outcome.
    const fields = Object.keys(modules[0] ?? {});
    for (const k of FORBIDDEN_TRUE_OUTCOME_KEYS) expect(fields).not.toContain(k);
  });

  it('skips private reports in open public mode without a headset (KSK-12)', async () => {
    const run = await runHeadless({
      modules: ['private_dice'],
      seed: '0000000000000402',
      siteMode: 'open_public',
      headset: false,
    });
    expect(run.results[0]?.endedReason).toBe('skipped');
    expect(run.events.filter((e) => e.event_type === 'trial_start')).toHaveLength(0);
    expect(run.events.find((e) => e.event_type === 'module_end')?.payload).toMatchObject({
      ended_reason: 'skipped',
    });
  });

  it('runs in open public mode with a headset and flags it on every report', async () => {
    const run = await runHeadless({
      modules: ['private_dice'],
      seed: '0000000000000403',
      siteMode: 'open_public',
      headset: true,
    });
    expect(run.results[0]?.endedReason).toBe('completed');
    const reports = run.events.filter((e) => e.event_type === 'report');
    expect(reports.length).toBe(11);
    for (const r of reports) expect((r.payload as { headset: boolean }).headset).toBe(true);
  });
});
