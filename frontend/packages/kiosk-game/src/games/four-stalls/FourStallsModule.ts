/**
 * MG-09 Four Stalls (IGT-lite): repeated choices among four fruit stalls with seeded pictorial payoffs,
 * plus repeated identical errands for response consistency.
 *
 * Own purchases: the player taps a stall; its next card from a fixed seeded deck pays out as mangoes
 * flying into the basket, and on loss cards a monkey snatches some back. Two stalls (drawn per session)
 * are high-variance: bigger gains, bigger occasional losses, lower expected value.
 * Errands: a villager brings the same request each time (same person, same wish, same stalls) and the
 * player picks a stall for them; nothing is paid to the player, so each repeat is the same situation.
 *
 * Measurement (scoring conventions): trial type `choice` in block `choices`, committed response
 * `stall_a..stall_d` (single tap, latency from the visual onset), window `choice_window_ms` exactly;
 * `params.high_variance_stalls` on every trial and `params.repeat_group_id` on errands; the realised
 * payoff (`gain`, `loss`, `net`) is added to the trial's params after the choice.
 */
import type { GameConfig } from '@shriii/contracts';
import type {
  ConstructId,
  GameModule,
  IndicatorId,
  ModuleContext,
  ModuleResult,
} from '../../core/contracts.ts';
import { BotHand, lognormalMs } from '../hub/kit/bot.ts';
import { runChoice } from '../hub/kit/choice.ts';
import { type ProbeGeometry, ProbeScene, probeGeometry, runProbeBlock } from '../hub/kit/probe.ts';
import { GameRuntime, type MicroGameHooks, ModuleAbortedError } from '../hub/kit/runtime.ts';
import { GameStage } from '../hub/kit/stage.ts';
import { TargetBoard } from '../hub/kit/targets.ts';
import { TrialRecorder } from '../hub/kit/trials.ts';
import { type FourStallsGeometry, fourStallsGeometry } from './geometry.ts';
import {
  buildFourStallsPlan,
  type FourStallsPlan,
  type FourStallsTrialPlan,
  STALL_CODES,
  type StallCode,
} from './plan.ts';
import { ERRAND_GOODS, FourStallsScene } from './scene.ts';

export const FOUR_STALLS_CONSTRUCTS: readonly ConstructId[] = [
  'decisiveness',
  'persistence_of_style',
  'response_consistency',
  'risk_preference',
  'stability',
];

export const FOUR_STALLS_INDICATORS: readonly IndicatorId[] = [
  'decisiveness.time_to_commit',
  'persistence_of_style.cross_segment_style_r',
  'persistence_of_style.lag1_autocorr',
  'response_consistency.choice_entropy_repeats',
  'response_consistency.loc_scale_sigma',
  'risk_preference.high_variance_stall_share',
  'stability.shift_slope',
];

const AUDIO = 'four_stalls.replay';
const targetId = (code: StallCode): string => `four_stalls.${code}`;

interface BotPersona {
  readonly temperature: number;
  readonly riskBias: number;
  readonly medianMs: number;
  readonly learning: number;
  readonly errandPrefs: Record<string, number[]>;
}

export class FourStallsModule implements GameModule {
  readonly id = 'four_stalls' as const;
  readonly kind = 'micro' as const;
  readonly constructs = FOUR_STALLS_CONSTRUCTS;
  readonly indicators = FOUR_STALLS_INDICATORS;
  private rt: GameRuntime | null = null;
  private rec: TrialRecorder | null = null;
  private board: TargetBoard | null = null;
  private plan: FourStallsPlan | null = null;
  private geo: FourStallsGeometry | null = null;
  private probeGeo: ProbeGeometry | null = null;
  private stage: GameStage | null = null;
  private scene: FourStallsScene | null = null;
  private bot: BotHand | null = null;
  private persona: BotPersona | null = null;
  private readonly picks: Record<StallCode, number> = {
    stall_a: 0,
    stall_b: 0,
    stall_c: 0,
    stall_d: 0,
  };
  private readonly practicePicks: Record<StallCode, number> = {
    stall_a: 0,
    stall_b: 0,
    stall_c: 0,
    stall_d: 0,
  };
  private readonly values: Record<StallCode, number> = {
    stall_a: 0,
    stall_b: 0,
    stall_c: 0,
    stall_d: 0,
  };
  private startMs = 0;

  constructor(private readonly hooks: MicroGameHooks = {}) {}

  async init(ctx: ModuleContext<GameConfig>): Promise<void> {
    const rt = new GameRuntime(ctx, this.id, this.hooks);
    this.rt = rt;
    this.rec = new TrialRecorder(rt);
    this.board = new TargetBoard(ctx.input);
    const choices = rt.block('choices').trials;
    this.plan = buildFourStallsPlan(ctx.config, ctx.rng.stream('plan'), choices);
    this.geo = fourStallsGeometry(ctx.layout);
    this.probeGeo = probeGeometry(ctx.layout);
    for (const k of ['choice_window_ms', 'payoff_ms', 'errand_ms', 'iti_ms', 'probe_window_ms'])
      rt.timing(k);
    if (rt.visual) {
      this.stage = new GameStage(rt, { sceneId: 'market_square', timeOfDay: 'midday' });
      this.scene = new FourStallsScene(this.stage, this.geo);
    }
    if (rt.bot) {
      this.bot = new BotHand(rt, this.board);
      const r = ctx.rng.stream('bot.persona');
      const prefs: Record<string, number[]> = {};
      for (let g = 0; g < 8; g++)
        prefs[`stalls_repeat_${g}`] = STALL_CODES.map(() => r.next() * 2 - 1);
      this.persona = {
        temperature: 0.6 + r.next() * 2.2,
        riskBias: (r.next() - 0.5) * 1.2,
        medianMs: 900 + r.next() * 900,
        learning: 0.2 + r.next() * 0.3,
        errandPrefs: prefs,
      };
    }
    ctx.voice.preload(ctx.config.audio_keys).catch(() => undefined);
  }

  async run(): Promise<ModuleResult> {
    const rt = this.need(this.rt);
    const rec = this.need(this.rec);
    const plan = this.need(this.plan);
    this.startMs = rt.now();
    try {
      rt.phase('intro');
      await Promise.all([
        this.scene?.intro(rt) ?? Promise.resolve(),
        rt.say('four_stalls.intro', this.scene?.guide ?? null),
      ]);
      this.registerTargets();

      rt.phase('practice');
      rt.sayAsync('four_stalls.practice', this.scene?.guide ?? null);
      const practiceN = rt.block('practice').trials;
      for (let i = 0; i < practiceN; i++) {
        await this.choice({ position: i, kind: 'own', repeatGroupId: null, villager: null }, true);
      }

      rt.phase('choices');
      const { minTrials } = rt.block('choices');
      const minRepeats = rt.ctx.config.min_counts.repeat_probes ?? 0;
      let done = 0;
      let repeats = 0;
      let spent = 0;
      const tail = rt.ctx.config.blocks.find((b) => b.block_id === 'probe')?.trials ?? 0;
      const tailMs = tail * rt.trialBudgetMs('probe') + rt.ctx.config.budget.outro_ms;
      for (let i = 0; i < plan.trials.length; i++) {
        const t = plan.trials[i] as FourStallsTrialPlan;
        const errandsLeft = plan.trials.slice(i).filter((x) => x.kind === 'errand').length;
        const avg = done > 0 ? spent / done : rt.trialBudgetMs('choices');
        // Own purchases above the block minimum give way when time runs short (errands never do).
        const optional =
          t.kind === 'own' &&
          done + errandsLeft >= minTrials &&
          repeats + errandsLeft >= minRepeats;
        if (optional && rt.shouldSkipOptional(tailMs + errandsLeft * avg, avg)) continue;
        const t0 = rt.now();
        await this.choice(t, false);
        spent += rt.now() - t0;
        done += 1;
        if (t.kind === 'errand') repeats += 1;
        this.scene?.advanceLight(done / plan.trials.length);
      }
      this.scene?.prepare(null);
      for (const code of STALL_CODES) this.board?.remove(targetId(code));

      await runProbeBlock(rt, rec, this.need(this.board), {
        scene: this.stage ? new ProbeScene(this.stage, this.need(this.probeGeo), this.id) : null,
        bot: this.bot,
        geometry: this.need(this.probeGeo),
      });

      rt.phase('outro');
      await Promise.all([
        this.scene?.outro() ?? Promise.resolve(),
        rt.say('four_stalls.outro', this.scene?.guide ?? null),
      ]);
      rt.phase('done');
    } catch (err) {
      if (!(err instanceof ModuleAbortedError)) throw err;
      rec.current?.abort();
    }
    return {
      moduleId: this.id,
      endedReason: rt.endedReason(),
      durationMs: rt.now() - this.startMs,
      trialsCompleted: rec.completed,
      scorableTrials: rec.scorableCompleted,
      contextShiftIndex: null,
    };
  }

  private registerTargets(): void {
    const board = this.need(this.board);
    const geo = this.need(this.geo);
    STALL_CODES.forEach((code, i) => {
      const r = geo.targets[i];
      if (r) board.set(targetId(code), r, AUDIO, { enabled: false });
    });
  }

  private async choice(t: FourStallsTrialPlan, practice: boolean): Promise<void> {
    const rt = this.need(this.rt);
    const rec = this.need(this.rec);
    const board = this.need(this.board);
    const plan = this.need(this.plan);
    const windowMs = rt.timing('choice_window_ms');
    const errand = t.kind === 'errand' && t.repeatGroupId !== null;
    const groupIndex = errand ? Number((t.repeatGroupId as string).split('_').pop()) : -1;
    const goods = errand ? (ERRAND_GOODS[groupIndex % ERRAND_GOODS.length] ?? 'mango') : null;
    const trial = rec.begin({
      blockId: practice ? 'practice' : 'choices',
      phase: practice ? 'practice' : 'main',
      conditionId: 'standard',
      trialType: 'choice',
      stimulusId: errand
        ? `four_stalls.errand.${t.repeatGroupId}`
        : practice
          ? 'four_stalls.own.practice'
          : 'four_stalls.own',
      responseWindowMs: windowMs,
      expectedResponse: null,
      scorable: !practice,
      params: {
        repeat_group_id: errand ? t.repeatGroupId : null,
        high_variance_stalls: [...plan.highVariance],
        situation: errand ? 'errand' : 'own',
        errand_goods: goods,
        villager: t.villager,
        position: t.position,
      },
    });
    try {
      rt.phase(errand ? 'errand.arrive' : practice ? 'practice.ready' : 'own.ready', trial.index);
      this.scene?.prepare(
        errand && t.villager !== null && goods ? { villager: t.villager, goods } : null,
      );
      await rt.sleep(errand ? rt.timing('errand_ms') : rt.timing('iti_ms'));
      const ids = STALL_CODES.map(targetId);
      const presented = await trial.present(
        () => {
          this.scene?.open();
          board.enableAll(ids, true);
        },
        { version: 'four_stalls.choice.1', durationMs: windowMs },
      );
      rt.phase(errand ? 'errand.choice' : practice ? 'practice.choice' : 'own.choice', trial.index);
      if (practice && trial.index === 0) this.scene?.hint('stall_b');
      if (this.bot) this.botChoice(t, windowMs);
      const outcome = await runChoice(rt, {
        options: new Map(STALL_CODES.map((c) => [targetId(c), c] as const)),
        confirmId: null,
        anchorMs: presented.presentedOnsetMs,
        windowMs,
        onSelect: (code) => this.scene?.choose(code as StallCode),
      });
      board.enableAll(ids, false);
      this.scene?.hideHint();
      trial.respond({
        stimulusId: trial.spec.stimulusId,
        value: outcome.value,
        correctness: null,
        latencyMs: outcome.latencyMs,
        anchor: 'visual_onset',
        tapCount: outcome.tapCount,
        revisions: outcome.revisions,
        xy: outcome.xy,
      });
      const payoffMs = rt.timing('payoff_ms');
      const code = outcome.value as StallCode | null;
      if (code === null) {
        this.scene?.close();
        if (errand) this.scene?.errandDone(null, payoffMs);
      } else if (errand) {
        this.scene?.errandDone(code, payoffMs);
      } else {
        const counter = practice ? this.practicePicks : this.picks;
        const deck = plan.decks[code];
        const card = deck[counter[code] % deck.length] ?? { gain: 1, loss: 0 };
        counter[code] += 1;
        trial.setParam('gain', card.gain);
        trial.setParam('loss', card.loss);
        trial.setParam('net', card.gain - card.loss);
        if (!practice)
          this.values[code] +=
            (this.persona?.learning ?? 0.3) * (card.gain - card.loss - this.values[code]);
        this.scene?.payoff(code, card.gain, card.loss, payoffMs);
      }
      rt.phase(errand ? 'errand.done' : 'own.payoff', trial.index);
      await rt.sleep(payoffMs);
      trial.end(code === null ? 'timeout' : 'not_applicable', null, code === null ? 0 : 1);
    } catch (err) {
      trial.abort();
      throw err;
    }
  }

  /** Scripted bot: softmax over learned stall values (own) or fixed errand preferences. */
  private botChoice(t: FourStallsTrialPlan, windowMs: number): void {
    const bot = this.need(this.bot);
    const p = this.need(this.persona);
    const plan = this.need(this.plan);
    const r = this.need(this.rt).ctx.rng.stream(`bot.choice.${this.need(this.rec).index}`);
    const utils = STALL_CODES.map((code, i) => {
      const base =
        t.kind === 'errand' && t.repeatGroupId
          ? (p.errandPrefs[t.repeatGroupId]?.[i] ?? 0)
          : this.values[code];
      return base + (plan.highVariance.includes(code) ? p.riskBias : 0);
    });
    const max = Math.max(...utils);
    const w = utils.map((x) => Math.exp((x - max) * p.temperature));
    const pick = r.weighted([...STALL_CODES], w);
    const at = Math.min(
      windowMs - 200,
      lognormalMs(() => r.next(), p.medianMs, 0.35),
    );
    void bot.tapTarget(targetId(pick), Math.max(150, at), () => r.next()).catch(() => undefined);
  }

  trialParams(): Record<string, Record<string, unknown>> {
    return this.rec?.trialParams() ?? {};
  }

  destroy(): void {
    this.board?.clear();
    this.scene?.destroy();
    this.stage?.destroy();
    this.rt?.dispose();
    this.scene = null;
    this.stage = null;
  }

  private need<T>(v: T | null): T {
    if (v === null) throw new Error('four_stalls: run() before init()');
    return v;
  }
}

export function createFourStalls(hooks: MicroGameHooks = {}): FourStallsModule {
  return new FourStallsModule(hooks);
}
