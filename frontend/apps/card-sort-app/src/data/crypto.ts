/** Small Web Crypto helpers (available in the Android WebView secure context, browsers and Node 24). */

/** JSON with object keys sorted recursively, so hashes do not depend on insertion order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

export const PIN_ITERATIONS = 120_000;

export interface PinHash {
  readonly algorithm: 'PBKDF2-SHA256';
  readonly iterations: number;
  readonly salt: string;
  readonly hash: string;
}

async function derive(
  pin: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256,
  );
  return toHex(bits);
}

export async function hashPin(pin: string, iterations = PIN_ITERATIONS): Promise<PinHash> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return {
    algorithm: 'PBKDF2-SHA256',
    iterations,
    salt: toHex(salt.buffer),
    hash: await derive(pin, salt, iterations),
  };
}

export async function verifyPin(pin: string, stored: PinHash): Promise<boolean> {
  const candidate = await derive(pin, fromHex(stored.salt), stored.iterations);
  // Constant-time comparison of the hex digests.
  let diff = candidate.length ^ stored.hash.length;
  for (let i = 0; i < Math.min(candidate.length, stored.hash.length); i++)
    diff |= candidate.charCodeAt(i) ^ stored.hash.charCodeAt(i);
  return diff === 0;
}

/** RFC 9562 version-4 UUID, lower case. */
export function uuid4(): string {
  return crypto.randomUUID().toLowerCase();
}
