/**
 * Road Home village maps (EPI-03): solver-verified road graphs laid out on a jittered grid with a
 * river running between two grid rows. Roads that cross the river are bridges. Each map is a pure
 * function of (options, seeded rng), so the trial params the scorer joins (`optimal_order`,
 * `optimal_cost`, `post_block_optimal_cost`, ...) can be regenerated from the session seed.
 *
 * Three map kinds:
 * - errand maps: start at the market (top half), visit every errand (pictured on the errand chit),
 *   finish at home (bottom half); the optimal tour fits the fuel budget;
 * - fallen-tree maps: one errand; a road on the optimal route out of the market is blocked at onset
 *   and the replanned tour still fits the fuel (EPI-03 AC "replan possible");
 * - flooded-river maps: every bridge is flooded, so home cannot be reached by road (the hard,
 *   unsolvable routing puzzle). The only way across is the ferry at the ghat, offered through the
 *   "rest" option (fallback). The post-block optimum is the cheapest route via the ferry.
 *
 * Shortest paths and tours come from the shared paradigm core (`paradigms/route-planning.ts`).
 */
import type { SeededRng } from '../../core/contracts.ts';
import { ROUTE_DEFAULTS } from '../../paradigms/content-defaults.ts';
import {
  edgeKey,
  optimalTour,
  type RouteEdge,
  RouteGraph,
  type RouteMap,
  shortestPath,
} from '../../paradigms/route-planning.ts';
import { RoadHomeConfigError } from './settings.ts';

/** Picture shown at a node (art only; never a scoring input). */
export type PlaceKind =
  | 'market'
  | 'home'
  | 'potter'
  | 'vaidya'
  | 'well'
  | 'mill'
  | 'temple'
  | 'banyan'
  | 'hamlet'
  | 'haystacks'
  | 'grove'
  | 'pond'
  | 'tea_stall'
  | 'ghat'
  | 'landing';

/** Errand pictures in chit order (errand_0 .. errand_3). */
export const ERRAND_PLACES: readonly PlaceKind[] = ['potter', 'vaidya', 'well', 'mill'];

const FILLER_PLACES: readonly PlaceKind[] = [
  'banyan',
  'hamlet',
  'temple',
  'haystacks',
  'grove',
  'pond',
  'tea_stall',
  'hamlet',
  'banyan',
  'grove',
];

/** A road the ferry takes (fallback route on the flooded-river map). */
export interface FerryLink {
  readonly ghat: string;
  readonly landing: string;
  readonly cost: number;
}

/** A Road Home map: the paradigm route map plus the layout facts the art needs. */
export interface RoadMap extends RouteMap {
  readonly cols: number;
  readonly rows: number;
  /** The river runs between grid row `riverRow` and `riverRow + 1`. */
  readonly riverRow: number;
  readonly cells: Readonly<Record<string, { readonly col: number; readonly row: number }>>;
  readonly places: Readonly<Record<string, PlaceKind>>;
  /** Edge keys of roads that cross the river. */
  readonly bridges: readonly string[];
}

export type MapKind = 'errand' | 'fallen_tree' | 'flooded_river' | 'practice';

/** Solver facts per map kind (the scorer's `GameTrialSpec.params`). */
export interface MapSolution {
  readonly optimalCost: number;
  readonly optimalOrder: readonly string[];
  readonly optimalPath: readonly string[];
}

/** A blocked-road event (fallen tree or flood) on a map. */
export interface BlockedEvent {
  readonly kind: 'fallen_tree' | 'flooded_river';
  /** Roads blocked at onset. */
  readonly blockedEdges: readonly string[];
  /** Optimal remaining cost from the start after the block (via the ferry for the flood). */
  readonly postBlockOptimalCost: number;
  readonly postBlockPath: readonly string[];
  /** Ferry fallback (flood only). */
  readonly ferry: FerryLink | null;
}

export interface MapOptions {
  readonly id: string;
  readonly nodes: number;
  readonly errands: number;
  readonly fuelBudget: number;
  readonly edgeCostRange: readonly [number, number];
}

interface Skeleton {
  readonly ids: string[];
  readonly cols: number;
  readonly rows: number;
  readonly riverRow: number;
  readonly cells: Record<string, { col: number; row: number }>;
  readonly positions: Record<string, { x: number; y: number }>;
  readonly edges: RouteEdge[];
  readonly bridges: string[];
}

const MAX_ATTEMPTS = ROUTE_DEFAULTS.maxAttempts;

/** Grid skeleton: jittered cells, planar neighbour roads, a spanning tree plus extra roads. */
function skeleton(n: number, costRange: readonly [number, number], r: SeededRng): Skeleton | null {
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  if (rows < 2) return null;
  const riverRow = Math.floor((rows - 1) / 2);
  const all: [number, number][] = [];
  for (let y = 0; y < rows; y += 1) for (let x = 0; x < cols; x += 1) all.push([x, y]);
  const chosen = r
    .shuffle(all)
    .slice(0, n)
    .sort((p, q) => p[1] - q[1] || p[0] - q[0]);
  // Both banks need at least two places so the river is a real obstacle.
  const above = chosen.filter(([, y]) => y <= riverRow).length;
  if (above < 2 || n - above < 2) return null;
  const ids = chosen.map((_, i) => `node_${i}`);
  const byCell = new Map(chosen.map((c, i) => [`${c[0]},${c[1]}`, ids[i] as string]));
  const cells: Record<string, { col: number; row: number }> = {};
  const positions: Record<string, { x: number; y: number }> = {};
  chosen.forEach(([x, y], i) => {
    const id = ids[i] as string;
    cells[id] = { col: x, row: y };
    positions[id] = {
      x: (x + 0.5 + (r.next() - 0.5) * 0.34) / cols,
      y: (y + 0.5 + (r.next() - 0.5) * 0.3) / rows,
    };
  });
  const candidates: [string, string][] = [];
  for (const [x, y] of chosen) {
    const a = byCell.get(`${x},${y}`) as string;
    for (const [dx, dy] of [
      [1, 0],
      [0, 1],
    ] as const) {
      const b = byCell.get(`${x + dx},${y + dy}`);
      if (b) candidates.push([a, b]);
    }
  }
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (x: string): string => {
    let c = x;
    while (parent.get(c) !== c) c = parent.get(c) as string;
    return c;
  };
  const [lo, hi] = costRange;
  const edges: RouteEdge[] = [];
  const rest: [string, string][] = [];
  for (const [a, b] of r.shuffle(candidates)) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) {
      parent.set(ra, rb);
      edges.push({ a, b, cost: r.int(lo, hi) });
    } else rest.push([a, b]);
  }
  if (edges.length !== n - 1) return null;
  for (const [a, b] of rest.slice(0, Math.round(n * ROUTE_DEFAULTS.extraEdgeFraction))) {
    edges.push({ a, b, cost: r.int(lo, hi) });
  }
  const bridges = edges
    .filter((e) => {
      const ra = cells[e.a]?.row ?? 0;
      const rb = cells[e.b]?.row ?? 0;
      return Math.min(ra, rb) === riverRow && Math.max(ra, rb) === riverRow + 1;
    })
    .map((e) => edgeKey(e.a, e.b));
  return { ids, cols, rows, riverRow, cells, positions, edges, bridges };
}

function assignPlaces(
  sk: Skeleton,
  start: string,
  home: string,
  errandNodes: readonly string[],
  r: SeededRng,
  extra: Readonly<Record<string, PlaceKind>> = {},
): Record<string, PlaceKind> {
  const places: Record<string, PlaceKind> = {};
  const fillers = r.shuffle(FILLER_PLACES);
  let f = 0;
  for (const id of sk.ids) {
    if (id === start) places[id] = 'market';
    else if (id === home) places[id] = 'home';
    else if (extra[id]) places[id] = extra[id] as PlaceKind;
    else {
      const e = errandNodes.indexOf(id);
      places[id] =
        e >= 0 ? (ERRAND_PLACES[e] as PlaceKind) : (fillers[f++ % fillers.length] as PlaceKind);
    }
  }
  return places;
}

function bank(sk: Skeleton, id: string): 'north' | 'south' {
  return (sk.cells[id]?.row ?? 0) <= sk.riverRow ? 'north' : 'south';
}

function validateOptions(o: MapOptions, minErrands: number): void {
  if (!Number.isInteger(o.nodes) || o.nodes < o.errands + 4) {
    throw new RoadHomeConfigError(`map ${o.id}: ${o.nodes} nodes cannot hold ${o.errands} errands`);
  }
  if (o.errands < minErrands) throw new RoadHomeConfigError(`map ${o.id}: too few errands`);
  const [lo, hi] = o.edgeCostRange;
  if (!(Number.isInteger(lo) && Number.isInteger(hi) && lo >= 1 && hi >= lo)) {
    throw new RoadHomeConfigError('edge_cost_range must be positive integers');
  }
}

/** Errand map: market (north bank) -> every errand -> home (south bank), within the fuel budget. */
export function generateErrandMap(
  o: MapOptions,
  rng: SeededRng,
): { readonly map: RoadMap; readonly solution: MapSolution } {
  validateOptions(o, 1);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const r = rng.stream(`attempt.${attempt}`);
    const sk = skeleton(o.nodes, o.edgeCostRange, r);
    if (!sk) continue;
    const north = sk.ids.filter((id) => bank(sk, id) === 'north');
    const south = sk.ids.filter((id) => bank(sk, id) === 'south');
    const start = r.pick(north);
    const home = r.pick(south);
    const others = r.shuffle(sk.ids.filter((id) => id !== start && id !== home));
    const errandNodes = others.slice(0, o.errands);
    if (errandNodes.length < o.errands) continue;
    const map = finishMap(o, sk, start, home, errandNodes, r);
    const tour = optimalTour(new RouteGraph(map), start, map.errands, home);
    if (!tour || tour.cost > o.fuelBudget) continue;
    // Keep the puzzle meaningful: the optimal route must not be the only sensible one.
    if (tour.path.length < 4) continue;
    return {
      map,
      solution: { optimalCost: tour.cost, optimalOrder: tour.order, optimalPath: tour.path },
    };
  }
  throw new RoadHomeConfigError(`no solvable errand map for ${o.id}`);
}

function finishMap(
  o: MapOptions,
  sk: Skeleton,
  start: string,
  home: string,
  errandNodes: readonly string[],
  r: SeededRng,
  extra: Readonly<Record<string, PlaceKind>> = {},
): RoadMap {
  return {
    id: o.id,
    nodes: sk.ids,
    positions: sk.positions,
    edges: sk.edges,
    start,
    home,
    errands: errandNodes.map((node, i) => ({ id: `errand_${i}`, node })),
    fuelBudget: o.fuelBudget,
    cols: sk.cols,
    rows: sk.rows,
    riverRow: sk.riverRow,
    cells: sk.cells,
    places: assignPlaces(sk, start, home, errandNodes, r, extra),
    bridges: sk.bridges,
  };
}

/**
 * Fallen-tree map: like an errand map with `o.errands` errands, plus a blocked road on the optimal
 * route out of the market whose detour still fits the fuel budget. Bridges are never the blocked
 * road (a tree falls across a dirt road).
 */
export function generateFallenTreeMap(
  o: MapOptions,
  rng: SeededRng,
): { readonly map: RoadMap; readonly solution: MapSolution; readonly event: BlockedEvent } {
  validateOptions(o, 1);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const r = rng.stream(`attempt.${attempt}`);
    const sk = skeleton(o.nodes, o.edgeCostRange, r);
    if (!sk) continue;
    const north = sk.ids.filter((id) => bank(sk, id) === 'north');
    const south = sk.ids.filter((id) => bank(sk, id) === 'south');
    const start = r.pick(north);
    const home = r.pick(south);
    const others = r.shuffle(sk.ids.filter((id) => id !== start && id !== home));
    const errandNodes = others.slice(0, o.errands);
    const map = finishMap(o, sk, start, home, errandNodes, r);
    const graph = new RouteGraph(map);
    const tour = optimalTour(graph, start, map.errands, home);
    if (!tour || tour.cost > o.fuelBudget) continue;
    // Block the first non-bridge road of the optimal route (the tree falls just ahead of the cart).
    let chosen: { edge: string; after: NonNullable<ReturnType<typeof optimalTour>> } | null = null;
    for (let i = 0; i + 1 < tour.path.length && i < 2 && !chosen; i += 1) {
      const k = edgeKey(tour.path[i] as string, tour.path[i + 1] as string);
      if (sk.bridges.includes(k)) continue;
      const after = optimalTour(graph.withBlocked([k]), start, map.errands, home);
      // The detour must cost more than the original (a real replan) and fit the fuel.
      if (after && after.cost <= o.fuelBudget && after.cost > tour.cost)
        chosen = { edge: k, after };
    }
    if (!chosen) continue;
    return {
      map,
      solution: { optimalCost: tour.cost, optimalOrder: tour.order, optimalPath: tour.path },
      event: {
        kind: 'fallen_tree',
        blockedEdges: [chosen.edge],
        postBlockOptimalCost: chosen.after.cost,
        postBlockPath: chosen.after.path,
        ferry: null,
      },
    };
  }
  throw new RoadHomeConfigError(`no fallen-tree map for ${o.id}`);
}

/** Graph used once the ferry is offered: every bridge flooded plus the ferry crossing. */
export function ferryGraph(map: RoadMap, event: BlockedEvent): RouteGraph {
  if (!event.ferry) return new RouteGraph(map, event.blockedEdges);
  return new RouteGraph(
    {
      nodes: map.nodes,
      edges: [
        ...map.edges,
        { a: event.ferry.ghat, b: event.ferry.landing, cost: event.ferry.cost },
      ],
    },
    event.blockedEdges,
  );
}

/** Cheapest fallback route from `from` to home via the ferry (null when unreachable). */
export function fallbackRoute(
  map: RoadMap,
  event: BlockedEvent,
  from: string,
): { readonly cost: number; readonly path: readonly string[] } | null {
  if (!event.ferry) return null;
  return shortestPath(ferryGraph(map, event), from, map.home);
}

/**
 * Flooded-river map: market on the north bank, home on the south bank, every bridge flooded, no
 * errands. The ferry joins a north-bank ghat to a south-bank landing; the fallback route (market ->
 * ghat -> ferry -> landing -> home) fits the fuel budget. Home is unreachable by road (verified).
 */
export function generateFloodMap(
  o: MapOptions,
  rng: SeededRng,
): { readonly map: RoadMap; readonly solution: MapSolution; readonly event: BlockedEvent } {
  validateOptions(o, 0);
  const [lo, hi] = o.edgeCostRange;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const r = rng.stream(`attempt.${attempt}`);
    const sk = skeleton(o.nodes, o.edgeCostRange, r);
    if (!sk || sk.bridges.length < 2) continue;
    const northRiver = sk.ids.filter((id) => sk.cells[id]?.row === sk.riverRow);
    const southRiver = sk.ids.filter((id) => sk.cells[id]?.row === sk.riverRow + 1);
    const north = sk.ids.filter((id) => bank(sk, id) === 'north');
    const south = sk.ids.filter((id) => bank(sk, id) === 'south');
    if (northRiver.length === 0 || southRiver.length === 0) continue;
    // Ferry: a ghat on the north bank with a landing straight across (no bridge already there).
    // Prefer a straight crossing; allow a diagonal one when every straight crossing has a bridge.
    const pairs: [string, string][] = [];
    for (const maxDc of [0, 1]) {
      for (const g of northRiver) {
        for (const l of southRiver) {
          const dc = Math.abs((sk.cells[g]?.col ?? 0) - (sk.cells[l]?.col ?? 0));
          if (dc <= maxDc && !sk.bridges.includes(edgeKey(g, l))) pairs.push([g, l]);
        }
      }
      if (pairs.length > 0) break;
    }
    if (pairs.length === 0) continue;
    const [ghat, landing] = r.pick(pairs);
    const startPool = north.filter((id) => id !== ghat);
    const homePool = south.filter((id) => id !== landing);
    if (startPool.length === 0 || homePool.length === 0) continue;
    const start = r.pick(startPool);
    const home = r.pick(homePool);
    const map = finishMap(o, sk, start, home, [], r, { [ghat]: 'ghat', [landing]: 'landing' });
    const flooded = [...sk.bridges];
    // Unsolvable by road: home unreachable with every bridge flooded.
    if (shortestPath(new RouteGraph(map, flooded), start, home) !== null) continue;
    // Reachable by road before the flood (the usual way home exists, so the puzzle looks solvable).
    if (shortestPath(new RouteGraph(map), start, home) === null) continue;
    const event0: BlockedEvent = {
      kind: 'flooded_river',
      blockedEdges: flooded,
      postBlockOptimalCost: 0,
      postBlockPath: [],
      ferry: { ghat, landing, cost: r.int(lo, hi) },
    };
    const fb = fallbackRoute(map, event0, start);
    if (!fb || fb.cost > o.fuelBudget || fb.path.length < 3) continue;
    const before = shortestPath(new RouteGraph(map), start, home);
    return {
      map,
      solution: {
        optimalCost: before?.cost ?? fb.cost,
        optimalOrder: [],
        optimalPath: before?.path ?? fb.path,
      },
      event: { ...event0, postBlockOptimalCost: fb.cost, postBlockPath: fb.path },
    };
  }
  throw new RoadHomeConfigError(`no flood map for ${o.id}`);
}

/** Tiny practice map: the market and the first crossroads (one tap), where the practice fork waits. */
export function practiceMap(id: string, fuelBudget: number): RoadMap {
  const ids = ['node_0', 'node_1'];
  return {
    id,
    nodes: ids,
    positions: { node_0: { x: 0.3, y: 0.56 }, node_1: { x: 0.7, y: 0.46 } },
    edges: [{ a: 'node_0', b: 'node_1', cost: 1 }],
    start: 'node_0',
    home: 'node_1',
    errands: [],
    fuelBudget,
    cols: 2,
    rows: 1,
    riverRow: -1,
    cells: { node_0: { col: 0, row: 0 }, node_1: { col: 1, row: 0 } },
    places: { node_0: 'market', node_1: 'banyan' },
    bridges: [],
  };
}

/** Compact serialisable layout for trial params (replay and research visualisation). */
export function mapLayoutParams(map: RoadMap): Record<string, unknown> {
  return {
    nodes: map.nodes,
    edges: map.edges.map((e) => [e.a, e.b, e.cost]),
    start: map.start,
    home: map.home,
    errands: map.errands.map((e) => [e.id, e.node]),
    cells: map.nodes.map((n) => [map.cells[n]?.col ?? 0, map.cells[n]?.row ?? 0]),
    river_row: map.riverRow,
    bridges: map.bridges,
  };
}
