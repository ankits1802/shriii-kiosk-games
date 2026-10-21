/**
 * @shriii/session-crypto — per-session envelope encryption for kiosk event data (KSK-07).
 *
 * - {@link generateDek} / {@link sealDek} / {@link openDek}: DEK sealed to the backend X25519 key
 *   with RFC 9180 HPKE (base mode, DHKEM-X25519/HKDF-SHA256/AES-256-GCM).
 * - {@link wrapDekLocal}: DEK wrapped with the device KEK for local use and crypto-shredding.
 * - {@link encryptChunk} / {@link decryptChunk}: gzip NDJSON chunks for `UploadBatch`.
 * - {@link encryptRecord}: at-rest encryption of each stored event.
 * - {@link RecipientKeyRing}: backend key rotation.
 *
 * Node / Electron main process only (node:crypto, node:zlib). The Python reference decryptor for
 * the API lives in `python/`.
 */
export * from './bytes.ts';
export * from './chunk.ts';
export * from './dek.ts';
export {
  AEAD_AES_128_GCM,
  AEAD_AES_256_GCM,
  type AeadId,
  DecryptionError,
  deriveKeyPair,
  generateKeyPair,
  HpkeContext,
  KDF_HKDF_SHA256,
  KEM_X25519_HKDF_SHA256,
  openBase,
  publicFromPrivate,
  sealBase,
  setupBaseR,
  setupBaseS,
} from './hpke.ts';
export * from './keys.ts';
