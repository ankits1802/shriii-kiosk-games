/** SQLite schema and migrations for the kiosk outbox (KSK-07). */
import type { SqlDatabase } from './driver.ts';

export const SCHEMA_VERSION = 1;

const V1 = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  ord        INTEGER NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  next_seq   INTEGER NOT NULL DEFAULT 0 CHECK (next_seq >= 0),
  consent    TEXT NOT NULL DEFAULT 'pending' CHECK (consent IN ('pending', 'granted', 'declined')),
  closed     INTEGER NOT NULL DEFAULT 0 CHECK (closed IN (0, 1)),
  closed_at  INTEGER,
  encryption TEXT NOT NULL CHECK (encryption IN ('sealed', 'none_dev'))
) STRICT;

CREATE TABLE IF NOT EXISTS session_keys (
  session_id  TEXT PRIMARY KEY REFERENCES sessions (session_id) ON DELETE CASCADE,
  wrapped_dek BLOB NOT NULL,
  sealed_dek  TEXT NOT NULL,
  kid         TEXT NOT NULL,
  sealed_at   INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS events (
  session_id TEXT NOT NULL REFERENCES sessions (session_id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL CHECK (seq >= 0),
  event_id   TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload    BLOB NOT NULL,
  bytes      INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'inflight', 'acked')),
  batch_id   TEXT,
  ack_status TEXT,
  acked_at   INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq)
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS events_status ON events (status, session_id, seq);
CREATE INDEX IF NOT EXISTS events_batch ON events (batch_id) WHERE batch_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS consents (
  session_id  TEXT NOT NULL REFERENCES sessions (session_id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('granted', 'declined', 'withdrawn')),
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq)
) STRICT;

CREATE TABLE IF NOT EXISTS batches (
  batch_id        TEXT PRIMARY KEY,
  created_at      INTEGER NOT NULL,
  body            TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER
) STRICT;
`;

/** Apply pragmas and migrations. Returns the journal mode actually in effect. */
export function migrate(db: SqlDatabase): string {
  const mode = (db.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode: string })
    .journal_mode;
  // FULL: a committed event survives power loss (WAL + NORMAL may lose the last commits).
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA foreign_keys = ON');
  // Deleted (purged / acknowledged) content is overwritten, not left in free pages.
  db.exec('PRAGMA secure_delete = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number })
    .user_version;
  if (current > SCHEMA_VERSION) {
    throw new Error(`outbox schema v${current} is newer than this build (v${SCHEMA_VERSION})`);
  }
  if (current < 1) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(V1);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return mode;
}
