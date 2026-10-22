/**
 * A cart's walk over one Road Home map: validates taps on waypoints, records `route_step` payloads
 * exactly as the scorer reads them (`errands.*`, `route.*` in `stats/scoring`), and tracks the
 * pictured fodder (fuel).
 *
 * Differences from the paradigm core's `RouteWalk` (kept here because they are episode rules):
 * - Reserve fodder: when the bundles run out the partner tops the cart up from the shared sack, so a
 *   wasteful route never strands the player. The step is still logged with its full `cost_units`
 *   (efficiency indicators sum costs), and `fuel_after_units` floors at 0; reserve use is counted.
 * - Blocked roads: a tap across a blocked road is an attempt (`blocked: true`, no movement, no fuel);
 *   these are the retries of `persistence.retries_on_blocked_route`.
 * - Ferry: on the flooded-river map the fallback adds the ferry crossing once the player rests.
 */
import type { RouteStepPayload } from '@shriii/contracts';
import { levenshtein } from '../../paradigms/common.ts';
import { edgeKey, type RouteGraph } from '../../paradigms/route-planning.ts';
import type { RoadMap } from './maps.ts';

export type StepRejection = 'not_adjacent' | 'finished' | 'unknown_node' | 'same_node';

export type StepOutcome =
  | {
      readonly ok: true;
      readonly payload: RouteStepPayload;
      readonly tMs: number;
      /** The cart moved (false for a blocked attempt). */
      readonly moved: boolean;
      /** Reserve fodder was needed for this step. */
      readonly reserve: boolean;
    }
  | { readonly ok: false; readonly reason: StepRejection };

export interface WalkSummary {
  readonly finished: boolean;
  readonly costUsed: number;
  readonly fuelLeft: number;
  readonly reserveUnits: number;
  readonly errandOrder: readonly string[];
  readonly revisits: number;
  readonly blockedAttempts: number;
  readonly steps: number;
  readonly orderEfficiency: number;
  readonly planningTimeMs: number | null;
}

export class EpisodeWalk {
  readonly map: RoadMap;
  readonly onsetMs: number;
  private graph: RouteGraph;
  private position: string;
  private fuel: number;
  private reserve = 0;
  private readonly done = new Set<string>();
  private readonly order: string[] = [];
  private readonly steps: { payload: RouteStepPayload; tMs: number }[] = [];
  private readonly optimalOrder: readonly string[];

  constructor(
    map: RoadMap,
    graph: RouteGraph,
    onsetMs: number,
    options: { readonly optimalOrder?: readonly string[]; readonly start?: string } = {},
  ) {
    this.map = map;
    this.graph = graph;
    this.onsetMs = onsetMs;
    this.position = options.start ?? map.start;
    this.fuel = map.fuelBudget;
    this.optimalOrder = options.optimalOrder ?? [];
  }

  get at(): string {
    return this.position;
  }

  get fuelLeft(): number {
    return this.fuel;
  }

  get reserveUnits(): number {
    return this.reserve;
  }

  get stepCount(): number {
    return this.steps.length;
  }

  get remainingErrands(): readonly { readonly id: string; readonly node: string }[] {
    return this.map.errands.filter((e) => !this.done.has(e.id));
  }

  get completedErrands(): readonly string[] {
    return this.order;
  }

  get finished(): boolean {
    return this.remainingErrands.length === 0 && this.position === this.map.home;
  }

  /** Current road graph (blocked roads applied). */
  get roads(): RouteGraph {
    return this.graph;
  }

  /** Replace the road graph (e.g. the ferry becomes available). */
  setGraph(graph: RouteGraph): void {
    this.graph = graph;
  }

  /** Neighbours reachable by a single tap from the current node (blocked roads included). */
  tappable(): readonly string[] {
    const out: string[] = [];
    for (const n of this.map.nodes) {
      if (n === this.position) continue;
      if (this.graph.roadCost(this.position, n) !== null) out.push(n);
    }
    return out;
  }

  isBlocked(to: string): boolean {
    return this.graph.isBlocked(this.position, to);
  }

  /** Try to move to `to` at session time `tMs`. */
  step(to: string, tMs: number): StepOutcome {
    if (this.finished) return { ok: false, reason: 'finished' };
    if (!this.graph.hasNode(to)) return { ok: false, reason: 'unknown_node' };
    if (to === this.position) return { ok: false, reason: 'same_node' };
    const cost = this.graph.roadCost(this.position, to);
    if (cost === null) return { ok: false, reason: 'not_adjacent' };
    const blocked = this.graph.isBlocked(this.position, to);
    const from = this.position;
    let errand: string | null = null;
    let reserve = false;
    if (!blocked) {
      if (cost > this.fuel) {
        reserve = true;
        this.reserve += cost - this.fuel;
        this.fuel = 0;
      } else {
        this.fuel -= cost;
      }
      this.position = to;
      const e = this.map.errands.find((x) => x.node === to && !this.done.has(x.id));
      if (e) {
        this.done.add(e.id);
        this.order.push(e.id);
        errand = e.id;
      }
    }
    const payload: RouteStepPayload = {
      map_id: this.map.id,
      from_node: from,
      to_node: to,
      step_index: this.steps.length,
      cost_units: blocked ? 0 : cost,
      fuel_after_units: this.fuel,
      blocked,
      errand_completed: errand,
    };
    this.steps.push({ payload, tMs });
    return { ok: true, payload, tMs, moved: !blocked, reserve };
  }

  log(): readonly RouteStepPayload[] {
    return this.steps.map((s) => s.payload);
  }

  stepTimes(): readonly number[] {
    return this.steps.map((s) => s.tMs);
  }

  /** Revisits counted exactly like the scorer's `errands.revisits` (blocked attempts skipped). */
  revisits(): number {
    const visited = new Set<string>();
    let count = 0;
    for (const { payload: s } of this.steps) {
      if (visited.size === 0) visited.add(s.from_node);
      if (s.blocked) continue;
      if (visited.has(s.to_node)) count += 1;
      visited.add(s.to_node);
    }
    return count;
  }

  /** Non-blocked fuel units spent (the scorer's route cost). */
  costUsed(): number {
    return this.steps.reduce((a, s) => a + (s.payload.blocked ? 0 : s.payload.cost_units), 0);
  }

  summary(): WalkSummary {
    const first = this.steps[0];
    const denom = Math.max(this.optimalOrder.length, this.order.length, 1);
    return {
      finished: this.finished,
      costUsed: this.costUsed(),
      fuelLeft: this.fuel,
      reserveUnits: this.reserve,
      errandOrder: [...this.order],
      revisits: this.revisits(),
      blockedAttempts: this.steps.filter((s) => s.payload.blocked).length,
      steps: this.steps.length,
      orderEfficiency: 1 - levenshtein(this.order, this.optimalOrder) / denom,
      planningTimeMs: first ? first.tMs - this.onsetMs : null,
    };
  }
}

/** True when the road between `a` and `b` is one of `edges` (edge keys). */
export function roadIn(edges: readonly string[], a: string, b: string): boolean {
  return edges.includes(edgeKey(a, b));
}
