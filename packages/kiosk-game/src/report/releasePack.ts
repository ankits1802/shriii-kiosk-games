/**
 * REP-03 signed, expiring release pack. The kiosk fails closed: a missing, malformed, unsigned,
 * wrongly-signed, unknown-key, expired, not-yet-valid or dictionary-mismatched pack yields NO pack, and
 * the report screen shows the thank-you scene.
 *
 * Signature: Ed25519 over the RFC 8785 (JCS) canonical JSON of the pack with the `signature` member
 * removed, verified with WebCrypto. The Python signer must use the same canonical form.
 */
import type { ReleasePack } from '@shriii/contracts';
import { readReleasePack } from '@shriii/contracts/validators/release-pack.reader';
import type { ReleasePackReader } from '../core/contracts.ts';

export type PackFailure =
  | 'missing'
  | 'malformed'
  | 'unknown_key'
  | 'bad_signature'
  | 'unsupported_crypto'
  | 'expired'
  | 'not_yet_valid'
  | 'dictionary_mismatch';

export type PackVerification =
  | { readonly status: 'valid'; readonly pack: ReleasePack }
  | { readonly status: PackFailure; readonly detail?: string };

/** Trust anchors and the dictionary this kiosk build is pinned to. */
export interface ReleasePackTrust {
  /** key_id -> base64 raw 32-byte Ed25519 public key. */
  readonly publicKeys: Readonly<Record<string, string>>;
  readonly dictionary: {
    readonly versions: { readonly A: string; readonly B: string };
    readonly sha256: { readonly A: string; readonly B: string };
  };
  /** Allowed clock skew for `issued_at` (default 5 minutes). */
  readonly skewMs?: number;
}

/** RFC 8785 JSON Canonicalization Scheme (sorted keys by UTF-16 code units, ES number formatting). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  throw new Error(`canonicalJson: unsupported ${typeof value}`);
}

/** Bytes that are signed: canonical JSON of the pack without its signature. */
export function signingPayload(pack: ReleasePack | Record<string, unknown>): Uint8Array {
  const { signature: _omit, ...rest } = pack as Record<string, unknown>;
  return new TextEncoder().encode(canonicalJson(rest));
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Verify a candidate pack. Never throws; every failure is a fail-closed status. */
export async function verifyReleasePack(
  raw: unknown,
  trust: ReleasePackTrust,
  now: Date,
): Promise<PackVerification> {
  if (raw === null || raw === undefined) return { status: 'missing' };
  if (!readReleasePack(raw))
    return { status: 'malformed', detail: readReleasePack.errors?.[0]?.message ?? 'schema' };
  const pack = raw as ReleasePack;
  if (pack.signature.algorithm !== 'ed25519')
    return { status: 'bad_signature', detail: 'algorithm' };
  const keyB64 = trust.publicKeys[pack.signature.key_id];
  if (!keyB64) return { status: 'unknown_key', detail: pack.signature.key_id };
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return { status: 'unsupported_crypto' };
  let ok = false;
  try {
    const key = await subtle.importKey(
      'raw',
      b64ToBytes(keyB64) as BufferSource,
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    ok = await subtle.verify(
      { name: 'Ed25519' },
      key,
      b64ToBytes(pack.signature.value) as BufferSource,
      signingPayload(pack) as BufferSource,
    );
  } catch (err) {
    return {
      status: 'unsupported_crypto',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (!ok) return { status: 'bad_signature' };
  const t = now.getTime();
  if (t >= Date.parse(pack.expires_at)) return { status: 'expired' };
  if (t + (trust.skewMs ?? 5 * 60_000) < Date.parse(pack.issued_at))
    return { status: 'not_yet_valid' };
  const d = trust.dictionary;
  if (
    pack.dictionary_versions.A !== d.versions.A ||
    pack.dictionary_versions.B !== d.versions.B ||
    pack.dictionary_sha256.A.toLowerCase() !== d.sha256.A.toLowerCase() ||
    pack.dictionary_sha256.B.toLowerCase() !== d.sha256.B.toLowerCase()
  ) {
    return { status: 'dictionary_mismatch' };
  }
  return { status: 'valid', pack };
}

/** A reader over a verification result that re-checks expiry on every call (long-running kiosks). */
export interface VerifiedPackReader extends ReleasePackReader {
  readonly verification: PackVerification;
  /** Why `current()` is null right now (null when a pack is available). */
  failure(): PackFailure | null;
}

export function createReleasePackReader(
  verification: PackVerification,
  now: () => Date = () => new Date(),
): VerifiedPackReader {
  return {
    verification,
    current(): ReleasePack | null {
      if (verification.status !== 'valid') return null;
      return now().getTime() < Date.parse(verification.pack.expires_at) ? verification.pack : null;
    },
    failure(): PackFailure | null {
      if (verification.status !== 'valid') return verification.status;
      return now().getTime() < Date.parse(verification.pack.expires_at) ? null : 'expired';
    },
  };
}

/** A reader that never yields a pack (default before any pack is installed). */
export const NO_PACK: VerifiedPackReader = createReleasePackReader({ status: 'missing' });
