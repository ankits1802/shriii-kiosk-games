/**
 * MG-04 Tower (Tower of London) in the potter's courtyard: stack clay pots on three pegs to match the
 * picture on the potter's easel. Four solvable problems (proven minimum moves across
 * `constraints.min_moves_range`) and >= 2 unsolvable items (pegs of a different height make the goal
 * unreachable; proven by exhaustive search), in a fixed order per form (ENG-14: a different
 * unsolvable identity per form). After `skip_icon_after_ms` a rest mat with an arrow appears: the
 * player may rest and move on at any time from then on (`response_value: skip`). Items end at their
 * cap (`solvable_cap_ms` / `unsolvable_cap_ms`).
 *
 * Interaction: tap a peg to lift its top pot, tap another peg to set it down. Every attempt is a
 * `move` event (problem, pot, from, to, legal, move_index); a full peg rejects the pot with a gentle
 * wobble (illegal attempt). Planning time is the onset to the first attempt.
 */
import type { GameConfig } from '@shriii/contracts';
import config from '../../../../../../content/games/pathway-b/tower.json' with { type: 'json' };
import type { ModuleContext, Point, TargetHandle } from '../../core/contracts.ts';
import {
  applyMove,
  buildTowerProblemSet,
  checkMove,
  legalMoves,
  type PotId,
  practiceProblem,
  solve,
  type TowerMove,
  type TowerProblem,
  type TowerState,
  TowerTrial,
  towerProblemSetOptions,
  towerTrialParams,
} from '../../paradigms/tower.ts';
import { timing } from '../dont-tap/kit/blocks.ts';
import { centreOf } from '../dont-tap/kit/bot.ts';
import { MicroGame, type MicroGameOptions } from '../dont-tap/kit/micro-game.ts';
import type { ActiveTrial } from '../dont-tap/kit/trial.ts';
import { type PlannedBlock, registerDisabledTarget } from '../dont-tap/kit/types.ts';
import { towerGeometry } from './geometry.ts';
import { TowerView } from './TowerView.ts';

const STATIC_CONFIG = config as unknown as GameConfig;

/** View surface the logic drives. */
export interface TowerViewSurface {
  setupBoard(problem: TowerProblem): void;
  select(basket: number | null): void;
  movePot(from: number, to: number, pot: PotId, state: TowerState): Promise<void>;
  reject(from: number, to: number): Promise<void>;
  showSkip(show: boolean): void;
  solved(): Promise<void>;
  rest(): Promise<void>;
  clearBoard(): Promise<void>;
  practiceHint(target: Point | null): void;
}

type ItemEnd = 'solved' | 'skip' | 'cap';

export class TowerModule extends MicroGame<TowerView> {
  private pegs: TargetHandle[] = [];
  private skipTarget: TargetHandle | null = null;
  private problems: TowerProblem[] = [];
  private practice: TowerProblem | null = null;
  private skipHintPlayed = false;

  constructor(options: MicroGameOptions = {}) {
    super(STATIC_CONFIG, options);
  }

  protected createView(ctx: ModuleContext): TowerView {
    return new TowerView(ctx);
  }

  protected async prepare(ctx: ModuleContext): Promise<void> {
    const cfg = ctx.config;
    this.problems = buildTowerProblemSet(towerProblemSetOptions(cfg, this.formId));
    this.practice = practiceProblem(cfg.config_id, this.formId);
    const g = towerGeometry(ctx.layout);
    // The rest mat first (it never overlaps a peg), then the pegs.
    this.skipTarget = registerDisabledTarget(ctx.input, {
      id: 'tower.skip',
      bounds: g.skip,
      audioKey: 'tower.skip_hint',
      kind: 'tap',
    });
    this.pegs = g.pegs.map((bounds, i) =>
      registerDisabledTarget(ctx.input, {
        id: `tower.basket_${i + 1}`,
        bounds,
        audioKey: 'tower.replay',
        kind: 'tap',
      }),
    );
    this.registerProbeTargets();
  }

  protected disposeTargets(): void {
    for (const t of this.pegs) t.remove();
    this.pegs = [];
    this.skipTarget?.remove();
    this.skipTarget = null;
  }

  protected async play(): Promise<void> {
    await this.playIntro();
    const practice = this.block('practice');
    this.markPhase('practice', { blockId: 'practice' });
    await this.say('tower.practice');
    if (this.practice) await this.runProblem(practice, 0, this.practice, true);

    const block = this.block('problems');
    this.markPhase('main', { blockId: 'problems' });
    for (let i = 0; i < Math.min(block.trials, this.problems.length); i += 1) {
      this.checkAbort();
      await this.runProblem(block, i, this.problems[i] as TowerProblem, false);
    }
    this.rec.releaseRouting();
    await this.runProbeBlock();
    await this.playOutro();
  }

  /** One problem, from onset to solved / rest / cap. */
  private async runProblem(
    block: PlannedBlock,
    i: number,
    problem: TowerProblem,
    isPractice: boolean,
  ): Promise<void> {
    const cfg = this.ctx.config;
    const level = this.ctx.level;
    const skipIconMs = timing(cfg, level, 'skip_icon_after_ms');
    const capMs =
      problem.kind === 'unsolvable'
        ? timing(cfg, level, 'unsolvable_cap_ms')
        : timing(cfg, level, 'solvable_cap_ms');
    const spec = this.trialBase(block, i, {
      trialType: problem.kind,
      stimulusId: problem.id,
      responseWindowMs: capMs,
      expectedResponse: null,
      variant: i,
      params: towerTrialParams(problem, { skipIconMs, capMs }),
    });
    const trial = this.rec.begin(spec);
    this.markPhase(isPractice ? 'practice' : 'main', {
      trialIndex: spec.trialIndex,
      blockId: block.blockId,
    });
    const onset = await trial.present(
      () => {
        this.view.setupBoard(problem);
        for (const p of this.pegs) p.setEnabled(true);
      },
      { durationMs: null, version: 'tower.board.1' },
    );
    const live = new TowerTrial(problem, onset.presentedOnsetMs);
    const end = await this.interact(
      trial,
      live,
      onset.presentedOnsetMs,
      skipIconMs,
      capMs,
      isPractice,
    );
    for (const p of this.pegs) p.setEnabled(false);
    this.skipTarget?.setEnabled(false);
    this.view.showSkip(false);
    this.view.select(null);
    this.view.practiceHint(null);
    this.bot?.cancelAll();
    const moves = live.log().length;
    if (end.kind === 'solved') {
      trial.end('correct', true, moves);
      await this.view.solved();
    } else if (end.kind === 'skip') {
      trial.respond({
        value: 'skip',
        correctness: null,
        latencyMs: end.latencyMs,
        touchXyNorm: end.xy,
      });
      trial.end('not_applicable', null, moves + 1);
      await this.view.rest();
    } else {
      // Cap: unsolvable items are not "wrong"; the potter simply moves on.
      trial.end('timeout', problem.kind === 'solvable' ? false : null, moves);
      await this.view.rest();
    }
    await this.view.clearBoard();
    trial.release();
  }

  private async interact(
    trial: ActiveTrial,
    live: TowerTrial,
    onsetMs: number,
    skipIconMs: number,
    capMs: number,
    isPractice: boolean,
  ): Promise<{ kind: ItemEnd; latencyMs: number | null; xy: readonly [number, number] | null }> {
    const ctx = this.ctx;
    const skipAt = onsetMs + skipIconMs;
    const capAt = onsetMs + capMs;
    let skipShown = false;
    let selected: number | null = null;
    const ids = this.pegs.map((p) => p.id);
    if (isPractice) {
      const first = solve(live.problem.start, live.problem.goal, live.problem.capacities);
      if (first.solvable && first.path[0])
        this.view.practiceHint(centreOf(this.pegRect(first.path[0].from)));
    }
    for (;;) {
      this.checkAbort();
      const now = ctx.clock.now();
      if (!skipShown && now >= skipAt) {
        skipShown = true;
        this.skipTarget?.setEnabled(true);
        this.view.showSkip(true);
        if (!this.skipHintPlayed && !isPractice) {
          this.skipHintPlayed = true;
          // Narration runs while the player keeps working (never blocks the item clock).
          void this.say('tower.skip_hint').catch(() => undefined);
        }
      }
      if (now >= capAt) return { kind: 'cap', latencyMs: null, xy: null };
      const deadline = skipShown ? capAt : Math.min(skipAt, capAt);
      if (this.bot) this.scheduleBot(live, selected, skipShown, onsetMs, capAt);
      const targets = skipShown && this.skipTarget ? [...ids, this.skipTarget.id] : ids;
      const r = await ctx.input.waitForTap(targets, {
        anchorMs: onsetMs,
        windowMs: Math.max(1, deadline - onsetMs),
        signal: ctx.signal,
      });
      this.bot?.cancelAll();
      if (r.kind === 'aborted') {
        this.checkAbort();
        return { kind: 'cap', latencyMs: null, xy: null };
      }
      if (r.kind === 'timeout') continue;
      if (r.tap.targetId === this.skipTarget?.id) {
        return { kind: 'skip', latencyMs: r.latencyMs, xy: r.tap.xyNorm };
      }
      const peg = ids.indexOf(r.tap.targetId ?? '');
      if (peg < 0) continue;
      if (selected === null) {
        if ((live.state[peg] ?? []).length === 0) continue; // nothing to lift: not a move attempt
        selected = peg;
        this.view.select(peg);
        this.ctx.audio.playSfx('tap_soft', { volume: 0.5 });
        if (isPractice) {
          const path = solve(live.state, live.problem.goal, live.problem.capacities);
          if (path.solvable && path.path[0])
            this.view.practiceHint(centreOf(this.pegRect(path.path[0].to)));
        }
        continue;
      }
      if (selected === peg) {
        selected = null; // set the pot back down where it was: not an attempt
        this.view.select(null);
        continue;
      }
      const move: TowerMove = { from: selected, to: peg };
      const before = live.state;
      const rec = live.attempt(move, r.tap.tMs);
      trial.log.log('move', live.movePayload(rec));
      selected = null;
      this.view.select(null);
      if (rec.legal && rec.item) {
        await this.view.movePot(
          move.from,
          move.to,
          rec.item,
          applyMove(before, live.problem.capacities, move),
        );
        this.ctx.audio.playSfx('pot_place', { volume: 0.6 });
      } else {
        await this.view.reject(move.from, move.to);
      }
      if (isPractice && !rec.solvedNow) {
        const path = solve(live.state, live.problem.goal, live.problem.capacities);
        if (path.solvable && path.path[0])
          this.view.practiceHint(centreOf(this.pegRect(path.path[0].from)));
      }
      if (rec.solvedNow) return { kind: 'solved', latencyMs: null, xy: null };
    }
  }

  private pegRect(i: number) {
    const g = towerGeometry(this.ctx.layout);
    const r = g.pegs[i];
    if (!r) throw new RangeError(`no peg ${i}`);
    return r;
  }

  /** Scripted player: plans, mostly follows the solver, sometimes wanders or tries a full peg. */
  private scheduleBot(
    live: TowerTrial,
    selected: number | null,
    skipShown: boolean,
    onsetMs: number,
    capAt: number,
  ): void {
    const bot = this.bot;
    if (!bot) return;
    const p = bot.persona;
    const now = this.ctx.clock.now();
    const problem = live.problem;
    const firstAction = live.log().length === 0 && selected === null;
    if (problem.kind === 'unsolvable' && skipShown) {
      // Rest after a while: patient players keep trying until the cap.
      const restAt = onsetMs + (capAt - onsetMs) * (0.6 + 0.45 * p.patience);
      if (restAt < capAt - 300 && this.skipTarget) {
        const g = towerGeometry(this.ctx.layout);
        void bot.tapAfter(centreOf(g.skip), Math.max(200, restAt - now));
        return;
      }
    }
    const delay = firstAction ? bot.latency(p.thinkMs * 1.4, 700) : bot.latency(520, 260);
    if (selected === null) {
      let move: TowerMove | null = null;
      const path =
        problem.kind === 'solvable' ? solve(live.state, problem.goal, problem.capacities) : null;
      if (path?.solvable && path.path[0] && bot.chance(0.82)) move = path.path[0];
      else {
        const options = legalMoves(live.state, problem.capacities);
        move = options.length > 0 ? bot.rng.pick(options) : null;
      }
      if (!move) return;
      this.botNext = move;
      void bot.tapAfter(centreOf(this.pegRect(move.from)), delay);
      return;
    }
    // Second tap: usually the planned destination, occasionally a full peg (illegal attempt).
    let to = this.botNext?.from === selected ? this.botNext.to : (selected + 1) % 3;
    if (bot.chance(0.06)) {
      const full = [0, 1, 2].find(
        (b) =>
          b !== selected &&
          !checkMove(live.state, problem.capacities, { from: selected, to: b }).legal,
      );
      if (full !== undefined) to = full;
    }
    void bot.tapAfter(centreOf(this.pegRect(to)), bot.latency(420, 220));
  }

  private botNext: TowerMove | null = null;
}

export function createTower(options?: MicroGameOptions): TowerModule {
  return new TowerModule(options);
}
