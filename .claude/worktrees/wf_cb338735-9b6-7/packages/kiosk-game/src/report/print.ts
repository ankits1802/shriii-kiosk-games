/**
 * One-page picture summary for the thermal printer (REP-02): drawn with the same pictograms as the
 * screen on a white 576-dot page (80 mm head), then dithered to 1-bit and wrapped as ESC/POS raster.
 * No text, no numbers: a marigold border, each trait card in miniature, the "snapshot, not a diagnosis"
 * badge, an "example" stamp for demo reports, and the retrieval QR.
 */
import { type Application, Container, Graphics } from 'pixi.js';
import { marigold } from '../art/draw.ts';
import { MELA } from '../art/palettes.ts';
import type { ReportModel, ReportTrait } from '../core/contracts.ts';
import { ditherToMono, escposRaster, type MonoBitmap, PRINTER_DOTS } from './escpos.ts';
import type { DisplayTrait } from './model.ts';
import { drawQr, encodeQr } from './qr.ts';
import { exampleStamp, snapshotBadge, traitCard } from './traitArt.ts';

/** Build the printable page as a display object (PRINTER_DOTS wide, origin top-left). */
export function buildPrintSummary(model: ReportModel, retrievalUrl: string | null): Container {
  const W = PRINTER_DOTS;
  const page = new Container();
  const traits: DisplayTrait[] =
    model.mode === 'thank_you'
      ? []
      : model.traits.map((t: ReportTrait) =>
          'style' in t ? (t as DisplayTrait) : { ...t, style: 'banded' },
        );
  const cols = 2;
  const cardW = 230;
  const cardH = cardW * 1.32;
  const rows = Math.ceil(traits.length / cols);
  const qrSize = retrievalUrl ? 260 : 0;
  const H = 120 + rows * (cardH + 24) + 130 + qrSize + 80;
  const bg = new Graphics().rect(0, 0, W, H).fill(0xffffff);
  page.addChild(bg);
  // Marigold border garland.
  const border = new Graphics();
  for (let x = 16; x < W - 8; x += 34) {
    marigold(border, x, 18, 11, MELA.marigold);
    marigold(border, x, H - 18, 11, MELA.marigold);
  }
  for (let y = 52; y < H - 40; y += 34) {
    marigold(border, 18, y, 11, MELA.marigold);
    marigold(border, W - 18, y, 11, MELA.marigold);
  }
  page.addChild(border);
  if (model.mode === 'demo') {
    const stamp = exampleStamp(46);
    stamp.position.set(W / 2, 74);
    page.addChild(stamp);
  }
  traits.forEach((t, i) => {
    const c = traitCard(t, cardW, { print: true });
    c.glow.visible = false;
    const row = Math.floor(i / cols);
    const col = i % cols;
    const inRow = Math.min(cols, traits.length - row * cols);
    c.view.position.set(
      W / 2 + (col - (inRow - 1) / 2) * (cardW + 30),
      120 + cardH / 2 + row * (cardH + 24),
    );
    page.addChild(c.view);
  });
  const badge = snapshotBadge(70);
  badge.position.set(W / 2, 120 + rows * (cardH + 24) + 60);
  page.addChild(badge);
  if (retrievalUrl) {
    const qr = drawQr(encodeQr(retrievalUrl), qrSize, 0x000000, 0xffffff);
    qr.position.set(W / 2, 120 + rows * (cardH + 24) + 130 + qrSize / 2);
    page.addChild(qr);
  }
  return page;
}

/** Render the page to pixels and produce the 1-bit bitmap and ESC/POS bytes (null without a renderer). */
export function rasterisePrintSummary(
  app: Application | null,
  page: Container,
): { bitmap: MonoBitmap; escpos: Uint8Array } | null {
  const renderer = app?.renderer;
  if (!renderer) return null;
  try {
    const out = renderer.extract.pixels({ target: page, resolution: 1 });
    const bitmap = ditherToMono(out.pixels, out.width, out.height);
    return { bitmap, escpos: escposRaster(bitmap) };
  } catch {
    return null;
  }
}

/** A white bitmap preview sprite source (gallery): expand the 1-bit bitmap back to RGBA. */
export function monoToRgba(bmp: MonoBitmap): Uint8ClampedArray {
  const out = new Uint8ClampedArray(bmp.width * bmp.height * 4);
  for (let y = 0; y < bmp.height; y++) {
    for (let x = 0; x < bmp.width; x++) {
      const on = ((bmp.data[y * bmp.bytesPerRow + (x >> 3)] ?? 0) & (0x80 >> (x & 7))) !== 0;
      const i = (y * bmp.width + x) * 4;
      const v = on ? 20 : 250;
      out[i] = v;
      out[i + 1] = v;
      out[i + 2] = v;
      out[i + 3] = 255;
    }
  }
  return out;
}
