/**
 * Model-free energy VAD with an adaptive noise floor, onset confirmation and hangover. It is the
 * default gate (no extra model to ship); a Silero VAD through sherpa-onnx can be plugged in instead
 * (`@shriii/asr-sherpa/sherpa`). Either way it only ever sees frames from an open prompt window.
 */
import { ASR_SAMPLE_RATE, type VadDecision, type VoiceActivityDetector } from './types.ts';

export interface EnergyVadOptions {
  /** Speech when the frame is this far above the tracked noise floor. */
  readonly marginDb?: number;
  /** Never speech below this absolute level. */
  readonly absoluteMinDbfs?: number;
  /** Consecutive speech time needed before the gate opens. */
  readonly onsetMs?: number;
  /** Time the gate stays open after the last speech frame. */
  readonly hangoverMs?: number;
  /** Initial noise floor guess before any frame is seen. */
  readonly initialFloorDbfs?: number;
  /** Rate (dB per second) at which the floor may rise towards louder frames. */
  readonly floorRiseDbPerSec?: number;
  /** Frames at the start of a window used only to calibrate the floor (gate stays closed). */
  readonly calibrationMs?: number;
  readonly sampleRate?: number;
}

export function rmsDbfs(frame: Float32Array): number {
  if (frame.length === 0) return -120;
  let acc = 0;
  for (const v of frame) acc += v * v;
  const rms = Math.sqrt(acc / frame.length);
  return rms > 0 ? Math.max(-120, 20 * Math.log10(rms)) : -120;
}

export class EnergyVad implements VoiceActivityDetector {
  private readonly marginDb: number;
  private readonly absMin: number;
  private readonly onsetMs: number;
  private readonly hangoverMs: number;
  private readonly initialFloor: number;
  private readonly riseDbPerSec: number;
  private readonly rate: number;
  private readonly calibrationMs: number;
  private floor: number;
  private calibratedMs = 0;
  private calibrationSum = 0;
  private aboveMs = 0;
  private sinceSpeechMs = Number.POSITIVE_INFINITY;
  private open = false;

  constructor(options: EnergyVadOptions = {}) {
    this.marginDb = options.marginDb ?? 12;
    this.absMin = options.absoluteMinDbfs ?? -55;
    this.onsetMs = options.onsetMs ?? 60;
    this.hangoverMs = options.hangoverMs ?? 300;
    this.initialFloor = options.initialFloorDbfs ?? -70;
    this.riseDbPerSec = options.floorRiseDbPerSec ?? 4;
    this.calibrationMs = options.calibrationMs ?? 150;
    this.rate = options.sampleRate ?? ASR_SAMPLE_RATE;
    this.floor = this.initialFloor;
  }

  get noiseFloorDbfs(): number {
    return this.floor;
  }

  accept(frame: Float32Array): VadDecision {
    const level = rmsDbfs(frame);
    const ms = (1000 * frame.length) / this.rate;
    if (this.calibratedMs < this.calibrationMs) {
      // time-weighted mean level (dB) of the calibration frames becomes the initial floor
      this.calibrationSum += level * ms;
      this.calibratedMs += ms;
      this.floor = this.calibrationSum / this.calibratedMs;
      return { speech: false, levelDbfs: level };
    }
    const loud = level > Math.max(this.floor + this.marginDb, this.absMin);
    if (loud) {
      this.aboveMs += ms;
      if (this.aboveMs >= this.onsetMs) {
        this.open = true;
        this.sinceSpeechMs = 0;
      }
    } else {
      this.aboveMs = 0;
      this.sinceSpeechMs += ms;
      if (this.open && this.sinceSpeechMs > this.hangoverMs) this.open = false;
    }
    // floor tracking: drop immediately to quieter frames, rise slowly towards louder ones (so a
    // persistent noise source is eventually treated as background, never as speech)
    if (level < this.floor) this.floor = level;
    else this.floor = Math.min(level, this.floor + (this.riseDbPerSec * ms) / 1000);
    return { speech: this.open, levelDbfs: level };
  }

  reset(): void {
    this.floor = this.initialFloor;
    this.calibratedMs = 0;
    this.calibrationSum = 0;
    this.aboveMs = 0;
    this.sinceSpeechMs = Number.POSITIVE_INFINITY;
    this.open = false;
  }
}
