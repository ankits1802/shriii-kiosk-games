/**
 * Live microphone for browsers / Electron renderers: getUserMedia -> AudioContext at 16 kHz ->
 * AudioWorklet that blocks samples into frames and transfers them to the main thread.
 *
 * The capture exists only between `open()` and `close()`; `close()` stops every track (the OS mic
 * indicator goes off), disconnects the graph and closes the context. Echo cancellation and noise
 * suppression are requested from the platform (VOX-05 front end); automatic gain stays off so the
 * noise-floor measurement is meaningful.
 */
import { ASR_SAMPLE_RATE, type AudioFrameSource, type CaptureHandle } from '../types.ts';

const PROCESSOR_NAME = 'shriii-asr-framer';

/** Worklet source: accumulates 128-sample render quanta into frames and transfers each frame. */
export const FRAMER_WORKLET_SOURCE = `
class ShriiiAsrFramer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.size = (options && options.processorOptions && options.processorOptions.frameSamples) || 512;
    this.buf = new Float32Array(this.size);
    this.n = 0;
    this.port.onmessage = (e) => { if (e.data === 'stop') { this.stopped = true; this.buf.fill(0); } };
  }
  process(inputs) {
    if (this.stopped) return false;
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    let i = 0;
    while (i < ch.length) {
      const k = Math.min(ch.length - i, this.size - this.n);
      this.buf.set(ch.subarray(i, i + k), this.n);
      this.n += k; i += k;
      if (this.n === this.size) {
        this.port.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Float32Array(this.size);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('${PROCESSOR_NAME}', ShriiiAsrFramer);
`;

export interface WebAudioMicSourceOptions {
  readonly frameSamples?: number;
  /** Injectable for tests and Electron variants. */
  readonly getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  readonly createContext?: (options: AudioContextOptions) => AudioContext;
  readonly createWorkletNode?: (
    ctx: AudioContext,
    name: string,
    options: AudioWorkletNodeOptions,
  ) => AudioWorkletNode;
  readonly workletUrl?: () => { url: string; revoke: () => void };
}

function defaultWorkletUrl(): { url: string; revoke: () => void } {
  const url = URL.createObjectURL(new Blob([FRAMER_WORKLET_SOURCE], { type: 'text/javascript' }));
  return { url, revoke: () => URL.revokeObjectURL(url) };
}

export class WebAudioMicSource implements AudioFrameSource {
  private readonly options: WebAudioMicSourceOptions;

  constructor(options: WebAudioMicSourceOptions = {}) {
    this.options = options;
  }

  async open(
    onFrame: (frame: Float32Array) => void,
    onError: (error: unknown) => void,
  ): Promise<CaptureHandle> {
    const gum =
      this.options.getUserMedia ??
      ((c: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(c));
    const stream = await gum({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
      },
      video: false,
    });
    const stopTracks = (): void => {
      for (const t of stream.getTracks()) t.stop();
    };
    let ctx: AudioContext | null = null;
    let worklet: { url: string; revoke: () => void } | null = null;
    try {
      ctx = (this.options.createContext ?? ((o) => new AudioContext(o)))({
        sampleRate: ASR_SAMPLE_RATE,
      });
      worklet = (this.options.workletUrl ?? defaultWorkletUrl)();
      await ctx.audioWorklet.addModule(worklet.url);
      const src = ctx.createMediaStreamSource(stream);
      const nodeOptions: AudioWorkletNodeOptions = {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
        processorOptions: { frameSamples: this.options.frameSamples ?? 512 },
      };
      const node = (this.options.createWorkletNode ?? ((c, n, o) => new AudioWorkletNode(c, n, o)))(
        ctx,
        PROCESSOR_NAME,
        nodeOptions,
      );
      let closed = false;
      node.port.onmessage = (e: MessageEvent<Float32Array>) => {
        if (closed) {
          e.data.fill(0);
          return;
        }
        try {
          onFrame(e.data);
        } catch (error) {
          onError(error);
        }
      };
      node.onprocessorerror = (e) => onError(e);
      src.connect(node);
      const context = ctx;
      const revoke = worklet.revoke;
      return {
        close: async () => {
          if (closed) return;
          closed = true;
          node.port.postMessage('stop');
          node.port.onmessage = null;
          src.disconnect();
          node.disconnect();
          stopTracks();
          revoke();
          await context.close();
        },
      };
    } catch (error) {
      stopTracks();
      worklet?.revoke();
      await ctx?.close().catch(() => undefined);
      throw error;
    }
  }
}
