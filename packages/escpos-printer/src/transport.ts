/**
 * Printer transports. The printer logic only needs ordered byte writes and short, timed reads of
 * status bytes, so every link (USB printer-class device, serial port, TCP 9100, virtual) is reduced
 * to {@link PrinterTransport}.
 *
 * - {@link NetworkTransport}: raw TCP (port 9100), the common Ethernet interface.
 * - {@link DeviceFileTransport}: a character device opened read/write — Linux `usblp`
 *   (`/dev/usb/lp0`) for USB printer-class devices, or a tty (`/dev/ttyUSB0`, already configured with
 *   `stty`) for serial. This is how the Ubuntu Core kiosk talks to the reference printer.
 * - {@link StreamTransport}: wraps any Duplex (e.g. a `serialport` instance) for platforms where a
 *   device file is not available.
 */
import { open as openFile, type FileHandle } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

export interface PrinterTransport {
  /** Human-readable link description for logs and heartbeat. */
  readonly description: string;
  open(): Promise<void>;
  write(data: Uint8Array): Promise<void>;
  /**
   * Read up to `maxBytes`, resolving as soon as at least one byte is available or with an empty
   * array after `timeoutMs`.
   */
  read(maxBytes: number, timeoutMs: number): Promise<Uint8Array>;
  /** Discard buffered input (stale status bytes). */
  drain(): void;
  close(): Promise<void>;
}

export class TransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TransportError';
  }
}

/** Shared receive buffer with waiter support for stream-like links. */
class RxBuffer {
  private chunks: Uint8Array[] = [];
  private waiters: (() => void)[] = [];

  push(data: Uint8Array): void {
    this.chunks.push(data);
    for (const w of this.waiters.splice(0)) w();
  }

  get size(): number {
    return this.chunks.reduce((n, c) => n + c.length, 0);
  }

  take(max: number): Uint8Array {
    const out: number[] = [];
    while (out.length < max && this.chunks.length > 0) {
      const head = this.chunks[0] as Uint8Array;
      const n = Math.min(max - out.length, head.length);
      for (let i = 0; i < n; i += 1) out.push(head[i] ?? 0);
      if (n === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(n);
    }
    return Uint8Array.from(out);
  }

  clear(): void {
    this.chunks = [];
  }

  wait(timeoutMs: number): Promise<void> {
    if (this.size > 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== done);
        resolve();
      }, timeoutMs);
      this.waiters.push(done);
    });
  }
}

/** Raw TCP printer (port 9100). */
export class NetworkTransport implements PrinterTransport {
  readonly description: string;
  private readonly host: string;
  private readonly port: number;
  private readonly connectTimeoutMs: number;
  private socket: Socket | null = null;
  private readonly rx = new RxBuffer();

  constructor(options: { host: string; port?: number; connectTimeoutMs?: number }) {
    this.host = options.host;
    this.port = options.port ?? 9100;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 3000;
    this.description = `tcp://${this.host}:${this.port}`;
  }

  open(): Promise<void> {
    if (this.socket) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const socket = connect({ host: this.host, port: this.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new TransportError(`connect timeout ${this.description}`));
      }, this.connectTimeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.setNoDelay(true);
        this.socket = socket;
        resolve();
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        this.socket = null;
        reject(new TransportError(`connect failed ${this.description}`, { cause: err }));
      });
      socket.on('data', (d: Buffer) => this.rx.push(new Uint8Array(d)));
      socket.on('close', () => {
        this.socket = null;
      });
    });
  }

  write(data: Uint8Array): Promise<void> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new TransportError('not connected'));
    return new Promise((resolve, reject) => {
      socket.write(data, (err) => (err ? reject(new TransportError('write failed', { cause: err })) : resolve()));
    });
  }

  async read(maxBytes: number, timeoutMs: number): Promise<Uint8Array> {
    await this.rx.wait(timeoutMs);
    return this.rx.take(maxBytes);
  }

  drain(): void {
    this.rx.clear();
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    await new Promise<void>((resolve) => socket.end(() => resolve()));
    socket.destroy();
  }
}

/** Wraps a Duplex stream (serialport, USB library streams, test pipes). */
export class StreamTransport implements PrinterTransport {
  readonly description: string;
  private readonly stream: Duplex;
  private readonly rx = new RxBuffer();
  private listening = false;

  constructor(stream: Duplex, description = 'stream') {
    this.stream = stream;
    this.description = description;
  }

  async open(): Promise<void> {
    if (this.listening) return;
    this.listening = true;
    this.stream.on('data', (d: Buffer | Uint8Array) => this.rx.push(new Uint8Array(d)));
  }

  write(data: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      this.stream.write(data, (err) => (err ? reject(new TransportError('write failed', { cause: err })) : resolve()));
    });
  }

  async read(maxBytes: number, timeoutMs: number): Promise<Uint8Array> {
    await this.rx.wait(timeoutMs);
    return this.rx.take(maxBytes);
  }

  drain(): void {
    this.rx.clear();
  }

  async close(): Promise<void> {
    this.stream.end();
  }
}

/**
 * Character-device transport (Linux usblp `/dev/usb/lp0`, serial tty). Reads poll the device with a
 * short interval because character devices do not support async readiness through node:fs.
 */
export class DeviceFileTransport implements PrinterTransport {
  readonly description: string;
  private readonly path: string;
  private readonly pollMs: number;
  private handle: FileHandle | null = null;

  constructor(options: { path: string; pollMs?: number }) {
    this.path = options.path;
    this.pollMs = options.pollMs ?? 20;
    this.description = `device://${this.path}`;
  }

  async open(): Promise<void> {
    if (this.handle) return;
    try {
      this.handle = await openFile(this.path, 'r+');
    } catch (err) {
      throw new TransportError(`cannot open ${this.path}`, { cause: err });
    }
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.handle) throw new TransportError('device not open');
    let offset = 0;
    while (offset < data.length) {
      const { bytesWritten } = await this.handle.write(data, offset, data.length - offset);
      offset += bytesWritten;
    }
  }

  async read(maxBytes: number, timeoutMs: number): Promise<Uint8Array> {
    if (!this.handle) throw new TransportError('device not open');
    const deadline = Date.now() + timeoutMs;
    const buf = new Uint8Array(maxBytes);
    for (;;) {
      const { bytesRead } = await this.handle.read(buf, 0, maxBytes, null);
      if (bytesRead > 0) return buf.slice(0, bytesRead);
      if (Date.now() >= deadline) return new Uint8Array(0);
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
  }

  drain(): void {
    // Status replies are read synchronously after each request; nothing is buffered here.
  }

  async close(): Promise<void> {
    const h = this.handle;
    this.handle = null;
    await h?.close();
  }
}
