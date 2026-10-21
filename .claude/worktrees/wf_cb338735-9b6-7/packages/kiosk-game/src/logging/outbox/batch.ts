/**
 * UploadBatch assembly (ING-02 client side): session-ordered chunks, canonical-JSON sha256.
 * The browser build sends `none_dev` plaintext chunks; the Electron build will seal chunks with the
 * per-session DEK (X25519 sealed box + AES-256-GCM) behind the same function signature.
 */
import type { EventEnvelope, PlainSessionChunk, UploadBatch } from '@shriii/contracts';
import { sha256Canonical } from '../hash.ts';
import type { BatchLimits, EventRow } from './types.ts';

/**
 * Pick rows for the next batch: whole sessions in creation order, events in seq order, stopping at
 * the event or byte limit (a single oversized event still goes alone so nothing is stuck forever).
 */
export function selectBatchRows(
  sessionsInOrder: readonly { readonly rows: readonly EventRow[] }[],
  limits: BatchLimits,
): EventRow[] {
  const out: EventRow[] = [];
  let bytes = 0;
  for (const { rows } of sessionsInOrder) {
    for (const row of rows) {
      if (out.length >= limits.maxEvents) return out;
      if (out.length > 0 && bytes + row.bytes > limits.maxBytes) return out;
      out.push(row);
      bytes += row.bytes;
    }
  }
  return out;
}

/** Assemble an UploadBatch from selected rows (rows must be grouped by session, seq ascending). */
export function assembleBatch(options: {
  readonly batchId: string;
  readonly kioskId: string;
  readonly kioskTWall: string;
  readonly rows: readonly EventRow[];
}): UploadBatch {
  const chunks: PlainSessionChunk[] = [];
  let current: { sessionId: string; events: EventEnvelope[]; first: number; last: number } | null =
    null;
  const flush = (): void => {
    if (!current || current.events.length === 0) return;
    chunks.push({
      encryption: 'none_dev',
      session_id: current.sessionId,
      first_seq: current.first,
      last_seq: current.last,
      event_count: current.events.length,
      events: current.events as [EventEnvelope, ...EventEnvelope[]],
    });
  };
  for (const row of options.rows) {
    if (!current || current.sessionId !== row.sessionId) {
      flush();
      current = { sessionId: row.sessionId, events: [], first: row.seq, last: row.seq };
    }
    current.events.push(row.event as EventEnvelope);
    current.last = row.seq;
  }
  flush();
  if (chunks.length === 0) throw new Error('assembleBatch: no rows');
  return {
    schema_version: '1.0',
    batch_id: options.batchId,
    kiosk_id: options.kioskId,
    kiosk_t_wall: options.kioskTWall,
    sha256: sha256Canonical(chunks),
    event_count: options.rows.length,
    session_chunks: chunks as UploadBatch['session_chunks'],
  };
}
