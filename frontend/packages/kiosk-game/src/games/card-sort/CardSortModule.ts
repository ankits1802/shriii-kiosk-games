/**
 * MG-03 Card Sort: the fortune-teller's card tent, with an unannounced rule switch and a reversal.
 *
 * Four key cards lie on the table, each with a distinct colour+pattern (colour is never the only cue),
 * shape and pictured count. The teller draws a card; the player taps the pile it belongs with. The
 * only rule information is feedback: a bright chime with a nod and warm glow (matches the rule) or a
 * soft wooden "oops" with a gentle head tilt (does not) - never a buzzer, never a number.
 *
 * Rules (`constraints.dimensions`, per form): initial rule -> unannounced switch -> reversal back to
 * the initial rule (`rule_switch`, `rule_reversal` context shifts, `announced: false`). Switch timing
 * is contingent: after `switch_after_correct` consecutive correct sorts once the block's switch window
 * opens, or at the window's end (`switch_window` x block bounds x `context_shift.window`). Every
 * post-switch block keeps >= `min_counts.post_switch_per_switch` trials. Cards after a switch always
 * separate the new-rule pile from the previous-rule pile (informative trials).
 *
 * Scoring conventions: trial type `sort`, response `pile_1..4`, params `rule`, `previous_rule`,
 * `matches` (dimension -> pile).
 */
import type { GameConfig } from '@shriii/contracts';
import config from '../../../../../../content/games/pathway-b/card-sort.json' with { type: 'json' };
import type { ModuleContext, TargetHandle } from '../../core/contracts.ts';
import {
  type Card,
  COLOUR_PATTERNS,
  COUNTS,
  configDimensions,
  type Dimension,
  drawCard,
  type KeyCards,
  keyCardsForForm,
  matchesOf,
  PILES,
  type Pile,
  type RulePlan,
  rulePlanForForm,
  SHAPES,
} from '../../paradigms/card-sort.ts';
import { constraintNumber, constraintWindow } from '../../paradigms/common.ts';
import { timing } from '../dont-tap/kit/blocks.ts';
import { centreOf } from '../dont-tap/kit/bot.ts';
import { MicroGame, type MicroGameOptions } from '../dont-tap/kit/micro-game.ts';
import { type PlannedBlock, registerDisabledTarget } from '../dont-tap/kit/types.ts';
import { CardSortView } from './CardSortView.ts';
import { cardSortGeometry, pileRect } from './geometry.ts';

const STATIC_CONFIG = config as unknown as GameConfig;

/** Pictured card faces (art ids). */
export interface CardFace {
  readonly colourPattern: (typeof COLOUR_PATTERNS)[number];
  readonly shape: (typeof SHAPES)[number];
  readonly count: (typeof COUNTS)[number];
}

export function faceOf(card: Card): CardFace {
  return {
    colourPattern: COLOUR_PATTERNS[card.colour_pattern] as CardFace['colourPattern'],
    shape: SHAPES[card.shape] as CardFace['shape'],
    count: COUNTS[card.count] as CardFace['count'],
  };
}

/** View surface the logic drives. */
export interface CardSortViewSurface {
  dealKeys(keys: readonly CardFace[]): Promise<void>;
  showCard(face: CardFace): void;
  sortTo(pile: Pile, correct: boolean): Promise<void>;
  cardTimeout(): Promise<void>;
  hint(pile: Pile | null): void;
}

/** Contingent rule-block bounds: [lo, hi] trials before the block may end. */
interface RuleBlockPlan {
  readonly block: PlannedBlock;
  readonly rule: Dimension;
  readonly previousRule: Dimension | null;
  readonly lo: number;
  readonly hi: number;
  /** True for the last rule block (runs its planned length; no further switch). */
  readonly last: boolean;
  readonly shift: 'rule_switch' | 'rule_reversal' | null;
}

export class CardSortModule extends MicroGame<CardSortView> {
  private targets: TargetHandle[] = [];
  private keys: KeyCards | null = null;
  private plan: RulePlan | null = null;
  private ruleBlocks: RuleBlockPlan[] = [];
  private afterCorrect = 6;

  constructor(options: MicroGameOptions = {}) {
    super(STATIC_CONFIG, options);
  }

  protected createView(ctx: ModuleContext): CardSortView {
    return new CardSortView(ctx);
  }

  protected async prepare(ctx: ModuleContext): Promise<void> {
    const cfg = ctx.config;
    const dims = configDimensions(cfg);
    this.plan = rulePlanForForm(cfg.config_id, this.formId, dims);
    this.keys = keyCardsForForm(cfg.config_id, this.formId);
    this.afterCorrect = constraintNumber(cfg, 'switch_after_correct') ?? 6;
    const sw = constraintWindow(cfg, 'switch_window') ?? [1, Number.POSITIVE_INFINITY];
    const csw = cfg.context_shift?.window ?? null;
    const practiceLen = this.block('practice').trials;
    const postMin = cfg.min_counts.post_switch_per_switch ?? 0;
    const order = ['initial_rule', 'switch_1', 'reversal'] as const;
    const rules: [Dimension, Dimension | null][] = [
      [this.plan.initial, null],
      [this.plan.switched, this.plan.initial],
      [this.plan.initial, this.plan.switched],
    ];
    this.ruleBlocks = order.map((id, k) => {
      const b = this.block(id);
      let lo = Math.max(b.minTrials, sw[0], k > 0 ? postMin : 0);
      let hi = Math.min(b.trials, sw[1]);
      // The first switch must land inside the context-shift window (trial index of the first
      // post-switch trial = practice + initial block length).
      if (k === 0 && csw) {
        lo = Math.max(lo, csw[0] - practiceLen);
        hi = Math.min(hi, csw[1] - practiceLen);
      }
      if (lo > hi) throw new Error(`card_sort: block ${id} has no feasible switch position`);
      const [rule, previousRule] = rules[k] as [Dimension, Dimension | null];
      return {
        block: b,
        rule,
        previousRule,
        lo,
        hi,
        last: k === order.length - 1,
        shift: k === 1 ? 'rule_switch' : k === 2 ? 'rule_reversal' : null,
      };
    });
    const g = cardSortGeometry(ctx.layout);
    this.targets = PILES.map((pile, i) =>
      registerDisabledTarget(ctx.input, {
        id: `card_sort.${pile}`,
        bounds: g.piles[i] as NonNullable<(typeof g.piles)[number]>,
        audioKey: 'card_sort.replay',
        kind: 'tap',
      }),
    );
    this.registerProbeTargets();
  }

  protected disposeTargets(): void {
    for (const t of this.targets) t.remove();
    this.targets = [];
  }

  protected async play(): Promise<void> {
    const keys = this.keys;
    if (!keys) throw new Error('card_sort: play before prepare');
    await Promise.all([this.playIntro(), this.view.dealKeys(keys.map(faceOf))]);

    // Practice: the initial rule with feedback (never scorable).
    this.markPhase('practice', { blockId: 'practice' });
    await this.say('card_sort.practice');
    const practice = this.block('practice');
    const first = this.ruleBlocks[0] as RuleBlockPlan;
    for (let i = 0; i < practice.trials; i += 1) {
      await this.sortTrial(practice, i, first.rule, null, i === 0);
    }

    for (const [k, rb] of this.ruleBlocks.entries()) {
      this.markPhase(rb.shift ? 'shift' : 'main', { blockId: rb.block.blockId });
      // Work still required after this block: the protected minimum of every later rule block, the
      // probe segment and the outro. A block past its own minimum stops early when that would not fit.
      const laterMs =
        this.ruleBlocks.slice(k + 1).reduce((acc, b) => acc + b.lo * this.trialEstimateMs(), 0) +
        this.probeBlockEstimateMs() +
        this.ctx.config.budget.outro_ms;
      let streak = 0;
      for (let i = 0; ; i += 1) {
        this.checkAbort();
        if (rb.last) {
          if (i >= rb.block.trials) break;
          const remaining =
            this.probeBlockEstimateMs() + this.ctx.config.budget.outro_ms + this.trialEstimateMs();
          if (i >= rb.block.minTrials && this.trimDue(remaining)) break;
        } else {
          if (i >= rb.hi) break;
          if (
            i >= rb.lo &&
            (streak >= this.afterCorrect || this.trimDue(laterMs + this.trialEstimateMs()))
          )
            break;
        }
        const correct = await this.sortTrial(
          rb.block,
          i,
          rb.rule,
          rb.previousRule,
          false,
          i === 0 ? rb.shift : null,
        );
        streak = correct ? streak + 1 : 0;
        if (i === 0) this.markPhase('main', { blockId: rb.block.blockId });
      }
      this.rec.releaseRouting();
    }

    await this.runProbeBlock();
    await this.playOutro();
  }

  /** Expected duration of one sort (median response + feedback + ITI). */
  private trialEstimateMs(): number {
    const cfg = this.ctx.config;
    return (
      timing(cfg, this.ctx.level, 'response_window_ms') * 0.45 +
      timing(cfg, this.ctx.level, 'feedback_ms') +
      timing(cfg, this.ctx.level, 'iti_ms') +
      120
    );
  }

  /** One sort trial. Returns correctness. */
  private async sortTrial(
    block: PlannedBlock,
    i: number,
    rule: Dimension,
    previousRule: Dimension | null,
    showHint: boolean,
    shift: 'rule_switch' | 'rule_reversal' | null = null,
  ): Promise<boolean> {
    const keys = this.keys as KeyCards;
    const cfg = this.ctx.config;
    const level = this.ctx.level;
    const windowMs = timing(cfg, level, 'response_window_ms');
    const feedbackMs = timing(cfg, level, 'feedback_ms');
    const itiMs = timing(cfg, level, 'iti_ms');
    const card = drawCard(this.ctx.rng.stream(`card.${block.blockId}.${i}`), keys, {
      unambiguous: true,
      rule,
      previousRule,
    });
    const matches = matchesOf(card, keys);
    const face = faceOf(card);
    const spec = this.trialBase(block, i, {
      trialType: 'sort',
      stimulusId: `card_sort.card.${card.colour_pattern}${card.shape}${card.count}`,
      responseWindowMs: windowMs,
      expectedResponse: matches[rule],
      variant: card.colour_pattern * 16 + card.shape * 4 + card.count,
      params: {
        rule,
        previous_rule: previousRule,
        matches,
        card: { colour_pattern: face.colourPattern, shape: face.shape, pictured_count: face.count },
      },
    });
    if (shift) this.rec.shift(spec, shift, cfg.context_shift?.announced ?? false);
    const trial = this.rec.begin(spec);
    this.markPhase(block.phase === 'practice' ? 'practice' : 'main', {
      trialIndex: spec.trialIndex,
      blockId: block.blockId,
    });
    if (showHint) this.view.hint(matches[rule]);
    const onset = await trial.present(
      () => {
        this.view.showCard(face);
        for (const t of this.targets) t.setEnabled(true);
      },
      { durationMs: null, version: 'card_sort.card.1' },
    );
    if (this.bot) this.scheduleBot(matches, rule, previousRule, i, windowMs);
    const r = await this.ctx.input.waitForTap(
      this.targets.map((t) => t.id),
      { anchorMs: onset.presentedOnsetMs, windowMs, signal: this.ctx.signal },
    );
    for (const t of this.targets) t.setEnabled(false);
    if (showHint) this.view.hint(null);
    if (r.kind === 'aborted') {
      this.checkAbort();
      return false;
    }
    if (r.kind === 'timeout') {
      trial.respond({ value: null, correctness: false, latencyMs: null });
      trial.end('timeout', false, 0);
      this.bot?.cancelAll();
      await this.view.cardTimeout();
      await this.wait(itiMs);
      trial.release();
      return false;
    }
    const pile = PILES[this.targets.findIndex((t) => t.id === r.tap.targetId)] as Pile;
    const correct = matches[rule] === pile;
    trial.respond({
      value: pile,
      correctness: correct,
      latencyMs: r.latencyMs,
      touchXyNorm: r.tap.xyNorm,
    });
    trial.end(correct ? 'correct' : 'incorrect', correct, 1);
    this.bot?.cancelAll();
    // Feedback (feedback_ms) then the inter-trial interval (iti_ms); the next card never waits on art.
    void this.view.sortTo(pile, correct);
    this.ctx.audio.playSfx(correct ? 'correct' : 'incorrect', { volume: correct ? 0.7 : 0.55 });
    await this.wait(feedbackMs + itiMs);
    trial.release();
    return correct;
  }

  private scheduleBot(
    matches: Readonly<Record<Dimension, Pile>>,
    rule: Dimension,
    previousRule: Dimension | null,
    i: number,
    windowMs: number,
  ): void {
    const bot = this.bot;
    if (!bot) return;
    const p = bot.persona;
    let choice: Pile;
    const persev = previousRule ? 0.75 * Math.exp(-i / 2.5) : 0;
    if (previousRule && bot.chance(persev)) choice = matches[previousRule];
    else if (bot.chance(p.accuracy + 0.08)) choice = matches[rule];
    else choice = bot.rng.pick(PILES.filter((x) => x !== matches[rule]));
    const g = cardSortGeometry(this.ctx.layout);
    const delay = Math.min(windowMs - 150, bot.latency(p.thinkMs * 0.75, 380));
    void bot.tapAfter(centreOf(pileRect(g, choice)), delay);
  }
}

export function createCardSort(options?: MicroGameOptions): CardSortModule {
  return new CardSortModule(options);
}
