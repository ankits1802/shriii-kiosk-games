/**
 * Route planning on a pictured village map (EPI-03 Road Home): weighted road graph, fuel budget,
 * blocked roads, shortest paths, optimal errand tours, errand-order efficiency and revisits.
 *
 * - Roads are undirected edges with an integer fuel cost (pictured fuel drops; the fuel gauge is a
 *   needle, never digits). The cart starts at the market (`start`), must visit every errand node
 *   (any order) and finish at `home` (a different node).
 * - Shortest paths: Dijkstra with deterministic tie-breaking (lexicographic node ids).
 * - Optimal tour: exhaustive over errand orders (errands <= 7) on all-pairs shortest-path costs, so
 *   the optimum is exact. Errands complete on first arrival, so `optimal_order` is the completion
 *   order REALISED along an optimal path (lexicographically smallest); all realised optimal orders
 *   are exposed.
 * - Maps are generated from a seeded rng on a jittered grid (planar roads: only grid-neighbour
 *   edges), with node count and fuel from the level table (`map_nodes`, `fuel_units`), and are
 *   solver-verified: the optimal tour fits the fuel budget, and (when required) some road on the
 *   optimal route can be blocked mid-route while the replanned tour still fits (EPI-03 AC).
 * - {@link RouteWalk} validates and records steps (`route_step` payloads), including attempts down a
 *   blocked road (`blocked: true`, no fuel spent, no movement), errand completions and revisits
 *   counted exactly like the scorer (`errands.revisits`).
 */
import type { CalibrationLevel, GameConfig, RouteStepPayload } from '@shriii/contracts';
import type { SeededRng } from '../core/contracts.ts';
import {
  constraintNumber,
  constraintWindow,
  type IndicatorBinding,
  levenshtein,
  ParadigmConfigError,
  ParadigmStateError,
  requireTiming,
} from './common.ts';
import { ROUTE_DEFAULTS } from './content-defaults.ts';

const PARADIGM = 'route_planning';

export interface RouteEdge {
  readonly a: string;
  readonly b: string;
  readonly cost: number;
}

export interface Errand {
  readonly id: string;
  readonly node: string;
}

export interface RouteMap {
  readonly id: string;
  readonly nodes: readonly string[];
  /** Normalised positions for rendering (0..1). */
  readonly positions: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
  readonly edges: readonly RouteEdge[];
  readonly start: string;
  readonly home: string;
  readonly errands: readonly Errand[];
  readonly fuelBudget: number;
}

export function edgeKey(a: string, b: string): string {
  return a < b ? `${a}~${b}` : `${b}~${a}`;
}

/** Adjacency view of a map with an optional set of blocked edges. */
export class RouteGraph {
  private readonly source: Pick<RouteMap, 'nodes' | 'edges'>;
  private readonly adj = new Map<string, Map<string, number>>();
  readonly blocked: ReadonlySet<string>;

  constructor(map: Pick<RouteMap, 'nodes' | 'edges'>, blocked: Iterable<string> = []) {
    this.source = map;
    for (const n of map.nodes) this.adj.set(n, new Map());
    for (const e of map.edges) {
      if (!this.adj.has(e.a) || !this.adj.has(e.b) || e.a === e.b) {
        throw new ParadigmConfigError(
          PARADIGM,
          `edge ${e.a}-${e.b} references an unknown node or is a loop`,
        );
      }
      if (!Number.isInteger(e.cost) || e.cost < 1) {
        throw new ParadigmConfigError(PARADIGM, 'edge costs must be positive integers');
      }
      this.adj.get(e.a)?.set(e.b, e.cost);
      this.adj.get(e.b)?.set(e.a, e.cost);
    }
    this.blocked = new Set(blocked);
  }

  hasNode(n: string): boolean {
    return this.adj.has(n);
  }

  /** Cost of the road between `a` and `b`, or null when there is none. Ignores blocking. */
  roadCost(a: string, b: string): number | null {
    return this.adj.get(a)?.get(b) ?? null;
  }

  isBlocked(a: string, b: string): boolean {
    return this.blocked.has(edgeKey(a, b));
  }

  /** Open neighbours sorted by id. */
  neighbours(n: string): readonly (readonly [string, number])[] {
    const m = this.adj.get(n);
    if (!m) return [];
    return [...m.entries()]
      .filter(([v]) => !this.isBlocked(n, v))
      .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  }

  /** A new graph with additional blocked roads. */
  withBlocked(extra: Iterable<string>): RouteGraph {
    return new RouteGraph(this.source, [...this.blocked, ...extra]);
  }
}

/** Dijkstra shortest path (deterministic tie-break on node id). Null when unreachable. */
export function shortestPath(
  graph: RouteGraph,
  from: string,
  to: string,
): { readonly cost: number; readonly path: readonly string[] } | null {
  if (!graph.hasNode(from) || !graph.hasNode(to))
    throw new ParadigmConfigError(PARADIGM, `unknown node ${from} or ${to}`);
  const dist = new Map<string, number>([[from, 0]]);
  const prev = new Map<string, string>();
  const done = new Set<string>();
  for (;;) {
    let u: string | null = null;
    let best = Number.POSITIVE_INFINITY;
    for (const [n, d] of dist) {
      if (done.has(n)) continue;
      if (d < best || (d === best && u !== null && n < u)) {
        best = d;
        u = n;
      }
    }
    if (u === null) return null;
    if (u === to) break;
    done.add(u);
    for (const [v, c] of graph.neighbours(u)) {
      if (done.has(v)) continue;
      const nd = best + c;
      const cur = dist.get(v);
      if (cur === undefined || nd < cur || (nd === cur && u < (prev.get(v) ?? '￿'))) {
        dist.set(v, nd);
        prev.set(v, u);
      }
    }
  }
  const path: string[] = [to];
  let cur = to;
  while (cur !== from) {
    const p = prev.get(cur);
    if (p === undefined) return null;
    path.push(p);
    cur = p;
  }
  path.reverse();
  return { cost: dist.get(to) ?? 0, path };
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  const out: T[][] = [];
  items.forEach((x, i) => {
    for (const rest of permutations([...items.slice(0, i), ...items.slice(i + 1)]))
      out.push([x, ...rest]);
  });
  return out;
}

export interface TourSolution {
  readonly cost: number;
  /** Errand completion order realised along the chosen optimal path (lexicographically smallest). */
  readonly order: readonly string[];
  /** Every realised optimal completion order. */
  readonly optimalOrders: readonly (readonly string[])[];
  /** Node path of the chosen optimal tour (from `from` to home). */
  readonly path: readonly string[];
}

/**
 * Exact optimal tour from `from` through every errand in `remaining` to `home` on the open roads.
 * Null when some errand or home is unreachable.
 */
export function optimalTour(
  graph: RouteGraph,
  from: string,
  remaining: readonly Errand[],
  home: string,
): TourSolution | null {
  if (remaining.length > 7)
    throw new ParadigmConfigError(PARADIGM, 'at most 7 errands per map are supported');
  const points = [from, ...remaining.map((e) => e.node), home];
  const sp = new Map<string, { cost: number; path: readonly string[] } | null>();
  const get = (a: string, b: string): { cost: number; path: readonly string[] } | null => {
    const k = `${a}>${b}`;
    if (!sp.has(k)) sp.set(k, a === b ? { cost: 0, path: [a] } : shortestPath(graph, a, b));
    return sp.get(k) ?? null;
  };
  for (const a of points) for (const b of points) if (a !== b && get(a, b) === null) return null;
  let best = Number.POSITIVE_INFINITY;
  let orders: Errand[][] = [];
  for (const perm of permutations(remaining)) {
    let cost = 0;
    let at = from;
    for (const e of perm) {
      cost += get(at, e.node)?.cost ?? 0;
      at = e.node;
    }
    cost += get(at, home)?.cost ?? 0;
    if (cost < best) {
      best = cost;
      orders = [perm];
    } else if (cost === best) orders.push(perm);
  }
  // Realise each optimal permutation as a node path; an errand is completed on FIRST arrival, so a
  // path may complete errands in a different order than the permutation (passing through).
  const realise = (perm: readonly Errand[]): { order: string[]; path: string[] } => {
    const path: string[] = [from];
    let at = from;
    for (const e of perm) {
      path.push(...(get(at, e.node)?.path ?? []).slice(1));
      at = e.node;
    }
    path.push(...(get(at, home)?.path ?? []).slice(1));
    const order: string[] = [];
    for (const node of path.slice(1)) {
      for (const e of remaining) if (e.node === node && !order.includes(e.id)) order.push(e.id);
    }
    return { order, path };
  };
  const realised = orders
    .map(realise)
    .sort((x, y) =>
      x.order.join(',') < y.order.join(',') ? -1 : x.order.join(',') > y.order.join(',') ? 1 : 0,
    );
  const unique: string[][] = [];
  for (const r of realised)
    if (!unique.some((u) => u.join(',') === r.order.join(','))) unique.push(r.order);
  const chosen = realised[0] ?? { order: [], path: [from] };
  return { cost: best, order: chosen.order, optimalOrders: unique, path: chosen.path };
}

/* ------------------------------------------------------------------------------------------------
 * Map generation
 * ---------------------------------------------------------------------------------------------- */

export interface MapGenerationOptions {
  readonly id: string;
  readonly nodes: number;
  readonly errands: number;
  readonly fuelBudget: number;
  readonly edgeCostRange: readonly [number, number];
  readonly extraEdgeFraction: number;
  /** Require a mid-route blockable road (the blocked-road beat). */
  readonly requireBlockable: boolean;
  readonly maxAttempts: number;
}

/** Map options from the config level table (`map_nodes`, `fuel_units`) plus constraints/defaults. */
export function mapOptionsFromConfig(
  config: GameConfig,
  level: CalibrationLevel,
  id: string,
  requireBlockable: boolean,
): MapGenerationOptions {
  return {
    id,
    nodes: requireTiming(PARADIGM, config, level, 'map_nodes'),
    fuelBudget: requireTiming(PARADIGM, config, level, 'fuel_units'),
    errands: constraintNumber(config, 'errands_per_map') ?? ROUTE_DEFAULTS.errandsPerMap,
    edgeCostRange: constraintWindow(config, 'edge_cost_range') ?? ROUTE_DEFAULTS.edgeCostRange,
    extraEdgeFraction: ROUTE_DEFAULTS.extraEdgeFraction,
    requireBlockable,
    maxAttempts: ROUTE_DEFAULTS.maxAttempts,
  };
}

/** A road on the optimal route whose blocking keeps the map solvable within the remaining fuel. */
export interface BlockCandidate {
  readonly edge: string;
  readonly a: string;
  readonly b: string;
  /** Optimal remaining tour cost after blocking, from the node before the block. */
  readonly postBlockOptimalCost: number;
}

/**
 * Candidate roads to block when the cart stands at `at` with `remaining` errands and `fuelLeft`:
 * roads on the current optimal path whose removal keeps a tour within the fuel left.
 */
export function blockCandidates(
  graph: RouteGraph,
  at: string,
  remaining: readonly Errand[],
  home: string,
  fuelLeft: number,
): BlockCandidate[] {
  const tour = optimalTour(graph, at, remaining, home);
  if (!tour) return [];
  const out: BlockCandidate[] = [];
  const seen = new Set<string>();
  for (let i = 0; i + 1 < tour.path.length; i += 1) {
    const a = tour.path[i] as string;
    const b = tour.path[i + 1] as string;
    const k = edgeKey(a, b);
    if (seen.has(k)) continue;
    seen.add(k);
    const after = optimalTour(graph.withBlocked([k]), at, remaining, home);
    if (after && after.cost <= fuelLeft) {
      out.push({ edge: k, a, b, postBlockOptimalCost: after.cost });
    }
  }
  return out;
}

/** Generate a solver-verified map. Throws (fail closed) when no valid map is found. */
export function generateRouteMap(options: MapGenerationOptions, rng: SeededRng): RouteMap {
  const { nodes: n, errands: k, fuelBudget } = options;
  if (!Number.isInteger(n) || n < k + 3) {
    throw new ParadigmConfigError(PARADIGM, `need at least ${k + 3} nodes, got ${n}`);
  }
  const [cLo, cHi] = options.edgeCostRange;
  if (!(Number.isInteger(cLo) && Number.isInteger(cHi) && cLo >= 1 && cHi >= cLo)) {
    throw new ParadigmConfigError(PARADIGM, 'edge cost range must be positive integers');
  }
  for (let attempt = 0; attempt < options.maxAttempts; attempt += 1) {
    const r = rng.stream(`attempt.${attempt}`);
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const cells: [number, number][] = [];
    for (let y = 0; y < rows; y += 1) for (let x = 0; x < cols; x += 1) cells.push([x, y]);
    const chosen = r
      .shuffle(cells)
      .slice(0, n)
      .sort((p, q) => p[1] - q[1] || p[0] - q[0]);
    const ids = chosen.map((_, i) => `node_${i}`);
    const cellId = new Map(chosen.map((c, i) => [`${c[0]},${c[1]}`, ids[i] as string]));
    const positions: Record<string, { x: number; y: number }> = {};
    chosen.forEach(([x, y], i) => {
      positions[ids[i] as string] = {
        x: (x + 0.5 + (r.next() - 0.5) * 0.4) / cols,
        y: (y + 0.5 + (r.next() - 0.5) * 0.4) / rows,
      };
    });
    // Candidate roads: 4-neighbour grid adjacency (planar).
    const candidates: [string, string][] = [];
    for (const [x, y] of chosen) {
      const a = cellId.get(`${x},${y}`) as string;
      for (const [dx, dy] of [
        [1, 0],
        [0, 1],
      ] as const) {
        const b = cellId.get(`${x + dx},${y + dy}`);
        if (b) candidates.push([a, b]);
      }
    }
    // Random spanning tree (Kruskal on shuffled candidates) + extra roads.
    const parent = new Map(ids.map((id) => [id, id]));
    const find = (x: string): string => {
      let c = x;
      while (parent.get(c) !== c) c = parent.get(c) as string;
      return c;
    };
    const shuffled = r.shuffle(candidates);
    const edges: RouteEdge[] = [];
    const rest: [string, string][] = [];
    for (const [a, b] of shuffled) {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) {
        parent.set(ra, rb);
        edges.push({ a, b, cost: r.int(cLo, cHi) });
      } else rest.push([a, b]);
    }
    if (edges.length !== n - 1) continue; // disconnected grid placement
    for (const [a, b] of rest.slice(0, Math.round(n * options.extraEdgeFraction))) {
      edges.push({ a, b, cost: r.int(cLo, cHi) });
    }
    const order = r.shuffle(ids);
    const start = order[0] as string;
    const home = order[1] as string;
    const errandNodes = order.slice(2, 2 + k);
    const map: RouteMap = {
      id: options.id,
      nodes: ids,
      positions,
      edges,
      start,
      home,
      errands: errandNodes.map((node, i) => ({ id: `errand_${i}`, node })),
      fuelBudget,
    };
    const graph = new RouteGraph(map);
    const tour = optimalTour(graph, map.start, map.errands, map.home);
    if (!tour || tour.cost > fuelBudget) continue;
    if (options.requireBlockable) {
      const first = tour.path[1];
      if (first === undefined) continue;
      // Blockable after the first step on the optimal route (mid-route).
      const fuelLeft = fuelBudget - (graph.roadCost(map.start, first) ?? 0);
      const remaining = map.errands.filter((e) => e.node !== first);
      if (blockCandidates(graph, first, remaining, map.home, fuelLeft).length === 0) continue;
    }
    return map;
  }
  throw new ParadigmConfigError(PARADIGM, `no solvable map after ${options.maxAttempts} attempts`);
}

/** Solver facts for a map (scoring params `optimal_order`, `optimal_cost`, `optimal_fuel`, `n_errands`). */
export function mapSolverParams(map: RouteMap): Record<string, unknown> {
  const tour = optimalTour(new RouteGraph(map), map.start, map.errands, map.home);
  if (!tour) throw new ParadigmConfigError(PARADIGM, `map ${map.id} is not solvable`);
  if (tour.cost > map.fuelBudget)
    throw new ParadigmConfigError(PARADIGM, `map ${map.id} exceeds its fuel budget`);
  return {
    map_id: map.id,
    optimal_order: [...tour.order],
    optimal_cost: tour.cost,
    optimal_fuel: tour.cost,
    n_errands: map.errands.length,
    fuel_budget: map.fuelBudget,
  };
}

/* ------------------------------------------------------------------------------------------------
 * Walking a map
 * ---------------------------------------------------------------------------------------------- */

export type StepRejection = 'not_adjacent' | 'insufficient_fuel' | 'finished' | 'unknown_node';

export type StepResult =
  | { readonly ok: true; readonly payload: RouteStepPayload; readonly tMs: number }
  | { readonly ok: false; readonly reason: StepRejection };

export interface WalkSummary {
  readonly mapId: string;
  readonly finished: boolean;
  readonly costUsed: number;
  readonly fuelLeft: number;
  readonly errandOrder: readonly string[];
  readonly revisits: number;
  readonly blockedAttempts: number;
  /** 1 - normalised edit distance to the solver's optimal order (scorer `errands.order_edit_distance`). */
  readonly orderEfficiency: number;
  /** (cost - optimum) / optimum over the moves made (meaningful when finished). */
  readonly excessCostRatio: number;
  /** Time from map onset to the first step (planning time); null when no step. */
  readonly planningTimeMs: number | null;
}

/** Live walk on one map. */
export class RouteWalk {
  readonly map: RouteMap;
  readonly onsetMs: number;
  private graph: RouteGraph;
  private position: string;
  private fuel: number;
  private readonly done = new Set<string>();
  private readonly order: string[] = [];
  private readonly steps: { payload: RouteStepPayload; tMs: number }[] = [];
  private readonly optimal: TourSolution;

  constructor(map: RouteMap, onsetMs: number) {
    this.map = map;
    this.onsetMs = onsetMs;
    this.graph = new RouteGraph(map);
    this.position = map.start;
    this.fuel = map.fuelBudget;
    const tour = optimalTour(this.graph, map.start, map.errands, map.home);
    if (!tour) throw new ParadigmConfigError(PARADIGM, `map ${map.id} is not solvable`);
    this.optimal = tour;
  }

  get at(): string {
    return this.position;
  }

  get fuelLeft(): number {
    return this.fuel;
  }

  get remainingErrands(): readonly Errand[] {
    return this.map.errands.filter((e) => !this.done.has(e.id));
  }

  get finished(): boolean {
    return this.remainingErrands.length === 0 && this.position === this.map.home;
  }

  /** Block a road (the blocked-road beat). Returns the replanned optimum from the current node. */
  block(edge: string): { readonly postBlockOptimalCost: number | null } {
    this.graph = this.graph.withBlocked([edge]);
    const t = optimalTour(this.graph, this.position, this.remainingErrands, this.map.home);
    return { postBlockOptimalCost: t ? t.cost : null };
  }

  /** Try to move to an adjacent node. A blocked road is logged as an attempt without movement. */
  step(to: string, tMs: number): StepResult {
    if (this.finished) return { ok: false, reason: 'finished' };
    if (!this.graph.hasNode(to)) return { ok: false, reason: 'unknown_node' };
    const cost = this.graph.roadCost(this.position, to);
    if (cost === null) return { ok: false, reason: 'not_adjacent' };
    const blocked = this.graph.isBlocked(this.position, to);
    if (!blocked && cost > this.fuel) return { ok: false, reason: 'insufficient_fuel' };
    const from = this.position;
    let errand: string | null = null;
    if (!blocked) {
      this.fuel -= cost;
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
    return { ok: true, payload, tMs };
  }

  log(): readonly RouteStepPayload[] {
    return this.steps.map((s) => s.payload);
  }

  /** Revisits exactly as the scorer counts them (blocked attempts skipped). */
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

  summary(): WalkSummary {
    const used = this.map.fuelBudget - this.fuel;
    const opt = this.optimal.order;
    const denom = Math.max(opt.length, this.order.length, 1);
    const first = this.steps[0];
    return {
      mapId: this.map.id,
      finished: this.finished,
      costUsed: used,
      fuelLeft: this.fuel,
      errandOrder: [...this.order],
      revisits: this.revisits(),
      blockedAttempts: this.steps.filter((s) => s.payload.blocked).length,
      orderEfficiency: 1 - levenshtein(this.order, opt) / denom,
      excessCostRatio: this.optimal.cost > 0 ? (used - this.optimal.cost) / this.optimal.cost : 0,
      planningTimeMs: first ? first.tMs - this.onsetMs : null,
    };
  }
}

/** Follow the optimal tour (headless optimal bot; zero excess cost, efficiency 1, no revisits beyond the path). */
export function walkOptimal(walk: RouteWalk, startMs: number, stepMs: number): void {
  const tour = optimalTour(new RouteGraph(walk.map), walk.at, walk.remainingErrands, walk.map.home);
  if (!tour) throw new ParadigmStateError(PARADIGM, 'no tour from the current position');
  let t = startMs;
  for (const node of tour.path.slice(1)) {
    t += stepMs;
    const r = walk.step(node, t);
    if (!r.ok) throw new ParadigmStateError(PARADIGM, `optimal step rejected: ${r.reason}`);
  }
}

export const ROUTE_PLANNING_INDICATORS: readonly IndicatorBinding[] = [
  {
    moduleId: 'road_home',
    indicators: [
      'problem_solving.excess_route_cost',
      'problem_solving.replan_quality',
      'problem_solving.replan_latency',
      'task_organisation.errand_order_efficiency',
      'task_organisation.revisits',
      'task_organisation.idle_time',
      'task_organisation.resource_allocation_efficiency',
      'initiative.route_planning_time',
      'persistence.retries_on_blocked_route',
    ],
  },
];
