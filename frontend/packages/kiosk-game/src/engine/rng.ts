/**
 * Deterministic seeded RNG (ENG-03): PCG32 (PCG-XSH-RR 64/32, O'Neill 2014) with named substreams.
 *
 * - 64-bit arithmetic is done on pairs of unsigned 32-bit halves (no BigInt in the hot path), so the
 *   generator is fast enough for 10k-seed scheduler property tests.
 * - A substream is fully determined by the session seed and its dotted stream name: the initial state
 *   and the stream increment are both derived from `hash64(seedHex | name)`. Drawing from one stream
 *   never changes another (independence by construction), and adding a new stream never perturbs
 *   existing schedules.
 * - Reference vector: `pcg32_srandom(42, 54)` yields 0xa15c02b7, 0x7b47f409, 0xba1d3330 ... (tested).
 */
import type { RngState, SeededRng } from '../core/contracts.ts';

/** Unsigned 64-bit value as two u32 halves. */
interface U64 {
  hi: number;
  lo: number;
}

const MULT: U64 = { hi: 0x5851f42d, lo: 0x4c957f2d }; // 6364136223846793005
const FNV_OFFSET: U64 = { hi: 0xcbf29ce4, lo: 0x84222325 };
const FNV_PRIME: U64 = { hi: 0x00000100, lo: 0x000001b3 };
const TWO_POW_32 = 0x1_0000_0000;

function mul64(a: U64, b: U64): U64 {
  const a48 = a.hi >>> 16;
  const a32 = a.hi & 0xffff;
  const a16 = a.lo >>> 16;
  const a00 = a.lo & 0xffff;
  const b48 = b.hi >>> 16;
  const b32 = b.hi & 0xffff;
  const b16 = b.lo >>> 16;
  const b00 = b.lo & 0xffff;
  let c00 = a00 * b00;
  let c16 = c00 >>> 16;
  c00 &= 0xffff;
  c16 += a16 * b00;
  let c32 = c16 >>> 16;
  c16 &= 0xffff;
  c16 += a00 * b16;
  c32 += c16 >>> 16;
  c16 &= 0xffff;
  c32 += a32 * b00;
  let c48 = c32 >>> 16;
  c32 &= 0xffff;
  c32 += a16 * b16;
  c48 += c32 >>> 16;
  c32 &= 0xffff;
  c32 += a00 * b32;
  c48 += c32 >>> 16;
  c32 &= 0xffff;
  c48 += a48 * b00 + a32 * b16 + a16 * b32 + a00 * b48;
  c48 &= 0xffff;
  return { hi: ((c48 << 16) | c32) >>> 0, lo: ((c16 << 16) | c00) >>> 0 };
}

function add64(a: U64, b: U64): U64 {
  const lo = a.lo + b.lo;
  const carry = lo >= TWO_POW_32 ? 1 : 0;
  return { hi: (a.hi + b.hi + carry) >>> 0, lo: lo >>> 0 };
}

function xorShiftRight64(a: U64, shift: number): U64 {
  // a ^ (a >>> shift) for 0 < shift < 32
  const hi = a.hi >>> shift;
  const lo = ((a.lo >>> shift) | (a.hi << (32 - shift))) >>> 0;
  return { hi: (a.hi ^ hi) >>> 0, lo: (a.lo ^ lo) >>> 0 };
}

function xorShiftRight64Wide(a: U64, shift: number): U64 {
  // a ^ (a >>> shift) for 32 <= shift < 64
  return { hi: a.hi, lo: (a.lo ^ (a.hi >>> (shift - 32))) >>> 0 };
}

function hexToU64(hex: string): U64 {
  if (!/^[0-9a-f]{16}$/.test(hex)) throw new RangeError(`expected 16 lower-case hex chars: ${hex}`);
  return {
    hi: Number.parseInt(hex.slice(0, 8), 16) >>> 0,
    lo: Number.parseInt(hex.slice(8), 16) >>> 0,
  };
}

function u64ToHex(v: U64): string {
  return v.hi.toString(16).padStart(8, '0') + v.lo.toString(16).padStart(8, '0');
}

/** splitmix64 finaliser (good avalanche for derived seeds). */
function mix64(v: U64): U64 {
  let z = xorShiftRight64Wide(v, 33);
  z = mul64(z, { hi: 0xff51afd7, lo: 0xed558ccd });
  z = xorShiftRight64Wide(z, 33);
  z = mul64(z, { hi: 0xc4ceb9fe, lo: 0x1a85ec53 });
  return xorShiftRight64Wide(z, 33);
}

const utf8 = new TextEncoder();

/** FNV-1a 64 over UTF-8, then a splitmix64 finaliser. Stable across platforms. */
export function hash64(text: string): string {
  let h: U64 = { ...FNV_OFFSET };
  for (const byte of utf8.encode(text)) {
    h = { hi: h.hi, lo: (h.lo ^ byte) >>> 0 };
    h = mul64(h, FNV_PRIME);
  }
  return u64ToHex(mix64(h));
}

/** Low-level PCG32 core seeded exactly like the reference `pcg32_srandom_r(initstate, initseq)`. */
export class Pcg32Core {
  private state: U64;
  private readonly inc: U64;

  private constructor(state: U64, inc: U64) {
    this.state = state;
    this.inc = inc;
  }

  /** Reference seeding: state=0, inc=(initseq<<1)|1, step, state+=initstate, step. */
  static seed(initStateHex: string, initSeqHex: string): Pcg32Core {
    const seq = hexToU64(initSeqHex);
    const inc: U64 = {
      hi: ((seq.hi << 1) | (seq.lo >>> 31)) >>> 0,
      lo: ((seq.lo << 1) | 1) >>> 0,
    };
    const core = new Pcg32Core({ hi: 0, lo: 0 }, inc);
    core.nextUint32();
    core.state = add64(core.state, hexToU64(initStateHex));
    core.nextUint32();
    return core;
  }

  /** Restore from a serialised state. */
  static restore(state: RngState): Pcg32Core {
    return new Pcg32Core(hexToU64(state.state), hexToU64(state.increment));
  }

  nextUint32(): number {
    const old = this.state;
    this.state = add64(mul64(old, MULT), this.inc);
    // xorshifted = ((old >> 18) ^ old) >> 27  (low 32 bits)
    const x = xorShiftRight64(old, 18);
    const xorshifted = ((x.lo >>> 27) | (x.hi << 5)) >>> 0;
    const rot = old.hi >>> 27;
    return ((xorshifted >>> rot) | (xorshifted << ((32 - rot) & 31))) >>> 0;
  }

  snapshot(): RngState {
    return { algorithm: 'pcg32', state: u64ToHex(this.state), increment: u64ToHex(this.inc) };
  }
}

/**
 * The engine's {@link SeededRng}. Create the root stream with {@link createSessionRng}; derive
 * module streams with `rng.stream('dont_tap')` → `session.dont_tap`.
 */
export class Pcg32Rng implements SeededRng {
  readonly seedHex: string;
  readonly streamName: string;
  private readonly core: Pcg32Core;

  constructor(seedHex: string, streamName: string, core?: Pcg32Core) {
    if (!/^[0-9a-f]{16}$/.test(seedHex)) throw new RangeError(`invalid seed hex: ${seedHex}`);
    if (streamName.length === 0) throw new RangeError('stream name must not be empty');
    this.seedHex = seedHex;
    this.streamName = streamName;
    this.core =
      core ?? Pcg32Core.seed(hash64(`${seedHex}|state|${streamName}`), hash64(`seq|${streamName}`));
  }

  /** Rebuild a stream mid-sequence from a {@link RngState} snapshot (replay tooling). */
  static restore(seedHex: string, streamName: string, state: RngState): Pcg32Rng {
    return new Pcg32Rng(seedHex, streamName, Pcg32Core.restore(state));
  }

  nextUint32(): number {
    return this.core.nextUint32();
  }

  next(): number {
    // 53-bit uniform double from two draws.
    const hi = this.core.nextUint32() >>> 5; // 27 bits
    const lo = this.core.nextUint32() >>> 6; // 26 bits
    return (hi * 67108864 + lo) / 9007199254740992;
  }

  int(min: number, max: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(max)) {
      throw new RangeError(`int(): bounds must be integers (${min}, ${max})`);
    }
    if (max < min) throw new RangeError(`int(): max < min (${min}, ${max})`);
    const range = max - min + 1;
    if (range > TWO_POW_32) throw new RangeError('int(): range exceeds 2^32');
    if (range === TWO_POW_32) return min + this.core.nextUint32();
    // Unbiased bounded draw (PCG's pcg32_boundedrand_r): reject the low (2^32 mod range) values.
    const threshold = (TWO_POW_32 - range) % range;
    for (;;) {
      const r = this.core.nextUint32();
      if (r >= threshold) return min + (r % range);
    }
  }

  bool(p = 0.5): boolean {
    if (!(p >= 0 && p <= 1)) throw new RangeError(`bool(): p must be in [0, 1] (${p})`);
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('pick(): empty array');
    return items[this.int(0, items.length - 1)] as T;
  }

  weighted<T>(items: readonly T[], weights: readonly number[]): T {
    if (items.length === 0 || items.length !== weights.length) {
      throw new RangeError('weighted(): items and weights must be non-empty and the same length');
    }
    let total = 0;
    for (const w of weights) {
      if (!(w >= 0) || !Number.isFinite(w)) throw new RangeError('weighted(): invalid weight');
      total += w;
    }
    if (total <= 0) throw new RangeError('weighted(): all weights are zero');
    let r = this.next() * total;
    for (let i = 0; i < items.length; i += 1) {
      r -= weights[i] ?? 0;
      if (r < 0) return items[i] as T;
    }
    // Floating-point edge: return the last item with a positive weight.
    for (let i = items.length - 1; i >= 0; i -= 1) {
      if ((weights[i] ?? 0) > 0) return items[i] as T;
    }
    return items[items.length - 1] as T;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i);
      const tmp = out[i] as T;
      out[i] = out[j] as T;
      out[j] = tmp;
    }
    return out;
  }

  stream(name: string): SeededRng {
    if (!/^[a-z0-9_:-][a-z0-9_.:-]*$/.test(name)) {
      throw new RangeError(`invalid stream name: ${name}`);
    }
    return new Pcg32Rng(this.seedHex, `${this.streamName}.${name}`);
  }

  state(): RngState {
    return this.core.snapshot();
  }
}

/** Root session stream (`session`) for a 64-bit hex seed. */
export function createSessionRng(seedHex: string): Pcg32Rng {
  return new Pcg32Rng(seedHex, 'session');
}

/** A stream that depends only on a stable key (e.g. a form's fixed item order), not on the session seed. */
export function createKeyedRng(key: string, streamName = 'keyed'): Pcg32Rng {
  return new Pcg32Rng(hash64(key), streamName);
}
