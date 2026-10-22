import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createSessionRng } from '../../../engine/rng.ts';
import {
  edgeKey,
  optimalTour,
  RouteGraph,
  shortestPath,
} from '../../../paradigms/route-planning.ts';
import {
  fallbackRoute,
  ferryGraph,
  generateErrandMap,
  generateFallenTreeMap,
  generateFloodMap,
  type RoadMap,
} from '../maps.ts';
import { EpisodeWalk } from '../walk.ts';

const rng = (i: number) =>
  createSessionRng(
    ((BigInt(i + 3) * 0x9e3779b97f4a7c15n) % (1n << 64n)).toString(16).padStart(16, '0'),
  ).stream('maps');
const opts = (nodes: number, errands: number) => ({
  id: 'map_t',
  nodes,
  errands,
  fuelBudget: 12,
  edgeCostRange: [1, 3] as const,
});
const bank = (m: RoadMap, n: string): 'n' | 's' =>
  (m.cells[n]?.row ?? 0) <= m.riverRow ? 'n' : 's';

describe('Road Home maps (EPI-03, solver-verified)', { timeout: 60_000 }, () => {
  it('errand maps: market north, home south, optimal tour within the fodder budget', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 500 }), fc.constantFrom(9, 11, 13), (i, n) => {
        const { map, solution } = generateErrandMap(opts(n, 3), rng(i));
        expect(map.nodes).toHaveLength(n);
        expect(bank(map, map.start)).toBe('n');
        expect(bank(map, map.home)).toBe('s');
        expect(new Set(map.errands.map((e) => e.node)).size).toBe(3);
        const tour = optimalTour(new RouteGraph(map), map.start, map.errands, map.home);
        expect(tour?.cost).toBe(solution.optimalCost);
        expect(solution.optimalCost).toBeLessThanOrEqual(map.fuelBudget);
        for (const b of map.bridges) {
          const [a, c] = b.split('~') as [string, string];
          expect(bank(map, a)).not.toBe(bank(map, c));
        }
      }),
      { numRuns: 60 },
    );
  });

  it('fallen tree: a dirt road on the optimal route; the detour costs more but fits the fodder', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 500 }), fc.constantFrom(9, 11, 13), (i, n) => {
        const { map, solution, event } = generateFallenTreeMap(opts(n, 1), rng(i));
        expect(event.blockedEdges).toHaveLength(1);
        const k = event.blockedEdges[0] as string;
        expect(map.bridges).not.toContain(k);
        const path = solution.optimalPath;
        const onPath = path.some(
          (p, j) => j + 1 < path.length && edgeKey(p, path[j + 1] as string) === k,
        );
        expect(onPath).toBe(true);
        const after = optimalTour(
          new RouteGraph(map, event.blockedEdges),
          map.start,
          map.errands,
          map.home,
        );
        expect(after?.cost).toBe(event.postBlockOptimalCost);
        expect(event.postBlockOptimalCost).toBeGreaterThan(solution.optimalCost);
        expect(event.postBlockOptimalCost).toBeLessThanOrEqual(map.fuelBudget);
      }),
      { numRuns: 60 },
    );
  });

  it('flooded river: home unreachable by road; the ferry fallback reaches it within the fodder', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 500 }), fc.constantFrom(9, 11, 13), (i, n) => {
        const { map, event } = generateFloodMap(opts(n, 0), rng(i));
        expect(new Set(event.blockedEdges)).toEqual(new Set(map.bridges));
        expect(
          shortestPath(new RouteGraph(map, event.blockedEdges), map.start, map.home),
        ).toBeNull();
        expect(shortestPath(new RouteGraph(map), map.start, map.home)).not.toBeNull();
        const fb = fallbackRoute(map, event, map.start);
        expect(fb?.cost).toBe(event.postBlockOptimalCost);
        expect(event.postBlockOptimalCost).toBeLessThanOrEqual(map.fuelBudget);
        const ferry = event.ferry;
        if (!ferry || !fb) throw new Error('flood map without a ferry route');
        const crossing = edgeKey(ferry.ghat, ferry.landing);
        const usesFerry = fb.path.some(
          (p, j) => j + 1 < fb.path.length && edgeKey(p, fb.path[j + 1] as string) === crossing,
        );
        expect(usesFerry).toBe(true);
      }),
      { numRuns: 60 },
    );
  });

  it('walk: blocked attempts cost nothing; revisits match the scorer; reserve never strands', () => {
    const { map, event } = generateFallenTreeMap(opts(11, 1), rng(7));
    const blocked = new RouteGraph(map, event.blockedEdges);
    const walk = new EpisodeWalk(map, blocked, 0);
    const [a, b] = (event.blockedEdges[0] as string).split('~') as [string, string];
    const to = shortestPath(blocked, map.start, a);
    for (const n of (to?.path ?? []).slice(1)) walk.step(n, 1);
    const before = walk.fuelLeft;
    const r = walk.step(b, 2);
    expect(r.ok && !r.moved && r.payload.blocked && r.payload.cost_units === 0).toBe(true);
    expect(walk.fuelLeft).toBe(before);
    expect(walk.summary().blockedAttempts).toBe(1);
    expect(walk.isBlocked(b)).toBe(true);
    expect(walk.step('nowhere', 3)).toEqual({ ok: false, reason: 'unknown_node' });

    const g = new RouteGraph(map);
    const w2 = new EpisodeWalk(map, g, 0);
    const nb = g.neighbours(map.start)[0]?.[0] as string;
    for (let k = 0; k < 8; k += 1) w2.step(k % 2 ? map.start : nb, k);
    // Every step back onto a visited node is a revisit (first step is new).
    expect(w2.revisits()).toBe(7);
    const log = w2.log();
    expect(log.map((s) => s.step_index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(log.every((s) => s.fuel_after_units >= 0)).toBe(true);
    expect(w2.costUsed()).toBe(log.reduce((x, s) => x + s.cost_units, 0));
    // Wandering beyond the budget dips into the reserve but the cart keeps moving.
    for (let k = 0; k < 20; k += 1) w2.step(k % 2 ? map.start : nb, 10 + k);
    expect(w2.fuelLeft).toBe(0);
    expect(w2.reserveUnits).toBeGreaterThan(0);
    expect(w2.stepCount).toBe(28);
  });

  it('ferry graph adds exactly the ferry crossing and keeps the bridges flooded', () => {
    const { map, event } = generateFloodMap(opts(11, 0), rng(3));
    const g = ferryGraph(map, event);
    expect(g.roadCost(event.ferry?.ghat ?? '', event.ferry?.landing ?? '')).toBe(event.ferry?.cost);
    for (const k of event.blockedEdges) {
      const [x, y] = k.split('~') as [string, string];
      expect(g.isBlocked(x, y)).toBe(true);
    }
  });
});
