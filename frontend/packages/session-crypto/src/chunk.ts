/**
 * Session chunk and at-rest record encryption with the session DEK (KSK-07, ING-02).
 *
 * Upload chunk (`UploadBatch.session_chunks[]` with `encryption: "x25519_sealed_aes256gcm"`):
 *   plaintext = gzip(NDJSON of the events, one JSON object per line, `\n`-terminated)
 *   ciphertext = AES-256-GCM(DEK, nonce, plaintext, aad) || tag   (base64)
 *   aad = "shriii/chunk/v1|<session_id>|<first_seq>|<last_seq>|<event_count>"
 * The AAD binds the ciphertext to the clear chunk header, so the server can trust the header fields it
 * routes on, and any edit to them is detected. Decryption also checks that the events' own
 * `session_id` and contiguous `seq` values match the header.
 *
 * At-rest record (SQLite `events.payload`): AES-256-GCM box bound to "shriii/event/v1|<sid>|<seq>".
 */
import { gunzipSync, gzipSync } from 'node:zlib';
import { concat, fromBase64, fromUtf8, toBase64, utf8 } from './bytes.ts';
import { boxOpen, boxSeal, DEK_BYTES } from './dek.ts';
import { DecryptionError } from './hpke.ts';

export const CHUNK_ENCRYPTION = 'x25519_sealed_aes256gcm' as const;

/** Decompressed-size ceiling (decompression-bomb guard). A 500-event batch is far below this. */
export const MAX_CHUNK_PLAINTEXT_BYTES = 16 * 1024 * 1024;

export interface ChunkHeader {
  readonly sessionId: string;
  readonly firstSeq: number;
  readonly lastSeq: number;
  readonly eventCount: number;
}

export function chunkAad(h: ChunkHeader): Uint8Array {
  return utf8(`shriii/chunk/v1|${h.sessionId}|${h.firstSeq}|${h.lastSeq}|${h.eventCount}`);
}

export function eventAad(sessionId: string, seq: number): Uint8Array {
  return utf8(`shriii/event/v1|${sessionId}|${seq}`);
}

/** NDJSON serialisation used inside chunks. */
export function toNdjson(events: readonly unknown[]): Uint8Array {
  return utf8(events.map((e) => `${JSON.stringify(e)}\n`).join(''));
}

export function fromNdjson(bytes: Uint8Array): unknown[] {
  const text = fromUtf8(bytes);
  if (text.length > 0 && !text.endsWith('\n')) throw new DecryptionError('NDJSON not terminated');
  return text
    .split('\n')
    .slice(0, -1)
    .map((line) => JSON.parse(line) as unknown);
}

export interface EncryptedChunkBody {
  /** base64 12-byte nonce. */
  readonly nonce: string;
  /** base64 ciphertext || tag. */
  readonly ciphertext: string;
}

/** Encrypt a session's events for upload. Events must be seq-ordered and contiguous. */
export function encryptChunk(
  dek: Uint8Array,
  header: ChunkHeader,
  events: readonly unknown[],
): EncryptedChunkBody {
  if (dek.length !== DEK_BYTES) throw new RangeError('DEK must be 32 bytes');
  if (events.length !== header.eventCount) throw new RangeError('event_count mismatch');
  if (header.lastSeq - header.firstSeq + 1 !== header.eventCount) {
    throw new RangeError('first_seq..last_seq must cover event_count contiguous seqs');
  }
  const compressed = new Uint8Array(gzipSync(toNdjson(events), { level: 6 }));
  const box = boxSeal(dek, chunkAad(header), compressed);
  return { nonce: toBase64(box.subarray(0, 12)), ciphertext: toBase64(box.subarray(12)) };
}

function checkEvents(header: ChunkHeader, events: readonly unknown[]): void {
  if (events.length !== header.eventCount) throw new DecryptionError('event_count mismatch');
  events.forEach((e, i) => {
    const ev = e as { session_id?: unknown; seq?: unknown } | null;
    if (ev === null || typeof ev !== 'object') throw new DecryptionError('event is not an object');
    if (ev.session_id !== header.sessionId) throw new DecryptionError('event session_id mismatch');
    if (ev.seq !== header.firstSeq + i) throw new DecryptionError('event seq is not contiguous');
  });
}

/** Decrypt an uploaded chunk back to its events (reference / tests; the API uses the Python port). */
export function decryptChunk(
  dek: Uint8Array,
  header: ChunkHeader,
  body: EncryptedChunkBody,
  options: { readonly verifyEvents?: boolean } = {},
): unknown[] {
  let nonce: Uint8Array;
  let ciphertext: Uint8Array;
  try {
    nonce = fromBase64(body.nonce);
    ciphertext = fromBase64(body.ciphertext);
  } catch {
    throw new DecryptionError('chunk fields are not base64');
  }
  if (nonce.length !== 12) throw new DecryptionError('nonce must be 12 bytes');
  const compressed = boxOpen(dek, chunkAad(header), concat(nonce, ciphertext));
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(gunzipSync(compressed, { maxOutputLength: MAX_CHUNK_PLAINTEXT_BYTES }));
  } catch {
    throw new DecryptionError('chunk payload is not valid gzip or too large');
  }
  let events: unknown[];
  try {
    events = fromNdjson(plain);
  } catch (error) {
    if (error instanceof DecryptionError) throw error;
    throw new DecryptionError('chunk payload is not valid NDJSON');
  }
  if (options.verifyEvents !== false) checkEvents(header, events);
  return events;
}

/** Encrypt one stored event (JSON text) at rest. */
export function encryptRecord(
  dek: Uint8Array,
  sessionId: string,
  seq: number,
  json: string,
): Uint8Array {
  return boxSeal(dek, eventAad(sessionId, seq), utf8(json));
}

export function decryptRecord(
  dek: Uint8Array,
  sessionId: string,
  seq: number,
  box: Uint8Array,
): string {
  return fromUtf8(boxOpen(dek, eventAad(sessionId, seq), box));
}
