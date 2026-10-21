/**
 * Packed 1-bit bitmaps (MSB first, 1 = black dot), the native format of ESC/POS raster images and
 * compatible with `MonoBitmap` in kiosk-game `report/escpos.ts`.
 */

export interface MonoBitmap {
  readonly width: number;
  readonly height: number;
  /** ceil(width / 8). */
  readonly bytesPerRow: number;
  readonly data: Uint8Array;
}

export function createBitmap(width: number, height: number): MonoBitmap {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0) {
    throw new RangeError('bitmap dimensions must be non-negative integers');
  }
  const bytesPerRow = Math.ceil(width / 8);
  return { width, height, bytesPerRow, data: new Uint8Array(bytesPerRow * height) };
}

export function getDot(bmp: MonoBitmap, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= bmp.width || y >= bmp.height) return false;
  return ((bmp.data[y * bmp.bytesPerRow + (x >> 3)] ?? 0) & (0x80 >> (x & 7))) !== 0;
}

export function setDot(bmp: MonoBitmap, x: number, y: number, black: boolean): void {
  if (x < 0 || y < 0 || x >= bmp.width || y >= bmp.height) return;
  const i = y * bmp.bytesPerRow + (x >> 3);
  const mask = 0x80 >> (x & 7);
  bmp.data[i] = black ? (bmp.data[i] ?? 0) | mask : (bmp.data[i] ?? 0) & ~mask;
}

export function fillRect(
  bmp: MonoBitmap,
  x: number,
  y: number,
  w: number,
  h: number,
  black = true,
): void {
  for (let yy = Math.max(0, y); yy < Math.min(bmp.height, y + h); yy += 1) {
    for (let xx = Math.max(0, x); xx < Math.min(bmp.width, x + w); xx += 1) {
      setDot(bmp, xx, yy, black);
    }
  }
}

/** Copy `src` onto `dst` at (x, y); black dots are OR-ed (white areas of src do not erase). */
export function blit(dst: MonoBitmap, src: MonoBitmap, x: number, y: number): void {
  for (let sy = 0; sy < src.height; sy += 1) {
    for (let sx = 0; sx < src.width; sx += 1) {
      if (getDot(src, sx, sy)) setDot(dst, x + sx, y + sy, true);
    }
  }
}

/** Stack bitmaps vertically on a canvas `width` dots wide, each centred, with `gap` blank lines. */
export function stackCentered(parts: readonly MonoBitmap[], width: number, gap = 0): MonoBitmap {
  const height = parts.reduce((h, p) => h + p.height, 0) + gap * Math.max(0, parts.length - 1);
  const out = createBitmap(width, height);
  let y = 0;
  for (const p of parts) {
    if (p.width > width) throw new RangeError(`part is ${p.width} dots wide, page is ${width}`);
    blit(out, p, Math.floor((width - p.width) / 2), y);
    y += p.height + gap;
  }
  return out;
}

/** Integer nearest-neighbour upscale (QR modules, icons). */
export function scaleBitmap(src: MonoBitmap, factor: number): MonoBitmap {
  if (!Number.isInteger(factor) || factor < 1)
    throw new RangeError('factor must be an integer >= 1');
  const out = createBitmap(src.width * factor, src.height * factor);
  for (let y = 0; y < out.height; y += 1) {
    for (let x = 0; x < out.width; x += 1) {
      if (getDot(src, Math.floor(x / factor), Math.floor(y / factor))) setDot(out, x, y, true);
    }
  }
  return out;
}

/** Rows [y0, y1) as a new bitmap sharing no memory with the source. */
export function sliceRows(src: MonoBitmap, y0: number, y1: number): MonoBitmap {
  const a = Math.max(0, y0);
  const b = Math.min(src.height, y1);
  return {
    width: src.width,
    height: Math.max(0, b - a),
    bytesPerRow: src.bytesPerRow,
    data: src.data.slice(a * src.bytesPerRow, b * src.bytesPerRow),
  };
}

/** Fraction of black dots (print-density / toner-free "ink" budget checks). */
export function blackRatio(bmp: MonoBitmap): number {
  let black = 0;
  for (let y = 0; y < bmp.height; y += 1) {
    for (let x = 0; x < bmp.width; x += 1) if (getDot(bmp, x, y)) black += 1;
  }
  return bmp.width * bmp.height === 0 ? 0 : black / (bmp.width * bmp.height);
}

export function bitmapsEqual(a: MonoBitmap, b: MonoBitmap): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  for (let y = 0; y < a.height; y += 1) {
    for (let x = 0; x < a.width; x += 1) if (getDot(a, x, y) !== getDot(b, x, y)) return false;
  }
  return true;
}
