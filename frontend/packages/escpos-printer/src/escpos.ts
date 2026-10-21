/**
 * ESC/POS command encoding for 80 mm raster printing (Epson TM-T20/T88 compatible command set).
 * Only the commands the kiosk needs are emitted; the virtual printer understands exactly these.
 */
import type { MonoBitmap } from './bitmap.ts';

export const ESC = 0x1b;
export const GS = 0x1d;
export const DLE = 0x10;
export const EOT = 0x04;

/** Printable width in dots of an 80 mm paper roll on a 203 dpi head. */
export const DOTS_80MM = 576;
/** Printable width on 58 mm paper (for completeness / alternative SKUs). */
export const DOTS_58MM = 384;

export type Align = 'left' | 'center' | 'right';

export const cmd = {
  /** ESC @: initialise (clears buffer and modes). */
  init: (): Uint8Array => Uint8Array.of(ESC, 0x40),
  /** ESC a n: justification. */
  align: (a: Align): Uint8Array =>
    Uint8Array.of(ESC, 0x61, a === 'left' ? 0 : a === 'center' ? 1 : 2),
  /** ESC d n: print and feed n lines. */
  feedLines: (n: number): Uint8Array => Uint8Array.of(ESC, 0x64, clampByte(n)),
  /** ESC J n: print and feed n dots (motion units). */
  feedDots: (n: number): Uint8Array => Uint8Array.of(ESC, 0x4a, clampByte(n)),
  /** GS V B n: feed to the cutter (+n units) and partial cut. */
  cut: (feed = 0): Uint8Array => Uint8Array.of(GS, 0x56, 0x42, clampByte(feed)),
  /** DLE EOT n: real-time status request (n = 1..4). */
  status: (n: 1 | 2 | 3 | 4): Uint8Array => Uint8Array.of(DLE, EOT, n),
  /** GS v 0 m xL xH yL yH d1..dk: raster bit image (m = 0 normal density). */
  rasterHeader: (bytesPerRow: number, rows: number): Uint8Array => {
    if (bytesPerRow < 1 || bytesPerRow > 0xffff || rows < 1 || rows > 0xffff) {
      throw new RangeError('raster dimensions out of range');
    }
    return Uint8Array.of(
      GS,
      0x76,
      0x30,
      0,
      bytesPerRow & 0xff,
      bytesPerRow >> 8,
      rows & 0xff,
      rows >> 8,
    );
  },
} as const;

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Raster commands for a bitmap split into horizontal bands. Many printers have small receive buffers
 * and some firmware caps a single GS v 0 image height, so long pages go as a series of bands.
 */
export function rasterBands(bmp: MonoBitmap, bandHeight = 128): Uint8Array[] {
  if (bandHeight < 1 || bandHeight > 2303) throw new RangeError('bandHeight must be 1..2303');
  const out: Uint8Array[] = [];
  for (let y = 0; y < bmp.height; y += bandHeight) {
    const rows = Math.min(bandHeight, bmp.height - y);
    out.push(
      concatBytes([
        cmd.rasterHeader(bmp.bytesPerRow, rows),
        bmp.data.subarray(y * bmp.bytesPerRow, (y + rows) * bmp.bytesPerRow),
      ]),
    );
  }
  return out;
}

export interface JobOptions {
  readonly bandHeight?: number;
  /** Lines fed after the image before cutting. Default 4. */
  readonly feedLines?: number;
  /** Cut at the end. Default true. */
  readonly cut?: boolean;
}

/** Full print job: init, centre, raster bands, feed, (cut). */
export function encodeRasterJob(bmp: MonoBitmap, options: JobOptions = {}): Uint8Array {
  return concatBytes([
    cmd.init(),
    cmd.align('center'),
    ...rasterBands(bmp, options.bandHeight ?? 128),
    cmd.feedLines(options.feedLines ?? 4),
    ...(options.cut === false ? [] : [cmd.cut(0)]),
  ]);
}
