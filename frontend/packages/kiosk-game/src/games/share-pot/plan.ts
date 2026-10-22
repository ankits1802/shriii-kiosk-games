/**
 * Share-the-Pot schedule (MG-05): practice round, 8 scripted-partner rounds with free-rider rounds and
 * one partner-error round inside its window, the exploratory unfair-loss tone probe, and the probe
 * segment. Partner policies, multiplier and endowment come from `content/games/pathway-b/share-pot.json`.
 *
 * Constraint added on top of the paradigm's round plan (`constraints.last_round_cooperative`): the
 * last round is cooperative so that every free-rider round and the error round is followed by a
 * round in which the player's response to it can be observed (the dictionary's
 * `teamwork.response_to_partner_defection` needs 3 post-defection rounds and the error indicator 1).
 * The plan is redrawn from numbered substreams until it holds, so it stays a pure function of the seed.
 */
import type { GameConfig } from '@shriii/contracts';
import type { SeededRng } from '../../core/contracts.ts';
import {
  buildRoundPlan,
  endowmentFromConfig,
  multiplierFromConfig,
  partnerParamsFromConfig,
  type RoundPlanEntry,
  sharePotPlanOptions,
} from '../../paradigms/public-goods.ts';

export interface SharePotPlan {
  readonly rounds: readonly RoundPlanEntry[];
  /** Index (0-based) of the first error round, or null. */
  readonly errorRound: number | null;
  /** Substream attempt that produced the plan (logged in params for replay). */
  readonly attempt: number;
  readonly endowment: number;
  readonly multiplier: number;
  readonly partner: {
    readonly cooperativeShare: number;
    readonly freeRiderMaxTokens: number;
    readonly errorTokens: number;
  };
  /** Provenance of each design value (`constraints` or `paradigm_default`). */
  readonly sources: Readonly<Record<string, string>>;
}

const MAX_ATTEMPTS = 256;

/** True when the plan satisfies the module's extra placement rules. */
export function planIsValid(rounds: readonly RoundPlanEntry[], lastCooperative: boolean): boolean {
  if (rounds.length === 0) return false;
  if (!lastCooperative) return true;
  const last = rounds[rounds.length - 1];
  return last !== undefined && last.partnerType === 'cooperative' && !last.errorRound;
}

export function buildSharePotPlan(config: GameConfig, rng: SeededRng): SharePotPlan {
  const options = sharePotPlanOptions(config);
  const lastCooperative = config.constraints.last_round_cooperative === true;
  let rounds: RoundPlanEntry[] | null = null;
  let attempt = 0;
  for (; attempt < MAX_ATTEMPTS; attempt += 1) {
    const candidate = buildRoundPlan(options, rng.stream(`rounds.${attempt}`));
    if (planIsValid(candidate, lastCooperative)) {
      rounds = candidate;
      break;
    }
  }
  if (!rounds) {
    throw new Error('share_pot: no round plan satisfies the placement rules (check the config)');
  }
  const endowment = endowmentFromConfig(config);
  const multiplier = multiplierFromConfig(config);
  const partner = partnerParamsFromConfig(config);
  const err = rounds.find((r) => r.errorRound);
  return {
    rounds,
    errorRound: err ? err.round : null,
    attempt,
    endowment: endowment.value,
    multiplier: multiplier.value,
    partner: {
      cooperativeShare: partner.cooperativeShare.value,
      freeRiderMaxTokens: partner.freeRiderMaxTokens.value,
      errorTokens: partner.errorTokens.value,
    },
    sources: {
      endowment_tokens: endowment.source,
      pot_multiplier: multiplier.source,
      cooperative_share: partner.cooperativeShare.source,
      free_rider_max_tokens: partner.freeRiderMaxTokens.source,
      error_tokens: partner.errorTokens.source,
    },
  };
}
