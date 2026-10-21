/**
 * Measurement protocols. Every protocol logs page-clock timestamps only; the physical side comes from
 * the rig (photodiode, solenoid tapper, microphone) or a high-speed camera and is imported as CSV.
 *
 * Presented-time convention (ENG-01): the patch is switched inside a rAF callback, and the timestamp of
 * the *next* rAF callback (the "rAF after commit") is recorded as presented_ms, exactly as the kiosk
 * timing service records presented_onset before adding the per-SKU display offset.
 */

import type { AudioClick, ClockMapping, SyncPair, TouchTap, VisualTrial } from './capture.ts';
import { findOnset, jitteredSchedule, normalisePoint, parseSyncReply } from './lib.ts';

export type Progress = (done: number, total: number) => void;

const nextFrame = (): Promise<number> => new Promise((resolve) => requestAnimationFrame(resolve));

export interface VisualOptions {
  n: number;
  minIsiMs: number;
  maxIsiMs: number;
  seed: number;
  flashFrames: number;
}

/** Photodiode protocol: flash the patch white for `flashFrames` frames at jittered intervals. */
export async function runVisual(
  opts: VisualOptions,
  patch: HTMLElement,
  onProgress: Progress,
  signal: AbortSignal,
): Promise<VisualTrial[]> {
  const start = (await nextFrame()) + 1500;
  const schedule = jitteredSchedule(opts.n, opts.minIsiMs, opts.maxIsiMs, opts.seed, start);
  const trials: VisualTrial[] = [];
  let lastTs = start - 1500;
  let period = 1000 / 60;
  for (let i = 0; i < schedule.length && !signal.aborted; i++) {
    const requested = schedule[i] ?? 0;
    let ts = await nextFrame();
    while (ts < requested - period / 2 && !signal.aborted) {
      period = 0.95 * period + 0.05 * Math.min(Math.max(ts - lastTs, 1), 100);
      lastTs = ts;
      ts = await nextFrame();
    }
    patch.style.background = '#fff';
    const presented = await nextFrame();
    trials.push({ i, requested_ms: requested, presented_ms: presented });
    for (let f = 1; f < opts.flashFrames; f++) await nextFrame();
    patch.style.background = '#000';
    lastTs = await nextFrame();
    onProgress(i + 1, schedule.length);
  }
  patch.style.background = '#000';
  return trials;
}

export interface TouchOptions {
  n: number;
  flashFrames: number;
}

/**
 * Tapper / camera protocol: every pointerdown on the target is logged with PointerEvent.timeStamp and
 * flashes the patch, so a high-speed camera sees contact and photon in one frame stream.
 */
export function runTouch(
  opts: TouchOptions,
  target: HTMLElement,
  patch: HTMLElement,
  onProgress: Progress,
  signal: AbortSignal,
): Promise<TouchTap[]> {
  return new Promise((resolve) => {
    const taps: TouchTap[] = [];
    let flashing = false;
    const finish = (): void => {
      target.removeEventListener('pointerdown', onDown);
      patch.style.background = '#000';
      resolve(taps);
    };
    const onDown = (ev: PointerEvent): void => {
      const handler = performance.now();
      ev.preventDefault();
      const p = normalisePoint(ev.clientX, ev.clientY, target.getBoundingClientRect());
      const tap: TouchTap = {
        i: taps.length,
        event_ts_ms: ev.timeStamp,
        handler_ms: handler,
        flash_presented_ms: null,
        x: p.x,
        y: p.y,
      };
      taps.push(tap);
      onProgress(taps.length, opts.n);
      if (!flashing) {
        flashing = true;
        requestAnimationFrame(async () => {
          patch.style.background = '#fff';
          tap.flash_presented_ms = await nextFrame();
          for (let f = 1; f < opts.flashFrames; f++) await nextFrame();
          patch.style.background = '#000';
          flashing = false;
          if (taps.length >= opts.n) finish();
        });
      } else if (taps.length >= opts.n) {
        finish();
      }
    };
    target.addEventListener('pointerdown', onDown);
    signal.addEventListener('abort', finish, { once: true });
  });
}

export interface AudioOptions {
  n: number;
  minIsiMs: number;
  maxIsiMs: number;
  seed: number;
  loopback: boolean;
  threshold: number;
}

export interface AudioResult {
  clicks: AudioClick[];
  inputLatencyMs: number | null;
  clockMapping: ClockMapping;
  context: { sampleRate: number; baseLatencyMs: number | null; outputLatencyMs: number | null };
}

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage({ frame: currentFrame, data: ch.slice(0) });
    return true;
  }
}
registerProcessor('shriii-loopback-tap', Tap);
`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Map an AudioContext time to the page clock through getOutputTimestamp (the same mapping the kiosk
 * audio engine must use when it logs audio_onset); falls back to currentTime sampled with now(). */
function ctxToPerf(
  ctx: AudioContext,
  ctxTime: number,
): { ms: number; via: 'output_timestamp' | 'current_time' } {
  const ts = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null;
  if (
    ts &&
    ts.contextTime !== undefined &&
    ts.performanceTime !== undefined &&
    ts.performanceTime > 0
  ) {
    return { ms: ts.performanceTime + (ctxTime - ts.contextTime) * 1000, via: 'output_timestamp' };
  }
  return { ms: performance.now() + (ctxTime - ctx.currentTime) * 1000, via: 'current_time' };
}

/** Audio protocol: 2 ms full-scale clicks at jittered intervals; optional in-page loopback capture. */
export async function runAudio(
  opts: AudioOptions,
  onProgress: Progress,
  signal: AbortSignal,
): Promise<AudioResult> {
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  await ctx.resume();
  const sr = ctx.sampleRate;
  const click = ctx.createBuffer(1, Math.round(sr * 0.002), sr);
  click.getChannelData(0).fill(1);

  const blocks: { frame: number; data: Float32Array }[] = [];
  let stream: MediaStream | null = null;
  let inputLatencyMs: number | null = null;
  if (opts.loopback) {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const settings = stream.getAudioTracks()[0]?.getSettings() as MediaTrackSettings & {
      latency?: number;
    };
    inputLatencyMs = typeof settings.latency === 'number' ? settings.latency * 1000 : null;
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const node = new AudioWorkletNode(ctx, 'shriii-loopback-tap');
    node.port.onmessage = (e: MessageEvent<{ frame: number; data: Float32Array }>) =>
      blocks.push(e.data);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    ctx.createMediaStreamSource(stream).connect(node).connect(mute).connect(ctx.destination);
  }

  const offsets = jitteredSchedule(opts.n, opts.minIsiMs, opts.maxIsiMs, opts.seed);
  const t0 = ctx.currentTime + 1;
  const clicks: AudioClick[] = [];
  const vias = new Set<'output_timestamp' | 'current_time'>();
  for (let i = 0; i < offsets.length && !signal.aborted; i++) {
    const at = t0 + (offsets[i] ?? 0) / 1000;
    while (at - ctx.currentTime > 0.15 && !signal.aborted) await sleep(20);
    const src = ctx.createBufferSource();
    src.buffer = click;
    src.connect(ctx.destination);
    src.start(at);
    const mapped = ctxToPerf(ctx, at);
    vias.add(mapped.via);
    clicks.push({
      i,
      scheduled_ctx_s: at,
      scheduled_perf_ms: mapped.ms,
      detected_ctx_s: null,
    });
    onProgress(i + 1, offsets.length);
  }
  await sleep(800);

  if (opts.loopback && blocks.length > 0) {
    // Blocks carry their AudioContext frame, so gaps (a lost message) stay silent instead of
    // shifting later samples.
    const first = blocks[0]?.frame ?? 0;
    const last = blocks.at(-1);
    const total = last ? last.frame + last.data.length - first : 0;
    const all = new Float32Array(total);
    for (const b of blocks) all.set(b.data, b.frame - first);
    for (const c of clicks) {
      const from = Math.round(c.scheduled_ctx_s * sr) - first;
      const window = all.subarray(Math.max(0, from), Math.max(0, from + Math.round(0.5 * sr)));
      const k = findOnset(window, opts.threshold);
      if (k >= 0) c.detected_ctx_s = (Math.max(0, from) + k + first) / sr;
    }
  }
  for (const t of stream?.getTracks() ?? []) t.stop();
  const context = {
    sampleRate: sr,
    baseLatencyMs: typeof ctx.baseLatency === 'number' ? ctx.baseLatency * 1000 : null,
    outputLatencyMs: typeof ctx.outputLatency === 'number' ? ctx.outputLatency * 1000 : null,
  };
  await ctx.close();
  const clockMapping: ClockMapping =
    vias.size > 1 ? 'mixed' : vias.has('current_time') ? 'current_time' : 'output_timestamp';
  return { clicks, inputLatencyMs, clockMapping, context };
}

/** Frame protocol: log every rAF timestamp for `seconds` (keep the page otherwise idle). */
export async function runFrames(
  seconds: number,
  onProgress: Progress,
  signal: AbortSignal,
): Promise<number[]> {
  const out: number[] = [];
  const first = await nextFrame();
  out.push(first);
  const end = first + seconds * 1000;
  let ts = first;
  while (ts < end && !signal.aborted) {
    ts = await nextFrame();
    out.push(ts);
    if (out.length % 60 === 0) onProgress(Math.round(ts - first), seconds * 1000);
  }
  return out;
}

interface SerialPortLike {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
}

interface SerialLike {
  requestPort(): Promise<SerialPortLike>;
}

export const serialAvailable = (): boolean => 'serial' in navigator;

/**
 * Host <-> rig clock sync over Web Serial (115200 baud). The page writes `P<seq>\n`; the rig firmware
 * replies `<seq> <device_us>\n` with its clock at reception. Each round trip is one sync pair.
 */
export async function runSerialSync(
  n: number,
  intervalMs: number,
  onProgress: Progress,
  signal: AbortSignal,
): Promise<SyncPair[]> {
  const serial = (navigator as Navigator & { serial?: SerialLike }).serial;
  if (!serial) throw new Error('Web Serial is not available in this browser');
  const port = await serial.requestPort();
  await port.open({ baudRate: 115200 });
  if (!port.readable || !port.writable) throw new Error('serial port is not readable/writable');
  const writer = port.writable.getWriter();
  const reader = port.readable.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const pending = new Map<number, number>();
  const pairs: SyncPair[] = [];
  let buffer = '';
  let reading = true;
  const readLoop = (async () => {
    while (reading) {
      const { value, done } = await reader.read();
      const recv = performance.now();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const reply = parseSyncReply(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        const sent = reply ? pending.get(reply.seq) : undefined;
        if (reply && sent !== undefined) {
          pending.delete(reply.seq);
          pairs.push({ host_send_ms: sent, host_recv_ms: recv, device_ms: reply.deviceMs });
          onProgress(pairs.length, n);
        }
        nl = buffer.indexOf('\n');
      }
    }
  })();
  for (let seq = 0; seq < n && !signal.aborted; seq++) {
    pending.set(seq, performance.now());
    await writer.write(encoder.encode(`P${seq}\n`));
    await sleep(intervalMs);
  }
  await sleep(300);
  reading = false;
  await reader.cancel();
  await readLoop;
  writer.releaseLock();
  reader.releaseLock();
  await port.close();
  return pairs;
}
