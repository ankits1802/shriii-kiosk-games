/**
 * MG-02 Don't-Tap: go/no-go at the firefly fruit-toss booth, with a pressure block (Meta-T style:
 * timer ring plus crowd noise) as the second half. GNG only (SSRT removed, see MG-11).
 *
 * Paradigm: fresh fruit appears on the lit pedestal -> tap to toss it into the customer's basket
 * (`go`, response `serve`); spoiled fruit (wrinkled, rot spots, buzzing flies: shape cues, never colour
 * alone) must be left alone (`nogo`, withholding = timeout with correctness true). Fixed-paced: ISI
 * (+ seeded jitter) -> stimulus for `stimulus_ms` -> response window `response_window_ms` from the
 * frame-committed onset. Every tap is logged by the input layer and routed to the trial (premature,
 * extra and ISI taps feed the restraint indicators). All numbers come from `dont-tap.json`.
 *
 * Context shift: `pressure_on` (announced) at the first pressure trial (`context_shift.window`); the
 * main block is never trimmed so the shift index is exactly as configured. Under a soft-cap wrap-up
 * the pressure block stops at its protected minimum, never below the no-go minimum per block.
 */
import type { ContextShiftPayload, GameConfig } from '@shriii/contracts';
import config from '../../../../../../content/games/pathway-b/dont-tap.json' with { type: 'json' };
import type { ModuleContext, TargetHandle } from '../../core/contracts.ts';
import { createKeyedRng } from '../../engine/rng.ts';
import {
  buildGoNoGoStream,
  type GngKind,
  type GngStimulus,
  goNoGoBlockOptions,
} from '../../paradigms/go-nogo.ts';
import { DontTapView, FRUIT_KINDS, type FruitKind } from './DontTapView.ts';
import { dontTapGeometry } from './geometry.ts';
import { timing } from './kit/blocks.ts';
import { centreOf } from './kit/bot.ts';
import { MicroGame, type MicroGameOptions } from './kit/micro-game.ts';
import type { ActiveTrial } from './kit/trial.ts';
import { type PlannedBlock, registerDisabledTarget } from './kit/types.ts';

const STATIC_CONFIG = config as unknown as GameConfig;

/** View surface the logic drives (the Pixi view and the headless no-op view implement it). */
export interface DontTapViewSurface {
  showFruit(kind: GngKind, fruit: FruitKind, pressure: boolean): void;
  hideFruit(): void;
  serve(kind: GngKind): Promise<void>;
  letGo(kind: GngKind): Promise<void>;
  timerRing(durationMs: number): void;
  pressureOn(): Promise<void>;
  pressureOff(): Promise<void>;
  practiceHint(show: boolean): void;
}

interface DontTapPlan {
  readonly practice: { readonly block: PlannedBlock; readonly stream: readonly GngStimulus[] };
  readonly main: { readonly block: PlannedBlock; readonly stream: readonly GngStimulus[] };
  readonly pressure: { readonly block: PlannedBlock; readonly stream: readonly GngStimulus[] };
  readonly anchors: ReadonlySet<number>;
}

export class DontTapModule extends MicroGame<DontTapView> {
  private target: TargetHandle | null = null;
  private plan: DontTapPlan | null = null;
  private nogoMinPerBlock = 0;

  constructor(options: MicroGameOptions = {}) {
    super(STATIC_CONFIG, options);
  }

  protected createView(ctx: ModuleContext): DontTapView {
    return new DontTapView(ctx);
  }

  protected async prepare(ctx: ModuleContext): Promise<void> {
    const cfg = ctx.config;
    const c = cfg.constraints as Record<string, unknown>;
    this.nogoMinPerBlock = cfg.min_counts.nogo_per_block ?? 0;
    const practiceCfg = this.block('practice');
    const mainCfg = this.block('main');
    const pressureCfg = this.block('pressure');
    const level = ctx.level;
    const share = Number(c.nogo_share);
    const maxRun = Number(c.max_consecutive_nogo);
    // Practice: the share alone (the per-block scored minimum does not apply), first trial a go.
    const practiceStream = buildGoNoGoStream(
      {
        trials: practiceCfg.trials,
        nogoShare: share,
        maxConsecutiveNogo: maxRun,
        stimulusMs: timing(cfg, level, 'stimulus_ms'),
        responseWindowMs: timing(cfg, level, 'response_window_ms'),
        isiMs: timing(cfg, level, 'isi_ms'),
        isiJitterMs: timing(cfg, level, 'isi_jitter_ms'),
      },
      ctx.rng.stream('schedule.practice'),
    );
    const firstGo = practiceStream.findIndex((s) => s.kind === 'go');
    if (firstGo > 0) {
      const a = practiceStream[0] as GngStimulus;
      const b = practiceStream[firstGo] as GngStimulus;
      practiceStream[0] = { ...b, index: 0 };
      practiceStream[firstGo] = { ...a, index: firstGo };
    }
    const mainStream = buildGoNoGoStream(
      goNoGoBlockOptions(cfg, level, { trials: mainCfg.trials, phase: mainCfg.phase }),
      ctx.rng.stream('schedule.main'),
    );
    const pressureStream = buildGoNoGoStream(
      goNoGoBlockOptions(cfg, level, { trials: pressureCfg.trials, phase: pressureCfg.phase }),
      ctx.rng.stream('schedule.pressure'),
    );
    // Anchor trials (form-keyed, identical across levels): scorable GNG positions.
    const anchorCount = typeof c.anchor_trials === 'number' ? c.anchor_trials : 0;
    const firstScored = practiceCfg.trials;
    const candidates: number[] = [];
    for (let i = 0; i < mainCfg.trials + pressureCfg.trials; i += 1)
      candidates.push(firstScored + i);
    const anchors = new Set(
      createKeyedRng(`${cfg.config_id}|${this.formId}`, 'anchors')
        .shuffle(candidates)
        .slice(0, anchorCount),
    );
    this.plan = {
      practice: { block: practiceCfg, stream: practiceStream },
      main: { block: mainCfg, stream: mainStream },
      pressure: { block: pressureCfg, stream: pressureStream },
      anchors,
    };
    const g = dontTapGeometry(ctx.layout);
    this.target = registerDisabledTarget(ctx.input, {
      id: 'dont_tap.serve',
      bounds: g.target,
      audioKey: 'dont_tap.prompt.serve',
      kind: 'tap',
    });
    this.registerProbeTargets();
  }

  protected disposeTargets(): void {
    this.target?.remove();
    this.target = null;
  }

  protected async play(): Promise<void> {
    const plan = this.plan;
    if (!plan) throw new Error('dont_tap: play before prepare');
    await this.playIntro();

    this.markPhase('practice', { blockId: 'practice' });
    this.view.practiceHint(true);
    await this.say('dont_tap.practice');
    await this.runBlock(plan.practice.block, plan.practice.stream, plan.anchors, false);
    this.view.practiceHint(false);

    this.markPhase('main', { blockId: 'main' });
    await this.runBlock(plan.main.block, plan.main.stream, plan.anchors, false);

    // Announced context shift: crowd arrives, timer ring appears, cue narration.
    this.markPhase('shift', { blockId: 'pressure' });
    await Promise.all([this.view.pressureOn(), this.say('dont_tap.pressure_cue')]);
    this.markPhase('pressure', { blockId: 'pressure' });
    await this.runBlock(plan.pressure.block, plan.pressure.stream, plan.anchors, true);
    // Crowd leaves and the light softens while the probe tray comes in.
    void this.view.pressureOff();

    await this.runProbeBlock();
    await this.playOutro();
  }

  /** Run one fixed-paced GNG block. */
  private async runBlock(
    block: PlannedBlock,
    stream: readonly GngStimulus[],
    anchors: ReadonlySet<number>,
    trimmable: boolean,
  ): Promise<void> {
    const cfg = this.ctx.config;
    const anchorTiming = cfg.levels.L2.timing;
    let nogoDone = 0;
    for (let i = 0; i < stream.length; i += 1) {
      this.checkAbort();
      const perTrial = (stream[i]?.isiMs ?? 0) + (stream[i]?.responseWindowMs ?? 0) + 80;
      const after = this.probeBlockEstimateMs() + cfg.budget.outro_ms;
      if (
        trimmable &&
        i >= block.minTrials &&
        nogoDone >= this.nogoMinPerBlock &&
        this.trimDue(perTrial + after)
      ) {
        break;
      }
      const s = stream[i] as GngStimulus;
      const index = this.peekTrialIndex();
      const anchor = block.scorable && anchors.has(index);
      // Anchor trials use the anchor level's timing (identical across levels, ENG-09).
      const stimMs = anchor ? Number(anchorTiming.stimulus_ms) : s.stimulusMs;
      const windowMs = anchor ? Number(anchorTiming.response_window_ms) : s.responseWindowMs;
      const isiBase = anchor
        ? Number(block.phase === 'pressure' ? anchorTiming.pressure_isi_ms : anchorTiming.isi_ms)
        : s.isiMs;
      const fruit = FRUIT_KINDS[
        this.ctx.rng.stream(`stim.${block.blockId}.${i}`).int(0, FRUIT_KINDS.length - 1)
      ] as FruitKind;
      const shiftHere = block.phase === 'pressure' && i === 0 && cfg.context_shift !== null;
      const trialSpec = this.trialBase(block, i, {
        trialType: s.kind,
        stimulusId: `dont_tap.${s.kind}.${fruit}`,
        responseWindowMs: windowMs,
        expectedResponse: s.kind === 'go' ? 'serve' : 'withhold',
        anchor,
        variant: FRUIT_KINDS.indexOf(fruit),
        params: {
          feedback: 'none',
          fruit,
          stimulus_ms: stimMs,
          isi_ms: isiBase,
          jitter_ms: s.jitterMs,
          ...(shiftHere ? { context_shift: true } : {}),
        },
      });
      if (shiftHere && cfg.context_shift) {
        this.rec.shift(
          trialSpec,
          cfg.context_shift.kind as ContextShiftPayload['kind'],
          cfg.context_shift.announced,
        );
      }
      const trial = this.rec.begin(trialSpec);
      this.markPhase(
        block.phase === 'pressure' ? 'pressure' : block.phase === 'practice' ? 'practice' : 'main',
        {
          trialIndex: trialSpec.trialIndex,
          blockId: block.blockId,
        },
      );
      await this.runTrial(trial, s.kind, fruit, {
        stimMs,
        windowMs,
        isiMs: isiBase + s.jitterMs,
        pressure: block.phase === 'pressure',
      });
      if (s.kind === 'nogo') nogoDone += 1;
    }
    this.rec.releaseRouting();
  }

  private async runTrial(
    trial: ActiveTrial,
    kind: GngKind,
    fruit: FruitKind,
    t: { stimMs: number; windowMs: number; isiMs: number; pressure: boolean },
  ): Promise<boolean> {
    const target = this.target;
    if (!target) throw new Error('dont_tap: target missing');
    const bot = this.bot;
    // Inter-stimulus interval: taps now are `during_isi` and attach to this trial.
    if (bot?.chance(bot.persona.prematureRate)) {
      const point = centreOf(dontTapGeometry(this.ctx.layout).target);
      void bot.tapAfter(point, t.isiMs * (0.35 + 0.5 * bot.rng.next()));
    }
    await this.wait(t.isiMs);
    const onset = await trial.present(
      () => {
        this.view.showFruit(kind, fruit, t.pressure);
        if (t.pressure) this.view.timerRing(t.windowMs);
        target.setEnabled(true);
      },
      { durationMs: t.stimMs, version: 'dont_tap.fruit.1' },
    );
    // Stimulus offset exactly at stimulus_ms (independent of any response animation).
    const offsetTimer = new AbortController();
    void this.ctx.clock
      .delay(
        Math.max(0, onset.presentedOnsetMs + t.stimMs - this.ctx.clock.now()),
        offsetTimer.signal,
      )
      .then(
        () => this.view.hideFruit(),
        () => undefined,
      );
    if (bot) this.scheduleBot(kind, t);
    const r = await this.ctx.input.waitForTap([target.id], {
      anchorMs: onset.presentedOnsetMs,
      windowMs: t.windowMs,
      signal: this.ctx.signal,
    });
    if (r.kind === 'aborted') {
      offsetTimer.abort();
      target.setEnabled(false);
      this.checkAbort();
      return false;
    }
    const responded = r.kind === 'tap';
    if (responded) void this.view.serve(kind);
    // Fixed-paced: the window always runs to its end (later taps are `extra`).
    const windowEnd = onset.presentedOnsetMs + t.windowMs;
    const remaining = windowEnd - this.ctx.clock.now();
    if (remaining > 0) await this.wait(remaining);
    target.setEnabled(false);
    (this.ctx.input as { markIsi?: () => void }).markIsi?.();
    if (!responded) void this.view.letGo(kind);
    const correct = kind === 'go' ? responded : !responded;
    trial.respond({
      value: responded ? 'serve' : null,
      correctness: correct,
      latencyMs: responded ? r.latencyMs : null,
      touchXyNorm: responded ? r.tap.xyNorm : null,
      tapCount: responded ? 1 : 0,
    });
    trial.end(
      kind === 'go' ? (responded ? 'correct' : 'omission') : responded ? 'commission' : 'correct',
      correct,
      responded ? 1 : 0,
    );
    bot?.cancelAll();
    return responded;
  }

  private scheduleBot(kind: GngKind, t: { windowMs: number; pressure: boolean }): void {
    const bot = this.bot;
    if (!bot) return;
    const p = bot.persona;
    const point = centreOf(dontTapGeometry(this.ctx.layout).target);
    const rt = bot.latency(p.rtMs * (t.pressure ? 0.92 : 1));
    const respond =
      kind === 'go'
        ? bot.chance(Math.min(0.995, p.accuracy + 0.12))
        : bot.chance(Math.min(0.95, p.commission * (t.pressure ? 1.35 : 1)));
    if (respond && rt < t.windowMs - 5) {
      void bot.tapAfter(point, kind === 'nogo' ? rt * 0.9 : rt);
      if (bot.chance(p.extraTapRate))
        void bot.tapAfter(point, Math.min(t.windowMs - 10, rt + 90 + 60 * bot.rng.next()));
    }
  }
}

export function createDontTap(options?: MicroGameOptions): DontTapModule {
  return new DontTapModule(options);
}
