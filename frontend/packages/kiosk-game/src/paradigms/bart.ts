/**
 * Balloon Analogue Risk Task (MG-01 Balloon Pump).
 *
 * Explosion schedules (`constraints.explosion_distribution: uniform_1_to_max_by_colour`,
 * `seeded_explosion_table: true`): for each risk colour the explosion points of its `n` balloons are
 * drawn by stratified sampling from the discrete uniform distribution on `1..max_pumps(colour)`:
 * the range is cut into `n` equal-probability strata, one point is drawn uniformly inside each, and
 * the points are shuffled. Every balloon is marginally uniform on `1..max`, while each session's
 * table matches the distribution as closely as `n` draws allow (MG-01 AC: count check on a fixed
 * seed table), so sessions are not advantaged by lucky schedules.
 *
 * A balloon explodes on the pump whose count reaches its explosion point (pump `k` explodes iff
 * `k >= explosion_point`), and it can never take more than `max_pumps` pumps. Collecting banks the
 * balloon (a jar fills; no numbers). Adjusted pumps (Lejuez et al., 2002) = mean pumps on balloons
 * that did not explode (research QA helper; the scorer computes the indicator from `pump` events).
 */
import type { CalibrationLevel, GameConfig, GameTrialSpec, PumpPayload } from '@shriii/contracts';
import type { SeededRng } from '../core/contracts.ts';
import {
  constraintString,
  type IndicatorBinding,
  ParadigmConfigError,
  ParadigmStateError,
  type Resolved,
  timingNumber,
} from './common.ts';
import { BALLOON_DEFAULTS } from './content-defaults.ts';

const PARADIGM = 'bart';

export type RiskColour = PumpPayload['risk_colour'];
export const RISK_COLOURS: readonly RiskColour[] = ['low_risk', 'high_risk'];

/** One scheduled balloon. */
export interface BalloonSpec {
  readonly index: number;
  readonly riskColour: RiskColour;
  readonly explosionPoint: number;
  readonly maxPumps: number;
}

/** Max pumps per colour: `max_pumps_<colour>` timing keys, else `max_pumps` (low) and a documented fraction (high). */
export function maxPumpsByColour(
  config: GameConfig,
  level: CalibrationLevel,
): Readonly<Record<RiskColour, Resolved<number>>> {
  const base = timingNumber(config, level, 'max_pumps');
  const resolve = (colour: RiskColour): Resolved<number> => {
    const explicit = timingNumber(config, level, `max_pumps_${colour}`);
    if (explicit !== null)
      return { value: explicit, source: 'level_timing', key: `max_pumps_${colour}` };
    if (base === null)
      throw new ParadigmConfigError(PARADIGM, `levels.${level}.timing.max_pumps missing`);
    if (colour === 'low_risk') return { value: base, source: 'level_timing', key: 'max_pumps' };
    return {
      value: Math.max(2, Math.round(base * BALLOON_DEFAULTS.highRiskFraction)),
      source: 'paradigm_default',
      key: 'BALLOON_DEFAULTS.highRiskFraction',
    };
  };
  return { low_risk: resolve('low_risk'), high_risk: resolve('high_risk') };
}

/**
 * Stratified explosion points for `n` balloons on `1..max`: stratum `k` covers
 * `[floor(k*max/n)+1, floor((k+1)*max/n)]` (non-empty when `n <= max`), one uniform draw per stratum,
 * then shuffled.
 */
export function stratifiedExplosionPoints(n: number, max: number, rng: SeededRng): number[] {
  if (!Number.isInteger(n) || n < 0)
    throw new ParadigmConfigError(PARADIGM, `balloon count must be >= 0, got ${n}`);
  if (!Number.isInteger(max) || max < 1)
    throw new ParadigmConfigError(PARADIGM, `max pumps must be >= 1, got ${max}`);
  if (n === 0) return [];
  const points: number[] = [];
  if (n <= max) {
    for (let k = 0; k < n; k += 1) {
      const lo = Math.floor((k * max) / n) + 1;
      const hi = Math.floor(((k + 1) * max) / n);
      points.push(rng.int(lo, hi));
    }
  } else {
    // More balloons than values: full passes over 1..max, then a stratified remainder.
    for (let pass = 0; pass < Math.floor(n / max); pass += 1)
      for (let v = 1; v <= max; v += 1) points.push(v);
    points.push(...stratifiedExplosionPoints(n % max, max, rng.stream('remainder')));
  }
  return rng.shuffle(points);
}

/**
 * Seeded explosion table: colours balanced (`n/2` each, the odd one seeded), colour order shuffled,
 * explosion points stratified per colour.
 */
export function buildExplosionTable(
  balloons: number,
  maxPumps: Readonly<Record<RiskColour, number>>,
  rng: SeededRng,
): BalloonSpec[] {
  if (!Number.isInteger(balloons) || balloons < 1) {
    throw new ParadigmConfigError(PARADIGM, `balloons must be a positive integer, got ${balloons}`);
  }
  const low = Math.floor(balloons / 2) + (balloons % 2 === 1 && rng.stream('odd').bool() ? 1 : 0);
  const colours = rng
    .stream('colours')
    .shuffle([
      ...new Array<RiskColour>(low).fill('low_risk'),
      ...new Array<RiskColour>(balloons - low).fill('high_risk'),
    ]);
  const pts: Record<RiskColour, number[]> = {
    low_risk: stratifiedExplosionPoints(low, maxPumps.low_risk, rng.stream('points.low_risk')),
    high_risk: stratifiedExplosionPoints(
      balloons - low,
      maxPumps.high_risk,
      rng.stream('points.high_risk'),
    ),
  };
  const next: Record<RiskColour, number> = { low_risk: 0, high_risk: 0 };
  return colours.map((riskColour, index) => {
    const explosionPoint = pts[riskColour][next[riskColour]++] as number;
    return { index, riskColour, explosionPoint, maxPumps: maxPumps[riskColour] };
  });
}

/** Validate the config's declared distribution (fail closed on anything but the implemented one). */
export function assertSupportedDistribution(config: GameConfig): void {
  const d = constraintString(config, 'explosion_distribution');
  if (d !== null && d !== 'uniform_1_to_max_by_colour') {
    throw new ParadigmConfigError(PARADIGM, `unsupported explosion_distribution ${d}`);
  }
}

/** Result of one pump. */
export interface PumpResult {
  readonly pumpIndex: number;
  readonly exploded: boolean;
  /** Pumps that inflated the balloon so far (including this one). */
  readonly pumps: number;
}

/** Live state of one balloon. */
export class BalloonTrial {
  readonly spec: BalloonSpec;
  private pumpCount = 0;
  private state: 'inflating' | 'exploded' | 'collected' = 'inflating';
  private readonly events: {
    readonly tMs: number;
    readonly kind: 'pump' | 'collect';
    readonly exploded: boolean;
  }[] = [];

  constructor(spec: BalloonSpec) {
    if (spec.explosionPoint < 1 || spec.explosionPoint > spec.maxPumps) {
      throw new ParadigmConfigError(
        PARADIGM,
        `explosion point ${spec.explosionPoint} outside 1..${spec.maxPumps}`,
      );
    }
    this.spec = spec;
  }

  get pumps(): number {
    return this.pumpCount;
  }

  get status(): 'inflating' | 'exploded' | 'collected' {
    return this.state;
  }

  /** True while another pump is allowed (inflating and below max pumps). */
  get canPump(): boolean {
    return this.state === 'inflating' && this.pumpCount < this.spec.maxPumps;
  }

  pump(tMs: number): PumpResult {
    if (!this.canPump)
      throw new ParadigmStateError(
        PARADIGM,
        `balloon ${this.spec.index} cannot be pumped (${this.state})`,
      );
    this.pumpCount += 1;
    const exploded = this.pumpCount >= this.spec.explosionPoint;
    if (exploded) this.state = 'exploded';
    this.events.push({ tMs, kind: 'pump', exploded });
    return { pumpIndex: this.pumpCount - 1, exploded, pumps: this.pumpCount };
  }

  collect(tMs: number): void {
    if (this.state !== 'inflating')
      throw new ParadigmStateError(PARADIGM, `balloon ${this.spec.index} is ${this.state}`);
    this.state = 'collected';
    this.events.push({ tMs, kind: 'collect', exploded: false });
  }

  /** `pump` payload for the most recent pump/collect (collect = `collected: true`). */
  lastPayload(): PumpPayload {
    const last = this.events[this.events.length - 1];
    if (!last) throw new ParadigmStateError(PARADIGM, 'no pump or collect yet');
    return {
      balloon_index: this.spec.index,
      pump_index: last.kind === 'collect' ? this.pumpCount : this.pumpCount - 1,
      risk_colour: this.spec.riskColour,
      exploded: last.exploded,
      collected: last.kind === 'collect',
    };
  }

  /** Banked tokens (pictured jar fill): pumps when collected, 0 when exploded. */
  banked(): number {
    return this.state === 'collected' ? this.pumpCount : 0;
  }
}

/** Adjusted pumps over finished balloons (null when every balloon exploded). QA/bots only. */
export function adjustedPumps(
  trials: readonly Pick<BalloonTrial, 'status' | 'pumps'>[],
): number | null {
  const kept = trials.filter((t) => t.status === 'collected');
  return kept.length === 0 ? null : kept.reduce((a, t) => a + t.pumps, 0) / kept.length;
}

function isRiskColour(x: unknown): x is RiskColour {
  return x === 'low_risk' || x === 'high_risk';
}

/**
 * Explosion table aligned to an engine schedule. The engine scheduler allocates the colour of each
 * scored balloon (trial types `low_risk` / `high_risk`); this draws the stratified explosion points
 * per colour for exactly the scheduled counts, in trial order. `rng` must be a dedicated session
 * substream (e.g. `ctx.rng.stream('balloon.table')`).
 */
export function explosionTableForSchedule(
  trials: readonly GameTrialSpec[],
  maxPumps: Readonly<Record<RiskColour, number>>,
  rng: SeededRng,
): ReadonlyMap<string, BalloonSpec> {
  const scored = trials.filter(
    (t) => t.phase !== 'practice' && t.phase !== 'warmup' && isRiskColour(t.trial_type),
  );
  const byColour: Record<RiskColour, GameTrialSpec[]> = { low_risk: [], high_risk: [] };
  for (const t of scored) byColour[t.trial_type as RiskColour].push(t);
  const out = new Map<string, BalloonSpec>();
  for (const colour of RISK_COLOURS) {
    const pts = stratifiedExplosionPoints(
      byColour[colour].length,
      maxPumps[colour],
      rng.stream(`points.${colour}`),
    );
    byColour[colour].forEach((t, k) => {
      out.set(t.trial_id, {
        index: scored.indexOf(t),
        riskColour: colour,
        explosionPoint: pts[k] as number,
        maxPumps: maxPumps[colour],
      });
    });
  }
  return out;
}

/**
 * Return the schedule with balloon params filled in (scoring keys `risk_colour`, `explosion_point`,
 * `max_pumps`). Practice balloons are low-risk with a point drawn from `rng.stream('practice')`.
 */
export function withBalloonParams(
  trials: readonly GameTrialSpec[],
  maxPumps: Readonly<Record<RiskColour, number>>,
  rng: SeededRng,
): GameTrialSpec[] {
  const table = explosionTableForSchedule(trials, maxPumps, rng);
  const practiceRng = rng.stream('practice');
  return trials.map((t) => {
    const spec = table.get(t.trial_id);
    if (spec) {
      return {
        ...t,
        stimulus_id: `balloon.${spec.riskColour}`,
        params: {
          ...t.params,
          risk_colour: spec.riskColour,
          explosion_point: spec.explosionPoint,
          max_pumps: spec.maxPumps,
          balloon_index: spec.index,
        },
      };
    }
    if (t.phase === 'practice') {
      return {
        ...t,
        stimulus_id: 'balloon.low_risk',
        params: {
          ...t.params,
          risk_colour: 'low_risk',
          explosion_point: practiceRng.int(1, maxPumps.low_risk),
          max_pumps: maxPumps.low_risk,
        },
      };
    }
    return t;
  });
}

/** Balloon spec from a trial's params (throws when the params are missing). */
export function balloonSpecFromTrial(t: GameTrialSpec): BalloonSpec {
  const p = t.params as Record<string, unknown>;
  const colour = p.risk_colour;
  const point = p.explosion_point;
  const max = p.max_pumps;
  if (!isRiskColour(colour) || typeof point !== 'number' || typeof max !== 'number') {
    throw new ParadigmConfigError(PARADIGM, `trial ${t.trial_id} has no balloon params`);
  }
  const index = typeof p.balloon_index === 'number' ? p.balloon_index : t.trial_index;
  return { index, riskColour: colour, explosionPoint: point, maxPumps: max };
}

export const BART_INDICATORS: readonly IndicatorBinding[] = [
  {
    moduleId: 'balloon',
    indicators: [
      'risk_preference.adjusted_pumps',
      'risk_preference.explosion_rate',
      'decisiveness.time_to_collect',
      'decisiveness.commit_rvi',
      'response_consistency.pump_rvi',
      'persistence_of_style.post_loss_adjustment',
    ],
  },
];
