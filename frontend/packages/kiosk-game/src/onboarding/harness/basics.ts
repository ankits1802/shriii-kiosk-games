/**
 * Dev/test harness services for onboarding, report and gallery previews. They implement the engine
 * contracts faithfully enough for previews and unit tests; the engine (src/engine, src/logging,
 * src/input) provides the production implementations.
 */
import type { EventType, LanguageTag, PayloadOf } from '@shriii/contracts';
import { hashString } from '../../art/rand.ts';
import type {
  Clock,
  EventLogger,
  LoggedEvent,
  LogOptions,
  LogScope,
  RngState,
  SeededRng,
  TimingProfile,
} from '../../core/contracts.ts';

/** Performance-based monotonic clock (uncertified timing profile). */
export function createDevClock(profile?: Partial<TimingProfile>): Clock {
  const perf = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const anchor = perf();
  const p: TimingProfile = {
    version: 'dev-0',
    certified: false,
    displayOffsetMs: 0,
    audioOutputOffsetMs: 0,
    touchOffsetMs: 0,
    refreshHz: 60,
    ...profile,
  };
  return {
    anchorPerfMs: anchor,
    profile: p,
    now: () => perf() - anchor,
    wallTime: () => new Date().toISOString(),
    fromPerformanceTime: (t) => t - anchor,
    fromPointerTime: (t) => t - anchor - p.touchOffsetMs,
    fromAudioTime: (s) => {
      // Without a shared AudioContext reference, map audio time to "now" plus the output offset.
      void s;
      return perf() - anchor + p.audioOutputOffsetMs;
    },
    nextFrame: () =>
      new Promise((resolve) => {
        const raf = (globalThis as { requestAnimationFrame?: (cb: (t: number) => void) => number })
          .requestAnimationFrame;
        if (raf) raf((t) => resolve(t - anchor + p.displayOffsetMs));
        else setTimeout(() => resolve(perf() - anchor), 16);
      }),
    delay: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        const id = setTimeout(resolve, ms);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(id);
            reject(signal.reason);
          },
          { once: true },
        );
      }),
  };
}

/** A logged event as recorded by {@link MemoryLogger}. */
export interface RecordedEvent {
  readonly seq: number;
  readonly type: EventType;
  readonly payload: unknown;
  readonly scope: LogScope;
  readonly options: LogOptions;
  readonly tMonoMs: number;
}

/** In-memory event logger (gapless seq shared by children). */
export class MemoryLogger implements EventLogger {
  readonly sessionId: string;
  readonly scope: LogScope;
  private readonly sink: { seq: number; events: RecordedEvent[] };
  private readonly clock: Clock | null;

  constructor(
    sessionId = '01900000-0000-7000-8000-000000000000',
    scope: LogScope = { task: null, condition: null, scorable: false },
    sink?: { seq: number; events: RecordedEvent[] },
    clock: Clock | null = null,
  ) {
    this.sessionId = sessionId;
    this.scope = scope;
    this.sink = sink ?? { seq: 0, events: [] };
    this.clock = clock;
  }

  /** All events logged through this logger or its children. */
  get events(): readonly RecordedEvent[] {
    return this.sink.events;
  }

  /** Events of one type. */
  ofType<T extends EventType>(
    type: T,
  ): { payload: PayloadOf<T>; scope: LogScope; options: LogOptions }[] {
    return this.sink.events
      .filter((e) => e.type === type)
      .map((e) => ({ payload: e.payload as PayloadOf<T>, scope: e.scope, options: e.options }));
  }

  log<T extends EventType>(type: T, payload: PayloadOf<T>, options: LogOptions = {}): LoggedEvent {
    const seq = this.sink.seq++;
    const t = this.clock ? this.clock.now() : seq;
    const scope: LogScope = {
      task: options.task !== undefined ? options.task : this.scope.task,
      condition: options.condition !== undefined ? options.condition : this.scope.condition,
      scorable: options.scorable ?? this.scope.scorable,
    };
    this.sink.events.push({ seq, type, payload, scope, options, tMonoMs: t });
    return { eventId: `${this.sessionId}:${seq}`, seq, tMonoMs: t, valid: true };
  }

  child(scope: Partial<LogScope>): EventLogger {
    return new MemoryLogger(this.sessionId, { ...this.scope, ...scope }, this.sink, this.clock);
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }
}

/** Small deterministic SeededRng (xorshift-multiply); the engine supplies the PCG32 implementation. */
export class DevRng implements SeededRng {
  private s: number;
  constructor(
    readonly seedHex: string,
    readonly streamName = 'session',
  ) {
    this.s = hashString(`${seedHex}:${streamName}`) || 1;
  }
  nextUint32(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }
  next(): number {
    return this.nextUint32() / 4294967296;
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  bool(p = 0.5): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick: empty');
    return items[this.int(0, items.length - 1)] as T;
  }
  weighted<T>(items: readonly T[], weights: readonly number[]): T {
    const total = weights.reduce((a, b) => a + b, 0);
    let r = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i] ?? 0;
      if (r < 0) return items[i] as T;
    }
    return items[items.length - 1] as T;
  }
  shuffle<T>(items: readonly T[]): T[] {
    const a = [...items];
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [a[i], a[j]] = [a[j] as T, a[i] as T];
    }
    return a;
  }
  stream(name: string): SeededRng {
    return new DevRng(this.seedHex, `${this.streamName}.${name}`);
  }
  state(): RngState {
    return {
      algorithm: 'pcg32',
      state: this.s.toString(16).padStart(16, '0'),
      increment: '0000000000000001',
    };
  }
}

/** Default onboarding content facts for previews and tests. */
export const DEV_LANGUAGES: readonly LanguageTag[] = ['hi-IN', 'mr-IN', 'ta-IN', 'en-IN'];
