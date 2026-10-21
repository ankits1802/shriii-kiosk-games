import { describe, expect, it, vi } from 'vitest';
import type { SherpaModule } from '../src/sherpa/binding.ts';
import { SherpaKeywordEngine } from '../src/sherpa/index.ts';
import { WebAudioMicSource } from '../src/web/index.ts';
import { grammar } from './helpers.ts';

/** Fake addon: a spotter "hears" whatever keyword the test queues, if its threshold allows it. */
function fakeSherpa(heard: { keyword: string; score: number }[]) {
  const created: { threshold: number; keywords: string; size: number }[] = [];
  class Stream {
    accepted = 0;
    finished = false;
    acceptWaveform(w: { samples: Float32Array }) {
      this.accepted += w.samples.length;
    }
    inputFinished() {
      this.finished = true;
    }
  }
  class KeywordSpotter {
    readonly threshold: number;
    private readonly queue = new Map<Stream, { keyword: string; score: number }[]>();
    private readonly pending = new Map<Stream, string>();
    constructor(config: {
      keywordsThreshold: number;
      keywordsBuf: string;
      keywordsBufSize: number;
    }) {
      this.threshold = config.keywordsThreshold;
      created.push({
        threshold: config.keywordsThreshold,
        keywords: config.keywordsBuf,
        size: config.keywordsBufSize,
      });
    }
    createStream() {
      const s = new Stream();
      this.queue.set(s, [...heard]);
      return s;
    }
    isReady(s: Stream) {
      return s.accepted > 0 && (this.queue.get(s)?.length ?? 0) > 0;
    }
    decode(s: Stream) {
      const next = this.queue.get(s)?.shift();
      if (next && next.score >= this.threshold) this.pending.set(s, next.keyword);
    }
    getResult(s: Stream) {
      const keyword = this.pending.get(s) ?? '';
      this.pending.delete(s);
      return { keyword, start_time: 0, timestamps: keyword ? [1.2] : [], tokens: [] };
    }
    reset(_s: Stream) {}
  }
  const mod = { version: 'fake-1', KeywordSpotter, Vad: class {} } as unknown as SherpaModule;
  return { mod, created };
}

const MODEL = { encoder: 'e.onnx', decoder: 'd.onnx', joiner: 'j.onnx', tokens: 'tokens.txt' };

describe('SherpaKeywordEngine', () => {
  it('builds one spotter per confidence tier with the full keyword list', async () => {
    const { mod, created } = fakeSherpa([]);
    const engine = new SherpaKeywordEngine({ model: MODEL, loader: async () => mod });
    expect(engine.ready).toBe(false);
    await engine.prepare(grammar());
    expect(engine.ready).toBe(true);
    expect(engine.version).toBe('fake-1');
    expect(created.map((c) => c.threshold)).toEqual([0.15, 0.35]);
    expect(created[0]?.keywords).toContain('▁HAA N @yes');
    expect(created[0]?.keywords).toContain('▁BAA NT O @share');
    expect(created[0]?.size).toBe(new TextEncoder().encode(created[0]?.keywords ?? '').length);
  });

  it('maps hits to tiers and filters codes outside the session vocabulary', async () => {
    const { mod } = fakeSherpa([
      { keyword: 'share', score: 0.9 },
      { keyword: 'yes', score: 0.2 },
    ]);
    const engine = new SherpaKeywordEngine({ model: MODEL, loader: async () => mod });
    await engine.prepare(grammar());
    const session = engine.createSession(['yes', 'no']);
    session.accept(new Float32Array(1600));
    const dets = [...session.poll(), ...(await session.finish())];
    expect(dets).toEqual([{ code: 'yes', tier: 0, timeSec: 1.2 }]); // 0.2 passes tier 0 (0.15) only
    session.dispose();
    expect(session.poll()).toEqual([]);
    session.accept(new Float32Array(10)); // ignored after dispose
  });

  it('refuses sessions before prepare and reports a missing addon clearly', async () => {
    const engine = new SherpaKeywordEngine({
      model: MODEL,
      loader: async () => {
        throw new Error('sherpa-onnx-node is not available');
      },
    });
    expect(() => engine.createSession(['yes'])).toThrow(/prepare/);
    await expect(engine.prepare(grammar())).rejects.toThrow(/not available/);
  });
});

describe('WebAudioMicSource', () => {
  function fakes() {
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    const port: {
      onmessage: ((e: MessageEvent<Float32Array>) => void) | null;
      postMessage: ReturnType<typeof vi.fn>;
    } = {
      onmessage: null,
      postMessage: vi.fn(),
    };
    const node = {
      port,
      disconnect: vi.fn(),
      onprocessorerror: null,
    } as unknown as AudioWorkletNode;
    const src = { connect: vi.fn(), disconnect: vi.fn() };
    const ctx = {
      audioWorklet: { addModule: vi.fn(async () => undefined) },
      createMediaStreamSource: vi.fn(() => src),
      close: vi.fn(async () => undefined),
    } as unknown as AudioContext;
    const revoke = vi.fn();
    const constraints: MediaStreamConstraints[] = [];
    const contextOptions: AudioContextOptions[] = [];
    const source = new WebAudioMicSource({
      getUserMedia: async (c) => {
        constraints.push(c);
        return stream;
      },
      createContext: (o) => {
        contextOptions.push(o);
        return ctx;
      },
      createWorkletNode: () => node,
      workletUrl: () => ({ url: 'blob:fake', revoke }),
    });
    return { source, track, port, node, src, ctx, revoke, constraints, contextOptions };
  }

  it('forwards frames, then stops the track and tears the graph down on close', async () => {
    const f = fakes();
    const frames: Float32Array[] = [];
    const handle = await f.source.open(
      (fr) => frames.push(fr),
      () => undefined,
    );
    expect(f.contextOptions[0]?.sampleRate).toBe(16000);
    const audio = f.constraints[0]?.audio as MediaTrackConstraints;
    expect(audio.echoCancellation).toBe(true);
    expect(audio.noiseSuppression).toBe(true);
    expect(audio.autoGainControl).toBe(false);
    f.port.onmessage?.({ data: Float32Array.from([0.1, 0.2]) } as MessageEvent<Float32Array>);
    expect(frames).toHaveLength(1);
    await handle.close();
    expect(f.track.stop).toHaveBeenCalledTimes(1);
    expect(f.port.postMessage).toHaveBeenCalledWith('stop');
    expect(f.port.onmessage).toBeNull();
    expect(f.ctx.close).toHaveBeenCalled();
    expect(f.revoke).toHaveBeenCalled();
    await handle.close(); // idempotent
    expect(f.track.stop).toHaveBeenCalledTimes(1);
  });

  it('stops the track if the audio graph cannot be built', async () => {
    const f = fakes();
    (f.ctx.audioWorklet.addModule as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('no worklet'),
    );
    await expect(
      f.source.open(
        () => undefined,
        () => undefined,
      ),
    ).rejects.toThrow('no worklet');
    expect(f.track.stop).toHaveBeenCalled();
    expect(f.revoke).toHaveBeenCalled();
  });
});
