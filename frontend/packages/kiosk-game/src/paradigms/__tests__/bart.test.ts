import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { loadGameContent } from '../../engine/content.ts';
import {
  adjustedPumps,
  assertSupportedDistribution,
  BalloonTrial,
  buildExplosionTable,
  maxPumpsByColour,
  stratifiedExplosionPoints,
} from '../bart.ts';
import { ParadigmConfigError, ParadigmStateError } from '../common.ts';
import { rngFor } from './helpers.ts';

const content = loadGameContent();
const balloon = content.get('balloon');

describe('explosion schedules', () => {
  it('reads max pumps from the level table; the high-risk default is flagged', () => {
    const m = maxPumpsByColour(balloon, 'L2');
    expect(m.low_risk).toEqual({ value: 32, source: 'level_timing', key: 'max_pumps' });
    expect(m.high_risk.value).toBe(16);
    expect(m.high_risk.source).toBe('paradigm_default');
    expect(() => assertSupportedDistribution(balloon)).not.toThrow();
  });

  it('stratified points: one per stratum, within 1..max, deterministic by seed (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1e6 }),
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 1, max: 40 }),
        (seed, n, max) => {
          const a = stratifiedExplosionPoints(n, max, rngFor(seed));
          expect(stratifiedExplosionPoints(n, max, rngFor(seed))).toEqual(a);
          expect(a).toHaveLength(n);
          for (const p of a) {
            expect(p).toBeGreaterThanOrEqual(1);
            expect(p).toBeLessThanOrEqual(max);
          }
          if (n <= max) {
            const sorted = [...a].sort((x, y) => x - y);
            sorted.forEach((p, k) => {
              expect(p).toBeGreaterThanOrEqual(Math.floor((k * max) / n) + 1);
              expect(p).toBeLessThanOrEqual(Math.floor(((k + 1) * max) / n));
            });
          }
        },
      ),
      { numRuns: 400 },
    );
  });

  it('fixed seed table: exact stratum counts and a mean close to (max + 1) / 2 (MG-01 AC)', () => {
    for (let seed = 0; seed < 20; seed += 1) {
      const pts = stratifiedExplosionPoints(8, 32, rngFor(seed));
      const strataHits = new Array(8).fill(0);
      for (const p of pts) strataHits[Math.floor((p - 1) / 4)] += 1;
      expect(strataHits).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
      const mean = pts.reduce((a, b) => a + b, 0) / pts.length;
      expect(Math.abs(mean - 16.5)).toBeLessThanOrEqual(2);
    }
  });

  it('each balloon is marginally uniform on 1..max across seeds', () => {
    const counts = new Array(16).fill(0);
    const runs = 4000;
    for (let s = 0; s < runs; s += 1) {
      const pts = stratifiedExplosionPoints(4, 16, rngFor(s));
      counts[(pts[0] as number) - 1] += 1;
    }
    const expected = runs / 16;
    const chi2 = counts.reduce((a, c) => a + (c - expected) ** 2 / expected, 0);
    expect(chi2).toBeLessThan(37.7); // df=15, p=.001
  });

  it('balances colours and is deterministic', () => {
    const t = buildExplosionTable(16, { low_risk: 32, high_risk: 16 }, rngFor(3));
    expect(t.filter((b) => b.riskColour === 'low_risk')).toHaveLength(8);
    expect(buildExplosionTable(16, { low_risk: 32, high_risk: 16 }, rngFor(3))).toEqual(t);
    expect(() => buildExplosionTable(0, { low_risk: 32, high_risk: 16 }, rngFor(3))).toThrow(
      ParadigmConfigError,
    );
  });
});

describe('BalloonTrial', () => {
  it('explodes exactly on the explosion point and logs pump payloads', () => {
    const b = new BalloonTrial({
      index: 2,
      riskColour: 'high_risk',
      explosionPoint: 3,
      maxPumps: 16,
    });
    expect(b.pump(100).exploded).toBe(false);
    expect(b.lastPayload()).toEqual({
      balloon_index: 2,
      pump_index: 0,
      risk_colour: 'high_risk',
      exploded: false,
      collected: false,
    });
    b.pump(200);
    const r = b.pump(300);
    expect(r).toEqual({ pumpIndex: 2, exploded: true, pumps: 3 });
    expect(b.status).toBe('exploded');
    expect(b.banked()).toBe(0);
    expect(() => b.pump(400)).toThrow(ParadigmStateError);
    expect(() => b.collect(400)).toThrow(ParadigmStateError);
  });

  it('collect banks the pumps; adjusted pumps averages unexploded balloons only', () => {
    const a = new BalloonTrial({
      index: 0,
      riskColour: 'low_risk',
      explosionPoint: 10,
      maxPumps: 32,
    });
    for (let i = 0; i < 4; i += 1) a.pump(i);
    a.collect(10);
    expect(a.lastPayload()).toMatchObject({ collected: true, pump_index: 4 });
    expect(a.banked()).toBe(4);
    const c = new BalloonTrial({
      index: 1,
      riskColour: 'low_risk',
      explosionPoint: 2,
      maxPumps: 32,
    });
    c.pump(1);
    c.pump(2);
    const d = new BalloonTrial({
      index: 2,
      riskColour: 'low_risk',
      explosionPoint: 32,
      maxPumps: 32,
    });
    for (let i = 0; i < 8; i += 1) d.pump(i);
    d.collect(9);
    expect(adjustedPumps([a, c, d])).toBe(6);
    expect(adjustedPumps([c])).toBeNull();
  });

  it('never allows more than max pumps (explosion at max)', () => {
    const b = new BalloonTrial({
      index: 0,
      riskColour: 'low_risk',
      explosionPoint: 2,
      maxPumps: 2,
    });
    b.pump(0);
    expect(b.canPump).toBe(true);
    expect(b.pump(1).exploded).toBe(true);
    expect(b.canPump).toBe(false);
  });
});
