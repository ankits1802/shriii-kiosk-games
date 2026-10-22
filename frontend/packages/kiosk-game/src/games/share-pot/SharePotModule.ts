/**
 * MG-05 Share-the-Pot (public goods with scripted partners).
 *
 * Under the banyan's share circle the player and a pretend helper each hold ten brass coins. Each
 * round the player taps a coin to set how many go into the brass pot (coins 1..k; the open palm keeps
 * everything) and taps the tick. The helper has decided at the same time; both piles go in, the pot
 * doubles (sparkles, never numbers) and is split equally. The helper follows a seeded script per round:
 * cooperative, free-rider (keeps coins, folds arms) or the error round (coins spill by accident).
 * After the rounds the helper snatches a gift basket meant for both (scripted unfair loss) and the
 * player answers with a warm, neutral or firm face (exploratory tone probe). The cross-module probe
 * segment closes the module.
 *
 * Measurement:
 * - `round` trials (block `rounds`): committed response `contribute` with every selection change as a
 *   revision `tokens_<k>`; `contribution` and `partner_action` events inside the trial; latency from the
 *   visual onset; decision window `decision_window_ms` exactly.
 * - `unprompted`: the player's first selection came before the nudge (`prompt_delay_ms` after onset)
 *   and shares at least one coin.
 * - `context_shift` `partner_error` (unannounced) at the error round.
 * - `tone_choice` trial (block `tone_probe`) with the helper's `partner_action` (`grab`).
 * - Timeouts log `input_mode: timeout` and no contribution (no decision means no data).
 */
import type { GameConfig } from '@shriii/contracts';
import type {
  ConstructId,
  GameModule,
  IndicatorId,
  ModuleContext,
  ModuleResult,
} from '../../core/contracts.ts';
import { type PlayedRound, PublicGoodsGame } from '../../paradigms/public-goods.ts';
import { BotHand, lognormalMs } from '../hub/kit/bot.ts';
import { runChoice } from '../hub/kit/choice.ts';
import { type ProbeGeometry, ProbeScene, probeGeometry, runProbeBlock } from '../hub/kit/probe.ts';
import { GameRuntime, type MicroGameHooks, ModuleAbortedError } from '../hub/kit/runtime.ts';
import { GameStage } from '../hub/kit/stage.ts';
import { TargetBoard } from '../hub/kit/targets.ts';
import { TrialRecorder } from '../hub/kit/trials.ts';
import { type SharePotGeometry, sharePotGeometry } from './geometry.ts';
import { buildSharePotPlan, type SharePotPlan } from './plan.ts';
import { SharePotScene } from './scene.ts';

export const SHARE_POT_CONSTRUCTS: readonly ConstructId[] = [
  'decisiveness',
  'emotional_regulation',
  'initiative',
  'persistence_of_style',
  'response_consistency',
  'stability',
  'teamwork',
];

export const SHARE_POT_INDICATORS: readonly IndicatorId[] = [
  'decisiveness.reversals_before_confirm',
  'emotional_regulation.tone_after_unfair_loss_b',
  'initiative.unprompted_share',
  'persistence_of_style.cross_segment_style_r',
  'persistence_of_style.lag1_autocorr',
  'response_consistency.loc_scale_sigma',
  'stability.shift_slope',
  'teamwork.mean_contribution',
  'teamwork.response_to_partner_defection',
  'teamwork.response_to_partner_error',
];

const TONE_CODES = ['warm', 'neutral', 'firm'] as const;
export type ToneCode = (typeof TONE_CODES)[number];

/** Seeded bot persona (behaviour only; never logged as anything but player input). */
interface SharePotBotPersona {
  readonly baseShare: number;
  readonly defectionDrop: number;
  readonly errorForgiveness: number;
  readonly reviseRate: number;
  readonly medianMs: number;
  readonly eagerness: number;
  readonly tone: ToneCode;
}

export class SharePotModule implements GameModule {
  readonly id = 'share_pot' as const;
  readonly kind = 'micro' as const;
  readonly constructs = SHARE_POT_CONSTRUCTS;
  readonly indicators = SHARE_POT_INDICATORS;
  private rt: GameRuntime | null = null;
  private rec: TrialRecorder | null = null;
  private board: TargetBoard | null = null;
  private plan: SharePotPlan | null = null;
  private geo: SharePotGeometry | null = null;
  private probeGeo: ProbeGeometry | null = null;
  private stage: GameStage | null = null;
  private scene: SharePotScene | null = null;
  private bot: BotHand | null = null;
  private persona: SharePotBotPersona | null = null;
  private lastPartner: { type: string; error: boolean } | null = null;
  private startMs = 0;

  constructor(private readonly hooks: MicroGameHooks = {}) {}

  async init(ctx: ModuleContext<GameConfig>): Promise<void> {
    const rt = new GameRuntime(ctx, this.id, this.hooks);
    this.rt = rt;
    this.rec = new TrialRecorder(rt);
    this.board = new TargetBoard(ctx.input);
    this.plan = buildSharePotPlan(ctx.config, ctx.rng.stream('plan'));
    this.geo = sharePotGeometry(ctx.layout, this.plan.endowment);
    this.probeGeo = probeGeometry(ctx.layout);
    // Fail closed on every timing the flow needs before anything is shown.
    for (const k of [
      'decision_window_ms',
      'reveal_ms',
      'deal_ms',
      'prompt_delay_ms',
      'round_gap_ms',
      'grab_ms',
      'tone_window_ms',
      'probe_window_ms',
    ])
      rt.timing(k);
    if (rt.visual) {
      this.stage = new GameStage(rt, { sceneId: 'share_circle', timeOfDay: 'golden_hour' });
      this.scene = new SharePotScene(this.stage, this.geo, {
        endowment: this.plan.endowment,
        partnerVariant: ctx.rng.stream('partner.look').int(0, 5),
      });
    }
    if (rt.bot) {
      this.bot = new BotHand(rt, this.board);
      const r = ctx.rng.stream('bot.persona');
      this.persona = {
        baseShare: 0.25 + r.next() * 0.65,
        defectionDrop: r.next() * 0.5,
        errorForgiveness: r.next(),
        reviseRate: r.next() * 0.5,
        medianMs: 1800 + r.next() * 1800,
        eagerness: r.next(),
        tone: r.pick(TONE_CODES),
      };
    }
    ctx.voice.preload(ctx.config.audio_keys).catch(() => undefined);
  }

  async run(): Promise<ModuleResult> {
    const rt = this.need(this.rt);
    const rec = this.need(this.rec);
    const plan = this.need(this.plan);
    this.startMs = rt.now();
    let shiftIndex: number | null = null;
    try {
      rt.phase('intro');
      await (this.scene?.intro(rt) ?? Promise.resolve());
      await rt.say('share_pot.intro', this.scene?.guide ?? null);

      rt.phase('practice');
      rt.sayAsync('share_pot.practice', this.scene?.guide ?? null);
      await this.round(-1, { round: -1, partnerType: 'cooperative', errorRound: false }, null);

      const game = new PublicGoodsGame({
        endowment: plan.endowment,
        multiplier: plan.multiplier,
        partner: plan.partner,
      });
      this.scene?.beginRounds();
      for (const entry of plan.rounds) {
        if (entry.errorRound && shiftIndex === null) {
          shiftIndex = rec.index;
          rec.contextShift(
            'partner_error',
            rt.ctx.config.context_shift?.announced ?? false,
            shiftIndex,
          );
        }
        await this.round(entry.round, entry, game);
      }

      rt.phase('tone_probe');
      await this.toneProbe(plan.rounds.length);

      await runProbeBlock(rt, rec, this.need(this.board), {
        scene: this.stage ? new ProbeScene(this.stage, this.need(this.probeGeo), this.id) : null,
        bot: this.bot,
        geometry: this.need(this.probeGeo),
      });

      rt.phase('outro');
      await Promise.all([
        this.scene?.outro() ?? Promise.resolve(),
        rt.say('share_pot.outro', this.scene?.guide ?? null),
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
      contextShiftIndex: shiftIndex,
    };
  }

  /** One public-goods round (practice when `game` is null). */
  private async round(
    roundIndex: number,
    entry: {
      readonly round: number;
      readonly partnerType: 'cooperative' | 'free_rider' | 'error_prone' | 'conditional_cooperator';
      readonly errorRound: boolean;
    },
    game: PublicGoodsGame | null,
  ): Promise<void> {
    const rt = this.need(this.rt);
    const rec = this.need(this.rec);
    const board = this.need(this.board);
    const geo = this.need(this.geo);
    const plan = this.need(this.plan);
    const practice = game === null;
    const windowMs = practice ? null : rt.timing('decision_window_ms');
    const promptDelay = rt.timing('prompt_delay_ms');
    const endowment = plan.endowment;
    const nudgeLine = 'share_pot.nudge';
    const hasNudgeLine = rt.ctx.voice.has(nudgeLine);
    const trial = rec.begin({
      blockId: practice ? 'practice' : 'rounds',
      phase: practice ? 'practice' : 'main',
      conditionId: practice ? 'standard' : 'scripted_partners',
      trialType: 'round',
      stimulusId: practice ? 'share_pot.round.practice' : `share_pot.round.${roundIndex}`,
      responseWindowMs: windowMs,
      expectedResponse: null,
      scorable: !practice,
      partnerType: entry.partnerType,
      params: {
        round: practice ? null : roundIndex,
        partner_type: entry.partnerType,
        policy_id: `${entry.partnerType}.v1`,
        error_round: entry.errorRound,
        endowment_tokens: endowment,
        pot_multiplier: plan.multiplier,
        prompt_delay_ms: promptDelay,
        plan_attempt: plan.attempt,
        sources: plan.sources,
        // The nudge is the round's only prompt; `contribution.unprompted` already encodes whether the
        // first selection came before it, so the nudge is not a "mentioning prompt" that would drop
        // rounds from the 8-round indicators.
        nudge_line: hasNudgeLine ? nudgeLine : null,
      },
    });
    rt.phase(practice ? 'practice.deal' : 'round.deal', trial.index);
    try {
      const optionIds = new Map<string, string>();
      geo.slots.forEach((rect, k) => {
        const id = k === 0 ? 'share_pot.palm' : `share_pot.coin_${k}`;
        optionIds.set(id, `tokens_${k}`);
        board.set(id, rect, 'share_pot.replay', { enabled: false });
      });
      board.set('share_pot.confirm', geo.confirm, 'share_pot.replay', { enabled: false });
      this.scene?.deal(entry.partnerType);
      await rt.sleep(rt.timing('deal_ms'));
      const presented = await trial.present(
        () => {
          this.scene?.openChoice();
          board.enableAll([...optionIds.keys(), 'share_pot.confirm'], true);
        },
        { version: 'share_pot.round.1', durationMs: windowMs },
      );
      rt.phase(practice ? 'practice.choice' : 'round.choice', trial.index);
      if (practice) this.scene?.practiceHint();

      // Nudge (the only prompt): fires once if nothing was selected by `prompt_delay_ms`.
      const nudgeAc = new AbortController();
      let firstSelectionMs: number | null = null;
      let nudgeMs: number | null = null;
      rt.ctx.clock
        .delay(
          presented.presentedOnsetMs + promptDelay - rt.now(),
          AbortSignal.any([nudgeAc.signal, rt.signal]),
        )
        .then(
          () => {
            if (firstSelectionMs !== null) return;
            nudgeMs = rt.now();
            this.scene?.nudge();
            if (hasNudgeLine) {
              const pb = rt.ctx.voice.play(nudgeLine, { signal: rt.signal });
              void pb.ended.then((r) => {
                if (!trial.closed && r.status === 'completed') {
                  trial.event('prompt_audio_end', {
                    line_id: nudgeLine,
                    audio_end_ms: Math.max(0, r.endMs),
                  });
                }
              });
            }
          },
          () => undefined,
        );

      if (this.bot) this.botRound(practice, entry, windowMs, promptDelay);

      const outcome = await runChoice(rt, {
        options: optionIds,
        confirmId: 'share_pot.confirm',
        anchorMs: presented.presentedOnsetMs,
        windowMs,
        onSelect: (code, tMs) => {
          if (firstSelectionMs === null) firstSelectionMs = tMs;
          this.scene?.select(Number(code.slice('tokens_'.length)));
          this.scene?.hideHint();
        },
      });
      nudgeAc.abort();
      board.enableAll([...optionIds.keys(), 'share_pot.confirm'], false);
      const responded = outcome.kind === 'response' && outcome.value !== null;
      const tokens = responded ? Number((outcome.value as string).slice('tokens_'.length)) : 0;
      trial.respond({
        stimulusId: trial.spec.stimulusId,
        value: responded ? 'contribute' : null,
        correctness: null,
        latencyMs: outcome.latencyMs,
        anchor: 'visual_onset',
        tapCount: outcome.tapCount,
        revisions: outcome.revisions,
        xy: outcome.xy,
      });
      const unprompted =
        responded &&
        tokens > 0 &&
        firstSelectionMs !== null &&
        (nudgeMs === null || firstSelectionMs < nudgeMs);
      const g =
        game ??
        new PublicGoodsGame({ endowment, multiplier: plan.multiplier, partner: plan.partner });
      const played: PlayedRound = g.playRound(
        { partnerType: entry.partnerType, errorRound: entry.errorRound },
        tokens,
        { unprompted },
        rt.ctx.rng.stream(practice ? 'partners.practice' : 'partners'),
      );
      if (responded) trial.event('contribution', played.contribution);
      trial.event('partner_action', played.partnerAction);
      trial.setParam('nudged', nudgeMs !== null);
      rt.phase(practice ? 'practice.reveal' : 'round.reveal', trial.index);
      const revealMs = rt.timing('reveal_ms');
      void this.scene?.reveal(played, responded, revealMs);
      await rt.sleep(revealMs);
      trial.end(responded ? 'not_applicable' : 'timeout', null, responded ? 1 : 0);
      if (!practice) {
        this.lastPartner = { type: entry.partnerType, error: entry.errorRound };
      }
      await rt.sleep(rt.timing('round_gap_ms'));
    } catch (err) {
      trial.abort();
      throw err;
    }
  }

  /** Scripted bot: choose an amount like a conditional cooperator, maybe revise, then confirm. */
  private botRound(
    practice: boolean,
    entry: { readonly partnerType: string },
    windowMs: number | null,
    promptDelay: number,
  ): void {
    const bot = this.need(this.bot);
    const p = this.need(this.persona);
    const plan = this.need(this.plan);
    const r = this.need(this.rt).ctx.rng.stream(`bot.round.${this.need(this.rec).index}`);
    let share = p.baseShare + (r.next() - 0.5) * 0.2;
    if (this.lastPartner?.type === 'free_rider' && !this.lastPartner.error)
      share -= p.defectionDrop;
    if (this.lastPartner?.error) share -= (1 - p.errorForgiveness) * 0.3;
    void entry;
    const k = Math.max(0, Math.min(plan.endowment, Math.round(share * plan.endowment)));
    const limit = windowMs ?? 20_000;
    const eager = r.next() < p.eagerness;
    const t1 = Math.min(
      limit * 0.55,
      eager
        ? 600 + r.next() * (promptDelay - 900)
        : promptDelay + lognormalMs(() => r.next(), 900, 0.4),
    );
    const id = (n: number): string => (n === 0 ? 'share_pot.palm' : `share_pot.coin_${n}`);
    const jitter = (): number => r.next();
    void bot.tapTarget(id(practice ? 5 : k), t1, jitter).catch(() => undefined);
    let t = t1;
    if (!practice && r.next() < p.reviseRate) {
      const alt = Math.max(0, Math.min(plan.endowment, k + (r.next() < 0.5 ? -2 : 2)));
      t += 400 + r.next() * 600;
      void bot.tapTarget(id(alt), t, jitter).catch(() => undefined);
      t += 350 + r.next() * 500;
      void bot.tapTarget(id(k), t, jitter).catch(() => undefined);
    }
    t += Math.min(
      limit * 0.35,
      lognormalMs(() => r.next(), p.medianMs * 0.35, 0.35),
    );
    void bot
      .tapTarget('share_pot.confirm', Math.min(t, limit - 250), jitter)
      .catch(() => undefined);
  }

  /** Scripted unfair loss (the helper snatches the shared gift) and the tone answer. */
  private async toneProbe(round: number): Promise<void> {
    const rt = this.need(this.rt);
    const rec = this.need(this.rec);
    const board = this.need(this.board);
    const geo = this.need(this.geo);
    const windowMs = rt.timing('tone_window_ms');
    const grabTokens = Math.round(rt.constraintNumber('unfair_pot_tokens'));
    const trial = rec.begin({
      blockId: 'tone_probe',
      phase: 'main',
      conditionId: 'unfair_loss_probe',
      trialType: 'tone_choice',
      stimulusId: 'share_pot.tone.unfair_loss',
      responseWindowMs: windowMs,
      expectedResponse: null,
      scorable: true,
      partnerType: 'free_rider',
      params: { unfair_pot_tokens: grabTokens, tone_options: [...TONE_CODES] },
    });
    try {
      const ids = TONE_CODES.map((c) => `share_pot.tone_${c}`);
      ids.forEach((id, i) => {
        board.set(id, geo.tones[i] as (typeof geo.tones)[0], 'share_pot.replay', {
          enabled: false,
        });
      });
      rt.phase('tone.grab', trial.index);
      this.scene?.hideRoundUi();
      this.scene?.unfairGrab(grabTokens);
      trial.event('partner_action', {
        partner_type: 'free_rider',
        policy_id: 'free_rider.v1',
        round,
        action: 'grab',
        tokens: grabTokens,
        is_error: false,
      });
      await rt.sleep(rt.timing('grab_ms'));
      const presented = await trial.present(
        () => {
          this.scene?.showTones();
          board.enableAll(ids, true);
        },
        { version: 'share_pot.tone.1', durationMs: windowMs },
      );
      rt.phase('tone.choice', trial.index);
      if (this.bot && this.persona) {
        const r = rt.ctx.rng.stream('bot.tone');
        void this.bot
          .tapTarget(`share_pot.tone_${this.persona.tone}`, 700 + r.next() * 1800, () => r.next())
          .catch(() => undefined);
      }
      const outcome = await runChoice(rt, {
        options: new Map(TONE_CODES.map((c) => [`share_pot.tone_${c}`, c] as const)),
        confirmId: null,
        anchorMs: presented.presentedOnsetMs,
        windowMs,
        onSelect: (code) => this.scene?.selectTone(code as ToneCode),
      });
      board.enableAll(ids, false);
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
      rt.phase('tone.reaction', trial.index);
      await (this.scene?.toneReaction((outcome.value as ToneCode | null) ?? null) ?? rt.sleep(0));
      trial.end(
        outcome.kind === 'timeout' ? 'timeout' : 'not_applicable',
        null,
        outcome.kind === 'timeout' ? 0 : 1,
      );
      for (const id of ids) board.remove(id);
    } catch (err) {
      trial.abort();
      throw err;
    }
  }

  /** `GameTrialSpec.params` of every trial so far (for export with the event stream). */
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
    if (v === null) throw new Error('share_pot: run() before init()');
    return v;
  }
}

/** Factory for the module registry. */
export function createSharePot(hooks: MicroGameHooks = {}): SharePotModule {
  return new SharePotModule(hooks);
}
