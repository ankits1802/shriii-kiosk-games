/**
 * Device key material for the outbox (KSK-07, KSK-09).
 *
 * - **Device KEK** (32 random bytes) wraps every session DEK at rest. It is stored encrypted with
 *   the OS keystore through Electron `safeStorage` (DPAPI on Windows, libsecret/kwallet on Linux).
 *   On Ubuntu Core the app runs without a desktop keyring, so `safeStorage` falls back to its
 *   `basic_text` backend; the file is then protected by the snap's private `$SNAP_USER_DATA`
 *   (0600) and the TPM-backed full-disk encryption of the image (KSK-09). The protection level is
 *   reported on the status so operations can see it.
 * - **Backend recipient keys** come from the signed site policy (PRV-01) as a JSON file.
 *
 * The `SecretStore` seam keeps this module testable without Electron.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type RecipientKeyJson, RecipientKeyRing } from '@shriii/session-crypto';

export interface SecretStore {
  /** Human-readable protection level ("dpapi", "gnome_libsecret", "basic_text", "plain_file"). */
  readonly protection: string;
  encrypt(plain: string): Buffer;
  decrypt(blob: Buffer): string;
}

export const KEK_FILE = 'device-kek.bin';

/** A store that does not encrypt (development / when the OS store is unavailable). */
export const plainFileStore: SecretStore = {
  protection: 'plain_file',
  encrypt: (plain) => Buffer.from(plain, 'utf8'),
  decrypt: (blob) => blob.toString('utf8'),
};

function writeAtomic(file: string, data: Buffer): void {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows ignores POSIX modes; DPAPI protects the content there.
  }
}

/** Load the device KEK, creating it on first boot. Never regenerates an existing (unreadable) KEK. */
export function loadOrCreateKek(
  dir: string,
  store: SecretStore,
): { kek: Uint8Array; created: boolean } {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, KEK_FILE);
  if (existsSync(file)) {
    const header = readFileSync(file);
    const sep = header.indexOf(0x0a);
    const protection = sep > 0 ? header.subarray(0, sep).toString('utf8') : '';
    if (protection !== store.protection) {
      throw new Error(
        `device KEK was stored with ${protection || 'unknown'} protection, current store is ${store.protection}`,
      );
    }
    const kek = Buffer.from(store.decrypt(header.subarray(sep + 1)), 'base64');
    if (kek.length !== 32) throw new Error('device KEK is corrupt');
    return { kek: new Uint8Array(kek), created: false };
  }
  const kek = randomBytes(32);
  writeAtomic(
    file,
    Buffer.concat([
      Buffer.from(`${store.protection}\n`, 'utf8'),
      store.encrypt(kek.toString('base64')),
    ]),
  );
  return { kek: new Uint8Array(kek), created: true };
}

/** Parse the backend recipient keys file. */
export function loadRecipientKeys(file: string): RecipientKeyRing {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  const list = Array.isArray(parsed) ? parsed : (parsed as { keys?: unknown }).keys;
  if (!Array.isArray(list))
    throw new Error('recipient keys file must be an array or {keys: [...]}');
  return RecipientKeyRing.fromJson(list as RecipientKeyJson[]);
}
