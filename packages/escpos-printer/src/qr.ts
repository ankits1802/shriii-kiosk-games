/**
 * QR codes rendered as raster dots (never the printer's native QR command, whose support and
 * module sizing vary by firmware). The quiet zone is part of the bitmap.
 */
import QRCode from 'qrcode';
import { createBitmap, type MonoBitmap, setDot } from './bitmap.ts';

export type QrErrorCorrection = 'L' | 'M' | 'Q' | 'H';

export interface QrOptions {
  /** Error correction level. Default 'M' (15%: survives smudged thermal paper). */
  readonly errorCorrection?: QrErrorCorrection;
  /** Dots per module. Default: largest that fits `maxWidth`, at most 8. */
  readonly moduleDots?: number;
  /** Maximum bitmap width in dots, including the quiet zone. Default 384. */
  readonly maxWidth?: number;
  /** Quiet zone in modules (spec minimum 4). Default 4. */
  readonly quietZone?: number;
}

/** The QR module matrix: `true` = dark module. */
export function qrMatrix(text: string, errorCorrection: QrErrorCorrection = 'M'): boolean[][] {
  const qr = QRCode.create(text, { errorCorrectionLevel: errorCorrection });
  const size = qr.modules.size;
  const rows: boolean[][] = [];
  for (let y = 0; y < size; y += 1) {
    const row: boolean[] = [];
    for (let x = 0; x < size; x += 1) row.push(qr.modules.get(y, x) === 1);
    rows.push(row);
  }
  return rows;
}

export function qrBitmap(text: string, options: QrOptions = {}): MonoBitmap {
  const matrix = qrMatrix(text, options.errorCorrection ?? 'M');
  const quiet = options.quietZone ?? 4;
  if (quiet < 4) throw new RangeError('QR quiet zone must be at least 4 modules');
  const modules = matrix.length + 2 * quiet;
  const maxWidth = options.maxWidth ?? 384;
  const fit = Math.floor(maxWidth / modules);
  const dots = options.moduleDots ?? Math.min(8, fit);
  if (dots < 2 || modules * dots > maxWidth) {
    throw new RangeError(`QR payload too long: ${modules} modules do not fit ${maxWidth} dots`);
  }
  const bmp = createBitmap(modules * dots, modules * dots);
  matrix.forEach((row, my) => {
    row.forEach((dark, mx) => {
      if (!dark) return;
      for (let dy = 0; dy < dots; dy += 1) {
        for (let dx = 0; dx < dots; dx += 1) {
          setDot(bmp, (mx + quiet) * dots + dx, (my + quiet) * dots + dy, true);
        }
      }
    });
  });
  return bmp;
}
