/**
 * The Road Home (Pathway A, Episode 3; EPI-03 "MindShift"): guide the bullock cart home from the
 * fair with a partner, from sunset to a starry night.
 *
 * Measures problem solving (excess route cost, replanning), planning/initiative (planning time,
 * unprompted optional actions), task organisation (errand order, revisits, idle time, fodder
 * efficiency), adaptability (unannounced rule reversal at the forks), teamwork (shared fodder pot
 * with a scripted partner) and persistence (blocked-road retries, uphill effort), plus the
 * cross-episode style probes. Indicator ids are the dictionary's (`dictionary.A.yaml`).
 *
 * Lifecycle: `init` builds the seeded plan and the scenes; `run` plays it through the director;
 * `destroy` releases everything. With `dev.headless` the scripted bot plays (visible when a stage
 * renders, virtual-time capable in tests).
 */
import type {
  ConstructId,
  GameModule,
  IndicatorId,
  ModuleContext,
  ModuleResult,
} from '../../core/contracts.ts';
import { BotPlayer, MEDIAN_ROAD_BOT, type RoadBotPolicy } from './bot.ts';
import { RoadHomeDirector } from './director.ts';
import { type BeatDurations, NullPresenter, ZERO_BEATS } from './null-presenter.ts';
import { buildRoadHomePlan, type RoadHomePlan } from './plan.ts';
import type { RoadHomePlayer, RoadHomePresenter } from './types.ts';

/** Constructs this episode provides evidence for (must match the content config). */
export const ROAD_HOME_CONSTRUCTS: readonly ConstructId[] = [
  'adaptability',
  'initiative',
  'persistence',
  'persistence_of_style',
  'problem_solving',
  'response_consistency',
  'stability',
  'task_organisation',
  'teamwork',
];

/** Indicators the episode's events feed (ENG-08 declaration; same ids as the config). */
export const ROAD_HOME_INDICATORS: readonly IndicatorId[] = [
  'adaptability.post_reversal_errors',
  'adaptability.reversal_trials_to_reacquire',
  'initiative.optional_actions_unprompted',
  'initiative.route_planning_time',
  'persistence.effort_completion_rate',
  'persistence.retries_on_blocked_route',
  'persistence_of_style.cross_segment_style_r',
  'persistence_of_style.lag1_autocorr',
  'problem_solving.excess_route_cost',
  'problem_solving.replan_latency',
  'problem_solving.replan_quality',
  'response_consistency.choice_entropy_repeats',
  'response_consistency.loc_scale_sigma',
  'stability.shift_slope',
  'stability.shift_slope_reversal',
  'task_organisation.errand_order_efficiency',
  'task_organisation.idle_time',
  'task_organisation.resource_allocation_efficiency',
  'task_organisation.revisits',
  'teamwork.mean_contribution',
  'teamwork.response_to_partner_defection',
  'teamwork.response_to_partner_error',
];

/** What the view module must provide (kept behind an import so headless builds stay Pixi-free). */
export type RoadHomeViewFactory = (
  ctx: ModuleContext,
  plan: RoadHomePlan,
) => {
  readonly presenter: RoadHomePresenter;
  /** Touch player bound to the view's targets. */
  readonly human: RoadHomePlayer;
  /** True when the input layer routes `input.hold` into the trial scope. */
  readonly inputLogsHolds: boolean;
};

export interface RoadHomeEpisodeOptions {
  /**
   * Scene renderer. Default: the Pixi view when the context has a renderer, else headless. Pass
   * `'headless'` to force the null presenter (tests, CI).
   */
  readonly view?: RoadHomeViewFactory | 'headless';
  /** Scripted bot behaviour for `dev.headless` runs. */
  readonly bot?: RoadBotPolicy;
  /** Nominal beat durations for headless pacing (default: zero). */
  readonly headlessBeats?: BeatDurations;
}

function hasRenderer(ctx: ModuleContext): boolean {
  const app = ctx.app as { renderer?: unknown } | null | undefined;
  return !!app && typeof app === 'object' && !!app.renderer;
}

export class RoadHomeEpisode implements GameModule {
  readonly id = 'road_home' as const;
  readonly kind = 'episode' as const;
  readonly constructs = ROAD_HOME_CONSTRUCTS;
  readonly indicators = ROAD_HOME_INDICATORS;
  private readonly options: RoadHomeEpisodeOptions;
  private ctx: ModuleContext | null = null;
  private plan: RoadHomePlan | null = null;
  private presenter: RoadHomePresenter | null = null;
  private player: RoadHomePlayer | null = null;
  private inputLogsHolds = false;

  constructor(options: RoadHomeEpisodeOptions = {}) {
    this.options = options;
  }

  /** The seeded plan (available after `init`; research tooling exports its trial params). */
  get currentPlan(): RoadHomePlan | null {
    return this.plan;
  }

  async init(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
    const plan = buildRoadHomePlan(
      ctx.config,
      ctx.level,
      ctx.rng.stream('plan'),
      ctx.session.formId,
    );
    this.plan = plan;
    const factory = this.options.view;
    if (factory && factory !== 'headless' && hasRenderer(ctx)) {
      const v = factory(ctx, plan);
      this.presenter = v.presenter;
      this.player = ctx.dev.headless
        ? new BotPlayer(
            ctx.clock,
            ctx.rng.stream('bot'),
            this.options.bot ?? MEDIAN_ROAD_BOT,
            v.presenter,
          )
        : v.human;
      this.inputLogsHolds = !ctx.dev.headless && v.inputLogsHolds;
      if (ctx.dev.headless) v.human.dispose();
    } else {
      if (!ctx.dev.headless) {
        throw new Error('road_home: a touch session needs the Pixi view (no renderer available)');
      }
      const presenter = new NullPresenter(ctx.clock, this.options.headlessBeats ?? ZERO_BEATS);
      this.presenter = presenter;
      this.player = new BotPlayer(
        ctx.clock,
        ctx.rng.stream('bot'),
        this.options.bot ?? MEDIAN_ROAD_BOT,
        presenter,
      );
      this.inputLogsHolds = false;
    }
    await this.presenter.init(plan);
    void ctx.voice.preload(ctx.config.audio_keys).catch(() => undefined);
  }

  async run(): Promise<ModuleResult> {
    const { ctx, plan, presenter, player } = this;
    if (!ctx || !plan || !presenter || !player) throw new Error('road_home: run() before init()');
    const director = new RoadHomeDirector({
      ctx,
      plan,
      presenter,
      player,
      inputLogsHolds: this.inputLogsHolds,
    });
    return director.run();
  }

  destroy(): void {
    this.player?.dispose();
    this.player = null;
    this.presenter?.destroy();
    this.presenter = null;
    this.ctx = null;
  }
}
