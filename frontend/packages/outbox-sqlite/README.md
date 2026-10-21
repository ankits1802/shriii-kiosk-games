# @shriii/outbox-sqlite

Encrypted, crash-safe kiosk outbox for the Electron main process (KSK-07). It implements the
kiosk-game `Outbox` contract (`packages/kiosk-game/src/core/contracts.ts`) and the full
`KioskOutbox` surface, so the kiosk-game logger, crash recovery and uploader run on it unchanged
(see `test/kiosk-game-compat.test.ts`).

**Driver:** Node's built-in `node:sqlite` (Node 24 / Electron 44 ship SQLite 3.53), so there is
no native addon to rebuild per Electron ABI. `better-sqlite3` fits the same `SqlDatabase` seam if it
is ever needed.

## Guarantees

- WAL, `synchronous=FULL`, `secure_delete=ON`, foreign keys, STRICT tables.
- `seq` allocated from `sessions.next_seq` inside the same `BEGIN IMMEDIATE` transaction as the
  event row. Remote callers (IPC) use `appendAt(sessionId, expectedSeq, event)`, which refuses
  anything but the next gapless seq.
- Payloads are stored AES-256-GCM encrypted with the per-session DEK (`@shriii/session-crypto`); the
  DEK is wrapped with the device KEK and sealed to the backend key.
- Consent first: only sessions with a stored core `consent.granted` are uploadable; batches are
  session-ordered, and a session's first chunk reaches its consent event.
- Purge: closing a session without granted consent (walk-away, abandon, decline) purges it and
  crypto-shreds its key; stale unconsented sessions are purged by `maintenance()`; withdrawal keeps
  only a tombstone at the next seq.
- Idempotent batches: a batch keeps its id and exact body until the server answers; `retryable`
  rows return to pending (re-chunked into contiguous runs), terminal ones are purged after the grace
  period.
- Capacity: quotas from [`config/outbox-policy.yaml`](config/outbox-policy.yaml) (30-day design
  capacity, 7-day unsynced alert, disk floor). At the quota new sessions stop; data is never dropped.
- Backend key rotation re-seals pending DEKs lazily; `rotateKek()` re-wraps every DEK.

## Tests

`pnpm --filter @shriii/outbox-sqlite test` runs unit tests, a fast-check property test, the
kiosk-game compatibility test and the crash test (a writer process is SIGKILLed 12 times mid-write;
after each kill `integrity_check` passes, every session is gapless and every reported commit
survived).
