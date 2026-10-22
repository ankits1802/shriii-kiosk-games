/**
 * The Road Home trial plan (ENG-09): a deterministic function of (config, level, session rng, form).
 *
 * The engine scheduler ({@link DataDrivenTrialScheduler}) supplies the skeleton every module shares:
 * block order and lengths, trial ids/indices, phases, conditions, anchor trials, the context-shift
 * index inside `context_shift.window`, and the level timing stamp. The episode then assigns each
 * trial its Road Home content and the trial type the scorer expects (`stats/scoring` conventions:
 * `errand_map`, `optional_opportunity`, `fork_choice`, `blocked_route`, `fuel_round`, `effort_hold`,
 * `probe`) because the scheduler's `TrialOverrides` cannot change `trial_type`.
 *
 * Block content (counts from the config; layouts from `constraints.*_block_pattern`):
 * - practice: one guided fork (route tap + fork), not scorable;
 * - errand_maps (shift_pre): errand maps, optional roadside opportunities and pre-reversal forks;
 * - blocked_road: the fallen tree (replan), forks, the flooded river (unsolvable; rest = ferry);
 * - reversal (shift_post): forks under the reversed rule (unannounced; no cue refers to it);
 * - fuel_pot: shared fodder rounds with the scripted partner;
 * - uphill: hold-to-push effort beats;
 * - probe: cross-episode style probes (safe/risky crossing).
 *
 * Every scorer-required param lives in `spec.params` (joined by `trial_id` in `stats/scoring`).
 */
import type { CalibrationLevel, GameConfig, GameTrialSpec } from '@shriii/contracts';
import type { SeededRng } from '../../core/contracts.ts';
import { DataDrivenTrialScheduler } from '../../engine/scheduler.ts';
import type { RoundPlanEntry } from '../../paradigms/public-goods.ts';
import {
  type Branch,
  buildForkSequence,
  type ForkTrial,
  forkTrial,
} from '../../paradigms/reversal.ts';
import { type FuelPotSettings, fuelPotSettings, roadHomeFuelPlan } from './fuel-pot.ts';
import {
  type BlockedEvent,
  generateErrandMap,
  generateFallenTreeMap,
  generateFloodMap,
  type MapSolution,
  mapLayoutParams,
  practiceMap,
  type RoadMap,
} from './maps.ts';
import {
  type BlockedEventKind,
  type OptionalKind,
  RoadHomeConfigError,
  type RoadHomeSettings,
  type RoadHomeTrialType,
  resolveSettings,
} from './settings.ts';

/** Probe crossings (identical situation ids across episodes: `probe_situation_<i>`). */
export const PROBE_SITUATIONS = ['plank_bridge', 'stepping_stones', 'ford', 'rope_bridge'] as const;
export type ProbeSituation = (typeof PROBE_SITUATIONS)[number];

interface TrialBase {
  readonly spec: GameTrialSpec;
  /** Story clock for lighting: 0 sunset .. 1 deep night with moonrise (visual only). */
  readonly sky: number;
}

export interface PracticeTrial extends TrialBase {
  readonly kind: 'practice';
  readonly map: RoadMap;
  readonly fork: ForkTrial;
}
export interface ErrandMapTrial extends TrialBase {
  readonly kind: 'errand_map';
  readonly map: RoadMap;
  readonly solution: MapSolution;
  readonly ordinal: number;
}
export interface OptionalTrial extends TrialBase {
  readonly kind: 'optional_opportunity';
  readonly opportunity: OptionalKind;
  readonly ordinal: number;
}
export interface ForkChoiceTrial extends TrialBase {
  readonly kind: 'fork_choice';
  readonly fork: ForkTrial;
  /** Position in the whole fork sequence (pre + post). */
  readonly ordinal: number;
}
export interface BlockedTrial extends TrialBase {
  readonly kind: 'blocked_route';
  readonly event: BlockedEvent;
  readonly map: RoadMap;
  readonly solution: MapSolution;
  readonly ordinal: number;
}
export interface FuelTrial extends TrialBase {
  readonly kind: 'fuel_round';
  readonly round: RoundPlanEntry;
  readonly endowment: number;
  readonly multiplier: number;
}
export interface EffortTrial extends TrialBase {
  readonly kind: 'effort_hold';
  readonly requiredMs: number;
  readonly ordinal: number;
}
export interface ProbeTrial extends TrialBase {
  readonly kind: 'probe';
  readonly situation: ProbeSituation;
  readonly position: number;
  /** Which side the safe option is drawn on (counterbalanced, seeded). */
  readonly safeSide: Branch;
}

export type RoadHomeTrial =
  | PracticeTrial
  | ErrandMapTrial
  | OptionalTrial
  | ForkChoiceTrial
  | BlockedTrial
  | FuelTrial
  | EffortTrial
  | ProbeTrial;

export interface RoadHomePlan {
  readonly level: CalibrationLevel;
  readonly formId: string;
  readonly settings: RoadHomeSettings;
  readonly fuel: FuelPotSettings;
  readonly trials: readonly RoadHomeTrial[];
  /** Trial index of the first reversed fork (logged as `context_shift.shift_index`). */
  readonly shiftIndex: number;
  /** `trial_id -> params` for the scorer join. */
  readonly trialParams: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

const EXPECTED_BLOCKS = [
  'practice',
  'errand_maps',
  'blocked_road',
  'reversal',
  'fuel_pot',
  'uphill',
  'probe',
] as const;

function withSpec(
  base: GameTrialSpec,
  o: {
    readonly trialType: RoadHomeTrialType;
    readonly stimulusId: string;
    readonly vocabulary: readonly [string, ...string[]];
    readonly expected: string | null;
    readonly windowMs: number | null;
    readonly params: Readonly<Record<string, unknown>>;
    readonly probeGroupId?: string | null;
  },
): GameTrialSpec {
  return {
    ...base,
    trial_type: o.trialType,
    stimulus_id: o.stimulusId,
    vocabulary: [...o.vocabulary] as [string, ...string[]],
    voice_vocabulary: [],
    expected_response: o.expected,
    response_window_ms: o.windowMs,
    latency_anchor: 'visual_onset',
    audio_keys: [],
    ...(o.probeGroupId !== undefined ? { probe_group_id: o.probeGroupId } : {}),
    params: { ...base.params, ...o.params },
  };
}

function skyAt(index: number, total: number): number {
  return total <= 1 ? 0 : Math.min(1, Math.max(0, index / (total - 1)));
}

/** Build the plan. Throws {@link RoadHomeConfigError} / `ScheduleConstraintError` (fail closed). */
export function buildRoadHomePlan(
  config: GameConfig,
  level: CalibrationLevel,
  rng: SeededRng,
  formId: string,
): RoadHomePlan {
  const settings = resolveSettings(config, level);
  const fuel = fuelPotSettings(config);
  const skeleton = new DataDrivenTrialScheduler().build(
    config,
    level,
    rng.stream('schedule'),
    formId,
  );
  for (const b of EXPECTED_BLOCKS) {
    if (!(b in skeleton.blockLengths)) throw new RoadHomeConfigError(`block '${b}' is missing`);
  }
  if (skeleton.contextShiftIndex === null) {
    throw new RoadHomeConfigError('the reversal needs a context-shift index');
  }
  const shiftIndex = skeleton.contextShiftIndex;
  const len = (b: string): number => skeleton.blockLengths[b] ?? 0;
  const errandTypes = settings.errandPattern.slice(0, len('errand_maps'));
  const blockedTypes = settings.blockedPattern.slice(0, len('blocked_road'));
  if (errandTypes.length < len('errand_maps') || blockedTypes.length < len('blocked_road')) {
    throw new RoadHomeConfigError('block patterns are shorter than their blocks');
  }
  const count = (xs: readonly string[], t: string): number => xs.filter((x) => x === t).length;
  const maps = count(errandTypes, 'errand_map');
  const optionals = count(errandTypes, 'optional_opportunity');
  const blocked = count(blockedTypes, 'blocked_route');
  const preForks = count(errandTypes, 'fork_choice') + count(blockedTypes, 'fork_choice');
  const postForks = len('reversal');
  const minCounts = config.min_counts;
  const checks: [string, number][] = [
    ['maps', maps],
    ['optional_opportunities', optionals],
    ['blocked_events', blocked],
    ['post_reversal', postForks],
    ['fuel_rounds', len('fuel_pot')],
    ['effort_holds', len('uphill')],
  ];
  for (const [key, n] of checks) {
    const min = minCounts[key];
    if (min !== undefined && n < min) {
      throw new RoadHomeConfigError(`min_counts.${key}: planned ${n} < ${min}`);
    }
  }
  if (blocked > settings.blockedKinds.length) {
    throw new RoadHomeConfigError('blocked_event_kinds has fewer kinds than blocked events');
  }
  if (optionals > settings.optionalKinds.length) {
    throw new RoadHomeConfigError('optional_kinds has fewer kinds than opportunities');
  }

  // Forks: one balanced sequence across the reversal (cue sides balanced within each phase).
  const forks = buildForkSequence(
    preForks + postForks,
    preForks,
    rng.stream('forks'),
    settings.forkMaxSameSide,
  );
  const practiceFork = forkTrial(0, rng.stream('practice').bool() ? 'left' : 'right', false);
  const fuelPlan = roadHomeFuelPlan(
    len('fuel_pot'),
    settings.fuelFreeRiderRounds,
    settings.fuelErrorWindow,
    rng.stream('fuel'),
  );
  const optionalOrder = rng.stream('optional').shuffle(settings.optionalKinds);
  const probeSides = rng.stream('probe_sides');
  const mapRng = rng.stream('maps');

  const total = skeleton.trials.length;
  const trials: RoadHomeTrial[] = [];
  const params: Record<string, Readonly<Record<string, unknown>>> = {};
  let mapOrdinal = 0;
  let optOrdinal = 0;
  let forkOrdinal = 0;
  let blockedOrdinal = 0;
  let fuelOrdinal = 0;
  let effortOrdinal = 0;
  let probePosition = 0;
  const withinBlock = new Map<string, number>();

  for (const base of skeleton.trials) {
    const i = withinBlock.get(base.block_id) ?? 0;
    withinBlock.set(base.block_id, i + 1);
    const sky = skyAt(base.trial_index, total);
    let t: RoadHomeTrial;
    const fork = (): ForkChoiceTrial => {
      const f = forks[forkOrdinal];
      if (!f) throw new RoadHomeConfigError('fork sequence exhausted');
      const reversed = base.trial_index >= shiftIndex;
      if (f.reversed !== reversed) {
        throw new RoadHomeConfigError(
          `fork ${forkOrdinal} reversal does not match the shift index`,
        );
      }
      const trial: ForkChoiceTrial = {
        kind: 'fork_choice',
        sky,
        ordinal: forkOrdinal,
        fork: f,
        spec: withSpec(base, {
          trialType: 'fork_choice',
          stimulusId: `road_home.fork.lantern_${f.blueSide}`,
          vocabulary: ['left', 'right'],
          expected: f.ruleOption,
          windowMs: settings.stepWindowMs,
          params: {
            rule_option: f.ruleOption,
            old_rule_option: f.oldRuleOption,
            lantern_side: f.blueSide,
            rule_cue: f.reversed ? 'unlit_branch' : 'lantern_branch',
            reversed: f.reversed,
            fork_ordinal: forkOrdinal,
          },
        }),
      };
      forkOrdinal += 1;
      return trial;
    };
    switch (base.block_id) {
      case 'practice': {
        t = {
          kind: 'practice',
          sky,
          map: practiceMap('road_home.practice', settings.fuelUnits),
          fork: practiceFork,
          spec: withSpec(base, {
            trialType: 'fork_choice',
            stimulusId: `road_home.practice.lantern_${practiceFork.blueSide}`,
            vocabulary: ['left', 'right'],
            expected: practiceFork.ruleOption,
            windowMs: null,
            params: {
              rule_option: practiceFork.ruleOption,
              old_rule_option: practiceFork.oldRuleOption,
              lantern_side: practiceFork.blueSide,
              rule_cue: 'lantern_branch',
              reversed: false,
            },
          }),
        };
        break;
      }
      case 'errand_maps':
      case 'blocked_road': {
        const type = (base.block_id === 'errand_maps' ? errandTypes : blockedTypes)[i];
        if (type === 'errand_map') {
          const id = `map_${base.form_id}_${mapOrdinal}`;
          const { map, solution } = generateErrandMap(
            {
              id,
              nodes: settings.mapNodes,
              errands: settings.errandsPerMap,
              fuelBudget: settings.fuelUnits,
              edgeCostRange: settings.edgeCostRange,
            },
            mapRng.stream(id),
          );
          t = {
            kind: 'errand_map',
            sky,
            map,
            solution,
            ordinal: mapOrdinal,
            spec: withSpec(base, {
              trialType: 'errand_map',
              stimulusId: `road_home.${id}`,
              vocabulary: ['step'],
              expected: null,
              windowMs: null,
              params: {
                map_id: id,
                optimal_order: [...solution.optimalOrder],
                optimal_cost: solution.optimalCost,
                optimal_fuel: solution.optimalCost,
                n_errands: map.errands.length,
                fuel_budget: map.fuelBudget,
                step_window_ms: settings.stepWindowMs,
                layout: mapLayoutParams(map),
              },
            }),
          };
          mapOrdinal += 1;
        } else if (type === 'optional_opportunity') {
          const kind = optionalOrder[optOrdinal] as OptionalKind;
          t = {
            kind: 'optional_opportunity',
            sky,
            opportunity: kind,
            ordinal: optOrdinal,
            spec: withSpec(base, {
              trialType: 'optional_opportunity',
              stimulusId: `road_home.optional.${kind}`,
              vocabulary: ['take', 'skip'],
              expected: null,
              windowMs: settings.optionalWindowMs,
              // No prompt ever mentions an optional action (EPI-03): unprompted by design.
              params: { mentioning_lines: [], opportunity: kind, opportunity_ordinal: optOrdinal },
            }),
          };
          optOrdinal += 1;
        } else if (type === 'fork_choice') {
          t = fork();
        } else if (type === 'blocked_route') {
          const kind = settings.blockedKinds[blockedOrdinal] as BlockedEventKind;
          const id = `map_blocked_${base.form_id}_${blockedOrdinal}`;
          const opts = {
            id,
            nodes: settings.mapNodes,
            errands: kind === 'fallen_tree' ? settings.blockedMapErrands : 0,
            fuelBudget: settings.fuelUnits,
            edgeCostRange: settings.edgeCostRange,
          };
          const g =
            kind === 'fallen_tree'
              ? generateFallenTreeMap(opts, mapRng.stream(id))
              : generateFloodMap(opts, mapRng.stream(id));
          t = {
            kind: 'blocked_route',
            sky,
            map: g.map,
            solution: g.solution,
            event: g.event,
            ordinal: blockedOrdinal,
            spec: withSpec(base, {
              trialType: 'blocked_route',
              stimulusId: `road_home.blocked.${kind}`,
              vocabulary: ['fallback'],
              expected: null,
              windowMs: null,
              params: {
                map_id: id,
                post_block_optimal_cost: g.event.postBlockOptimalCost,
                blocked_kind: kind,
                blocked_edges: [...g.event.blockedEdges],
                solvable_by_road: kind === 'fallen_tree',
                fallback_offered: kind === 'flooded_river',
                ferry: g.event.ferry
                  ? [g.event.ferry.ghat, g.event.ferry.landing, g.event.ferry.cost]
                  : null,
                rest_cap_ms: kind === 'flooded_river' ? settings.restCapMs : null,
                optimal_cost_before_block: g.solution.optimalCost,
                n_errands: g.map.errands.length,
                fuel_budget: g.map.fuelBudget,
                layout: mapLayoutParams(g.map),
              },
            }),
          };
          blockedOrdinal += 1;
        } else {
          throw new RoadHomeConfigError(`pattern type ${String(type)} is not allowed here`);
        }
        break;
      }
      case 'reversal':
        t = fork();
        break;
      case 'fuel_pot': {
        const round = fuelPlan[fuelOrdinal];
        if (!round) throw new RoadHomeConfigError('fuel plan exhausted');
        t = {
          kind: 'fuel_round',
          sky,
          round,
          endowment: fuel.endowment.value,
          multiplier: fuel.multiplier.value,
          spec: {
            ...withSpec(base, {
              trialType: 'fuel_round',
              stimulusId: `road_home.fuel.${round.partnerType}`,
              vocabulary: ['contribute'],
              expected: null,
              windowMs: settings.fuelWindowMs,
              params: {
                round: round.round,
                partner_type: round.partnerType,
                policy_id: `${round.partnerType}.v1`,
                error_round: round.errorRound,
                endowment_tokens: fuel.endowment.value,
                endowment_source: fuel.endowment.source,
                pot_multiplier: fuel.multiplier.value,
                multiplier_source: fuel.multiplier.source,
                partner_params: { ...fuel.partner },
                partner_param_sources: { ...fuel.partnerSources },
              },
            }),
          },
        };
        fuelOrdinal += 1;
        break;
      }
      case 'uphill': {
        t = {
          kind: 'effort_hold',
          sky,
          requiredMs: settings.holdRequiredMs,
          ordinal: effortOrdinal,
          spec: withSpec(base, {
            trialType: 'effort_hold',
            stimulusId: `road_home.uphill.${effortOrdinal}`,
            vocabulary: ['hold'],
            expected: 'hold',
            windowMs: settings.uphillWindowMs,
            params: { required_hold_ms: settings.holdRequiredMs, hill: effortOrdinal },
          }),
        };
        effortOrdinal += 1;
        break;
      }
      case 'probe': {
        const situation = PROBE_SITUATIONS[
          probePosition % PROBE_SITUATIONS.length
        ] as ProbeSituation;
        const safeSide: Branch = probeSides.bool() ? 'left' : 'right';
        // Two comparable segments of two trials (the simulator's convention).
        const group = `road_home.probe_${Math.floor(probePosition / 2) + 1}`;
        t = {
          kind: 'probe',
          sky,
          situation,
          position: probePosition,
          safeSide,
          spec: withSpec(base, {
            trialType: 'probe',
            stimulusId: `probe.${probePosition}`,
            vocabulary: ['safe', 'risky'],
            expected: null,
            windowMs: settings.probeWindowMs,
            probeGroupId: group,
            params: {
              repeat_group_id: `probe_situation_${probePosition}`,
              situation,
              safe_side: safeSide,
            },
          }),
        };
        probePosition += 1;
        break;
      }
      default:
        throw new RoadHomeConfigError(`unexpected block '${base.block_id}'`);
    }
    trials.push(t);
    params[t.spec.trial_id] = t.spec.params as Record<string, unknown>;
  }
  const firstReversed = trials.find((t) => t.kind === 'fork_choice' && t.fork.reversed);
  if (!firstReversed || firstReversed.spec.trial_index !== shiftIndex) {
    throw new RoadHomeConfigError('the first reversed fork must be the context-shift trial');
  }
  return {
    level,
    formId: skeleton.formId,
    settings,
    fuel,
    trials,
    shiftIndex,
    trialParams: params,
  };
}
