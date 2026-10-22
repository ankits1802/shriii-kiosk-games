/**
 * Road Home director (EPI-03): runs the plan trial by trial and writes every event.
 *
 * Event conventions (match `stats/scoring` and the simulator, see `conventions.py`):
 * - each trial is `trial_start` -> `stimulus_onset` -> trial events -> `trial_end`, scoped with
 *   `task.trial_id` / `trial_index` / `block_id` and the block's condition (`partner_type` on fodder
 *   rounds); practice is `scorable: false`;
 * - maps log one `route_step` per accepted tap at the tap time (blocked attempts included), and an
 *   `idle` event when the gap between two steps exceeds `constraints.idle_gap_log_ms`;
 * - forks, optional opportunities, probes and fodder rounds log one committed `response`
 *   (timeouts are `input_mode: timeout` with null value and latency);
 * - the rule reversal is logged once as `context_shift { kind: rule_reversal, announced: false }`
 *   immediately before the first reversed fork's `trial_start`, with `shift_index` = its trial
 *   index. No sound, line or visual change announces it (EPI-03 AC);
 * - fodder rounds log `contribution` and `partner_action`; uphill beats log `input.hold`.
 *
 * Timing: stimulus onset is the frame `presenter.reveal()` commits (`presentStimulus`); every latency
 * is signed from that onset (or from the previous route step for later steps). Feedback animations
 * start only after the response window has closed. Soft-cap wrap-up skips trials beyond each block's
 * `min_trials` and hurries flourishes; aborts end the trial as `aborted` (interrupted).
 */
import type { EventCondition, EventTaskPosition } from '@shriii/contracts';
import {
  abortReasonOf,
  type EventLogger,
  type ModuleContext,
  type ModuleResult,
  type TimingFlag,
} from '../../core/contracts.ts';
import { presentStimulus } from '../../engine/timing.ts';
import { PublicGoodsGame } from '../../paradigms/public-goods.ts';
import { classifyForkChoice } from '../../paradigms/reversal.ts';
import { RouteGraph } from '../../paradigms/route-planning.ts';
import { ROAD_HOME_LINES } from './lines.ts';
import { fallbackRoute, ferryGraph } from './maps.ts';
import type {
  BlockedTrial,
  EffortTrial,
  ErrandMapTrial,
  ForkChoiceTrial,
  FuelTrial,
  OptionalTrial,
  PracticeTrial,
  ProbeTrial,
  RoadHomePlan,
  RoadHomeTrial,
} from './plan.ts';
import type { MapAnswer, RoadHomePlayer, RoadHomePresenter, TouchXy } from './types.ts';
import { EpisodeWalk } from './walk.ts';

/** Thrown internally when the module signal aborts mid-trial. */
class TrialAborted extends Error {
  readonly isAbort = true;
  constructor() {
    super('aborted');
    this.name = 'AbortError';
  }
}

export interface DirectorOptions {
  readonly ctx: ModuleContext;
  readonly plan: RoadHomePlan;
  readonly presenter: RoadHomePresenter;
  readonly player: RoadHomePlayer;
  /** True when the input layer logs `input.hold` itself (human touch with a routable logger). */
  readonly inputLogsHolds: boolean;
}

/** Counters reported in {@link ModuleResult} (counts only, never scores). */
interface Tally {
  completed: number;
  scorable: number;
  shiftLogged: boolean;
}

const STIMULUS_VERSION = 'road_home.v1';

/**
 * Pacing estimates per trial kind (ms): a median adult at L2 with the view's nominal beats
 * (`view/beats.ts`). Used only to decide whether a skippable trial still fits before the soft cap;
 * they never change a window, a stimulus or a required trial.
 */
const PACING_MS: Readonly<Record<RoadHomeTrial['kind'], number>> = {
  practice: 7000,
  errand_map: 10500,
  blocked_route: 10000,
  optional_opportunity: 3200,
  fork_choice: 2300,
  fuel_round: 4600,
  effort_hold: 4800,
  probe: 1900,
};

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

export class RoadHomeDirector {
  private readonly ctx: ModuleContext;
  private readonly plan: RoadHomePlan;
  private readonly presenter: RoadHomePresenter;
  private readonly player: RoadHomePlayer;
  private readonly inputLogsHolds: boolean;
  private readonly pot: PublicGoodsGame;
  private readonly tally: Tally = { completed: 0, scorable: 0, shiftLogged: false };
  /** Median-pace time the trials run so far should have taken (intro included). */
  private expectedMs = 0;

  constructor(o: DirectorOptions) {
    this.ctx = o.ctx;
    this.plan = o.plan;
    this.presenter = o.presenter;
    this.player = o.player;
    this.inputLogsHolds = o.inputLogsHolds;
    this.pot = new PublicGoodsGame({
      endowment: o.plan.fuel.endowment.value,
      multiplier: o.plan.fuel.multiplier.value,
      partner: o.plan.fuel.partner,
    });
  }

  /** Play the episode to completion, wrap-up or abort. Never rejects for expected aborts. */
  async run(): Promise<ModuleResult> {
    const { ctx, plan } = this;
    const startMs = ctx.clock.now();
    const finish = (): ModuleResult => {
      const reason = abortReasonOf(ctx.signal);
      return {
        moduleId: 'road_home',
        endedReason: reason ? (reason.kind === 'crash' ? 'error' : reason.kind) : 'completed',
        durationMs: ctx.clock.now() - startMs,
        trialsCompleted: this.tally.completed,
        scorableTrials: this.tally.scorable,
        contextShiftIndex: this.tally.shiftLogged ? plan.shiftIndex : null,
      };
    };
    ctx.wrapUp?.onRequest(() => this.presenter.setHurry(true));
    try {
      await this.intro();
      this.expectedMs = ctx.clock.now() - startMs;
      const blockMin = new Map(ctx.config.blocks.map((b) => [b.block_id, b.min_trials] as const));
      const done = new Map<string, number>();
      for (const [i, trial] of plan.trials.entries()) {
        if (ctx.signal.aborted) break;
        const block = trial.spec.block_id;
        const inBlock = done.get(block) ?? 0;
        const skippable = inBlock >= (blockMin.get(block) ?? 0);
        // Soft-cap wrap-up (ENG-05): finish the current trial, keep every block's minimum.
        if (skippable && ctx.wrapUp?.requested) continue;
        // Pacing: drop a skippable trial early when the remaining required trials would not fit
        // before the soft cap, so a slow player keeps the later blocks (fodder pot, uphill, probes).
        if (skippable && this.wouldOverrun(i, done, blockMin, ctx.clock.now() - startMs)) continue;
        await this.runTrial(trial);
        this.expectedMs += PACING_MS[trial.kind];
        done.set(block, inBlock + 1);
        this.tally.completed += 1;
        if (trial.spec.scorable) this.tally.scorable += 1;
      }
      if (!ctx.signal.aborted) await this.outro();
    } catch (err) {
      if (!(err instanceof TrialAborted) && !ctx.signal.aborted) throw err;
    }
    return finish();
  }

  /**
   * True when running trial `i` now would push the projected end (this trial, every later trial a
   * block minimum still requires, and the outro) past `budget.soft_cap_ms`.
   */
  private wouldOverrun(
    i: number,
    done: ReadonlyMap<string, number>,
    blockMin: ReadonlyMap<string, number>,
    elapsedMs: number,
  ): boolean {
    const trials = this.plan.trials;
    const virtualDone = new Map(done);
    let ahead = 0;
    for (let j = i + 1; j < trials.length; j += 1) {
      const t = trials[j] as RoadHomeTrial;
      const b = t.spec.block_id;
      const n = virtualDone.get(b) ?? 0;
      if (n < (blockMin.get(b) ?? 0)) {
        ahead += PACING_MS[t.kind];
        virtualDone.set(b, n + 1);
      }
    }
    const current = trials[i] as RoadHomeTrial;
    // Scale the estimates by this player's observed pace (never faster than the median).
    const pace = this.expectedMs > 0 ? Math.min(2, Math.max(1, elapsedMs / this.expectedMs)) : 1;
    const projected =
      elapsedMs + (PACING_MS[current.kind] + ahead) * pace + this.ctx.config.budget.outro_ms;
    return projected > this.ctx.config.budget.soft_cap_ms;
  }

  /* ------------------------------------------------------------------------------------------ */

  private async intro(): Promise<void> {
    const { ctx } = this;
    ctx.audio.playMusic('road_home', { fadeMs: 1800 });
    ctx.audio.setAmbience('road_evening', { fadeMs: 2500 });
    const voice = ctx.voice.has(ROAD_HOME_LINES.intro)
      ? ctx.voice.play(ROAD_HOME_LINES.intro, { signal: ctx.signal }).ended
      : Promise.resolve(null);
    await Promise.all([this.presenter.intro(ctx.signal), voice]);
    this.throwIfAborted();
  }

  private async outro(): Promise<void> {
    const { ctx } = this;
    const scene = this.presenter.outro(ctx.signal);
    const line = ctx.voice.has(ROAD_HOME_LINES.outro)
      ? ctx.voice.play(ROAD_HOME_LINES.outro, { signal: ctx.signal }).ended
      : Promise.resolve(null);
    await Promise.all([scene, line]);
    ctx.audio.stopMusic(2200);
    ctx.audio.setAmbience(null, { fadeMs: 2200 });
  }

  private throwIfAborted(): void {
    if (this.ctx.signal.aborted) throw new TrialAborted();
  }

  private scope(trial: RoadHomeTrial): { task: EventTaskPosition; condition: EventCondition } {
    const s = trial.spec;
    const block = this.ctx.config.blocks.find((b) => b.block_id === s.block_id);
    const variant = (s.params as { variant?: unknown }).variant;
    const condition: EventCondition = {
      phase: s.phase,
      condition_id: s.condition_id,
      shift_active: block?.conditions.shift_active ?? false,
      timer: block?.conditions.timer ?? false,
      noise: block?.conditions.noise ?? false,
      calibration_level: s.calibration_level,
      variant_seed: typeof variant === 'number' ? (variant >>> 0).toString(16) : null,
      ...(trial.kind === 'fuel_round' ? { partner_type: trial.round.partnerType } : {}),
    };
    const task: EventTaskPosition = {
      episode_id: 'road_home',
      module_id: 'road_home',
      block_id: s.block_id,
      trial_id: s.trial_id,
      trial_index: s.trial_index,
      probe_group_id: s.probe_group_id,
      form_id: s.form_id,
      anchor_trial: s.anchor_trial,
    };
    return { task, condition };
  }

  private routeInput(logger: EventLogger | null): void {
    const input = this.ctx.input as { setLogger?: (l: EventLogger | null) => void };
    input.setLogger?.(logger ?? this.ctx.logger);
  }

  private async runTrial(trial: RoadHomeTrial): Promise<void> {
    const { ctx, presenter } = this;
    await presenter.prepare(trial, ctx.signal);
    this.throwIfAborted();
    const { task, condition } = this.scope(trial);
    const log = ctx.logger.child({ task, condition, scorable: trial.spec.scorable });
    const params = trial.spec.params as { context_shift?: unknown };
    if (params.context_shift === true && ctx.config.context_shift) {
      log.log('context_shift', {
        kind: 'rule_reversal',
        announced: ctx.config.context_shift.announced,
        shift_index: trial.spec.trial_index,
      });
      this.tally.shiftLogged = true;
    }
    const startMs = ctx.clock.now();
    log.log('trial_start', {
      trial_type: trial.spec.trial_type,
      stimulus_id: trial.spec.stimulus_id,
      response_window_ms: trial.spec.response_window_ms,
      private_report: false,
      expected_response: trial.spec.expected_response,
    });
    this.routeInput(log);
    try {
      const onset = await presentStimulus(ctx.clock, () => presenter.reveal(trial));
      log.log(
        'stimulus_onset',
        {
          stimulus_id: trial.spec.stimulus_id ?? `road_home.${trial.spec.trial_type}`,
          stimulus_version: STIMULUS_VERSION,
          requested_onset_ms: round3(onset.requestedOnsetMs),
          presented_onset_ms: round3(onset.presentedOnsetMs),
          audio_onset_ms: null,
          onset_source: 'raf_commit',
          duration_ms: null,
        },
        { timingFlag: onset.timingFlag },
      );
      const end = await this.dispatch(trial, log, onset.presentedOnsetMs, onset.timingFlag);
      log.log('trial_end', {
        outcome: end.outcome,
        correctness: end.correctness,
        response_count: end.responses,
        duration_ms: round3(ctx.clock.now() - startMs),
      });
    } catch (err) {
      presenter.conceal(trial);
      presenter.hint(null);
      if (err instanceof TrialAborted || ctx.signal.aborted) {
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
        throw new TrialAborted();
      }
      throw err;
    } finally {
      this.routeInput(null);
    }
  }

  private dispatch(
    trial: RoadHomeTrial,
    log: EventLogger,
    onsetMs: number,
    flag: TimingFlag,
  ): Promise<TrialEnd> {
    const timing = { timingFlag: flag };
    switch (trial.kind) {
      case 'practice':
        return this.practice(trial, log, onsetMs, timing);
      case 'errand_map':
      case 'blocked_route':
        return this.mapTrial(trial, log, onsetMs, timing);
      case 'fork_choice':
        return this.fork(trial, log, onsetMs, timing);
      case 'optional_opportunity':
        return this.optional(trial, log, onsetMs, timing);
      case 'fuel_round':
        return this.fuel(trial, log, onsetMs, timing);
      case 'effort_hold':
        return this.effort(trial, log, onsetMs, timing);
      case 'probe':
        return this.probe(trial, log, onsetMs, timing);
    }
  }

  /* ------------------------------------------------------------------------- response helpers */

  private logChoice(
    log: EventLogger,
    timing: TimingOpt,
    stimulusId: string | null,
    answer:
      | { kind: 'timeout' }
      | { kind: 'choice'; value: string; latencyMs: number; xy: TouchXy; tapCount: number },
    correctness: boolean | null,
    extra: { revisions?: readonly { value: string; tMs: number }[]; holdMs?: number | null } = {},
  ): void {
    const timeout = answer.kind === 'timeout';
    log.log(
      'response',
      {
        stimulus_id: stimulusId,
        response_value: timeout ? null : answer.value,
        correctness: timeout ? null : correctness,
        input_mode: timeout ? 'timeout' : 'touch',
        latency_ms: timeout ? null : round3(answer.latencyMs),
        latency_anchor: 'visual_onset',
        barge_in: false,
        hold_ms: extra.holdMs ?? null,
        tap_count: timeout ? 0 : answer.tapCount,
        revisions: (extra.revisions ?? []).map((r) => ({ value: r.value, t_ms: round3(r.tMs) })),
        touch_xy_norm: timeout || !answer.xy ? null : [answer.xy[0], answer.xy[1]],
      },
      timing,
    );
  }

  /* ----------------------------------------------------------------------------------- trials */

  private async practice(
    trial: PracticeTrial,
    log: EventLogger,
    onsetMs: number,
    timing: TimingOpt,
  ): Promise<TrialEnd> {
    const { ctx, presenter, player } = this;
    if (ctx.voice.has(ROAD_HOME_LINES.practice)) {
      void ctx.voice.play(ROAD_HOME_LINES.practice, { signal: ctx.signal });
    }
    // 1) Tap the glowing waypoints to drive to the fork.
    const walk = new EpisodeWalk(trial.map, new RouteGraph(trial.map), onsetMs);
    let anchor = onsetMs;
    while (!walk.finished) {
      const next = trial.map.nodes.find((n) => walk.tappable().includes(n) && n > walk.at) ?? null;
      presenter.offer(trial, walk.tappable(), false);
      presenter.hint(next ? `node:${next}` : null);
      const ans = await player.mapStep({
        trial,
        walk,
        anchorMs: anchor,
        windowMs: this.plan.settings.stepWindowMs,
        restOffered: false,
        knownBlocked: new Set(),
        signal: ctx.signal,
      });
      if (ans.kind === 'aborted') throw new TrialAborted();
      if (ans.kind !== 'node') {
        presenter.nudge(trial);
        anchor = ctx.clock.now();
        continue;
      }
      const o = walk.step(ans.node, ans.tMs);
      if (!o.ok) continue;
      log.log('route_step', o.payload);
      anchor = ans.tMs;
      await presenter.step(trial, {
        payload: o.payload,
        moved: o.moved,
        reserve: o.reserve,
        auto: false,
      });
    }
    presenter.hint(null);
    await presenter.mapDone(trial);
    // 2) The fork: the guide's hand points along the lantern-lit branch (the starting rule).
    let responses = 0;
    let correct = false;
    for (let attempt = 0; attempt < 3 && !correct; attempt += 1) {
      presenter.hint(`branch:${trial.fork.ruleOption}`);
      const forkOnset = ctx.clock.now();
      const ans = await player.fork({
        trial,
        anchorMs: forkOnset,
        windowMs: null,
        signal: ctx.signal,
      });
      if (ans.kind === 'aborted') throw new TrialAborted();
      presenter.hint(null);
      if (ans.kind === 'timeout') continue;
      responses += 1;
      correct = classifyForkChoice(trial.fork, ans.value).correct;
      this.logChoice(log, timing, trial.spec.stimulus_id, ans, correct);
      presenter.conceal(trial);
      await presenter.forkOutcome(trial, ans.value, correct);
      if (!correct) presenter.reveal(trial);
    }
    presenter.conceal(trial);
    return { outcome: correct ? 'correct' : 'incorrect', correctness: correct, responses };
  }

  private async mapTrial(
    trial: ErrandMapTrial | BlockedTrial,
    log: EventLogger,
    onsetMs: number,
    timing: TimingOpt,
  ): Promise<TrialEnd> {
    const { ctx, presenter, player, plan } = this;
    const s = plan.settings;
    const blocked = trial.kind === 'blocked_route' ? trial : null;
    const graph = blocked
      ? new RouteGraph(trial.map, blocked.event.blockedEdges)
      : new RouteGraph(trial.map);
    const walk = new EpisodeWalk(trial.map, graph, onsetMs, {
      optimalOrder: trial.solution.optimalOrder,
    });
    const restOffered = blocked?.event.ferry != null;
    if (blocked && ctx.voice.has(ROAD_HOME_LINES.blockCue)) {
      // The road block itself is announced (never the rule reversal).
      void ctx.voice.play(ROAD_HOME_LINES.blockCue, { signal: ctx.signal });
    }
    const knownBlocked = new Set<string>();
    let anchor = onsetMs;
    let lastStepMs: number | null = null;
    let responses = 0;
    while (!walk.finished) {
      let windowMs = s.stepWindowMs;
      if (restOffered) {
        const left = onsetMs + s.restCapMs - ctx.clock.now();
        if (left <= 0) {
          await this.fallback(trial as BlockedTrial, walk, log, timing, onsetMs, null);
          responses += 1;
          break;
        }
        windowMs = Math.min(windowMs, left);
      }
      presenter.offer(trial, walk.tappable(), restOffered);
      const ans: MapAnswer = await player.mapStep({
        trial,
        walk,
        anchorMs: anchor,
        windowMs,
        restOffered,
        knownBlocked,
        signal: ctx.signal,
      });
      if (ans.kind === 'aborted') throw new TrialAborted();
      if (ans.kind === 'timeout') {
        if (!(restOffered && onsetMs + s.restCapMs - ctx.clock.now() <= 0)) presenter.nudge(trial);
        anchor = ctx.clock.now();
        continue;
      }
      if (ans.kind === 'rest') {
        if (!restOffered) continue;
        await this.fallback(trial as BlockedTrial, walk, log, timing, onsetMs, ans);
        responses += 1;
        break;
      }
      const o = walk.step(ans.node, ans.tMs);
      if (!o.ok) continue;
      if (lastStepMs !== null) {
        const gap = ans.tMs - lastStepMs;
        if (gap > s.idleGapLogMs) {
          log.log('idle', {
            duration_ms: round3(gap),
            state: 'play',
            after_response_window: gap > s.stepWindowMs,
          });
        }
      }
      log.log('route_step', o.payload);
      if (!o.moved) knownBlocked.add(ans.node);
      lastStepMs = ans.tMs;
      anchor = ans.tMs;
      void presenter.step(trial, {
        payload: o.payload,
        moved: o.moved,
        reserve: o.reserve,
        auto: false,
      });
    }
    presenter.conceal(trial);
    await presenter.mapDone(trial);
    if (blocked) return { outcome: 'not_applicable', correctness: null, responses };
    return { outcome: 'correct', correctness: true, responses: 0 };
  }

  /** Rest chosen (or cap reached): the ferry is called and the cart follows the fallback route. */
  private async fallback(
    trial: BlockedTrial,
    walk: EpisodeWalk,
    log: EventLogger,
    timing: TimingOpt,
    onsetMs: number,
    ans: Extract<MapAnswer, { kind: 'rest' }> | null,
  ): Promise<void> {
    const { ctx, presenter } = this;
    this.logChoice(
      log,
      timing,
      trial.spec.stimulus_id,
      ans
        ? {
            kind: 'choice',
            value: 'fallback',
            latencyMs: ans.tMs - onsetMs,
            xy: ans.xy,
            tapCount: 1,
          }
        : { kind: 'timeout' },
      null,
    );
    presenter.conceal(trial);
    await presenter.rest(trial, ans === null);
    this.throwIfAborted();
    walk.setGraph(ferryGraph(trial.map, trial.event));
    const route = fallbackRoute(trial.map, trial.event, walk.at);
    if (!route) return;
    for (const node of route.path.slice(1)) {
      this.throwIfAborted();
      const o = walk.step(node, ctx.clock.now());
      if (!o.ok) break;
      log.log('route_step', o.payload);
      await presenter.step(trial, {
        payload: o.payload,
        moved: o.moved,
        reserve: o.reserve,
        auto: true,
      });
    }
  }

  private async fork(
    trial: ForkChoiceTrial,
    log: EventLogger,
    onsetMs: number,
    timing: TimingOpt,
  ): Promise<TrialEnd> {
    const { ctx, presenter, player } = this;
    const ans = await player.fork({
      trial,
      anchorMs: onsetMs,
      windowMs: trial.spec.response_window_ms,
      signal: ctx.signal,
    });
    if (ans.kind === 'aborted') throw new TrialAborted();
    presenter.conceal(trial);
    const choice = ans.kind === 'choice' ? ans.value : null;
    const cls = classifyForkChoice(trial.fork, choice);
    this.logChoice(log, timing, trial.spec.stimulus_id, ans, cls.correct);
    await presenter.forkOutcome(trial, choice, cls.correct);
    return {
      outcome: cls.timeout ? 'timeout' : cls.correct ? 'correct' : 'incorrect',
      correctness: cls.timeout ? null : cls.correct,
      responses: cls.timeout ? 0 : 1,
    };
  }

  private async optional(
    trial: OptionalTrial,
    log: EventLogger,
    onsetMs: number,
    timing: TimingOpt,
  ): Promise<TrialEnd> {
    const { ctx, presenter, player } = this;
    const ans = await player.optional({
      trial,
      anchorMs: onsetMs,
      windowMs: trial.spec.response_window_ms,
      signal: ctx.signal,
    });
    if (ans.kind === 'aborted') throw new TrialAborted();
    presenter.conceal(trial);
    this.logChoice(log, timing, trial.spec.stimulus_id, ans, null);
    const taken = ans.kind === 'choice';
    await presenter.optionalOutcome(trial, taken);
    return {
      outcome: taken ? 'not_applicable' : 'timeout',
      correctness: null,
      responses: taken ? 1 : 0,
    };
  }

  private async fuel(
    trial: FuelTrial,
    log: EventLogger,
    onsetMs: number,
    timing: TimingOpt,
  ): Promise<TrialEnd> {
    const { ctx, presenter, player } = this;
    const ans = await player.fuel({
      trial,
      endowment: trial.endowment,
      anchorMs: onsetMs,
      windowMs: trial.spec.response_window_ms,
      signal: ctx.signal,
    });
    if (ans.kind === 'aborted') throw new TrialAborted();
    presenter.conceal(trial);
    const tokens = Math.max(0, Math.min(trial.endowment, Math.round(ans.tokens)));
    this.logChoice(
      log,
      timing,
      trial.spec.stimulus_id,
      ans.kind === 'confirm' && ans.latencyMs !== null
        ? {
            kind: 'choice',
            value: 'contribute',
            latencyMs: ans.latencyMs,
            xy: ans.xy,
            tapCount: ans.tapCount,
          }
        : { kind: 'timeout' },
      null,
      { revisions: ans.revisions },
    );
    // The partner decides from the history only (simultaneous move), then both piles are revealed.
    const played = this.pot.playRound(
      trial.round,
      tokens,
      { unprompted: tokens > 0 },
      ctx.rng.stream('fuel_pot'),
    );
    log.log('contribution', played.contribution);
    log.log('partner_action', played.partnerAction);
    await presenter.fuelOutcome(trial, played);
    return {
      outcome: 'not_applicable',
      correctness: null,
      responses: ans.kind === 'confirm' ? 1 : 0,
    };
  }

  private async effort(
    trial: EffortTrial,
    log: EventLogger,
    onsetMs: number,
    timing: TimingOpt,
  ): Promise<TrialEnd> {
    const { ctx, presenter, player } = this;
    const ans = await player.effort({
      trial,
      requiredMs: trial.requiredMs,
      anchorMs: onsetMs,
      windowMs: trial.spec.response_window_ms,
      signal: ctx.signal,
    });
    if (ans.kind === 'aborted') throw new TrialAborted();
    presenter.conceal(trial);
    if (!this.inputLogsHolds) {
      for (const h of ans.holds) {
        log.log('input.hold', {
          target_id: 'road_home.cart',
          hold_ms: round3(h.holdMs),
          required_hold_ms: trial.requiredMs,
          completed: h.completed,
        });
      }
    }
    const first = ans.holds[0];
    const longest = ans.holds.reduce((m, h) => Math.max(m, h.holdMs), 0);
    this.logChoice(
      log,
      timing,
      trial.spec.stimulus_id,
      first
        ? {
            kind: 'choice',
            value: 'hold',
            latencyMs: first.startMs - onsetMs,
            xy: null,
            tapCount: ans.holds.length,
          }
        : { kind: 'timeout' },
      first ? ans.completed : null,
      { holdMs: first ? round3(longest) : null },
    );
    await presenter.effortOutcome(trial, ans.completed);
    return { outcome: 'not_applicable', correctness: null, responses: first ? 1 : 0 };
  }

  private async probe(
    trial: ProbeTrial,
    log: EventLogger,
    onsetMs: number,
    timing: TimingOpt,
  ): Promise<TrialEnd> {
    const { ctx, presenter, player } = this;
    const ans = await player.probe({
      trial,
      anchorMs: onsetMs,
      windowMs: trial.spec.response_window_ms,
      signal: ctx.signal,
    });
    if (ans.kind === 'aborted') throw new TrialAborted();
    presenter.conceal(trial);
    this.logChoice(log, timing, trial.spec.stimulus_id, ans, null);
    await presenter.probeOutcome(trial, ans.kind === 'choice' ? ans.value : null);
    return {
      outcome: ans.kind === 'choice' ? 'not_applicable' : 'timeout',
      correctness: null,
      responses: ans.kind === 'choice' ? 1 : 0,
    };
  }
}

type TimingOpt = { readonly timingFlag: TimingFlag };

interface TrialEnd {
  readonly outcome:
    | 'correct'
    | 'incorrect'
    | 'omission'
    | 'commission'
    | 'timeout'
    | 'not_applicable';
  readonly correctness: boolean | null;
  readonly responses: number;
}
