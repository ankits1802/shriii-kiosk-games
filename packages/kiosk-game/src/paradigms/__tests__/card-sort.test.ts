import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { loadGameContent } from '../../engine/content.ts';
import {
  CardSortRuleEngine,
  classifyHeaton,
  classifySort,
  contingentPolicyFromConfig,
  DIMENSIONS,
  type Dimension,
  distinctMatchPiles,
  drawCard,
  keyCardsForForm,
  type Matches,
  makeKeyCards,
  matchesOf,
  type Pile,
  rulePlanForForm,
  rulesForCondition,
  type SortRecord,
  trialsToReacquire,
} from '../card-sort.ts';
import { trialsToCriterion } from '../common.ts';
import { rngFor } from './helpers.ts';

const content = loadGameContent();
const cs = content.get('card_sort');

const M: Matches = { colour_pattern: 'pile_1', shape: 'pile_2', count: 'pile_3' };
const rec = (
  rule: Dimension,
  previousRule: Dimension | null,
  response: Pile | null,
  matches: Matches = M,
): SortRecord => ({
  rule,
  previousRule,
  matches,
  response,
});

describe('key cards and cards', () => {
  it('key cards hold a permutation of the values on every dimension (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1e6 }), (i) => {
        const keys = makeKeyCards(rngFor(i));
        for (const d of DIMENSIONS) expect(keys.map((k) => k[d]).sort()).toEqual([0, 1, 2, 3]);
        const card = drawCard(rngFor(i, 'card'), keys, {
          unambiguous: true,
          rule: 'shape',
          previousRule: 'count',
        });
        const m = matchesOf(card, keys);
        expect(distinctMatchPiles(m)).toBe(3);
        expect(m.shape).not.toBe(m.count);
        const amb = drawCard(rngFor(i, 'amb'), keys, { unambiguous: false });
        expect(distinctMatchPiles(matchesOf(amb, keys))).toBe(2);
      }),
      { numRuns: 300 },
    );
  });

  it('key cards are fixed per form', () => {
    expect(keyCardsForForm('card_sort.v0', 'form_1')).toEqual(
      keyCardsForForm('card_sort.v0', 'form_1'),
    );
  });
});

describe('rules per form (ENG-14)', () => {
  it('forms 1..6 use six different ordered rule pairs; same form is stable', () => {
    const pairs = new Set<string>();
    for (let k = 1; k <= 6; k += 1) {
      const p = rulePlanForForm(cs.config_id, `form_${k}`);
      expect(p.initial).not.toBe(p.switched);
      pairs.add(`${p.initial}>${p.switched}`);
    }
    expect(pairs.size).toBe(6);
    expect(rulePlanForForm(cs.config_id, 'form_2')).toEqual(
      rulePlanForForm(cs.config_id, 'form_2'),
    );
  });

  it('maps block conditions to rule / previous rule (switch, then reversal back)', () => {
    const plan = { initial: 'shape', switched: 'count' } as const;
    expect(rulesForCondition('rule_1', plan)).toEqual({ rule: 'shape', previousRule: null });
    expect(rulesForCondition('rule_2', plan)).toEqual({ rule: 'count', previousRule: 'shape' });
    expect(rulesForCondition('rule_1_reversed', plan)).toEqual({
      rule: 'shape',
      previousRule: 'count',
    });
  });
});

describe('contingent switching', () => {
  it('reads the policy from the config and switches after N correct inside the window', () => {
    const policy = contingentPolicyFromConfig(cs);
    expect(policy).toEqual({ afterCorrect: 6, window: [8, 14], switches: 2 });
    const e = new CardSortRuleEngine({ initial: 'shape', switched: 'colour_pattern' }, policy);
    const shifts = [];
    for (let i = 0; i < 7; i += 1) expect(e.record(true)).toBeNull(); // 7 < window min 8
    const s1 = e.record(true);
    expect(s1).toEqual({ kind: 'rule_switch', atTrial: 8, from: 'shape', to: 'colour_pattern' });
    shifts.push(s1);
    expect(e.previousRule).toBe('shape');
    // Never correct: forced switch at window max (14).
    let s2 = null;
    for (let i = 0; i < 14 && !s2; i += 1) s2 = e.record(false);
    expect(s2).toEqual({ kind: 'rule_reversal', atTrial: 22, from: 'colour_pattern', to: 'shape' });
    for (let i = 0; i < 30; i += 1) expect(e.record(true)).toBeNull(); // no third switch
    expect(e.switchesDone).toBe(2);
  });
});

describe('classification', () => {
  it.each([
    // rule, previous, response, correct, simplePerseverative, other
    ['colour_pattern', null, 'pile_1', true, false, false],
    ['shape', 'colour_pattern', 'pile_1', false, true, false],
    ['shape', 'colour_pattern', 'pile_2', true, false, false],
    ['shape', 'colour_pattern', 'pile_3', false, false, false],
    ['shape', 'colour_pattern', 'pile_4', false, false, true],
    ['shape', 'colour_pattern', null, false, false, false],
  ] as const)('rule=%s prev=%s response=%s', (rule, prev, resp, correct, pers, other) => {
    const c = classifySort(rec(rule, prev, resp));
    expect(c.correct).toBe(correct);
    expect(c.simplePerseverativeError).toBe(pers);
    expect(c.other).toBe(other);
    expect(c.timeout).toBe(resp === null);
  });

  it('Heaton: perseveration to the previous rule after a switch', () => {
    const r = [
      rec('colour_pattern', null, 'pile_1'),
      rec('shape', 'colour_pattern', 'pile_1'), // P: colour -> perseverative error
      rec('shape', 'colour_pattern', 'pile_1'), // perseverative error
      rec('shape', 'colour_pattern', 'pile_3'), // count: non-perseverative error
      rec('shape', 'colour_pattern', 'pile_2'), // correct
    ];
    const h = classifyHeaton(r);
    expect(h.trials.map((t) => t.perseverativeError)).toEqual([false, true, true, false, false]);
    expect(h.trials.map((t) => t.nonPerseverativeError)).toEqual([
      false,
      false,
      false,
      true,
      false,
    ]);
    expect(h.perseverativeErrors).toBe(2);
    expect(h.errors).toBe(3);
  });

  it('Heaton: first unambiguous error sets the principle before any switch', () => {
    const r = [
      rec('colour_pattern', null, 'pile_2'), // shape error -> principle shape, not perseverative
      rec('colour_pattern', null, 'pile_2'), // perseverative
      rec('colour_pattern', null, 'pile_3'), // count error, non-perseverative
    ];
    const h = classifyHeaton(r);
    expect(h.trials.map((t) => t.perseverativeError)).toEqual([false, true, false]);
    expect(h.trials[1]?.principle).toBe('shape');
  });

  it('Heaton: principle shift after three consecutive unambiguous errors to a new dimension', () => {
    const r = [
      rec('colour_pattern', null, 'pile_1'),
      rec('shape', 'colour_pattern', 'pile_3'), // count 1 (not perseverative)
      rec('shape', 'colour_pattern', 'pile_3'), // count 2 -> perseverative (retro)
      rec('shape', 'colour_pattern', 'pile_3'), // count 3 -> perseverative, principle = count
      rec('shape', 'colour_pattern', 'pile_3'), // perseverative to count
      rec('shape', 'colour_pattern', 'pile_1'), // colour is no longer the principle
    ];
    const h = classifyHeaton(r);
    expect(h.trials.map((t) => t.perseverativeError)).toEqual([
      false,
      false,
      true,
      true,
      true,
      false,
    ]);
    expect(h.trials[4]?.principle).toBe('count');
  });

  it('Heaton: sandwich rule for ambiguous responses', () => {
    const amb: Matches = { colour_pattern: 'pile_1', shape: 'pile_2', count: 'pile_1' }; // colour+count on pile_1
    const r = [
      rec('colour_pattern', null, 'pile_1'),
      rec('shape', 'colour_pattern', 'pile_1'), // unambiguous perseverative
      rec('shape', 'colour_pattern', 'pile_1', amb), // ambiguous, matches principle -> sandwiched
      rec('shape', 'colour_pattern', 'pile_1'), // unambiguous perseverative
      rec('shape', 'colour_pattern', 'pile_1', amb), // ambiguous, not closed by a later perseverative
      rec('shape', 'colour_pattern', 'pile_2'),
    ];
    const h = classifyHeaton(r);
    expect(h.trials.map((t) => t.perseverativeResponse)).toEqual([
      false,
      true,
      true,
      true,
      false,
      false,
    ]);
  });

  it('perseverative errors are a subset of errors; simple parity rule never flags correct sorts (property)', () => {
    const piles: Pile[] = ['pile_1', 'pile_2', 'pile_3', 'pile_4'];
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1e6 }),
        fc.array(fc.option(fc.constantFrom(...piles), { nil: null }), {
          minLength: 5,
          maxLength: 40,
        }),
        (seed, responses) => {
          const keys = makeKeyCards(rngFor(seed));
          const rng = rngFor(seed, 'cards');
          const records = responses.map((resp, i) => {
            const rule: Dimension = i < 10 ? 'shape' : i < 25 ? 'count' : 'shape';
            const prev: Dimension | null = i < 10 ? null : i < 25 ? 'shape' : 'count';
            const card = drawCard(rng, keys, {
              unambiguous: rng.bool(0.7),
              rule,
              previousRule: prev,
            });
            return rec(rule, prev, resp, matchesOf(card, keys));
          });
          const h = classifyHeaton(records);
          for (const t of h.trials) {
            if (t.perseverativeError || t.nonPerseverativeError) expect(t.correct).toBe(false);
            if (t.simplePerseverativeError) expect(t.correct).toBe(false);
            expect(t.perseverativeError && t.nonPerseverativeError).toBe(false);
          }
          expect(h.perseverativeErrors + h.nonPerseverativeErrors).toBe(h.errors);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('trials to reacquire (Python parity)', () => {
  it('matches trials_to_criterion per rule change', () => {
    const r = [
      rec('colour_pattern', null, 'pile_1'),
      rec('colour_pattern', null, 'pile_1'),
      rec('shape', 'colour_pattern', 'pile_1'),
      rec('shape', 'colour_pattern', 'pile_2'),
      rec('shape', 'colour_pattern', 'pile_2'),
      rec('shape', 'colour_pattern', 'pile_2'),
      rec('colour_pattern', 'shape', 'pile_2'),
      rec('colour_pattern', 'shape', 'pile_1'),
    ];
    expect(trialsToReacquire(r, 3)).toEqual([
      { shiftAt: 2, position: 4, reached: true },
      { shiftAt: 6, position: 3, reached: false },
    ]);
    expect(trialsToCriterion([true, false, true, true, true], 3)).toEqual({
      position: 5,
      reached: true,
    });
    expect(trialsToCriterion([], 3)).toEqual({ position: 1, reached: false });
  });
});
