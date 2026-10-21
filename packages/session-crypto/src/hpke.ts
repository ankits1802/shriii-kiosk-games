/**
 * RFC 9180 HPKE, base mode, for the single KEM/KDF the kiosk uses:
 * DHKEM(X25519, HKDF-SHA256) + HKDF-SHA256, with AES-128-GCM (0x0001, test vectors only) or
 * AES-256-GCM (0x0002, production suite). Implemented on node:crypto primitives (X25519, HMAC,
 * AES-GCM) and verified against the RFC / CFRG known-answer vectors in `test-vectors/`.
 *
 * Only single-shot use is needed (seal one DEK per session), but the context keeps the RFC sequence
 * number semantics so the KAT encryptions at seq 0..n can be checked.
 */

import { Buffer } from 'node:buffer';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  type KeyObject,
  randomBytes,
} from 'node:crypto';
import { concat, i2osp, utf8, wipe } from './bytes.ts';

export const KEM_X25519_HKDF_SHA256 = 0x0020;
export const KDF_HKDF_SHA256 = 0x0001;
export const AEAD_AES_128_GCM = 0x0001;
export const AEAD_AES_256_GCM = 0x0002;

export type AeadId = typeof AEAD_AES_128_GCM | typeof AEAD_AES_256_GCM;

const N_SECRET = 32; // Nsecret for DHKEM(X25519)
const N_PK = 32; // Npk / Nenc
const N_SK = 32;
const N_H = 32; // SHA-256 output
const N_N = 12; // AEAD nonce
const N_T = 16; // AEAD tag
const MODE_BASE = 0x00;
const HPKE_V1 = utf8('HPKE-v1');
const EMPTY = new Uint8Array(0);

const KEM_SUITE_ID = concat(utf8('KEM'), i2osp(KEM_X25519_HKDF_SHA256, 2));

function aeadKeyLength(aead: AeadId): number {
  return aead === AEAD_AES_128_GCM ? 16 : 32;
}

function aeadAlgorithm(aead: AeadId): 'aes-128-gcm' | 'aes-256-gcm' {
  return aead === AEAD_AES_128_GCM ? 'aes-128-gcm' : 'aes-256-gcm';
}

function hpkeSuiteId(aead: AeadId): Uint8Array {
  return concat(
    utf8('HPKE'),
    i2osp(KEM_X25519_HKDF_SHA256, 2),
    i2osp(KDF_HKDF_SHA256, 2),
    i2osp(aead, 2),
  );
}

/* --------------------------------------------------------------------------------------------- *
 * HKDF-SHA256 (RFC 5869) and the HPKE labeled variants
 * --------------------------------------------------------------------------------------------- */

export function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Uint8Array {
  return new Uint8Array(createHmac('sha256', salt).update(ikm).digest());
}

export function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Uint8Array {
  if (length > 255 * N_H) throw new RangeError('hkdfExpand: length too large');
  const out = new Uint8Array(length);
  let previous: Uint8Array = EMPTY;
  let offset = 0;
  for (let i = 1; offset < length; i += 1) {
    previous = new Uint8Array(
      createHmac('sha256', prk).update(previous).update(info).update(Uint8Array.of(i)).digest(),
    );
    out.set(previous.subarray(0, Math.min(N_H, length - offset)), offset);
    offset += N_H;
  }
  return out;
}

function labeledExtract(
  suiteId: Uint8Array,
  salt: Uint8Array,
  label: string,
  ikm: Uint8Array,
): Uint8Array {
  return hkdfExtract(salt, concat(HPKE_V1, suiteId, utf8(label), ikm));
}

function labeledExpand(
  suiteId: Uint8Array,
  prk: Uint8Array,
  label: string,
  info: Uint8Array,
  length: number,
): Uint8Array {
  return hkdfExpand(prk, concat(i2osp(length, 2), HPKE_V1, suiteId, utf8(label), info), length);
}

/* --------------------------------------------------------------------------------------------- *
 * X25519 raw key handling on node:crypto KeyObjects
 * --------------------------------------------------------------------------------------------- */

const PKCS8_X25519_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
]);
const SPKI_X25519_PREFIX = Uint8Array.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00,
]);

export function x25519PrivateKey(raw: Uint8Array): KeyObject {
  if (raw.length !== N_SK) throw new RangeError('X25519 private key must be 32 bytes');
  return createPrivateKey({
    key: Buffer.from(concat(PKCS8_X25519_PREFIX, raw)),
    format: 'der',
    type: 'pkcs8',
  });
}

export function x25519PublicKey(raw: Uint8Array): KeyObject {
  if (raw.length !== N_PK) throw new RangeError('X25519 public key must be 32 bytes');
  return createPublicKey({
    key: Buffer.from(concat(SPKI_X25519_PREFIX, raw)),
    format: 'der',
    type: 'spki',
  });
}

export function rawPublicKey(key: KeyObject): Uint8Array {
  const spki = new Uint8Array(key.export({ format: 'der', type: 'spki' }));
  return spki.subarray(spki.length - N_PK);
}

export function rawPrivateKey(key: KeyObject): Uint8Array {
  const pkcs8 = new Uint8Array(key.export({ format: 'der', type: 'pkcs8' }));
  return pkcs8.slice(pkcs8.length - N_SK);
}

/** Public key bytes for a raw private key. */
export function publicFromPrivate(skRaw: Uint8Array): Uint8Array {
  return rawPublicKey(createPublicKey(x25519PrivateKey(skRaw)));
}

function dh(skRaw: Uint8Array, pkRaw: Uint8Array): Uint8Array {
  const shared = new Uint8Array(
    diffieHellman({ privateKey: x25519PrivateKey(skRaw), publicKey: x25519PublicKey(pkRaw) }),
  );
  // RFC 7748 §6.1: reject the all-zero output (low-order public key).
  if (shared.every((b) => b === 0)) throw new Error('X25519: low-order public key');
  return shared;
}

/** RFC 9180 §7.1.3 DeriveKeyPair for X25519 (deterministic; used for KATs and tests). */
export function deriveKeyPair(ikm: Uint8Array): { sk: Uint8Array; pk: Uint8Array } {
  if (ikm.length < N_SK) throw new RangeError('deriveKeyPair: ikm must be >= 32 bytes');
  const dkpPrk = labeledExtract(KEM_SUITE_ID, EMPTY, 'dkp_prk', ikm);
  const sk = labeledExpand(KEM_SUITE_ID, dkpPrk, 'sk', EMPTY, N_SK);
  return { sk, pk: publicFromPrivate(sk) };
}

export function generateKeyPair(): { sk: Uint8Array; pk: Uint8Array } {
  return deriveKeyPair(new Uint8Array(randomBytes(N_SK)));
}

function extractAndExpand(dhValue: Uint8Array, kemContext: Uint8Array): Uint8Array {
  const eaePrk = labeledExtract(KEM_SUITE_ID, EMPTY, 'eae_prk', dhValue);
  return labeledExpand(KEM_SUITE_ID, eaePrk, 'shared_secret', kemContext, N_SECRET);
}

/** DHKEM Encap. `ikmE` makes it deterministic (tests); production omits it. */
export function encap(
  pkR: Uint8Array,
  ikmE?: Uint8Array,
): { sharedSecret: Uint8Array; enc: Uint8Array } {
  const eph = ikmE ? deriveKeyPair(ikmE) : generateKeyPair();
  try {
    const dhValue = dh(eph.sk, pkR);
    const enc = eph.pk;
    return { sharedSecret: extractAndExpand(dhValue, concat(enc, pkR)), enc };
  } finally {
    wipe(eph.sk);
  }
}

/** DHKEM Decap. */
export function decap(enc: Uint8Array, skR: Uint8Array): Uint8Array {
  if (enc.length !== N_PK) throw new RangeError('decap: enc must be 32 bytes');
  const dhValue = dh(skR, enc);
  return extractAndExpand(dhValue, concat(enc, publicFromPrivate(skR)));
}

/* --------------------------------------------------------------------------------------------- *
 * Key schedule and AEAD context
 * --------------------------------------------------------------------------------------------- */

export interface KeySchedule {
  readonly key: Uint8Array;
  readonly baseNonce: Uint8Array;
  readonly exporterSecret: Uint8Array;
  readonly keyScheduleContext: Uint8Array;
  readonly secret: Uint8Array;
}

export function keySchedule(aead: AeadId, sharedSecret: Uint8Array, info: Uint8Array): KeySchedule {
  const suiteId = hpkeSuiteId(aead);
  const pskIdHash = labeledExtract(suiteId, EMPTY, 'psk_id_hash', EMPTY);
  const infoHash = labeledExtract(suiteId, EMPTY, 'info_hash', info);
  const keyScheduleContext = concat(Uint8Array.of(MODE_BASE), pskIdHash, infoHash);
  const secret = labeledExtract(suiteId, sharedSecret, 'secret', EMPTY);
  return {
    key: labeledExpand(suiteId, secret, 'key', keyScheduleContext, aeadKeyLength(aead)),
    baseNonce: labeledExpand(suiteId, secret, 'base_nonce', keyScheduleContext, N_N),
    exporterSecret: labeledExpand(suiteId, secret, 'exp', keyScheduleContext, N_H),
    keyScheduleContext,
    secret,
  };
}

/** Raw AES-GCM: returns ciphertext || tag. */
export function aeadSeal(
  aead: AeadId,
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
): Uint8Array {
  const cipher = createCipheriv(aeadAlgorithm(aead), key, nonce, { authTagLength: N_T });
  cipher.setAAD(aad);
  const body = concat(cipher.update(plaintext), cipher.final());
  return concat(body, cipher.getAuthTag());
}

/** Raw AES-GCM open of ciphertext || tag; throws {@link DecryptionError} when authentication fails. */
export function aeadOpen(
  aead: AeadId,
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  sealed: Uint8Array,
): Uint8Array {
  if (sealed.length < N_T) throw new DecryptionError('ciphertext shorter than the tag');
  const decipher = createDecipheriv(aeadAlgorithm(aead), key, nonce, { authTagLength: N_T });
  decipher.setAAD(aad);
  decipher.setAuthTag(sealed.subarray(sealed.length - N_T));
  try {
    return concat(decipher.update(sealed.subarray(0, sealed.length - N_T)), decipher.final());
  } catch {
    throw new DecryptionError('authentication failed');
  }
}

/** Authentication or format failure on decryption. Never carries key material. */
export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptionError';
  }
}

/** HPKE encryption context (RFC 9180 §5.2) with sequence-number nonces. */
export class HpkeContext {
  private seq = 0;
  readonly aead: AeadId;
  private readonly schedule: KeySchedule;

  constructor(aead: AeadId, schedule: KeySchedule) {
    this.aead = aead;
    this.schedule = schedule;
  }

  get keySchedule(): KeySchedule {
    return this.schedule;
  }

  private nonce(): Uint8Array {
    const seqBytes = i2osp(this.seq, N_N);
    const out = new Uint8Array(N_N);
    for (let i = 0; i < N_N; i += 1)
      out[i] = (this.schedule.baseNonce[i] ?? 0) ^ (seqBytes[i] ?? 0);
    return out;
  }

  seal(aad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    const out = aeadSeal(this.aead, this.schedule.key, this.nonce(), aad, plaintext);
    this.seq += 1;
    return out;
  }

  open(aad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    const out = aeadOpen(this.aead, this.schedule.key, this.nonce(), aad, ciphertext);
    this.seq += 1;
    return out;
  }

  export(exporterContext: Uint8Array, length: number): Uint8Array {
    return labeledExpand(
      hpkeSuiteId(this.aead),
      this.schedule.exporterSecret,
      'sec',
      exporterContext,
      length,
    );
  }
}

export function setupBaseS(
  aead: AeadId,
  pkR: Uint8Array,
  info: Uint8Array,
  ikmE?: Uint8Array,
): { enc: Uint8Array; context: HpkeContext; sharedSecret: Uint8Array } {
  const { sharedSecret, enc } = encap(pkR, ikmE);
  return {
    enc,
    sharedSecret,
    context: new HpkeContext(aead, keySchedule(aead, sharedSecret, info)),
  };
}

export function setupBaseR(
  aead: AeadId,
  enc: Uint8Array,
  skR: Uint8Array,
  info: Uint8Array,
): HpkeContext {
  return new HpkeContext(aead, keySchedule(aead, decap(enc, skR), info));
}

/** Single-shot base-mode Seal. */
export function sealBase(
  aead: AeadId,
  pkR: Uint8Array,
  info: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
  ikmE?: Uint8Array,
): { enc: Uint8Array; ciphertext: Uint8Array } {
  const { enc, context } = setupBaseS(aead, pkR, info, ikmE);
  return { enc, ciphertext: context.seal(aad, plaintext) };
}

/** Single-shot base-mode Open. Throws {@link DecryptionError} on any failure. */
export function openBase(
  aead: AeadId,
  enc: Uint8Array,
  skR: Uint8Array,
  info: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array {
  let context: HpkeContext;
  try {
    context = setupBaseR(aead, enc, skR, info);
  } catch (error) {
    if (error instanceof DecryptionError) throw error;
    throw new DecryptionError('invalid encapsulated key');
  }
  return context.open(aad, ciphertext);
}

export const HPKE_SIZES = { N_PK, N_SK, N_N, N_T } as const;
