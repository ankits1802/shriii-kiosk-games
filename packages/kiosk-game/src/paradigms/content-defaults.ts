/**
 * Stimulus-design defaults for values the iteration-1 content configs (`content/games/**`) do not yet
 * carry. These are CONTENT defaults (ladder steps, pot multiplier, goods catalogue), never scientific
 * thresholds: thresholds (premature cut-off, reacquisition run, hostile tone level, ...) are always
 * passed in by callers from `scoring/**` YAML.
 *
 * Every default is consumed through `resolveNumber`/explicit option objects that report
 * `source: 'paradigm_default'`, and modules log the resolved value with its source, so a session that
 * ran on a default is identifiable in the raw events. Where a value mirrors the synthetic-player
 * simulator (`python/shriii_simulator/.../data/simulator.yaml`) it says so: the simulator and the
 * kiosk must present the same stimuli for parameter recovery to be meaningful.
 *
 * Each key names the config key that should replace it (requested from the content owner).
 */

/** Wait-or-Now delay ladder (MG-07). Mirrors the simulator's `wait_or_now` titration. */
export const DELAY_LADDER_DEFAULTS = {
  /** `constraints.delay_ll_amount`: larger-later reward in pictured tokens. */
  llAmount: 10,
  /** `constraints.delay_cycles`: delays in sun/moon cycles; each presented `repeats` times. */
  delays: [1, 2, 4, 8] as const,
  /** `constraints.delay_repeats`. */
  repeats: 2,
  /** `constraints.delay_order`: `seeded` shuffles each pass of the delays; `fixed` keeps config order. */
  order: 'seeded' as const,
} as const;

/** Wait-or-Now effort ladder (MG-07). */
export const EFFORT_LADDER_DEFAULTS = {
  /** `constraints.effort_hard_amount`: reward for the hold-to-earn option (tokens). */
  hardAmount: 10,
  /** `constraints.effort_hold_multipliers`: hold durations as multiples of `hold_required_ms`. */
  holdMultipliers: [1, 1, 1, 1] as const,
} as const;

/** Balloon (MG-01): `levels.Lx.timing.max_pumps_<colour>`; high-risk mirrors the simulator (32 / 16). */
export const BALLOON_DEFAULTS = {
  highRiskFraction: 0.5,
} as const;

/** Share-the-Pot / fuel pot (MG-05, EPI-03). */
export const PUBLIC_GOODS_DEFAULTS = {
  /** `constraints.pot_multiplier`: pot multiplied then split equally between two players. */
  potMultiplier: 2,
  /** `constraints.cooperative_share`: share of the endowment a cooperative partner contributes. */
  cooperativeShare: 0.8,
  /** `constraints.free_rider_max_tokens`. */
  freeRiderMaxTokens: 1,
  /** `constraints.error_tokens`: tokens that actually land in the pot on a scripted error. */
  errorTokens: 0,
  /** `constraints.fuel_endowment_tokens` for the Road Home fuel pot (no endowment key in road-home.json). */
  fuelEndowmentTokens: 6,
} as const;

/** Weighing Post (EPI-02) rule sets in pictured weight units (needle ticks), never shown as digits. */
export const WEIGHING_DEFAULTS = {
  /** Baseline rule: short weight (declared - true) <= approveWithin -> approve; <= warnWithin -> warn; else fine. */
  baseRule: { approveWithin: 0, warnWithin: 1, shortWeightOnly: true },
  /** New market rule (odd forms): zero tolerance; one tick of short weight is now a fine. */
  newRule: { approveWithin: 0, warnWithin: 0, shortWeightOnly: true },
  /** Needle ticks per item weight range. */
  minWeight: 2,
  maxWeight: 9,
  /** Share of decisions whose declared weight is honest. */
  honestShare: 0.4,
  /** Share of decisions whose needle is ambiguous until "inspect more" (requires one inspection). */
  ambiguousShare: 0.3,
} as const;

/** Road Home maps (EPI-03): node count and fuel come from the level table; the rest are defaults. */
export const ROUTE_DEFAULTS = {
  /** `constraints.errands_per_map`. */
  errandsPerMap: 3,
  /** `constraints.edge_cost_range` in fuel units (pictured drops). */
  edgeCostRange: [1, 3] as const,
  /** Extra edges beyond the spanning tree, as a fraction of node count. */
  extraEdgeFraction: 0.6,
  /** Maximum generation attempts before failing closed. */
  maxAttempts: 500,
} as const;

/** Stall (EPI-01) queue content. */
export const STALL_DEFAULTS = {
  /** Item kinds the player serves (go) and must not serve (no-go: spoiled or out of turn). */
  serveItems: ['mango', 'banana', 'tomato', 'onion', 'chilli', 'lemon'] as const,
  dontServeItems: ['spoiled_fruit', 'out_of_turn'] as const,
  /** `constraints.nogo_share` is absent in stall.json; no-go count comes from planned_counts. */
} as const;
