/**
 * Batch uploader (KSK-07, ING-02 client): POST {API_BASE}/api/v1/events/batch with an UploadBatch.
 *
 * - Idempotent: a batch keeps its `batch_id` until the server answers; retries resend the same batch.
 * - Exponential backoff with jitter (1 s .. 15 min by default), reset on success.
 * - Offline tolerant: network errors back off; the browser `online` event triggers an immediate try.
 * - Paused during play (no upload activity while a player is in a module).
 * - With no API base configured the uploader is disabled and the queue simply persists, so the kiosk
 *   is fully playable without a backend.
 * - HTTP 426 (build outside every active wave) stops uploading and keeps the data (operations alert).
 */
import type { UploadBatchResult } from '@shriii/contracts';
import { validateUploadBatchResult } from '@shriii/contracts/validators/upload-batch-result';
import { trimTrailingSlashes } from '../core/url.ts';
import type { KioskOutbox } from './outbox/types.ts';

export type UploaderState =
  | 'disabled'
  | 'idle'
  | 'uploading'
  | 'backoff'
  | 'paused'
  | 'blocked_upgrade_required'
  | 'stopped';

/** Observable uploader status (devtools, device_health). */
export interface UploaderStatus {
  readonly state: UploaderState;
  readonly endpoint: string | null;
  readonly consecutiveFailures: number;
  readonly nextAttemptAt: number | null;
  readonly lastError: string | null;
  readonly lastSuccessAt: number | null;
  readonly batchesSent: number;
}

/** Backoff policy. */
export interface BackoffPolicy {
  readonly baseMs: number;
  readonly maxMs: number;
  /** 0..1: fraction of the delay that is randomised ("equal jitter"). */
  readonly jitter: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = { baseMs: 1000, maxMs: 15 * 60 * 1000, jitter: 0.5 };

/** Delay before retry number `failures` (1-based). */
export function backoffDelay(
  failures: number,
  policy: BackoffPolicy,
  random: () => number,
): number {
  const exp = Math.min(policy.maxMs, policy.baseMs * 2 ** Math.max(0, failures - 1));
  const fixed = exp * (1 - policy.jitter);
  return Math.round(fixed + random() * exp * policy.jitter);
}

/** Outcome of one upload attempt. */
export type UploadOutcome =
  | { readonly kind: 'empty' }
  | { readonly kind: 'sent'; readonly result: UploadBatchResult }
  | { readonly kind: 'failed'; readonly error: string; readonly retryInMs: number }
  | { readonly kind: 'blocked'; readonly status: number }
  | { readonly kind: 'skipped'; readonly reason: 'disabled' | 'paused' | 'busy' | 'stopped' };

export interface BatchUploaderOptions {
  readonly outbox: KioskOutbox;
  /** API base URL (e.g. `http://localhost:8000`); null/empty disables uploading. */
  readonly apiBase: string | null | undefined;
  readonly fetch?: typeof globalThis.fetch;
  readonly backoff?: BackoffPolicy;
  /** Jitter source (not game logic, so Math.random is acceptable here). */
  readonly random?: () => number;
  readonly nowMs?: () => number;
  readonly setTimer?: (cb: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  /** Interval between idle polls for new data (default 30 s). */
  readonly idlePollMs?: number;
  /** Acknowledged rows are deleted after this grace period (default 24 h). */
  readonly ackGraceMs?: number;
  /** Request timeout (default 30 s). */
  readonly timeoutMs?: number;
  /** Extra request headers (auth token for the kiosk device role). */
  readonly headers?: () => Record<string, string>;
}

/** Build the batch endpoint from an API base. */
export function batchEndpoint(apiBase: string | null | undefined): string | null {
  if (!apiBase || apiBase.trim() === '') return null;
  return `${trimTrailingSlashes(apiBase)}/api/v1/events/batch`;
}

export class BatchUploader {
  private readonly outbox: KioskOutbox;
  private readonly endpoint: string | null;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly backoff: BackoffPolicy;
  private readonly random: () => number;
  private readonly nowMs: () => number;
  private readonly setTimer: (cb: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly idlePollMs: number;
  private readonly ackGraceMs: number;
  private readonly timeoutMs: number;
  private readonly headers: () => Record<string, string>;
  private timer: unknown = null;
  private busy = false;
  private paused = false;
  private running = false;
  private blocked = false;
  private status: UploaderStatus;
  private readonly listeners = new Set<(s: UploaderStatus) => void>();
  private readonly onOnline = (): void => {
    if (!this.paused && !this.blocked) this.schedule(0);
  };

  constructor(options: BatchUploaderOptions) {
    this.outbox = options.outbox;
    this.endpoint = batchEndpoint(options.apiBase);
    this.fetchImpl = options.fetch ?? ((...args) => globalThis.fetch(...args));
    this.backoff = options.backoff ?? DEFAULT_BACKOFF;
    this.random = options.random ?? Math.random;
    this.nowMs = options.nowMs ?? Date.now;
    this.setTimer = options.setTimer ?? ((cb, ms) => globalThis.setTimeout(cb, ms));
    this.clearTimer =
      options.clearTimer ?? ((h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>));
    this.idlePollMs = options.idlePollMs ?? 30_000;
    this.ackGraceMs = options.ackGraceMs ?? 24 * 60 * 60 * 1000;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.headers = options.headers ?? (() => ({}));
    this.status = {
      state: this.endpoint ? 'idle' : 'disabled',
      endpoint: this.endpoint,
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

  subscribe(listener: (s: UploaderStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  private update(patch: Partial<UploaderStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const l of this.listeners) l(this.status);
  }

  /** Start the background loop (no-op when disabled). */
  start(): void {
    if (!this.endpoint || this.running) return;
    this.running = true;
    globalThis.addEventListener?.('online', this.onOnline);
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    globalThis.removeEventListener?.('online', this.onOnline);
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.update({ state: this.endpoint ? 'stopped' : 'disabled', nextAttemptAt: null });
  }

  /** Pause uploads (during play). */
  pause(): void {
    this.paused = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    if (this.endpoint) this.update({ state: 'paused', nextAttemptAt: null });
  }

  /** Resume uploads (after play) and try immediately. */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (!this.endpoint) return;
    this.update({ state: this.blocked ? 'blocked_upgrade_required' : 'idle' });
    if (this.running && !this.blocked) this.schedule(0);
  }

  get isPaused(): boolean {
    return this.paused;
  }

  private schedule(ms: number): void {
    if (!this.running || this.paused) return;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.tick();
    }, ms);
  }

  private async tick(): Promise<void> {
    const outcome = await this.uploadOnce();
    if (!this.running || this.paused) return;
    switch (outcome.kind) {
      case 'sent':
        this.schedule(0); // drain the queue
        break;
      case 'empty':
        this.schedule(this.idlePollMs);
        break;
      case 'failed':
        this.schedule(outcome.retryInMs);
        break;
      case 'blocked':
        break;
      case 'skipped':
        if (outcome.reason === 'busy') this.schedule(this.idlePollMs);
        break;
    }
  }

  /** One attempt: take the next batch (or the open one) and send it. Safe to call directly. */
  async uploadOnce(): Promise<UploadOutcome> {
    if (!this.endpoint) return { kind: 'skipped', reason: 'disabled' };
    if (this.paused) return { kind: 'skipped', reason: 'paused' };
    if (this.blocked) return { kind: 'blocked', status: 426 };
    if (this.busy) return { kind: 'skipped', reason: 'busy' };
    this.busy = true;
    try {
      const batch = await this.outbox.nextBatch();
      if (!batch) {
        await this.outbox.purgeAcknowledged(this.ackGraceMs);
        this.update({ state: 'idle', nextAttemptAt: null });
        return { kind: 'empty' };
      }
      this.update({ state: 'uploading' });
      let response: Response;
      const controller = new AbortController();
      const timeout = this.setTimer(() => controller.abort(), this.timeoutMs);
      try {
        response = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...this.headers() },
          body: JSON.stringify(batch),
          signal: controller.signal,
        });
      } catch (err) {
        return await this.fail(batch.batch_id, `network: ${errorMessage(err)}`);
      } finally {
        this.clearTimer(timeout);
      }
      if (response.status === 426) {
        this.blocked = true;
        this.update({ state: 'blocked_upgrade_required', lastError: 'HTTP 426 upgrade required' });
        return { kind: 'blocked', status: 426 };
      }
      if (!response.ok) {
        return await this.fail(batch.batch_id, `HTTP ${response.status}`);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch (err) {
        return await this.fail(batch.batch_id, `bad response body: ${errorMessage(err)}`);
      }
      if (!validateUploadBatchResult(body) || body.batch_id !== batch.batch_id) {
        return await this.fail(batch.batch_id, 'response does not match UploadBatchResult');
      }
      await this.outbox.applyResult(body);
      this.update({
        state: 'idle',
        consecutiveFailures: 0,
        lastError: null,
        lastSuccessAt: this.nowMs(),
        nextAttemptAt: null,
        batchesSent: this.status.batchesSent + 1,
      });
      return { kind: 'sent', result: body };
    } catch (err) {
      // Outbox failure (quota, blocked DB): back off, never crash the kiosk.
      const failures = this.status.consecutiveFailures + 1;
      const retryInMs = backoffDelay(failures, this.backoff, this.random);
      this.update({
        state: 'backoff',
        consecutiveFailures: failures,
        lastError: `outbox: ${errorMessage(err)}`,
        nextAttemptAt: this.nowMs() + retryInMs,
      });
      return { kind: 'failed', error: errorMessage(err), retryInMs };
    } finally {
      this.busy = false;
    }
  }

  private async fail(batchId: string, error: string): Promise<UploadOutcome> {
    await this.outbox.markBatchFailed(batchId);
    const failures = this.status.consecutiveFailures + 1;
    const retryInMs = backoffDelay(failures, this.backoff, this.random);
    this.update({
      state: 'backoff',
      consecutiveFailures: failures,
      lastError: error,
      nextAttemptAt: this.nowMs() + retryInMs,
    });
    return { kind: 'failed', error, retryInMs };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
