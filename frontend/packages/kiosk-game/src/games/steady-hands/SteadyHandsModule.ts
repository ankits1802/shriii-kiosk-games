/**
 * MG-08 Steady Hands (free vs held responding).
 *
 * At dusk in the temple courtyard a great brass lamp flares to light; the player touches it while it
 * burns. In the free block the hand rests anywhere; in the held block it rests on a brass plate between
 * flames and lifts only to answer. On a seeded share of trials a festive distractor (firework, rising
 * sky lantern, temple bell) appears at a seeded offset inside the target window, away from the lamp.
 * The blocks are counterbalanced by seed; the switch is announced and logged as a `context_shift`
 * (`held_block` / `free_block`). The task is fixed-paced: ISI then the lamp burns for exactly
 * `target_ms` (the response window), whatever the player does.
 *
 * Measurement:
 * - every trial is trial type `target` (block `free` / `held`) with `params.distractor`; the committed
 *   response is `tap` (latency from the visual onset) or a timeout (omission);
 * - every raw tap is logged by the input layer, never debounced: ISI taps are `during_isi`, taps
 *   after the response are `extra`, both counted by the restraint indicator; a trial spans its ISI and
 *   window so these taps belong to it;
 * - resting the hand on the plate in the held block is the instructed action, so presses on the plate
 *   are re-labelled `on_target` (never counted as unneeded); lifting is logged per held trial as
 *   `input.hold` (hold over the ISI up to the onset);
 * - the distractor onset is logged as its own `stimulus_onset` on the frame it appears.
 */
import type { GameConfig } from '@shriii/contracts';
import type {
  ConstructId,
  GameModule,
  IndicatorId,
  ModuleContext,
  ModuleResult,
} from '../../core/contracts.ts';
import { presentStimulus } from '../../engine/timing.ts';
import {
  buildHeldFreeBlock,
  type HeldFreeStimulus,
  type HoldCondition,
  heldFreeBlockOptions,
} from '../../paradigms/held-free.ts';
import { BotHand, lognormalMs } from '../hub/kit/bot.ts';
import { type ProbeGeometry, ProbeScene, probeGeometry, runProbeBlock } from '../hub/kit/probe.ts';
import { GameRuntime, type MicroGameHooks, ModuleAbortedError } from '../hub/kit/runtime.ts';
import { GameStage } from '../hub/kit/stage.ts';
import { centerOf, TargetBoard } from '../hub/kit/targets.ts';
import { TrialRecorder } from '../hub/kit/trials.ts';
import { type SteadyHandsGeometry, steadyHandsGeometry } from './geometry.ts';
import { HoldPadTracker } from './pad.ts';
import { type DistractorKind, SteadyHandsScene } from './scene.ts';

export const STEADY_HANDS_CONSTRUCTS: readonly ConstructId[] = [
  'composure',
  'expressive_restraint',
  'persistence_of_style',
  'response_consistency',
  'stability',
];

export const STEADY_HANDS_INDICATORS: readonly IndicatorId[] = [
  'composure.distractor_slope',
  'expressive_restraint.held_vs_free_slope',
  'persistence_of_style.cross_segment_style_r',
  'persistence_of_style.lag1_autocorr',
  'response_consistency.loc_scale_sigma',
  'stability.shift_slope',
];

const LAMP_ID = 'steady_hands.target';
const PAD_ID = 'steady_hands.hold_pad';
const AUDIO = 'steady_hands.replay';

interface BotPersona {
  readonly rtMs: number;
  readonly rtSd: number;
  readonly distractorCostMs: number;
  readonly omitRate: number;
  readonly extraFree: number;
  readonly extraHeld: number;
}

export class SteadyHandsModule implements GameModule {
  readonly id = 'steady_hands' as const;
  readonly kind = 'micro' as const;
  readonly constructs = STEADY_HANDS_CONSTRUCTS;
  readonly indicators = STEADY_HANDS_INDICATORS;
  private rt: GameRuntime | null = null;
  private rec: TrialRecorder | null = null;
  private board: TargetBoard | null = null;
  private geo: SteadyHandsGeometry | null = null;
  private probeGeo: ProbeGeometry | null = null;
  private stage: GameStage | null = null;
  private scene: SteadyHandsScene | null = null;
  private pad: HoldPadTracker | null = null;
  private bot: BotHand | null = null;
  private persona: BotPersona | null = null;
  private botPadPointer: number | null = null;
  private heldActive = false;
  private kinds: DistractorKind[] = ['firework', 'sky_lantern', 'bell'];
  private startMs = 0;

  constructor(private readonly hooks: MicroGameHooks = {}) {}

  async init(ctx: ModuleContext<GameConfig>): Promise<void> {
    const rt = new GameRuntime(ctx, this.id, this.hooks);
    this.rt = rt;
    this.rec = new TrialRecorder(rt);
    this.board = new TargetBoard(ctx.input);
    this.geo = steadyHandsGeometry(ctx.layout);
    this.probeGeo = probeGeometry(ctx.layout);
    for (const k of [
      'target_ms',
      'isi_ms',
      'distractor_ms',
      'block_intro_ms',
      'hold_wait_ms',
      'probe_window_ms',
    ])
      rt.timing(k);
    const kinds = rt.constraintStrings('distractor_kinds');
    this.kinds = kinds.filter(
      (k): k is DistractorKind => k === 'firework' || k === 'sky_lantern' || k === 'bell',
    );
    if (this.kinds.length === 0)
      throw new Error('steady_hands: constraints.distractor_kinds is empty');
    this.pad = new HoldPadTracker(rt);
    // Plate presses in the held block are the instructed action, not unneeded taps.
    rt.setRawTapClassifier((p) =>
      this.heldActive &&
      p.target_id === PAD_ID &&
      p.classification !== 'filtered_palm' &&
      p.classification !== 'multi_touch_interference'
        ? 'on_target'
        : p.classification,
    );
    if (rt.visual) {
      this.stage = new GameStage(rt, { sceneId: 'tower_courtyard', timeOfDay: 'dusk' });
      this.scene = new SteadyHandsScene(this.stage, this.geo);
      this.pad.attachView(this.scene.padView);
    }
    if (rt.bot) {
      this.bot = new BotHand(rt, this.board);
      if (!rt.visual) this.pad.attachBot(this.bot, () => this.board?.bounds(PAD_ID) ?? null);
      const r = ctx.rng.stream('bot.persona');
      this.persona = {
        rtMs: 360 + r.next() * 160,
        rtSd: 0.12 + r.next() * 0.12,
        distractorCostMs: 15 + r.next() * 70,
        omitRate: 0.01 + r.next() * 0.04,
        extraFree: 0.05 + r.next() * 0.25,
        extraHeld: r.next() * 0.1,
      };
    }
    ctx.voice.preload(ctx.config.audio_keys).catch(() => undefined);
  }

  async run(): Promise<ModuleResult> {
    const rt = this.need(this.rt);
    const rec = this.need(this.rec);
    this.startMs = rt.now();
    let shiftIndex: number | null = null;
    const { ctx } = rt;
    try {
      rt.phase('intro');
      await Promise.all([
        this.scene?.intro(rt) ?? Promise.resolve(),
        rt.say('steady_hands.intro', this.scene?.guide ?? null),
      ]);

      const heldFirst = ctx.rng.stream('block_order').bool(0.5);
      const order: HoldCondition[] = heldFirst ? ['held', 'free'] : ['free', 'held'];

      // Practice: one free and one held flame (unscored), taught with the hand hint.
      rt.phase('practice');
      rt.sayAsync('steady_hands.practice', this.scene?.guide ?? null);
      const practice = buildHeldFreeBlock(
        { ...heldFreeBlockOptions(ctx.config, ctx.level, 'free', 2), distractorShare: 0 },
        ctx.rng.stream('practice'),
      );
      await this.setCondition('free', false);
      await this.target(practice[0] as HeldFreeStimulus, 'practice', 'free', true, order);
      await this.setCondition('held', false);
      await this.target(
        { ...(practice[1] as HeldFreeStimulus), condition: 'held' },
        'practice',
        'held',
        true,
        order,
      );

      for (let b = 0; b < order.length; b++) {
        const condition = order[b] as HoldCondition;
        const { trials, minTrials } = rt.block(condition);
        const stimuli = buildHeldFreeBlock(
          heldFreeBlockOptions(ctx.config, ctx.level, condition, trials),
          ctx.rng.stream(`block.${condition}`),
        );
        await this.setCondition(condition, b > 0 || condition === 'held');
        if (b > 0) {
          shiftIndex = rec.index;
          rec.contextShift(condition === 'held' ? 'held_block' : 'free_block', true, shiftIndex);
        }
        rt.phase(`block.${condition}`);
        let done = 0;
        const later = order.slice(b + 1).reduce((n, c) => n + rt.block(c).minTrials, 0);
        const tail =
          rt.block('probe').trials * rt.trialBudgetMs('probe') + ctx.config.budget.outro_ms;
        for (const stim of stimuli) {
          const per = stim.isiMs + stim.jitterMs + stim.targetMs + 40;
          const required =
            tail + later * per + (b + 1 < order.length ? rt.timing('block_intro_ms') : 0);
          if (done >= minTrials && rt.shouldSkipOptional(required, per)) break;
          await this.target(stim, condition, condition, false, order);
          done += 1;
        }
      }
      this.heldActive = false;
      this.scene?.setCondition('free');
      this.board?.remove(PAD_ID);
      // The lamp is not a target during the probe (its probe cards may sit over it in portrait).
      this.board?.remove(LAMP_ID);
      this.releaseBotPad();

      await runProbeBlock(rt, rec, this.need(this.board), {
        scene: this.stage ? new ProbeScene(this.stage, this.need(this.probeGeo), this.id) : null,
        bot: this.bot,
        geometry: this.need(this.probeGeo),
      });

      rt.phase('outro');
      await Promise.all([
        this.scene?.outro() ?? Promise.resolve(),
        rt.say('steady_hands.outro', this.scene?.guide ?? null),
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

  /** Switch the plate on/off; an announced switch shows the guide's demonstration first. */
  private async setCondition(condition: HoldCondition, announce: boolean): Promise<void> {
    const rt = this.need(this.rt);
    const board = this.need(this.board);
    const geo = this.need(this.geo);
    this.heldActive = condition === 'held';
    this.scene?.setCondition(condition);
    if (condition === 'held') {
      board.set(PAD_ID, geo.pad, AUDIO, { kind: 'hold' });
      if (this.bot && this.botPadPointer === null) {
        this.botPadPointer = this.bot.press(centerOf(geo.pad), { rest: true });
      }
    } else {
      board.remove(PAD_ID);
      this.releaseBotPad();
    }
    if (!announce) return;
    rt.phase(`announce.${condition}`);
    await (this.scene?.announce(condition) ?? Promise.resolve());
    await rt.sleep(rt.timing('block_intro_ms'));
    if (condition === 'held') {
      // Wait (bounded) for the hand to settle on the plate before the held block starts.
      const deadline = rt.now() + rt.timing('hold_wait_ms');
      while (!this.need(this.pad).held && rt.now() < deadline) await rt.sleep(100);
    }
    this.scene?.endAnnounce();
  }

  private releaseBotPad(): void {
    if (this.bot && this.botPadPointer !== null) {
      this.bot.release(this.botPadPointer, centerOf(this.need(this.geo).pad), { rest: true });
      this.botPadPointer = null;
    }
  }

  /** One fixed-paced flame: ISI, then the lamp burns for exactly `target_ms`. */
  private async target(
    stim: HeldFreeStimulus,
    blockId: string,
    condition: HoldCondition,
    practice: boolean,
    order: readonly HoldCondition[],
  ): Promise<void> {
    const rt = this.need(this.rt);
    const rec = this.need(this.rec);
    const board = this.need(this.board);
    const geo = this.need(this.geo);
    const pad = this.need(this.pad);
    const { ctx } = rt;
    const kind: DistractorKind | null = stim.distractor
      ? (this.kinds[ctx.rng.stream(`distractor.kind.${rec.index}`).int(0, this.kinds.length - 1)] ??
        'firework')
      : null;
    const trial = rec.begin({
      blockId,
      phase: practice ? 'practice' : 'main',
      conditionId: practice ? 'standard' : condition,
      trialType: 'target',
      stimulusId: practice ? 'steady_hands.lamp.practice' : 'steady_hands.lamp',
      responseWindowMs: stim.targetMs,
      expectedResponse: 'tap',
      scorable: !practice,
      shiftActive: !practice && condition === 'held',
      params: {
        distractor: stim.distractor,
        distractor_kind: kind,
        hold_condition: condition,
        target_ms: stim.targetMs,
        distractor_ms: stim.distractorMs,
        distractor_offset_ms: stim.distractorOffsetMs,
        isi_ms: stim.isiMs,
        jitter_ms: stim.jitterMs,
        block_order: order.join('_'),
      },
    });
    try {
      board.set(LAMP_ID, geo.lamp, AUDIO, { enabled: false });
      (ctx.input as { markIsi?: () => void }).markIsi?.();
      if (condition === 'held' && !pad.held) this.scene?.padNeedsHand();
      if (practice) rt.phase(`practice.${condition}`, trial.index);
      await rt.sleep(stim.isiMs + stim.jitterMs);
      const presented = await trial.present(
        () => {
          this.scene?.light();
          board.enable(LAMP_ID, true);
        },
        { version: 'steady_hands.lamp.1', durationMs: stim.targetMs },
      );
      const onset = presented.presentedOnsetMs;
      rt.phase(practice ? `practice.${condition}.lit` : 'lit', trial.index);
      if (condition === 'held') {
        const hw = pad.window(trial.startMs, onset);
        trial.event('input.hold', {
          target_id: PAD_ID,
          hold_ms: Math.round(hw.holdMs * 1000) / 1000,
          required_hold_ms: Math.round((onset - trial.startMs) * 1000) / 1000,
          completed: hw.completed,
        });
      }
      if (practice) this.scene?.hint();
      // Distractor at its seeded offset, on its own committed frame (never over the lamp).
      if (kind !== null && stim.distractorOffsetMs !== null && stim.distractorMs !== null) {
        const offset = stim.distractorOffsetMs;
        const dur = stim.distractorMs;
        void ctx.clock
          .delay(Math.max(0, onset + offset - rt.now()), ctx.signal)
          .then(async () => {
            if (trial.closed) return;
            const p = await presentStimulus(ctx.clock, () => this.scene?.distractor(kind, dur));
            if (!trial.closed) {
              trial.logOnset(`steady_hands.distractor.${kind}`, p, {
                version: 'steady_hands.distractor.1',
                durationMs: dur,
              });
            }
          })
          .catch(() => undefined);
      }
      // The flame goes out exactly at the end of the window.
      void ctx.clock
        .delay(Math.max(0, onset + stim.targetMs - rt.now()), ctx.signal)
        .then(() => {
          board.enable(LAMP_ID, false);
          this.scene?.extinguish();
        })
        .catch(() => undefined);
      if (this.bot) this.botTrial(stim, condition, onset);
      const r = await ctx.input.waitForTap([LAMP_ID], {
        anchorMs: onset,
        windowMs: stim.targetMs,
        signal: ctx.signal,
      });
      if (r.kind === 'aborted') throw new ModuleAbortedError();
      const tapped = r.kind === 'tap';
      trial.respond({
        stimulusId: trial.spec.stimulusId,
        value: tapped ? 'tap' : null,
        correctness: tapped ? true : null,
        latencyMs: tapped ? r.latencyMs : null,
        anchor: 'visual_onset',
        tapCount: tapped ? 1 : 0,
        revisions: [],
        xy: tapped ? r.tap.xyNorm : null,
      });
      if (tapped) this.scene?.flare();
      if (practice) this.scene?.hideHint();
      await rt.sleepUntil(onset + stim.targetMs);
      trial.end(tapped ? 'correct' : 'omission', tapped, tapped ? 1 : 0);
    } catch (err) {
      trial.abort();
      throw err;
    }
  }

  /** Scripted bot: lift from the plate, touch the flame, rest the hand again; sometimes an extra tap. */
  private botTrial(stim: HeldFreeStimulus, condition: HoldCondition, onset: number): void {
    const bot = this.need(this.bot);
    const p = this.need(this.persona);
    const rt = this.need(this.rt);
    const geo = this.need(this.geo);
    const r = rt.ctx.rng.stream(`bot.trial.${this.need(this.rec).index}`);
    const rand = (): number => r.next();
    const rtMs = lognormalMs(rand, p.rtMs + (stim.distractor ? p.distractorCostMs : 0), p.rtSd);
    const respond = r.next() > p.omitRate && rtMs < stim.targetMs - 20;
    const at = Math.max(0, onset + rtMs - rt.now());
    if (condition === 'held' && this.botPadPointer !== null) {
      const id = this.botPadPointer;
      const lift = Math.max(0, at - 140);
      void rt.sleep(lift).then(
        () => {
          if (this.botPadPointer === id) {
            bot.release(id, centerOf(geo.pad), { rest: true });
            this.botPadPointer = null;
          }
        },
        () => undefined,
      );
      void rt.sleep(at + 260).then(
        () => {
          if (this.botPadPointer === null && this.heldActive)
            this.botPadPointer = bot.press(centerOf(geo.pad), { rest: true });
        },
        () => undefined,
      );
    }
    if (respond) void bot.tapTarget(LAMP_ID, at, rand).catch(() => undefined);
    const extra = condition === 'held' ? p.extraHeld : p.extraFree;
    if (r.next() < extra) {
      // An unneeded touch on the lamp area: after answering, or early in the next ISI.
      const lamp = centerOf(geo.lamp);
      const when = respond ? at + 120 + r.next() * 200 : stim.targetMs + 80 + r.next() * 200;
      void bot
        .tapPoint({ x: lamp.x + (r.next() - 0.5) * 40, y: lamp.y }, when)
        .catch(() => undefined);
    }
  }

  trialParams(): Record<string, Record<string, unknown>> {
    return this.rec?.trialParams() ?? {};
  }

  destroy(): void {
    this.releaseBotPad();
    this.board?.clear();
    this.pad?.dispose();
    this.scene?.destroy();
    this.stage?.destroy();
    this.rt?.dispose();
    this.scene = null;
    this.stage = null;
  }

  private need<T>(v: T | null): T {
    if (v === null) throw new Error('steady_hands: run() before init()');
    return v;
  }
}

export function createSteadyHands(hooks: MicroGameHooks = {}): SteadyHandsModule {
  return new SteadyHandsModule(hooks);
}
