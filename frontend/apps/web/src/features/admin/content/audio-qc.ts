/**
 * In-browser audio checks for recorded voice-line takes (VOX-02 acceptance on re-measure):
 * integrated loudness per ITU-R BS.1770-4 / EBU R128 (K-weighting, 400 ms blocks with 75 % overlap,
 * absolute −70 LUFS and relative −10 LU gates), true peak by 4× oversampling, clipping runs and
 * duration against the recording-sheet target. Every threshold comes from
 * tools/audio-pipeline/config/qc.yaml (passed in as {@link QcThresholds}).
 *
 * The audio pipeline (ffmpeg loudnorm) remains the authority; this gives the reviewer an immediate
 * answer before a take is handed over.
 */
import type { QcThresholds } from './content-types';

export interface DecodedAudio {
  readonly sampleRate: number;
  /** One Float32Array per channel, samples in [-1, 1]. */
  readonly channels: readonly Float32Array[];
  /** Sample rate of the file itself, when known (WAV header); decoders may resample. */
  readonly sourceSampleRate: number | null;
  readonly sourceChannels: number;
}

// ---------------------------------------------------------------- WAV parsing

/** Parse a RIFF/WAVE file (PCM 8/16/24/32-bit, IEEE float 32/64, WAVE_FORMAT_EXTENSIBLE). */
export function parseWav(buffer: ArrayBuffer): DecodedAudio {
  const view = new DataView(buffer);
  const tag = (o: number) =>
    String.fromCharCode(
      view.getUint8(o),
      view.getUint8(o + 1),
      view.getUint8(o + 2),
      view.getUint8(o + 3),
    );
  if (buffer.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE')
    throw new Error('not a RIFF/WAVE file');
  let offset = 12;
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let data: { start: number; length: number } | null = null;
  while (offset + 8 <= buffer.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      if (format === 0xfffe && size >= 40) format = view.getUint16(body + 24, true);
    } else if (id === 'data') {
      data = { start: body, length: Math.min(size, buffer.byteLength - body) };
    }
    offset = body + size + (size % 2);
  }
  if (!data || channels === 0 || sampleRate === 0)
    throw new Error('WAV file has no fmt or data chunk');
  if (format !== 1 && format !== 3) throw new Error(`unsupported WAV encoding (format ${format})`);
  const bytes = bits / 8;
  const frames = Math.floor(data.length / (bytes * channels));
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let f = 0; f < frames; f += 1) {
    for (let c = 0; c < channels; c += 1) {
      const p = data.start + (f * channels + c) * bytes;
      let v: number;
      if (format === 3) v = bits === 64 ? view.getFloat64(p, true) : view.getFloat32(p, true);
      else if (bits === 8) v = (view.getUint8(p) - 128) / 128;
      else if (bits === 16) v = view.getInt16(p, true) / 32768;
      else if (bits === 24) {
        const raw = view.getUint8(p) | (view.getUint8(p + 1) << 8) | (view.getInt8(p + 2) << 16);
        v = raw / 8388608;
      } else if (bits === 32) v = view.getInt32(p, true) / 2147483648;
      else throw new Error(`unsupported PCM bit depth ${bits}`);
      (out[c] as Float32Array)[f] = v;
    }
  }
  return { sampleRate, channels: out, sourceSampleRate: sampleRate, sourceChannels: channels };
}

// ---------------------------------------------------------------- loudness

interface Biquad {
  readonly b0: number;
  readonly b1: number;
  readonly b2: number;
  readonly a1: number;
  readonly a2: number;
}

/**
 * K-weighting coefficients for any sample rate (pre-filter shelf + RLB high-pass). The analogue
 * prototype parameters reproduce the BS.1770 48 kHz coefficients exactly.
 */
export function kWeighting(fs: number): readonly [Biquad, Biquad] {
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / fs);
  const Vh = 10 ** (G / 20);
  const Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q + K * K;
  const shelf: Biquad = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / fs);
  a0 = 1 + K / Q + K * K;
  const highpass: Biquad = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  return [shelf, highpass];
}

function filter(input: ArrayLike<number>, f: Biquad): Float64Array {
  const out = new Float64Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < input.length; i += 1) {
    const x = input[i] as number;
    const y = f.b0 * x + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    out[i] = y;
  }
  return out;
}

const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_LU = -10;

/** Integrated loudness in LUFS (−Infinity when no block passes the gates or the clip is < 400 ms). */
export function integratedLoudness(audio: Pick<DecodedAudio, 'sampleRate' | 'channels'>): number {
  const fs = audio.sampleRate;
  const block = Math.round(0.4 * fs);
  const step = Math.round(0.1 * fs);
  const len = audio.channels[0]?.length ?? 0;
  if (len < block) return Number.NEGATIVE_INFINITY;
  const [shelf, hp] = kWeighting(fs);
  // Channel weights: 1.0 for L, R, C (surround channels are not used for mono/stereo voice takes).
  const weighted = audio.channels.map((ch) => {
    const y = filter(filter(ch, shelf), hp);
    // Prefix sums of squares for O(1) block energies.
    const prefix = new Float64Array(y.length + 1);
    for (let i = 0; i < y.length; i += 1)
      prefix[i + 1] = (prefix[i] as number) + (y[i] as number) ** 2;
    return prefix;
  });
  const energies: number[] = [];
  for (let start = 0; start + block <= len; start += step) {
    let z = 0;
    for (const prefix of weighted)
      z += ((prefix[start + block] as number) - (prefix[start] as number)) / block;
    energies.push(z);
  }
  const lufs = (z: number) => -0.691 + 10 * Math.log10(z);
  const absGated = energies.filter((z) => z > 0 && lufs(z) > ABSOLUTE_GATE_LUFS);
  if (absGated.length === 0) return Number.NEGATIVE_INFINITY;
  const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const relativeGate = lufs(mean(absGated)) + RELATIVE_GATE_LU;
  const gated = absGated.filter((z) => lufs(z) > relativeGate);
  return gated.length === 0 ? Number.NEGATIVE_INFINITY : lufs(mean(gated));
}

// ---------------------------------------------------------------- peaks and clipping

const OVERSAMPLE = 4;
const TAPS_PER_PHASE = 16;

/** Polyphase interpolation filter (Hann-windowed sinc, cut-off at the original Nyquist). */
function interpolationPhases(): Float64Array[] {
  const n = OVERSAMPLE * TAPS_PER_PHASE;
  const centre = (n - 1) / 2;
  const h = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = (i - centre) / OVERSAMPLE;
    const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / n);
    h[i] = sinc * w;
  }
  return Array.from({ length: OVERSAMPLE }, (_, p) => {
    const phase = new Float64Array(TAPS_PER_PHASE);
    let sum = 0;
    for (let k = 0; k < TAPS_PER_PHASE; k += 1) {
      phase[k] = h[k * OVERSAMPLE + p] as number;
      sum += phase[k] as number;
    }
    for (let k = 0; k < TAPS_PER_PHASE; k += 1) phase[k] = (phase[k] as number) / sum;
    return phase;
  });
}

const PHASES = interpolationPhases();

/** Maximum absolute sample value over all channels (linear). */
export function samplePeak(channels: readonly Float32Array[]): number {
  let peak = 0;
  for (const ch of channels)
    for (let i = 0; i < ch.length; i += 1) peak = Math.max(peak, Math.abs(ch[i] as number));
  return peak;
}

/** True peak (linear) by 4× polyphase oversampling, never below the sample peak. */
export function truePeak(channels: readonly Float32Array[]): number {
  let peak = samplePeak(channels);
  for (const ch of channels) {
    for (let i = 0; i + TAPS_PER_PHASE <= ch.length; i += 1) {
      for (const phase of PHASES) {
        let acc = 0;
        for (let k = 0; k < TAPS_PER_PHASE; k += 1)
          acc += (phase[k] as number) * (ch[i + k] as number);
        const a = Math.abs(acc);
        if (a > peak) peak = a;
      }
    }
  }
  return peak;
}

/** Number of runs of at least `minRun` consecutive samples at or above `threshold` full scale. */
export function clippingEvents(
  channels: readonly Float32Array[],
  threshold: number,
  minRun: number,
): number {
  let events = 0;
  for (const ch of channels) {
    let run = 0;
    for (let i = 0; i <= ch.length; i += 1) {
      if (i < ch.length && Math.abs(ch[i] as number) >= threshold) run += 1;
      else {
        if (run >= minRun) events += 1;
        run = 0;
      }
    }
  }
  return events;
}

export const toDb = (linear: number): number =>
  linear > 0 ? 20 * Math.log10(linear) : Number.NEGATIVE_INFINITY;

// ---------------------------------------------------------------- evaluation

export interface TakeMeasurement {
  readonly durationMs: number;
  readonly sampleRate: number;
  readonly sourceSampleRate: number | null;
  readonly channels: number;
  readonly integratedLufs: number;
  readonly truePeakDbtp: number;
  readonly samplePeakDbfs: number;
  readonly clippingEvents: number;
}

export function measureTake(audio: DecodedAudio, qc: QcThresholds): TakeMeasurement {
  const len = audio.channels[0]?.length ?? 0;
  return {
    durationMs: (len / audio.sampleRate) * 1000,
    sampleRate: audio.sampleRate,
    sourceSampleRate: audio.sourceSampleRate,
    channels: audio.sourceChannels,
    integratedLufs: integratedLoudness(audio),
    truePeakDbtp: toDb(truePeak(audio.channels)),
    samplePeakDbfs: toDb(samplePeak(audio.channels)),
    clippingEvents: clippingEvents(audio.channels, qc.clipSampleThreshold, qc.clipMinRunSamples),
  };
}

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'info';

export interface QcCheck {
  readonly id: string;
  readonly label: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

const fmt = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '−∞');

/**
 * Judge a measured take against the QC thresholds and its recording-sheet target.
 * @param targetDurationMs the line's target duration (lines.yaml)
 * @param sourceDurationMs duration of the source-language clip; falls back to the source target
 */
export function evaluateTake(
  m: TakeMeasurement,
  qc: QcThresholds,
  {
    targetDurationMs,
    sourceDurationMs,
  }: { targetDurationMs: number; sourceDurationMs?: number | null },
): QcCheck[] {
  const checks: QcCheck[] = [];
  if (m.sourceSampleRate === null) {
    checks.push({
      id: 'sample_rate',
      label: 'Sample rate',
      status: 'info',
      detail: `Decoded at ${m.sampleRate} Hz; the file's own rate is checked for WAV only (minimum ${qc.minSampleRateHz} Hz).`,
    });
  } else {
    checks.push({
      id: 'sample_rate',
      label: 'Sample rate',
      status: m.sourceSampleRate >= qc.minSampleRateHz ? 'pass' : 'fail',
      detail: `${m.sourceSampleRate} Hz (minimum ${qc.minSampleRateHz} Hz)`,
    });
  }
  checks.push({
    id: 'channels',
    label: 'Channels',
    status: m.channels <= qc.maxChannels ? 'pass' : 'fail',
    detail: `${m.channels} (maximum ${qc.maxChannels})`,
  });
  const inRange = m.durationMs >= qc.minDurationMs && m.durationMs <= qc.maxDurationMs;
  checks.push({
    id: 'duration_range',
    label: 'Length',
    status: inRange ? 'pass' : 'fail',
    detail: `${fmt(m.durationMs / 1000, 2)} s (allowed ${qc.minDurationMs / 1000}–${qc.maxDurationMs / 1000} s)`,
  });
  const loudOk =
    Number.isFinite(m.integratedLufs) &&
    Math.abs(m.integratedLufs - qc.targetLufs) <= qc.toleranceLu;
  checks.push({
    id: 'loudness',
    label: 'Integrated loudness',
    status: loudOk ? 'pass' : 'fail',
    detail: `${fmt(m.integratedLufs)} LUFS (delivered clips: ${qc.targetLufs} ± ${qc.toleranceLu} LU; raw takes are normalised by the audio pipeline)`,
  });
  checks.push({
    id: 'true_peak',
    label: 'True peak',
    status: m.truePeakDbtp <= qc.truePeakCeilingDbtp ? 'pass' : 'fail',
    detail: `${fmt(m.truePeakDbtp)} dBTP (ceiling ${qc.truePeakCeilingDbtp} dBTP; sample peak ${fmt(m.samplePeakDbfs)} dBFS)`,
  });
  checks.push({
    id: 'clipping',
    label: 'Clipping',
    status:
      m.clippingEvents > qc.clipMaxEventsReject ? 'fail' : m.clippingEvents > 0 ? 'warn' : 'pass',
    detail: `${m.clippingEvents} clipped run${m.clippingEvents === 1 ? '' : 's'} of ≥ ${qc.clipMinRunSamples} samples`,
  });
  if (targetDurationMs > 0) {
    const dev = (m.durationMs - targetDurationMs) / targetDurationMs;
    checks.push({
      id: 'duration_target',
      label: 'Length vs recording sheet',
      status: Math.abs(dev) <= qc.durationTargetTolerance ? 'pass' : 'warn',
      detail: `${dev >= 0 ? '+' : ''}${fmt(dev * 100, 0)} % vs target ${fmt(targetDurationMs / 1000, 2)} s (± ${fmt(qc.durationTargetTolerance * 100, 0)} %)`,
    });
  }
  const source = sourceDurationMs ?? targetDurationMs;
  if (source > 0) {
    const ratio = m.durationMs / source;
    const long = ratio > qc.maxRatioToSource;
    checks.push({
      id: 'ratio_to_source',
      label: 'Length vs source language',
      status: long ? (qc.longClipIsError ? 'fail' : 'warn') : 'pass',
      detail: `${fmt(ratio, 2)}× the ${sourceDurationMs ? 'source clip' : 'source target'} (flag above ${qc.maxRatioToSource}×)`,
    });
  }
  return checks;
}

export function overallStatus(checks: readonly QcCheck[]): CheckStatus {
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  if (checks.some((c) => c.status === 'warn')) return 'warn';
  return 'pass';
}
