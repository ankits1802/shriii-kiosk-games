/**
 * A virtual 80 mm ESC/POS printer: a {@link PrinterTransport} that interprets the byte stream the
 * real printer would receive, renders the paper as a bitmap, answers DLE EOT status requests from a
 * simulated state (paper roll length, near-end sensor, cover, errors) and writes each cut page as a
 * PNG. Used by tests, the dev kiosk (no hardware) and the report gallery.
 *
 * Unknown or malformed commands are recorded in {@link VirtualPrinter.protocolErrors} so encoder bugs
 * fail tests instead of printing garbage.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBitmap, type MonoBitmap, setDot } from './bitmap.ts';
import { DLE, DOTS_80MM, EOT, ESC, GS } from './escpos.ts';
import { encodePng } from './png.ts';
import { encodeStatus, type PrinterStatus, READY_STATUS } from './status.ts';
import type { PrinterTransport } from './transport.ts';

export interface VirtualPrinterOptions {
  readonly widthDots?: number;
  /** Remaining paper on the roll, in dot rows (Infinity = endless). */
  readonly paperDots?: number;
  /** Near-end sensor trips when remaining paper drops below this many dot rows. */
  readonly nearEndDots?: number;
  /** Dot rows per `ESC d` line feed. Default 30 (3.75 mm at 203 dpi). */
  readonly lineDots?: number;
  /** Write each cut page as `page-<n>.png` into this directory. */
  readonly outputDir?: string;
  /** Do not answer status requests (simulates a hung or disconnected printer). */
  readonly unresponsive?: boolean;
}

export class VirtualPrinter implements PrinterTransport {
  readonly description = 'virtual://escpos-80mm';
  readonly widthDots: number;
  readonly pages: MonoBitmap[] = [];
  readonly protocolErrors: string[] = [];
  /** Every byte received, for byte-level assertions. */
  readonly received: number[] = [];
  state: PrinterStatus = READY_STATUS;
  unresponsive: boolean;
  private paperDots: number;
  private readonly nearEndDots: number;
  private readonly lineDots: number;
  private readonly outputDir: string | undefined;
  private rows: Uint8Array[] = [];
  private align = 0;
  private pending: number[] = [];
  private rx: number[] = [];
  private isOpen = false;
  /** Pages written to disk. */
  readonly files: string[] = [];

  constructor(options: VirtualPrinterOptions = {}) {
    this.widthDots = options.widthDots ?? DOTS_80MM;
    this.paperDots = options.paperDots ?? Number.POSITIVE_INFINITY;
    this.nearEndDots = options.nearEndDots ?? 2000;
    this.lineDots = options.lineDots ?? 30;
    this.outputDir = options.outputDir;
    this.unresponsive = options.unresponsive ?? false;
    this.updatePaperSensors();
  }

  /** Load a fresh roll. */
  loadPaper(dots = Number.POSITIVE_INFINITY): void {
    this.paperDots = dots;
    this.updatePaperSensors();
  }

  setState(patch: Partial<PrinterStatus>): void {
    this.state = { ...this.state, ...patch };
  }

  get remainingPaperDots(): number {
    return this.paperDots;
  }

  /** Rows printed since the last cut (not yet a page). */
  get pendingRows(): number {
    return this.rows.length;
  }

  private updatePaperSensors(): void {
    this.state = {
      ...this.state,
      paperOut: this.paperDots <= 0,
      paperNearEnd: this.paperDots < this.nearEndDots,
    };
  }

  private canPrint(): boolean {
    return this.state.online && !this.state.coverOpen && !this.state.paperOut && !this.state.unrecoverableError;
  }

  private emitRow(row: Uint8Array): void {
    if (!this.canPrint()) return;
    this.rows.push(row);
    this.paperDots -= 1;
    this.updatePaperSensors();
  }

  private blankRows(n: number): void {
    for (let i = 0; i < n; i += 1) this.emitRow(new Uint8Array(Math.ceil(this.widthDots / 8)));
  }

  private cut(): void {
    if (this.rows.length === 0) return;
    const page = createBitmap(this.widthDots, this.rows.length);
    this.rows.forEach((r, y) => page.data.set(r.subarray(0, page.bytesPerRow), y * page.bytesPerRow));
    this.rows = [];
    this.pages.push(page);
    if (this.outputDir) {
      mkdirSync(this.outputDir, { recursive: true });
      const file = join(this.outputDir, `page-${this.pages.length}.png`);
      writeFileSync(file, encodePng(page));
      this.files.push(file);
    }
  }

  private rasterRows(bytesPerRow: number, rows: number, data: number[]): void {
    const imgWidth = bytesPerRow * 8;
    if (imgWidth > this.widthDots + 7) {
      this.protocolErrors.push(`raster ${imgWidth} dots wider than paper ${this.widthDots}`);
    }
    const offset =
      this.align === 1 ? Math.max(0, Math.floor((this.widthDots - imgWidth) / 2)) : this.align === 2 ? Math.max(0, this.widthDots - imgWidth) : 0;
    for (let y = 0; y < rows; y += 1) {
      const row = createBitmap(this.widthDots, 1);
      for (let x = 0; x < imgWidth; x += 1) {
        const byte = data[y * bytesPerRow + (x >> 3)] ?? 0;
        if (byte & (0x80 >> (x & 7))) setDot(row, offset + x, 0, true);
      }
      this.emitRow(row.data);
    }
  }

  /** Parse as many complete commands as are buffered. */
  private parse(): void {
    const b = this.pending;
    let i = 0;
    const need = (n: number): boolean => i + n <= b.length;
    while (i < b.length) {
      const c = b[i] ?? 0;
      if (c === ESC) {
        if (!need(2)) break;
        const op = b[i + 1];
        if (op === 0x40) {
          this.align = 0;
          i += 2;
        } else if (op === 0x61 || op === 0x64 || op === 0x4a) {
          if (!need(3)) break;
          const n = b[i + 2] ?? 0;
          if (op === 0x61) this.align = n === 1 || n === 0x31 ? 1 : n === 2 || n === 0x32 ? 2 : 0;
          else if (op === 0x64) this.blankRows(n * this.lineDots);
          else this.blankRows(n);
          i += 3;
        } else {
          this.protocolErrors.push(`unknown ESC 0x${(op ?? 0).toString(16)}`);
          i += 2;
        }
      } else if (c === GS) {
        if (!need(2)) break;
        const op = b[i + 1];
        if (op === 0x56) {
          if (!need(3)) break;
          const m = b[i + 2] ?? 0;
          if (m === 0x41 || m === 0x42) {
            if (!need(4)) break;
            this.blankRows(b[i + 3] ?? 0);
            i += 4;
          } else {
            i += 3;
          }
          this.cut();
        } else if (op === 0x76) {
          if (!need(8)) break;
          if (b[i + 2] !== 0x30) this.protocolErrors.push('GS v: expected 0x30');
          const bytesPerRow = (b[i + 4] ?? 0) | ((b[i + 5] ?? 0) << 8);
          const rows = (b[i + 6] ?? 0) | ((b[i + 7] ?? 0) << 8);
          const len = bytesPerRow * rows;
          if (!need(8 + len)) break;
          this.rasterRows(bytesPerRow, rows, b.slice(i + 8, i + 8 + len));
          i += 8 + len;
        } else {
          this.protocolErrors.push(`unknown GS 0x${(op ?? 0).toString(16)}`);
          i += 2;
        }
      } else if (c === DLE) {
        if (!need(3)) break;
        const n = b[i + 2] ?? 0;
        if (b[i + 1] !== EOT || n < 1 || n > 4) this.protocolErrors.push('bad DLE EOT');
        else if (!this.unresponsive) this.rx.push(encodeStatus(this.state)[n - 1] ?? 0);
        i += 3;
      } else if (c === 0x0a) {
        this.blankRows(this.lineDots);
        i += 1;
      } else {
        this.protocolErrors.push(`unexpected byte 0x${c.toString(16)}`);
        i += 1;
      }
    }
    this.pending = b.slice(i);
  }

  async open(): Promise<void> {
    this.isOpen = true;
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.isOpen) throw new Error('virtual printer not open');
    for (const byte of data) {
      this.received.push(byte);
      this.pending.push(byte);
    }
    this.parse();
  }

  async read(maxBytes: number, timeoutMs: number): Promise<Uint8Array> {
    if (this.rx.length === 0 && timeoutMs > 0) {
      await new Promise((r) => setTimeout(r, Math.min(timeoutMs, 5)));
    }
    return Uint8Array.from(this.rx.splice(0, maxBytes));
  }

  drain(): void {
    this.rx = [];
  }

  async close(): Promise<void> {
    this.isOpen = false;
  }

  /** The last cut page as PNG bytes. */
  lastPagePng(): Uint8Array | null {
    const page = this.pages.at(-1);
    return page ? encodePng(page) : null;
  }
}
