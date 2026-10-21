/**
 * Top-level React error boundary for the kiosk. A render/lifecycle error in any screen is reported
 * (the runtime view forwards it to `SessionController.reportError`, which ends the session with
 * `CRASH`: abandon, keep consented events, no resume) and a neutral out-of-service panel replaces
 * the broken subtree. When `resetKey` changes (e.g. the session moved on to wipe/attract) the
 * boundary renders its children again, so one broken screen never bricks the kiosk.
 *
 * Expected aborts thrown during render are reported too; `reportError` ignores them.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

export interface KioskErrorBoundaryProps {
  /** Receives every caught error. */
  readonly onError: (error: unknown, info: ErrorInfo | null) => void;
  /** Changing this value clears a caught error and re-renders the children. */
  readonly resetKey?: unknown;
  /** Replacement while failed (default: a dark, text-free out-of-service panel). */
  readonly fallback?: ReactNode;
  readonly children?: ReactNode;
}

interface State {
  readonly failed: boolean;
  readonly key: unknown;
}

export class KioskErrorBoundary extends Component<KioskErrorBoundaryProps, State> {
  override state: State = { failed: false, key: undefined };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: KioskErrorBoundaryProps, state: State): Partial<State> {
    if (props.resetKey !== state.key) return { key: props.resetKey, failed: false };
    return {};
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    try {
      this.props.onError(error, info);
    } catch (err) {
      console.error('[kiosk] error boundary handler failed', err);
    }
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      this.props.fallback ?? (
        <div
          data-testid="kiosk-error-boundary"
          style={{ position: 'absolute', inset: 0, background: '#1d1d1b' }}
        />
      )
    );
  }
}
