import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '../../logging/hash.ts';
import {
  randomSeedHex,
  UUIDV7_PATTERN,
  Uuidv7Generator,
  uuidv7Timestamp,
} from '../../logging/uuid.ts';
import { createKeyedRng, createSessionRng, hash64, Pcg32Core, Pcg32Rng } from '../rng.ts';

const seedArb = fc
  .bigInt({ min: 0n, max: (1n << 64n) - 1n })
  .map((v) => v.toString(16).padStart(16, '0'));

describe('PCG32', () => {
  it('matches the reference pcg32_srandom(42, 54) output', () => {
    const core = Pcg32Core.seed('000000000000002a', '0000000000000036');
    const out = Array.from({ length: 6 }, () => core.nextUint32().toString(16).padStart(8, '0'));
    expect(out).toEqual(['a15c02b7', '7b47f409', 'ba1d3330', '83d2f293', 'bfa4784b', 'cbed606e']);
  });

  it('is deterministic for a seed and stream name', () => {
    fc.assert(
      fc.property(seedArb, fc.stringMatching(/^[a-z_]{1,12}$/), (seed, name) => {
        const a = createSessionRng(seed).stream(name);
        const b = createSessionRng(seed).stream(name);
        for (let i = 0; i < 20; i += 1) expect(a.nextUint32()).toBe(b.nextUint32());
      }),
      { numRuns: 200 },
    );
  });

  it('derives substreams independently of draws on the parent or siblings', () => {
    const seed = randomSeedHex();
    const fresh = createSessionRng(seed).stream('dont_tap').nextUint32();
    const busy = createSessionRng(seed);
    for (let i = 0; i < 1000; i += 1) busy.nextUint32();
    busy.stream('card_sort').nextUint32();
    expect(busy.stream('dont_tap').nextUint32()).toBe(fresh);
  });

  it('gives different sequences for different streams and seeds', () => {
    const r = createSessionRng('0123456789abcdef');
    const a = Array.from({ length: 8 }, () => r.stream('a').nextUint32());
    const s1 = r.stream('a');
    const s2 = r.stream('b');
    const xs = Array.from({ length: 8 }, () => s1.nextUint32());
    const ys = Array.from({ length: 8 }, () => s2.nextUint32());
    expect(xs).not.toEqual(ys);
    expect(new Set(a).size).toBe(1); // a fresh stream restarts from the same state
    const other = createSessionRng('0123456789abcdee').stream('a');
    expect(Array.from({ length: 8 }, () => other.nextUint32())).not.toEqual(xs);
  });

  it('produces unbiased bounded integers within range', () => {
    const r = createSessionRng('00000000deadbeef');
    const counts = new Array<number>(6).fill(0);
    for (let i = 0; i < 60000; i += 1) {
      const v = r.int(1, 6);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(6);
      counts[v - 1] = (counts[v - 1] ?? 0) + 1;
    }
    for (const c of counts) expect(Math.abs(c - 10000)).toBeLessThan(500);
    // next() in [0, 1)
    for (let i = 0; i < 1000; i += 1) {
      const x = r.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('shuffles as a permutation and leaves the input untouched', () => {
    const r = createSessionRng('1111111111111111');
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = r.shuffle(input);
    expect([...out].sort()).toEqual(input);
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('weighted() respects zero weights and rejects invalid input', () => {
    const r = createSessionRng('2222222222222222');
    for (let i = 0; i < 200; i += 1) expect(r.weighted(['a', 'b', 'c'], [0, 1, 0])).toBe('b');
    expect(() => r.weighted(['a'], [0])).toThrow();
    expect(() => r.pick([])).toThrow();
    expect(() => r.int(3, 1)).toThrow();
  });

  it('round-trips state snapshots for replay', () => {
    const r = new Pcg32Rng('abcdefabcdefabcd', 'session.x');
    for (let i = 0; i < 17; i += 1) r.nextUint32();
    const snap = r.state();
    const restored = Pcg32Rng.restore('abcdefabcdefabcd', 'session.x', snap);
    for (let i = 0; i < 10; i += 1) expect(restored.nextUint32()).toBe(r.nextUint32());
  });

  it('hash64 is stable and keyed streams do not depend on a session seed', () => {
    expect(hash64('shriii')).toBe(hash64('shriii'));
    expect(hash64('a')).not.toBe(hash64('b'));
    expect(createKeyedRng('tower|form_1').nextUint32()).toBe(
      createKeyedRng('tower|form_1').nextUint32(),
    );
  });
});

describe('hashing', () => {
  it('computes standard SHA-256 vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    for (const len of [55, 56, 63, 64, 65, 1000, 100_000]) {
      const text = `é${'ab'.repeat(len)}`;
      expect(sha256Hex(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
    }
  });

  it('serialises canonical JSON with sorted keys and no whitespace', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x'], c: { z: 1.5, y: undefined } })).toBe(
      '{"a":[true,null,"x"],"b":1,"c":{"z":1.5}}',
    );
    expect(() => canonicalJson({ x: Number.NaN })).toThrow();
  });
});

describe('UUIDv7', () => {
  it('generates valid, unique, monotonic ids', () => {
    let t = 1_760_000_000_000;
    const gen = new Uuidv7Generator({ nowMs: () => t });
    const ids: string[] = [];
    for (let i = 0; i < 5000; i += 1) {
      if (i % 1000 === 0) t += 1;
      ids.push(gen.next());
    }
    for (const id of ids) expect(id).toMatch(UUIDV7_PATTERN);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    expect(uuidv7Timestamp(ids[0] ?? '')).toBe(1_760_000_000_001);
  });

  it('stays monotonic when the wall clock goes backwards', () => {
    let t = 2_000_000_000_000;
    const gen = new Uuidv7Generator({ nowMs: () => t });
    const a = gen.next();
    t -= 5000;
    const b = gen.next();
    expect(b > a).toBe(true);
  });
});
