/**
 * Global crash wiring (KSK-02 crash policy, ENG-07 AC): uncaught errors (`error`) and unhandled
 * promise rejections (`unhandledrejection`) end the running session with `CRASH`, which abandons it
 * with `session.abandoned{crash_recovery}` and keeps the consented events (no resume).
 *
 * Expected aborts (see `isAbortError`) are not crashes: their rejection is marked handled
 * (`preventDefault`) so they neither crash the session nor spam the console.
 */
import type { Unsubscribe } from '../core/contracts.ts';
import type { ErrorDisposition } from './session-controller.ts';

/** Minimal event-target surface (window in the browser, a fake in tests). */
export interface CrashEventTarget {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

/** Install `error` + `unhandledrejection` handlers that forward to `report`. Returns the remover. */
export function installGlobalCrashHandlers(
  target: CrashEventTarget,
  report: (error: unknown) => ErrorDisposition,
): Unsubscribe {
  const onError = (event: Event): void => {
    const e = event as ErrorEvent;
    // Resource load failures (img/script) are not script errors and do not reach here without
    // capture; a script error always has `error` or at least `message`.
    const error: unknown = e.error ?? (e.message ? new Error(e.message) : null);
    if (error === null) return;
    if (report(error) === 'abort') event.preventDefault();
  };
  const onRejection = (event: Event): void => {
    const reason: unknown = (event as PromiseRejectionEvent).reason;
    if (report(reason) === 'abort') event.preventDefault();
  };
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onRejection);
  };
}
