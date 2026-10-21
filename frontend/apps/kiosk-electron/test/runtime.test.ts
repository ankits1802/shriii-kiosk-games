import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { UploadBatch, UploadBatchResult } from '@shriii/contracts';
import { ThermalPrinter, VirtualPrinter } from '@shriii/escpos-printer';
import { SqliteOutbox } from '@shriii/outbox-sqlite';
import {
  decryptChunk,
  generateKek,
  generateRecipientKeyPair,
  openDek,
  RecipientKeyRing,
} from '@shriii/session-crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHandlers } from '../src/main/ipc-handlers.ts';
import {
  KEK_FILE,
  loadOrCreateKek,
  loadRecipientKeys,
  plainFileStore,
  type SecretStore,
} from '../src/main/keystore.ts';
import { decodeSignature, KioskUpdater, type UpdaterLike } from '../src/main/updater.ts';
import { backoffDelay, DEFAULT_BACKOFF, MainUploader } from '../src/main/uploader.ts';
import { IpcOutbox } from '../src/renderer-bridge/ipc-outbox.ts';
import { IPC, type ShriiiKioskBridge } from '../src/shared/ipc-contract.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

const SID = '01928c6e-7d3a-7b2c-8f00-1234567890ab';
const SID2 = '01928c6e-7d3a-7b2c-8f00-1234567890ac';

function env() {
  const dir = mkdtempSync(path.join(tmpdir(), 'kiosk-rt-'));
  const backend = generateRecipientKeyPair('backend-1');
  const outbox = new SqliteOutbox({
    kioskId: 'kiosk-test',
    path: path.join(dir, 'outbox.db'),
    encryption: {
      mode: 'sealed',
      kek: generateKek(),
      recipients: new RecipientKeyRing([
        { kid: 'backend-1', publicKey: backend.publicKey, notBefore: 0, notAfter: null },
      ]),
    },
  });
  const vp = new VirtualPrinter();
  const printer = new ThermalPrinter(vp);
  const onWrite = vi.fn();
  const handlers = createHandlers({ outbox, printer, onOutboxWrite: onWrite });
  cleanups.push(() => {
    outbox.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, backend, outbox, vp, printer, handlers, onWrite };
}

/** A bridge whose calls go through structured cloning into the real main-process handlers. */
function fakeBridge(handlers: ReturnType<typeof createHandlers>): ShriiiKioskBridge {
  const call = (ch: string, payload?: unknown) =>
    handlers[ch]?.(structuredClone(payload)) as Promise<never>;
  return {
    platform: 'electron',
    getInfo: async () => ({
      platform: 'electron',
      appVersion: '0',
      kioskId: 'kiosk-test',
      updateChannel: null,
      encryption: 'sealed',
      printer: 'virtual',
    }),
    relaunchToAttract: () => undefined,
    reportState: () => undefined,
    onPowerEvent: () => () => undefined,
    outbox: {
      appendAt: (sessionId, seq, event) => call(IPC.outboxAppendAt, { sessionId, seq, event }),
      nextSeq: (sessionId) => call(IPC.outboxNextSeq, { sessionId }),
      setConsent: (sessionId, state) => call(IPC.outboxSetConsent, { sessionId, state }),
      purgeSession: (sessionId, tombstone) =>
        call(IPC.outboxPurgeSession, { sessionId, tombstone: tombstone ?? null }),
      closeSession: (sessionId) => call(IPC.outboxCloseSession, { sessionId }),
      recordDecline: () => call(IPC.outboxRecordDecline),
      stats: () => call(IPC.outboxStats),
      openSessions: () => call(IPC.outboxOpenSessions),
      sessionEvents: (sessionId) => call(IPC.outboxSessionEvents, { sessionId }),
      pendingCount: () => call(IPC.outboxPendingCount),
      health: () => call(IPC.outboxHealth),
    },
    printer: {
      printReport: (req) => call(IPC.printerPrint, req),
      status: () => call(IPC.printerStatus),
    },
  };
}

const ev = (sid: string, seq: number, type = 'x', payload: Record<string, unknown> = {}) => ({
  event_id: `e-${seq}`,
  session_id: sid,
  seq,
  event_type: type,
  payload,
});

describe('IPC handlers', () => {
  it('validates payloads and maps errors to typed results', async () => {
    const { handlers, onWrite } = env();
    const h = (ch: string, p?: unknown) => handlers[ch]?.(p);
    expect(await h(IPC.outboxAppendAt, { sessionId: 'nope', seq: 0, event: {} })).toMatchObject({
      ok: false,
      code: 'invalid',
    });
    expect(await h(IPC.outboxAppendAt, { sessionId: SID, seq: -1, event: {} })).toMatchObject({
      ok: false,
      code: 'invalid',
    });
    expect(
      await h(IPC.outboxAppendAt, { sessionId: SID, seq: 0, event: ev(SID2, 0) }),
    ).toMatchObject({ ok: false, code: 'invalid' });
    expect(
      await h(IPC.outboxAppendAt, { sessionId: SID, seq: 0, event: { big: 'x'.repeat(70_000) } }),
    ).toMatchObject({ ok: false, code: 'invalid' });
    expect(await h(IPC.outboxAppendAt, null)).toMatchObject({ ok: false, code: 'invalid' });
    // Envelopes without their own session_id / seq would poison the session's upload chunks.
    expect(
      await h(IPC.outboxAppendAt, { sessionId: SID, seq: 0, event: { event_type: 'x', seq: 0 } }),
    ).toMatchObject({ ok: false, code: 'invalid' });
    expect(
      await h(IPC.outboxAppendAt, { sessionId: SID, seq: 0, event: { session_id: SID } }),
    ).toMatchObject({ ok: false, code: 'invalid' });
    expect(await h(IPC.outboxAppendAt, { sessionId: SID, seq: 0, event: ev(SID, 0) })).toEqual({
      ok: true,
      value: 0,
    });
    expect(onWrite).toHaveBeenCalledTimes(1);
    expect(
      await h(IPC.outboxAppendAt, { sessionId: SID, seq: 0, event: ev(SID, 0) }),
    ).toMatchObject({ ok: false, code: 'seq_conflict', expected: 1 });
    expect(await h(IPC.outboxSetConsent, { sessionId: SID, state: 'maybe' })).toMatchObject({
      ok: false,
      code: 'invalid',
    });
    expect(await h(IPC.outboxHealth)).toMatchObject({ ok: true, value: { canStartSession: true } });
  });

  it('reports an unavailable outbox and missing printer without throwing', async () => {
    const handlers = createHandlers({ outbox: null, printer: null });
    expect(await handlers[IPC.outboxNextSeq]?.({ sessionId: SID })).toMatchObject({
      ok: false,
      code: 'unavailable',
    });
    expect(await handlers[IPC.printerPrint]?.({ qrUrl: 'https://x.example/r' })).toEqual({
      ok: true,
      value: { ok: false, reason: 'no_printer' },
    });
    expect(await handlers[IPC.printerStatus]?.(undefined)).toEqual({
      ok: true,
      value: { available: false, description: 'none' },
    });
  });

  it('prints RGBA reports and validates image payloads', async () => {
    const { handlers, vp } = env();
    const w = 64;
    const h = 32;
    const rgba = new Uint8Array(w * h * 4).fill(0);
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    expect(
      await handlers[IPC.printerPrint]?.({
        rgba,
        width: w,
        height: h,
        qrUrl: 'https://shriii.example/r/1',
      }),
    ).toEqual({
      ok: true,
      value: { ok: true, paperNearEnd: false },
    });
    expect(vp.pages).toHaveLength(1);
    expect(await handlers[IPC.printerPrint]?.({ rgba, width: w + 1, height: h })).toMatchObject({
      ok: false,
      code: 'invalid',
    });
    expect(await handlers[IPC.printerPrint]?.({ qrUrl: 'javascript:alert(1)' })).toMatchObject({
      ok: false,
      code: 'invalid',
    });
    expect(await handlers[IPC.printerPrint]?.({})).toMatchObject({ ok: false, code: 'invalid' });
    vp.loadPaper(0);
    expect(await handlers[IPC.printerPrint]?.({ qrUrl: 'https://shriii.example/r/1' })).toEqual({
      ok: true,
      value: { ok: false, reason: 'paper_out' },
    });
    expect(await handlers[IPC.printerStatus]?.(undefined)).toMatchObject({
      ok: true,
      value: { available: true, paperOut: true },
    });
  });
});

describe('renderer IpcOutbox over the bridge', () => {
  it('keeps seq gapless across renderer reloads (stale expectations) and conflicts', async () => {
    const { handlers, outbox } = env();
    const bridge = fakeBridge(handlers);
    const a = new IpcOutbox(bridge, 'kiosk-test');
    expect(await a.append(SID, (seq) => ev(SID, seq))).toBe(0);
    expect(await a.append(SID, (seq) => ev(SID, seq))).toBe(1);
    // A second renderer instance (after a crash-reload) appends; the first one's cache is stale.
    const b = new IpcOutbox(bridge, 'kiosk-test');
    expect(await b.append(SID, (seq) => ev(SID, seq))).toBe(2);
    expect(await a.append(SID, (seq) => ev(SID, seq))).toBe(3);
    const seqs = ((await outbox.sessionEvents(SID)) as { seq: number }[]).map((e) => e.seq);
    expect(seqs).toEqual([0, 1, 2, 3]);
    expect(await a.nextBatch()).toBeNull();
  });

  it('supports consent, close (purge without consent), tombstones and stats', async () => {
    const { handlers, outbox } = env();
    const o = new IpcOutbox(fakeBridge(handlers), 'kiosk-test');
    await o.append(SID, (seq) => ev(SID, seq));
    await o.append(SID, (seq) => ev(SID, seq, 'consent.granted', { consent_kind: 'core' }));
    await o.append(SID2, (seq) => ev(SID2, seq));
    await o.closeSession(SID2);
    await o.recordDecline();
    expect((await o.stats()).sessions).toBe(1);
    expect((await o.openSessions()).map((s) => s.sessionId)).toEqual([SID]);
    await o.purgeSession(SID, (seq) => ev(SID, seq, 'session_tombstone'));
    expect(
      ((await outbox.sessionEvents(SID)) as { seq: number; event_type: string }[]).map((e) => [
        e.seq,
        e.event_type,
      ]),
    ).toEqual([[2, 'session_tombstone']]);
    expect(await o.pendingCount()).toBe(1);
  });
});

describe('main uploader', () => {
  function serverFor(backend: ReturnType<typeof generateRecipientKeyPair>) {
    const seen: UploadBatch[] = [];
    let mode: 'ok' | 'fail' | 'upgrade' = 'ok';
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (mode === 'fail') throw new Error('ECONNREFUSED');
      if (mode === 'upgrade') return new Response('', { status: 426 });
      const batch = JSON.parse(String(init?.body)) as UploadBatch;
      seen.push(batch);
      const results: UploadBatchResult['results'] = [];
      for (const c of batch.session_chunks) {
        if (c.encryption !== 'x25519_sealed_aes256gcm') throw new Error('plaintext');
        const dek = openDek({
          sealed: c.sealed_dek,
          sessionId: c.session_id,
          privateKeys: () => backend.privateKey,
        });
        const events = decryptChunk(
          dek,
          {
            sessionId: c.session_id,
            firstSeq: c.first_seq,
            lastSeq: c.last_seq,
            eventCount: c.event_count,
          },
          c,
        ) as { seq: number }[];
        for (const e of events)
          results.push({
            event_id: '01928c6e-7d3a-7b2c-8f00-000000000001',
            session_id: c.session_id,
            seq: e.seq,
            status: 'accepted',
            reason_code: null,
          });
      }
      return new Response(
        JSON.stringify({
          schema_version: '1.0',
          batch_id: batch.batch_id,
          server_received_at: new Date().toISOString(),
          clock_offset_estimate_ms: null,
          duplicate_batch: false,
          results,
          summary: {
            accepted: results.length,
            duplicate: 0,
            parked: 0,
            rejected_terminal: 0,
            retryable: 0,
          },
        }),
        { status: 200 },
      );
    });
    return { seen, fetchImpl, setMode: (m: typeof mode) => (mode = m) };
  }

  it('uploads encrypted consented batches, backs off on failure and stops on 426', async () => {
    const { outbox, backend } = env();
    await outbox.append(SID, (seq) => ev(SID, seq, 'consent.granted', { consent_kind: 'core' }));
    await outbox.append(SID, (seq) => ev(SID, seq));
    const server = serverFor(backend);
    const up = new MainUploader({
      outbox,
      apiOrigin: 'https://api.test',
      fetch: server.fetchImpl as never,
      random: () => 0.5,
    });
    expect(up.endpoint).toBe('https://api.test/api/v1/events/batch');
    server.setMode('fail');
    const failed = await up.uploadOnce();
    expect(failed).toMatchObject({ kind: 'failed' });
    expect(up.current.consecutiveFailures).toBe(1);
    server.setMode('ok');
    expect((await up.uploadOnce()).kind).toBe('sent');
    expect(server.seen).toHaveLength(1);
    expect(await outbox.pendingCount()).toBe(0);
    expect(up.current.consecutiveFailures).toBe(0);
    expect((await up.uploadOnce()).kind).toBe('empty');
    await outbox.append(SID, (seq) => ev(SID, seq));
    server.setMode('upgrade');
    expect((await up.uploadOnce()).kind).toBe('blocked');
    expect(up.current.state).toBe('blocked_upgrade_required');
    expect(await outbox.pendingCount()).toBe(1); // data kept
  });

  it('pauses while anyone uses the kiosk', async () => {
    const { outbox, backend } = env();
    const server = serverFor(backend);
    const up = new MainUploader({
      outbox,
      apiOrigin: 'https://api.test',
      fetch: server.fetchImpl as never,
    });
    up.setLifecycleState('play');
    expect(await up.uploadOnce()).toEqual({ kind: 'skipped', reason: 'paused' });
    up.setLifecycleState('attract');
    expect((await up.uploadOnce()).kind).toBe('empty');
    expect(server.fetchImpl).not.toHaveBeenCalled();
    expect(
      new MainUploader({ outbox, apiOrigin: null, fetch: server.fetchImpl as never }).current.state,
    ).toBe('disabled');
  });

  it('computes equal-jitter backoff within bounds', () => {
    expect(backoffDelay(1, DEFAULT_BACKOFF, () => 0)).toBe(500);
    expect(backoffDelay(1, DEFAULT_BACKOFF, () => 1)).toBe(1000);
    expect(backoffDelay(30, DEFAULT_BACKOFF, () => 1)).toBe(15 * 60_000);
  });
});

describe('keystore', () => {
  it('creates the KEK once and reloads it; refuses a store mismatch', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kek-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const xorStore: SecretStore = {
      protection: 'test_xor',
      encrypt: (p) => Buffer.from(Buffer.from(p).map((b) => b ^ 0x5a)),
      decrypt: (b) => Buffer.from(b.map((x) => x ^ 0x5a)).toString(),
    };
    const first = loadOrCreateKek(dir, xorStore);
    expect(first.created).toBe(true);
    const again = loadOrCreateKek(dir, xorStore);
    expect(again.created).toBe(false);
    expect(Buffer.from(again.kek).equals(Buffer.from(first.kek))).toBe(true);
    expect(
      readFileSync(path.join(dir, KEK_FILE)).includes(Buffer.from(first.kek).toString('base64')),
    ).toBe(false);
    expect(() => loadOrCreateKek(dir, plainFileStore)).toThrow(/protection/);
  });

  it('loads recipient keys from the policy file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'keys-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const k = generateRecipientKeyPair('k1');
    const file = path.join(dir, 'keys.json');
    writeFileSync(
      file,
      JSON.stringify({
        keys: [
          {
            kid: 'k1',
            public_key: Buffer.from(k.publicKey).toString('base64'),
            not_before: '2026-01-01T00:00:00Z',
          },
        ],
      }),
    );
    expect(loadRecipientKeys(file).current(Date.parse('2026-06-01T00:00:00Z')).kid).toBe('k1');
  });
});

describe('updater wiring', () => {
  function mockUpdater() {
    const listeners: Record<string, ((arg: never) => void)[]> = {};
    const u = {
      autoDownload: true,
      autoInstallOnAppQuit: true,
      allowDowngrade: true,
      allowPrerelease: false,
      setFeedURL: vi.fn(),
      checkForUpdates: vi.fn(async () => null),
      downloadUpdate: vi.fn(async () => null),
      quitAndInstall: vi.fn(),
      on: (event: string, cb: (arg: never) => void) => {
        const list = listeners[event] ?? [];
        list.push(cb);
        listeners[event] = list;
        return u;
      },
      emit: (event: string, arg: unknown) => {
        for (const cb of listeners[event] ?? []) cb(arg as never);
      },
    };
    return u;
  }
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  it('fails closed without a manifest key and refuses unsigned updates', async () => {
    const u = mockUpdater();
    const cfg = {
      feedUrl: 'https://updates.test/kiosk',
      ring: null,
      ring10Percent: 10,
      manifestPublicKey: null,
      frozenVersion: null,
      checkIntervalMs: 3_600_000,
    };
    const disabled = new KioskUpdater(
      u as unknown as UpdaterLike,
      cfg,
      'stable',
      '0.1.0',
      log,
      fetch,
    );
    expect(disabled.current).toMatchObject({ state: 'disabled' });

    const { generateKeyPairSync } = await import('node:crypto');
    const { publicKey } = generateKeyPairSync('ed25519');
    const pem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
    const fetchImpl = vi.fn(async (url: unknown) =>
      String(url).endsWith('.sig')
        ? new Response(Buffer.alloc(64).toString('base64'))
        : new Response('{}'),
    );
    const up = new KioskUpdater(
      u as unknown as UpdaterLike,
      { ...cfg, manifestPublicKey: pem },
      'stable',
      '0.1.0',
      log,
      fetchImpl as never,
    );
    up.start();
    expect(u.autoDownload).toBe(false);
    expect(u.allowDowngrade).toBe(false);
    expect(u.setFeedURL).toHaveBeenCalledWith({
      provider: 'generic',
      url: 'https://updates.test/kiosk/stable',
    });
    u.emit('update-available', { version: '0.2.0', files: [{ sha512: 'x' }] });
    await vi.waitFor(() => expect(up.current.state).toBe('rejected'));
    expect(u.downloadUpdate).not.toHaveBeenCalled();
    // A downloaded update waits for idle attract.
    u.emit('update-downloaded', { version: '0.2.0' });
    up.setLifecycleState('play', 0);
    expect(u.quitAndInstall).not.toHaveBeenCalled();
    up.setLifecycleState('attract', 1000);
    up.setLifecycleState('attract', 62_000);
    expect(u.quitAndInstall).toHaveBeenCalledTimes(1);
    up.stop();
  });

  it('decodes raw and base64 signatures', () => {
    expect(decodeSignature(new Uint8Array(64)).length).toBe(64);
    expect(
      decodeSignature(new TextEncoder().encode(Buffer.alloc(64, 1).toString('base64'))).length,
    ).toBe(64);
    expect(() => decodeSignature(new TextEncoder().encode('short'))).toThrow();
  });
});
