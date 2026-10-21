/**
 * Main-process uploader (KSK-07, ING-02 client). POSTs `UploadBatch`es from the SQLite outbox to
 * `<apiOrigin>/api/v1/events/batch` with Electron `net.fetch` (Chromium network stack: system proxy
 * and the device mTLS client certificate via `select-client-certificate`).
 *
 * - Idempotent: a batch keeps its id and body until the server answers.
 * - Exponential backoff with equal jitter (1 s .. 15 min), reset on success.
 * - Paused whenever a person is using the kiosk (any lifecycle state other than attract/boot):
 *   no network activity during play.
 * - HTTP 426 (build outside every active wave) stops uploading and keeps the data.
 * - Periodic maintenance: stale unconsented purge, acknowledged-row purge, WAL checkpoint.
 */
import type { UploadBatchResult } from '@shriii/contracts';
import { validateUploadBatchResult } from '@shriii/contracts/validators/upload-batch-result';
import type { SqliteOutbox } from '@shriii/outbox-sqlite';

export type UploaderState =
  | 'disabled'
  | 'idle'
  | 'uploading'
  | 'backoff'
  | 'paused'
  | 'blocked_upgrade_required'
  | 'stopped';

export interface UploaderStatus {
  readonly state: UploaderState;
  readonly consecutiveFailures: number;
  readonly nextAttemptAt: number | null;
  readonly lastError: string | null;
  readonly lastSuccessAt: number | null;
  readonly batchesSent: number;
}

export interface BackoffPolicy {
  readonly baseMs: number;
  readonly maxMs: number;
  readonly jitter: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = { baseMs: 1000, maxMs: 15 * 60_000, jitter: 0.5 };

export function backoffDelay(failures: number, p: BackoffPolicy, random: () => number): number {
  const exp = Math.min(p.maxMs, p.baseMs * 2 ** Math.max(0, failures - 1));
  return Math.round(exp * (1 - p.jitter) + random() * exp * p.jitter);
}

/** Lifecycle states in which uploading is allowed (nobody at the kiosk). */
export const UPLOAD_STATES: ReadonlySet<string> = new Set(['boot', 'attract', 'out_of_service']);

export type Outcome =
  | { readonly kind: 'empty' }
  | { readonly kind: 'sent'; readonly result: UploadBatchResult }
  | { readonly kind: 'failed'; readonly error: string; readonly retryInMs: number }
  | { readonly kind: 'blocked' }
  | { readonly kind: 'skipped'; readonly reason: 'disabled' | 'paused' | 'busy' };

export interface MainUploaderOptions {
  readonly outbox: SqliteOutbox;
  readonly apiOrigin: string | null;
  readonly fetch: typeof globalThis.fetch;
  readonly backoff?: BackoffPolicy;
  readonly random?: () => number;
  readonly nowMs?: () => number;
  readonly timeoutMs?: number;
  readonly idlePollMs?: number;
  readonly maintenanceEveryMs?: number;
  readonly headers?: () => Record<string, string>;
  readonly setTimer?: (cb: () => void, ms: number) => unknown;
  readonly clearTimer?: (h: unknown) => void;
  readonly log?: (msg: string, data?: Record<string, unknown>) => void;
}

export class MainUploader {
  private readonly o: Required<Omit<MainUploaderOptions, 'apiOrigin' | 'log' | 'headers'>> & {
    headers: () => Record<string, string>;
    log: (msg: string, data?: Record<string, unknown>) => void;
  };
  readonly endpoint: string | null;
  private timer: unknown = null;
  private running = false;
  private busy = false;
  private paused = false;
  private blocked = false;
  private lastMaintenance = 0;
  private status: UploaderStatus;

  constructor(options: MainUploaderOptions) {
    this.endpoint = options.apiOrigin ? `${options.apiOrigin}/api/v1/events/batch` : null;
    this.o = {
      outbox: options.outbox,
      fetch: options.fetch,
      backoff: options.backoff ?? DEFAULT_BACKOFF,
      random: options.random ?? Math.random,
      nowMs: options.nowMs ?? Date.now,
      timeoutMs: options.timeoutMs ?? 30_000,
      idlePollMs: options.idlePollMs ?? 30_000,
      maintenanceEveryMs: options.maintenanceEveryMs ?? 10 * 60_000,
      headers: options.headers ?? (() => ({})),
      setTimer: options.setTimer ?? ((cb, ms) => setTimeout(cb, ms)),
      clearTimer: options.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout)),
      log: options.log ?? (() => undefined),
    };
    this.status = {
      state: this.endpoint ? 'idle' : 'disabled',
      consecutiveFailures: 0,
      nextAttemptAt: null,
      lastError: null,
      lastSuccessAt: null,
      batchesSent: 0,
    };
  }

  get current(): UploaderStatus {
    return this.status;
  }

  private update(patch: Partial<UploaderStatus>): void {
    this.status = { ...this.status, ...patch };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) this.o.clearTimer(this.timer);
    this.timer = null;
    this.update({ state: this.endpoint ? 'stopped' : 'disabled', nextAttemptAt: null });
  }

  /** Follow the renderer's lifecycle state: pause while anyone is using the kiosk. */
  setLifecycleState(state: string): void {
    if (UPLOAD_STATES.has(state)) this.resume();
    else this.pause();
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    if (this.timer !== null) this.o.clearTimer(this.timer);
    this.timer = null;
    if (this.endpoint) this.update({ state: 'paused', nextAttemptAt: null });
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (this.endpoint) this.update({ state: this.blocked ? 'blocked_upgrade_required' : 'idle' });
    this.schedule(0);
  }

  /** New data was written: try soon (if allowed). */
  poke(): void {
    if (this.timer === null) this.schedule(this.o.idlePollMs);
  }

  private schedule(ms: number): void {
    if (!this.running || this.paused) return;
    if (this.timer !== null) this.o.clearTimer(this.timer);
    this.timer = this.o.setTimer(() => {
      this.timer = null;
      void this.tick();
    }, ms);
  }

  private maintain(): void {
    const now = this.o.nowMs();
    if (now - this.lastMaintenance < this.o.maintenanceEveryMs) return;
    this.lastMaintenance = now;
    try {
      const r = this.o.outbox.maintenance();
      if (r.purgedSessions.length > 0 || r.purgedRows > 0) {
        this.o.log('outbox maintenance', {
          purgedSessions: r.purgedSessions.length,
          purgedRows: r.purgedRows,
        });
      }
    } catch (err) {
      this.o.log('outbox maintenance failed', { error: (err as Error).message });
    }
  }

  private async tick(): Promise<void> {
    this.maintain();
    const outcome = await this.uploadOnce();
    if (!this.running || this.paused) return;
    if (outcome.kind === 'sent') this.schedule(0);
    else if (outcome.kind === 'empty') this.schedule(this.o.idlePollMs);
    else if (outcome.kind === 'failed') this.schedule(outcome.retryInMs);
    else if (outcome.kind === 'skipped' && outcome.reason === 'busy')
      this.schedule(this.o.idlePollMs);
  }

  private async fail(batchId: string | null, error: string): Promise<Outcome> {
    if (batchId) await this.o.outbox.markBatchFailed(batchId);
    const failures = this.status.consecutiveFailures + 1;
    const retryInMs = backoffDelay(failures, this.o.backoff, this.o.random);
    this.update({
      state: 'backoff',
      consecutiveFailures: failures,
      lastError: error,
      nextAttemptAt: this.o.nowMs() + retryInMs,
    });
    this.o.log('upload failed', { error, retryInMs });
    return { kind: 'failed', error, retryInMs };
  }

  async uploadOnce(): Promise<Outcome> {
    if (!this.endpoint) return { kind: 'skipped', reason: 'disabled' };
    if (this.paused) return { kind: 'skipped', reason: 'paused' };
    if (this.blocked) return { kind: 'blocked' };
    if (this.busy) return { kind: 'skipped', reason: 'busy' };
    this.busy = true;
    try {
      let batch: Awaited<ReturnType<SqliteOutbox['nextBatch']>>;
      try {
        batch = await this.o.outbox.nextBatch();
      } catch (err) {
        return await this.fail(null, `outbox: ${(err as Error).message}`);
      }
      if (!batch) {
        this.update({ state: 'idle', nextAttemptAt: null });
        return { kind: 'empty' };
      }
      this.update({ state: 'uploading' });
      const controller = new AbortController();
      const timeout = this.o.setTimer(() => controller.abort(), this.o.timeoutMs);
      let response: Response;
      try {
        response = await this.o.fetch(this.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': batch.batch_id,
            ...this.o.headers(),
          },
          body: JSON.stringify(batch),
          signal: controller.signal,
        });
      } catch (err) {
        return await this.fail(batch.batch_id, `network: ${(err as Error).message}`);
      } finally {
        this.o.clearTimer(timeout);
      }
      if (response.status === 426) {
        this.blocked = true;
        this.update({ state: 'blocked_upgrade_required', lastError: 'HTTP 426 upgrade required' });
        this.o.log('uploads blocked: upgrade required');
        return { kind: 'blocked' };
      }
      if (!response.ok) return await this.fail(batch.batch_id, `HTTP ${response.status}`);
      let body: unknown;
      try {
        body = await response.json();
      } catch (err) {
        return await this.fail(batch.batch_id, `bad response body: ${(err as Error).message}`);
      }
      if (!validateUploadBatchResult(body) || body.batch_id !== batch.batch_id) {
        return await this.fail(batch.batch_id, 'response does not match UploadBatchResult');
      }
      await this.o.outbox.applyResult(body);
      this.update({
        state: 'idle',
        consecutiveFailures: 0,
        lastError: null,
        lastSuccessAt: this.o.nowMs(),
        nextAttemptAt: null,
        batchesSent: this.status.batchesSent + 1,
      });
      return { kind: 'sent', result: body };
    } finally {
      this.busy = false;
    }
  }
}
