/**
 * Bot batch export for the scoring verification (opt-in): runs SET2_EXPORT_SESSIONS synthetic
 * sessions (default 32), each playing the four set-2 modules headlessly with a seeded bot, and writes
 * `events.ndjson` + `trial_params.json` into SET2_EXPORT_DIR for
 * `src/games/hub/dev/score_events.py` (the Python indicator engine).
 *
 *   SET2_EXPORT_DIR=<dir> npx vitest run src/games/hub/__tests__/export-batch.test.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectValidModuleStream } from './conventions.ts';
import { runHeadless } from './headless.ts';

const dir = process.env.SET2_EXPORT_DIR;
const sessions = Number(process.env.SET2_EXPORT_SESSIONS ?? 32);

describe.skipIf(!dir)('set-2 bot batch export (scoring verification)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it(
    `exports ${sessions} bot sessions`,
    async () => {
      const out = dir as string;
      mkdirSync(out, { recursive: true });
      const lines: string[] = [];
      const params: Record<string, Record<string, Record<string, unknown>>> = {};
      for (let i = 0; i < sessions; i++) {
        const seed = (0x5e70000 + i).toString(16).padStart(16, '0');
        const run = await runHeadless({
          modules: ['share_pot', 'steady_hands', 'four_stalls', 'private_dice'],
          seed,
        });
        expect(run.invalidEvents).toBe(0);
        expect(
          run.results.map((r) => `${r.moduleId}:${r.endedReason}`),
          `seed ${seed}`,
        ).toEqual([
          'share_pot:completed',
          'steady_hands:completed',
          'four_stalls:completed',
          'private_dice:completed',
        ]);
        for (const m of ['share_pot', 'steady_hands', 'four_stalls', 'private_dice'])
          expectValidModuleStream(run.events, run.params, m);
        for (const e of run.events) lines.push(JSON.stringify(e));
        params[run.sessionId] = run.params;
      }
      writeFileSync(join(out, 'events.ndjson'), `${lines.join('\n')}\n`);
      writeFileSync(join(out, 'trial_params.json'), JSON.stringify(params));
    },
    30 * 60_000,
  );
});
