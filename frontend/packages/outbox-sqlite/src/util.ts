/** Canonical JSON, SHA-256 and UUIDv7 helpers (byte-compatible with kiosk-game `logging/hash.ts`). */
import { createHash, randomBytes } from 'node:crypto';

/**
 * Canonical JSON: keys sorted by UTF-16 code unit order, no whitespace, `undefined` members dropped,
 * non-finite numbers rejected. Matches Python `json.dumps(v, sort_keys=True, separators=(",", ":"),
 * ensure_ascii=False)` for contract shapes; `UploadBatch.sha256` is computed over it.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((k) => record[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }
}

export function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
let lastMs = -1;
let counter = 0;

/** RFC 9562 UUIDv7 with a monotonic 12-bit counter within a millisecond. */
export function uuidv7(nowMs: number = Date.now()): string {
  const bytes = randomBytes(16);
  let ms = Math.max(0, Math.floor(nowMs));
  if (ms <= lastMs) {
    ms = lastMs;
    counter += 1;
    if (counter > 0xfff) {
      ms += 1;
      counter = (bytes[6] ?? 0) & 0x7f;
    }
  } else {
    counter = (((bytes[6] ?? 0) & 0x07) << 8) | (bytes[7] ?? 0);
  }
  lastMs = ms;
  const high = Math.floor(ms / 0x1_0000_0000);
  const low = ms >>> 0;
  bytes[0] = (high >>> 8) & 0xff;
  bytes[1] = high & 0xff;
  bytes[2] = (low >>> 24) & 0xff;
  bytes[3] = (low >>> 16) & 0xff;
  bytes[4] = (low >>> 8) & 0xff;
  bytes[5] = low & 0xff;
  bytes[6] = 0x70 | ((counter >>> 8) & 0x0f);
  bytes[7] = counter & 0xff;
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  let out = '';
  for (let i = 0; i < 16; i += 1) {
    if (i === 4 || i === 6 || i === 8 || i === 10) out += '-';
    out += HEX[bytes[i] ?? 0];
  }
  return out;
}

export function utf8Length(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}
