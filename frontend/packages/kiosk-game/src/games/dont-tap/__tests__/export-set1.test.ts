/**
 * Bot batch export for the scoring verification (opt-in): runs SET1_EXPORT_SESSIONS synthetic bot
 * players (default 24, seeded personas sampled around the median) through each set-1 module
 * headlessly, validates every stream and writes `<module>.events.ndjson` + `<module>.trial_params.json`
 * into SET1_EXPORT_DIR for `kit/dev/score_set1.py` (the Python indicator engine in stats/scoring).
 *
 *   SET1_EXPORT_DIR=<dir> npx vitest run src/games/dont-tap/__tests__/export-set1.test.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkSessionSequence } from '@shriii/contracts';
import { describe, expect, it } from 'vitest';
import type { GameModule, ModuleId, SeededRng } from '../../../core/contracts.ts';
import { createBalloon } from '../../balloon/BalloonModule.ts';
import { createCardSort } from '../../card-sort/CardSortModule.ts';
import { createTower } from '../../tower/TowerModule.ts';
import { createWaitOrNow } from '../../wait-or-now/WaitOrNowModule.ts';
import { createDontTap } from '../DontTapModule.ts';
import { type BotPersona, samplePersona } from '../kit/bot.ts';
import type { MicroGameOptions } from '../kit/micro-game.ts';
import { type ParamsReporter, runHeadless, toNdjson } from '../kit/testing/headless.ts';

const dir = process.env.SET1_EXPORT_DIR;
const sessions = Number(process.env.SET1_EXPORT_SESSIONS ?? 24);
const only = process.env.SET1_EXPORT_MODULES?.split(',') ?? null;

type Factory = (o: MicroGameOptions) => GameModule & ParamsReporter;

const MODULES: readonly (readonly [ModuleId, Factory])[] = [
  ['dont_tap', (o) => createDontTap(o)],
  ['card_sort', (o) => createCardSort(o)],
  ['balloon', (o) => createBalloon(o)],
  ['tower', (o) => createTower(o)],
  ['wait_or_now', (o) => createWaitOrNow(o)],
];

/** Minimal deterministic stream for persona sampling (mulberry32; only `next` is used). */
function personaRng(seed: number): SeededRng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next } as unknown as SeededRng;
}

describe.skipIf(!dir)('set-1 bot batch export (scoring verification)', () => {
  it(
    `exports ${sessions} bot sessions per module`,
    async () => {
      const out = dir as string;
      mkdirSync(out, { recursive: true });
      for (const [moduleId, factory] of MODULES) {
        if (only && !only.includes(moduleId)) continue;
        const chunks: string[] = [];
        let capped = 0;
        const params: Record<
          string,
          Readonly<Record<string, Readonly<Record<string, unknown>>>>
        > = {};
        for (let i = 0; i < sessions; i += 1) {
          const persona: BotPersona = samplePersona(personaRng(0x5e7100 + i));
          const r = await runHeadless({
            moduleId,
            factory: () => factory({ persona }),
            seed: 0x5e71000 + i * 7919,
          });
          expect(r.invalidEvents, `${moduleId} #${i}`).toBe(0);
          // Very slow players may meet the hard cap (block minimums are never trimmed, ENG-05).
          expect(['completed', 'time_cap'], `${moduleId} #${i}`).toContain(r.result.endedReason);
          if (r.result.endedReason === 'time_cap') capped += 1;
          expect(checkSessionSequence(r.events), `${moduleId} #${i}`).toEqual([]);
          chunks.push(toNdjson(r.events));
          params[r.sessionId] = r.trialParams;
        }
        expect(capped / sessions, `${moduleId}: share of hard-capped sessions`).toBeLessThanOrEqual(
          0.15,
        );
        if (capped > 0)
          console.info(
            `[export-set1] ${moduleId}: ${capped}/${sessions} sessions hit the hard cap`,
          );
        writeFileSync(join(out, `${moduleId}.events.ndjson`), chunks.join(''));
        writeFileSync(join(out, `${moduleId}.trial_params.json`), JSON.stringify(params));
      }
    },
    60 * 60_000,
  );
});
