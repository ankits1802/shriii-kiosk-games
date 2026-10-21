import { describe, expect, it } from 'vitest';
import type { CardSortStore } from '../src/data/store.ts';
import { backoffMs, ENDPOINT, requeue, syncOutbox } from '../src/sync/outbox.ts';
import { completedSession, memoryStore, SETTINGS } from './helpers.ts';

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Fake API: scripted POST outcomes; GET returns what has been "stored" so far. */
interface StoredRow {
  item_id: string;
  raw_response: number | null;
  device_id: string;
  administrator_id: string | null;
}

function fakeApi(postOutcomes: (number | 'network')[], preexisting: StoredRow[] = []) {
  const calls: Call[] = [];
  const stored: StoredRow[] = [...preexisting];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (method === 'GET') return new Response(JSON.stringify(stored), { status: 200 });
    const outcome = postOutcomes.shift() ?? 201;
    const body = JSON.parse(String(init?.body)) as {
      device_id: string;
      administrator_id: string | null;
      responses: { item_id: string; raw_response: number | null }[];
    };
    const rows = body.responses.map((r) => ({
      item_id: r.item_id,
      raw_response: r.raw_response,
      device_id: body.device_id,
      administrator_id: body.administrator_id,
    }));
    if (outcome === 'network') {
      // The request reached the server and was stored, but the response was lost.
      stored.push(...rows);
      throw new TypeError('Failed to fetch');
    }
    if (outcome === 201) {
      stored.push(...rows);
      return new Response(
        JSON.stringify({ responses: [], scoring_run_id: '0b0e4c1e-8d47-4a43-9d1e-5f0e2a1c3b4d' }),
        {
          status: 201,
        },
      );
    }
    return new Response(JSON.stringify({ detail: { code: 'x', message: `status ${outcome}` } }), {
      status: outcome,
    });
  }) as typeof fetch;
  return { calls, stored, fetchFn };
}

async function setup(): Promise<CardSortStore> {
  const store = await memoryStore();
  await completedSession(store);
  return store;
}

describe('offline sync queue', () => {
  it('posts AdministrationIn with bearer token and idempotency key, then marks synced', async () => {
    const store = await setup();
    const api = fakeApi([201]);
    const summary = await syncOutbox({ store, settings: SETTINGS, fetch: api.fetchFn });
    expect(summary).toMatchObject({ attempted: 1, synced: 1, rejected: 0, retrying: 0 });
    const post = api.calls[0];
    if (!post) throw new Error('no request');
    expect(post?.method).toBe('POST');
    expect(post?.url).toBe(`https://api.test${ENDPOINT}`);
    expect(post?.headers.Authorization).toBe('Bearer kdt_test');
    expect(post?.headers['Idempotency-Key']).toBeTruthy();
    expect((post.body as { instrument_id: string }).instrument_id).toBe('card_sort_criterion');
    const [item] = await store.listOutbox();
    expect(item?.status).toBe('synced');
    expect(item?.serverScoringRunId).toBe('0b0e4c1e-8d47-4a43-9d1e-5f0e2a1c3b4d');
    // Nothing left to send.
    expect((await syncOutbox({ store, settings: SETTINGS, fetch: api.fetchFn })).attempted).toBe(0);
  });

  it('a lost response is retried without duplicating the stored administration', async () => {
    const store = await setup();
    const api = fakeApi(['network', 201]);
    let now = new Date('2026-10-22T10:00:00Z');
    const deps = { store, settings: SETTINGS, fetch: api.fetchFn, now: () => now };
    expect((await syncOutbox(deps)).retrying).toBe(1);
    let [item] = await store.listOutbox();
    expect(item?.status).toBe('pending');
    expect(item?.nextAttemptAt).toBe(now.getTime() + backoffMs(1));
    // Not due yet.
    expect((await syncOutbox(deps)).attempted).toBe(0);
    now = new Date(now.getTime() + backoffMs(1));
    const second = await syncOutbox(deps);
    expect(second.deduplicated).toBe(1);
    [item] = await store.listOutbox();
    expect(item?.status).toBe('synced');
    expect(api.stored).toHaveLength(3); // one copy of the three measures
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('an earlier administration of the same pid and occasion is not mistaken for this one', async () => {
    const store = await setup();
    const [queued] = await store.listOutbox();
    const earlier: StoredRow[] = (queued?.payload.administration.responses ?? []).map((r) => ({
      item_id: r.item_id,
      raw_response: (r.raw_response ?? 0) + 1,
      device_id: 'other-tablet',
      administrator_id: 'admin.other',
    }));
    const api = fakeApi([503, 201], earlier);
    const deps = { store, settings: SETTINGS, fetch: api.fetchFn };
    expect((await syncOutbox(deps, { force: true })).retrying).toBe(1);
    const second = await syncOutbox(deps, { force: true });
    expect(second.synced).toBe(1);
    expect(second.deduplicated).toBe(0);
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(2);
  });

  it('server errors back off; definitive 4xx is rejected until requeued', async () => {
    const store = await setup();
    const api = fakeApi([503, 409, 201]);
    const deps = { store, settings: SETTINGS, fetch: api.fetchFn };
    expect((await syncOutbox(deps, { force: true })).retrying).toBe(1);
    expect((await syncOutbox(deps, { force: true })).rejected).toBe(1);
    let [item] = await store.listOutbox();
    expect(item?.status).toBe('rejected');
    expect(item?.lastError).toContain('409');
    expect((await syncOutbox(deps, { force: true })).attempted).toBe(0);
    await requeue(store, item?.id ?? '', 'admin.asha');
    expect((await syncOutbox(deps, { force: true })).synced).toBe(1);
    [item] = await store.listOutbox();
    expect(item?.status).toBe('synced');
    const events = (await store.listAudit()).map((e) => e.event);
    expect(events).toContain('sync_rejected');
    expect(events).toContain('sync_requeued');
    expect(events.at(-1)).toBe('sync_success');
  });

  it('does nothing without an API URL', async () => {
    const store = await setup();
    const api = fakeApi([]);
    const s = await syncOutbox({
      store,
      settings: { ...SETTINGS, apiBaseUrl: '' },
      fetch: api.fetchFn,
    });
    expect(s.attempted).toBe(0);
    expect(api.calls).toHaveLength(0);
  });

  it('backoff doubles and is capped', () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(60_000);
    expect(backoffMs(20)).toBe(60 * 60_000);
  });
});
