import { APPEND_ONLY, AppendOnlyViolation, type KvBackend, TABLES, type Table } from './kv.ts';

const DB_VERSION = 1;

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

/** IndexedDB backend for the browser build (one object store per table, JSON string values). */
export class IndexedDbKv implements KvBackend {
  readonly kind = 'indexeddb' as const;
  private db: IDBDatabase | null = null;

  constructor(
    private readonly name = 'shriii-card-sort',
    private readonly factory: IDBFactory = globalThis.indexedDB,
  ) {}

  async open(): Promise<void> {
    if (this.db) return;
    const req = this.factory.open(this.name, DB_VERSION);
    req.onupgradeneeded = () => {
      for (const t of TABLES)
        if (!req.result.objectStoreNames.contains(t)) req.result.createObjectStore(t);
    };
    this.db = await promisify(req);
  }

  private store(table: Table, mode: IDBTransactionMode): IDBObjectStore {
    if (!this.db) throw new Error('store not opened');
    return this.db.transaction(table, mode).objectStore(table);
  }

  async get<T>(table: Table, key: string): Promise<T | undefined> {
    const raw = (await promisify(this.store(table, 'readonly').get(key))) as string | undefined;
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }

  async put(table: Table, key: string, value: unknown): Promise<void> {
    const store = this.store(table, 'readwrite');
    const json = JSON.stringify(value);
    if (APPEND_ONLY.has(table)) {
      try {
        await promisify(store.add(json, key));
      } catch (e) {
        if (e instanceof DOMException && e.name === 'ConstraintError')
          throw new AppendOnlyViolation(table, key);
        throw e;
      }
      return;
    }
    await promisify(store.put(json, key));
  }

  async list<T>(table: Table, prefix = ''): Promise<T[]> {
    const range = prefix ? IDBKeyRange.bound(prefix, `${prefix}￿`) : undefined;
    const rows = (await promisify(this.store(table, 'readonly').getAll(range))) as string[];
    return rows.map((r) => JSON.parse(r) as T);
  }
}
