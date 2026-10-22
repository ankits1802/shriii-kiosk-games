import { describe, expect, it } from 'vitest';
import {
  type Card,
  COLOURS,
  correctKey,
  type Dimension,
  KEY_CARDS,
  type KeyIndex,
  NUMBERS,
  SHAPES,
} from '../src/domain/cards.ts';
import { createEngine, currentCard, respond } from '../src/domain/engine.ts';
import { PROTOCOL_64, PROTOCOL_128, type ProtocolConfig } from '../src/domain/protocol.ts';
import { type ScoringInput, scoreCardSort } from '../src/domain/scoring.ts';

/** Card whose colour, shape and number point at key cards c, s and n (0-3). */
const card = (c: number, s: number, n: number): Card => ({
  colour: COLOURS[c] as Card['colour'],
  shape: SHAPES[s] as Card['shape'],
  number: NUMBERS[n] as Card['number'],
});
/** Sort `c` onto key card `k`. */
const r = (c: Card, k: KeyIndex): ScoringInput => ({ card: c, chosenKey: k });

const proto = (rules: Dimension[], n: number, max = rules.length): ProtocolConfig => ({
  ...PROTOCOL_64,
  ruleSequence: rules,
  consecutiveCorrectToComplete: n,
  maxCategories: max,
});

describe('worked example A: first-category principle, P after completion, sandwich rule', () => {
  // Rules colour -> shape -> number, 3 in a row completes a category (short form for hand scoring).
  // Key cards: K0 1 red triangle, K1 2 green stars, K2 3 yellow crosses, K3 4 blue circles.
  const trials: ScoringInput[] = [
    r(card(1, 0, 2), 0), //  1 shape only, rule colour: error, sets P=shape (not perseverative)
    r(card(2, 1, 0), 1), //  2 shape only: perseverative error
    r(card(3, 2, 1), 3), //  3 colour: correct (run 1)
    r(card(0, 3, 2), 0), //  4 colour: correct (run 2)
    r(card(1, 2, 3), 1), //  5 colour: correct (run 3) -> category 1 complete; rule shape, P=colour
    r(card(2, 0, 1), 2), //  6 colour only: perseverative error
    r(card(0, 1, 2), 1), //  7 shape: correct (run 1)
    r(card(3, 3, 0), 3), //  8 colour+shape: correct, ambiguous, matches P but not sandwiched
    r(card(1, 0, 3), 0), //  9 shape: correct (run 3) -> category 2 complete; rule number, P=shape
    r(card(3, 1, 2), 1), // 10 shape only: perseverative error
    r(card(2, 1, 1), 1), // 11 shape+number: correct, ambiguous, sandwiched -> perseverative response
    r(card(0, 1, 3), 1), // 12 shape only: perseverative error
    r(card(1, 3, 2), 2), // 13 number: correct (run 1)
    r(card(1, 2, 0), 1), // 14 colour only: non-perseverative error
    r(card(2, 3, 1), 1), // 15 number: correct (run 1)
    r(card(0, 0, 3), 3), // 16 number only: correct (run 2)
    r(card(3, 2, 2), 2), // 17 shape+number: correct (run 3) -> category 3 complete, test ends
  ];
  const s = scoreCardSort(proto(['colour', 'shape', 'number'], 3), trials);

  it('matches the hand-scored totals', () => {
    expect(s.trialsAdministered).toBe(17);
    expect(s.categoriesCompleted).toBe(3);
    expect(s.totalCorrect).toBe(11);
    expect(s.totalErrors).toBe(6);
    expect(s.perseverativeResponses).toBe(5);
    expect(s.perseverativeErrors).toBe(4);
    expect(s.nonPerseverativeErrors).toBe(2);
    expect(s.trialsToFirstCategory).toBe(5);
    expect(s.failureToMaintainSet).toBe(0);
    expect(s.conceptualLevelResponses).toBe(9);
    expect(s.otherResponses).toBe(0);
  });

  it('classifies each trial', () => {
    const pers = s.trials.filter((t) => t.perseverative).map((t) => t.index);
    expect(pers).toEqual([2, 6, 10, 11, 12]);
    expect(s.trials[0]?.principle).toBeNull();
    expect(s.trials[1]?.principle).toBe('shape');
    expect(s.trials[5]?.principle).toBe('colour');
    expect(s.trials[7]?.perseverative).toBe(false); // ambiguous, previous response did not match P
    expect(s.trials[10]?.perseverativeError).toBe(false); // perseverative yet correct
    expect(s.trials.filter((t) => t.completesCategory).map((t) => t.index)).toEqual([5, 9, 17]);
  });
});

describe('worked example B: three-error principle change and failure to maintain set', () => {
  // Rules colour -> shape, 6 in a row completes a category. Every card points to three different
  // key cards, so every response is unambiguous.
  const c = card(0, 1, 2); // colour->K0, shape->K1, number->K2, K3 matches nothing
  const trials: ScoringInput[] = [
    r(c, 0),
    r(c, 0),
    r(c, 0),
    r(c, 0),
    r(c, 0), // 1-5 colour: correct (run 5)
    r(c, 2), //  6 number: error after 5 correct -> failure to maintain set; sets P=number
    r(c, 1), //  7 shape: error, first of three to a new principle (not perseverative)
    r(c, 1), //  8 shape: second -> perseverative (retroactively, once the third arrives)
    r(c, 1), //  9 shape: third -> P=shape, perseverative
    r(c, 2), // 10 number: error, no longer P -> non-perseverative
    r(c, 0),
    r(c, 0),
    r(c, 0),
    r(c, 0),
    r(c, 0),
    r(c, 0), // 11-16 colour -> category 1 at 16
    r(c, 0), // 17 colour only, rule shape, P=colour: perseverative error
    r(c, 3), // 18 matches nothing: "other" error, non-perseverative
  ];
  const s = scoreCardSort(proto(['colour', 'shape'], 6), trials);

  it('matches the hand-scored totals', () => {
    expect(s.trialsAdministered).toBe(18);
    expect(s.categoriesCompleted).toBe(1);
    expect(s.totalCorrect).toBe(11);
    expect(s.totalErrors).toBe(7);
    expect(s.perseverativeErrors).toBe(3);
    expect(s.perseverativeResponses).toBe(3);
    expect(s.nonPerseverativeErrors).toBe(4);
    expect(s.failureToMaintainSet).toBe(1);
    expect(s.trialsToFirstCategory).toBe(16);
    expect(s.conceptualLevelResponses).toBe(11);
    expect(s.otherResponses).toBe(1);
  });

  it('applies the new principle from the second of the three errors', () => {
    expect(s.trials.filter((t) => t.perseverative).map((t) => t.index)).toEqual([8, 9, 17]);
    expect(s.trials[6]?.principle).toBe('number');
    expect(s.trials[7]?.principle).toBe('shape');
    expect(s.trials[9]?.principle).toBe('shape');
    expect(s.trials[5]?.failureToMaintainSet).toBe(true);
  });

  it('does not change principle on two errors or interrupted streaks', () => {
    const t2: ScoringInput[] = [r(c, 2), r(c, 1), r(c, 1), r(c, 0), r(c, 1)];
    const s2 = scoreCardSort(proto(['colour', 'shape'], 6), t2);
    expect(s2.trials.map((t) => t.principle)).toEqual([
      null,
      'number',
      'number',
      'number',
      'number',
    ]);
    expect(s2.perseverativeErrors).toBe(0);
  });
});

describe('edge cases', () => {
  it('no responses', () => {
    const s = scoreCardSort(PROTOCOL_64, []);
    expect(s.trialsAdministered).toBe(0);
    expect(s.trialsToFirstCategory).toBeNull();
    expect(s.percentPerseverativeErrors).toBeNull();
  });

  it('ambiguous errors do not establish the first principle', () => {
    // card colour->K1, shape->K2, number->K2: sorting on K2 matches shape+number (rule colour)
    const s = scoreCardSort(PROTOCOL_64, [r(card(1, 2, 2), 2), r(card(1, 2, 2), 2)]);
    expect(s.trials.every((t) => t.principle === null)).toBe(true);
    expect(s.perseverativeErrors).toBe(0);
    expect(s.nonPerseverativeErrors).toBe(2);
  });

  it('ignores responses after the last category', () => {
    const c = card(0, 1, 2);
    const s = scoreCardSort(proto(['colour'], 2, 1), [r(c, 0), r(c, 0), r(c, 1)]);
    expect(s.trialsAdministered).toBe(2);
    expect(s.categoriesCompleted).toBe(1);
  });
});

describe('standard protocol through the engine', () => {
  function run(config: ProtocolConfig, policy: (c: Card, rule: Dimension, i: number) => KeyIndex) {
    let state = createEngine(config);
    while (!state.finished) {
      const c = currentCard(state) as Card;
      const rule = config.ruleSequence[
        state.categoriesCompleted % config.ruleSequence.length
      ] as Dimension;
      state = respond(
        state,
        policy(c, rule, state.trials.length),
        1000,
        '2026-10-22T10:00:00Z',
      ).state;
    }
    return { state, scores: scoreCardSort(config, state.trials) };
  }

  it('a perfect sorter completes 6 categories in 60 cards', () => {
    const { state, scores } = run(PROTOCOL_64, (c, rule) => correctKey(c, rule));
    expect(state.trials).toHaveLength(60);
    expect(scores.categoriesCompleted).toBe(6);
    expect(scores.totalErrors).toBe(0);
    expect(scores.trialsToFirstCategory).toBe(10);
    expect(scores.conceptualLevelResponses).toBe(60);
    expect(scores.perseverativeResponses).toBe(0);
  });

  it('a colour-only sorter: one category, every error perseverative', () => {
    const { state, scores } = run(PROTOCOL_64, (c) => correctKey(c, 'colour'));
    expect(state.trials).toHaveLength(64);
    expect(scores.categoriesCompleted).toBe(1);
    expect(scores.trialsToFirstCategory).toBe(10);
    expect(scores.totalErrors).toBeGreaterThan(30);
    expect(scores.perseverativeErrors).toBe(scores.totalErrors);
    expect(scores.nonPerseverativeErrors).toBe(0);
  });

  it('engine running flags agree with the independent scorer', () => {
    const { state, scores } = run(PROTOCOL_128, (c, rule, i) =>
      i % 7 === 3 ? (((correctKey(c, rule) + 1) % 4) as KeyIndex) : correctKey(c, rule),
    );
    expect(scores.categoriesCompleted).toBe(state.categoriesCompleted);
    expect(scores.totalCorrect).toBe(state.trials.filter((t) => t.correct).length);
    expect(state.trials.every((t, i) => t.correct === scores.trials[i]?.correct)).toBe(true);
  });

  it('the key cards are the standard four', () => {
    expect(KEY_CARDS.map((k) => `${k.number} ${k.colour} ${k.shape}`)).toEqual([
      '1 red triangle',
      '2 green star',
      '3 yellow cross',
      '4 blue circle',
    ]);
  });
});
