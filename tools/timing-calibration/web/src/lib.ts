/** Pure helpers shared by the protocols (unit-tested without a DOM). */

/** mulberry32: small seeded PRNG so a run's ISI schedule is reproducible from its seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Onset times (ms after start) with uniformly jittered inter-stimulus intervals. Jitter keeps the
 * sensor stream from aliasing with the refresh cycle and lets unanchored runs be aligned by pattern.
 */
export function jitteredSchedule(
  n: number,
  minIsiMs: number,
  maxIsiMs: number,
  seed: number,
  startMs = 0,
): number[] {
  if (!(minIsiMs > 0 && maxIsiMs >= minIsiMs)) throw new Error('need 0 < minIsi <= maxIsi');
  const rnd = mulberry32(seed);
  const out: number[] = [];
  let t = startMs;
  for (let i = 0; i < n; i++) {
    t += minIsiMs + (maxIsiMs - minIsiMs) * rnd();
    out.push(t);
  }
  return out;
}

export interface FrameSummary {
  n: number;
  refreshHz: number;
  intervalSdMs: number;
  droppedFrames: number;
  droppedRate: number;
  p99Ms: number;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] ?? Number.NaN;
  const b = sorted[hi] ?? Number.NaN;
  return a + (b - a) * (pos - lo);
}

/** Live preview of the frame statistics; mirrors shriii_timing.analysis.frame_stats. */
export function summariseFrames(
  rafMs: readonly number[],
  nominalHz: number | null,
  dropThresholdPeriods = 1.5,
): FrameSummary | null {
  if (rafMs.length < 3) return null;
  const iv: number[] = [];
  for (let i = 1; i < rafMs.length; i++) {
    const d = (rafMs[i] ?? 0) - (rafMs[i - 1] ?? 0);
    if (d > 0) iv.push(d);
  }
  const sorted = [...iv].sort((a, b) => a - b);
  const median = quantile(sorted, 0.5);
  const period = nominalHz ? 1000 / nominalHz : median;
  const thr = dropThresholdPeriods * period;
  let dropped = 0;
  const normal: number[] = [];
  for (const d of iv) {
    if (d > thr) dropped += Math.max(Math.round(d / period) - 1, 1);
    else normal.push(d);
  }
  const mean = normal.reduce((s, v) => s + v, 0) / Math.max(normal.length, 1);
  const variance =
    normal.length > 1 ? normal.reduce((s, v) => s + (v - mean) ** 2, 0) / (normal.length - 1) : 0;
  return {
    n: rafMs.length,
    refreshHz: 1000 / median,
    intervalSdMs: Math.sqrt(variance),
    droppedFrames: dropped,
    droppedRate: dropped / (iv.length + dropped),
    p99Ms: quantile(sorted, 0.99),
  };
}

/** Best (lowest round-trip) sync sample: offset device - host midpoint and its uncertainty RTT/2. */
export function bestSyncEstimate(
  pairs: readonly { host_send_ms: number; host_recv_ms: number; device_ms: number }[],
): { offsetMs: number; uncertaintyMs: number } | null {
  let best: { offsetMs: number; uncertaintyMs: number } | null = null;
  for (const p of pairs) {
    const rtt = p.host_recv_ms - p.host_send_ms;
    if (!(rtt >= 0)) continue;
    const est = {
      offsetMs: p.device_ms - (p.host_send_ms + p.host_recv_ms) / 2,
      uncertaintyMs: rtt / 2,
    };
    if (best === null || est.uncertaintyMs < best.uncertaintyMs) best = est;
  }
  return best;
}

/**
 * First sample index at or after `fromIndex` whose absolute value reaches `threshold`, or -1.
 * Used on loopback input blocks to find a click onset.
 */
export function findOnset(samples: Float32Array, threshold: number, fromIndex = 0): number {
  for (let i = Math.max(0, fromIndex); i < samples.length; i++) {
    const v = samples[i] ?? 0;
    if (v >= threshold || v <= -threshold) return i;
  }
  return -1;
}

/** Parse one rig reply line `"<seq> <device_us>"` into its sequence number and device time in ms. */
export function parseSyncReply(line: string): { seq: number; deviceMs: number } | null {
  const m = /^\s*(\d+)\s+(\d+(?:\.\d+)?)\s*$/.exec(line);
  if (!m) return null;
  return { seq: Number(m[1]), deviceMs: Number(m[2]) / 1000 };
}

/** Normalised (0..1) pointer position inside an element box. */
export function normalisePoint(
  x: number,
  y: number,
  box: { left: number; top: number; width: number; height: number },
): { x: number; y: number } {
  const nx = box.width > 0 ? (x - box.left) / box.width : 0;
  const ny = box.height > 0 ? (y - box.top) / box.height : 0;
  return { x: Math.min(1, Math.max(0, nx)), y: Math.min(1, Math.max(0, ny)) };
}
