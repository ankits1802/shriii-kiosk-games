/**
 * MG-07 Wait-or-Now (delay and effort discounting) at the halwai's sweet counter.
 *
 * Delay block: two brass plates on the counter. One holds a few laddoos ready NOW (open plate, warm
 * steam); the other holds the full plate under a glass cloche with a chain of sun-and-moon tokens over
 * it (that many days and nights to wait). Effort block: a few laddoos for nothing, or the full plate
 * for churning the butter pot (hold-to-earn: press and hold the churn handle while the butter rises).
 * Amounts are pictured laddoos; no numerals anywhere (ENG-11).
 *
 * Titration: `paradigms/discounting.ts` seeded bisection ladders (one track per delay, one per hold
 * duration). Offers are filled in at run time and logged in `GameTrialSpec.params` with the scoring
 * keys (`ss_amount, ss_delay, ll_amount, ll_delay` / `easy_amount, easy_effort, hard_amount,
 * hard_effort`). A timeout (no choice inside `choice_window_ms`) leaves its ladder unchanged.
 *
 * Hold-to-earn: after a `hard` choice the churn pad opens inside the same trial; the input layer logs
 * `input.hold` (`hold_ms`, `required_hold_ms = hold_required_ms x multiplier`, `completed`) on the
 * trial-scoped logger, which `persistence.effort_completion_rate` reads. Letting go early is never
 * shamed: the churn simply rests and the halwai keeps the plate.
 */
import type { GameConfig } from '@shriii/contracts';
import config from '../../../../../../content/games/pathway-b/wait-or-now.json' with {
  type: 'json',
};
import type { ModuleContext, TargetHandle } from '../../core/contracts.ts';
import {
  type DelayChoice,
  DelayDiscountingLadder,
  type DelayOffer,
  delayLadderConfig,
  type EffortChoice,
  EffortDiscountingLadder,
  type EffortOffer,
  effortLadderConfig,
  type Side,
} from '../../paradigms/discounting.ts';
import { timing } from '../dont-tap/kit/blocks.ts';
import { centreOf } from '../dont-tap/kit/bot.ts';
import { MicroGame, type MicroGameOptions } from '../dont-tap/kit/micro-game.ts';
import type { ActiveTrial } from '../dont-tap/kit/trial.ts';
import { type KitInput, type PlannedBlock, registerDisabledTarget } from '../dont-tap/kit/types.ts';
import { waitOrNowGeometry } from './geometry.ts';
import { WaitOrNowView } from './WaitOrNowView.ts';

const STATIC_CONFIG = config as unknown as GameConfig;

/** Pacing (presentation only; never part of a response window). */
const PACE = {
  /** Halwai lays out the next plates before the offer appears. */
  layOutMs: 500,
  /** Savouring a choice (sweets into the basket / parcel to the shelf). */
  afterChoiceMs: 1100,
  /** After a choice window closed without a choice. */
  afterTimeoutMs: 700,
  /** Between the hard choice and the churn opening. */
  toChurnMs: 350,
  /** After a completed / released hold. */
  afterHoldMs: 1000,
} as const;

/** What one plate pictures. */
export interface PlateSpec {
  readonly amount: number;
  /** `now`: open plate; `wait`: cloche + sun/moon chain of `delay` days; `easy`/`hard`: effort pair. */
  readonly kind: 'now' | 'wait' | 'easy' | 'hard';
  /** Delay in sun/moon cycles (wait plates). */
  readonly delay: number;
}

/** One offer as the view draws it. */
export interface OfferPicture {
  readonly left: PlateSpec;
  readonly right: PlateSpec;
  readonly block: 'delay' | 'effort';
}

/** View surface the logic drives. */
export interface WaitOrNowViewSurface {
  /** Synchronously draw both plates (called inside the frame-committed stimulus render). */
  showOffer(offer: OfferPicture): void;
  /** Acknowledge a choice (null = no choice in time) without any outcome judgement. */
  chosen(side: Side | null, offer: OfferPicture): Promise<void>;
  /** Bring the churn forward for a hold of `requiredMs`. */
  showChurn(requiredMs: number): void;
  /** The finger came down on the churn. */
  churnStart(): void;
  /** The hold ended (completed or let go) or never started (null). */
  churnEnd(result: { readonly completed: boolean; readonly heldMs: number } | null): Promise<void>;
  /** Before an offer: the halwai reaches for the next plates (no stimulus yet). */
  layOut(): void;
  /** Between blocks: light and props for the block (delay at golden hour, effort at dusk). */
  enterBlock(block: 'delay' | 'effort'): Promise<void>;
  /** Practice coaching: hand hint over the plates, or over the churn (hold). */
  practiceHint(target: 'plates' | 'churn' | null): void;
}

/** Parameter echo (where an offer's amounts came from) for audit, never shown. */
interface LadderSources {
  readonly ll: string;
  readonly delays: string;
  readonly hard: string;
  readonly holds: string;
}

export class WaitOrNowModule extends MicroGame<WaitOrNowView> {
  private leftT: TargetHandle | null = null;
  private rightT: TargetHandle | null = null;
  private churnT: TargetHandle | null = null;
  private delayLadder: DelayDiscountingLadder | null = null;
  private effortLadder: EffortDiscountingLadder | null = null;
  private sources: LadderSources = { ll: '', delays: '', hard: '', holds: '' };

  constructor(options: MicroGameOptions = {}) {
    super(STATIC_CONFIG, options);
  }

  protected createView(ctx: ModuleContext): WaitOrNowView {
    return new WaitOrNowView(ctx);
  }

  protected async prepare(ctx: ModuleContext): Promise<void> {
    const dCfg = delayLadderConfig(ctx.config);
    const eCfg = effortLadderConfig(ctx.config, ctx.level);
    this.delayLadder = new DelayDiscountingLadder(dCfg, ctx.rng.stream('wait_or_now.delay'));
    this.effortLadder = new EffortDiscountingLadder(eCfg, ctx.rng.stream('wait_or_now.effort'));
    this.sources = {
      ll: `${dCfg.llAmount.source}:${dCfg.llAmount.key}`,
      delays: `${dCfg.delays.source}:${dCfg.delays.key}`,
      hard: `${eCfg.hardAmount.source}:${eCfg.hardAmount.key}`,
      holds: `${eCfg.holdMs.source}:${eCfg.holdMs.key}`,
    };
    const delayBlock = this.block('delay');
    const effortBlock = this.block('effort');
    if (this.delayLadder.trials !== delayBlock.trials) {
      throw new Error(
        `wait_or_now: delay ladder has ${this.delayLadder.trials} steps, block wants ${delayBlock.trials}`,
      );
    }
    if (this.effortLadder.plan.length !== effortBlock.trials) {
      throw new Error(
        `wait_or_now: effort ladder has ${this.effortLadder.plan.length} steps, block wants ${effortBlock.trials}`,
      );
    }
    const g = waitOrNowGeometry(ctx.layout);
    const input = ctx.input;
    this.leftT = registerDisabledTarget(input, {
      id: 'wait_or_now.left',
      bounds: g.left,
      audioKey: 'wait_or_now.replay',
      kind: 'tap',
    });
    this.rightT = registerDisabledTarget(input, {
      id: 'wait_or_now.right',
      bounds: g.right,
      audioKey: 'wait_or_now.replay',
      kind: 'tap',
    });
    this.churnT = registerDisabledTarget(input, {
      id: 'wait_or_now.churn',
      bounds: g.churn,
      audioKey: 'wait_or_now.replay',
      kind: 'hold',
    });
    this.registerProbeTargets();
  }

  protected disposeTargets(): void {
    for (const t of [this.leftT, this.rightT, this.churnT]) t?.remove();
    this.leftT = null;
    this.rightT = null;
    this.churnT = null;
  }

  protected async play(): Promise<void> {
    await this.playIntro();
    this.markPhase('practice', { blockId: 'practice' });
    await this.say('wait_or_now.practice');
    await this.runPractice();

    const delay = this.block('delay');
    await this.view.enterBlock('delay');
    this.markPhase('main', { blockId: 'delay' });
    const dl = this.delayLadder as DelayDiscountingLadder;
    for (let i = 0; !dl.done && i < delay.trials; i += 1) {
      this.checkAbort();
      await this.runDelayTrial(delay, i, dl.nextOffer(), false);
    }

    const effort = this.block('effort');
    this.markPhase('main', { blockId: 'effort' });
    await this.view.enterBlock('effort');
    const el = this.effortLadder as EffortDiscountingLadder;
    for (let i = 0; !el.done && i < effort.trials; i += 1) {
      this.checkAbort();
      await this.runEffortTrial(effort, i, el.nextOffer());
    }
    this.rec.releaseRouting();
    await this.runProbeBlock();
    await this.playOutro();
  }

  /* ---------------------------------------------------------------------------------------------- */

  private get choiceWindowMs(): number {
    return timing(this.ctx.config, this.ctx.level, 'choice_window_ms');
  }

  /**
   * Practice: one delay-style choice that never touches the ladders (fixed amounts from the config),
   * with the hand hint over the plates. Unscored.
   */
  private async runPractice(): Promise<void> {
    const block = this.block('practice');
    const dl = this.delayLadder as DelayDiscountingLadder;
    const c = this.ctx.config.constraints;
    const ss =
      typeof c.practice_ss_amount === 'number'
        ? c.practice_ss_amount
        : Math.max(1, Math.round(dl.llAmount * 0.3));
    const d =
      typeof c.practice_delay_cycles === 'number' ? c.practice_delay_cycles : Math.min(...dl.plan);
    const side: Side = this.ctx.rng.stream('wait_or_now.practice').bool() ? 'left' : 'right';
    const offer: DelayOffer = {
      step: -1,
      ssAmount: ss,
      ssDelay: 0,
      llAmount: dl.llAmount,
      llDelay: d,
      ssSide: side,
    };
    await this.runDelayTrial(block, 0, offer, true);
  }

  private delayPicture(o: DelayOffer): OfferPicture {
    const now: PlateSpec = { amount: o.ssAmount, kind: 'now', delay: 0 };
    const wait: PlateSpec = { amount: o.llAmount, kind: 'wait', delay: o.llDelay };
    return {
      left: o.ssSide === 'left' ? now : wait,
      right: o.ssSide === 'left' ? wait : now,
      block: 'delay',
    };
  }

  private effortPicture(o: EffortOffer): OfferPicture {
    const easy: PlateSpec = { amount: o.easyAmount, kind: 'easy', delay: 0 };
    const hard: PlateSpec = { amount: o.hardAmount, kind: 'hard', delay: 0 };
    return {
      left: o.easySide === 'left' ? easy : hard,
      right: o.easySide === 'left' ? hard : easy,
      block: 'effort',
    };
  }

  /** Present an offer, wait for a plate within the choice window; returns the chosen side or null. */
  private async choose(
    picture: OfferPicture,
    trial: ActiveTrial,
    botPick: (() => Side) | null,
    isPractice: boolean,
  ): Promise<{
    side: Side | null;
    latencyMs: number | null;
    xy: readonly [number, number] | null;
  }> {
    const left = this.leftT;
    const right = this.rightT;
    if (!left || !right) throw new Error('wait_or_now: targets missing');
    const window = this.choiceWindowMs;
    const onset = await trial.present(
      () => {
        this.view.showOffer(picture);
        left.setEnabled(true);
        right.setEnabled(true);
      },
      { durationMs: window, version: `wait_or_now.${picture.block}.1` },
    );
    if (isPractice) this.view.practiceHint('plates');
    if (this.bot && botPick) {
      const g = waitOrNowGeometry(this.ctx.layout);
      const side = botPick();
      const at = centreOf(side === 'left' ? g.left : g.right);
      void this.bot.tapAfter(
        at,
        Math.min(window * 0.8, this.bot.latency(this.bot.persona.thinkMs, 450)),
      );
    }
    const r = await this.ctx.input.waitForTap([left.id, right.id], {
      anchorMs: onset.presentedOnsetMs,
      windowMs: window,
      signal: this.ctx.signal,
    });
    left.setEnabled(false);
    right.setEnabled(false);
    this.bot?.cancelAll();
    this.view.practiceHint(null);
    this.checkAbort();
    if (r.kind !== 'tap') return { side: null, latencyMs: null, xy: null };
    return {
      side: r.tap.targetId === left.id ? 'left' : 'right',
      latencyMs: r.latencyMs,
      xy: r.tap.xyNorm,
    };
  }

  private async runDelayTrial(
    block: PlannedBlock,
    i: number,
    offer: DelayOffer,
    isPractice: boolean,
  ): Promise<void> {
    const dl = this.delayLadder as DelayDiscountingLadder;
    const picture = this.delayPicture(offer);
    this.view.layOut();
    await this.wait(PACE.layOutMs);
    const spec = this.trialBase(block, i, {
      trialType: 'delay_choice',
      stimulusId: `wait_or_now.delay.${offer.llDelay}`,
      responseWindowMs: this.choiceWindowMs,
      expectedResponse: null,
      variant: offer.llDelay,
      params: {
        ss_amount: offer.ssAmount,
        ss_delay: offer.ssDelay,
        ll_amount: offer.llAmount,
        ll_delay: offer.llDelay,
        ss_side: offer.ssSide,
        ladder_step: offer.step,
        delay_units: 'sun_moon_cycles',
        ll_amount_source: this.sources.ll,
        delays_source: this.sources.delays,
        ...(isPractice ? { practice_fixed_offer: true } : {}),
      },
    });
    const trial = this.rec.begin(spec);
    this.markPhase(isPractice ? 'practice' : 'main', {
      trialIndex: spec.trialIndex,
      blockId: block.blockId,
    });
    const botPick = this.bot ? () => this.botDelaySide(offer) : null;
    const r = await this.choose(picture, trial, botPick, isPractice);
    const choice: DelayChoice | null =
      r.side === null ? null : r.side === offer.ssSide ? 'now' : 'wait';
    trial.respond({ value: choice, correctness: null, latencyMs: r.latencyMs, touchXyNorm: r.xy });
    if (!isPractice) dl.record(choice);
    trial.end(choice ? 'not_applicable' : 'timeout', null, choice ? 1 : 0);
    if (choice) this.ctx.audio.playSfx(choice === 'now' ? 'jar_fill' : 'chime', { volume: 0.5 });
    await Promise.all([
      this.view.chosen(r.side, picture),
      this.wait(choice ? PACE.afterChoiceMs : PACE.afterTimeoutMs),
    ]);
    trial.release();
  }

  private async runEffortTrial(block: PlannedBlock, i: number, offer: EffortOffer): Promise<void> {
    const el = this.effortLadder as EffortDiscountingLadder;
    const picture = this.effortPicture(offer);
    this.view.layOut();
    await this.wait(PACE.layOutMs);
    const spec = this.trialBase(block, i, {
      trialType: 'effort_choice',
      stimulusId: `wait_or_now.effort.${offer.hardEffortMs}`,
      responseWindowMs: this.choiceWindowMs,
      expectedResponse: null,
      variant: offer.hardEffortMs,
      params: {
        easy_amount: offer.easyAmount,
        easy_effort: offer.easyEffortMs / 1000,
        hard_amount: offer.hardAmount,
        hard_effort: offer.hardEffortMs / 1000,
        easy_side: offer.easySide,
        ladder_step: offer.step,
        required_hold_ms: offer.hardEffortMs,
        hard_amount_source: this.sources.hard,
        hold_source: this.sources.holds,
      },
    });
    const trial = this.rec.begin(spec);
    this.markPhase('main', { trialIndex: spec.trialIndex, blockId: block.blockId });
    const botPick = this.bot ? () => this.botEffortSide(offer) : null;
    const r = await this.choose(picture, trial, botPick, false);
    const choice: EffortChoice | null =
      r.side === null ? null : r.side === offer.easySide ? 'easy' : 'hard';
    trial.respond({ value: choice, correctness: null, latencyMs: r.latencyMs, touchXyNorm: r.xy });
    el.record(choice);
    if (choice === 'hard') {
      await Promise.all([this.view.chosen(r.side, picture), this.wait(PACE.toChurnMs)]);
      const hold = await this.runHold(offer.hardEffortMs);
      if (hold) el.recordHold(hold.heldMs);
      trial.end('not_applicable', null, hold ? 2 : 1);
      await Promise.all([this.view.churnEnd(hold), this.wait(PACE.afterHoldMs)]);
    } else {
      trial.end(choice ? 'not_applicable' : 'timeout', null, choice ? 1 : 0);
      if (choice) this.ctx.audio.playSfx('jar_fill', { volume: 0.5 });
      await Promise.all([
        this.view.chosen(r.side, picture),
        this.wait(choice ? PACE.afterChoiceMs : PACE.afterTimeoutMs),
      ]);
    }
    trial.release();
  }

  /**
   * Hold-to-earn inside the open effort trial. The hold must start within the choice window; once
   * started it ends on release (the input layer logs `input.hold`). A safety stop ends a hold that is
   * still going long after completion (a resting hand) and logs the same `input.hold` record.
   */
  private async runHold(
    requiredMs: number,
  ): Promise<{ completed: boolean; heldMs: number } | null> {
    const pad = this.churnT;
    if (!pad) throw new Error('wait_or_now: churn target missing');
    const ctx = this.ctx;
    const input = ctx.input as KitInput & { onActivity?: (l: (tMs: number) => void) => () => void };
    this.view.showChurn(requiredMs);
    pad.setEnabled(true);
    let holdStartMs: number | null = null;
    const g = waitOrNowGeometry(ctx.layout);
    const offActivity = input.onActivity?.((tMs) => {
      if (holdStartMs !== null) return;
      holdStartMs = tMs;
      this.view.churnStart();
    });
    const stop = new AbortController();
    const onAbort = (): void => stop.abort();
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    if (this.bot) {
      const bot = this.bot;
      const finish = bot.chance(Math.min(0.97, 0.45 + 0.5 * bot.persona.patience));
      const holdMs = finish
        ? requiredMs + bot.latency(260, 80)
        : requiredMs * (0.3 + 0.5 * bot.rng.next());
      void bot.holdAfter(centreOf(g.churn), bot.latency(650, 300), holdMs);
    }
    const safetyMs = this.choiceWindowMs + requiredMs + 2500;
    let safetyFired = false;
    const safety = ctx.clock.delay(safetyMs, stop.signal).then(
      () => {
        safetyFired = true;
        stop.abort();
      },
      () => undefined,
    );
    const r = await input.waitForHold(pad.id, {
      requiredMs,
      windowMs: this.choiceWindowMs,
      signal: stop.signal,
    });
    stop.abort();
    void safety;
    ctx.signal.removeEventListener('abort', onAbort);
    offActivity?.();
    pad.setEnabled(false);
    this.bot?.cancelAll();
    this.checkAbort();
    if (r.kind === 'hold') return { completed: r.completed, heldMs: r.holdMs };
    if (r.kind === 'aborted' && safetyFired && holdStartMs !== null) {
      // Still pressing well past completion: close the hold as completed (same record the input layer writes).
      const heldMs = Math.max(requiredMs, ctx.clock.now() - (holdStartMs as number));
      this.rec.current?.log.log('input.hold', {
        target_id: pad.id,
        hold_ms: Math.round(heldMs * 1000) / 1000,
        required_hold_ms: requiredMs,
        completed: true,
      });
      return { completed: true, heldMs };
    }
    return null;
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Scripted player (headless): hyperbolic chooser around a persona-specific k.                    */
  /* ---------------------------------------------------------------------------------------------- */

  private botDelaySide(o: DelayOffer): Side {
    const bot = this.bot;
    if (!bot) return 'left';
    const k = Math.exp(-3.5 + 3 * (1 - bot.persona.patience));
    const vWait = o.llAmount / (1 + k * o.llDelay);
    const p = 1 / (1 + Math.exp(-(vWait - o.ssAmount) * 1.2));
    const wait = bot.chance(p);
    return wait === (o.ssSide === 'left') ? 'right' : 'left';
  }

  private botEffortSide(o: EffortOffer): Side {
    const bot = this.bot;
    if (!bot) return 'left';
    const c = 0.15 + 0.5 * (1 - bot.persona.patience);
    const vHard = o.hardAmount - c * (o.hardEffortMs / 1000) * 2;
    const p = 1 / (1 + Math.exp(-(vHard - o.easyAmount) * 1.2));
    const hard = bot.chance(p);
    return hard === (o.easySide === 'left') ? 'right' : 'left';
  }
}

export function createWaitOrNow(options?: MicroGameOptions): WaitOrNowModule {
  return new WaitOrNowModule(options);
}
