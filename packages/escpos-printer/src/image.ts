/**
 * RGBA -> grayscale conversion and resampling for thermal output. Alpha is composited on white
 * paper; luminance uses Rec. 709 weights; optional levels and gamma compensate for thermal dot gain.
 */

/** Straight (non-premultiplied) RGBA pixels, row-major, 4 bytes per pixel. */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array | Uint8ClampedArray;
}

/** Grayscale image: 0 = black, 255 = white (paper). */
export interface GrayImage {
  readonly width: number;
  readonly height: number;
  readonly data: Float32Array;
}

export interface ToneOptions {
  /** Input level mapped to full black (deepens darks). Default 24. */
  readonly black?: number;
  /** Input level mapped to paper white (clips near-white tones). Default 222. */
  readonly white?: number;
  /** Gamma > 1 lightens mid-tones to offset thermal dot gain. Default 1.15. */
  readonly gamma?: number;
}

function checkRgba(img: RgbaImage): void {
  if (img.data.length !== img.width * img.height * 4) {
    throw new RangeError(
      `RGBA buffer is ${img.data.length} bytes, expected ${img.width * img.height * 4}`,
    );
  }
}

export function toGray(img: RgbaImage, tone: ToneOptions = {}): GrayImage {
  checkRgba(img);
  const black = tone.black ?? 24;
  const white = tone.white ?? 222;
  const gamma = tone.gamma ?? 1.15;
  if (!(white > black)) throw new RangeError('white level must exceed black level');
  const n = img.width * img.height;
  const out = new Float32Array(n);
  const d = img.data;
  for (let i = 0; i < n; i += 1) {
    const a = (d[i * 4 + 3] ?? 255) / 255;
    const r = (d[i * 4] ?? 255) * a + 255 * (1 - a);
    const g = (d[i * 4 + 1] ?? 255) * a + 255 * (1 - a);
    const b = (d[i * 4 + 2] ?? 255) * a + 255 * (1 - a);
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const lin = Math.max(0, Math.min(1, (y - black) / (white - black)));
    out[i] = 255 * lin ** (1 / gamma);
  }
  return { width: img.width, height: img.height, data: out };
}

/**
 * Resample a grayscale image. Downscaling uses exact area averaging (box filter over the source
 * footprint), which keeps fine strokes legible on a 203 dpi head; upscaling uses bilinear.
 */
export function resizeGray(src: GrayImage, width: number, height: number): GrayImage {
  if (width < 1 || height < 1) throw new RangeError('target size must be >= 1');
  if (width === src.width && height === src.height) return src;
  const out = new Float32Array(width * height);
  const sx = src.width / width;
  const sy = src.height / height;
  const px = (x: number, y: number): number => src.data[y * src.width + x] ?? 255;
  if (sx >= 1 && sy >= 1) {
    for (let y = 0; y < height; y += 1) {
      const y0 = y * sy;
      const y1 = y0 + sy;
      for (let x = 0; x < width; x += 1) {
        const x0 = x * sx;
        const x1 = x0 + sx;
        let sum = 0;
        let area = 0;
        for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy += 1) {
          const wy = Math.min(y1, yy + 1) - Math.max(y0, yy);
          for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx += 1) {
            const w = wy * (Math.min(x1, xx + 1) - Math.max(x0, xx));
            sum += w * px(Math.min(xx, src.width - 1), Math.min(yy, src.height - 1));
            area += w;
          }
        }
        out[y * width + x] = sum / area;
      }
    }
  } else {
    for (let y = 0; y < height; y += 1) {
      const fy = Math.max(0, Math.min(src.height - 1, (y + 0.5) * sy - 0.5));
      const y0 = Math.floor(fy);
      const y1 = Math.min(src.height - 1, y0 + 1);
      const ty = fy - y0;
      for (let x = 0; x < width; x += 1) {
        const fx = Math.max(0, Math.min(src.width - 1, (x + 0.5) * sx - 0.5));
        const x0 = Math.floor(fx);
        const x1 = Math.min(src.width - 1, x0 + 1);
        const tx = fx - x0;
        const top = px(x0, y0) * (1 - tx) + px(x1, y0) * tx;
        const bottom = px(x0, y1) * (1 - tx) + px(x1, y1) * tx;
        out[y * width + x] = top * (1 - ty) + bottom * ty;
      }
    }
  }
  return { width, height, data: out };
}

/** Scale to `width` dots keeping the aspect ratio (no-op when already that wide). */
export function fitToWidth(src: GrayImage, width: number): GrayImage {
  if (src.width === width) return src;
  return resizeGray(src, width, Math.max(1, Math.round((src.height * width) / src.width)));
}
