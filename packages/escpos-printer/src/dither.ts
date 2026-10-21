/**
 * Grayscale -> 1-bit conversion: plain threshold, Floyd–Steinberg (serpentine scan) and Atkinson.
 * Atkinson diffuses only 3/4 of the error, which keeps large light areas clean on thermal paper and
 * is the default for pictorial reports; Floyd–Steinberg preserves average tone exactly.
 */
import { createBitmap, type MonoBitmap } from './bitmap.ts';
import type { GrayImage } from './image.ts';

export type DitherAlgorithm = 'threshold' | 'floyd-steinberg' | 'atkinson';

export interface DitherOptions {
  readonly algorithm?: DitherAlgorithm;
  /** Black/white decision level, 0..255. Default 128. */
  readonly threshold?: number;
  /** Alternate scan direction per row (Floyd–Steinberg only). Default true. */
  readonly serpentine?: boolean;
}

interface Tap {
  readonly dx: number;
  readonly dy: number;
  readonly w: number;
}

const FLOYD_STEINBERG: readonly Tap[] = [
  { dx: 1, dy: 0, w: 7 / 16 },
  { dx: -1, dy: 1, w: 3 / 16 },
  { dx: 0, dy: 1, w: 5 / 16 },
  { dx: 1, dy: 1, w: 1 / 16 },
];

const ATKINSON: readonly Tap[] = [
  { dx: 1, dy: 0, w: 1 / 8 },
  { dx: 2, dy: 0, w: 1 / 8 },
  { dx: -1, dy: 1, w: 1 / 8 },
  { dx: 0, dy: 1, w: 1 / 8 },
  { dx: 1, dy: 1, w: 1 / 8 },
  { dx: 0, dy: 2, w: 1 / 8 },
];

export function dither(img: GrayImage, options: DitherOptions = {}): MonoBitmap {
  const algorithm = options.algorithm ?? 'atkinson';
  const threshold = options.threshold ?? 128;
  const { width, height } = img;
  const out = createBitmap(width, height);
  const lum = Float32Array.from(img.data);
  const taps =
    algorithm === 'floyd-steinberg' ? FLOYD_STEINBERG : algorithm === 'atkinson' ? ATKINSON : [];
  const serpentine = algorithm === 'floyd-steinberg' && options.serpentine !== false;
  for (let y = 0; y < height; y += 1) {
    const reverse = serpentine && y % 2 === 1;
    for (let k = 0; k < width; k += 1) {
      const x = reverse ? width - 1 - k : k;
      const i = y * width + x;
      const old = lum[i] ?? 255;
      const black = old < threshold;
      if (black) {
        const byte = y * out.bytesPerRow + (x >> 3);
        out.data[byte] = (out.data[byte] ?? 0) | (0x80 >> (x & 7));
      }
      const err = old - (black ? 0 : 255);
      if (err === 0) continue;
      for (const t of taps) {
        const nx = x + (reverse ? -t.dx : t.dx);
        const ny = y + t.dy;
        if (nx < 0 || nx >= width || ny >= height) continue;
        const j = ny * width + nx;
        lum[j] = (lum[j] ?? 0) + err * t.w;
      }
    }
  }
  return out;
}
