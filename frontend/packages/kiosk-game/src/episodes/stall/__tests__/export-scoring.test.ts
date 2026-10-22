/**
 * Exports headless bot sessions of The Stall as NDJSON (raw events) plus the trial params the scorer
 * joins, for `src/episodes/stall/dev/score_events.py` (the Python indicator engine). Runs only when
 * `STALL_EXPORT_DIR` is set:
 *
 *   STALL_EXPORT_DIR=<dir> STALL_EXPORT_SESSIONS=30 npx vitest run src/episodes/stall/__tests__/export-scoring.test.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHeadless } from './helpers.ts';

const dir = process.env.STALL_EXPORT_DIR;
const sessions = Number(process.env.STALL_EXPORT_SESSIONS ?? 30);

describe.skipIf(!dir)('stall scoring export', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it(`exports ${sessions} bot sessions`, async () => {
    const out = dir as string;
    mkdirSync(out, { recursive: true });
    const lines: string[] = [];
    const params: Record<string, Record<string, Readonly<Record<string, unknown>>>> = {};
    for (let i = 0; i < sessions; i++) {
      const form = i % 2 === 0 ? 'form_1' : 'form_2';
      const run = await runHeadless(
        `?module=stall&level=L2&lang=en-IN&seed=${1000 + i * 7919}&form=${form}&bot=1`,
      );
      expect(run.result.endedReason).toBe('completed');
      expect(run.events.filter((e) => e.event_type === 'invalid')).toEqual([]);
      for (const e of run.events) lines.push(JSON.stringify(e));
      params[run.sessionId] = run.trialParams;
    }
    writeFileSync(join(out, 'stall_events.ndjson'), `${lines.join('\n')}\n`);
    writeFileSync(join(out, 'stall_trial_params.json'), JSON.stringify(params));
  }, 600_000);
});
