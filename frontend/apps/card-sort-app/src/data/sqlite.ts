import type { SQLiteDBConnection } from '@capacitor-community/sqlite';
import { APPEND_ONLY, AppendOnlyViolation, type KvBackend, TABLES, type Table } from './kv.ts';

const DB_NAME = 'shriii_card_sort';
const DB_VERSION = 1;

function schemaSql(): string {
  const parts: string[] = [];
  for (const t of TABLES) {
    parts.push(
      `CREATE TABLE IF NOT EXISTS kv_${t} (k TEXT PRIMARY KEY NOT NULL, v TEXT NOT NULL, written_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));`,
    );
    if (APPEND_ONLY.has(t)) {
      // Append-only at the database level too: the audit trail and trial log cannot be edited.
      parts.push(
        `CREATE TRIGGER IF NOT EXISTS kv_${t}_no_update BEFORE UPDATE ON kv_${t} BEGIN SELECT RAISE(ABORT, '${t} is append-only'); END;`,
        `CREATE TRIGGER IF NOT EXISTS kv_${t}_no_delete BEFORE DELETE ON kv_${t} BEGIN SELECT RAISE(ABORT, '${t} is append-only'); END;`,
      );
    }
  }
  return parts.join('\n');
}

/** SQLite backend on the tablet (Android, via @capacitor-community/sqlite). */
export class SqliteKv implements KvBackend {
  readonly kind = 'sqlite' as const;
  private db: SQLiteDBConnection | null = null;

  async open(): Promise<void> {
    if (this.db) return;
    const { CapacitorSQLite, SQLiteConnection } = await import('@capacitor-community/sqlite');
    const sqlite = new SQLiteConnection(CapacitorSQLite);
    await sqlite.checkConnectionsConsistency().catch(() => undefined);
    const existing = (await sqlite.isConnection(DB_NAME, false)).result;
    const db = existing
      ? await sqlite.retrieveConnection(DB_NAME, false)
      : await sqlite.createConnection(DB_NAME, false, 'no-encryption', DB_VERSION, false);
    await db.open();
    await db.execute(schemaSql(), true);
    this.db = db;
  }

  private conn(): SQLiteDBConnection {
    if (!this.db) throw new Error('store not opened');
    return this.db;
  }

  async get<T>(table: Table, key: string): Promise<T | undefined> {
    const res = await this.conn().query(`SELECT v FROM kv_${table} WHERE k = ?`, [key]);
    const row = res.values?.[0] as { v: string } | undefined;
    return row ? (JSON.parse(row.v) as T) : undefined;
  }

  async put(table: Table, key: string, value: unknown): Promise<void> {
    const json = JSON.stringify(value);
    if (APPEND_ONLY.has(table)) {
      const exists = await this.conn().query(`SELECT 1 AS x FROM kv_${table} WHERE k = ?`, [key]);
      if ((exists.values?.length ?? 0) > 0) throw new AppendOnlyViolation(table, key);
      await this.conn().run(`INSERT INTO kv_${table} (k, v) VALUES (?, ?)`, [key, json]);
      return;
    }
    await this.conn().run(
      `INSERT INTO kv_${table} (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, written_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      [key, json],
    );
  }

  async list<T>(table: Table, prefix = ''): Promise<T[]> {
    const res = prefix
      ? await this.conn().query(`SELECT v FROM kv_${table} WHERE substr(k, 1, ?) = ? ORDER BY k`, [
          prefix.length,
          prefix,
        ])
      : await this.conn().query(`SELECT v FROM kv_${table} ORDER BY k`);
    return ((res.values ?? []) as { v: string }[]).map((r) => JSON.parse(r.v) as T);
  }
}
