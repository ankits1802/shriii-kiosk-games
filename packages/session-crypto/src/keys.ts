/**
 * Backend recipient keys and rotation (KSK-07, PRV-01).
 *
 * The backend publishes X25519 public keys with a key id (`kid`) and a validity window. The kiosk
 * seals each session DEK to the key that is current when the session starts. Rotation rules:
 * - `notBefore` (ms since epoch): the kiosk may start sealing to the key from this instant.
 * - `notAfter` (ms since epoch, optional): after this instant the kiosk must not seal to the key any
 *   more, and DEKs of still-unsynced sessions sealed to it are re-sealed to the current key before
 *   upload (the backend keeps the old private key until every sealed DEK it might receive has aged
 *   out of the kiosk retention window).
 * - Among keys valid at an instant, the one with the latest `notBefore` is current.
 */
import { fromBase64, toBase64 } from './bytes.ts';
import { generateKeyPair, HPKE_SIZES } from './hpke.ts';

export const KID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export interface RecipientKey {
  readonly kid: string;
  /** Raw 32-byte X25519 public key. */
  readonly publicKey: Uint8Array;
  readonly notBefore: number;
  readonly notAfter: number | null;
}

/** JSON form of a recipient key (as distributed in the signed kiosk policy). */
export interface RecipientKeyJson {
  readonly kid: string;
  readonly public_key: string;
  readonly not_before: string;
  readonly not_after?: string | null;
}

export class NoActiveKeyError extends Error {
  constructor(nowMs: number) {
    super(`no recipient key is valid at ${new Date(nowMs).toISOString()}`);
    this.name = 'NoActiveKeyError';
  }
}

function validateKey(key: RecipientKey): RecipientKey {
  if (!KID_PATTERN.test(key.kid)) throw new TypeError(`invalid kid: ${key.kid}`);
  if (key.publicKey.length !== HPKE_SIZES.N_PK) throw new TypeError(`key ${key.kid}: bad length`);
  if (!Number.isFinite(key.notBefore)) throw new TypeError(`key ${key.kid}: bad notBefore`);
  if (key.notAfter !== null && !(key.notAfter > key.notBefore)) {
    throw new TypeError(`key ${key.kid}: notAfter must be after notBefore`);
  }
  return key;
}

function parseInstant(text: string, field: string): number {
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) throw new TypeError(`invalid ${field}: ${text}`);
  return ms;
}

export class RecipientKeyRing {
  private readonly keys: readonly RecipientKey[];

  constructor(keys: readonly RecipientKey[]) {
    if (keys.length === 0) throw new TypeError('RecipientKeyRing needs at least one key');
    const seen = new Set<string>();
    for (const k of keys) {
      validateKey(k);
      if (seen.has(k.kid)) throw new TypeError(`duplicate kid: ${k.kid}`);
      seen.add(k.kid);
    }
    this.keys = [...keys].sort((a, b) => b.notBefore - a.notBefore);
  }

  static fromJson(keys: readonly RecipientKeyJson[]): RecipientKeyRing {
    return new RecipientKeyRing(
      keys.map((k) => ({
        kid: k.kid,
        publicKey: fromBase64(k.public_key),
        notBefore: parseInstant(k.not_before, 'not_before'),
        notAfter: k.not_after ? parseInstant(k.not_after, 'not_after') : null,
      })),
    );
  }

  toJson(): RecipientKeyJson[] {
    return this.keys.map((k) => ({
      kid: k.kid,
      public_key: toBase64(k.publicKey),
      not_before: new Date(k.notBefore).toISOString(),
      not_after: k.notAfter === null ? null : new Date(k.notAfter).toISOString(),
    }));
  }

  get size(): number {
    return this.keys.length;
  }

  get(kid: string): RecipientKey | undefined {
    return this.keys.find((k) => k.kid === kid);
  }

  /** May the kiosk seal to this key at `nowMs`? */
  isSealable(kid: string, nowMs: number): boolean {
    const k = this.get(kid);
    return k !== undefined && k.notBefore <= nowMs && (k.notAfter === null || nowMs < k.notAfter);
  }

  /** The key to seal new DEKs to at `nowMs`. */
  current(nowMs: number): RecipientKey {
    const k = this.keys.find((key) => this.isSealable(key.kid, nowMs));
    if (!k) throw new NoActiveKeyError(nowMs);
    return k;
  }
}

/** Generate a backend key pair (tooling and tests; production keys live in the backend KMS). */
export function generateRecipientKeyPair(kid: string): {
  kid: string;
  publicKey: Uint8Array;
  privateKey: Uint8Array;
} {
  if (!KID_PATTERN.test(kid)) throw new TypeError(`invalid kid: ${kid}`);
  const { pk, sk } = generateKeyPair();
  return { kid, publicKey: pk, privateKey: sk };
}
