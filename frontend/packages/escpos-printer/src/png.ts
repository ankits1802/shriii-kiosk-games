/** Minimal PNG encode/decode for 1-bit grayscale images (virtual printer output and test checks). */
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { createBitmap, type MonoBitmap } from './bitmap.ts';

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Encode a mono bitmap as a 1-bit grayscale PNG (black dots -> black pixels). */
export function encodePng(bmp: MonoBitmap): Uint8Array {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, Math.max(1, bmp.width));
  v.setUint32(4, Math.max(1, bmp.height));
  ihdr[8] = 1; // bit depth
  ihdr[9] = 0; // grayscale
  const raw = new Uint8Array((bmp.bytesPerRow + 1) * bmp.height);
  for (let y = 0; y < bmp.height; y += 1) {
    raw[y * (bmp.bytesPerRow + 1)] = 0; // filter: none
    for (let i = 0; i < bmp.bytesPerRow; i += 1) {
      // PNG gray 1-bit: 0 = black. Our bitmap: 1 = black.
      raw[y * (bmp.bytesPerRow + 1) + 1 + i] = ~(bmp.data[y * bmp.bytesPerRow + i] ?? 0) & 0xff;
    }
  }
  const parts = [
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Decode a PNG produced by {@link encodePng} (1-bit gray, filter 0, non-interlaced) back to dots. */
export function decodePng(png: Uint8Array): MonoBitmap {
  for (let i = 0; i < 8; i += 1) if (png[i] !== SIGNATURE[i]) throw new Error('not a PNG');
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  while (offset < png.length) {
    const len = view.getUint32(offset);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    const data = png.subarray(offset + 8, offset + 8 + len);
    if (crc32(png.subarray(offset + 4, offset + 8 + len)) !== view.getUint32(offset + 8 + len)) {
      throw new Error(`bad CRC in ${type}`);
    }
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      if (data[8] !== 1 || data[9] !== 0 || data[12] !== 0)
        throw new Error('unsupported PNG format');
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    offset += 12 + len;
  }
  const raw = new Uint8Array(inflateSync(Buffer.concat(idat)));
  const bmp = createBitmap(width, height);
  for (let y = 0; y < height; y += 1) {
    if (raw[y * (bmp.bytesPerRow + 1)] !== 0) throw new Error('unsupported PNG filter');
    for (let i = 0; i < bmp.bytesPerRow; i += 1) {
      bmp.data[y * bmp.bytesPerRow + i] = ~(raw[y * (bmp.bytesPerRow + 1) + 1 + i] ?? 0xff) & 0xff;
    }
    // Clear padding bits beyond the width.
    const pad = bmp.bytesPerRow * 8 - width;
    if (pad > 0) {
      const last = y * bmp.bytesPerRow + bmp.bytesPerRow - 1;
      bmp.data[last] = (bmp.data[last] ?? 0) & ((0xff << pad) & 0xff);
    }
  }
  return bmp;
}
