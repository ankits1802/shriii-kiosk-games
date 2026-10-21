import { MessageChannel } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import {
  ArrayFrameSource,
  type KeywordSession,
  KeywordSpeechInput,
  portTransport,
  RemoteKeywordEngine,
  serveKeywordEngine,
} from '../src/index.ts';
import { SherpaKeywordEngine } from '../src/sherpa/index.ts';
import { concat, Gate, grammar, isZero, noise, ScriptedEngine, tone } from './helpers.ts';

const asPort = (p: unknown) => p as MessagePort;

describe('RemoteKeywordEngine over a MessageChannel', () => {
  it('runs the adapter end to end with the engine on the other side and wipes transferred audio', async () => {
    const channel = new MessageChannel();
    const hostEngine = new ScriptedEngine([{ afterSamples: 4000, code: 'yes', tier: 1 }]);
    const received: Float32Array[] = [];
    const create = hostEngine.createSession.bind(hostEngine);
    hostEngine.createSession = (vocab): KeywordSession => {
      const s = create(vocab);
      return {
        ...s,
        accept: (x: Float32Array) => {
          received.push(x);
          s.accept(x);
        },
      };
    };
    const stop = serveKeywordEngine(hostEngine, portTransport(asPort(channel.port1)));
    const remote = new RemoteKeywordEngine(portTransport(asPort(channel.port2)));
    const g = grammar();
    await remote.prepare(g);
    expect(remote.ready).toBe(true);
    expect(hostEngine.prepared?.language).toBe('hi-IN');
    const audio = concat(noise(0.5, -65, 1), tone(0.6, -18), noise(1.5, -65, 2));
    const input = new KeywordSpeechInput({
      engine: remote,
      source: new ArrayFrameSource(audio),
      grammar: g,
      gate: new Gate(),
    });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const result = await input.listen('stall.offer', ['yes', 'no'], ctrl.signal);
    clearTimeout(timer);
    expect(result).toEqual({ label: 'yes', confidence: 0.95 });
    await new Promise((r) => setTimeout(r, 50));
    expect(received.length).toBeGreaterThan(0);
    expect(received.every(isZero)).toBe(true);
    expect(hostEngine.sessions[0]?.disposed).toBe(true);
    expect(hostEngine.sessions[0]?.vocabulary).toEqual(['yes', 'no']);
    stop();
    remote.dispose();
    channel.port1.close();
    channel.port2.close();
  });

  it('propagates prepare failures', async () => {
    const channel = new MessageChannel();
    const failing = new SherpaKeywordEngine({
      model: { encoder: 'e', decoder: 'd', joiner: 'j', tokens: 't' },
      loader: async () => {
        throw new Error('addon missing');
      },
    });
    const stop = serveKeywordEngine(failing, portTransport(asPort(channel.port1)));
    const remote = new RemoteKeywordEngine(portTransport(asPort(channel.port2)));
    await expect(remote.prepare(grammar())).rejects.toThrow('addon missing');
    expect(remote.ready).toBe(false);
    expect(() => remote.createSession(['yes'])).toThrow(/prepare/);
    stop();
    channel.port1.close();
    channel.port2.close();
  });

  it('drops malformed requests and survives a session that cannot be created', async () => {
    let handler: (m: unknown) => void = () => undefined;
    const replies: unknown[] = [];
    const transport = {
      postMessage: (m: unknown) => replies.push(m),
      onMessage: (h: (m: unknown) => void) => {
        handler = h;
        return () => undefined;
      },
    };
    const engine = new ScriptedEngine([]);
    await engine.prepare(grammar());
    const stop = serveKeywordEngine(engine, transport);
    expect(() => {
      handler({ t: 'accept', sid: 1, samples: [0.5, 0.5] });
      handler({ t: 'open', sid: 'x', vocabulary: ['yes'] });
      handler({ t: 'open', sid: 1, vocabulary: [1, 2] });
      handler({ t: 'bogus' });
      handler(null);
    }).not.toThrow();
    expect(engine.sessions).toHaveLength(0);
    engine.createSession = () => {
      throw new Error('native failure');
    };
    expect(() => handler({ t: 'open', sid: 2, vocabulary: ['yes'] })).not.toThrow();
    const frame = new Float32Array([0.1, 0.2]);
    handler({ t: 'accept', sid: 2, samples: frame });
    expect(isZero(frame)).toBe(true);
    handler({ t: 'finish', id: 9, sid: 2 });
    await new Promise((r) => setTimeout(r, 0));
    expect(replies).toContainEqual({ t: 'finished', id: 9, sid: 2, list: [] });
    stop();
  });
});
