/**
 * Per-session data-encryption keys (KSK-07).
 *
 * Each session gets a random 256-bit DEK. Two wrapped copies exist:
 * 1. **Sealed to the backend** with RFC 9180 HPKE base mode
 *    (DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM). Uploaded as `sealed_dek`.
 * 2. **Wrapped locally** with the device key-encryption key (KEK; Electron safeStorage / TPM) so the
 *    kiosk can keep encrypting the session's events and can crypto-shred the session by deleting the
 *    wrapped copy (purge on abandon / no consent).
 *
 * Sealed DEK wire format (then base64):
 * ```
 * u8  version = 1
 * u16 kem_id (0x0020) | u16 kdf_id (0x0001) | u16 aead_id (0x0002)
 * u8  kid_len | kid (ASCII, KID_PATTERN)
 * enc (32 bytes, ephemeral X25519 public key)
 * ct  (32-byte DEK + 16-byte GCM tag)
 * ```
 * HPKE `info` = "shriii/session-dek/v1"; HPKE `aad` = header bytes (version..kid) || session_id, so a
 * sealed DEK cannot be replayed onto another session or relabelled with another kid or suite.
 */
import { randomBytes } from 'node:crypto';
import { concat, fromBase64, i2osp, toBase64, utf8 } from './bytes.ts';
import {
  AEAD_AES_256_GCM,
  type AeadId,
  aeadOpen,
  aeadSeal,
  DecryptionError,
  HPKE_SIZES,
  KDF_HKDF_SHA256,
  KEM_X25519_HKDF_SHA256,
  openBase,
  sealBase,
} from './hpke.ts';
import { KID_PATTERN, type RecipientKey } from './keys.ts';

export const DEK_BYTES = 32;
export const KEK_BYTES = 32;
export const SEALED_DEK_VERSION = 1;
export const DEK_INFO = utf8('shriii/session-dek/v1');

const NONCE_BYTES = 12;

export function generateDek(): Uint8Array {
  return new Uint8Array(randomBytes(DEK_BYTES));
}

export function generateKek(): Uint8Array {
  return new Uint8Array(randomBytes(KEK_BYTES));
}

function header(aead: AeadId, kid: string): Uint8Array {
  const kidBytes = utf8(kid);
  return concat(
    Uint8Array.of(SEALED_DEK_VERSION),
    i2osp(KEM_X25519_HKDF_SHA256, 2),
    i2osp(KDF_HKDF_SHA256, 2),
    i2osp(aead, 2),
    Uint8Array.of(kidBytes.length),
    kidBytes,
  );
}

export interface SealedDekParts {
  readonly version: number;
  readonly aead: AeadId;
  readonly kid: string;
  readonly header: Uint8Array;
  readonly enc: Uint8Array;
  readonly ciphertext: Uint8Array;
}

/** Parse (without decrypting) a base64 sealed DEK. Throws {@link DecryptionError} if malformed. */
export function parseSealedDek(sealed: string): SealedDekParts {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(sealed);
  } catch {
    throw new DecryptionError('sealed DEK is not base64');
  }
  if (bytes.length < 8) throw new DecryptionError('sealed DEK too short');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = bytes[0] ?? 0;
  if (version !== SEALED_DEK_VERSION) throw new DecryptionError(`unsupported version ${version}`);
  if (view.getUint16(1) !== KEM_X25519_HKDF_SHA256 || view.getUint16(3) !== KDF_HKDF_SHA256) {
    throw new DecryptionError('unsupported KEM/KDF');
  }
  const aead = view.getUint16(5);
  if (aead !== AEAD_AES_256_GCM) throw new DecryptionError('unsupported AEAD');
  const kidLength = bytes[7] ?? 0;
  const headerEnd = 8 + kidLength;
  const expected = headerEnd + HPKE_SIZES.N_PK + DEK_BYTES + HPKE_SIZES.N_T;
  if (bytes.length !== expected) throw new DecryptionError('sealed DEK has the wrong length');
  const kid = new TextDecoder().decode(bytes.subarray(8, headerEnd));
  if (!KID_PATTERN.test(kid)) throw new DecryptionError('sealed DEK has an invalid kid');
  return {
    version,
    aead,
    kid,
    header: bytes.slice(0, headerEnd),
    enc: bytes.slice(headerEnd, headerEnd + HPKE_SIZES.N_PK),
    ciphertext: bytes.slice(headerEnd + HPKE_SIZES.N_PK),
  };
}

/** Seal a DEK to a backend recipient key; returns base64. `ikmE` only for deterministic tests. */
export function sealDek(options: {
  readonly dek: Uint8Array;
  readonly sessionId: string;
  readonly recipient: Pick<RecipientKey, 'kid' | 'publicKey'>;
  readonly ikmE?: Uint8Array;
}): string {
  if (options.dek.length !== DEK_BYTES) throw new RangeError('DEK must be 32 bytes');
  if (!KID_PATTERN.test(options.recipient.kid)) throw new TypeError('invalid kid');
  const h = header(AEAD_AES_256_GCM, options.recipient.kid);
  const { enc, ciphertext } = sealBase(
    AEAD_AES_256_GCM,
    options.recipient.publicKey,
    DEK_INFO,
    concat(h, utf8(options.sessionId)),
    options.dek,
    options.ikmE,
  );
  return toBase64(concat(h, enc, ciphertext));
}

/** Resolve a private key by kid (backend side). */
export type PrivateKeyLookup = (kid: string) => Uint8Array | undefined;

/** Open a sealed DEK with the backend private key for its kid. */
export function openDek(options: {
  readonly sealed: string;
  readonly sessionId: string;
  readonly privateKeys: PrivateKeyLookup;
}): Uint8Array {
  const parts = parseSealedDek(options.sealed);
  const sk = options.privateKeys(parts.kid);
  if (!sk) throw new DecryptionError(`no private key for kid ${parts.kid}`);
  const dek = openBase(
    parts.aead,
    parts.enc,
    sk,
    DEK_INFO,
    concat(parts.header, utf8(options.sessionId)),
    parts.ciphertext,
  );
  if (dek.length !== DEK_BYTES) throw new DecryptionError('DEK has the wrong length');
  return dek;
}

/** Symmetric AES-256-GCM box: nonce(12) || ciphertext || tag(16). */
export function boxSeal(key: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Uint8Array {
  if (key.length !== 32) throw new RangeError('key must be 32 bytes');
  const nonce = new Uint8Array(randomBytes(NONCE_BYTES));
  return concat(nonce, aeadSeal(AEAD_AES_256_GCM, key, nonce, aad, plaintext));
}

export function boxOpen(key: Uint8Array, aad: Uint8Array, box: Uint8Array): Uint8Array {
  if (key.length !== 32) throw new RangeError('key must be 32 bytes');
  if (box.length < NONCE_BYTES + HPKE_SIZES.N_T) throw new DecryptionError('box too short');
  return aeadOpen(
    AEAD_AES_256_GCM,
    key,
    box.subarray(0, NONCE_BYTES),
    aad,
    box.subarray(NONCE_BYTES),
  );
}

function localAad(sessionId: string): Uint8Array {
  return utf8(`shriii/dek-local/v1|${sessionId}`);
}

/** Wrap a DEK with the device KEK for local storage (bound to the session id). */
export function wrapDekLocal(kek: Uint8Array, sessionId: string, dek: Uint8Array): Uint8Array {
  if (dek.length !== DEK_BYTES) throw new RangeError('DEK must be 32 bytes');
  return boxSeal(kek, localAad(sessionId), dek);
}

export function unwrapDekLocal(kek: Uint8Array, sessionId: string, wrapped: Uint8Array): Uint8Array {
  const dek = boxOpen(kek, localAad(sessionId), wrapped);
  if (dek.length !== DEK_BYTES) throw new DecryptionError('DEK has the wrong length');
  return dek;
}
