/**
 * Delay and effort discounting choice ladders (MG-07 Wait-or-Now).
 *
 * Delay: "a little now" (smaller-sooner, SS, delay 0) versus "more after N sun/moon cycles"
 * (larger-later, LL). Effort: "a little, no effort" (easy) versus "more for holding the pad" (hard,
 * hold-to-earn). All amounts are integer pictured tokens (no numerals, ENG-11).
 *
 * Titration (`constraints.titration: seeded_bisection`): one independent integer bisection track per
 * delay (per hold multiplier for effort). Each track keeps an open bracket `(lo, hi)` around the
 * indifference amount, starting at `(0, LL)` with the offer at the midpoint:
 *
 * - choosing LL / hard means the SS / easy offer was too small: `lo = offer`;
 * - choosing SS / easy means it was big enough: `hi = offer`;
 * - next offer = `round((lo + hi) / 2)`, kept strictly inside the bracket while one exists;
 * - a timeout leaves the track unchanged (logged with `choice: null`).
 *
 * "Seeded" means the presentation order of the tracks (each pass of the delays is shuffled) and the
 * side on which the SS option appears are drawn from the module's SeededRng, so the ladder is
 * reproducible from the session seed. Every step is kept in {@link LadderEntry} for logging.
 *
 * The ladder is adaptive, so offered amounts are filled into the trial spec at run time with
 * {@link materialiseDelayTrial} / {@link materialiseEffortTrial} (params keys are the scoring
 * convention: `ss_amount, ss_delay, ll_amount, ll_delay` / `easy_amount, easy_effort, hard_amount,
 * hard_effort`).
 */
import type { CalibrationLevel, GameConfig, GameTrialSpec } from '@shriii/contracts';
import type { SeededRng } from '../core/contracts.ts';
import {
  constraintNumber,
  constraintNumbers,
  constraintString,
  type IndicatorBinding,
  ParadigmConfigError,
  ParadigmStateError,
  type Resolved,
  requireTiming,
} from './common.ts';
import { DELAY_LADDER_DEFAULTS, EFFORT_LADDER_DEFAULTS } from './content-defaults.ts';

const PARADIGM = 'discounting';

export type Side = 'left' | 'right';
export type DelayChoice = 'now' | 'wait';
export type EffortChoice = 'easy' | 'hard';

/** One step of a titration ladder (logged; replayable). */
export interface LadderEntry<C extends string> {
  readonly step: number;
  /** Track key (delay in cycles, or hold multiplier). */
  readonly track: number;
  readonly offeredAmount: number;
  readonly fixedAmount: number;
  readonly bracketBefore: readonly [number, number];
  readonly choice: C | null;
  readonly bracketAfter: readonly [number, number];
  /** Offer the track will make next time. */
  readonly nextAmount: number;
}

/** One integer bisection track. */
class BisectionTrack {
  lo: number;
  hi: number;
  offer: number;
  readonly max: number;
  constructor(max: number) {
    this.max = max;
    this.lo = 0;
    this.hi = max;
    this.offer = BisectionTrack.mid(0, max);
  }
  static mid(lo: number, hi: number): number {
    const m = Math.round((lo + hi) / 2);
    if (hi - lo >= 2) return Math.min(hi - 1, Math.max(lo + 1, m));
    return m;
  }
  /** `raise`: the offer was too small (the fixed option was preferred). */
  update(raise: boolean): void {
    if (raise) this.lo = this.offer;
    else this.hi = this.offer;
    this.offer = BisectionTrack.mid(this.lo, this.hi);
  }
}

/* ------------------------------------------------------------------------------------------------
 * Delay ladder
 * ---------------------------------------------------------------------------------------------- */

export interface DelayLadderConfig {
  readonly llAmount: Resolved<number>;
  readonly delays: Resolved<readonly number[]>;
  readonly repeats: Resolved<number>;
  readonly order: Resolved<'seeded' | 'fixed'>;
}

/** Ladder config from `constraints.delay_*` keys with documented content defaults. */
export function delayLadderConfig(config: GameConfig): DelayLadderConfig {
  const ll = constraintNumber(config, 'delay_ll_amount');
  const delays = constraintNumbers(config, 'delay_cycles');
  const repeats = constraintNumber(config, 'delay_repeats');
  const order = constraintString(config, 'delay_order');
  return {
    llAmount:
      ll !== null
        ? { value: ll, source: 'constraints', key: 'delay_ll_amount' }
        : {
            value: DELAY_LADDER_DEFAULTS.llAmount,
            source: 'paradigm_default',
            key: 'DELAY_LADDER_DEFAULTS.llAmount',
          },
    delays:
      delays !== null
        ? { value: delays, source: 'constraints', key: 'delay_cycles' }
        : {
            value: DELAY_LADDER_DEFAULTS.delays,
            source: 'paradigm_default',
            key: 'DELAY_LADDER_DEFAULTS.delays',
          },
    repeats:
      repeats !== null
        ? { value: repeats, source: 'constraints', key: 'delay_repeats' }
        : {
            value: DELAY_LADDER_DEFAULTS.repeats,
            source: 'paradigm_default',
            key: 'DELAY_LADDER_DEFAULTS.repeats',
          },
    order:
      order === 'seeded' || order === 'fixed'
        ? { value: order, source: 'constraints', key: 'delay_order' }
        : {
            value: DELAY_LADDER_DEFAULTS.order,
            source: 'paradigm_default',
            key: 'DELAY_LADDER_DEFAULTS.order',
          },
  };
}

/** A delay offer for one trial. */
export interface DelayOffer {
  readonly step: number;
  readonly ssAmount: number;
  readonly ssDelay: 0;
  readonly llAmount: number;
  readonly llDelay: number;
  /** Side the SS option is pictured on (seeded). */
  readonly ssSide: Side;
}

/** Seeded bisection ladder for delay discounting. */
export class DelayDiscountingLadder {
  /** Presentation order of delay tracks (length = trials). */
  readonly plan: readonly number[];
  readonly llAmount: number;
  private readonly tracks = new Map<number, BisectionTrack>();
  private readonly sides: readonly Side[];
  private readonly entries: LadderEntry<DelayChoice>[] = [];
  private step = 0;
  private pending: DelayOffer | null = null;

  constructor(cfg: DelayLadderConfig, rng: SeededRng) {
    const ll = cfg.llAmount.value;
    if (!Number.isInteger(ll) || ll < 2) {
      throw new ParadigmConfigError(
        PARADIGM,
        `LL amount must be an integer >= 2 tokens, got ${ll}`,
      );
    }
    const delays = cfg.delays.value;
    if (delays.length === 0 || delays.some((d) => !(d > 0))) {
      throw new ParadigmConfigError(PARADIGM, 'delays must be a non-empty list of positive cycles');
    }
    if (new Set(delays).size !== delays.length)
      throw new ParadigmConfigError(PARADIGM, 'delays must be unique');
    const repeats = cfg.repeats.value;
    if (!Number.isInteger(repeats) || repeats < 1) {
      throw new ParadigmConfigError(PARADIGM, `repeats must be a positive integer, got ${repeats}`);
    }
    this.llAmount = ll;
    const orderRng = rng.stream('order');
    const plan: number[] = [];
    for (let pass = 0; pass < repeats; pass += 1) {
      plan.push(...(cfg.order.value === 'seeded' ? orderRng.shuffle(delays) : delays));
    }
    this.plan = plan;
    for (const d of delays) this.tracks.set(d, new BisectionTrack(ll));
    const sideRng = rng.stream('side');
    this.sides = plan.map(() => (sideRng.bool() ? 'left' : 'right'));
  }

  get done(): boolean {
    return this.step >= this.plan.length;
  }

  get trials(): number {
    return this.plan.length;
  }

  /** The offer for the next trial (idempotent until {@link record} is called). */
  nextOffer(): DelayOffer {
    if (this.done) throw new ParadigmStateError(PARADIGM, 'delay ladder is complete');
    if (this.pending) return this.pending;
    const delay = this.plan[this.step] as number;
    const track = this.tracks.get(delay) as BisectionTrack;
    this.pending = {
      step: this.step,
      ssAmount: track.offer,
      ssDelay: 0,
      llAmount: this.llAmount,
      llDelay: delay,
      ssSide: this.sides[this.step] as Side,
    };
    return this.pending;
  }

  /** Record the choice for the pending offer (`null` = timeout, no titration step). */
  record(choice: DelayChoice | null): LadderEntry<DelayChoice> {
    const offer = this.pending ?? this.nextOffer();
    const track = this.tracks.get(offer.llDelay) as BisectionTrack;
    const before: [number, number] = [track.lo, track.hi];
    if (choice !== null) track.update(choice === 'wait');
    const entry: LadderEntry<DelayChoice> = {
      step: offer.step,
      track: offer.llDelay,
      offeredAmount: offer.ssAmount,
      fixedAmount: offer.llAmount,
      bracketBefore: before,
      choice,
      bracketAfter: [track.lo, track.hi],
      nextAmount: track.offer,
    };
    this.entries.push(entry);
    this.pending = null;
    this.step += 1;
    return entry;
  }

  /** Every recorded step, in order. */
  log(): readonly LadderEntry<DelayChoice>[] {
    return this.entries;
  }

  /** Current bracket midpoint (indifference estimate) per delay; for research QA only, never shown. */
  indifferencePoints(): ReadonlyMap<number, number> {
    const out = new Map<number, number>();
    for (const [d, t] of this.tracks) out.set(d, (t.lo + t.hi) / 2);
    return out;
  }
}

/** Fill a scheduled delay trial with its offer (scoring param keys + layout). */
export function materialiseDelayTrial(spec: GameTrialSpec, offer: DelayOffer): GameTrialSpec {
  return {
    ...spec,
    trial_type: 'delay_choice',
    vocabulary: ['now', 'wait'],
    voice_vocabulary: spec.voice_vocabulary.length > 0 ? ['now', 'wait'] : [],
    expected_response: null,
    stimulus_id: `wait_or_now.delay.${offer.llDelay}`,
    params: {
      ...spec.params,
      ss_amount: offer.ssAmount,
      ss_delay: offer.ssDelay,
      ll_amount: offer.llAmount,
      ll_delay: offer.llDelay,
      ss_side: offer.ssSide,
      ladder_step: offer.step,
    },
  };
}

/* ------------------------------------------------------------------------------------------------
 * Effort ladder
 * ---------------------------------------------------------------------------------------------- */

export interface EffortLadderConfig {
  readonly hardAmount: Resolved<number>;
  /** Hold durations (ms) per track, from `hold_required_ms` x multiplier. */
  readonly holdMs: Resolved<readonly number[]>;
}

/** Effort ladder config: hold time from the level table (`hold_required_ms`), amounts from constraints/defaults. */
export function effortLadderConfig(
  config: GameConfig,
  level: CalibrationLevel,
): EffortLadderConfig {
  const base = requireTiming(PARADIGM, config, level, 'hold_required_ms');
  const hard = constraintNumber(config, 'effort_hard_amount');
  const mults = constraintNumbers(config, 'effort_hold_multipliers');
  return {
    hardAmount:
      hard !== null
        ? { value: hard, source: 'constraints', key: 'effort_hard_amount' }
        : {
            value: EFFORT_LADDER_DEFAULTS.hardAmount,
            source: 'paradigm_default',
            key: 'EFFORT_LADDER_DEFAULTS.hardAmount',
          },
    holdMs: {
      value: (mults ?? EFFORT_LADDER_DEFAULTS.holdMultipliers).map((m) => Math.round(base * m)),
      source: mults !== null ? 'constraints' : 'paradigm_default',
      key: mults !== null ? 'effort_hold_multipliers' : 'EFFORT_LADDER_DEFAULTS.holdMultipliers',
    },
  };
}

export interface EffortOffer {
  readonly step: number;
  readonly easyAmount: number;
  readonly easyEffortMs: 0;
  readonly hardAmount: number;
  readonly hardEffortMs: number;
  readonly easySide: Side;
}

/** Hold outcome for a chosen hard option (persistence.effort_completion_rate). */
export interface EffortHoldRecord {
  readonly step: number;
  readonly requiredMs: number;
  readonly heldMs: number;
  readonly completed: boolean;
}

/** Seeded bisection ladder for effort discounting (one track per distinct hold duration). */
export class EffortDiscountingLadder {
  readonly plan: readonly number[];
  readonly hardAmount: number;
  private readonly tracks = new Map<number, BisectionTrack>();
  private readonly sides: readonly Side[];
  private readonly entries: LadderEntry<EffortChoice>[] = [];
  private readonly holds: EffortHoldRecord[] = [];
  private step = 0;
  private pending: EffortOffer | null = null;
  private lastChoice: { step: number; choice: EffortChoice | null } | null = null;

  constructor(cfg: EffortLadderConfig, rng: SeededRng) {
    const hard = cfg.hardAmount.value;
    if (!Number.isInteger(hard) || hard < 2) {
      throw new ParadigmConfigError(
        PARADIGM,
        `hard amount must be an integer >= 2 tokens, got ${hard}`,
      );
    }
    const holds = cfg.holdMs.value;
    if (holds.length === 0 || holds.some((h) => !(h > 0))) {
      throw new ParadigmConfigError(PARADIGM, 'hold durations must be positive');
    }
    this.hardAmount = hard;
    this.plan = rng.stream('order').shuffle(holds);
    for (const h of new Set(holds)) this.tracks.set(h, new BisectionTrack(hard));
    const sideRng = rng.stream('side');
    this.sides = this.plan.map(() => (sideRng.bool() ? 'left' : 'right'));
  }

  get done(): boolean {
    return this.step >= this.plan.length;
  }

  nextOffer(): EffortOffer {
    if (this.done) throw new ParadigmStateError(PARADIGM, 'effort ladder is complete');
    if (this.pending) return this.pending;
    const holdMs = this.plan[this.step] as number;
    const track = this.tracks.get(holdMs) as BisectionTrack;
    this.pending = {
      step: this.step,
      easyAmount: track.offer,
      easyEffortMs: 0,
      hardAmount: this.hardAmount,
      hardEffortMs: holdMs,
      easySide: this.sides[this.step] as Side,
    };
    return this.pending;
  }

  record(choice: EffortChoice | null): LadderEntry<EffortChoice> {
    const offer = this.pending ?? this.nextOffer();
    const track = this.tracks.get(offer.hardEffortMs) as BisectionTrack;
    const before: [number, number] = [track.lo, track.hi];
    if (choice !== null) track.update(choice === 'hard');
    const entry: LadderEntry<EffortChoice> = {
      step: offer.step,
      track: offer.hardEffortMs,
      offeredAmount: offer.easyAmount,
      fixedAmount: offer.hardAmount,
      bracketBefore: before,
      choice,
      bracketAfter: [track.lo, track.hi],
      nextAmount: track.offer,
    };
    this.entries.push(entry);
    this.lastChoice = { step: offer.step, choice };
    this.pending = null;
    this.step += 1;
    return entry;
  }

  /** Record the hold that followed a `hard` choice on the most recent step. */
  recordHold(heldMs: number): EffortHoldRecord {
    const last = this.lastChoice;
    if (last?.choice !== 'hard') {
      throw new ParadigmStateError(PARADIGM, 'a hold is recorded only after a hard choice');
    }
    if (this.holds.some((h) => h.step === last.step)) {
      throw new ParadigmStateError(PARADIGM, `hold for step ${last.step} already recorded`);
    }
    const requiredMs = this.plan[last.step] as number;
    const rec: EffortHoldRecord = {
      step: last.step,
      requiredMs,
      heldMs,
      completed: heldMs >= requiredMs,
    };
    this.holds.push(rec);
    return rec;
  }

  log(): readonly LadderEntry<EffortChoice>[] {
    return this.entries;
  }

  holdLog(): readonly EffortHoldRecord[] {
    return this.holds;
  }
}

/** Fill a scheduled effort trial with its offer (`hard_effort`/`easy_effort` in seconds of holding). */
export function materialiseEffortTrial(spec: GameTrialSpec, offer: EffortOffer): GameTrialSpec {
  return {
    ...spec,
    trial_type: 'effort_choice',
    vocabulary: ['easy', 'hard'],
    voice_vocabulary: spec.voice_vocabulary.length > 0 ? ['easy', 'hard'] : [],
    expected_response: null,
    stimulus_id: `wait_or_now.effort.${offer.hardEffortMs}`,
    params: {
      ...spec.params,
      easy_amount: offer.easyAmount,
      easy_effort: offer.easyEffortMs / 1000,
      hard_amount: offer.hardAmount,
      hard_effort: offer.hardEffortMs / 1000,
      easy_side: offer.easySide,
      ladder_step: offer.step,
    },
  };
}

export const DISCOUNTING_INDICATORS: readonly IndicatorBinding[] = [
  {
    moduleId: 'wait_or_now',
    indicators: [
      'self_control.delay_discount_logk',
      'self_control.effort_discount',
      'self_control.choice_consistency',
      'persistence.effort_completion_rate',
    ],
  },
];
