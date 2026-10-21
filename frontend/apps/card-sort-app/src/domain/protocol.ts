import { DIMENSIONS, type Dimension } from './cards.ts';

/**
 * Administration protocol. The defaults are the standard WCST procedure: sorting rules
 * colour -> shape -> number, repeated once; a category is complete after 10 consecutive correct
 * sorts; the test stops after 6 categories or when the cards run out (64 or 128).
 */
export interface ProtocolConfig {
  /** Stable id recorded with every session, e.g. `wcst64-standard`. */
  readonly protocolId: string;
  readonly deckSize: 64 | 128;
  /** Rule for category k is `ruleSequence[k % length]`; consecutive rules must differ. */
  readonly ruleSequence: readonly Dimension[];
  /** Consecutive correct sorts that complete a category. */
  readonly consecutiveCorrectToComplete: number;
  /** Stop once this many categories are complete. */
  readonly maxCategories: number;
  /** Seed for the fixed card order (keep constant within a study). */
  readonly deckSeed: number;
  /** Correct/incorrect feedback duration before the next card (ms). */
  readonly feedbackMs: number;
}

export const STANDARD_RULES: readonly Dimension[] = [
  'colour',
  'shape',
  'number',
  'colour',
  'shape',
  'number',
];

export const DEFAULT_DECK_SEED = 19_930_064;

export const PROTOCOL_64: ProtocolConfig = {
  protocolId: 'wcst64-standard',
  deckSize: 64,
  ruleSequence: STANDARD_RULES,
  consecutiveCorrectToComplete: 10,
  maxCategories: 6,
  deckSeed: DEFAULT_DECK_SEED,
  feedbackMs: 1200,
};

export const PROTOCOL_128: ProtocolConfig = {
  ...PROTOCOL_64,
  protocolId: 'wcst128-standard',
  deckSize: 128,
};

export const PROTOCOLS: Readonly<Record<string, ProtocolConfig>> = {
  [PROTOCOL_64.protocolId]: PROTOCOL_64,
  [PROTOCOL_128.protocolId]: PROTOCOL_128,
};

/** Rule in force for the given number of completed categories. */
export function ruleFor(
  config: Pick<ProtocolConfig, 'ruleSequence'>,
  categoriesCompleted: number,
): Dimension {
  const rule = config.ruleSequence[categoriesCompleted % config.ruleSequence.length];
  if (!rule) throw new Error('empty rule sequence');
  return rule;
}

/** Human-readable problems with a protocol (empty = valid). */
export function validateProtocol(config: ProtocolConfig): string[] {
  const errors: string[] = [];
  const seq = config.ruleSequence;
  if (config.deckSize !== 64 && config.deckSize !== 128) errors.push('deckSize must be 64 or 128');
  if (seq.length === 0) errors.push('ruleSequence must not be empty');
  for (const r of seq) if (!DIMENSIONS.includes(r)) errors.push(`unknown rule ${String(r)}`);
  for (let k = 0; k < config.maxCategories; k++) {
    const a = seq[k % seq.length];
    const b = seq[(k + 1) % seq.length];
    if (seq.length > 0 && k + 1 < config.maxCategories && a === b)
      errors.push(`rules for categories ${k + 1} and ${k + 2} are identical (${String(a)})`);
  }
  if (
    !Number.isInteger(config.consecutiveCorrectToComplete) ||
    config.consecutiveCorrectToComplete < 2
  )
    errors.push('consecutiveCorrectToComplete must be an integer >= 2');
  if (!Number.isInteger(config.maxCategories) || config.maxCategories < 1)
    errors.push('maxCategories must be an integer >= 1');
  if (!(config.feedbackMs >= 0)) errors.push('feedbackMs must be >= 0');
  return errors;
}
