import { getDot, type MonoBitmap } from '../src/bitmap.ts';
import type { RgbaImage } from '../src/image.ts';

/** A solid RGBA image. */
export function solid(width: number, height: number, v: number, alpha = 255): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) data.set([v, v, v, alpha], i * 4);
  return { width, height, data };
}

/** Horizontal gradient from black (left) to white (right). */
export function gradient(width: number, height: number): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const v = Math.round((x / (width - 1)) * 255);
      data.set([v, v, v, 255], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

/** A pictorial test page: warm background, dark circles (trait cards), a soft vignette. */
export function pictureReport(width = 900, height = 1200): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  const circles = [
    { x: width * 0.3, y: height * 0.25, r: width * 0.18, c: [180, 60, 40] },
    { x: width * 0.7, y: height * 0.25, r: width * 0.18, c: [40, 90, 160] },
    { x: width * 0.3, y: height * 0.6, r: width * 0.18, c: [230, 170, 30] },
    { x: width * 0.7, y: height * 0.6, r: width * 0.18, c: [60, 140, 70] },
  ];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let rgb = [255, 248, 235];
      for (const c of circles) {
        const d = Math.hypot(x - c.x, y - c.y);
        if (d < c.r) {
          const t = d / c.r;
          rgb = c.c.map((v) => Math.round(v + (255 - v) * t * t * 0.6));
        }
      }
      data.set([...rgb, 255], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

/** Expand a mono bitmap to RGBA (for QR decoding with jsQR). */
export function monoToRgba(
  bmp: MonoBitmap,
  pad = 0,
): { data: Uint8ClampedArray; width: number; height: number } {
  const width = bmp.width + 2 * pad;
  const height = bmp.height + 2 * pad;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 0; y < bmp.height; y += 1) {
    for (let x = 0; x < bmp.width; x += 1) {
      if (getDot(bmp, x, y)) data.set([0, 0, 0, 255], ((y + pad) * width + x + pad) * 4);
    }
  }
  return { data, width, height };
}

export function blackFractionInColumns(bmp: MonoBitmap, x0: number, x1: number): number {
  let black = 0;
  for (let y = 0; y < bmp.height; y += 1)
    for (let x = x0; x < x1; x += 1) if (getDot(bmp, x, y)) black += 1;
  return black / ((x1 - x0) * bmp.height);
}
