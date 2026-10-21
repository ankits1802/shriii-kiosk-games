/**
 * Public-goods / share-pot logic (MG-05 Share-the-Pot, EPI-03 Road Home fuel pot, EPI-06 co-play
 * scripted partners).
 *
 * Each round both players hold an endowment of pictured tokens and drop some into a shared pot; the
 * pot is multiplied and split equally. Tokens are integers (pictured coins / fuel drops, never
 * numerals). With the default multiplier 2 and two players each player gets back exactly the pot
 * total, so returns are always whole tokens; for other multipliers the split is floored and the
 * remainder is recorded (`houseTokens`).
 *
 * Scripted partner policies (`PartnerType` in the contracts; introduced as "pretend helpers"):
 * - `cooperative`: about `cooperativeShare` of the endowment (seeded +-1 token);
 * - `conditional_cooperator`: matches the player's previous contribution (half on round 1);
 * - `free_rider`: 0..`freeRiderMaxTokens` tokens;
 * - `error_prone`: cooperative intent, but on its scripted error round the tokens spill
 *   (`errorTokens` land in the pot; `is_error: true`).
 *
 * Partner behaviour is deterministic given the round plan and the module rng (MG-05 AC) and is
 * logged per round as `partner_action`.
 */
import type {
  ContributionPayload,
  GameConfig,
  PartnerActionPayload,
  PartnerType,
} from '@shriii/contracts';
import type { SeededRng } from '../core/contracts.ts';
import type { TrialOverrideGenerator } from '../engine/scheduler.ts';
import {
  constraintNumber,
  constraintWindow,
  type IndicatorBinding,
  ParadigmConfigError,
  ParadigmStateError,
  type Resolved,
} from './common.ts';
import { PUBLIC_GOODS_DEFAULTS } from './content-defaults.ts';

const PARADIGM = 'public_goods';

export type ScriptedPartnerType = Exclude<PartnerType, 'live'>;

export interface PartnerPolicyParams {
  readonly cooperativeShare: number;
  readonly freeRiderMaxTokens: number;
  readonly errorTokens: number;
}

/** Context a partner sees when deciding. */
export interface PartnerContext {
  readonly round: number;
  readonly endowment: number;
  /** Player contributions in earlier rounds (oldest first). */
  readonly playerHistory: readonly number[];
  /** True on the round where an error-prone partner makes its scripted mistake. */
  readonly errorRound: boolean;
}

export interface PartnerDecision {
  readonly partnerType: ScriptedPartnerType;
  readonly policyId: string;
  /** Tokens the partner meant to contribute. */
  readonly intendedTokens: number;
  /** Tokens that landed in the pot. */
  readonly tokens: number;
  readonly isError: boolean;
  /** Closed action code for the `partner_action` event. */
  readonly action: 'contribute' | 'spill';
}

export interface PartnerPolicy {
  readonly type: ScriptedPartnerType;
  readonly policyId: string;
  decide(ctx: PartnerContext, rng: SeededRng): PartnerDecision;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function cooperativeAmount(ctx: PartnerContext, p: PartnerPolicyParams, rng: SeededRng): number {
  return clamp(Math.round(ctx.endowment * p.cooperativeShare) + rng.int(-1, 1), 0, ctx.endowment);
}

/** Create a scripted partner policy. */
export function createPartnerPolicy(
  type: ScriptedPartnerType,
  params: PartnerPolicyParams,
): PartnerPolicy {
  if (!(params.cooperativeShare >= 0 && params.cooperativeShare <= 1)) {
    throw new ParadigmConfigError(PARADIGM, 'cooperativeShare must be in [0, 1]');
  }
  if (params.freeRiderMaxTokens < 0 || params.errorTokens < 0) {
    throw new ParadigmConfigError(PARADIGM, 'token parameters must be >= 0');
  }
  const policyId = `${type}.v1`;
  const base = (intended: number, tokens: number, isError: boolean): PartnerDecision => ({
    partnerType: type,
    policyId,
    intendedTokens: intended,
    tokens,
    isError,
    action: isError ? 'spill' : 'contribute',
  });
  switch (type) {
    case 'cooperative':
      return {
        type,
        policyId,
        decide: (ctx, rng) => {
          const a = cooperativeAmount(ctx, params, rng);
          return base(a, a, false);
        },
      };
    case 'conditional_cooperator':
      return {
        type,
        policyId,
        decide: (ctx) => {
          const prev = ctx.playerHistory[ctx.playerHistory.length - 1];
          const a = clamp(prev ?? Math.round(ctx.endowment / 2), 0, ctx.endowment);
          return base(a, a, false);
        },
      };
    case 'free_rider':
      return {
        type,
        policyId,
        decide: (ctx, rng) => {
          const a = clamp(rng.int(0, params.freeRiderMaxTokens), 0, ctx.endowment);
          return base(a, a, false);
        },
      };
    case 'error_prone':
      return {
        type,
        policyId,
        decide: (ctx, rng) => {
          const intended = cooperativeAmount(ctx, params, rng);
          if (!ctx.errorRound) return base(intended, intended, false);
          return base(intended, clamp(params.errorTokens, 0, intended), true);
        },
      };
    default: {
      const never: never = type;
      throw new ParadigmConfigError(PARADIGM, `unknown partner type ${String(never)}`);
    }
  }
}

/** Partner parameters from `constraints` with documented content defaults. */
export function partnerParamsFromConfig(
  config: GameConfig,
): Readonly<Record<keyof PartnerPolicyParams, Resolved<number>>> {
  const r = (key: string, fallbackKey: keyof typeof PUBLIC_GOODS_DEFAULTS): Resolved<number> => {
    const v = constraintNumber(config, key);
    return v !== null
      ? { value: v, source: 'constraints', key }
      : {
          value: PUBLIC_GOODS_DEFAULTS[fallbackKey],
          source: 'paradigm_default',
          key: `PUBLIC_GOODS_DEFAULTS.${fallbackKey}`,
        };
  };
  return {
    cooperativeShare: r('cooperative_share', 'cooperativeShare'),
    freeRiderMaxTokens: r('free_rider_max_tokens', 'freeRiderMaxTokens'),
    errorTokens: r('error_tokens', 'errorTokens'),
  };
}

/* ------------------------------------------------------------------------------------------------
 * Round plans
 * ---------------------------------------------------------------------------------------------- */

export interface RoundPlanEntry {
  readonly round: number;
  readonly partnerType: ScriptedPartnerType;
  readonly errorRound: boolean;
}

/**
 * Standalone Share-the-Pot round plan: `rounds` rounds, `freeRiderRounds` free-rider rounds, one or
 * more error rounds inside `errorWindow` (0-based round indices), cooperative otherwise. Round 0 is
 * always cooperative (baseline before any defection) and free-rider rounds never fill the window.
 */
export function buildRoundPlan(
  options: {
    readonly rounds: number;
    readonly freeRiderRounds: number;
    readonly errorRounds: number;
    readonly errorWindow: readonly [number, number];
  },
  rng: SeededRng,
): RoundPlanEntry[] {
  const { rounds, freeRiderRounds, errorRounds, errorWindow } = options;
  const [w0, w1] = errorWindow;
  if (
    rounds < 1 ||
    freeRiderRounds < 0 ||
    errorRounds < 0 ||
    freeRiderRounds + errorRounds > rounds - 1
  ) {
    throw new ParadigmConfigError(
      PARADIGM,
      'round counts do not fit (round 0 is a cooperative baseline)',
    );
  }
  if (errorRounds > 0 && (w0 < 1 || w1 >= rounds || w1 - w0 + 1 < errorRounds)) {
    throw new ParadigmConfigError(
      PARADIGM,
      `error window [${w0}, ${w1}] does not fit ${errorRounds} error rounds`,
    );
  }
  const windowSlots: number[] = [];
  for (let r = w0; r <= w1; r += 1) windowSlots.push(r);
  const errors = new Set(rng.stream('error').shuffle(windowSlots).slice(0, errorRounds));
  const rest: number[] = [];
  for (let r = 1; r < rounds; r += 1) if (!errors.has(r)) rest.push(r);
  const riders = new Set(rng.stream('free_rider').shuffle(rest).slice(0, freeRiderRounds));
  const plan: RoundPlanEntry[] = [];
  for (let r = 0; r < rounds; r += 1) {
    plan.push({
      round: r,
      partnerType: errors.has(r) ? 'error_prone' : riders.has(r) ? 'free_rider' : 'cooperative',
      errorRound: errors.has(r),
    });
  }
  return plan;
}

/** Map an engine-scheduled Share-the-Pot trial type onto a partner (`error_round` -> error-prone). */
export function partnerForTrialType(
  trialType: string,
): { readonly partnerType: ScriptedPartnerType; readonly errorRound: boolean } | null {
  switch (trialType) {
    case 'cooperative':
      return { partnerType: 'cooperative', errorRound: false };
    case 'free_rider':
      return { partnerType: 'free_rider', errorRound: false };
    case 'error_round':
      return { partnerType: 'error_prone', errorRound: true };
    case 'conditional_cooperator':
      return { partnerType: 'conditional_cooperator', errorRound: false };
    default:
      return null;
  }
}

/* ------------------------------------------------------------------------------------------------
 * Accounting
 * ---------------------------------------------------------------------------------------------- */

export interface RoundSettlement {
  readonly endowment: number;
  readonly playerContributed: number;
  readonly partnerContributed: number;
  readonly pot: number;
  readonly multipliedPot: number;
  /** Tokens returned to EACH player (floored equal split). */
  readonly returnEach: number;
  /** Remainder of the floored split (kept by the stall; 0 with the default multiplier). */
  readonly houseTokens: number;
  readonly playerRoundTotal: number;
  readonly partnerRoundTotal: number;
}

/** Settle one round in whole tokens. */
export function settleRound(
  endowment: number,
  player: number,
  partner: number,
  multiplier: number,
): RoundSettlement {
  for (const [name, v] of [
    ['endowment', endowment],
    ['player', player],
    ['partner', partner],
  ] as const) {
    if (!Number.isInteger(v) || v < 0)
      throw new ParadigmConfigError(PARADIGM, `${name} must be a whole token count`);
  }
  if (player > endowment || partner > endowment) {
    throw new ParadigmConfigError(PARADIGM, 'a contribution cannot exceed the endowment');
  }
  if (!(multiplier > 0)) throw new ParadigmConfigError(PARADIGM, 'multiplier must be positive');
  const pot = player + partner;
  const multiplied = pot * multiplier;
  const returnEach = Math.floor(multiplied / 2);
  return {
    endowment,
    playerContributed: player,
    partnerContributed: partner,
    pot,
    multipliedPot: multiplied,
    returnEach,
    houseTokens: multiplied - 2 * returnEach,
    playerRoundTotal: endowment - player + returnEach,
    partnerRoundTotal: endowment - partner + returnEach,
  };
}

/** Result of one played round, with the event payloads. */
export interface PlayedRound {
  readonly round: number;
  readonly partner: PartnerDecision;
  readonly settlement: RoundSettlement;
  readonly contribution: ContributionPayload;
  readonly partnerAction: PartnerActionPayload;
}

/** A public-goods game against scripted partners. */
export class PublicGoodsGame {
  readonly endowment: number;
  readonly multiplier: number;
  private readonly params: PartnerPolicyParams;
  private readonly history: number[] = [];
  private readonly rounds: PlayedRound[] = [];

  constructor(options: {
    readonly endowment: number;
    readonly multiplier: number;
    readonly partner: PartnerPolicyParams;
  }) {
    if (!Number.isInteger(options.endowment) || options.endowment < 1) {
      throw new ParadigmConfigError(
        PARADIGM,
        `endowment must be a positive whole token count, got ${options.endowment}`,
      );
    }
    this.endowment = options.endowment;
    this.multiplier = options.multiplier;
    this.params = options.partner;
  }

  /**
   * Play a round. The partner decides from the history BEFORE seeing this round's contribution
   * (simultaneous move); the reveal shows both piles.
   */
  playRound(
    plan: { readonly partnerType: ScriptedPartnerType; readonly errorRound: boolean },
    playerTokens: number,
    options: { readonly unprompted: boolean },
    rng: SeededRng,
  ): PlayedRound {
    if (!Number.isInteger(playerTokens) || playerTokens < 0 || playerTokens > this.endowment) {
      throw new ParadigmStateError(
        PARADIGM,
        `player contribution ${playerTokens} outside 0..${this.endowment}`,
      );
    }
    const round = this.rounds.length;
    const policy = createPartnerPolicy(plan.partnerType, this.params);
    const partner = policy.decide(
      {
        round,
        endowment: this.endowment,
        playerHistory: [...this.history],
        errorRound: plan.errorRound,
      },
      rng.stream(`partner.${round}`),
    );
    const settlement = settleRound(this.endowment, playerTokens, partner.tokens, this.multiplier);
    this.history.push(playerTokens);
    const played: PlayedRound = {
      round,
      partner,
      settlement,
      contribution: {
        round,
        endowment_tokens: this.endowment,
        contributed_tokens: playerTokens,
        partner_contributed_tokens: partner.tokens,
        pot_return_tokens: settlement.returnEach,
        unprompted: options.unprompted,
      },
      partnerAction: {
        partner_type: partner.partnerType,
        policy_id: partner.policyId,
        round,
        action: partner.action,
        tokens: partner.tokens,
        is_error: partner.isError,
      },
    };
    this.rounds.push(played);
    return played;
  }

  log(): readonly PlayedRound[] {
    return this.rounds;
  }
}

/** Endowment for a module: `constraints.endowment_tokens`, else the fuel-pot default. */
export function endowmentFromConfig(config: GameConfig): Resolved<number> {
  const v = constraintNumber(config, 'endowment_tokens');
  if (v !== null) return { value: v, source: 'constraints', key: 'endowment_tokens' };
  return {
    value: PUBLIC_GOODS_DEFAULTS.fuelEndowmentTokens,
    source: 'paradigm_default',
    key: 'PUBLIC_GOODS_DEFAULTS.fuelEndowmentTokens',
  };
}

/** Pot multiplier: `constraints.pot_multiplier`, else the default. */
export function multiplierFromConfig(config: GameConfig): Resolved<number> {
  const v = constraintNumber(config, 'pot_multiplier');
  if (v !== null) return { value: v, source: 'constraints', key: 'pot_multiplier' };
  return {
    value: PUBLIC_GOODS_DEFAULTS.potMultiplier,
    source: 'paradigm_default',
    key: 'PUBLIC_GOODS_DEFAULTS.potMultiplier',
  };
}

/** Share-the-Pot round-plan options from the config (`planned_counts`, `error_round_window`). */
export function sharePotPlanOptions(config: GameConfig): {
  readonly rounds: number;
  readonly freeRiderRounds: number;
  readonly errorRounds: number;
  readonly errorWindow: readonly [number, number];
} {
  const rounds = config.planned_counts.rounds;
  const fr = config.planned_counts.free_rider_rounds;
  const er = config.planned_counts.error_rounds;
  const w = constraintWindow(config, 'error_round_window');
  if (rounds === undefined || fr === undefined || er === undefined || !w) {
    throw new ParadigmConfigError(
      PARADIGM,
      'planned_counts.rounds/free_rider_rounds/error_rounds and error_round_window are required',
    );
  }
  return { rounds, freeRiderRounds: fr, errorRounds: er, errorWindow: w };
}

/**
 * Road Home fuel pot plan: a conditional-cooperator partner with one scripted error round placed
 * (seeded) away from the first and last rounds.
 */
export function fuelPotPlan(rounds: number, rng: SeededRng): RoundPlanEntry[] {
  if (rounds < 3) throw new ParadigmConfigError(PARADIGM, 'fuel pot needs at least 3 rounds');
  const err = rng.int(1, rounds - 2);
  return Array.from({ length: rounds }, (_, r) => ({
    round: r,
    partnerType: r === err ? ('error_prone' as const) : ('conditional_cooperator' as const),
    errorRound: r === err,
  }));
}

/**
 * Scheduler override generator for Share-the-Pot: partner params per round from the engine's trial
 * type (`cooperative`, `free_rider`, `error_round`) plus the endowment.
 */
export const sharePotOverrides: TrialOverrideGenerator = ({ trial, config }) => {
  const partner = partnerForTrialType(trial.trial_type);
  if (!partner) return {};
  const endowment = endowmentFromConfig(config);
  return {
    params: {
      partner_type: partner.partnerType,
      policy_id: `${partner.partnerType}.v1`,
      error_round: partner.errorRound,
      endowment_tokens: endowment.value,
      endowment_source: endowment.source,
    },
  };
};

export const PUBLIC_GOODS_INDICATORS: readonly IndicatorBinding[] = [
  {
    moduleId: 'share_pot',
    indicators: [
      'teamwork.mean_contribution',
      'teamwork.response_to_partner_defection',
      'teamwork.response_to_partner_error',
      'initiative.unprompted_share',
      'decisiveness.reversals_before_confirm',
      'emotional_regulation.tone_after_unfair_loss_b',
    ],
  },
  {
    moduleId: 'road_home',
    indicators: [
      'teamwork.mean_contribution',
      'teamwork.response_to_partner_defection',
      'teamwork.response_to_partner_error',
    ],
  },
];
