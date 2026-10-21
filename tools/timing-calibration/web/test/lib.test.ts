import { describe, expect, it } from 'vitest';
import schema from '../../schemas/capture.v1.schema.json';
import {
  CAPTURE_FORMAT,
  type Capture,
  captureFileName,
  type DeviceInfo,
  newCapture,
  serialiseCapture,
} from '../src/capture.ts';
import {
  bestSyncEstimate,
  findOnset,
  jitteredSchedule,
  mulberry32,
  normalisePoint,
  parseSyncReply,
  summariseFrames,
} from '../src/lib.ts';

const device: DeviceInfo = {
  hardware_sku: 'kiosk-sku-a',
  os_build: 'ubuntu-core-24',
  firmware: 'fw-1',
  shell: 'electron-44',
  user_agent: 'test',
  refresh_hz_nominal: 60,
  screen: { width: 1920, height: 1080, dpr: 1 },
  audio: { sample_rate: 48000, base_latency_ms: 5, output_latency_ms: 20, output_device: 'hdmi-0' },
};

describe('schedule', () => {
  it('is reproducible from the seed and respects the ISI bounds', () => {
    const a = jitteredSchedule(500, 250, 450, 42, 1000);
    const b = jitteredSchedule(500, 250, 450, 42, 1000);
    expect(a).toEqual(b);
    expect(jitteredSchedule(500, 250, 450, 43, 1000)).not.toEqual(a);
    let prev = 1000;
    for (const t of a) {
      expect(t - prev).toBeGreaterThanOrEqual(250);
      expect(t - prev).toBeLessThanOrEqual(450);
      prev = t;
    }
  });

  it('rejects invalid bounds', () => {
    expect(() => jitteredSchedule(3, 0, 10, 1)).toThrow();
    expect(() => jitteredSchedule(3, 20, 10, 1)).toThrow();
  });

  it('mulberry32 yields values in [0, 1)', () => {
    const r = mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('frame summary', () => {
  it('counts dropped frames like the Python analysis', () => {
    const period = 1000 / 60;
    const raf = [0];
    for (let i = 0; i < 5000; i++) {
      const step = i === 100 || i === 2000 ? 2 * period : i === 3000 ? 4 * period : period;
      raf.push((raf.at(-1) ?? 0) + step);
    }
    const s = summariseFrames(raf, 60);
    expect(s).not.toBeNull();
    expect(s?.droppedFrames).toBe(5);
    expect(s?.refreshHz).toBeCloseTo(60, 6);
    expect(s?.intervalSdMs).toBeCloseTo(0, 6);
  });

  it('needs at least three frames', () => {
    expect(summariseFrames([1, 2], 60)).toBeNull();
  });
});

describe('sync and onset helpers', () => {
  it('picks the lowest round-trip sample', () => {
    const best = bestSyncEstimate([
      { host_send_ms: 0, host_recv_ms: 4, device_ms: 1002 },
      { host_send_ms: 10, host_recv_ms: 11, device_ms: 1010.5 },
      { host_send_ms: 20, host_recv_ms: 19, device_ms: 5 },
    ]);
    expect(best).toEqual({ offsetMs: 1000, uncertaintyMs: 0.5 });
    expect(bestSyncEstimate([])).toBeNull();
  });

  it('parses rig replies', () => {
    expect(parseSyncReply('12 345678\r')).toEqual({ seq: 12, deviceMs: 345.678 });
    expect(parseSyncReply('garbage')).toBeNull();
  });

  it('finds the first sample above threshold', () => {
    const buf = new Float32Array(100);
    buf[40] = -0.5;
    buf[60] = 0.9;
    expect(findOnset(buf, 0.3)).toBe(40);
    expect(findOnset(buf, 0.3, 41)).toBe(60);
    expect(findOnset(buf, 0.95)).toBe(-1);
  });

  it('normalises and clamps pointer positions', () => {
    const box = { left: 100, top: 50, width: 200, height: 100 };
    expect(normalisePoint(200, 100, box)).toEqual({ x: 0.5, y: 0.5 });
    expect(normalisePoint(0, 500, box)).toEqual({ x: 0, y: 1 });
  });
});

describe('capture document', () => {
  it('has every top-level and device field the capture.v1 schema requires', () => {
    const c = newCapture(device, new Date('2026-10-22T00:00:00Z'));
    expect(c.format).toBe(CAPTURE_FORMAT);
    expect(schema.properties.format.const).toBe(CAPTURE_FORMAT);
    for (const key of schema.required) expect(c).toHaveProperty(key);
    for (const key of schema.properties.device.required) expect(c.device).toHaveProperty(key);
  });

  it('rejects SKUs that cannot form a timing_profile_version', () => {
    expect(() => newCapture({ ...device, hardware_sku: 'Kiosk SKU' })).toThrow();
  });

  it('rounds times when serialising and keeps integers', () => {
    const c: Capture = newCapture(device, new Date('2026-10-22T00:00:00Z'));
    c.visual = {
      patch: { x: 0, y: 0, size: 120 },
      flash_frames: 3,
      trials: [{ i: 0, requested_ms: 1000.123456789, presented_ms: 1016.98765432 }],
    };
    c.audio = {
      input_latency_ms: null,
      clicks: [
        { i: 0, scheduled_ctx_s: 1.123456789123, scheduled_perf_ms: 5.5, detected_ctx_s: null },
      ],
    };
    const back = JSON.parse(serialiseCapture(c)) as Capture;
    expect(back.visual?.trials[0]?.requested_ms).toBe(1000.1235);
    expect(back.audio?.clicks[0]?.scheduled_ctx_s).toBe(1.1234568);
    expect(back.visual?.flash_frames).toBe(3);
    expect(captureFileName(c)).toBe('timing-capture_kiosk-sku-a_2026-10-22T00-00-00-000Z.json');
  });
});
