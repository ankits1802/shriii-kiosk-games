/**
 * Minimal key-value persistence used by the store. Three backends implement it:
 * SQLite on the tablet (@capacitor-community/sqlite), IndexedDB in a browser build (tests and
 * the Playwright smoke), and an in-memory map for unit tests.
 */

export const TABLES = ['settings', 'sessions', 'trials', 'outbox', 'audit'] as const;
export type Table = (typeof TABLES)[number];

/** Tables whose rows may never be overwritten or deleted. */
export const APPEND_ONLY: ReadonlySet<Table> = new Set<Table>(['audit', 'trials']);

export class AppendOnlyViolation extends Error {
  constructor(table: Table, key: string) {
    super(`${table} is append-only; row ${key} already exists`);
    this.name = 'AppendOnlyViolation';
  }
}

export interface KvBackend {
  readonly kind: 'sqlite' | 'indexeddb' | 'memory';
  open(): Promise<void>;
  get<T>(table: Table, key: string): Promise<T | undefined>;
  /** Upsert, except in append-only tables where an existing key throws {@link AppendOnlyViolation}. */
  put(table: Table, key: string, value: unknown): Promise<void>;
  /** Rows whose key starts with `prefix`, ordered by key. */
  list<T>(table: Table, prefix?: string): Promise<T[]>;
}

export class MemoryKv implements KvBackend {
  readonly kind = 'memory' as const;
  private readonly tables = new Map<Table, Map<string, string>>();

  async open(): Promise<void> {
    for (const t of TABLES) if (!this.tables.has(t)) this.tables.set(t, new Map());
  }

  private table(t: Table): Map<string, string> {
    const m = this.tables.get(t);
    if (!m) throw new Error('store not opened');
    return m;
  }

  async get<T>(table: Table, key: string): Promise<T | undefined> {
    const raw = this.table(table).get(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }

  async put(table: Table, key: string, value: unknown): Promise<void> {
    const t = this.table(table);
    if (APPEND_ONLY.has(table) && t.has(key)) throw new AppendOnlyViolation(table, key);
    t.set(key, JSON.stringify(value));
  }

  async list<T>(table: Table, prefix = ''): Promise<T[]> {
    return [...this.table(table).entries()]
      .filter(([k]) => k.startsWith(prefix))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, v]) => JSON.parse(v) as T);
  }
}
