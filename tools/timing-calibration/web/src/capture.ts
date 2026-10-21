/**
 * Capture document written by the page (tools/timing-calibration/schemas/capture.v1.schema.json).
 * All *_ms values are performance.now() milliseconds; *_ctx_s values are AudioContext seconds.
 */

export const CAPTURE_FORMAT = 'shriii.timing-capture/1';
export const PAGE_VERSION = '0.1.0';

export interface DeviceInfo {
  hardware_sku: string;
  os_build: string;
  firmware: string;
  shell: string;
  user_agent: string;
  refresh_hz_nominal: number | null;
  screen: { width: number; height: number; dpr: number };
  audio: {
    sample_rate: number | null;
    base_latency_ms: number | null;
    output_latency_ms: number | null;
    output_device: string;
  };
}

export interface VisualTrial {
  i: number;
  requested_ms: number;
  presented_ms: number;
}

export interface TouchTap {
  i: number;
  event_ts_ms: number;
  handler_ms: number;
  flash_presented_ms: number | null;
  x: number;
  y: number;
}

export interface AudioClick {
  i: number;
  scheduled_ctx_s: number;
  scheduled_perf_ms: number;
  detected_ctx_s: number | null;
}

export interface SyncPair {
  host_send_ms: number;
  host_recv_ms: number;
  device_ms: number;
}

export interface Capture {
  format: typeof CAPTURE_FORMAT;
  tool_version: string;
  created_at: string;
  device: DeviceInfo;
  visual: {
    patch: { x: number; y: number; size: number };
    flash_frames: number;
    trials: VisualTrial[];
  } | null;
  touch: { taps: TouchTap[] } | null;
  audio: { input_latency_ms: number | null; clicks: AudioClick[] } | null;
  frames: { raf_ms: number[] } | null;
  sync: { pairs: SyncPair[] } | null;
}

export const SKU_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;

export function newCapture(device: DeviceInfo, now: Date = new Date()): Capture {
  if (!SKU_PATTERN.test(device.hardware_sku)) {
    throw new Error(`hardware_sku must match ${SKU_PATTERN.source}`);
  }
  return {
    format: CAPTURE_FORMAT,
    tool_version: PAGE_VERSION,
    created_at: now.toISOString(),
    device,
    visual: null,
    touch: null,
    audio: null,
    frames: null,
    sync: null,
  };
}

const round = (v: number, digits = 4): number => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

/** Serialise with times rounded to 0.1 µs (keeps files small; far below any measured jitter). */
export function serialiseCapture(capture: Capture): string {
  return `${JSON.stringify(
    capture,
    (key, value: unknown) => {
      if (typeof value !== 'number' || Number.isInteger(value)) return value;
      return key.endsWith('_ctx_s') ? round(value, 7) : round(value);
    },
    1,
  )}\n`;
}

export function captureFileName(capture: Capture): string {
  const stamp = capture.created_at.replace(/[:.]/g, '-');
  return `timing-capture_${capture.device.hardware_sku}_${stamp}.json`;
}
