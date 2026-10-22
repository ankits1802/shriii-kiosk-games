/**
 * Canonical JSON, content hashing and structural diffs for configuration review.
 *
 * Canonical form: object keys sorted by code point, no insignificant whitespace, arrays in order.
 * Two configs that differ only in key order or formatting hash the same, so a reviewer sees only
 * real changes. (Server hashes of content files are over file bytes and are shown separately.)
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deterministic JSON text with sorted keys. Throws on values JSON cannot represent. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite number in JSON value');
    return JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  throw new TypeError(`unsupported JSON value: ${typeof value}`);
}

/** Lower-case hex SHA-256 of a UTF-8 string (Web Crypto; available in browsers and Node ≥ 19). */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export type DiffKind = 'added' | 'removed' | 'changed';

export interface DiffEntry {
  /** JSON pointer (RFC 6901) of the changed node, e.g. `/blocks/1/trials`. */
  readonly path: string;
  readonly kind: DiffKind;
  readonly before?: unknown;
  readonly after?: unknown;
}

function escapePointer(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

/** Structural diff: leaf-level changes, arrays compared index by index. */
export function jsonDiff(before: unknown, after: unknown, path = ''): DiffEntry[] {
  if (Array.isArray(before) && Array.isArray(after)) {
    const out: DiffEntry[] = [];
    const n = Math.max(before.length, after.length);
    for (let i = 0; i < n; i += 1) {
      const p = `${path}/${i}`;
      if (i >= before.length) out.push({ path: p, kind: 'added', after: after[i] });
      else if (i >= after.length) out.push({ path: p, kind: 'removed', before: before[i] });
      else out.push(...jsonDiff(before[i], after[i], p));
    }
    return out;
  }
  if (isPlainObject(before) && isPlainObject(after)) {
    const out: DiffEntry[] = [];
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const k of keys) {
      const p = `${path}/${escapePointer(k)}`;
      if (!(k in before)) out.push({ path: p, kind: 'added', after: after[k] });
      else if (!(k in after)) out.push({ path: p, kind: 'removed', before: before[k] });
      else out.push(...jsonDiff(before[k], after[k], p));
    }
    return out;
  }
  if (canonicalJson(before) === canonicalJson(after)) return [];
  return [{ path: path || '/', kind: 'changed', before, after }];
}

/** True when `path` equals `prefix` or lies under it (pointer segments, not string prefixes). */
export function pointerWithin(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** Parse JSON text, returning a positioned error message instead of throwing. */
export function parseJson(
  text: string,
): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'invalid JSON' };
  }
}

/** Compare dotted numeric versions (`0.10.0` > `0.9.3`). Non-numeric parts compare as text. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/);
  const pb = b.split(/[.+-]/);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i += 1) {
    const x = pa[i] ?? '0';
    const y = pb[i] ?? '0';
    const nx = Number(x);
    const ny = Number(y);
    if (Number.isInteger(nx) && Number.isInteger(ny)) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** Trigger a browser download of text content. */
export function downloadText(fileName: string, text: string, mime = 'application/json'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
