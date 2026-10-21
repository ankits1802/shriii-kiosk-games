/**
 * Renderer-side outbox over the preload bridge: a drop-in for kiosk-game's `KioskOutbox` (logger,
 * crash recovery) when the kiosk runs inside Electron. The SQLite outbox in the main process stays
 * the single source of truth for `seq`:
 *
 * - `append(sessionId, build)` builds the event for the seq it believes is next and sends it with
 *   that seq; the main process accepts it only if that is exactly the next gapless seq. On a
 *   conflict it rebuilds for the seq the main process reports and retries.
 * - Appends are serialised per outbox instance, matching IndexedDB/SQLite transaction order.
 * - Uploading is done by the main process, so `nextBatch()` returns null and the renderer's
 *   `BatchUploader` (if constructed) is a harmless no-op; `applyResult`/`markBatchFailed`/
 *   `purgeAcknowledged` are no-ops for the same reason.
 *
 * Wiring in `frontend/apps/kiosk` (merge step): when `window.shriiiKiosk` exists, construct
 * `new IpcOutbox(window.shriiiKiosk, kioskId)` instead of the Dexie outbox and keep the renderer
 * uploader disabled (`apiBase: null`).
 */
import type {
  ConsentState,
  IpcResult,
  OpenSessionInfo,
  OutboxStats,
  ShriiiKioskBridge,
} from '../shared/ipc-contract.ts';

export class BridgeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

function unwrap<T>(r: IpcResult<T>): T {
  if (r.ok) return r.value;
  throw new BridgeError(r.code, r.message);
}

const MAX_CONFLICT_RETRIES = 3;

export class IpcOutbox {
  readonly kioskId: string;
  private readonly bridge: ShriiiKioskBridge;
  private readonly expected = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(bridge: ShriiiKioskBridge, kioskId: string) {
    this.bridge = bridge;
    this.kioskId = kioskId;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  append(sessionId: string, build: (seq: number) => unknown): Promise<number> {
    return this.serial(async () => {
      let seq = this.expected.get(sessionId) ?? unwrap(await this.bridge.outbox.nextSeq(sessionId));
      for (let attempt = 0; ; attempt += 1) {
        const r = await this.bridge.outbox.appendAt(sessionId, seq, build(seq));
        if (r.ok) {
          this.expected.set(sessionId, seq + 1);
          return seq;
        }
        if (
          r.code === 'seq_conflict' &&
          r.expected !== undefined &&
          attempt < MAX_CONFLICT_RETRIES
        ) {
          seq = r.expected;
          continue;
        }
        this.expected.delete(sessionId);
        throw new BridgeError(r.code, r.message);
      }
    });
  }

  nextSeq(sessionId: string): Promise<number> {
    return this.serial(async () => unwrap(await this.bridge.outbox.nextSeq(sessionId)));
  }

  /** Uploads run in the main process. */
  async nextBatch(): Promise<null> {
    return null;
  }

  async applyResult(_result: unknown): Promise<void> {}

  async markBatchFailed(_batchId: string): Promise<void> {}

  async purgeAcknowledged(_graceMs: number): Promise<number> {
    return 0;
  }

  setConsent(sessionId: string, state: ConsentState): Promise<void> {
    return this.serial(async () => {
      unwrap(await this.bridge.outbox.setConsent(sessionId, state));
    });
  }

  purgeSession(sessionId: string, tombstone?: (seq: number) => unknown): Promise<void> {
    return this.serial(async () => {
      this.expected.delete(sessionId);
      if (!tombstone) {
        unwrap(await this.bridge.outbox.purgeSession(sessionId));
        return;
      }
      let seq = unwrap(await this.bridge.outbox.nextSeq(sessionId));
      for (let attempt = 0; ; attempt += 1) {
        const r = await this.bridge.outbox.purgeSession(sessionId, { seq, event: tombstone(seq) });
        if (r.ok) return;
        if (
          r.code === 'seq_conflict' &&
          r.expected !== undefined &&
          attempt < MAX_CONFLICT_RETRIES
        ) {
          seq = r.expected;
          continue;
        }
        throw new BridgeError(r.code, r.message);
      }
    });
  }

  closeSession(sessionId: string): Promise<void> {
    return this.serial(async () => {
      this.expected.delete(sessionId);
      unwrap(await this.bridge.outbox.closeSession(sessionId));
    });
  }

  recordDecline(): Promise<void> {
    return this.serial(async () => {
      unwrap(await this.bridge.outbox.recordDecline());
    });
  }

  async pendingCount(): Promise<number> {
    return unwrap(await this.bridge.outbox.pendingCount());
  }

  async stats(): Promise<OutboxStats> {
    return unwrap(await this.bridge.outbox.stats());
  }

  async openSessions(): Promise<readonly OpenSessionInfo[]> {
    return unwrap(await this.bridge.outbox.openSessions());
  }

  sessionEvents(sessionId: string): Promise<unknown[]> {
    return this.serial(async () => unwrap(await this.bridge.outbox.sessionEvents(sessionId)));
  }
}

/** The bridge, when running inside the Electron kiosk shell. */
export function getKioskBridge(): ShriiiKioskBridge | null {
  const w = globalThis as { shriiiKiosk?: ShriiiKioskBridge };
  return w.shriiiKiosk?.platform === 'electron' ? w.shriiiKiosk : null;
}
