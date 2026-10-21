/**
 * IPC handlers for the preload bridge. Every payload is validated here (the renderer is treated as
 * untrusted input even though it is our own code) and every failure becomes a typed
 * {@link IpcResult} instead of a thrown error crossing the process boundary.
 * Electron-free: `main/index.ts` registers these on `ipcMain.handle` behind a sender check.
 */

import type { PrintResult, ThermalPrinter } from '@shriii/escpos-printer';
import type { OutboxHealth, SqliteOutbox } from '@shriii/outbox-sqlite';
import { OutboxFullError, SeqConflictError } from '@shriii/outbox-sqlite';
import {
  type ConsentState,
  IPC,
  type IpcResult,
  type OutboxHealthView,
  type PrinterStatusView,
  type PrintReportResult,
} from '../shared/ipc-contract.ts';

export const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Largest single event accepted over IPC (serialised JSON). */
export const MAX_EVENT_BYTES = 64 * 1024;
export const MAX_PRINT_WIDTH = 4096;
export const MAX_PRINT_HEIGHT = 8192;

export class InvalidPayload extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPayload';
  }
}

function obj(p: unknown): Record<string, unknown> {
  if (p === null || typeof p !== 'object' || Array.isArray(p))
    throw new InvalidPayload('payload must be an object');
  return p as Record<string, unknown>;
}

function sessionId(p: Record<string, unknown>): string {
  const v = p.sessionId;
  if (typeof v !== 'string' || !UUIDV7.test(v))
    throw new InvalidPayload('sessionId must be a UUIDv7');
  return v;
}

function seq(v: unknown): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)
    throw new InvalidPayload('seq must be a non-negative integer');
  return v;
}

function event(v: unknown, sid: string, s: number): unknown {
  if (v === null || typeof v !== 'object' || Array.isArray(v))
    throw new InvalidPayload('event must be an object');
  const json = JSON.stringify(v);
  if (Buffer.byteLength(json, 'utf8') > MAX_EVENT_BYTES)
    throw new InvalidPayload('event too large');
  const e = v as { session_id?: unknown; seq?: unknown };
  if (e.session_id !== undefined && e.session_id !== sid)
    throw new InvalidPayload('event session_id mismatch');
  if (e.seq !== undefined && e.seq !== s) throw new InvalidPayload('event seq mismatch');
  return JSON.parse(json) as unknown;
}

function fail(err: unknown): IpcResult<never> {
  if (err instanceof InvalidPayload) return { ok: false, code: 'invalid', message: err.message };
  if (err instanceof SeqConflictError) {
    return { ok: false, code: 'seq_conflict', message: err.message, expected: err.expected };
  }
  if (err instanceof OutboxFullError)
    return { ok: false, code: 'outbox_full', message: err.message };
  return { ok: false, code: 'error', message: err instanceof Error ? err.message : String(err) };
}

async function wrap<T>(fn: () => T | Promise<T>): Promise<IpcResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return fail(err);
  }
}

export function healthView(h: OutboxHealth): OutboxHealthView {
  return {
    canStartSession: h.canStartSession,
    alerts: h.alerts,
    unsyncedEvents: h.unsyncedEvents,
    oldestUnsyncedAgeMs: h.oldestUnsyncedAgeMs,
    storedBytes: h.storedBytes,
    quotaBytes: h.quotaBytes,
  };
}

export interface HandlerDeps {
  /** Null when the outbox could not be opened (e.g. no backend key in a packaged build). */
  readonly outbox: SqliteOutbox | null;
  readonly printer: ThermalPrinter | null;
  /** Called after any write so the uploader can schedule work. */
  readonly onOutboxWrite?: () => void;
}

export type Handler = (payload: unknown) => Promise<IpcResult<unknown>>;

const CONSENT: readonly ConsentState[] = ['pending', 'granted', 'declined'];

export function createHandlers(deps: HandlerDeps): Record<string, Handler> {
  const withOutbox = <T>(fn: (o: SqliteOutbox) => T | Promise<T>): Promise<IpcResult<T>> => {
    const o = deps.outbox;
    if (!o)
      return Promise.resolve({ ok: false, code: 'unavailable', message: 'outbox unavailable' });
    return wrap(() => fn(o));
  };
  const written = <T>(v: T): T => {
    deps.onOutboxWrite?.();
    return v;
  };
  return {
    [IPC.outboxAppendAt]: (p) =>
      withOutbox((o) => {
        const b = obj(p);
        const sid = sessionId(b);
        const s = seq(b.seq);
        return written(o.appendAtSync(sid, s, event(b.event, sid, s)));
      }),
    [IPC.outboxNextSeq]: (p) => withOutbox((o) => o.nextSeq(sessionId(obj(p)))),
    [IPC.outboxSetConsent]: (p) =>
      withOutbox(async (o) => {
        const b = obj(p);
        const state = b.state as ConsentState;
        if (!CONSENT.includes(state)) throw new InvalidPayload('invalid consent state');
        await o.setConsent(sessionId(b), state);
        return written(null);
      }),
    [IPC.outboxPurgeSession]: (p) =>
      withOutbox((o) => {
        const b = obj(p);
        const sid = sessionId(b);
        let tombstone: { seq: number; event: unknown } | null = null;
        if (b.tombstone !== null && b.tombstone !== undefined) {
          const t = obj(b.tombstone);
          const s = seq(t.seq);
          tombstone = { seq: s, event: event(t.event, sid, s) };
        }
        o.purgeSessionAtSync(sid, tombstone);
        return written(null);
      }),
    [IPC.outboxCloseSession]: (p) =>
      withOutbox(async (o) => {
        await o.closeSession(sessionId(obj(p)));
        return written(null);
      }),
    [IPC.outboxRecordDecline]: () =>
      withOutbox(async (o) => {
        await o.recordDecline();
        return null;
      }),
    [IPC.outboxStats]: () => withOutbox((o) => o.stats()),
    [IPC.outboxOpenSessions]: () => withOutbox((o) => o.openSessions()),
    [IPC.outboxSessionEvents]: (p) => withOutbox((o) => o.sessionEvents(sessionId(obj(p)))),
    [IPC.outboxPendingCount]: () => withOutbox((o) => o.pendingCount()),
    [IPC.outboxHealth]: () => withOutbox((o) => healthView(o.healthSync())),
    [IPC.printerPrint]: (p) =>
      wrap(async (): Promise<PrintReportResult> => {
        const printer = deps.printer;
        if (!printer) return { ok: false, reason: 'no_printer' };
        const b = obj(p);
        const qrUrl = b.qrUrl === undefined || b.qrUrl === null ? null : b.qrUrl;
        if (
          qrUrl !== null &&
          (typeof qrUrl !== 'string' || qrUrl.length > 512 || !/^https:\/\//.test(qrUrl))
        ) {
          throw new InvalidPayload('qrUrl must be an https URL of at most 512 characters');
        }
        let image: { width: number; height: number; data: Uint8Array } | undefined;
        if (b.rgba !== undefined && b.rgba !== null) {
          const w = b.width;
          const h = b.height;
          if (!(b.rgba instanceof Uint8Array))
            throw new InvalidPayload('rgba must be a Uint8Array');
          if (
            typeof w !== 'number' ||
            typeof h !== 'number' ||
            !Number.isInteger(w) ||
            !Number.isInteger(h)
          ) {
            throw new InvalidPayload('width and height must be integers');
          }
          if (w < 1 || h < 1 || w > MAX_PRINT_WIDTH || h > MAX_PRINT_HEIGHT)
            throw new InvalidPayload('image size out of range');
          if (b.rgba.length !== w * h * 4)
            throw new InvalidPayload('rgba length != width * height * 4');
          image = { width: w, height: h, data: b.rgba };
        }
        if (!image && !qrUrl) throw new InvalidPayload('nothing to print');
        const r: PrintResult = await printer.printReport({ ...(image ? { image } : {}), qrUrl });
        return r.ok ? { ok: true, paperNearEnd: r.paperNearEnd } : { ok: false, reason: r.reason };
      }),
    [IPC.printerStatus]: () =>
      wrap(async (): Promise<PrinterStatusView> => {
        const printer = deps.printer;
        if (!printer) return { available: false, description: 'none' };
        try {
          const s = await printer.status();
          return {
            available: true,
            description: printer.description,
            online: s.online,
            paperNearEnd: s.paperNearEnd,
            paperOut: s.paperOut,
            coverOpen: s.coverOpen,
          };
        } catch (err) {
          return {
            available: false,
            description: printer.description,
            error: (err as Error).message,
          };
        }
      }),
  };
}
