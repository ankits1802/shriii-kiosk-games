/**
 * Scripted Road Home bot (ENG-05: every module runs headlessly with a scripted bot; PLT-01 dev runs).
 *
 * A seeded synthetic player with plausible behaviour, so a bot run exercises every branch of the
 * episode and produces events every Road Home indicator can be computed from: it plans before the
 * first step, mostly follows the solver's tour (sometimes detours), bumps into the fallen tree a few
 * times before detouring, explores the flooded river before resting, perseverates briefly after the
 * unannounced reversal, takes some optional opportunities, shares fodder (less after a free rider),
 * completes most uphill holds and answers probes. All delays run on the session clock, so the same
 * bot runs in real time in the browser and in virtual time in tests.
 */
import type { Clock, SeededRng } from '../../core/contracts.ts';
import type { Branch } from '../../paradigms/reversal.ts';
import { optimalTour, RouteGraph, shortestPath } from '../../paradigms/route-planning.ts';
import type {
  ChoiceAnswer,
  ChoiceRequest,
  EffortAnswer,
  EffortRequest,
  FuelAnswer,
  FuelRequest,
  HoldRecord,
  MapAnswer,
  MapStepRequest,
  PlayerFeedback,
  RoadHomePlayer,
} from './types.ts';

/** Behaviour parameters (median adult defaults in {@link MEDIAN_ROAD_BOT}). */
export interface RoadBotPolicy {
  /** Median planning time before the first step of a map (ms). */
  readonly planningMs: number;
  /** Median gap between route steps (ms). */
  readonly stepGapMs: number;
  /** Probability of taking the solver's next step (else a random open neighbour). */
  readonly routeOptimality: number;
  /** Taps on a blocked road before detouring (fallen tree). */
  readonly retriesOnBlock: number;
  /** Crossings tried on the flooded river before resting. */
  readonly floodAttempts: number;
  /** Median fork / choice latency (ms). */
  readonly choiceMs: number;
  readonly forkAccuracy: number;
  /** Post-reversal forks answered with the old rule before switching. */
  readonly perseveration: number;
  readonly optionalTakeRate: number;
  /** Share of the endowment contributed at baseline. */
  readonly contributeShare: number;
  /** Proportional drop after a free-rider round. */
  readonly defectionDrop: number;
  readonly holdCompletion: number;
  readonly probeRiskRate: number;
}

export const MEDIAN_ROAD_BOT: RoadBotPolicy = {
  planningMs: 2600,
  stepGapMs: 900,
  routeOptimality: 0.85,
  retriesOnBlock: 1,
  floodAttempts: 2,
  choiceMs: 1050,
  forkAccuracy: 0.92,
  perseveration: 2,
  optionalTakeRate: 0.6,
  contributeShare: 0.6,
  defectionDrop: 0.35,
  holdCompletion: 0.8,
  probeRiskRate: 0.4,
};

const NO_FEEDBACK: PlayerFeedback = {
  touched: () => undefined,
  fuelChanged: () => undefined,
  effortProgress: () => undefined,
};

function aborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

export class BotPlayer implements RoadHomePlayer {
  private readonly clock: Clock;
  private readonly rng: SeededRng;
  private readonly policy: RoadBotPolicy;
  private readonly feedback: PlayerFeedback;
  private reversedSeen = 0;
  private lastPartner: string | null = null;
  private readonly retried = new Map<string, number>();
  private floodTries = 0;
  private mapTrialId: string | null = null;
  private dueAt: number | null = null;

  constructor(
    clock: Clock,
    rng: SeededRng,
    policy: RoadBotPolicy = MEDIAN_ROAD_BOT,
    feedback: PlayerFeedback = NO_FEEDBACK,
  ) {
    this.clock = clock;
    this.rng = rng;
    this.policy = policy;
    this.feedback = feedback;
  }

  dispose(): void {
    this.retried.clear();
  }

  /** A plausible touch point (normalised) for a target key, with a little scatter. */
  private touchAt(x: number, y: number): readonly [number, number] {
    const j = (v: number): number =>
      Math.min(0.98, Math.max(0.02, v + (this.rng.next() - 0.5) * 0.04));
    return [Math.round(j(x) * 1e4) / 1e4, Math.round(j(y) * 1e4) / 1e4];
  }

  /** Log-normal delay around `median` (sd 0.25 in log space), clamped to `[min, max]`. */
  private jitter(median: number, min = 80, max = Number.POSITIVE_INFINITY): number {
    const u1 = Math.max(1e-9, this.rng.next());
    const u2 = this.rng.next();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.min(max, Math.max(min, median * Math.exp(0.25 * z)));
  }

  private async wait(ms: number, signal: AbortSignal): Promise<boolean> {
    try {
      await this.clock.delay(ms, signal);
      return true;
    } catch {
      return false;
    }
  }

  /** Wait `ms` but never past the window; returns false when the window (or signal) ran out. */
  private async waitInWindow(
    ms: number,
    anchorMs: number,
    windowMs: number | null,
    signal: AbortSignal,
  ): Promise<'ok' | 'timeout' | 'aborted'> {
    const now = this.clock.now();
    if (windowMs !== null) {
      const left = anchorMs + windowMs - now;
      if (ms >= left) {
        if (!(await this.wait(Math.max(0, left), signal))) return 'aborted';
        return 'timeout';
      }
    }
    return (await this.wait(ms, signal)) ? 'ok' : 'aborted';
  }

  async mapStep(req: MapStepRequest): Promise<MapAnswer> {
    const { walk, trial, signal } = req;
    if (aborted(signal)) return { kind: 'aborted' };
    if (this.mapTrialId !== trial.spec.trial_id) {
      this.mapTrialId = trial.spec.trial_id;
      this.retried.clear();
      this.floodTries = 0;
    }
    const first = walk.stepCount === 0;
    // The decision time is drawn once per step; a window that closes first just re-prompts.
    if (this.dueAt === null) {
      const delay = first
        ? this.jitter(this.policy.planningMs, 600)
        : this.jitter(this.policy.stepGapMs, 250);
      this.dueAt = this.clock.now() + delay;
    }
    const w = await this.waitInWindow(
      Math.max(0, this.dueAt - this.clock.now()),
      req.anchorMs,
      req.windowMs,
      signal,
    );
    if (w === 'aborted') return { kind: 'aborted' };
    if (w === 'timeout') return { kind: 'timeout' };
    this.dueAt = null;
    const tMs = this.clock.now();
    // Flooded river: try the crossings, then rest.
    if (req.restOffered && trial.kind === 'blocked_route') {
      if (this.floodTries >= this.policy.floodAttempts) {
        this.feedback.touched('rest');
        return { kind: 'rest', tMs, latencyMs: tMs - walk.onsetMs, xy: this.touchAt(0.08, 0.84) };
      }
      const node = this.floodStep(req);
      if (node === null) {
        this.feedback.touched('rest');
        return { kind: 'rest', tMs, latencyMs: tMs - walk.onsetMs, xy: this.touchAt(0.08, 0.84) };
      }
      this.feedback.touched(`node:${node}`);
      return { kind: 'node', node, tMs, xy: this.nodeXy(walk.map.positions[node]) };
    }
    const node = this.routeStep(req);
    this.feedback.touched(`node:${node}`);
    return { kind: 'node', node, tMs, xy: this.nodeXy(walk.map.positions[node]) };
  }

  private nodeXy(
    p: { readonly x: number; readonly y: number } | undefined,
  ): readonly [number, number] {
    return this.touchAt(0.08 + 0.84 * (p?.x ?? 0.5), 0.1 + 0.8 * (p?.y ?? 0.5));
  }

  /** Next node: the solver's tour, bumping into a blocked road a few times before detouring. */
  private routeStep(req: MapStepRequest): string {
    const { walk } = req;
    const map = walk.map;
    const rest = walk.remainingErrands;
    const naive = optimalTour(new RouteGraph(map), walk.at, rest, map.home)?.path[1] ?? null;
    if (naive !== null && walk.isBlocked(naive)) {
      const n = this.retried.get(naive) ?? 0;
      if (n < this.policy.retriesOnBlock) {
        this.retried.set(naive, n + 1);
        return naive;
      }
    }
    const real = optimalTour(walk.roads, walk.at, rest, map.home)?.path[1] ?? null;
    const open = walk.tappable().filter((n) => !walk.isBlocked(n));
    if (real === null || !this.rng.bool(this.policy.routeOptimality)) {
      return open.length > 0 ? this.rng.pick(open) : (real ?? map.home);
    }
    return real;
  }

  private floodStep(req: MapStepRequest): string | null {
    const { walk, trial } = req;
    if (trial.kind !== 'blocked_route') return null;
    // Head for the nearest flooded bridge and try to cross it.
    const bridges = trial.event.blockedEdges.map((k) => k.split('~') as [string, string]);
    for (const [a, b] of bridges) {
      if (walk.at === a || walk.at === b) {
        const other = walk.at === a ? b : a;
        if (!req.knownBlocked.has(other)) {
          this.floodTries += 1;
          return other;
        }
      }
    }
    let best: { node: string; cost: number } | null = null;
    for (const [a, b] of bridges) {
      for (const end of [a, b]) {
        const sp = shortestPath(walk.roads, walk.at, end);
        if (sp && sp.path.length > 1 && (!best || sp.cost < best.cost)) {
          best = { node: sp.path[1] as string, cost: sp.cost };
        }
      }
    }
    if (!best) {
      this.floodTries = this.policy.floodAttempts;
      return null;
    }
    return best.node;
  }

  async fork(req: ChoiceRequest): Promise<ChoiceAnswer<Branch>> {
    const { trial } = req;
    if (trial.kind !== 'fork_choice' && trial.kind !== 'practice') return { kind: 'timeout' };
    const f = trial.fork;
    let choice: Branch;
    if (f.reversed) {
      this.reversedSeen += 1;
      choice =
        this.reversedSeen <= this.policy.perseveration
          ? f.oldRuleOption
          : this.rng.bool(this.policy.forkAccuracy)
            ? f.ruleOption
            : f.oldRuleOption;
    } else {
      choice =
        trial.kind === 'practice' || this.rng.bool(this.policy.forkAccuracy)
          ? f.ruleOption
          : f.oldRuleOption;
    }
    return this.choose(
      req,
      choice,
      `branch:${choice}`,
      this.policy.choiceMs,
      choice === 'left' ? [0.3, 0.55] : [0.7, 0.55],
    );
  }

  async optional(req: ChoiceRequest): Promise<ChoiceAnswer<'take'>> {
    if (!this.rng.bool(this.policy.optionalTakeRate)) {
      const w = await this.waitInWindow(
        Number.POSITIVE_INFINITY,
        req.anchorMs,
        req.windowMs,
        req.signal,
      );
      return w === 'aborted' ? { kind: 'aborted' } : { kind: 'timeout' };
    }
    return this.choose(req, 'take', 'optional', this.policy.choiceMs * 1.6, [0.74, 0.58]);
  }

  async probe(req: ChoiceRequest): Promise<ChoiceAnswer<'safe' | 'risky'>> {
    const value = this.rng.bool(this.policy.probeRiskRate) ? 'risky' : 'safe';
    const trial = req.trial;
    const side =
      trial.kind === 'probe'
        ? value === 'safe'
          ? trial.safeSide
          : trial.safeSide === 'left'
            ? 'right'
            : 'left'
        : 'left';
    return this.choose(
      req,
      value,
      `probe:${value}`,
      Math.min(this.policy.choiceMs * 0.75, 900),
      side === 'left' ? [0.3, 0.6] : [0.7, 0.6],
    );
  }

  private async choose<C extends string>(
    req: ChoiceRequest,
    value: C,
    key: string,
    medianMs: number,
    at: readonly [number, number],
  ): Promise<ChoiceAnswer<C>> {
    const w = await this.waitInWindow(
      this.jitter(medianMs, 250),
      req.anchorMs,
      req.windowMs,
      req.signal,
    );
    if (w === 'aborted') return { kind: 'aborted' };
    if (w === 'timeout') return { kind: 'timeout' };
    this.feedback.touched(key);
    const tMs = this.clock.now();
    return {
      kind: 'choice',
      value,
      tMs,
      latencyMs: tMs - req.anchorMs,
      xy: this.touchAt(at[0], at[1]),
      tapCount: 1,
    };
  }

  async fuel(req: FuelRequest): Promise<FuelAnswer> {
    const { trial, endowment, signal } = req;
    let share = this.policy.contributeShare;
    if (this.lastPartner === 'free_rider') share *= 1 - this.policy.defectionDrop;
    if (this.lastPartner === 'error_prone') share *= 0.9;
    if (trial.kind === 'fuel_round') this.lastPartner = trial.round.partnerType;
    const target = Math.max(
      0,
      Math.min(endowment, Math.round(share * endowment + (this.rng.next() - 0.5))),
    );
    const revisions: { value: string; tMs: number }[] = [];
    let tokens = 0;
    let taps = 0;
    const timeout = (): FuelAnswer => ({
      kind: 'timeout',
      tokens,
      revisions,
      tMs: null,
      latencyMs: null,
      tapCount: taps,
      xy: null,
    });
    // Place bundles one by one (sometimes one too many, then take it back).
    const overshoot = target < endowment && this.rng.bool(0.25);
    const plan = [
      ...Array.from({ length: target + (overshoot ? 1 : 0) }, () => 1),
      ...(overshoot ? [-1] : []),
    ];
    for (const d of plan) {
      const w = await this.waitInWindow(this.jitter(420, 180), req.anchorMs, req.windowMs, signal);
      if (w === 'aborted') return { ...timeout(), kind: 'aborted' };
      if (w === 'timeout') return timeout();
      tokens += d;
      taps += 1;
      revisions.push({ value: `tokens_${tokens}`, tMs: this.clock.now() });
      this.feedback.touched(d > 0 ? 'fuel:bundle' : 'fuel:trough');
      this.feedback.fuelChanged(tokens);
    }
    const w = await this.waitInWindow(this.jitter(650, 250), req.anchorMs, req.windowMs, signal);
    if (w === 'aborted') return { ...timeout(), kind: 'aborted' };
    if (w === 'timeout') return timeout();
    this.feedback.touched('fuel:confirm');
    const tMs = this.clock.now();
    return {
      kind: 'confirm',
      tokens,
      revisions,
      tMs,
      latencyMs: tMs - req.anchorMs,
      tapCount: taps + 1,
      xy: this.touchAt(0.82, 0.8),
    };
  }

  async effort(req: EffortRequest): Promise<EffortAnswer> {
    const { requiredMs, signal } = req;
    const holds: HoldRecord[] = [];
    const complete = this.rng.bool(this.policy.holdCompletion);
    const attempts = complete ? (this.rng.bool(0.2) ? 2 : 1) : 1;
    for (let i = 0; i < attempts; i += 1) {
      const w = await this.waitInWindow(this.jitter(700, 250), req.anchorMs, req.windowMs, signal);
      if (w === 'aborted') return { kind: 'aborted', holds, completed: false };
      if (w === 'timeout') break;
      const last = i === attempts - 1;
      const holdMs =
        last && complete
          ? requiredMs + this.rng.int(60, 260)
          : requiredMs * (0.25 + 0.5 * this.rng.next());
      const startMs = this.clock.now();
      this.feedback.touched('effort');
      const steps = Math.max(1, Math.round(holdMs / 120));
      for (let k = 1; k <= steps; k += 1) {
        if (!(await this.wait(holdMs / steps, signal)))
          return { kind: 'aborted', holds, completed: false };
        this.feedback.effortProgress(Math.min(1, (holdMs * k) / steps / requiredMs));
      }
      this.feedback.effortProgress(null);
      holds.push({ startMs, holdMs, completed: holdMs >= requiredMs });
    }
    const completed = holds.some((h) => h.completed);
    return { kind: holds.length > 0 ? 'held' : 'timeout', holds, completed };
  }
}
