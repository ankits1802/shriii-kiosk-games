/**
 * MG-01 Balloon Pump (BART) at the balloon-seller's stall.
 *
 * Each balloon sits on the seller's brass hand-pump: tap the pump to blow it up (one tap = one pump),
 * tap the glass jar to tie it off and collect (the jar fills with pictured treats; no numbers, ever).
 * A balloon may pop: it bursts into a shower of confetti with a cheerful "pop" and the seller laughs -
 * never punitive, never a score. Two balloon kinds (colour AND pattern differ: sky-blue with stars,
 * rose with stripes) have different seeded explosion schedules: stratified uniform points on
 * `1..max_pumps(kind)` (MG-01 AC: the schedule matches the configured distribution for each seed).
 *
 * Scoring conventions: trial type `balloon`; a `pump` event per pump (`exploded` on the bursting pump),
 * a collect is a `pump` event with `collected: true` plus the response `collect`; params
 * `risk_colour`, `explosion_point`, `max_pumps`.
 */
import type { GameConfig } from '@shriii/contracts';
import config from '../../../../../../content/games/pathway-b/balloon.json' with { type: 'json' };
import type { ModuleContext, TargetHandle } from '../../core/contracts.ts';
import {
  assertSupportedDistribution,
  type BalloonSpec,
  BalloonTrial,
  buildExplosionTable,
  maxPumpsByColour,
  type RiskColour,
} from '../../paradigms/bart.ts';
import { timing } from '../dont-tap/kit/blocks.ts';
import { centreOf } from '../dont-tap/kit/bot.ts';
import { MicroGame, type MicroGameOptions } from '../dont-tap/kit/micro-game.ts';
import { type PlannedBlock, registerDisabledTarget } from '../dont-tap/kit/types.ts';
import { BalloonView } from './BalloonView.ts';
import { balloonGeometry } from './geometry.ts';

const STATIC_CONFIG = config as unknown as GameConfig;

/** View surface the logic drives. */
export interface BalloonViewSurface {
  newBalloon(kind: RiskColour, maxPumps: number, pumpAnimationMs: number): void;
  pump(pumps: number, maxPumps: number): void;
  burst(): Promise<void>;
  collect(pumps: number, maxPumps: number): Promise<void>;
  practiceHint(stage: 'pump' | 'collect' | null): void;
}

export class BalloonModule extends MicroGame<BalloonView> {
  private pumpTarget: TargetHandle | null = null;
  private jarTarget: TargetHandle | null = null;
  private table: BalloonSpec[] = [];
  private practiceSpec: BalloonSpec | null = null;
  private maxPumps: Record<RiskColour, number> = { low_risk: 32, high_risk: 16 };
  private maxPumpsSource: Record<RiskColour, string> = {
    low_risk: 'level_timing',
    high_risk: 'level_timing',
  };
  private botMemory = { lastExploded: false };

  constructor(options: MicroGameOptions = {}) {
    super(STATIC_CONFIG, options);
  }

  protected createView(ctx: ModuleContext): BalloonView {
    return new BalloonView(ctx);
  }

  protected async prepare(ctx: ModuleContext): Promise<void> {
    const cfg = ctx.config;
    assertSupportedDistribution(cfg);
    const resolved = maxPumpsByColour(cfg, ctx.level);
    this.maxPumps = { low_risk: resolved.low_risk.value, high_risk: resolved.high_risk.value };
    this.maxPumpsSource = {
      low_risk: `${resolved.low_risk.source}:${resolved.low_risk.key}`,
      high_risk: `${resolved.high_risk.source}:${resolved.high_risk.key}`,
    };
    const block = this.block('balloons');
    this.table = buildExplosionTable(block.trials, this.maxPumps, ctx.rng.stream('balloon.table'));
    // Practice balloon: low risk, popping in the upper half of its range (a gentle first try).
    const prng = ctx.rng.stream('balloon.practice');
    const max = this.maxPumps.low_risk;
    // Index 0 within its own (practice) block: the pump payload schema requires balloon_index >= 0.
    this.practiceSpec = {
      index: 0,
      riskColour: 'low_risk',
      explosionPoint: prng.int(Math.ceil(max / 2), max),
      maxPumps: max,
    };
    const g = balloonGeometry(ctx.layout);
    this.pumpTarget = registerDisabledTarget(ctx.input, {
      id: 'balloon.pump',
      bounds: g.pump,
      audioKey: 'balloon.replay',
      kind: 'tap',
    });
    this.jarTarget = registerDisabledTarget(ctx.input, {
      id: 'balloon.collect',
      bounds: g.jar,
      audioKey: 'balloon.replay',
      kind: 'tap',
    });
    this.registerProbeTargets();
  }

  protected disposeTargets(): void {
    this.pumpTarget?.remove();
    this.jarTarget?.remove();
    this.pumpTarget = null;
    this.jarTarget = null;
  }

  protected async play(): Promise<void> {
    await this.playIntro();
    this.markPhase('practice', { blockId: 'practice' });
    await this.say('balloon.practice');
    const practice = this.block('practice');
    if (this.practiceSpec) await this.runBalloon(practice, 0, this.practiceSpec, true);

    const block = this.block('balloons');
    this.markPhase('main', { blockId: 'balloons' });
    const perBalloon = 4800;
    for (let i = 0; i < Math.min(block.trials, this.table.length); i += 1) {
      this.checkAbort();
      const after = this.probeBlockEstimateMs() + this.ctx.config.budget.outro_ms + perBalloon;
      if (i >= block.minTrials && this.trimDue(after)) break;
      await this.runBalloon(block, i, this.table[i] as BalloonSpec, false);
    }
    this.rec.releaseRouting();
    await this.runProbeBlock();
    await this.playOutro();
  }

  private async runBalloon(
    block: PlannedBlock,
    i: number,
    spec: BalloonSpec,
    isPractice: boolean,
  ): Promise<void> {
    const cfg = this.ctx.config;
    const level = this.ctx.level;
    const pumpAnim = timing(cfg, level, 'pump_animation_ms');
    const burstMs = timing(cfg, level, 'explosion_feedback_ms');
    const bankMs = timing(cfg, level, 'bank_feedback_ms');
    const pumpT = this.pumpTarget;
    const jarT = this.jarTarget;
    if (!pumpT || !jarT) throw new Error('balloon: targets missing');
    const trialSpec = this.trialBase(block, i, {
      trialType: 'balloon',
      stimulusId: `balloon.${spec.riskColour}`,
      responseWindowMs: null,
      expectedResponse: null,
      variant: spec.riskColour === 'low_risk' ? 0 : 1,
      params: {
        risk_colour: spec.riskColour,
        explosion_point: spec.explosionPoint,
        max_pumps: spec.maxPumps,
        balloon_index: spec.index,
        max_pumps_source: this.maxPumpsSource[spec.riskColour],
      },
    });
    const trial = this.rec.begin(trialSpec);
    this.markPhase(isPractice ? 'practice' : 'main', {
      trialIndex: trialSpec.trialIndex,
      blockId: block.blockId,
    });
    const balloon = new BalloonTrial(spec);
    const onset = await trial.present(
      () => {
        this.view.newBalloon(spec.riskColour, spec.maxPumps, pumpAnim);
        pumpT.setEnabled(true);
        jarT.setEnabled(true);
      },
      { durationMs: null, version: 'balloon.stall.1' },
    );
    if (isPractice) this.view.practiceHint('pump');
    const botPlan = this.bot ? this.botTarget(spec) : 0;
    let ended: 'collected' | 'burst' | 'max' = 'max';
    for (;;) {
      this.checkAbort();
      if (this.bot) this.scheduleBot(balloon, botPlan);
      const r = await this.ctx.input.waitForTap([pumpT.id, jarT.id], {
        anchorMs: onset.presentedOnsetMs,
        windowMs: null,
        signal: this.ctx.signal,
      });
      this.bot?.cancelAll();
      if (r.kind !== 'tap') {
        this.checkAbort();
        continue;
      }
      if (r.tap.targetId === pumpT.id) {
        if (!balloon.canPump) continue;
        const res = balloon.pump(r.tap.tMs);
        trial.log.log('pump', balloon.lastPayload());
        if (isPractice && res.pumps === 3) this.view.practiceHint('collect');
        if (res.exploded) {
          ended = 'burst';
          break;
        }
        this.view.pump(res.pumps, spec.maxPumps);
        this.ctx.audio.playSfx('pump', { volume: 0.55 });
        continue;
      }
      // Collect (only meaningful after at least one pump; an empty balloon cannot be tied off).
      if (balloon.pumps === 0) continue;
      balloon.collect(r.tap.tMs);
      trial.log.log('pump', balloon.lastPayload());
      trial.respond({
        value: 'collect',
        correctness: null,
        latencyMs: r.latencyMs,
        touchXyNorm: r.tap.xyNorm,
      });
      ended = 'collected';
      break;
    }
    pumpT.setEnabled(false);
    jarT.setEnabled(false);
    this.view.practiceHint(null);
    if (ended === 'burst') {
      trial.end('not_applicable', null, balloon.pumps);
      if (!isPractice) this.botMemory.lastExploded = true;
      void this.view.burst();
      this.ctx.audio.playSfx('balloon_burst', { volume: 0.6 });
      await this.wait(burstMs);
    } else {
      trial.end('not_applicable', null, balloon.pumps + 1);
      if (!isPractice) this.botMemory.lastExploded = false;
      void this.view.collect(balloon.pumps, spec.maxPumps);
      this.ctx.audio.playSfx('jar_fill', { volume: 0.6 });
      await this.wait(bankMs);
    }
    trial.release();
  }

  /** Bot: a pump target per balloon from the persona's risk appetite (riskier kind -> fewer pumps). */
  private botTarget(spec: BalloonSpec): number {
    const bot = this.bot;
    if (!bot) return 0;
    const base = spec.maxPumps * (0.18 + 0.42 * bot.persona.risk);
    const adjust = this.botMemory.lastExploded ? 0.8 : 1;
    return Math.max(
      1,
      Math.min(
        spec.maxPumps,
        Math.round(base * adjust * Math.exp(0.25 * (bot.rng.next() - 0.5) * 2)),
      ),
    );
  }

  private scheduleBot(balloon: BalloonTrial, target: number): void {
    const bot = this.bot;
    if (!bot) return;
    const g = balloonGeometry(this.ctx.layout);
    if (balloon.pumps < target && balloon.canPump) {
      const delay = balloon.pumps === 0 ? bot.latency(700, 300) : bot.latency(240, 140);
      void bot.tapAfter(centreOf(g.pump), delay);
    } else {
      void bot.tapAfter(centreOf(g.jar), bot.latency(650, 280));
    }
  }
}

export function createBalloon(options?: MicroGameOptions): BalloonModule {
  return new BalloonModule(options);
}
