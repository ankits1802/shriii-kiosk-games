import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { ModuleId } from '../../core/contracts.ts';
import { loadGameContent } from '../../engine/content.ts';
import { PARADIGM_INDICATORS } from '../index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../../../..');

interface DictIndicator {
  readonly id: string;
  readonly group_only: boolean;
  readonly source: { readonly module_id: string };
}

function load(pathway: 'A' | 'B'): Map<string, DictIndicator> {
  const doc = parse(
    readFileSync(
      resolve(root, `stats/measurement-model/dictionary/dictionary.${pathway}.yaml`),
      'utf8',
    ),
  ) as {
    indicators: DictIndicator[];
  };
  return new Map(doc.indicators.map((i) => [i.id, i]));
}

const dictA = load('A');
const dictB = load('B');
const content = loadGameContent();
const A_MODULES = new Set(['stall', 'weighing_post', 'road_home', 'coplay']);

describe('paradigm indicator bindings', () => {
  const rows = Object.entries(PARADIGM_INDICATORS).flatMap(([paradigm, bindings]) =>
    bindings.flatMap((b) => b.indicators.map((id) => ({ paradigm, moduleId: b.moduleId, id }))),
  );

  it.each(rows)(
    '$paradigm -> $moduleId: $id exists in the pathway dictionary with that source module',
    (row) => {
      const dict = A_MODULES.has(row.moduleId) ? dictA : dictB;
      const ind = dict.get(row.id);
      expect(
        ind,
        `${row.id} missing from dictionary.${A_MODULES.has(row.moduleId) ? 'A' : 'B'}.yaml`,
      ).toBeDefined();
      expect(ind?.source.module_id).toBe(row.moduleId);
      // The module config declares it too (ENG-08 declarations).
      expect(content.get(row.moduleId as ModuleId).indicators).toContain(row.id);
    },
  );

  it('private-report indicators are group-only in the dictionary', () => {
    for (const b of PARADIGM_INDICATORS.private_report ?? []) {
      for (const id of b.indicators) {
        const ind = (A_MODULES.has(b.moduleId) ? dictA : dictB).get(id);
        expect(ind?.group_only).toBe(true);
      }
    }
  });
});
