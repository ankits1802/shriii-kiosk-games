/**
 * Dev-only "stills" for visual QA: stage one named phase of The Road Home deterministically (no bot
 * timing, no caps), so Playwright can screenshot every phase reliably even under software GL.
 * A still builds the real plan and the real Pixi view, runs `prepare`/`reveal` (and optionally a
 * scripted feedback beat) for the chosen trial, then marks `data-still="ready"` on the host.
 */
import { gsap } from 'gsap';
import type { GameModule, ModuleContext, ModuleResult } from '../../../core/contracts.ts';
import { createSessionRng } from '../../../engine/rng.ts';
import { PublicGoodsGame } from '../../../paradigms/public-goods.ts';
import { optimalTour, RouteGraph } from '../../../paradigms/route-planning.ts';
import { buildRoadHomePlan, type RoadHomePlan, type RoadHomeTrial } from '../plan.ts';
import { roadHomeView } from '../view/index.ts';
import type { RoadHomeView } from '../view/RoadHomeView.ts';
import { EpisodeWalk } from '../walk.ts';

type Pick = (p: RoadHomePlan) => RoadHomeTrial | undefined;
type Act = (v: RoadHomeView, t: RoadHomeTrial, p: RoadHomePlan) => Promise<void>;

const ROUNDS = new Map<string, PublicGoodsGame>();

function nth(kind: RoadHomeTrial['kind'], n = 0, block?: string): Pick {
  return (p) => p.trials.filter((t) => t.kind === kind && (!block || t.spec.block_id === block))[n];
}

async function walkSteps(v: RoadHomeView, t: RoadHomeTrial, steps: number): Promise<void> {
  if (t.kind !== 'errand_map' && t.kind !== 'blocked_route') return;
  const graph = new RouteGraph(t.map, t.kind === 'blocked_route' ? t.event.blockedEdges : []);
  const walk = new EpisodeWalk(t.map, graph, 0, { optimalOrder: t.solution.optimalOrder });
  const tour = optimalTour(graph, walk.at, walk.remainingErrands, t.map.home);
  for (const node of (tour?.path ?? []).slice(1, steps + 1)) {
    const o = walk.step(node, 0);
    if (!o.ok) break;
    await v.step(t, { payload: o.payload, moved: o.moved, reserve: o.reserve, auto: false });
  }
  v.offer(t, walk.tappable(), t.kind === 'blocked_route' && t.event.ferry !== null);
}

/** Named stills: which trial, and what to do after reveal. */
export const STILLS: Readonly<Record<string, { pick: Pick; act?: Act; settleMs?: number }>> = {
  practice_map: {
    pick: nth('practice'),
    act: async (v, t) => v.hint(`node:${t.kind === 'practice' ? t.map.nodes[1] : ''}`),
  },
  practice_fork: {
    pick: nth('practice'),
    act: async (v, t) => {
      await v.mapDone(t);
      if (t.kind === 'practice') v.hint(`branch:${t.fork.ruleOption}`);
    },
  },
  errand_map: { pick: nth('errand_map', 0), settleMs: 600 },
  errand_map_progress: {
    pick: nth('errand_map', 1),
    act: (v, t) => walkSteps(v, t, 4),
    settleMs: 700,
  },
  errand_map_night: {
    pick: nth('errand_map', 2),
    act: (v, t) => walkSteps(v, t, 2),
    settleMs: 600,
  },
  optional_stranded_traveller: {
    pick: (p) =>
      p.trials.find(
        (t) => t.kind === 'optional_opportunity' && t.opportunity === 'stranded_traveller',
      ),
  },
  optional_shrine_lamp: {
    pick: (p) =>
      p.trials.find((t) => t.kind === 'optional_opportunity' && t.opportunity === 'shrine_lamp'),
  },
  optional_spilled_mangoes: {
    pick: (p) =>
      p.trials.find(
        (t) => t.kind === 'optional_opportunity' && t.opportunity === 'spilled_mangoes',
      ),
  },
  optional_thirsty_calf: {
    pick: (p) =>
      p.trials.find((t) => t.kind === 'optional_opportunity' && t.opportunity === 'thirsty_calf'),
  },
  optional_fallen_signpost: {
    pick: (p) =>
      p.trials.find(
        (t) => t.kind === 'optional_opportunity' && t.opportunity === 'fallen_signpost',
      ),
  },
  optional_helped: {
    pick: (p) =>
      p.trials.find((t) => t.kind === 'optional_opportunity' && t.opportunity === 'shrine_lamp'),
    act: async (v, t) => {
      v.conceal(t);
      void v.optionalOutcome(t, true);
      await new Promise((r) => setTimeout(r, 900));
    },
  },
  fork_sunset: { pick: nth('fork_choice', 0) },
  fork_dusk: { pick: nth('fork_choice', 8) },
  fork_night: { pick: nth('fork_choice', 14) },
  fork_outcome_correct: {
    pick: nth('fork_choice', 2),
    act: async (v, t) => {
      if (t.kind !== 'fork_choice') return;
      v.conceal(t);
      await v.forkOutcome(t, t.fork.ruleOption, true);
    },
  },
  fork_outcome_dead_end: {
    pick: nth('fork_choice', 12),
    act: async (v, t) => {
      if (t.kind !== 'fork_choice') return;
      v.conceal(t);
      await v.forkOutcome(t, t.fork.oldRuleOption, false);
    },
  },
  blocked_tree: { pick: nth('blocked_route', 0), settleMs: 900 },
  blocked_tree_bump: {
    pick: nth('blocked_route', 0),
    act: (v, t) => walkSteps(v, t, 3),
    settleMs: 400,
  },
  blocked_flood: { pick: nth('blocked_route', 1), settleMs: 900 },
  blocked_flood_ferry: {
    pick: nth('blocked_route', 1),
    act: async (v, t) => {
      v.conceal(t);
      await v.rest(t, false);
    },
  },
  fodder_stop: { pick: nth('fuel_round', 0), act: async (v) => v.fuelChanged(3), settleMs: 700 },
  fodder_reveal: {
    pick: nth('fuel_round', 0),
    act: async (v, t, p) => fodder(v, t, p, 4, 0.55),
  },
  fodder_free_rider: {
    pick: (p) =>
      p.trials.find((t) => t.kind === 'fuel_round' && t.round.partnerType === 'free_rider'),
    act: async (v, t, p) => fodder(v, t, p, 3, 0.45),
  },
  fodder_partner_spill: {
    pick: (p) => p.trials.find((t) => t.kind === 'fuel_round' && t.round.errorRound),
    act: async (v, t, p) => fodder(v, t, p, 4, 0.3),
  },
  uphill: { pick: nth('effort_hold', 0), settleMs: 500 },
  uphill_push: {
    pick: nth('effort_hold', 1),
    act: async (v) => {
      for (let k = 1; k <= 12; k += 1) {
        v.effortProgress(k / 20);
        await new Promise((r) => setTimeout(r, 40));
      }
    },
  },
  uphill_crest: {
    pick: nth('effort_hold', 2),
    act: async (v, t) => {
      v.conceal(t);
      await v.effortOutcome(t, true);
    },
  },
  probe_crossing: { pick: nth('probe', 0) },
  outro_home: {
    pick: nth('probe', 3),
    act: async (v, t) => {
      v.conceal(t);
      const ac = new AbortController();
      void v.outro(ac.signal);
      await new Promise((r) => setTimeout(r, 2000));
    },
  },
};

async function fodder(
  v: RoadHomeView,
  t: RoadHomeTrial,
  p: RoadHomePlan,
  tokens: number,
  at: number,
): Promise<void> {
  if (t.kind !== 'fuel_round') return;
  v.fuelChanged(tokens);
  await new Promise((r) => setTimeout(r, 500));
  v.conceal(t);
  const game =
    ROUNDS.get(t.spec.trial_id) ??
    new PublicGoodsGame({
      endowment: p.fuel.endowment.value,
      multiplier: p.fuel.multiplier.value,
      partner: p.fuel.partner,
    });
  ROUNDS.set(t.spec.trial_id, game);
  const played = game.playRound(
    t.round,
    tokens,
    { unprompted: true },
    createSessionRng('00000000000000aa'),
  );
  void v.fuelOutcome(t, played);
  await new Promise((r) => setTimeout(r, 1300 * at * 2));
}

/** A GameModule that stages one still and then idles until aborted. */
export class StillModule implements GameModule {
  readonly id = 'road_home' as const;
  readonly kind = 'episode' as const;
  readonly constructs = [];
  readonly indicators = [];
  private ctx: ModuleContext | null = null;
  private view: RoadHomeView | null = null;
  private plan: RoadHomePlan | null = null;

  constructor(
    private readonly name: string,
    private readonly host: HTMLElement,
  ) {}

  async init(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
    this.plan = buildRoadHomePlan(
      ctx.config,
      ctx.level,
      ctx.rng.stream('plan'),
      ctx.session.formId,
    );
    this.view = roadHomeView(ctx, this.plan).presenter as RoadHomeView;
    await this.view.init(this.plan);
  }

  async run(): Promise<ModuleResult> {
    const { ctx, view, plan } = this;
    if (!ctx || !view || !plan) throw new Error('still before init');
    const def = STILLS[this.name];
    if (this.name === 'intro_fair' || this.name === 'intro_road') {
      void view.intro(ctx.signal);
      await new Promise((r) => setTimeout(r, this.name === 'intro_fair' ? 1800 : 5600));
    } else if (def) {
      const trial = def.pick(plan);
      if (!trial) throw new Error(`still ${this.name}: no trial`);
      await view.prepare(trial, ctx.signal);
      view.reveal(trial);
      if (def.act) await def.act(view, trial, plan);
      await new Promise((r) => setTimeout(r, def.settleMs ?? 350));
    } else {
      throw new Error(`unknown still '${this.name}'`);
    }
    // Freeze the choreography on this frame: software-GL screenshots take seconds to capture and
    // the tweens would otherwise run on (e.g. into the outro's handover veil) while the shot is taken.
    gsap.globalTimeline.pause();
    this.host.dataset.still = 'ready';
    await new Promise<void>((resolve) =>
      ctx.signal.addEventListener('abort', () => resolve(), { once: true }),
    );
    return {
      moduleId: 'road_home',
      endedReason: 'explicit_exit',
      durationMs: 0,
      trialsCompleted: 0,
      scorableTrials: 0,
      contextShiftIndex: null,
    };
  }

  destroy(): void {
    this.view?.destroy();
  }
}
