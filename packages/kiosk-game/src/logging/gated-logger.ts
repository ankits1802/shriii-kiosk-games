/**
 * Logger gate (ENG-05/ENG-07): once a module has ended, nothing it still holds may write events for
 * it. The module host wraps the module's logger in a {@link GatedLogger}; after `module_end` the gate
 * is closed and every further `log()` from the module (or any child logger derived from it, or the
 * input layer still routed to it) is dropped with a non-valid receipt instead of being written.
 *
 * Dropping never throws into gameplay. Drops are counted and reported through `onDrop` (dev builds
 * print a warning) so a module that keeps logging after its end is visible in QA.
 */
import type { EventType, PayloadOf } from '@shriii/contracts';
import type { EventLogger, LoggedEvent, LogOptions, LogScope } from '../core/contracts.ts';

/** Shared open/closed state of one gated logger family (a logger and all its children). */
export class LoggerGate {
  private isClosed = false;
  private droppedCount = 0;
  private readonly onDrop: ((type: EventType, label: string) => void) | undefined;
  readonly label: string;

  constructor(label: string, onDrop?: (type: EventType, label: string) => void) {
    this.label = label;
    this.onDrop = onDrop;
  }

  /** True once {@link close} was called. */
  get closed(): boolean {
    return this.isClosed;
  }

  /** Number of events dropped after the gate closed. */
  get dropped(): number {
    return this.droppedCount;
  }

  /** Close the gate; idempotent. */
  close(): void {
    this.isClosed = true;
  }

  /** @internal Record a dropped event. */
  drop(type: EventType): void {
    this.droppedCount += 1;
    this.onDrop?.(type, this.label);
  }
}

/** Receipt returned for a dropped event: never valid, never a real seq. */
export function droppedReceipt(tMonoMs: number): LoggedEvent {
  return { eventId: '', seq: -1, tMonoMs, valid: false };
}

/** An {@link EventLogger} that forwards to `inner` while its {@link LoggerGate} is open. */
export class GatedLogger implements EventLogger {
  readonly sessionId: string;
  readonly scope: LogScope;
  readonly gate: LoggerGate;
  private readonly inner: EventLogger;
  private readonly now: () => number;

  /**
   * @param inner logger events are forwarded to while the gate is open
   * @param gate shared gate (children share it)
   * @param now session-clock time for dropped receipts
   */
  constructor(inner: EventLogger, gate: LoggerGate, now: () => number) {
    this.inner = inner;
    this.gate = gate;
    this.now = now;
    this.sessionId = inner.sessionId;
    this.scope = inner.scope;
  }

  log<T extends EventType>(type: T, payload: PayloadOf<T>, options?: LogOptions): LoggedEvent {
    if (this.gate.closed) {
      this.gate.drop(type);
      return droppedReceipt(this.now());
    }
    return this.inner.log(type, payload, options);
  }

  child(scope: Partial<LogScope>): EventLogger {
    return new GatedLogger(this.inner.child(scope), this.gate, this.now);
  }

  flush(): Promise<void> {
    return this.inner.flush();
  }
}

/** Dev-build drop reporter: warns once per gate and event type. */
export function warnOnLateEvents(): (type: EventType, label: string) => void {
  const seen = new Set<string>();
  return (type, label) => {
    const key = `${label}|${type}`;
    if (seen.has(key)) return;
    seen.add(key);
    console.warn(`[logger-gate] dropped '${type}' logged by ${label} after module_end`);
  };
}
