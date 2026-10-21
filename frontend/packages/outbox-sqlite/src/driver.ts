/**
 * Minimal synchronous SQLite driver surface. Both Node's built-in `node:sqlite` (`DatabaseSync`,
 * the default; no native addon to rebuild for Electron) and `better-sqlite3` satisfy it, so the
 * outbox can run on either without code changes.
 */

export type SqlValue = null | number | bigint | string | Uint8Array;

export interface SqlRunResult {
  readonly changes: number | bigint;
  readonly lastInsertRowid: number | bigint;
}

export interface SqlStatement {
  run(...params: SqlValue[]): SqlRunResult;
  get(...params: SqlValue[]): unknown;
  all(...params: SqlValue[]): unknown[];
}

export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

export type OpenDatabase = (path: string) => SqlDatabase;

interface NodeSqliteModule {
  DatabaseSync: new (
    path: string,
    options?: { readonly timeout?: number; readonly enableForeignKeyConstraints?: boolean },
  ) => SqlDatabase;
}

function loadNodeSqlite(): NodeSqliteModule | undefined {
  // getBuiltinModule works in ESM and CJS bundles and never throws for a missing builtin.
  return process.getBuiltinModule?.('node:sqlite') as NodeSqliteModule | undefined;
}

/** Open a database with Node's built-in `node:sqlite` (Node >= 22.13 / Electron with Node 24). */
export const openNodeSqlite: OpenDatabase = (path) => {
  const sqlite = loadNodeSqlite();
  if (!sqlite) throw new Error('node:sqlite is not available in this runtime; inject a driver');
  return new sqlite.DatabaseSync(path, { timeout: 5000, enableForeignKeyConstraints: true });
};

/** True when `node:sqlite` can be loaded in this runtime. */
export function nodeSqliteAvailable(): boolean {
  return loadNodeSqlite() !== undefined;
}
