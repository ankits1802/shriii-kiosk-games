/**
 * Session time budget enforcement and timeline simulation (ONB-08, plan §4.4).
 *
 * All budgets come from `content/games/session-plan.json` and each module's `budget` / level table.
 * `checkSessionBudget` is the static CI check; `simulateSessionTimeline` runs seeded bot sessions
 * (median or slow, with per-trial latency jitter, soft-cap trimming to block minimums and the hard cap)
 * so the 1,000-slow-bot acceptance check can run in unit tests.
 */
import type { CalibrationLevel, GameConfig, SessionPlan } from '@shriii/contracts';
import type { ModuleId, SeededRng } from '../core/contracts.ts';
import type { GameContent } from './content.ts';

const LEVELS: readonly CalibrationLevel[] = ['L1', 'L2', 'L3'];

/** Bot speed profile. */
export type BotProfile = 'median' | 'slow';

/** One budget problem, reported by path (ENG-04 AC style). */
export interface BudgetViolation {
  readonly path: string;
  readonly message: string;
}

function trialMs(
  config: GameConfig,
  level: CalibrationLevel,
  bot: BotProfile,
  budgetTrialMs: number | null,
): number {
  return budgetTrialMs ?? config.levels[level].seconds_per_trial[bot] * 1000;
}

/** Budget-model duration (content/games/README.md) of one module. */
export function estimateModuleDurationMs(
  config: GameConfig,
  level: CalibrationLevel,
  bot: BotProfile,
  trimmed = false,
): number {
  let ms = config.budget.intro_ms + config.budget.outro_ms;
  for (const b of config.blocks) {
    ms += (trimmed ? b.min_trials : b.trials) * trialMs(config, level, bot, b.budget_trial_ms);
  }
  return Math.round(ms);
}

function moduleIdsFor(plan: SessionPlan, pathway: 'A' | 'B', slot: string | null): string[] {
  if (pathway === 'A') return [...plan.pathways.A.order];
  return [...plan.pathways.B.core_order, ...(slot ? [slot] : [])];
}

/** Static budget checks over the whole bundle. Returns every violation (empty = pass). */
export function checkSessionBudget(content: GameContent): BudgetViolation[] {
  const { plan } = content;
  const v: BudgetViolation[] = [];
  const get = (id: string): GameConfig | null =>
    content.has(id as ModuleId) ? content.get(id as ModuleId) : null;
  const bRange = plan.b_module_duration_s;
  const bIds = [...plan.pathways.B.core_order, ...plan.pathways.B.slot_candidates];

  for (const id of [...bIds, ...plan.pathways.A.order, plan.pathways.B.warmup]) {
    const c = get(id);
    if (!c) {
      v.push({ path: `session-plan/pathways/${id}`, message: 'module has no config' });
      continue;
    }
    if (c.budget.soft_cap_ms > c.budget.hard_cap_ms) {
      v.push({ path: `${id}/budget`, message: 'soft cap exceeds hard cap' });
    }
    for (const level of LEVELS) {
      const median = estimateModuleDurationMs(c, level, 'median');
      const slow = estimateModuleDurationMs(c, level, 'slow');
      const slowTrimmed = estimateModuleDurationMs(c, level, 'slow', true);
      const declared = c.levels[level].estimated_duration_ms;
      for (const [name, computed, stated] of [
        ['median', median, declared.median],
        ['slow', slow, declared.slow],
        ['slow_trimmed', slowTrimmed, declared.slow_trimmed],
      ] as const) {
        if (Math.abs(computed - stated) > 1) {
          v.push({
            path: `${id}/levels/${level}/estimated_duration_ms/${name}`,
            message: `declared ${stated} ms but the budget model gives ${computed} ms`,
          });
        }
      }
      if (median > c.budget.soft_cap_ms) {
        v.push({ path: `${id}/levels/${level}`, message: `median ${median} ms exceeds soft cap` });
      }
      if (slowTrimmed > c.budget.hard_cap_ms) {
        v.push({
          path: `${id}/levels/${level}`,
          message: `trimmed slow ${slowTrimmed} ms exceeds hard cap`,
        });
      }
      if (bIds.includes(id)) {
        for (const [name, ms] of [
          ['median', median],
          ['slow_trimmed', slowTrimmed],
        ] as const) {
          if (ms < bRange.min * 1000 || ms > bRange.max * 1000) {
            v.push({
              path: `${id}/levels/${level}/${name}`,
              message: `${ms} ms outside B module range ${bRange.min}-${bRange.max} s`,
            });
          }
        }
      }
    }
  }

  // Warm-up fits its segment.
  const warm = get(plan.pathways.B.warmup);
  if (warm && warm.budget.hard_cap_ms > plan.segments_max_s.practice_warmup * 1000) {
    v.push({
      path: `${warm.module_id}/budget/hard_cap_ms`,
      message: 'warm-up hard cap exceeds the practice/warm-up segment',
    });
  }

  // Pathway A episodes at L2.
  for (const id of plan.pathways.A.order) {
    const c = get(id);
    if (!c) continue;
    const ms = estimateModuleDurationMs(c, 'L2', 'median');
    const r = plan.a_episode_median_s;
    if (ms < r.min * 1000 || ms > r.max * 1000) {
      v.push({
        path: `${id}/levels/L2`,
        message: `episode median ${ms} ms outside ${r.min}-${r.max} s`,
      });
    }
  }

  // Scored play at L2 (median) for each slot form, and Pathway A.
  const scored = plan.scored_play_median_s;
  const fixedSegments =
    plan.segments_max_s.onboarding +
    plan.segments_max_s.practice_warmup +
    plan.segments_max_s.bridges +
    plan.segments_max_s.report_survey +
    plan.segments_max_s.contact_optin;
  const variants: {
    readonly name: string;
    readonly pathway: 'A' | 'B';
    readonly slot: string | null;
  }[] = [
    ...plan.pathways.B.slot_candidates.map((s) => ({
      name: `B+${s}`,
      pathway: 'B' as const,
      slot: s,
    })),
    { name: 'A', pathway: 'A', slot: null },
  ];
  for (const variant of variants) {
    const configs = moduleIdsFor(plan, variant.pathway, variant.slot).map(get);
    if (configs.some((c) => c === null)) continue;
    const list = configs as GameConfig[];
    const median = list.reduce((a, c) => a + estimateModuleDurationMs(c, 'L2', 'median'), 0);
    if (median < scored.min * 1000 || median > scored.max * 1000) {
      v.push({
        path: `session/${variant.name}/scored_play`,
        message: `median scored play ${median} ms outside ${scored.min}-${scored.max} s`,
      });
    }
    const worst = list.reduce((a, c) => a + c.budget.hard_cap_ms, 0) / 1000 + fixedSegments;
    if (worst > plan.session_target_max_s) {
      v.push({
        path: `session/${variant.name}/worst_case`,
        message: `hard caps + segment ceilings = ${worst} s exceed target ${plan.session_target_max_s} s`,
      });
    }
    if (worst > plan.session_cap_s) {
      v.push({
        path: `session/${variant.name}/worst_case`,
        message: `exceeds session cap ${plan.session_cap_s} s`,
      });
    }
  }
  return v;
}

/** One simulated session. All durations in seconds. */
export interface SimulatedTimeline {
  readonly pathway: 'A' | 'B';
  readonly slot: string | null;
  readonly level: CalibrationLevel;
  readonly bot: BotProfile;
  readonly onboardingS: number;
  readonly warmupS: number;
  readonly scoredPlayS: number;
  readonly bridgesS: number;
  readonly reportSurveyS: number;
  readonly contactOptInS: number;
  readonly totalS: number;
  /** Time to the start of the report (EPI-04 AC). */
  readonly reportStartS: number;
  readonly modules: readonly {
    readonly id: string;
    readonly ms: number;
    readonly trimmed: boolean;
    readonly hitHardCap: boolean;
    /** Scorable trials completed per block (minimum protection check). */
    readonly trialsPerBlock: Readonly<Record<string, number>>;
  }[];
}

/** Simulation assumptions for the non-play segments (fractions of the plan ceilings). */
export interface SegmentAssumptions {
  /** Fraction of each segment ceiling a bot uses (slow bots default to 1.0, median to 0.6). */
  readonly segmentFraction: number;
  /** Whether the contact opt-in runs (slow bot: yes, per ONB-08). */
  readonly contactOptIn: boolean;
}

/**
 * Simulate one module trial by trial: each trial takes the bot's seconds-per-trial (or the block's
 * fixed `budget_trial_ms`) with multiplicative jitter. Once the projected end passes the soft cap the
 * remaining optional trials are trimmed (every block keeps `min_trials`); the hard cap truncates.
 */
export function simulateModule(
  config: GameConfig,
  level: CalibrationLevel,
  bot: BotProfile,
  rng: SeededRng,
  jitter = 0.1,
): SimulatedTimeline['modules'][number] {
  const { intro_ms, outro_ms, soft_cap_ms, hard_cap_ms } = config.budget;
  let t = intro_ms;
  let trimmed = false;
  const trialsPerBlock: Record<string, number> = {};
  const draw = (b: GameConfig['blocks'][number]): number => {
    const base = trialMs(config, level, bot, b.budget_trial_ms);
    // Fixed-paced trials (budget_trial_ms or constraints.fixed_paced) do not jitter. The slow bot
    // is the 90th-percentile profile, so its jitter only ever makes trials faster; the median bot
    // jitters symmetrically.
    if (b.budget_trial_ms !== null || config.constraints.fixed_paced === true) return base;
    const u = rng.next();
    return bot === 'slow' ? base * (1 - u * jitter) : base * (1 + (u * 2 - 1) * jitter);
  };
  const minRemainingFrom = (bi: number, done: number): number => {
    let ms = 0;
    config.blocks.forEach((b, i) => {
      if (i < bi) return;
      const left = i === bi ? Math.max(0, b.min_trials - done) : b.min_trials;
      ms += left * trialMs(config, level, bot, b.budget_trial_ms);
    });
    return ms;
  };
  let hitHardCap = false;
  for (const [bi, b] of config.blocks.entries()) {
    let done = 0;
    for (let i = 0; i < b.trials; i += 1) {
      const optional = i >= b.min_trials;
      if (optional && t + minRemainingFrom(bi, done) + outro_ms > soft_cap_ms) {
        trimmed = true;
        break;
      }
      const d = draw(b);
      if (t + d + outro_ms > hard_cap_ms) {
        hitHardCap = true;
        break;
      }
      t += d;
      done += 1;
    }
    trialsPerBlock[b.block_id] = done;
    if (hitHardCap) break;
  }
  t = Math.min(hard_cap_ms, t + outro_ms);
  return { id: config.module_id, ms: Math.round(t), trimmed, hitHardCap, trialsPerBlock };
}

/** Simulate a full session timeline. */
export function simulateSessionTimeline(
  content: GameContent,
  options: {
    readonly pathway: 'A' | 'B';
    readonly slot: string | null;
    readonly level: CalibrationLevel;
    readonly bot: BotProfile;
    readonly rng: SeededRng;
    readonly jitter?: number;
    readonly assumptions?: Partial<SegmentAssumptions>;
  },
): SimulatedTimeline {
  const { plan } = content;
  const fraction = options.assumptions?.segmentFraction ?? (options.bot === 'slow' ? 1 : 0.6);
  const contactOptIn = options.assumptions?.contactOptIn ?? options.bot === 'slow';
  const seg = plan.segments_max_s;
  const warmCfg = content.get(plan.pathways[options.pathway].warmup as ModuleId);
  const warm = simulateModule(
    warmCfg,
    options.level,
    options.bot,
    options.rng.stream('warmup'),
    options.jitter,
  );
  const modules = moduleIdsFor(plan, options.pathway, options.slot).map((id) =>
    simulateModule(
      content.get(id as ModuleId),
      options.level,
      options.bot,
      options.rng.stream(id),
      options.jitter,
    ),
  );
  const onboardingS = seg.onboarding * fraction;
  const warmupS = warm.ms / 1000;
  const scoredPlayS = modules.reduce((a, m) => a + m.ms, 0) / 1000;
  const bridgesS = seg.bridges * fraction;
  const reportSurveyS = seg.report_survey * fraction;
  const contactOptInS = contactOptIn ? seg.contact_optin * fraction : 0;
  const reportStartS = onboardingS + warmupS + scoredPlayS + bridgesS;
  return {
    pathway: options.pathway,
    slot: options.slot,
    level: options.level,
    bot: options.bot,
    onboardingS,
    warmupS,
    scoredPlayS,
    bridgesS,
    reportSurveyS,
    contactOptInS,
    totalS: reportStartS + reportSurveyS + contactOptInS,
    reportStartS,
    modules,
  };
}
