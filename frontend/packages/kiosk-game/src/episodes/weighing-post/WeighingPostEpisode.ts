/**
 * Episode 2 of Pathway A: The Weighing Post ("The Weighmaster", EPI-02).
 *
 * The player is the market weighmaster at a brass beam scale in the late golden afternoon. Goods arrive
 * with a declared quantity pictured as brass weights on the right pan; the needle shows the difference.
 * The player approves, warns or fines (select, then confirm), and may re-weigh ("inspect more") first.
 * Dilemmas (>= 3 per type): a bribe, an overpayment, the assistant's mistake (credit/blame) and the
 * assistant's discovery of fraud (credit). A gamble inspection measures risk preference, luck tokens
 * reuse the private-report logic (dice mode a: the roll is never stored), and an announced new market
 * rule is the context shift. Two comparable probe segments close the episode.
 *
 * Event conventions are those the indicator engine reads (see `schedule.ts`). Nothing in this module
 * shows a score, a number or a judgement: reactions depend only on the choice, never on correctness.
 */
import type {
  ContextShiftPayload,
  EventCondition,
  EventTaskPosition,
  LatencyAnchor,
} from '@shriii/contracts';
import type {
  ConstructId,
  EventLogger,
  GameModule,
  IndicatorId,
  LineId,
  ModuleContext,
  ModuleEndedReason,
  ModuleResult,
  Rect,
  TargetHandle,
  Unsubscribe,
} from '../../core/contracts.ts';
import { abortReasonOf } from '../../core/contracts.ts';
import { presentStimulus } from '../../engine/timing.ts';
import {
  assertNoTrueOutcome,
  PrivateReportTrial,
  parseFaceCode,
} from '../../paradigms/private-report.ts';
import {
  creditAllocationPayload,
  resolveGamble,
  WEIGH_DECISIONS,
  type WeighDecision,
} from '../../paradigms/weighing-post.ts';
import { type BotPolicy, WeighingBot } from './bot.ts';
import { type ChoiceAnchor, type ChoiceOutcome, runChoice } from './decision.ts';
import { LINE, optionLine, promptLine, readingLine } from './lines.ts';
import { BudgetPacer } from './pacing.ts';
import { type EpisodeParams, episodeParams } from './params.ts';
import { HeadlessWeighingScene } from './scene/headless.ts';
import { CHOREO, type ChoiceKind, type SpeakerRole, type WeighingScene } from './scene/types.ts';
import {
  type AllocationCode,
  buildEpisodePlan,
  type DilemmaTrial,
  type EpisodePlan,
  type EpisodeTrial,
  type GambleTrial,
  type LuckTrial,
  MODULE_ID,
  type ProbeTrial,
  trialParamsOf,
  type WeighTrial,
} from './schedule.ts';

/** Constructs this episode provides evidence for (must match the config). */
export const WEIGHING_POST_CONSTRUCTS: readonly ConstructId[] = [
  'adaptability',
  'decisiveness',
  'integrity',
  'judgement',
  'persistence_of_style',
  'response_consistency',
  'risk_preference',
  'stability',
];

/** Indicator declarations (ENG-08), identical to `config.indicators`. */
export const WEIGHING_POST_INDICATORS: readonly IndicatorId[] = [
  'adaptability.rule_compliance_post_shift',
  'decisiveness.commit_rvi',
  'decisiveness.info_gathered',
  'decisiveness.reversals_before_confirm',
  'decisiveness.time_to_commit',
  'integrity.bribe_acceptance',
  'integrity.luck_token_overreport_rate',
  'integrity.overpayment_return',
  'judgement.blame_shifting',
  'judgement.consistency_across_dilemmas',
  'judgement.credit_taking',
  'persistence_of_style.cross_segment_style_r',
  'persistence_of_style.lag1_autocorr',
  'response_consistency.choice_entropy_repeats',
  'response_consistency.loc_scale_sigma',
  'risk_preference.gamble_rate',
  'stability.shift_slope',
  'stability.shift_slope_new_rule',
];

/** Target ids (the scorer counts on-target taps on `*inspect_more`). */
export const TARGET = {
  confirm: `${MODULE_ID}.confirm`,
  inspect: `${MODULE_ID}.inspect_more`,
  replay: `${MODULE_ID}.replay`,
  option: (kind: ChoiceKind, code: string): string =>
    kind === 'probe' ? `${MODULE_ID}.probe_${code}` : `${MODULE_ID}.${kind}.${code}`,
} as const;

/** Builds the rendered scene (injected so tests and headless runs need no renderer). */
export type SceneFactory = (ctx: ModuleContext) => WeighingScene | Promise<WeighingScene>;

export interface WeighingPostOptions {
  /** Scene factory; default: the headless scene (the package entry wires the Pixi scene). */
  readonly scene?: SceneFactory;
  /** Bot policy for `dev.headless` runs. */
  readonly bot?: BotPolicy;
  /** Called once the plan is built (dev harness: export trial params for the scorer). */
  readonly onPlan?: (plan: EpisodePlan, params: EpisodeParams) => void;
}

type TrialResult = 'done' | 'aborted';

interface TrialScope {
  readonly log: EventLogger;
  readonly startMs: number;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

export class WeighingPostEpisode implements GameModule {
  readonly id = MODULE_ID;
  readonly kind = 'episode' as const;
  readonly constructs = WEIGHING_POST_CONSTRUCTS;
  readonly indicators = WEIGHING_POST_INDICATORS;

  private ctx: ModuleContext | null = null;
  private plan: EpisodePlan | null = null;
  private params: EpisodeParams | null = null;
  private scene: WeighingScene | null = null;
  private bot: WeighingBot | null = null;
  private readonly options: WeighingPostOptions;
  private targets = new Map<string, { handle: TargetHandle; rect: Rect }>();
  private replayHandle: TargetHandle | null = null;
  private unsubs: Unsubscribe[] = [];
  private destroyed = false;

  constructor(options: WeighingPostOptions = {}) {
    this.options = options;
  }

  /** The plan (after `init`). */
  get currentPlan(): EpisodePlan | null {
    return this.plan;
  }

  /** `trial_id -> GameTrialSpec.params` for the scoring engine (after `init`). */
  trialParams(): Record<string, Readonly<Record<string, unknown>>> {
    return this.plan ? trialParamsOf(this.plan) : {};
  }

  async init(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
    this.params = episodeParams(ctx.config);
    this.plan = buildEpisodePlan(
      ctx.config,
      ctx.level,
      ctx.rng.stream('schedule'),
      ctx.session.formId,
      this.params,
    );
    this.options.onPlan?.(this.plan, this.params);
    this.scene = this.options.scene
      ? await this.options.scene(ctx)
      : new HeadlessWeighingScene(ctx.layout);
    await this.scene.mount();
    if (ctx.dev.headless) {
      this.bot = new WeighingBot({
        rng: ctx.rng.stream('bot'),
        input: ctx.input,
        clock: ctx.clock,
        app: ctx.app,
        stageSize: () => ({ width: ctx.layout.width, height: ctx.layout.height }),
        ...(this.options.bot ? { policy: this.options.bot } : {}),
      });
    }
    const replay = this.scene.controls().replay;
    this.replayHandle = ctx.input.registerTarget({
      id: TARGET.replay,
      bounds: replay,
      audioKey: LINE.replay,
      kind: 'tap',
      enabled: true,
    });
    this.unsubs.push(
      ctx.input.onRawTap((tap) => {
        if (tap.targetId === TARGET.replay && tap.filtered === 'none' && !ctx.signal.aborted) {
          ctx.voice.replayLast({ replay: true, signal: ctx.signal });
        }
      }),
    );
    void ctx.voice
      .preload(ctx.config.audio_keys.filter((k) => ctx.voice.has(k)))
      .catch(() => undefined);
  }

  async run(): Promise<ModuleResult> {
    const ctx = this.ctx;
    const plan = this.plan;
    const scene = this.scene;
    if (!ctx || !plan || !scene) throw new Error('WeighingPostEpisode.run before init');
    const startMs = ctx.clock.now();
    let completed = 0;
    let scorable = 0;
    let shiftLogged: number | null = null;
    const doneInBlock = new Map<string, number>();

    ctx.audio.playMusic('weighing_post', { fadeMs: 1800 });
    ctx.audio.setAmbience('market_day', { fadeMs: 1800 });

    let aborted = !(await this.intro());
    const luckTrials = plan.trials.filter((t) => t.kind === 'luck');
    const probeTrials = plan.trials.filter((t) => t.kind === 'probe');
    const total = plan.trials.length;
    const timing = ctx.levelConfig.timing;
    const pacer = new BudgetPacer(
      plan.trials,
      {
        settleMs: timing.needle_settle_ms ?? 1200,
        decisionMs: timing.decision_window_ms ?? 8000,
        dilemmaMs: timing.dilemma_window_ms ?? 9000,
      },
      ctx.config.budget.soft_cap_ms,
      ctx.config.budget.outro_ms,
    );

    for (let i = 0; i < plan.trials.length && !aborted; i += 1) {
      const trial = plan.trials[i];
      if (!trial) continue;
      const block = trial.block;
      const inBlock = doneInBlock.get(block.block_id) ?? 0;
      // Soft-cap wrap-up (ENG-05): finish the current trial, keep every block minimum.
      if (ctx.wrapUp?.requested && inBlock >= block.min_trials) continue;
      // Budget pacing: skip an optional trial when it would squeeze out a remaining minimum.
      if (pacer.shouldSkip(i, ctx.clock.now() - startMs)) continue;
      scene.setProgress(i / total);

      if (trial.contextShift) {
        if (!(await this.announceNewRule())) {
          aborted = true;
          break;
        }
      }
      if (trial.kind === 'luck' && trial === luckTrials[0]) {
        scene.luckBegin();
        if (!(await this.sleep(CHOREO.luckBeginMs))) break;
      }
      if (trial.kind === 'probe' && trial === probeTrials[0]) {
        scene.probeBegin();
        if (!(await this.sleep(CHOREO.probeBeginMs))) break;
      }

      const scope = this.openTrial(trial);
      if (trial.contextShift && ctx.config.context_shift) {
        const payload: ContextShiftPayload = {
          kind: 'new_market_rule',
          announced: ctx.config.context_shift.announced,
          shift_index: trial.spec.trial_index,
        };
        scope.log.log('context_shift', payload);
        shiftLogged = trial.spec.trial_index;
      }
      const r = await this.runTrial(trial, scope);
      if (r === 'aborted') {
        aborted = true;
        break;
      }
      pacer.record(trial, ctx.clock.now() - scope.startMs);
      completed += 1;
      if (trial.spec.scorable) scorable += 1;
      doneInBlock.set(block.block_id, inBlock + 1);

      if (trial.kind === 'luck' && trial === luckTrials.at(-1)) {
        scene.luckEnd();
        if (!(await this.sleep(CHOREO.luckEndMs))) aborted = true;
      }
      if (trial.kind === 'probe' && trial === probeTrials.at(-1)) {
        scene.probeEnd();
        if (!(await this.sleep(CHOREO.probeEndMs))) aborted = true;
      }
    }
    if (!aborted) aborted = !(await this.outro());
    this.removeTrialTargets();
    const reason = abortReasonOf(ctx.signal);
    const endedReason: ModuleEndedReason = reason
      ? reason.kind === 'crash'
        ? 'error'
        : reason.kind
      : 'completed';
    if (!reason) ctx.audio.stopMusic(1600);
    return {
      moduleId: MODULE_ID,
      endedReason,
      durationMs: round3(ctx.clock.now() - startMs),
      trialsCompleted: completed,
      scorableTrials: scorable,
      contextShiftIndex: shiftLogged,
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.removeTrialTargets();
    this.replayHandle?.remove();
    this.replayHandle = null;
    this.scene?.destroy();
    this.scene = null;
  }

  /* ============================================ helpers ============================================ */

  private get c(): ModuleContext {
    if (!this.ctx) throw new Error('WeighingPostEpisode: no context');
    return this.ctx;
  }

  private get s(): WeighingScene {
    if (!this.scene) throw new Error('WeighingPostEpisode: no scene');
    return this.scene;
  }

  /** Session-clock wait; false when the module was aborted. */
  private async sleep(ms: number): Promise<boolean> {
    if (this.c.signal.aborted) return false;
    if (ms <= 0) return true;
    try {
      await this.c.clock.delay(ms, this.c.signal);
      return true;
    } catch {
      return false;
    }
  }

  /** Play lines (those the voice service has) with the speaker animation; resolves at the end. */
  private async say(lines: readonly LineId[], role: SpeakerRole): Promise<number | null> {
    const ctx = this.c;
    const playable = lines.filter((l) => ctx.voice.has(l));
    if (playable.length === 0 || ctx.signal.aborted) return null;
    this.s.speaker(role);
    const pb = ctx.voice.playSequence(playable, { signal: ctx.signal });
    const r = await pb.ended;
    this.s.speaker(null);
    return r.endMs;
  }

  private async intro(): Promise<boolean> {
    const ctx = this.c;
    const t0 = ctx.clock.now();
    this.s.intro();
    const budget = ctx.config.budget.intro_ms;
    const voice = (async () => {
      if (!(await this.sleep(900))) return;
      await this.say([LINE.intro], 'guide');
    })();
    const minimum = this.sleep(CHOREO.introMinMs);
    await Promise.race([Promise.all([voice, minimum]), this.sleep(budget)]);
    if (ctx.signal.aborted) return false;
    const elapsed = ctx.clock.now() - t0;
    return elapsed >= CHOREO.introMinMs || (await this.sleep(CHOREO.introMinMs - elapsed));
  }

  private async outro(): Promise<boolean> {
    const ctx = this.c;
    this.s.outro();
    const budget = ctx.config.budget.outro_ms;
    const voice = this.say([LINE.outro], 'guide');
    await Promise.race([
      Promise.all([voice, this.sleep(Math.min(budget, 2400))]),
      this.sleep(budget),
    ]);
    return !ctx.signal.aborted;
  }

  private async announceNewRule(): Promise<boolean> {
    const plan = this.plan;
    if (!plan) return false;
    this.s.newRuleAnnounce(plan.newRule);
    const voice = (async () => {
      if (!(await this.sleep(500))) return;
      await this.say([LINE.newRule], 'inspector');
    })();
    await Promise.all([voice, this.sleep(CHOREO.newRuleMinMs)]);
    if (this.c.signal.aborted) return false;
    this.s.newRuleDone();
    return this.sleep(CHOREO.newRuleSettleMs);
  }

  private openTrial(trial: EpisodeTrial): TrialScope {
    const ctx = this.c;
    const spec = trial.spec;
    const task: EventTaskPosition = {
      episode_id: MODULE_ID,
      module_id: MODULE_ID,
      block_id: spec.block_id,
      trial_id: spec.trial_id,
      trial_index: spec.trial_index,
      probe_group_id: spec.probe_group_id,
      form_id: spec.form_id,
      anchor_trial: spec.anchor_trial,
    };
    const condition: EventCondition = {
      phase: spec.phase,
      condition_id: spec.condition_id,
      shift_active: trial.block.conditions.shift_active,
      timer: trial.block.conditions.timer,
      noise: trial.block.conditions.noise,
      calibration_level: spec.calibration_level,
      variant_seed: (trial.variant >>> 0).toString(16),
    };
    const log = ctx.logger.child({ task, condition, scorable: spec.scorable });
    return { log, startMs: ctx.clock.now() };
  }

  private async runTrial(trial: EpisodeTrial, scope: TrialScope): Promise<TrialResult> {
    switch (trial.kind) {
      case 'weigh':
        return this.runWeigh(trial, scope);
      case 'bribe':
      case 'overpayment':
      case 'assistant_mistake':
      case 'fraud_found':
        return this.runDilemma(trial, scope);
      case 'gamble':
        return this.runGamble(trial, scope);
      case 'luck':
        return this.runLuck(trial, scope);
      case 'probe':
        return this.runProbe(trial, scope);
      default: {
        const never: never = trial;
        throw new Error(`unknown trial ${String(never)}`);
      }
    }
  }

  private logTrialStart(trial: EpisodeTrial, scope: TrialScope): void {
    const spec = trial.spec;
    scope.log.log('trial_start', {
      trial_type: spec.trial_type,
      stimulus_id: spec.stimulus_id,
      response_window_ms: spec.response_window_ms,
      private_report: spec.private_report,
      expected_response: spec.expected_response,
    });
  }

  private logOnset(
    scope: TrialScope,
    stimulusId: string,
    presented: Awaited<ReturnType<typeof presentStimulus>>,
  ): void {
    scope.log.log(
      'stimulus_onset',
      {
        stimulus_id: stimulusId,
        stimulus_version: 'weighing_post.1',
        requested_onset_ms: round3(Math.max(0, presented.requestedOnsetMs)),
        presented_onset_ms: round3(Math.max(0, presented.presentedOnsetMs)),
        audio_onset_ms: null,
        onset_source: 'raf_commit',
        duration_ms: null,
      },
      { timingFlag: presented.timingFlag },
    );
  }

  /** Abort path: close the trial with `aborted` (interrupted). */
  private endAborted(scope: TrialScope): TrialResult {
    this.disableTrialTargets();
    this.s.hideChoices();
    this.s.setInspectVisible(false, false);
    scope.log.log(
      'trial_end',
      {
        outcome: 'aborted',
        correctness: null,
        response_count: 0,
        duration_ms: round3(Math.max(0, this.c.clock.now() - scope.startMs)),
      },
      { interrupted: true },
    );
    return 'aborted';
  }

  /* ------------------------------------------ targets ------------------------------------------- */

  private registerChoiceTargets(
    kind: ChoiceKind,
    codes: readonly string[],
    withConfirm: boolean,
    withInspect: boolean,
  ): void {
    const ctx = this.c;
    this.removeTrialTargets();
    for (const slot of this.s.layoutChoices(kind, codes)) {
      const id = TARGET.option(kind, slot.code);
      const handle = ctx.input.registerTarget({
        id,
        bounds: slot.rect,
        audioKey: optionLine(kind, slot.code),
        kind: 'tap',
      });
      handle.setEnabled(false);
      this.targets.set(id, { handle, rect: slot.rect });
    }
    const controls = this.s.controls();
    if (withConfirm) {
      const handle = ctx.input.registerTarget({
        id: TARGET.confirm,
        bounds: controls.confirm,
        audioKey: optionLine('control', 'confirm'),
        kind: 'tap',
      });
      handle.setEnabled(false);
      this.targets.set(TARGET.confirm, { handle, rect: controls.confirm });
    }
    if (withInspect) {
      const handle = ctx.input.registerTarget({
        id: TARGET.inspect,
        bounds: controls.inspect,
        audioKey: optionLine('control', 'inspect_more'),
        kind: 'tap',
      });
      handle.setEnabled(false);
      this.targets.set(TARGET.inspect, { handle, rect: controls.inspect });
    }
  }

  /** Move the confirm seal (and its touch target) above the selected token. */
  private moveConfirm(kind: ChoiceKind, code: string): void {
    const token = this.targets.get(TARGET.option(kind, code));
    const confirm = this.targets.get(TARGET.confirm);
    if (!token || !confirm) return;
    const rect = this.s.confirmFor(token.rect);
    confirm.handle.setBounds(rect);
    this.targets.set(TARGET.confirm, { handle: confirm.handle, rect });
  }

  private enableTargets(ids: readonly string[], enabled: boolean): void {
    for (const id of ids) this.targets.get(id)?.handle.setEnabled(enabled);
  }

  private disableTrialTargets(): void {
    for (const t of this.targets.values()) t.handle.setEnabled(false);
  }

  private removeTrialTargets(): void {
    for (const t of this.targets.values()) t.handle.remove();
    this.targets.clear();
  }

  private optionIds(kind: ChoiceKind, codes: readonly string[]): string[] {
    return codes.map((c) => TARGET.option(kind, c));
  }

  /** Anchor for a choice: end of the spoken prompt if any line plays, else the go signal. */
  private anchorFor(
    scope: TrialScope,
    lines: readonly LineId[],
    goMs: number,
    visualAnchor: LatencyAnchor,
    role: SpeakerRole,
  ): { anchor: Promise<ChoiceAnchor>; kind: LatencyAnchor } {
    const ctx = this.c;
    const playable = lines.filter((l) => ctx.voice.has(l));
    if (playable.length === 0) {
      return {
        anchor: Promise.resolve({ anchorMs: goMs, anchor: visualAnchor }),
        kind: visualAnchor,
      };
    }
    this.s.speaker(role);
    const pb = ctx.voice.playSequence(playable, { signal: ctx.signal });
    const last = playable[playable.length - 1] ?? playable[0] ?? '';
    const anchor = pb.ended.then((r) => {
      this.s.speaker(null);
      const endMs = round3(Math.max(0, r.endMs));
      scope.log.log('prompt_audio_end', { line_id: last, audio_end_ms: endMs });
      return { anchorMs: endMs, anchor: 'audio_end' as const };
    });
    return { anchor, kind: 'audio_end' };
  }

  private choiceBot(trial: EpisodeTrial, kind: ChoiceKind, anchor: Promise<ChoiceAnchor>): void {
    const bot = this.bot;
    if (!bot) return;
    const script = bot.script(trial, {
      option: (code) => TARGET.option(kind, code),
      confirm: TARGET.confirm,
      inspect: TARGET.inspect,
    });
    void bot.play(script, anchor, (id) => this.targets.get(id)?.rect ?? null, this.c.signal);
  }

  private logResponse<C extends string>(
    scope: TrialScope,
    stimulusId: string,
    out: ChoiceOutcome<C>,
    anchorKind: LatencyAnchor,
    correctness: boolean | null,
  ): void {
    const timeout = out.kind !== 'response';
    scope.log.log('response', {
      stimulus_id: stimulusId,
      response_value: timeout ? null : out.value,
      correctness: timeout ? null : correctness,
      input_mode: timeout ? 'timeout' : 'touch',
      latency_ms: timeout ? null : out.latencyMs,
      latency_anchor: out.anchor?.anchor ?? anchorKind,
      barge_in: timeout ? false : out.bargeIn,
      hold_ms: null,
      tap_count: out.tapCount,
      revisions: out.revisions.map((r) => ({ value: r.value, t_ms: round3(Math.max(0, r.tMs)) })),
      touch_xy_norm: timeout || !out.touchXyNorm ? null : [out.touchXyNorm[0], out.touchXyNorm[1]],
      asr_label: null,
      asr_confidence: null,
    });
  }

  private logTrialEnd(
    scope: TrialScope,
    outcome: 'correct' | 'incorrect' | 'timeout' | 'not_applicable',
    correctness: boolean | null,
    responses: number,
  ): void {
    scope.log.log('trial_end', {
      outcome,
      correctness,
      response_count: responses,
      duration_ms: round3(Math.max(0, this.c.clock.now() - scope.startMs)),
    });
    (this.c.input as { markIsi?: () => void }).markIsi?.();
  }

  /* ------------------------------------------- trials ------------------------------------------- */

  private async runWeigh(trial: WeighTrial, scope: TrialScope): Promise<TrialResult> {
    const ctx = this.c;
    const scene = this.s;
    const spec = trial.spec;
    const stimulusId = spec.stimulus_id ?? `${MODULE_ID}.${trial.item.good}`;
    const settleMs = ctx.levelConfig.timing.needle_settle_ms ?? 1200;
    const codes = WEIGH_DECISIONS;
    this.registerChoiceTargets('weigh', codes, true, true);
    if (trial.practice) {
      // Practice (unscored): the guide introduces the first sack before the trial starts.
      await this.say([LINE.practice], 'guide');
      if (ctx.signal.aborted) return 'aborted';
    }
    this.logTrialStart(trial, scope);

    scene.weighPrepare(trial);
    if (!(await this.sleep(CHOREO.weighPrepareMs))) return this.endAborted(scope);
    const onset = await presentStimulus(ctx.clock, () => scene.weighReveal(trial, settleMs));
    this.logOnset(scope, stimulusId, onset);
    // The needle swings and settles within the level's needle_settle_ms (ambiguous readings keep
    // wobbling until re-weighed).
    const settleLeft = onset.presentedOnsetMs + settleMs - ctx.clock.now();
    if (!(await this.sleep(settleLeft))) return this.endAborted(scope);

    const optionIds = this.optionIds('weigh', codes);
    const go = await presentStimulus(ctx.clock, () => {
      scene.showChoices('weigh', codes, { enabled: true });
      scene.setInspectVisible(true, true);
      this.enableTargets([...optionIds, TARGET.inspect], true);
    });
    if (trial.practice) scene.practiceHint(trial.expected);
    let steady = !trial.item.ambiguous;
    // The spoken reading is played only as a whole (prefix + reading clip).
    const reading = readingLine(trial.item, steady);
    const { anchor, kind: anchorKind } = this.anchorFor(
      scope,
      ctx.voice.has(reading) ? [LINE.quantityPrefix, reading] : [],
      go.presentedOnsetMs,
      'go_signal',
      'assistant',
    );
    this.choiceBot(trial, 'weigh', anchor);
    const out = await runChoice<WeighDecision>(ctx.input, ctx.clock, {
      options: codes.map((code) => ({ code, targetId: TARGET.option('weigh', code) })),
      confirmId: TARGET.confirm,
      inspectId: TARGET.inspect,
      goMs: go.presentedOnsetMs,
      anchor,
      windowMs: spec.response_window_ms,
      signal: ctx.signal,
      onSelect: (code) => {
        this.moveConfirm('weigh', code);
        scene.setChoiceState({ enabled: true, selected: code, confirmVisible: true });
      },
      onConfirmAvailable: () => this.enableTargets([TARGET.confirm], true),
      setInspectEnabled: (enabled) => {
        this.enableTargets([TARGET.inspect], enabled);
        scene.setInspectVisible(true, enabled);
      },
      onInspect: async () => {
        const wasSteady = steady;
        steady = true;
        scene.reweigh(trial.item, settleMs, !wasSteady);
        await this.sleep(CHOREO.reweighLiftMs + settleMs);
      },
    });
    scene.clearHints();
    if (out.kind === 'aborted') return this.endAborted(scope);
    this.disableTrialTargets();
    scene.setInspectVisible(false, false);
    const value = out.kind === 'response' ? out.value : null;
    const correct = value === null ? null : value === trial.expected;
    this.logResponse(scope, stimulusId, out, anchorKind, correct);
    this.logTrialEnd(
      scope,
      value === null ? 'timeout' : correct ? 'correct' : 'incorrect',
      correct,
      value === null ? 0 : 1,
    );
    scene.commitChoice(value);
    scene.weighOutcome(trial, value);
    return (await this.sleep(CHOREO.weighExitMs)) ? 'done' : 'aborted';
  }

  private async runDilemma(trial: DilemmaTrial, scope: TrialScope): Promise<TrialResult> {
    const ctx = this.c;
    const scene = this.s;
    const spec = trial.spec;
    const kind = trial.kind;
    const stimulusId = spec.stimulus_id ?? `${MODULE_ID}.${kind}`;
    const codes = trial.codes;
    this.registerChoiceTargets(kind, codes, true, false);
    this.logTrialStart(trial, scope);
    scene.dilemmaPrepare(trial);
    if (!(await this.sleep(CHOREO.dilemmaPrepareMs))) return this.endAborted(scope);
    const optionIds = this.optionIds(kind, codes);
    const onset = await presentStimulus(ctx.clock, () => {
      scene.dilemmaReveal(trial);
      scene.showChoices(kind, codes, { enabled: true });
      this.enableTargets(optionIds, true);
    });
    this.logOnset(scope, stimulusId, onset);
    const { anchor, kind: anchorKind } = this.anchorFor(
      scope,
      [promptLine(kind)],
      onset.presentedOnsetMs,
      'visual_onset',
      kind === 'bribe' || kind === 'overpayment' ? 'customer' : 'guide',
    );
    this.choiceBot(trial, kind, anchor);
    const out = await runChoice<string>(ctx.input, ctx.clock, {
      options: codes.map((code) => ({ code, targetId: TARGET.option(kind, code) })),
      confirmId: TARGET.confirm,
      inspectId: null,
      goMs: onset.presentedOnsetMs,
      anchor,
      windowMs: spec.response_window_ms,
      signal: ctx.signal,
      onSelect: (code) => {
        this.moveConfirm(kind, code);
        scene.setChoiceState({ enabled: true, selected: code, confirmVisible: true });
      },
      onConfirmAvailable: () => this.enableTargets([TARGET.confirm], true),
    });
    if (out.kind === 'aborted') return this.endAborted(scope);
    this.disableTrialTargets();
    const value = out.kind === 'response' ? out.value : null;
    this.logResponse(scope, stimulusId, out, anchorKind, null);
    if (value !== null && (kind === 'assistant_mistake' || kind === 'fraud_found')) {
      scope.log.log('credit_allocation', creditAllocationPayload(kind, value as AllocationCode));
    }
    this.logTrialEnd(
      scope,
      value === null ? 'timeout' : 'not_applicable',
      null,
      value === null ? 0 : 1,
    );
    scene.commitChoice(value);
    scene.dilemmaOutcome(trial, value);
    return (await this.sleep(CHOREO.dilemmaExitMs)) ? 'done' : 'aborted';
  }

  private async runGamble(trial: GambleTrial, scope: TrialScope): Promise<TrialResult> {
    const ctx = this.c;
    const scene = this.s;
    const spec = trial.spec;
    const stimulusId = spec.stimulus_id ?? `${MODULE_ID}.gamble`;
    const codes = ['inspect', 'gamble'] as const;
    this.registerChoiceTargets('gamble', codes, true, false);
    this.logTrialStart(trial, scope);
    scene.gamblePrepare(trial);
    if (!(await this.sleep(CHOREO.gamblePrepareMs))) return this.endAborted(scope);
    const onset = await presentStimulus(ctx.clock, () => {
      scene.gambleReveal(trial);
      scene.showChoices('gamble', codes, { enabled: true });
      this.enableTargets(this.optionIds('gamble', codes), true);
    });
    this.logOnset(scope, stimulusId, onset);
    const { anchor, kind: anchorKind } = this.anchorFor(
      scope,
      [promptLine('gamble')],
      onset.presentedOnsetMs,
      'visual_onset',
      'customer',
    );
    this.choiceBot(trial, 'gamble', anchor);
    const out = await runChoice<'inspect' | 'gamble'>(ctx.input, ctx.clock, {
      options: codes.map((code) => ({ code, targetId: TARGET.option('gamble', code) })),
      confirmId: TARGET.confirm,
      inspectId: null,
      goMs: onset.presentedOnsetMs,
      anchor,
      windowMs: spec.response_window_ms,
      signal: ctx.signal,
      onSelect: (code) => {
        this.moveConfirm('gamble', code);
        scene.setChoiceState({ enabled: true, selected: code, confirmVisible: true });
      },
      onConfirmAvailable: () => this.enableTargets([TARGET.confirm], true),
    });
    if (out.kind === 'aborted') return this.endAborted(scope);
    this.disableTrialTargets();
    const value = out.kind === 'response' ? out.value : null;
    this.logResponse(scope, stimulusId, out, anchorKind, null);
    this.logTrialEnd(
      scope,
      value === null ? 'timeout' : 'not_applicable',
      null,
      value === null ? 0 : 1,
    );
    // Seeded resolution: the same session seed replays the same outcome.
    const caught =
      value === null
        ? false
        : resolveGamble(
            value,
            trial.catchProbability,
            ctx.rng.stream(`gamble.${spec.trial_id}`),
          ) === 'caught';
    scene.commitChoice(value);
    scene.gambleOutcome(trial, value, caught);
    return (await this.sleep(CHOREO.gambleOutcomeMs)) ? 'done' : 'aborted';
  }

  private async runLuck(trial: LuckTrial, scope: TrialScope): Promise<TrialResult> {
    const ctx = this.c;
    const scene = this.s;
    const spec = trial.spec;
    const stimulusId = spec.stimulus_id ?? `${MODULE_ID}.luck_token`;
    const codes = spec.vocabulary;
    this.registerChoiceTargets('luck', codes, false, false);
    this.logTrialStart(trial, scope);
    scene.luckRoll();
    if (!(await this.sleep(CHOREO.luckRollMs))) return this.endAborted(scope);
    const report = new PrivateReportTrial({
      context: 'luck_token',
      reportIndex: trial.reportIndex,
      faces: trial.faces,
    });
    const optionIds = this.optionIds('luck', codes);
    const onset = await presentStimulus(ctx.clock, () => {
      // The face exists only as the callback argument (dice mode a): drawn, never stored.
      report.reveal((face) => scene.luckShowFace(face));
      scene.showChoices('luck', codes, { enabled: true });
      this.enableTargets(optionIds, true);
    });
    this.logOnset(scope, stimulusId, onset);
    const anchor = Promise.resolve<ChoiceAnchor>({
      anchorMs: onset.presentedOnsetMs,
      anchor: 'visual_onset',
    });
    this.choiceBot(trial, 'luck', anchor);
    const out = await runChoice<string>(ctx.input, ctx.clock, {
      options: codes.map((code) => ({ code, targetId: TARGET.option('luck', code) })),
      confirmId: null,
      inspectId: null,
      goMs: onset.presentedOnsetMs,
      anchor,
      windowMs: spec.response_window_ms,
      signal: ctx.signal,
      onSelect: (code) =>
        scene.setChoiceState({ enabled: false, selected: code, confirmVisible: false }),
    });
    scene.luckClear();
    if (out.kind === 'aborted') return this.endAborted(scope);
    this.disableTrialTargets();
    const value = out.kind === 'response' ? out.value : null;
    const reported = parseFaceCode(value, trial.faces);
    this.logResponse(scope, stimulusId, out, 'visual_onset', null);
    if (reported !== null) {
      const payload = report.report(reported, {
        headset: ctx.session.headset,
        onlookerReported: false,
      });
      assertNoTrueOutcome(payload);
      scope.log.log('report', payload);
    }
    this.logTrialEnd(
      scope,
      value === null ? 'timeout' : 'not_applicable',
      null,
      value === null ? 0 : 1,
    );
    scene.commitChoice(value);
    scene.luckOutcome(reported);
    return (await this.sleep(CHOREO.luckOutcomeMs)) ? 'done' : 'aborted';
  }

  private async runProbe(trial: ProbeTrial, scope: TrialScope): Promise<TrialResult> {
    const ctx = this.c;
    const scene = this.s;
    const spec = trial.spec;
    const stimulusId = spec.stimulus_id ?? `probe.${trial.position}`;
    const codes = ['safe', 'risky'] as const;
    this.registerChoiceTargets('probe', codes, false, false);
    this.logTrialStart(trial, scope);
    scene.probePrepare(trial);
    if (!(await this.sleep(CHOREO.probePrepareMs))) return this.endAborted(scope);
    const onset = await presentStimulus(ctx.clock, () => {
      scene.probeReveal(trial);
      scene.showChoices('probe', codes, { enabled: true });
      this.enableTargets(this.optionIds('probe', codes), true);
    });
    this.logOnset(scope, stimulusId, onset);
    const anchor = Promise.resolve<ChoiceAnchor>({
      anchorMs: onset.presentedOnsetMs,
      anchor: 'visual_onset',
    });
    this.choiceBot(trial, 'probe', anchor);
    const out = await runChoice<'safe' | 'risky'>(ctx.input, ctx.clock, {
      options: codes.map((code) => ({ code, targetId: TARGET.option('probe', code) })),
      confirmId: null,
      inspectId: null,
      goMs: onset.presentedOnsetMs,
      anchor,
      windowMs: spec.response_window_ms,
      signal: ctx.signal,
      onSelect: (code) =>
        scene.setChoiceState({ enabled: false, selected: code, confirmVisible: false }),
    });
    if (out.kind === 'aborted') return this.endAborted(scope);
    this.disableTrialTargets();
    const value = out.kind === 'response' ? out.value : null;
    this.logResponse(scope, stimulusId, out, 'visual_onset', null);
    this.logTrialEnd(
      scope,
      value === null ? 'timeout' : 'not_applicable',
      null,
      value === null ? 0 : 1,
    );
    scene.commitChoice(value);
    scene.probeOutcome(trial, value);
    return (await this.sleep(CHOREO.probeOutcomeMs)) ? 'done' : 'aborted';
  }
}
