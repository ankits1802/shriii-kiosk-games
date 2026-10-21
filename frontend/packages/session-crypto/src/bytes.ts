/** Byte helpers shared by the HPKE, DEK and chunk modules (no dependencies beyond node:buffer). */
import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function fromUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function concat(...parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const p of parts) length += p.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Big-endian unsigned integer of `length` bytes (RFC 8017 I2OSP). */
export function i2osp(value: number, length: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0) throw new RangeError('i2osp: value must be a uint');
  if (length < 6 && value >= 2 ** (8 * length)) throw new RangeError('i2osp: value too large');
  const out = new Uint8Array(length);
  let v = value;
  for (let i = length - 1; i >= 0; i -= 1) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex');
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) throw new TypeError('fromHex: invalid hex');
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

/** Strict standard base64 (padding required, no whitespace) to bytes. */
export function fromBase64(text: string): Uint8Array {
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
    throw new TypeError('fromBase64: invalid base64');
  }
  return new Uint8Array(Buffer.from(text, 'base64'));
}

/** Constant-time equality for equal-length secrets; false for different lengths. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Overwrite a secret buffer with zeros (best effort; JS cannot guarantee no copies remain). */
export function wipe(bytes: Uint8Array): void {
  bytes.fill(0);
}
