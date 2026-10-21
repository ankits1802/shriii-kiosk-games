/**
 * QR code for report retrieval (REP-02: an opaque 128-bit token URL for a 72 h - 7 day page with audio
 * replay and "erase my data"). Encoded with the `qrcode` library; drawn as crisp vector modules with
 * rounded finder patterns so it suits the art style yet stays scannable (quiet zone, high contrast).
 */

import { Graphics } from 'pixi.js';
import QRCode from 'qrcode';

/** Boolean module matrix (true = dark). */
export interface QrMatrix {
  readonly size: number;
  get(row: number, col: number): boolean;
}

/** Encode text (error correction M by default). */
export function encodeQr(text: string, level: 'L' | 'M' | 'Q' | 'H' = 'M'): QrMatrix {
  const qr = QRCode.create(text, { errorCorrectionLevel: level });
  const m = qr.modules;
  return { size: m.size, get: (r, c) => Boolean(m.get(r, c)) };
}

function inFinder(size: number, r: number, c: number): boolean {
  return (r < 7 && c < 7) || (r < 7 && c >= size - 7) || (r >= size - 7 && c < 7);
}

/** Draw the QR into a Graphics of edge `px` (including a 4-module quiet zone) centred at (0, 0). */
export function drawQr(matrix: QrMatrix, px: number, dark = 0x1b1838, light = 0xffffff): Graphics {
  const g = new Graphics();
  const n = matrix.size + 8;
  const cell = px / n;
  const o = -px / 2;
  g.roundRect(o, o, px, px, cell * 2).fill(light);
  for (let r = 0; r < matrix.size; r++) {
    for (let c = 0; c < matrix.size; c++) {
      if (!matrix.get(r, c) || inFinder(matrix.size, r, c)) continue;
      g.roundRect(
        o + (c + 4) * cell + cell * 0.06,
        o + (r + 4) * cell + cell * 0.06,
        cell * 0.88,
        cell * 0.88,
        cell * 0.3,
      ).fill(dark);
    }
  }
  for (const [fr, fc] of [
    [0, 0],
    [0, matrix.size - 7],
    [matrix.size - 7, 0],
  ] as const) {
    const x = o + (fc + 4) * cell;
    const y = o + (fr + 4) * cell;
    g.roundRect(x, y, cell * 7, cell * 7, cell * 2).fill(dark);
    g.roundRect(x + cell, y + cell, cell * 5, cell * 5, cell * 1.5).fill(light);
    g.roundRect(x + cell * 2, y + cell * 2, cell * 3, cell * 3, cell).fill(dark);
  }
  return g;
}
