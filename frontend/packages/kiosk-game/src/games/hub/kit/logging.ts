/**
 * Module-aware raw-tap classification. The input layer classifies every pointer-down against the
 * current wait (premature / on_target / off_target / extra / during_isi). A module may know that a
 * tap was an *instructed* action the input layer cannot see as such — e.g. resting the hand on the
 * Steady Hands hold pad between targets — and must keep it out of the unneeded-action counts the
 * restraint indicators read. {@link withRawTapClassifier} wraps the module logger so the module's
 * classifier sees each `input.raw_tap` payload before it is written; all other events pass through.
 *
 * The wrapper never invents taps and never drops them: it can only re-label a real tap.
 */
import type { EventType, InputRawTapPayload, PayloadOf } from '@shriii/contracts';
import type { EventLogger, LoggedEvent, LogOptions, LogScope } from '../../../core/contracts.ts';

export type RawTapClassifier = (
  payload: InputRawTapPayload,
) => InputRawTapPayload['classification'];

class ClassifyingLogger implements EventLogger {
  readonly sessionId: string;
  readonly scope: LogScope;

  constructor(
    private readonly inner: EventLogger,
    private readonly classify: RawTapClassifier,
  ) {
    this.sessionId = inner.sessionId;
    this.scope = inner.scope;
  }

  log<T extends EventType>(type: T, payload: PayloadOf<T>, options?: LogOptions): LoggedEvent {
    if (type === 'input.raw_tap') {
      const p = payload as InputRawTapPayload;
      const classification = this.classify(p);
      if (classification !== p.classification) {
        const next: InputRawTapPayload = { ...p, classification };
        return this.inner.log(type, next as PayloadOf<T>, options);
      }
    }
    return this.inner.log(type, payload, options);
  }

  child(scope: Partial<LogScope>): EventLogger {
    return new ClassifyingLogger(this.inner.child(scope), this.classify);
  }

  flush(): Promise<void> {
    return this.inner.flush();
  }
}

/** Wrap `logger` so `input.raw_tap` classifications pass through `classify`. */
export function withRawTapClassifier(logger: EventLogger, classify: RawTapClassifier): EventLogger {
  return new ClassifyingLogger(logger, classify);
}

/** Point the input layer's raw-tap logging at `logger` (no-op for inputs without `setLogger`). */
export function routeInputLogging(input: unknown, logger: EventLogger): boolean {
  const i = input as { setLogger?: (l: EventLogger | null) => void };
  if (typeof i.setLogger !== 'function') return false;
  i.setLogger(logger);
  return true;
}
