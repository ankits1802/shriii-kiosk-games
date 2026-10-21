import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  validateCriterionResponseRecord,
  validateCriterionScaleScoreRecord,
} from '@shriii/contracts';
import { describe, expect, it } from 'vitest';
import { buildRecords, SCALES, SESSION_ITEM, SUBMITTED_MEASURES } from '../src/sync/records.ts';
import { completedSession, memoryStore, PID } from './helpers.ts';

const registry = readFileSync(
  fileURLToPath(
    new URL('../../../../content/instruments/card-sort-criterion.yaml', import.meta.url),
  ),
  'utf8',
);
const openapi = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../backend/api/openapi.json', import.meta.url)),
    'utf8',
  ),
) as {
  components: {
    schemas: Record<string, { required?: string[]; properties: Record<string, unknown> }>;
  };
};

describe('contract records', () => {
  it('submitted measures are exactly the registry measures of the session item', () => {
    const block = registry.split('measures:\n')[1]?.split('\nsubscales:')[0] ?? '';
    const measures = [...block.matchAll(/^\s*-\s*(\w+)\s*$/gm)].map((m) => m[1]);
    expect(measures).toEqual([...SUBMITTED_MEASURES]);
    expect(registry).toContain(`item_id: ${SESSION_ITEM}`);
    expect(registry).toContain('instrument_id: card_sort_criterion');
    expect(registry).toContain('public_kiosk_allowed: false');
  });

  it('builds valid CriterionResponse and CriterionScaleScore records', async () => {
    const store = await memoryStore();
    const session = await completedSession(store);
    const built = buildRecords(session, '2026-10-22T10:00:00.000Z');
    expect(built.criterion_responses).toHaveLength(SUBMITTED_MEASURES.length);
    for (const rec of built.criterion_responses)
      expect(validateCriterionResponseRecord(rec).ok).toBe(true);
    expect(built.criterion_scale_scores.map((s) => s.scale_id)).toEqual([...SCALES]);
    for (const rec of built.criterion_scale_scores)
      expect(validateCriterionScaleScoreRecord(rec).ok).toBe(true);

    const byItem = Object.fromEntries(
      built.criterion_responses.map((r) => [r.item_id, r.raw_response]),
    );
    expect(byItem).toEqual({
      'card_sort_criterion.session.perseverative_errors': 0,
      'card_sort_criterion.session.categories_completed': 6,
      'card_sort_criterion.session.trials_administered': 60,
    });
    const first = built.criterion_responses[0];
    expect(first?.pid).toBe(PID);
    expect(first?.language_version).toBe('hi-in');
    expect(first?.block).toBe('performance');
    expect(first?.source).toBe('in_app');
    expect(first?.administration_mode).toBe('read_aloud');
  });

  it('AdministrationIn has every field the API requires and nothing it does not define', async () => {
    const store = await memoryStore();
    const session = await completedSession(store, 'colour');
    const { administration } = buildRecords(session, '2026-10-22T10:00:00.000Z');
    const schema = openapi.components.schemas.AdministrationIn;
    const itemSchema = openapi.components.schemas.ItemResponseIn;
    if (!schema || !itemSchema) throw new Error('openapi schema missing');
    for (const key of schema.required ?? []) expect(administration).toHaveProperty(key);
    for (const key of Object.keys(administration)) expect(schema.properties).toHaveProperty(key);
    for (const r of administration.responses)
      for (const key of Object.keys(r)) expect(itemSchema.properties).toHaveProperty(key);
    expect(administration.site_mode).toBe('supervised');
    expect(administration.language).toMatch(/^[a-z]{2,3}-[A-Z]{2}$/);
    expect(
      administration.responses.find((r) => r.item_id.endsWith('categories_completed'))
        ?.raw_response,
    ).toBe(1);
  });

  it('refuses to build records for an unfinished session', async () => {
    const store = await memoryStore();
    const session = await completedSession(store);
    expect(() =>
      buildRecords({ ...session, status: 'aborted' }, '2026-10-22T10:00:00.000Z'),
    ).toThrow();
  });
});
