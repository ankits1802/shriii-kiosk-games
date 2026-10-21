/**
 * Offline sync queue. Completed administrations wait in the outbox (SQLite on the tablet) until
 * POST /api/v1/assessment-responses accepts them.
 *
 * No loss: an item leaves `pending` only on a 201 (`synced`) or a definitive 4xx (`rejected`,
 * kept for the administrator to fix and retry). No duplication: the endpoint has no idempotency
 * key, so before re-sending an item that was already attempted the queue asks the API for the
 * current responses of that administration and marks the item synced when they are already
 * stored. An `Idempotency-Key` header (the session id) is sent as well for servers that honour it.
 */

import type { CardSortStore } from '../data/store.ts';
import type { DeviceSettings, OutboxItem } from '../data/types.ts';

export const ENDPOINT = '/api/v1/assessment-responses';
export const BASE_BACKOFF_MS = 30_000;
export const MAX_BACKOFF_MS = 60 * 60_000;
export const REQUEST_TIMEOUT_MS = 20_000;

export interface SyncDeps {
  readonly store: CardSortStore;
  readonly settings: DeviceSettings;
  readonly fetch: typeof fetch;
  readonly now?: () => Date;
  readonly actor?: string;
}

export interface SyncSummary {
  readonly attempted: number;
  readonly synced: number;
  readonly deduplicated: number;
  readonly rejected: number;
  readonly retrying: number;
}

export function backoffMs(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1));
}

/** Retryable = network failure, timeout, rate limit or server error. */
export function isRetryable(status: number | null): boolean {
  return status === null || status === 408 || status === 425 || status === 429 || status >= 500;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

async function request(
  deps: SyncDeps,
  url: string,
  init: RequestInit,
): Promise<{ status: number | null; body: unknown; error: string | null }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await deps.fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // keep text
    }
    return { status: res.status, body, error: null };
  } catch (e) {
    return { status: null, body: null, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

function headers(
  settings: DeviceSettings,
  extra: Record<string, string> = {},
): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/json', ...extra };
  if (settings.deviceToken) h.Authorization = `Bearer ${settings.deviceToken}`;
  return h;
}

function describe(body: unknown): string {
  if (body && typeof body === 'object' && 'detail' in body) {
    const d = (body as { detail: unknown }).detail;
    if (typeof d === 'string') return d;
    if (d && typeof d === 'object' && 'message' in d)
      return String((d as { message: unknown }).message);
    return JSON.stringify(d).slice(0, 500);
  }
  return typeof body === 'string' ? body.slice(0, 500) : '';
}

/** True when the server already holds every measure of this administration. */
async function alreadyStored(deps: SyncDeps, item: OutboxItem): Promise<boolean | null> {
  const a = item.payload.administration;
  const q = new URLSearchParams({
    pid: a.pid,
    study_id: a.study_id,
    occasion_id: a.occasion_id,
    instrument_id: a.instrument_id,
  });
  const res = await request(deps, `${joinUrl(deps.settings.apiBaseUrl, ENDPOINT)}?${q}`, {
    method: 'GET',
    headers: headers(deps.settings),
  });
  if (res.status !== 200 || !Array.isArray(res.body)) return null;
  const stored = new Set((res.body as { item_id?: unknown }[]).map((r) => String(r.item_id)));
  return a.responses.every((r) => stored.has(r.item_id));
}

export async function syncItem(deps: SyncDeps, item: OutboxItem): Promise<OutboxItem> {
  const now = deps.now ?? (() => new Date());
  const actor = deps.actor ?? 'sync';
  const ref = { outbox_id: item.id, session_id: item.sessionId, attempt: item.attempts + 1 };

  if (item.attempts > 0) {
    const stored = await alreadyStored(deps, item);
    if (stored === true) {
      const done: OutboxItem = {
        ...item,
        status: 'synced',
        updatedAt: now().toISOString(),
        syncedAt: now().toISOString(),
        lastError: null,
      };
      await deps.store.putOutbox(done);
      await deps.store.audit(actor, 'sync_deduplicated', ref);
      return done;
    }
    if (stored === null) await deps.store.audit(actor, 'sync_dedupe_check_unavailable', ref);
  }

  await deps.store.audit(actor, 'sync_attempt', ref);
  const res = await request(deps, joinUrl(deps.settings.apiBaseUrl, ENDPOINT), {
    method: 'POST',
    headers: headers(deps.settings, {
      'Content-Type': 'application/json',
      'Idempotency-Key': item.id,
    }),
    body: JSON.stringify(item.payload.administration),
  });
  const at = now();
  const attempts = item.attempts + 1;

  if (res.status === 201 || res.status === 200) {
    const runId =
      res.body && typeof res.body === 'object' && 'scoring_run_id' in res.body
        ? String((res.body as { scoring_run_id: unknown }).scoring_run_id)
        : null;
    const done: OutboxItem = {
      ...item,
      status: 'synced',
      attempts,
      lastHttpStatus: res.status,
      lastError: null,
      updatedAt: at.toISOString(),
      syncedAt: at.toISOString(),
      serverScoringRunId: runId,
    };
    await deps.store.putOutbox(done);
    await deps.store.audit(actor, 'sync_success', {
      ...ref,
      http_status: res.status,
      scoring_run_id: runId,
    });
    return done;
  }

  const error = res.error ?? `HTTP ${res.status}: ${describe(res.body)}`.trim();
  if (isRetryable(res.status)) {
    const next: OutboxItem = {
      ...item,
      attempts,
      lastHttpStatus: res.status,
      lastError: error,
      updatedAt: at.toISOString(),
      nextAttemptAt: at.getTime() + backoffMs(attempts),
    };
    await deps.store.putOutbox(next);
    await deps.store.audit(actor, 'sync_retry_scheduled', {
      ...ref,
      http_status: res.status,
      error,
    });
    return next;
  }
  const rejected: OutboxItem = {
    ...item,
    status: 'rejected',
    attempts,
    lastHttpStatus: res.status,
    lastError: error,
    updatedAt: at.toISOString(),
  };
  await deps.store.putOutbox(rejected);
  await deps.store.audit(actor, 'sync_rejected', { ...ref, http_status: res.status, error });
  return rejected;
}

/** Send every due pending item (all pending items when `force`). Runs items one at a time. */
export async function syncOutbox(
  deps: SyncDeps,
  opts: { force?: boolean } = {},
): Promise<SyncSummary> {
  const now = deps.now ?? (() => new Date());
  if (!deps.settings.apiBaseUrl)
    return { attempted: 0, synced: 0, deduplicated: 0, rejected: 0, retrying: 0 };
  const due = (await deps.store.listOutbox()).filter(
    (i) => i.status === 'pending' && (opts.force || i.nextAttemptAt <= now().getTime()),
  );
  let synced = 0;
  let deduplicated = 0;
  let rejected = 0;
  let retrying = 0;
  for (const item of due) {
    const out = await syncItem(deps, item);
    if (out.status === 'synced') {
      if (out.attempts === item.attempts) deduplicated += 1;
      else synced += 1;
    } else if (out.status === 'rejected') rejected += 1;
    else retrying += 1;
  }
  return { attempted: due.length, synced, deduplicated, rejected, retrying };
}

/** Administrator action: put a rejected item back in the queue (e.g. after consent was recorded). */
export async function requeue(
  store: CardSortStore,
  id: string,
  actor: string,
  now = new Date(),
): Promise<void> {
  const item = await store.getOutbox(id);
  if (item?.status !== 'rejected') return;
  await store.putOutbox({
    ...item,
    status: 'pending',
    nextAttemptAt: 0,
    updatedAt: now.toISOString(),
  });
  await store.audit(actor, 'sync_requeued', { outbox_id: id, session_id: item.sessionId });
}
