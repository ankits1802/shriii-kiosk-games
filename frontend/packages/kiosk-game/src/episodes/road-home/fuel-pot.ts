/**
 * Road Home shared fodder pot (EPI-03 teamwork beat): at each night stop the player and the partner
 * each hold `endowment_tokens` bundles of fodder and drop some into the shared trough; the trough is
 * multiplied (`pot_multiplier`) and split equally (shared paradigm accounting, `public-goods.ts`).
 *
 * Partner script (content config): round 0 is a cooperative baseline; `fuel_free_rider_rounds`
 * rounds are free-rider rounds (the partner keeps almost all of their fodder) placed so each is
 * followed by another round (so `teamwork.response_to_partner_defection` has post-defection rounds);
 * one scripted error round (`is_error`: the partner trips and the fodder spills) falls inside
 * `fuel_error_round_window`; the last round is cooperative. All placement is seeded.
 */
import type { GameConfig } from '@shriii/contracts';
import type { SeededRng } from '../../core/contracts.ts';
import type { Resolved } from '../../paradigms/common.ts';
import {
  endowmentFromConfig,
  multiplierFromConfig,
  type PartnerPolicyParams,
  partnerParamsFromConfig,
  type RoundPlanEntry,
} from '../../paradigms/public-goods.ts';
import { RoadHomeConfigError } from './settings.ts';

export interface FuelPotSettings {
  readonly endowment: Resolved<number>;
  readonly multiplier: Resolved<number>;
  readonly partner: PartnerPolicyParams;
  readonly partnerSources: Readonly<Record<keyof PartnerPolicyParams, string>>;
}

/** Fuel-pot settings from the config (sources are logged with each round's params). */
export function fuelPotSettings(config: GameConfig): FuelPotSettings {
  const p = partnerParamsFromConfig(config);
  return {
    endowment: endowmentFromConfig(config),
    multiplier: multiplierFromConfig(config),
    partner: {
      cooperativeShare: p.cooperativeShare.value,
      freeRiderMaxTokens: p.freeRiderMaxTokens.value,
      errorTokens: p.errorTokens.value,
    },
    partnerSources: {
      cooperativeShare: p.cooperativeShare.source,
      freeRiderMaxTokens: p.freeRiderMaxTokens.source,
      errorTokens: p.errorTokens.source,
    },
  };
}

/** Seeded round plan for the Road Home partner. */
export function roadHomeFuelPlan(
  rounds: number,
  freeRiderRounds: number,
  errorWindow: readonly [number, number],
  rng: SeededRng,
): RoundPlanEntry[] {
  const [w0, w1] = errorWindow;
  if (rounds < 3) throw new RoadHomeConfigError('the fodder pot needs at least 3 rounds');
  if (w0 < 1 || w1 > rounds - 2 || w0 > w1) {
    throw new RoadHomeConfigError(
      `fuel_error_round_window [${w0}, ${w1}] must lie inside rounds 1..${rounds - 2}`,
    );
  }
  const err = rng.stream('error').int(w0, w1);
  const pool: number[] = [];
  for (let r = 1; r <= rounds - 2; r += 1) if (r !== err) pool.push(r);
  if (freeRiderRounds > pool.length) {
    throw new RoadHomeConfigError(
      `fuel_free_rider_rounds ${freeRiderRounds} does not fit ${rounds} rounds`,
    );
  }
  const riders = new Set(rng.stream('free_rider').shuffle(pool).slice(0, freeRiderRounds));
  return Array.from({ length: rounds }, (_, r) => ({
    round: r,
    partnerType:
      r === err
        ? ('error_prone' as const)
        : riders.has(r)
          ? ('free_rider' as const)
          : ('cooperative' as const),
    errorRound: r === err,
  }));
}
