/**
 * Thermal-printer output for the one-page picture summary (REP-02): RGBA pixels -> 1-bit with
 * Floyd-Steinberg dithering -> ESC/POS "GS v 0" raster command. Pure functions (unit-tested).
 */

/** Printable width in dots of an 80 mm, 203 dpi printer head. */
export const PRINTER_DOTS = 576;

/** A packed 1-bit image: rows of ceil(width / 8) bytes, MSB first, 1 = black. */
export interface MonoBitmap {
  readonly width: number;
  readonly height: number;
  readonly bytesPerRow: number;
  readonly data: Uint8Array;
}

/** Dither RGBA pixels (alpha composited on white) to a packed 1-bit bitmap. */
export function ditherToMono(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  threshold = 128,
  levels: { readonly black: number; readonly white: number } = { black: 24, white: 222 },
): MonoBitmap {
  const lum = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const a = (rgba[i * 4 + 3] ?? 255) / 255;
    const r = (rgba[i * 4] ?? 255) * a + 255 * (1 - a);
    const g = (rgba[i * 4 + 1] ?? 255) * a + 255 * (1 - a);
    const b = (rgba[i * 4 + 2] ?? 255) * a + 255 * (1 - a);
    // Levels: clip near-white paper tones to white and deepen darks so the print stays crisp.
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lum[i] = Math.max(0, Math.min(255, ((y - levels.black) / (levels.white - levels.black)) * 255));
  }
  const bytesPerRow = Math.ceil(width / 8);
  const data = new Uint8Array(bytesPerRow * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const old = lum[i] ?? 255;
      const black = old < threshold;
      const err = old - (black ? 0 : 255);
      if (black)
        data[y * bytesPerRow + (x >> 3)] =
          (data[y * bytesPerRow + (x >> 3)] ?? 0) | (0x80 >> (x & 7));
      if (x + 1 < width) lum[i + 1] = (lum[i + 1] ?? 0) + (err * 7) / 16;
      if (y + 1 < height) {
        if (x > 0) lum[i + width - 1] = (lum[i + width - 1] ?? 0) + (err * 3) / 16;
        lum[i + width] = (lum[i + width] ?? 0) + (err * 5) / 16;
        if (x + 1 < width) lum[i + width + 1] = (lum[i + width + 1] ?? 0) + (err * 1) / 16;
      }
    }
  }
  return { width, height, bytesPerRow, data };
}

/** ESC/POS raster bit image command (GS v 0, normal density) for a mono bitmap, plus init and feed/cut. */
export function escposRaster(
  bmp: MonoBitmap,
  options: { readonly cut?: boolean } = {},
): Uint8Array {
  const xL = bmp.bytesPerRow & 0xff;
  const xH = (bmp.bytesPerRow >> 8) & 0xff;
  const yL = bmp.height & 0xff;
  const yH = (bmp.height >> 8) & 0xff;
  const init = [0x1b, 0x40]; // ESC @
  const center = [0x1b, 0x61, 0x01]; // ESC a 1
  const header = [0x1d, 0x76, 0x30, 0x00, xL, xH, yL, yH];
  const feed = [0x1b, 0x64, 0x04]; // ESC d 4
  const cut = options.cut === false ? [] : [0x1d, 0x56, 0x42, 0x00]; // GS V B 0 (feed and partial cut)
  const out = new Uint8Array(
    init.length + center.length + header.length + bmp.data.length + feed.length + cut.length,
  );
  let o = 0;
  for (const part of [init, center, header]) {
    out.set(part, o);
    o += part.length;
  }
  out.set(bmp.data, o);
  o += bmp.data.length;
  out.set(feed, o);
  o += feed.length;
  out.set(cut, o);
  return out;
}
