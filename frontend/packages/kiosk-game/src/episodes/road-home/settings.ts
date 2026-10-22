/**
 * Road Home (EPI-03) settings, resolved from `content/games/pathway-a/road-home.json` (ENG-04/ENG-10).
 *
 * Every number the episode uses comes from the config: level timing (`levels.Lx.timing`), block
 * structure and constraints. Missing keys fail closed with {@link RoadHomeConfigError}; the episode
 * never invents a window or a count. Stimulus-design defaults that the shared paradigm core still
 * carries (`paradigms/content-defaults.ts`) are only used through `Resolved` values whose source is
 * logged.
 */
import type { CalibrationLevel, GameConfig } from '@shriii/contracts';
import {
  constraintNumber,
  constraintStrings,
  constraintWindow,
  timingNumber,
} from '../../paradigms/common.ts';

/** Thrown when the config cannot drive the episode (the module will not run). */
export class RoadHomeConfigError extends Error {
  constructor(message: string) {
    super(`[road_home] ${message}`);
    this.name = 'RoadHomeConfigError';
  }
}

/** Trial kinds as the scoring conventions name them (`trial_start.payload.trial_type`). */
export type RoadHomeTrialType =
  | 'errand_map'
  | 'optional_opportunity'
  | 'fork_choice'
  | 'blocked_route'
  | 'fuel_round'
  | 'effort_hold'
  | 'probe';

const PATTERN_TYPES: ReadonlySet<string> = new Set<RoadHomeTrialType>([
  'errand_map',
  'optional_opportunity',
  'fork_choice',
  'blocked_route',
]);

export type BlockedEventKind = 'fallen_tree' | 'flooded_river';
export type OptionalKind =
  | 'stranded_traveller'
  | 'shrine_lamp'
  | 'spilled_mangoes'
  | 'thirsty_calf'
  | 'fallen_signpost';

const BLOCKED_KINDS: ReadonlySet<string> = new Set<BlockedEventKind>([
  'fallen_tree',
  'flooded_river',
]);
const OPTIONAL_KINDS: ReadonlySet<string> = new Set<OptionalKind>([
  'stranded_traveller',
  'shrine_lamp',
  'spilled_mangoes',
  'thirsty_calf',
  'fallen_signpost',
]);

/** Everything the plan and the director read from the config at one calibration level. */
export interface RoadHomeSettings {
  readonly level: CalibrationLevel;
  readonly mapNodes: number;
  readonly fuelUnits: number;
  /** Response window per route step / fork (ms). */
  readonly stepWindowMs: number;
  readonly holdRequiredMs: number;
  readonly optionalWindowMs: number;
  readonly fuelWindowMs: number;
  readonly uphillWindowMs: number;
  /** Time on the unsolvable crossing before the partner leads the fallback (ms). */
  readonly restCapMs: number;
  /** Probe window: the block trial budget (same rule as the engine scheduler for probe segments). */
  readonly probeWindowMs: number;
  readonly idleGapLogMs: number;
  readonly errandsPerMap: number;
  readonly blockedMapErrands: number;
  readonly edgeCostRange: readonly [number, number];
  readonly forkMaxSameSide: number;
  readonly errandPattern: readonly RoadHomeTrialType[];
  readonly blockedPattern: readonly RoadHomeTrialType[];
  readonly blockedKinds: readonly BlockedEventKind[];
  readonly optionalKinds: readonly OptionalKind[];
  readonly fuelFreeRiderRounds: number;
  readonly fuelErrorWindow: readonly [number, number];
}

function needTiming(config: GameConfig, level: CalibrationLevel, key: string): number {
  const v = timingNumber(config, level, key);
  if (v === null || v < 0) {
    throw new RoadHomeConfigError(`levels.${level}.timing.${key} is missing or negative`);
  }
  return v;
}

function needNumber(config: GameConfig, key: string): number {
  const v = constraintNumber(config, key);
  if (v === null) throw new RoadHomeConfigError(`constraints.${key} is missing`);
  return v;
}

function needWindow(config: GameConfig, key: string): readonly [number, number] {
  const v = constraintWindow(config, key);
  if (!v || v[0] > v[1]) throw new RoadHomeConfigError(`constraints.${key} must be [lo, hi]`);
  return v;
}

function needPattern(config: GameConfig, key: string): RoadHomeTrialType[] {
  const v = constraintStrings(config, key);
  if (!v || v.length === 0) throw new RoadHomeConfigError(`constraints.${key} is missing`);
  for (const t of v) {
    if (!PATTERN_TYPES.has(t)) throw new RoadHomeConfigError(`constraints.${key}: unknown '${t}'`);
  }
  return v as RoadHomeTrialType[];
}

function needKinds<T extends string>(
  config: GameConfig,
  key: string,
  allowed: ReadonlySet<string>,
): T[] {
  const v = constraintStrings(config, key);
  if (!v || v.length === 0) throw new RoadHomeConfigError(`constraints.${key} is missing`);
  for (const k of v) {
    if (!allowed.has(k)) throw new RoadHomeConfigError(`constraints.${key}: unknown '${k}'`);
  }
  return v as T[];
}

/** Resolve and validate the settings for `level`. */
export function resolveSettings(config: GameConfig, level: CalibrationLevel): RoadHomeSettings {
  if (config.module_id !== 'road_home') {
    throw new RoadHomeConfigError(`config is for '${config.module_id}', not road_home`);
  }
  const probeBlock = config.blocks.find((b) => b.block_id === 'probe');
  if (!probeBlock || probeBlock.budget_trial_ms === null) {
    throw new RoadHomeConfigError('probe block with budget_trial_ms is required');
  }
  const settings: RoadHomeSettings = {
    level,
    mapNodes: needTiming(config, level, 'map_nodes'),
    fuelUnits: needTiming(config, level, 'fuel_units'),
    stepWindowMs: needTiming(config, level, 'step_window_ms'),
    holdRequiredMs: needTiming(config, level, 'hold_required_ms'),
    optionalWindowMs: needTiming(config, level, 'optional_window_ms'),
    fuelWindowMs: needTiming(config, level, 'fuel_window_ms'),
    uphillWindowMs: needTiming(config, level, 'uphill_window_ms'),
    restCapMs: needTiming(config, level, 'rest_cap_ms'),
    probeWindowMs: probeBlock.budget_trial_ms,
    idleGapLogMs: needNumber(config, 'idle_gap_log_ms'),
    errandsPerMap: needNumber(config, 'errands_per_map'),
    blockedMapErrands: needNumber(config, 'blocked_map_errands'),
    edgeCostRange: needWindow(config, 'edge_cost_range'),
    forkMaxSameSide: needNumber(config, 'fork_max_same_side'),
    errandPattern: needPattern(config, 'errand_block_pattern'),
    blockedPattern: needPattern(config, 'blocked_block_pattern'),
    blockedKinds: needKinds<BlockedEventKind>(config, 'blocked_event_kinds', BLOCKED_KINDS),
    optionalKinds: needKinds<OptionalKind>(config, 'optional_kinds', OPTIONAL_KINDS),
    fuelFreeRiderRounds: needNumber(config, 'fuel_free_rider_rounds'),
    fuelErrorWindow: needWindow(config, 'fuel_error_round_window'),
  };
  if (settings.errandsPerMap < 1 || settings.errandsPerMap > 4) {
    throw new RoadHomeConfigError('errands_per_map must be 1..4 (pictured errand chit)');
  }
  if (settings.mapNodes < settings.errandsPerMap + 3) {
    throw new RoadHomeConfigError('map_nodes too small for the errands');
  }
  return settings;
}
