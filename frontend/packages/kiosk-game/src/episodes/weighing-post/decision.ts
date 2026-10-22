/**
 * Select-then-confirm choice loop over the shared input layer (ENG-06), with optional "inspect more"
 * (re-weigh) requests inside the same response window.
 *
 * Why not `InputService.sayOrTouch`: "inspect more" must be an on-target tap of the live wait (the
 * scorer counts on-target `*inspect_more` taps, `choice.inspect_more_rate`) without committing a
 * response, which sayOrTouch cannot express. Revisions follow sayOrTouch exactly (every option tap is
 * recorded in `revisions`, so reversals before confirm = revisions - 1) to keep the `response` payload
 * comparable across modules.
 *
 * Timing (ENG-01): choices are enabled at `goMs`; the latency anchor is either that go signal or the end
 * of the spoken prompt (`audio_end`), known only when the clip ends. The response window (from the
 * level table) runs from the anchor. A commit before the anchor is a barge-in with a signed, negative
 * latency. `null` latency only for timeouts.
 */
import type { LatencyAnchor } from '@shriii/contracts';
import type { Clock, InputService, RawTap } from '../../core/contracts.ts';

export interface ChoiceAnchor {
  readonly anchorMs: number;
  readonly anchor: LatencyAnchor;
}

export interface ChoiceRequest<C extends string> {
  readonly options: readonly { readonly code: C; readonly targetId: string }[];
  /** Confirm target (select-then-confirm), or null for single-tap commits. */
  readonly confirmId: string | null;
  /** Inspect-more target, or null. */
  readonly inspectId: string | null;
  /** Session time the choices became enabled. */
  readonly goMs: number;
  /** Resolves with the latency anchor once known (immediately for visual anchors). */
  readonly anchor: Promise<ChoiceAnchor>;
  /** Response window from the anchor (level table), or null for untimed. */
  readonly windowMs: number | null;
  readonly signal: AbortSignal;
  /** Visual feedback for a selection (or `null` when cleared). */
  readonly onSelect?: (code: C) => void;
  /** An inspect-more request; return a promise to keep the inspect target disabled until done. */
  readonly onInspect?: () => Promise<void> | void;
  /** Toggle the inspect target while a re-weigh runs. */
  readonly setInspectEnabled?: (enabled: boolean) => void;
  /** Show the confirm control after the first selection. */
  readonly onConfirmAvailable?: () => void;
}

export interface ChoiceOutcome<C extends string> {
  readonly kind: 'response' | 'timeout' | 'aborted';
  readonly value: C | null;
  /** Session time of the committing tap, null on timeout/abort. */
  readonly responseMs: number | null;
  /** Signed latency from the anchor (null on timeout/abort). */
  readonly latencyMs: number | null;
  readonly bargeIn: boolean;
  readonly anchor: ChoiceAnchor | null;
  readonly revisions: readonly { readonly value: C; readonly tMs: number }[];
  readonly tapCount: number;
  readonly touchXyNorm: readonly [number, number] | null;
  readonly inspections: number;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** Run one choice. Never throws for aborts; resolves with `kind: 'aborted'`. */
export async function runChoice<C extends string>(
  input: InputService,
  clock: Clock,
  req: ChoiceRequest<C>,
): Promise<ChoiceOutcome<C>> {
  const byId = new Map(req.options.map((o) => [o.targetId, o.code] as const));
  const revisions: { value: C; tMs: number }[] = [];
  let tapCount = 0;
  let inspections = 0;
  let selection: { code: C; tap: RawTap } | null = null;
  let anchor: ChoiceAnchor | null = null;
  let timedOut = false;
  let current: AbortController | null = null;
  const deadlineAc = new AbortController();
  let inspecting = false;
  /** Set once the choice has resolved: late re-weigh completions must not re-enable anything. */
  let settled = false;

  const onAnchor = (a: ChoiceAnchor): void => {
    anchor = a;
    if (req.windowMs === null) return;
    const remaining = a.anchorMs + req.windowMs - clock.now();
    clock.delay(Math.max(0, remaining), deadlineAc.signal).then(
      () => {
        timedOut = true;
        current?.abort();
      },
      () => undefined,
    );
  };
  void req.anchor.then(onAnchor, () => undefined);

  const finish = async (
    kind: ChoiceOutcome<C>['kind'],
    commit: { code: C; tMs: number; tap: RawTap } | null,
  ): Promise<ChoiceOutcome<C>> => {
    settled = true;
    deadlineAc.abort();
    if (kind !== 'response' || !commit) {
      return {
        kind,
        value: null,
        responseMs: null,
        latencyMs: null,
        bargeIn: false,
        anchor,
        revisions,
        tapCount,
        touchXyNorm: null,
        inspections,
      };
    }
    // Barge-in: the anchor (prompt end) may still be in the future; wait for it (never rejects in
    // practice; an aborted session still yields the anchor from the voice service's interrupt).
    const a = anchor ?? (await req.anchor);
    const latency = round3(commit.tMs - a.anchorMs);
    return {
      kind,
      value: commit.code,
      responseMs: commit.tMs,
      latencyMs: latency,
      bargeIn: latency < 0,
      anchor: a,
      revisions,
      tapCount,
      touchXyNorm: [commit.tap.xyNorm[0], commit.tap.xyNorm[1]],
      inspections,
    };
  };

  for (;;) {
    if (req.signal.aborted) return finish('aborted', null);
    if (timedOut) return finish('timeout', null);
    const ids = [...byId.keys()];
    if (req.inspectId && !inspecting) ids.push(req.inspectId);
    if (req.confirmId && selection) ids.push(req.confirmId);
    current = new AbortController();
    const signal = AbortSignal.any([req.signal, current.signal]);
    const r = await input.waitForTap(ids, { anchorMs: req.goMs, windowMs: null, signal });
    current = null;
    if (r.kind === 'aborted' || r.kind === 'timeout') {
      if (req.signal.aborted) return finish('aborted', null);
      if (timedOut) return finish('timeout', null);
      continue;
    }
    const id = r.tap.targetId;
    if (id === null) continue;
    if (id === req.inspectId) {
      inspections += 1;
      const pending = req.onInspect?.();
      if (pending) {
        inspecting = true;
        req.setInspectEnabled?.(false);
        void pending.finally(() => {
          inspecting = false;
          if (!settled && !req.signal.aborted) req.setInspectEnabled?.(true);
        });
      }
      continue;
    }
    const code = byId.get(id);
    if (code !== undefined) {
      tapCount += 1;
      if (!req.confirmId) {
        // Single-tap commit: nothing can be revised (sayOrTouch records no revisions either).
        req.onSelect?.(code);
        return finish('response', { code, tMs: r.tap.tMs, tap: r.tap });
      }
      revisions.push({ value: code, tMs: r.tap.tMs });
      const first = selection === null;
      selection = { code, tap: r.tap };
      req.onSelect?.(code);
      if (first) req.onConfirmAvailable?.();
      continue;
    }
    if (id === req.confirmId && selection) {
      tapCount += 1;
      return finish('response', { code: selection.code, tMs: r.tap.tMs, tap: selection.tap });
    }
  }
}
