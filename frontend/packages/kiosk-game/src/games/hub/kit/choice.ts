/**
 * Select-then-confirm choices through the unified input layer (ENG-06). Every selection tap is a
 * revision (the input layer's SayOrTouch convention: `revisions` lists every change before the
 * confirmation, in order); a tap on the confirm target commits the current selection. Without a
 * confirm target the first selection commits.
 *
 * The response window runs from `anchorMs` exactly as configured: the input layer times it out at
 * `anchorMs + windowMs` no matter how many selection changes happened in between.
 */
import type { Point } from '../../../core/contracts.ts';
import { type GameRuntime, ModuleAbortedError } from './runtime.ts';

export interface ChoiceRequest {
  /** Option target id -> closed response code. */
  readonly options: ReadonlyMap<string, string>;
  /** Confirm target id (enabled by the caller after the first selection), or null. */
  readonly confirmId: string | null;
  readonly anchorMs: number;
  readonly windowMs: number | null;
  /** Initial selection (e.g. a pre-filled amount); not counted as a revision. */
  readonly initial?: string | null;
  /** Called on every selection change (scene feedback). */
  readonly onSelect?: (code: string, tMs: number) => void;
}

export interface ChoiceOutcome {
  readonly kind: 'response' | 'timeout';
  /** Committed code (null on timeout). */
  readonly value: string | null;
  /** Selection in place when the window closed (timeouts) or was committed. */
  readonly selection: string | null;
  readonly latencyMs: number | null;
  readonly responseMs: number | null;
  readonly revisions: readonly { readonly value: string; readonly tMs: number }[];
  /** Taps that changed or confirmed the selection. */
  readonly tapCount: number;
  /** Normalised position of the committing selection tap. */
  readonly xy: readonly [number, number] | null;
  /** Session time of the first selection, or null. */
  readonly firstSelectionMs: number | null;
}

/** Run one select/confirm choice. Throws {@link ModuleAbortedError} when the module aborts. */
export async function runChoice(rt: GameRuntime, req: ChoiceRequest): Promise<ChoiceOutcome> {
  const input = rt.ctx.input;
  let selection: string | null = req.initial ?? null;
  let selectionXy: readonly [number, number] | null = null;
  let firstSelectionMs: number | null = null;
  const revisions: { value: string; tMs: number }[] = [];
  let tapCount = 0;
  const optionIds = [...req.options.keys()];
  for (;;) {
    rt.check();
    const ids =
      req.confirmId !== null && selection !== null ? [...optionIds, req.confirmId] : optionIds;
    const r = await input.waitForTap(ids, {
      anchorMs: req.anchorMs,
      windowMs: req.windowMs,
      signal: rt.signal,
    });
    if (r.kind === 'aborted') throw new ModuleAbortedError();
    if (r.kind === 'timeout') {
      return {
        kind: 'timeout',
        value: null,
        selection,
        latencyMs: null,
        responseMs: null,
        revisions,
        tapCount,
        xy: null,
        firstSelectionMs,
      };
    }
    const id = r.tap.targetId;
    if (id === null) continue;
    tapCount += 1;
    if (id === req.confirmId && selection !== null) {
      return {
        kind: 'response',
        value: selection,
        selection,
        latencyMs: r.latencyMs,
        responseMs: r.tap.tMs,
        revisions,
        tapCount,
        xy: selectionXy ?? r.tap.xyNorm,
        firstSelectionMs,
      };
    }
    const code = req.options.get(id);
    if (code === undefined) continue;
    selection = code;
    selectionXy = r.tap.xyNorm;
    if (firstSelectionMs === null) firstSelectionMs = r.tap.tMs;
    revisions.push({ value: code, tMs: r.tap.tMs });
    req.onSelect?.(code, r.tap.tMs);
    if (req.confirmId === null) {
      return {
        kind: 'response',
        value: code,
        selection: code,
        latencyMs: r.latencyMs,
        responseMs: r.tap.tMs,
        revisions,
        tapCount,
        xy: r.tap.xyNorm,
        firstSelectionMs,
      };
    }
  }
}

/** Jittered point inside a target (bots tap like people: not always dead centre). */
export function jitterPoint(
  center: Point,
  sizePx: number,
  rand: () => number,
  spread = 0.22,
): Point {
  return {
    x: center.x + (rand() * 2 - 1) * sizePx * spread,
    y: center.y + (rand() * 2 - 1) * sizePx * spread,
  };
}
