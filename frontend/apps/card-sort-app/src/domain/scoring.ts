/**
 * Criterion card-sort scoring (Heaton et al., 1993 rules; WCST-64 per Kongs et al., 2000).
 *
 * Scoring is recomputed from the raw responses (card + chosen key card) and the protocol, never
 * from the engine's running flags, so a stored session can be rescored independently.
 *
 * Perseveration rules implemented:
 * 1. Perseverated-to principle (P). None at the start. In the first category the first
 *    unambiguous error sets P (that error itself is not perseverative). After each completed
 *    category, P becomes the rule of the category just completed.
 * 2. Principle change. Three consecutive unambiguous errors to the same dimension other than P
 *    make that dimension the new P; the first of the three is not perseverative, the second and
 *    third are.
 * 3. A response that matches P unambiguously (on P only) is perseverative.
 * 4. Sandwich rule. An ambiguous response that matches P (on P plus another dimension) is
 *    perseverative only when it lies between two unambiguous perseverative responses under the
 *    same P, and every response between them also matches P.
 * Perseverative errors are perseverative responses that are incorrect; an ambiguous response that
 * also matches the current rule can be perseverative yet correct.
 *
 * Failure to maintain set: an error after 5 or more consecutive correct sorts, before the
 * category is completed. Conceptual-level responses: correct sorts in runs of 3 or more.
 */

import {
  type Card,
  type Dimension,
  KEY_CARDS,
  type KeyIndex,
  matchingDimensions,
} from './cards.ts';
import { type ProtocolConfig, ruleFor } from './protocol.ts';

export const SCORING_ALGORITHM_VERSION = '1.0.0';
export const FAILURE_TO_MAINTAIN_SET_RUN = 5;
export const CONCEPTUAL_LEVEL_RUN = 3;

export interface ScoringInput {
  readonly card: Card;
  readonly chosenKey: KeyIndex;
}

export type ScoringProtocol = Pick<
  ProtocolConfig,
  'ruleSequence' | 'consecutiveCorrectToComplete' | 'maxCategories'
>;

export interface TrialScore {
  readonly index: number;
  readonly rule: Dimension;
  readonly matched: readonly Dimension[];
  readonly correct: boolean;
  readonly ambiguous: boolean;
  /** Perseverated-to principle in force for this trial (null before it is established). */
  readonly principle: Dimension | null;
  readonly perseverative: boolean;
  readonly perseverativeError: boolean;
  /** This trial completed a category. */
  readonly completesCategory: boolean;
  readonly failureToMaintainSet: boolean;
}

export interface CardSortScores {
  readonly trialsAdministered: number;
  readonly totalCorrect: number;
  readonly totalErrors: number;
  readonly categoriesCompleted: number;
  readonly perseverativeResponses: number;
  readonly perseverativeErrors: number;
  readonly nonPerseverativeErrors: number;
  /** Errors matching no dimension of the chosen key card. */
  readonly otherResponses: number;
  readonly failureToMaintainSet: number;
  /** Trials up to and including the one completing the first category; null when none was. */
  readonly trialsToFirstCategory: number | null;
  readonly conceptualLevelResponses: number;
  readonly percentPerseverativeErrors: number | null;
  readonly trials: readonly TrialScore[];
}

interface Streak {
  readonly dim: Dimension;
  readonly count: number;
  readonly first: number;
}

/** Extend a run of consecutive unambiguous errors to `dim`, or start a new one at trial `i`. */
function extendStreak(prev: Streak | null, dim: Dimension, i: number): Streak {
  return prev !== null && prev.dim === dim && prev.first + prev.count === i
    ? { dim, count: prev.count + 1, first: prev.first }
    : { dim, count: 1, first: i };
}

interface Working {
  index: number;
  rule: Dimension;
  matched: Dimension[];
  correct: boolean;
  principle: Dimension | null;
  completesCategory: boolean;
  failureToMaintainSet: boolean;
}

export function scoreCardSort(
  protocol: ScoringProtocol,
  responses: readonly ScoringInput[],
): CardSortScores {
  const work: Working[] = [];
  let principle: Dimension | null = null;
  let categories = 0;
  let run = 0;
  let streak: Streak | null = null;
  let firstCategoryAt: number | null = null;

  for (const [i, r] of responses.entries()) {
    if (categories >= protocol.maxCategories) break;
    const rule = ruleFor(protocol, categories);
    const matched = matchingDimensions(r.card, KEY_CARDS[r.chosenKey]);
    const correct = matched.includes(rule);
    const w: Working = {
      index: i + 1,
      rule,
      matched,
      correct,
      principle,
      completesCategory: false,
      failureToMaintainSet: false,
    };
    work.push(w);

    const unambiguousError = !correct && matched.length === 1 ? (matched[0] as Dimension) : null;
    if (categories === 0 && principle === null) {
      if (unambiguousError) principle = unambiguousError; // rule 1: not itself perseverative
      streak = null;
    } else if (unambiguousError && unambiguousError !== principle) {
      const next = extendStreak(streak, unambiguousError, i);
      streak = next;
      if (next.count === 3) {
        // rule 2: the new principle applies from the second of the three errors onward
        principle = unambiguousError;
        for (let j = next.first + 1; j <= i; j++) (work[j] as Working).principle = principle;
        streak = null;
      }
    } else {
      streak = null;
    }

    if (correct) {
      run += 1;
      if (run >= protocol.consecutiveCorrectToComplete) {
        categories += 1;
        w.completesCategory = true;
        if (firstCategoryAt === null) firstCategoryAt = w.index;
        principle = rule;
        streak = null;
        run = 0;
      }
    } else {
      if (run >= FAILURE_TO_MAINTAIN_SET_RUN) w.failureToMaintainSet = true;
      run = 0;
    }
  }

  const matchesP = (w: Working | undefined): boolean =>
    !!w && w.principle !== null && w.matched.includes(w.principle);
  const unambiguousP = (w: Working | undefined): boolean => matchesP(w) && w?.matched.length === 1;

  const sandwiched = (i: number): boolean => {
    const p = work[i]?.principle;
    const scan = (step: 1 | -1): boolean => {
      for (let j = i + step; j >= 0 && j < work.length; j += step) {
        const w = work[j];
        if (!w || w.principle !== p || !matchesP(w)) return false;
        if (w.matched.length === 1) return true;
      }
      return false;
    };
    return scan(-1) && scan(1);
  };

  const trials: TrialScore[] = work.map((w, i) => {
    const ambiguous = w.matched.length > 1;
    const perseverative = unambiguousP(w) || (ambiguous && matchesP(w) && sandwiched(i));
    return {
      index: w.index,
      rule: w.rule,
      matched: w.matched,
      correct: w.correct,
      ambiguous,
      principle: w.principle,
      perseverative,
      perseverativeError: perseverative && !w.correct,
      completesCategory: w.completesCategory,
      failureToMaintainSet: w.failureToMaintainSet,
    };
  });

  let conceptual = 0;
  let streakCorrect = 0;
  for (const t of trials) {
    if (t.correct) {
      streakCorrect += 1;
      if (streakCorrect === CONCEPTUAL_LEVEL_RUN) conceptual += CONCEPTUAL_LEVEL_RUN;
      else if (streakCorrect > CONCEPTUAL_LEVEL_RUN) conceptual += 1;
    } else {
      streakCorrect = 0;
    }
  }

  const n = trials.length;
  const totalCorrect = trials.filter((t) => t.correct).length;
  const perseverativeErrors = trials.filter((t) => t.perseverativeError).length;
  return {
    trialsAdministered: n,
    totalCorrect,
    totalErrors: n - totalCorrect,
    categoriesCompleted: categories,
    perseverativeResponses: trials.filter((t) => t.perseverative).length,
    perseverativeErrors,
    nonPerseverativeErrors: n - totalCorrect - perseverativeErrors,
    otherResponses: trials.filter((t) => t.matched.length === 0).length,
    failureToMaintainSet: trials.filter((t) => t.failureToMaintainSet).length,
    trialsToFirstCategory: firstCategoryAt,
    conceptualLevelResponses: conceptual,
    percentPerseverativeErrors:
      n === 0 ? null : Math.round((perseverativeErrors / n) * 10000) / 100,
    trials,
  };
}
