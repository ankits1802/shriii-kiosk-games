import { Capacitor } from '@capacitor/core';
import { IndexedDbKv } from './idb.ts';
import { type KvBackend, MemoryKv } from './kv.ts';
import { SqliteKv } from './sqlite.ts';
import { CardSortStore } from './store.ts';

/** SQLite on the tablet, IndexedDB in a browser, memory as a last resort (never for real data). */
export function pickBackend(): KvBackend {
  if (Capacitor.isNativePlatform()) return new SqliteKv();
  if (typeof indexedDB !== 'undefined') return new IndexedDbKv();
  return new MemoryKv();
}

export async function openStore(): Promise<CardSortStore> {
  const store = new CardSortStore(pickBackend());
  await store.init();
  return store;
}
