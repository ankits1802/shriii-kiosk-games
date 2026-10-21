/**
 * Seeded, logged session assignments:
 * - Pathway B planned-missingness slot (MG-10): permuted blocks per kiosk, so allocation counts are
 *   exactly balanced within each block of `block_size` consented sessions.
 * - Pilot battery arm (EPI-05): `B_fixed` / `A_narrative` 1:1 permuted blocks (offline fallback; a
 *   server list or a forced arm can override).
 * - Parallel form (ENG-14): T1 form drawn at random from the session seed.
 *
 * Block positions advance only when a session commits (core consent granted), so declined or
 * abandoned-before-consent sessions do not unbalance the design.
 */
import type { BatteryArm, SlotForm } from '@shriii/contracts';
import type { SeededRng } from '../core/contracts.ts';
import { Pcg32Rng } from './rng.ts';

/** Small persistent key/value store (localStorage in the browser, memory in tests, SQLite later). */
export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** In-memory {@link KeyValueStore}. */
export class MemoryKeyValueStore implements KeyValueStore {
  private readonly map = new Map<string, string>();
  get(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  set(key: string, value: string): void {
    this.map.set(key, value);
  }
}

/** `localStorage`-backed store; falls back to memory when storage is unavailable (private mode). */
export class LocalStorageKeyValueStore implements KeyValueStore {
  private readonly prefix: string;
  private readonly fallback = new MemoryKeyValueStore();
  constructor(prefix = 'shriii.kiosk.') {
    this.prefix = prefix;
  }
  get(key: string): string | null {
    try {
      return globalThis.localStorage?.getItem(this.prefix + key) ?? this.fallback.get(key);
    } catch {
      return this.fallback.get(key);
    }
  }
  set(key: string, value: string): void {
    this.fallback.set(key, value);
    try {
      globalThis.localStorage?.setItem(this.prefix + key, value);
    } catch {
      // Storage full or blocked: keep the in-memory value (assignment still deterministic per run).
    }
  }
}

/** One permuted-block assignment, before or after commit. */
export interface BlockAssignment<T extends string> {
  readonly value: T;
  /** 0-based block number on this kiosk. */
  readonly blockIndex: number;
  /** Position within the block. */
  readonly position: number;
}

/**
 * Permuted-block randomiser keyed by a kiosk seed. The permutation for block `b` is a pure function
 * of (kiosk seed, name, b), so assignments are reproducible from the kiosk seed and the counter.
 */
export class PermutedBlockAssigner<T extends string> {
  private readonly store: KeyValueStore;
  private readonly kioskSeedHex: string;
  private readonly name: string;
  private readonly values: readonly T[];
  private readonly blockSize: number;

  constructor(options: {
    readonly store: KeyValueStore;
    /** Persistent 64-bit hex seed of this kiosk. */
    readonly kioskSeedHex: string;
    /** Assignment family, e.g. `slot` or `arm` (also the store key). */
    readonly name: string;
    readonly values: readonly T[];
    /** Must be a positive multiple of `values.length`. */
    readonly blockSize: number;
  }) {
    if (options.values.length === 0) throw new RangeError('PermutedBlockAssigner: no values');
    if (options.blockSize <= 0 || options.blockSize % options.values.length !== 0) {
      throw new RangeError(
        `PermutedBlockAssigner: block size ${options.blockSize} must be a multiple of ${options.values.length}`,
      );
    }
    this.store = options.store;
    this.kioskSeedHex = options.kioskSeedHex;
    this.name = options.name;
    this.values = options.values;
    this.blockSize = options.blockSize;
  }

  private counter(): number {
    const raw = this.store.get(`${this.name}.counter`);
    const n = raw === null ? 0 : Number.parseInt(raw, 10);
    return Number.isInteger(n) && n >= 0 ? n : 0;
  }

  /** The permuted block `b` (each value appears blockSize / values.length times). */
  block(b: number): T[] {
    const reps = this.blockSize / this.values.length;
    const pool: T[] = [];
    for (let r = 0; r < reps; r += 1) pool.push(...this.values);
    return new Pcg32Rng(this.kioskSeedHex, `kiosk.${this.name}.block.${b}`).shuffle(pool);
  }

  /** The assignment the next committed session will receive (does not advance). */
  peek(): BlockAssignment<T> {
    const n = this.counter();
    const blockIndex = Math.floor(n / this.blockSize);
    const position = n % this.blockSize;
    return { value: this.block(blockIndex)[position] as T, blockIndex, position };
  }

  /** Advance past the peeked assignment (call when the session commits). */
  commit(expected: BlockAssignment<T>): void {
    const n = this.counter();
    if (n !== expected.blockIndex * this.blockSize + expected.position) return; // already advanced
    this.store.set(`${this.name}.counter`, String(n + 1));
  }
}

/** Default pilot arm values (EPI-05). `B_adaptive`, `A_D`, `C` are reserved for later waves. */
export const PILOT_ARMS: readonly BatteryArm[] = ['B_fixed', 'A_narrative'];

/** Draw the session's parallel form (ENG-14) from the session stream. */
export function assignForm(
  rng: SeededRng,
  forms: readonly string[] = ['form_1', 'form_2'],
): string {
  return rng.stream('form').pick(forms);
}

/** Type guard for slot forms. */
export function isSlotForm(value: string): value is SlotForm {
  return (
    value === 'wait_or_now' ||
    value === 'steady_hands' ||
    value === 'four_stalls' ||
    value === 'private_dice'
  );
}
