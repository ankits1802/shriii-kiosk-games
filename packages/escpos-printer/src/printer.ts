/**
 * Thermal printer service for the one-page picture report (REP-02, KSK-08).
 *
 * `printReport` checks status first (paper out / cover open / error -> no print, the kiosk falls back
 * to the on-screen QR), composes the page (report picture fitted to the head width, optional raster
 * QR below it), dithers it, sends banded GS v 0 raster data, cuts, and checks status again so a roll
 * that ran out mid-print is reported. Paper near end does not block printing but is surfaced for the
 * heartbeat. All operations are serialised: one job at a time per printer.
 */
import { createBitmap, type MonoBitmap, stackCentered } from './bitmap.ts';
import { type DitherOptions, dither } from './dither.ts';
import { cmd, concatBytes, DOTS_80MM, rasterBands } from './escpos.ts';
import { fitToWidth, type RgbaImage, type ToneOptions, toGray } from './image.ts';
import { type QrOptions, qrBitmap } from './qr.ts';
import {
  decodeStatus,
  type PrintBlocker,
  type PrinterStatus,
  printBlocker,
  StatusError,
} from './status.ts';
import type { PrinterTransport } from './transport.ts';

export interface ThermalPrinterOptions {
  /** Head width in dots. Default 576 (80 mm, 203 dpi). */
  readonly widthDots?: number;
  /** Raster band height. Default 128 rows. */
  readonly bandHeight?: number;
  /** Per status byte read timeout. Default 500 ms. */
  readonly statusTimeoutMs?: number;
  /** Bytes per transport write (flow control for small printer buffers). Default 16 KiB. */
  readonly writeChunkBytes?: number;
}

export interface ReportPrintRequest {
  /** The rendered report page (any size; scaled to the head width). */
  readonly image?: RgbaImage;
  /** A pre-dithered bitmap instead of `image` (e.g. kiosk-game `rasterisePrintSummary`). */
  readonly bitmap?: MonoBitmap;
  /** Retrieval URL printed as a raster QR under the picture. */
  readonly qrUrl?: string | null;
  readonly qr?: QrOptions;
  readonly tone?: ToneOptions;
  readonly dither?: DitherOptions;
  /** Blank dot rows between picture and QR. Default 24. */
  readonly gapDots?: number;
  /** Lines fed before the cut. Default 4. */
  readonly feedLines?: number;
}

export type PrintFailure =
  | PrintBlocker
  | 'no_status'
  | 'paper_out_during_print'
  | 'transport_error';

export type PrintResult =
  | {
      readonly ok: true;
      readonly status: PrinterStatus;
      /** Paper is low: report it on the heartbeat (KSK-08 AC: within 60 s). */
      readonly paperNearEnd: boolean;
      readonly dots: { readonly width: number; readonly height: number };
      readonly bytes: number;
    }
  | {
      readonly ok: false;
      readonly reason: PrintFailure;
      readonly status: PrinterStatus | null;
      readonly detail?: string;
    };

export class ThermalPrinter {
  readonly widthDots: number;
  private readonly transport: PrinterTransport;
  private readonly bandHeight: number;
  private readonly statusTimeoutMs: number;
  private readonly writeChunkBytes: number;
  private queue: Promise<unknown> = Promise.resolve();
  private opened = false;

  constructor(transport: PrinterTransport, options: ThermalPrinterOptions = {}) {
    this.transport = transport;
    this.widthDots = options.widthDots ?? DOTS_80MM;
    this.bandHeight = options.bandHeight ?? 128;
    this.statusTimeoutMs = options.statusTimeoutMs ?? 500;
    this.writeChunkBytes = options.writeChunkBytes ?? 16 * 1024;
  }

  get description(): string {
    return this.transport.description;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async ensureOpen(): Promise<void> {
    if (this.opened) return;
    await this.transport.open();
    this.opened = true;
  }

  private async readStatusUnlocked(): Promise<PrinterStatus> {
    await this.ensureOpen();
    this.transport.drain();
    const bytes: number[] = [];
    for (const n of [1, 2, 3, 4] as const) {
      await this.transport.write(cmd.status(n));
      const r = await this.transport.read(1, this.statusTimeoutMs);
      const b = r[0];
      if (b === undefined) throw new StatusError(`no reply to DLE EOT ${n}`);
      bytes.push(b);
    }
    return decodeStatus(bytes as [number, number, number, number]);
  }

  /** Query real-time status (throws {@link StatusError} if the printer does not answer). */
  status(): Promise<PrinterStatus> {
    return this.serial(() => this.readStatusUnlocked());
  }

  /** Compose and dither the report page without printing (preview, gallery, tests). */
  composePage(req: ReportPrintRequest): MonoBitmap {
    const parts: MonoBitmap[] = [];
    if (req.bitmap) {
      if (req.bitmap.width > this.widthDots) {
        throw new RangeError(`bitmap is ${req.bitmap.width} dots, head is ${this.widthDots}`);
      }
      parts.push(req.bitmap);
    } else if (req.image) {
      parts.push(dither(fitToWidth(toGray(req.image, req.tone), this.widthDots), req.dither));
    }
    if (req.qrUrl) {
      if (parts.length > 0) parts.push(createBitmap(this.widthDots, req.gapDots ?? 24));
      parts.push(qrBitmap(req.qrUrl, { maxWidth: Math.min(this.widthDots, 384), ...req.qr }));
    }
    if (parts.length === 0) throw new RangeError('nothing to print: give image, bitmap or qrUrl');
    return stackCentered(parts, this.widthDots);
  }

  /** Encode a page as the full job byte stream. */
  encodeJob(page: MonoBitmap, feedLines = 4): Uint8Array {
    return concatBytes([
      cmd.init(),
      cmd.align('center'),
      ...rasterBands(page, this.bandHeight),
      cmd.feedLines(feedLines),
      cmd.cut(0),
    ]);
  }

  private async writeChunked(bytes: Uint8Array): Promise<void> {
    for (let o = 0; o < bytes.length; o += this.writeChunkBytes) {
      await this.transport.write(bytes.subarray(o, o + this.writeChunkBytes));
    }
  }

  printReport(req: ReportPrintRequest): Promise<PrintResult> {
    return this.serial(async () => {
      let before: PrinterStatus;
      try {
        before = await this.readStatusUnlocked();
      } catch (err) {
        return { ok: false, reason: 'no_status', status: null, detail: errorText(err) };
      }
      const blocker = printBlocker(before);
      if (blocker) return { ok: false, reason: blocker, status: before };
      const page = this.composePage(req);
      const job = this.encodeJob(page, req.feedLines ?? 4);
      try {
        await this.writeChunked(job);
      } catch (err) {
        return { ok: false, reason: 'transport_error', status: before, detail: errorText(err) };
      }
      let after: PrinterStatus;
      try {
        after = await this.readStatusUnlocked();
      } catch (err) {
        return { ok: false, reason: 'no_status', status: null, detail: errorText(err) };
      }
      if (after.paperOut) return { ok: false, reason: 'paper_out_during_print', status: after };
      const late = printBlocker(after);
      if (late) return { ok: false, reason: late, status: after };
      return {
        ok: true,
        status: after,
        paperNearEnd: after.paperNearEnd,
        dots: { width: page.width, height: page.height },
        bytes: job.length,
      };
    });
  }

  async close(): Promise<void> {
    await this.queue;
    if (this.opened) await this.transport.close();
    this.opened = false;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
