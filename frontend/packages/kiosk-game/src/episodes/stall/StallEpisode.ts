/**
 * Episode 1 of Pathway A: The Stall ("Table for One", EPI-01).
 *
 * The player runs a chaat, sweets and fruit stall at the afternoon fair. Customers step up one at a time:
 *
 * 1. practice (2, not scored): serve a fresh item, hold back a spoiled one, with hints;
 * 2. service (go/no-go): tap the serving plate to hand the item over, hold back spoiled food (rot,
 *    flies). Scripted negative feedback: some customers grumble whatever the player does;
 * 3. tone_calm: calm customers speak; the player answers by tapping a warm, neutral or firm face;
 * 4. timed_rush (pressure): the same serving with a burning timer lamp, crowd noise and a shorter
 *    window (level table); stimuli are otherwise identical;
 * 5. rude_run (the single, unannounced context shift `rude_customer_run`): customers' tone escalates
 *    (recorded face + voice tone levels, a stimulus property, never sensing of the player);
 * 6. probe (cross-episode style probes, the evening lull): a quick pick between a sure handful of
 *    coins and a covered pot.
 *
 * Measurement integrity (ENG-01/06/07/09/10): the schedule is the seeded data-driven schedule; timings
 * and windows come from the level table; stimulus onset is the frame after the render commit; every
 * raw tap (premature, during ISI, extra) is logged against its trial; response windows are exact and
 * serving trials are fixed-paced (the trial lasts the whole window, so pacing never depends on the
 * player); animations never delay a stimulus; no score, number or "wrong" sound is ever shown.
 */
import type {
  BlockConfig,
  ContextShiftPayload,
  EventCondition,
  EventTaskPosition,
  GameConfig,
} from '@shriii/contracts';
import type {
  ConstructId,
  EventLogger,
  GameModule,
  IndicatorId,
  ModuleContext,
  ModuleResult,
  RawTap,
  TargetHandle,
  VoicePlayback,
} from '../../core/contracts.ts';
import { abortReasonOf, isAbortError } from '../../core/contracts.ts';
import { type PresentedOnset, presentStimulus } from '../../engine/timing.ts';
import type { PointerSample } from '../../input/input-service.ts';
import { classifyGngTrial, gngResponseFields } from '../../paradigms/go-nogo.ts';
import { StallBot, sampleStallBotPolicy } from './bot.ts';
import { stallGeometry } from './layout.ts';
import { PREMATURE_THRESHOLD_MS } from './params/params.generated.ts';
import {
  buildStallPlan,
  type ProbeCode,
  type ProbeTrial,
  type ServeTrial,
  type StallPlan,
  type StallTrial,
  type ToneCode,
  type ToneTrial,
} from './schedule.ts';
import { NullStallView, type StallBeat, type StallView } from './view.ts';

export const STALL_MODULE_ID = 'stall' as const;
const STIMULUS_VERSION = 'stall.art.v1';

/** Target ids (also the raw-tap `target_id`s). */
export const STALL_TARGETS = {
  plate: 'stall.serve',
  tone: (code: ToneCode): string => `stall.tone_${code}`,
  probe: (code: ProbeCode): string => `stall.probe_${code}`,
} as const;

/** Creates the view for a context (the Pixi scene in the browser; injected so tests stay headless). */
export type StallViewFactory = (ctx: ModuleContext) => StallView;

export interface StallEpisodeOptions {
  /** View factory; default: the headless {@link NullStallView} (the package factory wires the Pixi scene). */
  readonly view?: StallViewFactory;
  /**
   * DEV ONLY (visual QA): start at this block, skipping the earlier ones (they are not logged). Never
   * set in a session; the kiosk factory does not expose it.
   */
  readonly devStartBlock?: string;
}

/** Input-service extras the engine's `DomInputService` provides (duck-typed, optional). */
interface InputExtras {
  setLogger?(logger: EventLogger | null): void;
  markIsi?(): void;
  markIdle?(): void;
  inject?(sample: PointerSample): void;
}

/** Live debugging/automation surface (dev harness, Playwright bot, screenshots). */
export interface StallDebugState {
  phase: 'loading' | 'intro' | 'handover' | 'isi' | 'stimulus' | 'resolve' | 'outro' | 'done';
  beat: StallBeat | null;
  trialIndex: number | null;
  trialId: string | null;
  trialType: string | null;
  blockId: string | null;
  /** What the current stimulus asks for (bots): serve/hold back, tone choice or probe. */
  expected: string | null;
  /** Live, enabled targets: id -> centre. */
  targets: Record<string, { x: number; y: number }>;
  trialsCompleted: number;
}

const BEATS: Readonly<Record<string, StallBeat>> = {
  practice: 'practice',
  service: 'service',
  tone_calm: 'tone_calm',
  timed_rush: 'timed_rush',
  rude_run: 'rude_run',
  probe: 'probe',
};

/** Voice line the guide speaks entering each block (the rude run is unannounced by design). */
const HANDOVER_LINES: Readonly<Partial<Record<StallBeat, string>>> = {
  practice: 'stall.practice',
  timed_rush: 'stall.rush_cue',
};

type TrialOutcome = 'done' | 'aborted';

export class StallEpisode implements GameModule<GameConfig> {
  readonly id = STALL_MODULE_ID;
  readonly kind = 'episode' as const;
  readonly constructs: readonly ConstructId[];
  readonly indicators: readonly IndicatorId[];

  private ctx: ModuleContext | null = null;
  private plan: StallPlan | null = null;
  private view: StallView | null = null;
  private bot: StallBot | null = null;
  private readonly targets = new Map<string, TargetHandle>();
  private readonly options: StallEpisodeOptions;
  private destroyed = false;
  private rudeRunStart: number | null = null;
  /** Automation/debug state (exposed by the dev harness). */
  readonly debug: StallDebugState = {
    phase: 'loading',
    beat: null,
    trialIndex: null,
    trialId: null,
    trialType: null,
    blockId: null,
    expected: null,
    targets: {},
    trialsCompleted: 0,
  };

  constructor(
    constructs: readonly ConstructId[] = [],
    indicators: readonly IndicatorId[] = [],
    options: StallEpisodeOptions = {},
  ) {
    this.constructs = constructs;
    this.indicators = indicators;
    this.options = options;
  }

  /** The plan in use (after `init`). */
  get currentPlan(): StallPlan | null {
    return this.plan;
  }

  async init(ctx: ModuleContext<GameConfig>): Promise<void> {
    this.ctx = ctx;
    this.plan = buildStallPlan(
      ctx.config,
      ctx.level,
      ctx.rng.stream('schedule'),
      ctx.session.formId,
    );
    const geometry = stallGeometry(ctx.layout);
    const factory = this.options.view;
    this.view = factory ? factory(ctx) : new NullStallView(geometry);
    const input = ctx.input as typeof ctx.input & InputExtras;
    if (ctx.dev.headless && typeof input.inject === 'function') {
      const injector = { inject: (s: PointerSample) => input.inject?.(s) };
      this.bot = new StallBot(
        sampleStallBotPolicy(ctx.rng.stream('bot.policy')),
        ctx.rng.stream('bot'),
        ctx.clock,
        injector,
        this.view.geometry,
      );
    }
    this.registerTargets();
    const lines = [
      'stall.intro',
      'stall.practice',
      'stall.rush_cue',
      'stall.outro',
      'stall.customer.calm',
      'stall.customer.hostile',
    ].filter((l) => ctx.voice.has(l));
    await Promise.all([
      ctx.voice.preload(lines).catch(() => undefined),
      this.view.prepare(this.plan),
    ]);
  }

  async run(): Promise<ModuleResult> {
    const ctx = this.ctx;
    const plan = this.plan;
    const view = this.view;
    if (!ctx || !plan || !view) throw new Error('StallEpisode.run before init');
    const startMs = ctx.clock.now();
    let completed = 0;
    let scorable = 0;
    let shiftIndex: number | null = null;
    let aborted = false;

    try {
      ctx.audio.playMusic('stall', { fadeMs: 1200 });
      ctx.audio.setAmbience('market_day', { fadeMs: 1500 });
      this.debug.phase = 'intro';
      const intro = this.speak('stall.intro');
      await Promise.all([view.intro(intro, ctx.signal), intro?.ended]);
      this.throwIfAborted();

      const startAt = this.options.devStartBlock
        ? plan.blockOrder.indexOf(this.options.devStartBlock)
        : 0;
      for (const blockId of plan.blockOrder.slice(Math.max(0, startAt))) {
        const block = ctx.config.blocks.find((b) => b.block_id === blockId);
        if (!block) continue;
        const blockTrials = plan.trials.filter((t) => t.spec.block_id === blockId);
        if (blockTrials.length === 0) continue;
        if (this.wrapUpRequested() && block.min_trials === 0) continue;
        await this.enterBlock(block);
        let inBlock = 0;
        for (const trial of blockTrials) {
          // Soft-cap wrap-up (ENG-05): finish the current trial, keep each block's minimum.
          if (this.wrapUpRequested() && inBlock >= block.min_trials) break;
          const outcome = await this.runTrial(trial, inBlock);
          if (outcome === 'aborted') {
            aborted = true;
            break;
          }
          inBlock += 1;
          completed += 1;
          this.debug.trialsCompleted = completed;
          if (trial.spec.scorable) scorable += 1;
          if (trial.contextShift) shiftIndex = trial.spec.trial_index;
        }
        if (aborted) break;
      }

      if (!aborted && !ctx.signal.aborted) {
        this.debug.phase = 'outro';
        this.clearInteractive();
        const outro = this.speak('stall.outro');
        await Promise.all([view.outro(outro, ctx.signal), outro?.ended]);
        ctx.audio.stopMusic(1500);
      }
    } catch (err) {
      if (!isAbortError(err) && !ctx.signal.aborted) throw err;
    } finally {
      this.clearInteractive();
      this.restoreInputLogger();
      this.debug.phase = 'done';
    }

    const reason = abortReasonOf(ctx.signal);
    return {
      moduleId: STALL_MODULE_ID,
      endedReason: reason ? (reason.kind === 'crash' ? 'error' : reason.kind) : 'completed',
      durationMs: ctx.clock.now() - startMs,
      trialsCompleted: completed,
      scorableTrials: scorable,
      contextShiftIndex: shiftIndex,
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const t of this.targets.values()) t.remove();
    this.targets.clear();
    this.restoreInputLogger();
    this.view?.destroy();
    this.view = null;
  }

  /* ------------------------------------------------------------------------------------------ */

  private registerTargets(): void {
    const ctx = this.ctx;
    const plan = this.plan;
    const view = this.view;
    if (!ctx || !plan || !view) return;
    const g = view.geometry;
    const add = (
      id: string,
      rect: { x: number; y: number; width: number; height: number },
    ): void => {
      // Registered enabled, then disabled through the handle: the input layer keeps a spec-level
      // `enabled: false` forever (its hit test checks the spec flag too), so never pass it here.
      const handle = ctx.input.registerTarget({
        id,
        bounds: rect,
        audioKey: 'stall.replay',
        kind: 'tap',
      });
      handle.setEnabled(false);
      this.targets.set(id, handle);
    };
    add(STALL_TARGETS.plate, g.plate.rect);
    plan.toneCodes.forEach((code, i) => {
      const face = g.toneFaces[i];
      if (face) add(STALL_TARGETS.tone(code), face.rect);
    });
    plan.probeCodes.forEach((code, i) => {
      const offer = g.probes[i];
      if (offer) add(STALL_TARGETS.probe(code), offer.rect);
    });
  }

  private setTargets(ids: readonly string[]): void {
    const g = this.view?.geometry;
    const live: Record<string, { x: number; y: number }> = {};
    for (const [id, handle] of this.targets) {
      const on = ids.includes(id);
      handle.setEnabled(on);
      if (on && g) {
        const c = this.centreOf(id);
        if (c) live[id] = c;
      }
    }
    this.debug.targets = live;
  }

  private centreOf(id: string): { x: number; y: number } | null {
    const g = this.view?.geometry;
    const plan = this.plan;
    if (!g || !plan) return null;
    if (id === STALL_TARGETS.plate) return { ...g.plate.center };
    const ti = plan.toneCodes.findIndex((c) => STALL_TARGETS.tone(c) === id);
    if (ti >= 0) return g.toneFaces[ti] ? { ...g.toneFaces[ti].center } : null;
    const pi = plan.probeCodes.findIndex((c) => STALL_TARGETS.probe(c) === id);
    if (pi >= 0) return g.probes[pi] ? { ...g.probes[pi].center } : null;
    return null;
  }

  private clearInteractive(): void {
    this.setTargets([]);
    this.view?.showHint(null);
  }

  private wrapUpRequested(): boolean {
    return this.ctx?.wrapUp?.requested === true;
  }

  private throwIfAborted(): void {
    this.ctx?.signal.throwIfAborted();
  }

  private speak(lineId: string): VoicePlayback | null {
    const ctx = this.ctx;
    if (!ctx?.voice.has(lineId) || ctx.voice.isVoiceForbidden(lineId)) return null;
    return ctx.voice.play(lineId, { signal: ctx.signal });
  }

  private restoreInputLogger(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    (ctx.input as typeof ctx.input & InputExtras).setLogger?.(ctx.logger);
  }

  private async enterBlock(block: BlockConfig): Promise<void> {
    const ctx = this.ctx;
    const view = this.view;
    if (!ctx || !view) return;
    const beat = BEATS[block.block_id] ?? 'service';
    this.debug.phase = 'handover';
    this.debug.beat = beat;
    this.debug.blockId = block.block_id;
    this.clearInteractive();
    if (block.conditions.timer || block.conditions.noise) {
      ctx.audio.playMusic('pressure', { fadeMs: 600 });
      ctx.audio.setAmbience('market_busy', { fadeMs: 800 });
    } else if (beat === 'rude_run' || beat === 'tone_calm' || beat === 'probe') {
      ctx.audio.playMusic('stall', { fadeMs: 1400 });
      ctx.audio.setAmbience(beat === 'probe' ? 'quiet' : 'market_day', { fadeMs: 1500 });
    }
    const lineId = HANDOVER_LINES[beat];
    const speech = lineId ? this.speak(lineId) : null;
    await Promise.all([view.enterBlock(beat, block, speech, ctx.signal), speech?.ended]);
    this.throwIfAborted();
    if (beat === 'rude_run') this.rudeRunStart = null;
  }

  private trialLogger(trial: StallTrial): EventLogger {
    const ctx = this.ctx as ModuleContext;
    const spec = trial.spec;
    const task: EventTaskPosition = {
      episode_id: STALL_MODULE_ID,
      module_id: STALL_MODULE_ID,
      block_id: spec.block_id,
      trial_id: spec.trial_id,
      trial_index: spec.trial_index,
      probe_group_id: trial.kind === 'probe' ? trial.probeGroupId : null,
      form_id: spec.form_id,
      anchor_trial: spec.anchor_trial,
    };
    const variant = (spec.params as { variant?: unknown }).variant;
    const condition: EventCondition = {
      phase: spec.phase,
      condition_id: spec.condition_id,
      shift_active: trial.block.conditions.shift_active,
      timer: trial.block.conditions.timer,
      noise: trial.block.conditions.noise,
      calibration_level: spec.calibration_level,
      variant_seed: typeof variant === 'number' ? (variant >>> 0).toString(16) : null,
      customer_tone_level: trial.toneLevel,
    };
    return ctx.logger.child({ task, condition, scorable: spec.scorable });
  }

  /** Common trial prologue: scoped logging, ISI marking, context shift, trial_start. */
  private beginTrial(trial: StallTrial): {
    log: EventLogger;
    startMs: number;
    taps: RawTap[];
    stop: () => void;
  } {
    const ctx = this.ctx as ModuleContext;
    const input = ctx.input as typeof ctx.input & InputExtras;
    const log = this.trialLogger(trial);
    input.setLogger?.(log);
    input.markIsi?.();
    const taps: RawTap[] = [];
    const unsub = ctx.input.onRawTap((t) => taps.push(t));
    const startMs = ctx.clock.now();
    if (trial.contextShift && ctx.config.context_shift) {
      log.log('context_shift', {
        kind: ctx.config.context_shift.kind as ContextShiftPayload['kind'],
        announced: ctx.config.context_shift.announced,
        shift_index: trial.spec.trial_index,
      });
    }
    log.log('trial_start', {
      trial_type: trial.trialType,
      stimulus_id: trial.stimulusId,
      response_window_ms: trial.spec.response_window_ms,
      private_report: false,
      expected_response: trial.expectedResponse,
    });
    this.debug.trialIndex = trial.spec.trial_index;
    this.debug.trialId = trial.spec.trial_id;
    this.debug.trialType = trial.trialType;
    this.debug.expected = null;
    this.debug.phase = 'isi';
    return { log, startMs, taps, stop: unsub };
  }

  private endAborted(log: EventLogger, startMs: number): TrialOutcome {
    const ctx = this.ctx as ModuleContext;
    this.clearInteractive();
    log.log(
      'trial_end',
      {
        outcome: 'aborted',
        correctness: null,
        response_count: 0,
        duration_ms: round3(ctx.clock.now() - startMs),
      },
      { interrupted: true },
    );
    return 'aborted';
  }

  private isiOf(trial: StallTrial): number {
    return Math.max(0, (trial.spec.timing.isi_ms ?? 0) + (trial.spec.timing.jitter_ms ?? 0));
  }

  private logOnset(log: EventLogger, trial: StallTrial, presented: PresentedOnset): void {
    log.log(
      'stimulus_onset',
      {
        stimulus_id: trial.stimulusId,
        stimulus_version: STIMULUS_VERSION,
        requested_onset_ms: round3(presented.requestedOnsetMs),
        presented_onset_ms: round3(presented.presentedOnsetMs),
        audio_onset_ms: null,
        onset_source: 'raf_commit',
        duration_ms: null,
      },
      { timingFlag: presented.timingFlag },
    );
  }

  private async runTrial(trial: StallTrial, inBlock: number): Promise<TrialOutcome> {
    if (trial.kind === 'serve') return this.runServe(trial, inBlock);
    if (trial.kind === 'tone') return this.runTone(trial);
    return this.runProbe(trial);
  }

  /* ---------------------------------------------- serving (go / no-go) -------------------------- */

  private async runServe(trial: ServeTrial, inBlock: number): Promise<TrialOutcome> {
    const ctx = this.ctx as ModuleContext;
    const view = this.view as StallView;
    const { log, startMs, taps, stop } = this.beginTrial(trial);
    try {
      const isi = this.isiOf(trial);
      view.customerApproach(trial, isi);
      if (trial.practice && inBlock === 0) view.showHint(null);
      const botApproach = this.bot?.approach(isi, ctx.signal).catch(() => undefined);
      await ctx.clock.delay(isi, ctx.signal);
      await botApproach;
      const windowMs = trial.spec.response_window_ms ?? 0;
      const presented = await presentStimulus(ctx.clock, () => {
        view.presentServe(trial);
        if (trial.rush) view.startTimer(windowMs);
        this.setTargets([STALL_TARGETS.plate]);
        if (trial.practice) view.showHint(trial.spoiled ? 'hold_back' : 'serve');
      });
      ctx.signal.throwIfAborted();
      this.logOnset(log, trial, presented);
      this.debug.phase = 'stimulus';
      this.debug.expected = trial.spoiled ? 'withhold' : 'serve';
      const onset = presented.presentedOnsetMs;
      const botRun = this.bot?.serve(trial, windowMs, ctx.signal).catch(() => undefined);
      const result = await ctx.input.waitForTap([STALL_TARGETS.plate], {
        anchorMs: onset,
        windowMs,
        signal: ctx.signal,
      });
      if (result.kind === 'aborted') return this.endAborted(log, startMs);
      if (result.kind === 'tap') {
        view.serveTapped(trial);
        if (trial.practice) view.showHint(null);
      }
      // Fixed pacing: the trial always lasts the full response window (extra taps are captured).
      const remaining = onset + windowMs - ctx.clock.now();
      if (remaining > 0) await ctx.clock.delay(remaining, ctx.signal);
      await botRun;
      this.setTargets([]);
      if (trial.practice) view.showHint(null);
      const c = classifyGngTrial(
        trial.trialType,
        { onsetMs: onset, responseWindowMs: windowMs },
        taps.map((t) => ({
          tMs: t.tMs,
          onTarget: t.targetId === STALL_TARGETS.plate,
          filtered: t.filtered,
        })),
        PREMATURE_THRESHOLD_MS,
      );
      const fields = gngResponseFields(c, 'serve');
      // The input layer's wait is authoritative for the commit and its latency.
      const responded = result.kind === 'tap';
      const latency = result.kind === 'tap' ? result.latencyMs : null;
      const correctness = trial.trialType === 'go' ? responded : !responded;
      log.log(
        'response',
        {
          stimulus_id: trial.stimulusId,
          response_value: responded ? 'serve' : null,
          correctness,
          input_mode: responded ? 'touch' : 'timeout',
          latency_ms: latency,
          latency_anchor: 'visual_onset',
          barge_in: false,
          hold_ms: null,
          tap_count: fields.tap_count,
          revisions: [],
          touch_xy_norm:
            result.kind === 'tap' ? [result.tap.xyNorm[0], result.tap.xyNorm[1]] : null,
        },
        { timingFlag: presented.timingFlag },
      );
      log.log('trial_end', {
        outcome:
          trial.trialType === 'go'
            ? responded
              ? 'correct'
              : 'omission'
            : responded
              ? 'commission'
              : 'correct',
        correctness,
        response_count: responded ? 1 : 0,
        duration_ms: round3(ctx.clock.now() - startMs),
      });
      this.debug.phase = 'resolve';
      this.debug.expected = null;
      view.resolveServe(trial, responded ? 'served' : 'held_back');
      return 'done';
    } catch (err) {
      if (isAbortError(err) || ctx.signal.aborted) return this.endAborted(log, startMs);
      throw err;
    } finally {
      stop();
    }
  }

  /* ---------------------------------------------- tone choice ----------------------------------- */

  private async runTone(trial: ToneTrial): Promise<TrialOutcome> {
    const ctx = this.ctx as ModuleContext;
    const view = this.view as StallView;
    const plan = this.plan as StallPlan;
    const { log, startMs, stop } = this.beginTrial(trial);
    const waitAc = new AbortController();
    const onAbort = (): void => waitAc.abort(ctx.signal.reason);
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    try {
      const isi = this.isiOf(trial);
      view.customerApproach(trial, isi);
      await ctx.clock.delay(isi, ctx.signal);
      const ids = plan.toneCodes.map((c) => STALL_TARGETS.tone(c));
      const presented = await presentStimulus(ctx.clock, () => {
        view.presentTone(trial, plan.toneCodes);
        this.setTargets(ids);
      });
      ctx.signal.throwIfAborted();
      this.logOnset(log, trial, presented);
      this.debug.phase = 'stimulus';
      this.debug.expected = 'tone';
      const onset = presented.presentedOnsetMs;
      const speech = this.speak(trial.lineId);
      view.customerSpeak(trial, speech);
      // Anchor: the end of the customer's line (ENG-01: spoken prompts anchor on audio end).
      const audioEnd: Promise<number> = speech
        ? speech.ended.then((r) => {
            log.log('prompt_audio_end', { line_id: trial.lineId, audio_end_ms: round3(r.endMs) });
            return r.endMs;
          })
        : Promise.resolve(onset);
      const windowMs = trial.spec.response_window_ms;
      void audioEnd.then((endMs) => {
        if (windowMs === null || waitAc.signal.aborted) return;
        const remaining = endMs + windowMs - ctx.clock.now();
        ctx.clock.delay(Math.max(0, remaining), waitAc.signal).then(
          () => {
            timedOut = true;
            waitAc.abort({ kind: 'tone_window' });
          },
          () => undefined,
        );
      });
      if (this.rudeRunStart === null && trial.block.phase === 'shift_post')
        this.rudeRunStart = trial.spec.trial_index;
      const runPosition =
        trial.block.phase === 'shift_post' && this.rudeRunStart !== null
          ? trial.spec.trial_index - this.rudeRunStart
          : null;
      const botRun = this.bot
        ?.tone(trial, plan.toneCodes, audioEnd, runPosition, waitAc.signal)
        .catch(() => undefined);
      const result = await ctx.input.waitForTap(ids, {
        anchorMs: onset,
        windowMs: null,
        signal: waitAc.signal,
      });
      if (result.kind === 'aborted' && !timedOut) return this.endAborted(log, startMs);
      const code =
        result.kind === 'tap'
          ? (plan.toneCodes.find((c) => STALL_TARGETS.tone(c) === result.tap.targetId) ?? null)
          : null;
      this.setTargets([]);
      view.toneChosen(trial, code);
      // The customer finishes their sentence before the exchange resolves (barge-ins included).
      const endMs = await audioEnd;
      waitAc.abort({ kind: 'resolved' });
      await botRun;
      const latency = result.kind === 'tap' ? round3(result.tap.tMs - endMs) : null;
      log.log('response', {
        stimulus_id: trial.stimulusId,
        response_value: code,
        correctness: null,
        input_mode: code ? 'touch' : 'timeout',
        latency_ms: code ? latency : null,
        latency_anchor: speech ? 'audio_end' : 'visual_onset',
        barge_in: code !== null && latency !== null && latency < 0,
        hold_ms: null,
        tap_count: result.kind === 'tap' ? 1 : 0,
        revisions: [],
        touch_xy_norm: result.kind === 'tap' ? [result.tap.xyNorm[0], result.tap.xyNorm[1]] : null,
      });
      log.log('trial_end', {
        outcome: code ? 'not_applicable' : 'timeout',
        correctness: null,
        response_count: code ? 1 : 0,
        duration_ms: round3(ctx.clock.now() - startMs),
      });
      this.debug.phase = 'resolve';
      this.debug.expected = null;
      view.resolveTone(trial);
      return 'done';
    } catch (err) {
      if (isAbortError(err) || ctx.signal.aborted) return this.endAborted(log, startMs);
      throw err;
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
      if (!waitAc.signal.aborted) waitAc.abort({ kind: 'resolved' });
      stop();
    }
  }

  /* ---------------------------------------------- probe ----------------------------------------- */

  private async runProbe(trial: ProbeTrial): Promise<TrialOutcome> {
    const ctx = this.ctx as ModuleContext;
    const view = this.view as StallView;
    const plan = this.plan as StallPlan;
    const { log, startMs, stop } = this.beginTrial(trial);
    try {
      const isi = this.isiOf(trial);
      view.customerApproach(trial, isi);
      await ctx.clock.delay(isi, ctx.signal);
      const ids = plan.probeCodes.map((c) => STALL_TARGETS.probe(c));
      const windowMs = trial.spec.response_window_ms;
      const presented = await presentStimulus(ctx.clock, () => {
        view.presentProbe(trial, plan.probeCodes);
        this.setTargets(ids);
      });
      ctx.signal.throwIfAborted();
      this.logOnset(log, trial, presented);
      this.debug.phase = 'stimulus';
      this.debug.expected = 'probe';
      const onset = presented.presentedOnsetMs;
      const botRun =
        windowMs !== null
          ? this.bot?.probe(trial, plan.probeCodes, windowMs, ctx.signal).catch(() => undefined)
          : undefined;
      const result = await ctx.input.waitForTap(ids, {
        anchorMs: onset,
        windowMs,
        signal: ctx.signal,
      });
      if (result.kind === 'aborted') return this.endAborted(log, startMs);
      await botRun;
      const code =
        result.kind === 'tap'
          ? (plan.probeCodes.find((c) => STALL_TARGETS.probe(c) === result.tap.targetId) ?? null)
          : null;
      this.setTargets([]);
      view.probeChosen(trial, code);
      log.log(
        'response',
        {
          stimulus_id: trial.stimulusId,
          response_value: code,
          correctness: null,
          input_mode: code ? 'touch' : 'timeout',
          latency_ms: result.kind === 'tap' ? result.latencyMs : null,
          latency_anchor: 'visual_onset',
          barge_in: false,
          hold_ms: null,
          tap_count: result.kind === 'tap' ? 1 : 0,
          revisions: [],
          touch_xy_norm:
            result.kind === 'tap' ? [result.tap.xyNorm[0], result.tap.xyNorm[1]] : null,
        },
        { timingFlag: presented.timingFlag },
      );
      log.log('trial_end', {
        outcome: code ? 'not_applicable' : 'timeout',
        correctness: null,
        response_count: code ? 1 : 0,
        duration_ms: round3(ctx.clock.now() - startMs),
      });
      this.debug.phase = 'resolve';
      this.debug.expected = null;
      return 'done';
    } catch (err) {
      if (isAbortError(err) || ctx.signal.aborted) return this.endAborted(log, startMs);
      throw err;
    } finally {
      stop();
    }
  }
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
