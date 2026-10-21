import {
  buildDeck,
  type Card,
  correctKey,
  type Dimension,
  KEY_CARDS,
  type KeyIndex,
  matchingDimensions,
} from './cards.ts';
import { type ProtocolConfig, ruleFor } from './protocol.ts';

/** One administered sort, as stored and synced. */
export interface TrialRecord {
  /** 1-based trial number. */
  readonly index: number;
  readonly card: Card;
  readonly chosenKey: KeyIndex;
  /** Sorting rule in force when the card was shown. */
  readonly rule: Dimension;
  readonly correct: boolean;
  /** Dimensions shared by the card and the chosen key card. */
  readonly matched: readonly Dimension[];
  /** Categories completed before this trial. */
  readonly categoriesBefore: number;
  /** Card shown -> tap, in ms (monotonic clock). */
  readonly latencyMs: number;
  readonly respondedAt: string;
}

export interface EngineState {
  readonly config: ProtocolConfig;
  readonly deck: readonly Card[];
  readonly trials: readonly TrialRecord[];
  readonly categoriesCompleted: number;
  /** Consecutive correct sorts in the current category. */
  readonly run: number;
  readonly finished: boolean;
}

export function createEngine(config: ProtocolConfig): EngineState {
  return {
    config,
    deck: buildDeck(config.deckSize, config.deckSeed),
    trials: [],
    categoriesCompleted: 0,
    run: 0,
    finished: false,
  };
}

export function currentCard(state: EngineState): Card | null {
  return state.finished ? null : (state.deck[state.trials.length] ?? null);
}

export function currentRule(state: EngineState): Dimension {
  return ruleFor(state.config, state.categoriesCompleted);
}

/** Pure transition: record the participant's choice for the current card. */
export function respond(
  state: EngineState,
  chosenKey: KeyIndex,
  latencyMs: number,
  respondedAt: string,
): { state: EngineState; trial: TrialRecord } {
  const card = currentCard(state);
  if (!card) throw new Error('administration already finished');
  const rule = currentRule(state);
  const correct = correctKey(card, rule) === chosenKey;
  const trial: TrialRecord = {
    index: state.trials.length + 1,
    card,
    chosenKey,
    rule,
    correct,
    matched: matchingDimensions(card, KEY_CARDS[chosenKey]),
    categoriesBefore: state.categoriesCompleted,
    latencyMs: Math.max(0, Math.round(latencyMs)),
    respondedAt,
  };
  let run = correct ? state.run + 1 : 0;
  let categoriesCompleted = state.categoriesCompleted;
  if (run >= state.config.consecutiveCorrectToComplete) {
    categoriesCompleted += 1;
    run = 0;
  }
  const trials = [...state.trials, trial];
  const finished =
    categoriesCompleted >= state.config.maxCategories || trials.length >= state.deck.length;
  return { state: { ...state, trials, categoriesCompleted, run, finished }, trial };
}

/** Rebuild engine state from stored trials (resume after an app restart). */
export function replay(config: ProtocolConfig, trials: readonly TrialRecord[]): EngineState {
  let state = createEngine(config);
  for (const t of trials) {
    const expected = currentCard(state);
    if (
      !expected ||
      expected.colour !== t.card.colour ||
      expected.shape !== t.card.shape ||
      expected.number !== t.card.number
    ) {
      throw new Error(`stored trial ${t.index} does not match the protocol deck`);
    }
    state = respond(state, t.chosenKey, t.latencyMs, t.respondedAt).state;
  }
  return state;
}
