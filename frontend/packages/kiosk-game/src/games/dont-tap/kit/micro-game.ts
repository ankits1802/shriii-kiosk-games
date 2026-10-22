/**
 * Base class of the kit's Pathway B micro-games (ENG-05 lifecycle: intro -> practice -> trials ->
 * contextShift? -> probes -> outro). Subclasses implement the paradigm flow in {@link MicroGame.play}
 * using the helpers here; the base owns:
 *
 * - the view (a Pixi scene, or a no-op view when there is no renderer: node tests and bot exports);
 * - the trial recorder (all trial events, raw-tap routing, params export);
 * - the scripted bot in `dev.headless` mode (pointer injection through the real input layer);
 * - narration (`say`), wrap-up (`wrapping`), abort handling and the {@link ModuleResult}.
 *
 * Expected aborts (walkaway, exit, hard cap) end `run()` normally with the abort reason; the open
 * trial is closed as `aborted`. Nothing here shows a number or a score to the player.
 */
import type { GameConfig } from '@shriii/contracts';
import type {
  ConstructId,
  GameModule,
  IndicatorId,
  LineId,
  MicroGameId,
  ModuleContext,
  ModuleResult,
  TargetHandle,
} from '../../../core/contracts.ts';
import { abortReasonOf, isAbortError } from '../../../core/contracts.ts';
import { LINES } from '../../../voice/catalogue/lines.generated.ts';
import { configBlock, isProbeBlock, planBlock } from './blocks.ts';
import { BotDriver, type BotPersona, centreOf } from './bot.ts';
import { markPhase } from './devtools.ts';
import { createNullView, hasRenderer } from './null-view.ts';
import {
  type ProbeChoice,
  type ProbeSituation,
  probeGeometry,
  probeParams,
  probeRectFor,
  probeSituation,
} from './probe.ts';
import { TrialRecorder } from './trial.ts';
import {
  type GamePhase,
  type KitTrial,
  type PlannedBlock,
  registerDisabledTarget,
} from './types.ts';

/** Methods every kit module view provides (scene-level choreography and the shared probe layer). */
export interface KitView {
  /** Opening cinematic; must finish within the config's `budget.intro_ms` (narration runs alongside). */
  intro(): Promise<void>;
  /** Closing beat; within `budget.outro_ms`. */
  outro(): Promise<void>;
  /** Phase lighting/music cue (never delays a stimulus). */
  phase(phase: GamePhase): void;
  /** Guide lip-sync for a narration clip of `ms`. */
  guideSpeak(ms: number): void;
  /** Bring in the probe tray (between the main task and the probes). */
  enterProbes(): Promise<void>;
  /** Synchronously show a probe situation (called inside the frame-committed stimulus render). */
  showProbe(situation: ProbeSituation): void;
  /** Acknowledge a probe choice (null = timeout) without revealing any outcome. */
  probeChosen(choice: ProbeChoice | null): Promise<void>;
  /** Remove the probe tray. */
  exitProbes(): Promise<void>;
  destroy(): void;
}

export interface MicroGameOptions {
  /** `auto` (default): Pixi view when the context has a renderer, else a no-op view. */
  readonly view?: 'auto' | 'pixi' | 'null';
  /** Bot persona for `dev.headless` runs (default: the median persona). */
  readonly persona?: BotPersona;
}

/** Thrown internally to unwind the flow after an abort. */
class FlowAborted extends Error {
  readonly isAbort = true;
  constructor() {
    super('module aborted');
    this.name = 'FlowAborted';
  }
}

export abstract class MicroGame<V extends KitView> implements GameModule {
  readonly kind = 'micro' as const;
  readonly id: MicroGameId;
  readonly constructs: readonly ConstructId[];
  readonly indicators: readonly IndicatorId[];
  protected readonly options: MicroGameOptions;
  private _ctx: ModuleContext | null = null;
  private _view: V | null = null;
  private _rec: TrialRecorder | null = null;
  protected bot: BotDriver | null = null;
  private nextTrialIndex = 0;
  private probeTargets: { left: TargetHandle; right: TargetHandle } | null = null;
  private destroyed = false;
  private startMs = 0;

  protected constructor(staticConfig: GameConfig, options: MicroGameOptions = {}) {
    this.id = staticConfig.module_id as MicroGameId;
    this.constructs = staticConfig.constructs;
    this.indicators = staticConfig.indicators as IndicatorId[];
    this.options = options;
  }

  protected get ctx(): ModuleContext {
    if (!this._ctx) throw new Error(`${this.id}: used before init`);
    return this._ctx;
  }

  protected get view(): V {
    if (!this._view) throw new Error(`${this.id}: view used before init`);
    return this._view;
  }

  protected get rec(): TrialRecorder {
    if (!this._rec) throw new Error(`${this.id}: recorder used before init`);
    return this._rec;
  }

  /** Session `trial_id -> GameTrialSpec.params` (for exports and the scoring engine). */
  trialParams(): Readonly<Record<string, Readonly<Record<string, unknown>>>> {
    return this._rec?.trialParams() ?? {};
  }

  /** True once a soft-cap / session-time wrap-up was requested (ENG-05). */
  protected get wrapping(): boolean {
    return this._ctx?.wrapUp?.requested ?? false;
  }

  /** Milliseconds since the module was initialised (close to `module_start`). */
  protected get elapsedMs(): number {
    return this.ctx.clock.now() - this.startMs;
  }

  /**
   * Budget guard (ENG-05 graceful wrap-up, applied early): true when a wrap-up was requested or when
   * finishing `remainingMs` of still-required work would pass `budget.soft_cap_ms`. Blocks then stop
   * at their protected minimum instead of running into the hard cap.
   */
  protected trimDue(remainingMs: number): boolean {
    return this.wrapping || this.elapsedMs + remainingMs > this.ctx.config.budget.soft_cap_ms;
  }

  /** True when `remainingMs` more still fits before the hard cap (with a small safety margin). */
  protected fitsBeforeHardCap(remainingMs: number): boolean {
    return this.elapsedMs + remainingMs <= this.ctx.config.budget.hard_cap_ms - 400;
  }

  /** True when the view draws (false in headless node runs). */
  protected get rendering(): boolean {
    return (
      this.options.view === 'pixi' || (this.options.view !== 'null' && hasRenderer(this._ctx?.app))
    );
  }

  async init(ctx: ModuleContext): Promise<void> {
    this._ctx = ctx;
    this.startMs = ctx.clock.now();
    this._rec = new TrialRecorder(ctx);
    this.bot = ctx.dev.headless ? new BotDriver(ctx, this.options.persona) : null;
    markPhase(this.id, 'loading');
    this._view = this.rendering ? this.createView(ctx) : createNullView<V>();
    await this.prepare(ctx);
    const lines = ctx.config.audio_keys.filter((k) => ctx.voice.has(k));
    await ctx.voice.preload(lines).catch(() => undefined);
  }

  async run(): Promise<ModuleResult> {
    const ctx = this.ctx;
    const startMs = ctx.clock.now();
    try {
      await this.play();
    } catch (err) {
      if (!(ctx.signal.aborted || err instanceof FlowAborted || isAbortError(err))) throw err;
    } finally {
      this.bot?.cancelAll();
      this.rec.abortOpen();
      markPhase(this.id, 'ended');
    }
    const reason = abortReasonOf(ctx.signal);
    return {
      moduleId: this.id,
      endedReason: reason ? (reason.kind === 'crash' ? 'error' : reason.kind) : 'completed',
      durationMs: ctx.clock.now() - startMs,
      trialsCompleted: this.rec.trialsCompleted,
      scorableTrials: this.rec.scorableTrials,
      contextShiftIndex: this.rec.contextShiftIndex,
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.bot?.cancelAll();
    this.probeTargets?.left.remove();
    this.probeTargets?.right.remove();
    this.probeTargets = null;
    this.disposeTargets();
    try {
      this._view?.destroy();
    } catch (err) {
      console.error(`[${this.id}] view destroy failed`, err);
    }
  }

  /* ---------------------------------------------------------------------------------------------- */

  /** Build the Pixi view (only called when rendering). */
  protected abstract createView(ctx: ModuleContext): V;

  /** Build schedules, register targets (both modes). */
  protected abstract prepare(ctx: ModuleContext): Promise<void>;

  /** The module flow (intro, practice, blocks, probes, outro). */
  protected abstract play(): Promise<void>;

  /** Remove module targets (called from destroy). */
  protected abstract disposeTargets(): void;

  /* ---------------------------------------------------------------------------------------------- */

  /** Throw to unwind when the module was aborted. */
  protected checkAbort(): void {
    if (this.ctx.signal.aborted) throw new FlowAborted();
  }

  /** Wait on the session clock (rejects on abort). */
  protected async wait(ms: number): Promise<void> {
    this.checkAbort();
    if (ms > 0) await this.ctx.clock.delay(ms, this.ctx.signal);
  }

  /** The index the next trial will get (not consumed). */
  protected peekTrialIndex(): number {
    return this.nextTrialIndex;
  }

  /** Allocate the next module trial index (practice included, from 0). */
  protected takeTrialIndex(): number {
    const i = this.nextTrialIndex;
    this.nextTrialIndex += 1;
    return i;
  }

  protected markPhase(phase: GamePhase, trial?: { trialIndex?: number; blockId?: string }): void {
    markPhase(this.id, phase, trial ?? {});
    this._view?.phase(phase);
  }

  /** Play a narration line (skipped when the line is unavailable); the guide lip-syncs. */
  protected async say(lineId: LineId, options: { readonly replay?: boolean } = {}): Promise<void> {
    this.checkAbort();
    const voice = this.ctx.voice;
    if (!voice.has(lineId)) return;
    const playback = voice.play(lineId, {
      signal: this.ctx.signal,
      ...(options.replay ? { replay: true } : {}),
    });
    const estimateMs = LINES[lineId]?.targetDurationMs ?? 2500;
    void playback.started.then(() => this.view.guideSpeak(estimateMs));
    await playback.ended;
    this.view.guideSpeak(0);
    this.checkAbort();
  }

  /** Intro: cinematic and narration together (instructions are always heard before practice). */
  protected async playIntro(lineId: LineId = `${this.id}.intro`): Promise<void> {
    this.markPhase('intro');
    await Promise.all([this.view.intro(), this.say(lineId)]);
    this.checkAbort();
  }

  protected async playOutro(lineId: LineId = `${this.id}.outro`): Promise<void> {
    this.markPhase('outro');
    await Promise.all([this.view.outro(), this.say(lineId)]);
  }

  /** Plan a config block by id. */
  protected block(blockId: string, length?: number): PlannedBlock {
    return planBlock(configBlock(this.ctx.config, blockId), length);
  }

  /** Base trial fields for a planned block. */
  protected trialBase(
    block: PlannedBlock,
    withinBlock: number,
    fields: Pick<
      KitTrial,
      'trialType' | 'stimulusId' | 'responseWindowMs' | 'expectedResponse' | 'params'
    > &
      Partial<Pick<KitTrial, 'anchor' | 'probeGroupId' | 'variant' | 'conditionId'>>,
  ): KitTrial {
    return {
      trialId: `${this.id}.${block.blockId}.${withinBlock}`,
      blockId: block.blockId,
      trialIndex: this.takeTrialIndex(),
      phase: block.phase,
      conditionId: fields.conditionId ?? block.conditionId,
      shiftActive: block.shiftActive,
      timer: block.timer,
      noise: block.noise,
      scorable: block.scorable && this.ctx.config.scorable && block.phase !== 'practice',
      anchor: fields.anchor ?? false,
      probeGroupId: fields.probeGroupId ?? null,
      formId: this.formId,
      trialType: fields.trialType,
      stimulusId: fields.stimulusId,
      responseWindowMs: fields.responseWindowMs,
      expectedResponse: fields.expectedResponse,
      params: fields.params,
      ...(fields.variant !== undefined ? { variant: fields.variant } : {}),
    };
  }

  /** Form id in force (falls back to the config's first form). */
  protected get formId(): string {
    const f = this.ctx.session.formId;
    return this.ctx.config.forms.includes(f) ? f : (this.ctx.config.forms[0] ?? 'form_1');
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* Probe block (shared by every module)                                                           */
  /* ---------------------------------------------------------------------------------------------- */

  /** Expected duration of the probe block (window plus choice acknowledgement per situation). */
  protected probeBlockEstimateMs(blockId = 'probe'): number {
    const b = this.ctx.config.blocks.find((x) => x.block_id === blockId);
    if (!b) return 0;
    // +700 ms for the tray entrance (the exit overlaps the outro).
    return 700 + b.trials * ((b.budget_trial_ms ?? 1200) + 350);
  }

  /** Register the two probe targets (call from `prepare`). */
  protected registerProbeTargets(): void {
    const g = probeGeometry(this.ctx.layout);
    const input = this.ctx.input;
    this.probeTargets = {
      left: registerDisabledTarget(input, {
        id: `${this.id}.probe_left`,
        bounds: g.left,
        audioKey: `${this.id}.replay`,
        kind: 'tap',
      }),
      right: registerDisabledTarget(input, {
        id: `${this.id}.probe_right`,
        bounds: g.right,
        audioKey: `${this.id}.replay`,
        kind: 'tap',
      }),
    };
  }

  /** Run the config's probe block (4 comparable situations; window from the config). */
  protected async runProbeBlock(blockId = 'probe'): Promise<void> {
    const cfg = configBlock(this.ctx.config, blockId);
    if (!isProbeBlock(cfg)) throw new Error(`${this.id}: block ${blockId} is not a probe block`);
    const targets = this.probeTargets;
    if (!targets) throw new Error(`${this.id}: probe targets not registered`);
    const block = planBlock(cfg);
    const window = cfg.budget_trial_ms ?? null;
    // Probes are comparable only as a whole segment; skip them (planned-missingness tolerant) rather
    // than let the hard cap cut the segment and the outro.
    if (
      !this.fitsBeforeHardCap(this.probeBlockEstimateMs(blockId) + this.ctx.config.budget.outro_ms)
    ) {
      return;
    }
    this.markPhase('probe', { blockId });
    await this.view.enterProbes();
    for (let i = 0; i < block.trials; i += 1) {
      this.checkAbort();
      const s = probeSituation(i);
      const trial = this.rec.begin(
        this.trialBase(block, i, {
          trialType: 'probe',
          stimulusId: `probe.${i}`,
          responseWindowMs: window,
          expectedResponse: null,
          params: probeParams(s),
          anchor: block.scorable,
          probeGroupId: `${this.id}.probe`,
          variant: i,
        }),
      );
      this.markPhase('probe', { trialIndex: trial.trial.trialIndex, blockId });
      const onset = await trial.present(
        () => {
          this.view.showProbe(s);
          targets.left.setEnabled(true);
          targets.right.setEnabled(true);
        },
        { durationMs: window, version: 'kit.probe.1' },
      );
      if (this.bot) {
        const choice: ProbeChoice = this.bot.chance(
          Math.min(
            0.95,
            Math.max(
              0.05,
              this.bot.persona.risk + (s.riskyAmount - 3) * 0.15 - (s.safeAmount - 1) * 0.12,
            ),
          ),
        )
          ? 'risky'
          : 'safe';
        void this.bot.tapAfter(
          centreOf(probeRectFor(this.ctx.layout, s, choice)),
          this.bot.latency(Math.min((window ?? 1200) * 0.62, 760), 220),
        );
      }
      const leftCode: ProbeChoice = s.safeSide === 'left' ? 'safe' : 'risky';
      const rightCode: ProbeChoice = leftCode === 'safe' ? 'risky' : 'safe';
      const r = await this.ctx.input.waitForTap([targets.left.id, targets.right.id], {
        anchorMs: onset.presentedOnsetMs,
        windowMs: window,
        signal: this.ctx.signal,
      });
      targets.left.setEnabled(false);
      targets.right.setEnabled(false);
      if (r.kind === 'aborted') throw new FlowAborted();
      const choice: ProbeChoice | null =
        r.kind === 'tap' ? (r.tap.targetId === targets.left.id ? leftCode : rightCode) : null;
      trial.respond({
        value: choice,
        correctness: null,
        latencyMs: r.kind === 'tap' ? r.latencyMs : null,
        touchXyNorm: r.kind === 'tap' ? r.tap.xyNorm : null,
      });
      trial.end(choice ? 'not_applicable' : 'timeout', null, choice ? 1 : 0);
      this.bot?.cancelAll();
      await this.view.probeChosen(choice);
      await this.wait(260);
      trial.release();
    }
    // The tray leaves while the outro begins (no extra time on the clock).
    void this.view.exitProbes();
  }
}
