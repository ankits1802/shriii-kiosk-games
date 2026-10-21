/**
 * Frame sources that are not a live microphone: replaying a clip (tests, the bake-off harness, the
 * supervised asr_eval rig). Each frame is a fresh buffer, as the {@link AudioFrameSource} contract asks.
 */
import { ASR_SAMPLE_RATE, type AudioFrameSource, type CaptureHandle } from './types.ts';

export interface ArrayFrameSourceOptions {
  /** Samples per frame (default 512 = 32 ms at 16 kHz). */
  readonly frameSamples?: number;
  /** Pace frames in real time (default false: as fast as the event loop allows). */
  readonly realtime?: boolean;
  /** Called with every frame emitted (tests keep references to check they were zeroed). */
  readonly onEmit?: (frame: Float32Array) => void;
}

/** Replays a mono 16 kHz clip as frames, then keeps emitting silence until closed. */
export class ArrayFrameSource implements AudioFrameSource {
  private readonly samples: Float32Array;
  private readonly frameSamples: number;
  private readonly realtime: boolean;
  private readonly onEmit: ((frame: Float32Array) => void) | undefined;
  openCount = 0;
  closeCount = 0;

  constructor(samples: Float32Array, options: ArrayFrameSourceOptions = {}) {
    this.samples = samples;
    this.frameSamples = options.frameSamples ?? 512;
    this.realtime = options.realtime ?? false;
    this.onEmit = options.onEmit;
  }

  get isOpen(): boolean {
    return this.openCount > this.closeCount;
  }

  async open(
    onFrame: (frame: Float32Array) => void,
    onError: (error: unknown) => void,
  ): Promise<CaptureHandle> {
    this.openCount++;
    let closed = false;
    let pos = 0;
    const frameMs = (1000 * this.frameSamples) / ASR_SAMPLE_RATE;
    const tick = (): void => {
      if (closed) return;
      const frame = new Float32Array(this.frameSamples);
      if (pos < this.samples.length) {
        frame.set(
          this.samples.subarray(pos, Math.min(this.samples.length, pos + this.frameSamples)),
        );
      }
      pos += this.frameSamples;
      this.onEmit?.(frame);
      try {
        onFrame(frame);
      } catch (error) {
        onError(error);
        return;
      }
      if (this.realtime) setTimeout(tick, frameMs);
      else setTimeout(tick, 0);
    };
    setTimeout(tick, 0);
    return {
      close: async () => {
        if (closed) return;
        closed = true;
        this.closeCount++;
      },
    };
  }
}
