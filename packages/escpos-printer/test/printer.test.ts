import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex, PassThrough } from 'node:stream';
import jsQR from 'jsqr';
import { afterAll, describe, expect, it } from 'vitest';
import { bitmapsEqual, sliceRows } from '../src/bitmap.ts';
import { decodePng } from '../src/png.ts';
import { ThermalPrinter } from '../src/printer.ts';
import {
  decodeStatus,
  encodeStatus,
  type PrinterStatus,
  printBlocker,
  READY_STATUS,
  StatusError,
} from '../src/status.ts';
import { DeviceFileTransport, NetworkTransport, StreamTransport } from '../src/transport.ts';
import { VirtualPrinter } from '../src/virtual-printer.ts';
import { monoToRgba, pictureReport } from './helpers.ts';

const dir = mkdtempSync(join(tmpdir(), 'escpos-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const URL_ = 'https://shriii.example/r/01928c6e-7d3a-7b2c-8f00-1234567890ab';

describe('status decoding', () => {
  it('round-trips every flag', () => {
    const flags: (keyof PrinterStatus)[] = [
      'coverOpen',
      'paperNearEnd',
      'paperOut',
      'cutterError',
      'unrecoverableError',
      'recoverableError',
    ];
    expect(decodeStatus(encodeStatus(READY_STATUS))).toEqual(READY_STATUS);
    for (const f of flags) {
      const s = { ...READY_STATUS, [f]: true };
      const d = decodeStatus(encodeStatus(s));
      expect(d[f]).toBe(true);
    }
    expect(decodeStatus([0x12, 0x12, 0x12, 0x7e]).paperOut).toBe(true);
    expect(decodeStatus([0x12, 0x12, 0x12, 0x1e]).paperNearEnd).toBe(true);
    expect(decodeStatus([0x1a, 0x12, 0x12, 0x12]).online).toBe(false);
  });

  it('rejects bytes that are not status responses', () => {
    expect(() => decodeStatus([0x00, 0x12, 0x12, 0x12])).toThrow(StatusError);
    expect(() => decodeStatus([0x12, 0x12, 0x12, 0x92])).toThrow(StatusError);
  });

  it('maps conditions to blockers (near end does not block)', () => {
    expect(printBlocker(READY_STATUS)).toBeNull();
    expect(printBlocker({ ...READY_STATUS, paperNearEnd: true })).toBeNull();
    expect(printBlocker({ ...READY_STATUS, paperOut: true, online: false })).toBe('paper_out');
    expect(printBlocker({ ...READY_STATUS, coverOpen: true })).toBe('cover_open');
    expect(printBlocker({ ...READY_STATUS, online: false })).toBe('offline');
  });
});

describe('ThermalPrinter on the virtual printer', () => {
  it('prints the picture report with a QR exactly as composed, and writes a PNG', async () => {
    const vp = new VirtualPrinter({ outputDir: join(dir, 'out') });
    const printer = new ThermalPrinter(vp);
    const req = { image: pictureReport(), qrUrl: URL_ };
    const result = await printer.printReport(req);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dots.width).toBe(576);
    expect(vp.protocolErrors).toEqual([]);
    expect(vp.pages).toHaveLength(1);
    const page = vp.pages[0];
    if (!page) throw new Error('page');
    const composed = printer.composePage(req);
    // The paper holds the composed page followed by the feed lines before the cut.
    expect(bitmapsEqual(sliceRows(page, 0, composed.height), composed)).toBe(true);
    expect(page.height).toBe(composed.height + 4 * 30);
    const file = vp.files[0] ?? '';
    expect(existsSync(file)).toBe(true);
    const png = decodePng(new Uint8Array(readFileSync(file)));
    expect(bitmapsEqual(png, page)).toBe(true);
    // The printed QR (bottom of the page) scans.
    const img = monoToRgba(page, 8);
    expect(jsQR(img.data, img.width, img.height)?.data).toBe(URL_);
    await printer.close();
  });

  it('accepts a pre-dithered bitmap and QR-only pages', async () => {
    const vp = new VirtualPrinter();
    const printer = new ThermalPrinter(vp);
    const qrOnly = await printer.printReport({ qrUrl: URL_ });
    expect(qrOnly.ok).toBe(true);
    const bitmap = printer.composePage({ image: pictureReport(300, 300) });
    expect((await printer.printReport({ bitmap })).ok).toBe(true);
    expect(vp.pages).toHaveLength(2);
    expect(() => printer.composePage({})).toThrow(/nothing to print/);
  });

  it('does not print when paper is out or the cover is open', async () => {
    const vp = new VirtualPrinter({ paperDots: 0 });
    const printer = new ThermalPrinter(vp);
    const r = await printer.printReport({ qrUrl: URL_ });
    expect(r).toMatchObject({ ok: false, reason: 'paper_out' });
    expect(vp.received.filter((b) => b === 0x76)).toHaveLength(0); // no GS v sent
    vp.loadPaper();
    vp.setState({ coverOpen: true });
    expect(await printer.printReport({ qrUrl: URL_ })).toMatchObject({
      ok: false,
      reason: 'cover_open',
    });
    vp.setState({ coverOpen: false });
    expect((await printer.printReport({ qrUrl: URL_ })).ok).toBe(true);
  });

  it('flags paper near end but still prints', async () => {
    const vp = new VirtualPrinter({ paperDots: 1500, nearEndDots: 2000 });
    const printer = new ThermalPrinter(vp);
    const r = await printer.printReport({ qrUrl: URL_ });
    expect(r).toMatchObject({ ok: true, paperNearEnd: true });
    expect((await printer.status()).paperNearEnd).toBe(true);
  });

  it('reports a roll that runs out mid-print', async () => {
    const vp = new VirtualPrinter({ paperDots: 300 });
    const printer = new ThermalPrinter(vp);
    const r = await printer.printReport({ image: pictureReport() });
    expect(r).toMatchObject({ ok: false, reason: 'paper_out_during_print' });
  });

  it('reports an unresponsive printer instead of hanging', async () => {
    const vp = new VirtualPrinter({ unresponsive: true });
    const printer = new ThermalPrinter(vp, { statusTimeoutMs: 30 });
    expect(await printer.printReport({ qrUrl: URL_ })).toMatchObject({
      ok: false,
      reason: 'no_status',
    });
    await expect(printer.status()).rejects.toThrow(StatusError);
  });

  it('serialises concurrent jobs', async () => {
    const vp = new VirtualPrinter();
    const printer = new ThermalPrinter(vp);
    const results = await Promise.all([
      printer.printReport({ qrUrl: `${URL_}?a` }),
      printer.printReport({ qrUrl: `${URL_}?b` }),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(vp.pages).toHaveLength(2);
    expect(vp.protocolErrors).toEqual([]);
    const decoded = vp.pages.map((p) => {
      const img = monoToRgba(p, 8);
      return jsQR(img.data, img.width, img.height)?.data;
    });
    expect(decoded).toEqual([`${URL_}?a`, `${URL_}?b`]);
  });
});

/** A TCP "printer" on localhost backed by a VirtualPrinter. */
function tcpPrinter(vp: VirtualPrinter): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      void vp.open();
      socket.on('data', async (d: Buffer) => {
        await vp.write(new Uint8Array(d));
        const reply = await vp.read(64, 0);
        if (reply.length > 0) socket.write(reply);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === 'object' && addr ? addr.port : 0 });
    });
  });
}

describe('transports', () => {
  it('prints over TCP 9100-style raw sockets', async () => {
    const vp = new VirtualPrinter();
    const { server, port } = await tcpPrinter(vp);
    const printer = new ThermalPrinter(new NetworkTransport({ host: '127.0.0.1', port }));
    try {
      const r = await printer.printReport({ qrUrl: URL_ });
      expect(r.ok).toBe(true);
      expect(vp.pages).toHaveLength(1);
      expect(vp.protocolErrors).toEqual([]);
    } finally {
      await printer.close();
      server.close();
    }
  });

  it('reconnects after the network printer drops the link (power cycle)', async () => {
    const vp = new VirtualPrinter();
    const { server, port } = await tcpPrinter(vp);
    const sockets = new Set<import('node:net').Socket>();
    server.on('connection', (s) => sockets.add(s));
    const printer = new ThermalPrinter(new NetworkTransport({ host: '127.0.0.1', port }), {
      statusTimeoutMs: 200,
    });
    try {
      expect((await printer.printReport({ qrUrl: URL_ })).ok).toBe(true);
      for (const s of sockets) s.destroy();
      sockets.clear();
      await new Promise((r) => setTimeout(r, 50));
      // The first job after the drop may fail on the dead link; the printer must not stay broken.
      const first = await printer.printReport({ qrUrl: URL_ });
      const result = first.ok ? first : await printer.printReport({ qrUrl: URL_ });
      expect(result.ok).toBe(true);
      expect(vp.pages.length).toBeGreaterThanOrEqual(2);
      expect((await printer.status()).online).toBe(true);
    } finally {
      await printer.close();
      server.close();
    }
  });

  it('fails fast when the network printer is unreachable', async () => {
    const printer = new ThermalPrinter(
      new NetworkTransport({ host: '127.0.0.1', port: 1, connectTimeoutMs: 500 }),
    );
    expect(await printer.printReport({ qrUrl: URL_ })).toMatchObject({
      ok: false,
      reason: 'no_status',
    });
  });

  it('prints over a generic duplex stream (serial port)', async () => {
    const vp = new VirtualPrinter();
    await vp.open();
    const toHost = new PassThrough();
    const port = new Duplex({
      read() {},
      write(chunk: Buffer, _enc, cb) {
        void vp.write(new Uint8Array(chunk)).then(async () => {
          const reply = await vp.read(64, 0);
          if (reply.length > 0) toHost.write(reply);
          cb();
        });
      },
    });
    toHost.on('data', (d) => port.push(d));
    const printer = new ThermalPrinter(new StreamTransport(port, 'serial://test'));
    expect((await printer.printReport({ qrUrl: URL_ })).ok).toBe(true);
    expect(vp.pages).toHaveLength(1);
  });

  it('writes to a character device path and times out reads', async () => {
    const path = join(dir, 'lp0');
    writeFileSync(path, '');
    const t = new DeviceFileTransport({ path, pollMs: 5 });
    await t.open();
    await t.write(Uint8Array.of(0x1b, 0x40));
    const r = await t.read(1, 30);
    expect(r.length).toBeLessThanOrEqual(1);
    await t.close();
    expect([...readFileSync(path)]).toEqual([0x1b, 0x40]);
    await expect(
      new DeviceFileTransport({ path: join(dir, 'missing', 'lp9') }).open(),
    ).rejects.toThrow(/cannot open/);
  });
});
