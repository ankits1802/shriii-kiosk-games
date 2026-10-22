/**
 * MG-06 Private Dice (group level only; integrity dice mode a).
 *
 * In a quiet corner the player holds a carved die in cupped hands, taps to shake, peeks at the face
 * for `reveal_ms`, and then touches the picture of the face they saw. Ten reports after one practice.
 *
 * Privacy and integrity rules (non-negotiable 6, MG-06, KSK-05/12):
 * - the true face is drawn from a non-seeded entropy source by `PrivateReportTrial` (it must not be
 *   reproducible from the logged session seed), handed to the render callback inside the reveal frame
 *   and never stored, logged, returned or kept in params — only the reported value is logged
 *   (`report` event); `assertNoTrueOutcome` guards every payload and param record;
 * - reports are touch only (never voiced) and the pictures are in fixed order with nothing pre-selected;
 * - `report` events carry the `headset` and `onlooker_reported` flags; the "someone watching?" button
 *   logs `onlooker_reported` and hides the screen;
 * - in `open_public` mode without a headset the module is skipped (`ended_reason: skipped`), never run
 *   on speakers (KSK-12 AC);
 * - outputs feed group-level estimators only (dictionary `group_only`); nothing here scores a person.
 */
import type { GameConfig } from '@shriii/contracts';
import type {
  ConstructId,
  GameModule,
  IndicatorId,
  ModuleContext,
  ModuleResult,
} from '../../core/contracts.ts';
import {
  assertNoTrueOutcome,
  type EntropySource,
  PrivateReportTrial,
  parseFaceCode,
} from '../../paradigms/private-report.ts';
import { BotHand, lognormalMs } from '../hub/kit/bot.ts';
import { runChoice } from '../hub/kit/choice.ts';
import { type ProbeGeometry, ProbeScene, probeGeometry, runProbeBlock } from '../hub/kit/probe.ts';
import { GameRuntime, type MicroGameHooks, ModuleAbortedError } from '../hub/kit/runtime.ts';
import { GameStage } from '../hub/kit/stage.ts';
import { TargetBoard } from '../hub/kit/targets.ts';
import { type ActiveTrial, TrialRecorder } from '../hub/kit/trials.ts';
import { type PrivateDiceGeometry, privateDiceGeometry } from './geometry.ts';
import { PrivateDiceScene } from './scene.ts';

export const PRIVATE_DICE_CONSTRUCTS: readonly ConstructId[] = [
  'integrity',
  'persistence_of_style',
  'response_consistency',
  'stability',
];

export const PRIVATE_DICE_INDICATORS: readonly IndicatorId[] = [
  'integrity.dice_overreport_rate',
  'integrity.report_distribution_skew',
  'persistence_of_style.cross_segment_style_r',
  'persistence_of_style.lag1_autocorr',
  'response_consistency.loc_scale_sigma',
  'stability.shift_slope',
];

const HANDS_ID = 'private_dice.hands';
const ONLOOKER_ID = 'private_dice.onlooker';
const FACE_PREFIX = 'private_dice.face_';
const AUDIO = 'private_dice.replay';

export interface PrivateDiceOptions extends MicroGameHooks {
  /** Entropy for the true face (default Web Crypto). Tests inject a counting source; never seeded. */
  readonly entropy?: EntropySource;
}

export class PrivateDiceModule implements GameModule {
  readonly id = 'private_dice' as const;
  readonly kind = 'micro' as const;
  readonly constructs = PRIVATE_DICE_CONSTRUCTS;
  readonly indicators = PRIVATE_DICE_INDICATORS;
  private rt: GameRuntime | null = null;
  private rec: TrialRecorder | null = null;
  private board: TargetBoard | null = null;
  private geo: PrivateDiceGeometry | null = null;
  private probeGeo: ProbeGeometry | null = null;
  private stage: GameStage | null = null;
  private scene: PrivateDiceScene | null = null;
  private bot: BotHand | null = null;
  private faces = 6;
  private onlookerReported = false;
  private startMs = 0;
  private unsubTap: (() => void) | null = null;

  constructor(private readonly options: PrivateDiceOptions = {}) {}

  async init(ctx: ModuleContext<GameConfig>): Promise<void> {
    const rt = new GameRuntime(ctx, this.id, this.options);
    this.rt = rt;
    this.rec = new TrialRecorder(rt);
    this.board = new TargetBoard(ctx.input);
    this.faces = Math.round(rt.constraintNumber('faces'));
    if (rt.constraintBoolean('true_outcome_logged') !== false) {
      throw new Error('private_dice: constraints.true_outcome_logged must be false (mode a)');
    }
    this.geo = privateDiceGeometry(ctx.layout, this.faces);
    this.probeGeo = probeGeometry(ctx.layout);
    for (const k of [
      'reveal_ms',
      'report_window_ms',
      'roll_autostart_ms',
      'shake_ms',
      'iti_ms',
      'probe_window_ms',
    ])
      rt.timing(k);
    if (rt.visual) {
      this.stage = new GameStage(rt, { sceneId: 'card_tent', timeOfDay: 'golden_hour' });
      this.scene = new PrivateDiceScene(this.stage, this.geo, this.faces);
    }
    if (rt.bot) this.bot = new BotHand(rt, this.board);
    ctx.voice.preload(ctx.config.audio_keys).catch(() => undefined);
  }

  /** KSK-12: private reports in open public mode need a headset, otherwise the module is skipped. */
  private skipForPrivacy(): boolean {
    const { ctx } = this.need(this.rt);
    return (
      ctx.session.siteMode === 'open_public' &&
      !ctx.session.headset &&
      ctx.config.constraints.headset_required_open_public === true
    );
  }

  async run(): Promise<ModuleResult> {
    const rt = this.need(this.rt);
    const rec = this.need(this.rec);
    this.startMs = rt.now();
    if (this.skipForPrivacy()) {
      rt.phase('skipped');
      return {
        moduleId: this.id,
        endedReason: 'skipped',
        durationMs: 0,
        trialsCompleted: 0,
        scorableTrials: 0,
        contextShiftIndex: null,
      };
    }
    const board = this.need(this.board);
    const geo = this.need(this.geo);
    if (rt.ctx.config.constraints.onlooker_button === true) {
      board.set(ONLOOKER_ID, geo.onlooker, AUDIO);
      this.scene?.addOnlookerButton(ONLOOKER_ID, AUDIO);
      this.unsubTap = rt.ctx.input.onRawTap((tap) => {
        if (tap.targetId === ONLOOKER_ID && tap.filtered === 'none') this.reportOnlooker();
      });
    }
    try {
      rt.phase('intro');
      await Promise.all([
        this.scene?.intro(rt) ?? Promise.resolve(),
        rt.say('private_dice.intro', this.scene?.guide ?? null),
      ]);

      rt.phase('practice');
      rt.sayAsync('private_dice.practice', this.scene?.guide ?? null);
      for (let i = 0; i < rt.block('practice').trials; i++) await this.report(i, true);

      rt.phase('reports');
      const n = rt.block('reports').trials;
      for (let i = 0; i < n; i++) await this.report(i, false);
      board.remove(HANDS_ID);

      await runProbeBlock(rt, rec, board, {
        scene: this.stage ? new ProbeScene(this.stage, this.need(this.probeGeo), this.id) : null,
        bot: this.bot,
        geometry: this.need(this.probeGeo),
      });

      rt.phase('outro');
      await Promise.all([
        this.scene?.outro() ?? Promise.resolve(),
        rt.say('private_dice.outro', this.scene?.guide ?? null),
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

  private reportOnlooker(): void {
    const rt = this.rt;
    const rec = this.rec;
    if (!rt || !rec || rt.aborted) return;
    this.onlookerReported = true;
    const open = rec.current;
    if (open) open.event('onlooker_reported', { context_id: 'private_dice' });
    else
      rt.ctx.logger.log(
        'onlooker_reported',
        { context_id: 'private_dice' },
        { task: rec.moduleTask(), condition: null },
      );
    this.scene?.hideFromOnlooker();
  }

  /** One private report: roll (tap or auto-start), private peek, picture report. */
  private async report(index: number, practice: boolean): Promise<void> {
    const rt = this.need(this.rt);
    const rec = this.need(this.rec);
    const board = this.need(this.board);
    const geo = this.need(this.geo);
    const { ctx } = rt;
    const windowMs = rt.timing('report_window_ms');
    const revealMs = rt.timing('reveal_ms');
    const trial: ActiveTrial = rec.begin({
      blockId: practice ? 'practice' : 'reports',
      phase: practice ? 'practice' : 'main',
      conditionId: practice ? 'standard' : 'private_report',
      trialType: 'report',
      stimulusId: practice ? 'private_dice.report.practice' : 'private_dice.report',
      responseWindowMs: windowMs,
      expectedResponse: null,
      scorable: !practice,
      privateReport: true,
      params: { report_index: practice ? null : index, faces: this.faces },
    });
    try {
      const reportTrial = new PrivateReportTrial({
        context: 'private_dice',
        reportIndex: index,
        faces: this.faces,
        ...(this.options.entropy ? { entropy: this.options.entropy } : {}),
      });
      // Roll: tap the hands (or they roll by themselves after a short wait).
      rt.phase(practice ? 'practice.ready' : 'ready', trial.index);
      board.set(HANDS_ID, geo.hands, AUDIO);
      this.scene?.ready(practice);
      if (this.bot) {
        const r = ctx.rng.stream(`bot.roll.${trial.index}`);
        void this.bot
          .tapTarget(HANDS_ID, 400 + r.next() * 900, () => r.next())
          .catch(() => undefined);
      }
      const roll = await ctx.input.waitForTap([HANDS_ID], {
        anchorMs: rt.now(),
        windowMs: rt.timing('roll_autostart_ms'),
        signal: ctx.signal,
      });
      if (roll.kind === 'aborted') throw new ModuleAbortedError();
      board.enable(HANDS_ID, false);
      rt.phase('shake', trial.index);
      this.scene?.shake(rt.timing('shake_ms'));
      await rt.sleep(rt.timing('shake_ms'));
      // Private peek: the face exists only inside this render callback.
      await trial.present(
        () => {
          reportTrial.reveal((face) => this.scene?.showFace(face));
        },
        {
          stimulusId: 'private_dice.reveal',
          version: 'private_dice.reveal.1',
          durationMs: revealMs,
        },
      );
      rt.phase('reveal', trial.index);
      await rt.sleep(revealMs);
      this.scene?.hideFace();
      // Report pictures (touch only, never voiced, nothing pre-selected).
      const ids = Array.from({ length: this.faces }, (_, k) => `${FACE_PREFIX}${k + 1}`);
      ids.forEach((id, k) => {
        const r = geo.faces[k];
        if (r) board.set(id, r, AUDIO, { enabled: false });
      });
      const presented = await trial.present(
        () => {
          this.scene?.showTiles(FACE_PREFIX, AUDIO);
          board.enableAll(ids, true);
        },
        {
          stimulusId: 'private_dice.report_pictures',
          version: 'private_dice.report.1',
          durationMs: windowMs,
        },
      );
      rt.phase(practice ? 'practice.report' : 'report', trial.index);
      if (this.bot) {
        // The bot cannot see the face (by design): it reports a seeded face.
        const r = ctx.rng.stream(`bot.report.${trial.index}`);
        const face = r.int(1, this.faces);
        void this.bot
          .tapTarget(
            `${FACE_PREFIX}${face}`,
            Math.min(
              windowMs - 300,
              lognormalMs(() => r.next(), 1300, 0.3),
            ),
            () => r.next(),
          )
          .catch(() => undefined);
      }
      const outcome = await runChoice(rt, {
        options: new Map(ids.map((id, k) => [id, `face_${k + 1}`] as const)),
        confirmId: null,
        anchorMs: presented.presentedOnsetMs,
        windowMs,
        onSelect: (code) => {
          const v = parseFaceCode(code, this.faces);
          if (v !== null) this.scene?.selectTile(v);
        },
      });
      board.enableAll(ids, false);
      trial.respond({
        stimulusId: 'private_dice.report_pictures',
        value: outcome.value,
        correctness: null,
        latencyMs: outcome.latencyMs,
        anchor: 'visual_onset',
        tapCount: outcome.tapCount,
        revisions: outcome.revisions,
        xy: outcome.xy,
      });
      const reported = parseFaceCode(outcome.value, this.faces);
      if (reported !== null) {
        const payload = reportTrial.report(reported, {
          headset: ctx.session.headset,
          onlookerReported: this.onlookerReported,
        });
        assertNoTrueOutcome(payload);
        trial.event('report', payload);
      }
      await (this.scene?.endReport() ?? Promise.resolve());
      trial.end(reported === null ? 'timeout' : 'not_applicable', null, reported === null ? 0 : 1);
      await rt.sleep(rt.timing('iti_ms'));
    } catch (err) {
      trial.abort();
      throw err;
    }
  }

  trialParams(): Record<string, Record<string, unknown>> {
    const p = this.rec?.trialParams() ?? {};
    assertNoTrueOutcome(p);
    return p;
  }

  destroy(): void {
    this.unsubTap?.();
    this.unsubTap = null;
    this.board?.clear();
    this.scene?.destroy();
    this.stage?.destroy();
    this.rt?.dispose();
    this.scene = null;
    this.stage = null;
  }

  private need<T>(v: T | null): T {
    if (v === null) throw new Error('private_dice: run() before init()');
    return v;
  }
}

export function createPrivateDice(options: PrivateDiceOptions = {}): PrivateDiceModule {
  return new PrivateDiceModule(options);
}
