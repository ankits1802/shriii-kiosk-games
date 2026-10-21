/**
 * Run the keyword engine in another context (Electron main process, utility process or a worker)
 * while the adapter, VAD and microphone live in the renderer. Frames cross the boundary only as
 * transferred RAM buffers; the host zero-fills every buffer right after feeding it to the engine.
 *
 * Transport: anything with `postMessage(data, transfer?)` and a message callback — a DOM/Node
 * `MessagePort`, Electron's `MessagePortMain` (wrap its `on('message')`), or a Worker.
 */
import type { AsrGrammar, KeywordDetection, KeywordEngine, KeywordSession } from './types.ts';

export interface MessageTransport {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  /** Register the single message handler; returns an unsubscribe function. */
  onMessage(handler: (message: unknown) => void): () => void;
}

/** Adapt a DOM/Node MessagePort (or Worker) to {@link MessageTransport}. */
export function portTransport(port: {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  start?: () => void;
}): MessageTransport {
  return {
    postMessage: (m, t) => port.postMessage(m, t ?? []),
    onMessage: (handler) => {
      const listener = (e: MessageEvent) => handler(e.data);
      port.addEventListener('message', listener);
      port.start?.();
      return () => port.removeEventListener('message', listener);
    },
  };
}

type EngineRequest =
  | { readonly t: 'prepare'; readonly id: number; readonly grammar: AsrGrammar }
  | { readonly t: 'open'; readonly sid: number; readonly vocabulary: readonly string[] }
  | { readonly t: 'accept'; readonly sid: number; readonly samples: Float32Array }
  | { readonly t: 'finish'; readonly id: number; readonly sid: number }
  | { readonly t: 'dispose'; readonly sid: number };

type EngineReply =
  | { readonly t: 'prepared'; readonly id: number; readonly error?: string }
  | { readonly t: 'detections'; readonly sid: number; readonly list: readonly KeywordDetection[] }
  | {
      readonly t: 'finished';
      readonly id: number;
      readonly sid: number;
      readonly list: readonly KeywordDetection[];
    };

function isRequest(m: unknown): m is EngineRequest {
  return typeof m === 'object' && m !== null && typeof (m as { t?: unknown }).t === 'string';
}

/**
 * Serve `engine` over `transport` (call in the process that can load the native addon).
 * Returns a stop function that disposes open sessions.
 */
export function serveKeywordEngine(engine: KeywordEngine, transport: MessageTransport): () => void {
  const sessions = new Map<number, KeywordSession>();
  const reply = (r: EngineReply): void => transport.postMessage(r);
  const off = transport.onMessage((m) => {
    if (!isRequest(m)) return;
    switch (m.t) {
      case 'prepare':
        engine.prepare(m.grammar).then(
          () => reply({ t: 'prepared', id: m.id }),
          (e: unknown) =>
            reply({ t: 'prepared', id: m.id, error: e instanceof Error ? e.message : String(e) }),
        );
        break;
      case 'open':
        sessions.get(m.sid)?.dispose();
        sessions.set(m.sid, engine.createSession(m.vocabulary));
        break;
      case 'accept': {
        const s = sessions.get(m.sid);
        try {
          if (s) {
            s.accept(m.samples);
            const list = s.poll();
            if (list.length > 0) reply({ t: 'detections', sid: m.sid, list });
          }
        } finally {
          m.samples.fill(0);
        }
        break;
      }
      case 'finish': {
        const s = sessions.get(m.sid);
        Promise.resolve(s ? s.finish() : []).then(
          (list) => reply({ t: 'finished', id: m.id, sid: m.sid, list }),
          () => reply({ t: 'finished', id: m.id, sid: m.sid, list: [] }),
        );
        break;
      }
      case 'dispose':
        sessions.get(m.sid)?.dispose();
        sessions.delete(m.sid);
        break;
    }
  });
  return () => {
    off();
    for (const s of sessions.values()) s.dispose();
    sessions.clear();
  };
}

/** Client side of {@link serveKeywordEngine}: a {@link KeywordEngine} usable by the adapter. */
export class RemoteKeywordEngine implements KeywordEngine {
  readonly name: string;
  private readonly transport: MessageTransport;
  private readonly off: () => void;
  private nextId = 1;
  private nextSid = 1;
  private isReady = false;
  private readonly pending = new Map<number, (r: EngineReply) => void>();
  private readonly queues = new Map<number, KeywordDetection[]>();

  constructor(transport: MessageTransport, name = 'remote') {
    this.name = name;
    this.transport = transport;
    this.off = transport.onMessage((m) => {
      const r = m as EngineReply;
      if (r.t === 'detections') this.queues.get(r.sid)?.push(...r.list);
      else if (r.t === 'prepared' || r.t === 'finished') {
        this.pending.get(r.id)?.(r);
        this.pending.delete(r.id);
      }
    });
  }

  get ready(): boolean {
    return this.isReady;
  }

  prepare(grammar: AsrGrammar): Promise<void> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (r) => {
        if (r.t === 'prepared' && r.error) reject(new Error(r.error));
        else {
          this.isReady = true;
          resolve();
        }
      });
      this.transport.postMessage({
        t: 'prepare',
        id,
        grammar: JSON.parse(JSON.stringify(grammar)),
      });
    });
  }

  createSession(vocabulary: readonly string[]): KeywordSession {
    if (!this.isReady) throw new Error('RemoteKeywordEngine.prepare() has not completed');
    const sid = this.nextSid++;
    const queue: KeywordDetection[] = [];
    this.queues.set(sid, queue);
    this.transport.postMessage({ t: 'open', sid, vocabulary: [...vocabulary] });
    let disposed = false;
    const drain = (): KeywordDetection[] => queue.splice(0, queue.length);
    return {
      accept: (samples) => {
        if (disposed || samples.length === 0) return;
        const copy = samples.slice(); // transferable copy; the caller wipes its own buffer
        this.transport.postMessage({ t: 'accept', sid, samples: copy }, [copy.buffer]);
      },
      poll: drain,
      finish: () => {
        if (disposed) return [];
        const id = this.nextId++;
        return new Promise<KeywordDetection[]>((resolve) => {
          this.pending.set(id, (r) => resolve([...drain(), ...(r.t === 'finished' ? r.list : [])]));
          this.transport.postMessage({ t: 'finish', id, sid });
        });
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        queue.length = 0;
        this.queues.delete(sid);
        this.transport.postMessage({ t: 'dispose', sid });
      },
    };
  }

  dispose(): void {
    this.off();
    this.isReady = false;
    this.queues.clear();
    this.pending.clear();
  }
}
