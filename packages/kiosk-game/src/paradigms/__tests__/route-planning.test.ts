import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { loadGameContent } from '../../engine/content.ts';
import { levenshtein } from '../common.ts';
import {
  blockCandidates,
  type Errand,
  edgeKey,
  generateRouteMap,
  mapOptionsFromConfig,
  mapSolverParams,
  optimalTour,
  type RouteEdge,
  RouteGraph,
  type RouteMap,
  RouteWalk,
  shortestPath,
  walkOptimal,
} from '../route-planning.ts';
import { rngFor } from './helpers.ts';

const content = loadGameContent();
const road = content.get('road_home');

/** Independent all-pairs shortest paths (Floyd-Warshall). */
function floyd(
  nodes: readonly string[],
  edges: readonly RouteEdge[],
  blocked: ReadonlySet<string>,
): Map<string, number> {
  const d = new Map<string, number>();
  const k = (a: string, b: string) => `${a}>${b}`;
  for (const a of nodes)
    for (const b of nodes) d.set(k(a, b), a === b ? 0 : Number.POSITIVE_INFINITY);
  for (const e of edges) {
    if (blocked.has(edgeKey(e.a, e.b))) continue;
    d.set(k(e.a, e.b), Math.min(d.get(k(e.a, e.b)) ?? Infinity, e.cost));
    d.set(k(e.b, e.a), Math.min(d.get(k(e.b, e.a)) ?? Infinity, e.cost));
  }
  for (const m of nodes)
    for (const a of nodes)
      for (const b of nodes) {
        const via = (d.get(k(a, m)) ?? Infinity) + (d.get(k(m, b)) ?? Infinity);
        if (via < (d.get(k(a, b)) ?? Infinity)) d.set(k(a, b), via);
      }
  return d;
}

/** Independent exact tour: shortest path over (node, visited-errand mask) states (Dijkstra on the product graph). */
function productTour(
  map: RouteMap,
  blocked: ReadonlySet<string>,
  from: string,
  remaining: readonly Errand[],
): number | null {
  const g = new RouteGraph(map, blocked);
  const idx = new Map(remaining.map((e, i) => [e.node, i]));
  const full = (1 << remaining.length) - 1;
  const startMask = idx.has(from) ? 1 << (idx.get(from) as number) : 0;
  const dist = new Map<string, number>([[`${from}|${startMask}`, 0]]);
  const done = new Set<string>();
  for (;;) {
    let best: string | null = null;
    let bd = Infinity;
    for (const [s, v] of dist) if (!done.has(s) && v < bd) [best, bd] = [s, v];
    if (best === null) return null;
    const [node, maskStr] = best.split('|') as [string, string];
    const mask = Number(maskStr);
    if (node === map.home && mask === full) return bd;
    done.add(best);
    for (const [v, c] of g.neighbours(node)) {
      const nm = idx.has(v) ? mask | (1 << (idx.get(v) as number)) : mask;
      const key = `${v}|${nm}`;
      if (bd + c < (dist.get(key) ?? Infinity)) dist.set(key, bd + c);
    }
  }
}

function mapForSeed(seed: number, level: 'L1' | 'L2' | 'L3' = 'L2'): RouteMap {
  return generateRouteMap(
    mapOptionsFromConfig(road, level, `road_home.map.${seed}`, true),
    rngFor(seed, 'map'),
  );
}

describe('shortest paths and tours', () => {
  it('Dijkstra equals Floyd-Warshall on generated maps with random blocks (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5000 }),
        fc.integer({ min: 0, max: 100 }),
        (seed, blockPick) => {
          const map = mapForSeed(seed);
          const e = map.edges[blockPick % map.edges.length] as RouteEdge;
          const blocked = new Set([edgeKey(e.a, e.b)]);
          const g = new RouteGraph(map, blocked);
          const fw = floyd(map.nodes, map.edges, blocked);
          for (const a of map.nodes.slice(0, 4)) {
            for (const b of map.nodes) {
              const sp = shortestPath(g, a, b);
              const ref = fw.get(`${a}>${b}`) ?? Infinity;
              if (ref === Infinity) expect(sp).toBeNull();
              else {
                expect(sp?.cost).toBe(ref);
                // The path is a valid walk of that cost on open roads.
                let cost = 0;
                const path = sp?.path ?? [];
                for (let i = 0; i + 1 < path.length; i += 1) {
                  expect(g.isBlocked(path[i] as string, path[i + 1] as string)).toBe(false);
                  cost += g.roadCost(path[i] as string, path[i + 1] as string) ?? Infinity;
                }
                expect(cost).toBe(ref);
              }
            }
          }
        },
      ),
      { numRuns: 60 },
    );
  });

  it('optimal tour equals an independent product-graph search (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5000 }), (seed) => {
        const map = mapForSeed(seed);
        const t = optimalTour(new RouteGraph(map), map.start, map.errands, map.home);
        expect(t).not.toBeNull();
        expect(t?.cost).toBe(productTour(map, new Set(), map.start, map.errands));
        expect(t?.optimalOrders).toContainEqual(t?.order);
      }),
      { numRuns: 60 },
    );
  });
});

describe('map generation', () => {
  it('every level gives solvable, blockable maps within fuel from the level table (200 seeds)', () => {
    for (const level of ['L1', 'L2', 'L3'] as const) {
      const nodes = road.levels[level].timing.map_nodes;
      const fuel = road.levels[level].timing.fuel_units;
      for (let s = 0; s < 200; s += 1) {
        const map = mapForSeed(s, level);
        expect(map.nodes).toHaveLength(nodes as number);
        expect(map.fuelBudget).toBe(fuel);
        expect(map.start).not.toBe(map.home);
        const p = mapSolverParams(map);
        expect(p.optimal_cost as number).toBeLessThanOrEqual(fuel as number);
        expect(p.n_errands).toBe(3);
      }
    }
  });

  it('is deterministic by seed', () => {
    expect(mapForSeed(42)).toEqual(mapForSeed(42));
    expect(mapForSeed(42)).not.toEqual(mapForSeed(43));
  });
});

describe('RouteWalk', () => {
  it('optimal bot: zero excess cost, order efficiency 1', () => {
    for (let s = 0; s < 50; s += 1) {
      const map = mapForSeed(s);
      const w = new RouteWalk(map, 0);
      walkOptimal(w, 2000, 1000);
      const sum = w.summary();
      expect(sum.finished).toBe(true);
      expect(sum.excessCostRatio).toBe(0);
      expect(sum.orderEfficiency).toBe(1);
      expect(sum.planningTimeMs).toBe(3000);
    }
  });

  it('blocked roads: attempt is logged without movement or fuel; replan stays within fuel', () => {
    const map = mapForSeed(7);
    const w = new RouteWalk(map, 0);
    const tour = optimalTour(new RouteGraph(map), map.start, map.errands, map.home);
    const first = tour?.path[1] as string;
    w.step(first, 1000);
    const cands = blockCandidates(
      new RouteGraph(map),
      w.at,
      w.remainingErrands,
      map.home,
      w.fuelLeft,
    );
    expect(cands.length).toBeGreaterThan(0);
    const c = cands[0];
    if (!c) throw new Error('no candidate');
    const { postBlockOptimalCost } = w.block(c.edge);
    expect(postBlockOptimalCost).toBe(c.postBlockOptimalCost);
    expect(postBlockOptimalCost as number).toBeLessThanOrEqual(w.fuelLeft);
    // Walk to one end of the blocked road and try it.
    const toA = shortestPath(new RouteGraph(map, [c.edge]), w.at, c.a);
    for (const n of toA?.path.slice(1) ?? []) w.step(n, 2000);
    const before = { at: w.at, fuel: w.fuelLeft };
    const r = w.step(c.b, 3000);
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.payload).toMatchObject({
        blocked: true,
        cost_units: 0,
        from_node: c.a,
        to_node: c.b,
      });
    expect({ at: w.at, fuel: w.fuelLeft }).toEqual(before);
    expect(w.summary().blockedAttempts).toBe(1);
  });

  it('rejects non-adjacent moves and counts revisits like the scorer', () => {
    const map: RouteMap = {
      id: 'tiny',
      nodes: ['a', 'b', 'c', 'd'],
      positions: { a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, c: { x: 1, y: 1 }, d: { x: 0, y: 1 } },
      edges: [
        { a: 'a', b: 'b', cost: 1 },
        { a: 'b', b: 'c', cost: 1 },
        { a: 'c', b: 'd', cost: 1 },
        { a: 'd', b: 'a', cost: 1 },
      ],
      start: 'a',
      home: 'd',
      errands: [
        { id: 'errand_0', node: 'b' },
        { id: 'errand_1', node: 'c' },
      ],
      fuelBudget: 10,
    };
    const w = new RouteWalk(map, 0);
    expect(w.step('c', 1)).toEqual({ ok: false, reason: 'not_adjacent' });
    w.step('b', 1);
    w.step('a', 2); // revisit of the start
    w.step('b', 3); // revisit
    w.step('c', 4);
    w.step('d', 5);
    const s = w.summary();
    expect(s.revisits).toBe(2);
    expect(s.finished).toBe(true);
    expect(s.costUsed).toBe(5);
    expect(s.excessCostRatio).toBeCloseTo((5 - 3) / 3, 12);
    expect(s.errandOrder).toEqual(['errand_0', 'errand_1']);
    expect(w.log().map((p) => p.step_index)).toEqual([0, 1, 2, 3, 4]);
    expect(w.step('c', 6)).toEqual({ ok: false, reason: 'finished' });
  });

  it('enforces the fuel budget and edit-distance efficiency', () => {
    const map: RouteMap = {
      id: 'fuel',
      nodes: ['a', 'b', 'c'],
      positions: { a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, c: { x: 2, y: 0 } },
      edges: [
        { a: 'a', b: 'b', cost: 2 },
        { a: 'b', b: 'c', cost: 2 },
      ],
      start: 'a',
      home: 'c',
      errands: [{ id: 'errand_0', node: 'b' }],
      fuelBudget: 4,
    };
    const w = new RouteWalk(map, 0);
    w.step('b', 1);
    w.step('a', 2);
    expect(w.step('b', 3)).toEqual({ ok: false, reason: 'insufficient_fuel' });
    expect(levenshtein(['x', 'y', 'z'], ['x', 'z', 'y'])).toBe(2);
  });
});
