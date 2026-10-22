/**
 * Touch targets for the set-2 micro-games. Bounds are computed from pure layout geometry (never from
 * rendered sprites), so the same targets exist on the kiosk, in the headless bot harness and in
 * vitest. Every target is >= 20 mm with >= 8 mm spacing (KSK-05; the input layer warns or throws in
 * strict dev builds) and carries an audio key for long-press help.
 */
import type { InputService, LineId, Point, Rect, TargetHandle } from '../../../core/contracts.ts';
import { TOUCH_SPACING_MIN_MM, TOUCH_TARGET_MIN_MM } from '../../../core/contracts.ts';

interface Entry {
  handle: TargetHandle;
  bounds: Rect;
  enabled: boolean;
}

/** Square of `sizePx` centred on `c`. */
export function squareAt(c: Point, sizePx: number): Rect {
  return { x: c.x - sizePx / 2, y: c.y - sizePx / 2, width: sizePx, height: sizePx };
}

/** Rect of `w` x `h` centred on `c`. */
export function rectAt(c: Point, w: number, h: number): Rect {
  return { x: c.x - w / 2, y: c.y - h / 2, width: w, height: h };
}

/** Centre of a rect. */
export function centerOf(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** Minimum target edge in px for a density. */
export function minTargetPx(pxPerMm: number): number {
  return TOUCH_TARGET_MIN_MM * pxPerMm;
}

/** Minimum spacing in px for a density. */
export function minSpacingPx(pxPerMm: number): number {
  return TOUCH_SPACING_MIN_MM * pxPerMm;
}

export class TargetBoard {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly input: InputService) {}

  /** Register a target, or move/re-enable an existing one. */
  set(
    id: string,
    bounds: Rect,
    audioKey: LineId,
    options: { readonly kind?: 'tap' | 'hold' | 'drag'; readonly enabled?: boolean } = {},
  ): void {
    const enabled = options.enabled ?? true;
    const existing = this.entries.get(id);
    if (existing) {
      // Disable first so a moved target is never validated against its own old bounds.
      existing.handle.setEnabled(false);
      existing.handle.setBounds(bounds);
      existing.handle.setEnabled(enabled);
      existing.bounds = bounds;
      existing.enabled = enabled;
      return;
    }
    // Register enabled and disable through the handle: the input layer's hit test also honours the
    // registration-time `spec.enabled`, which a handle cannot change later.
    const handle = this.input.registerTarget({
      id,
      bounds,
      audioKey,
      kind: options.kind ?? 'tap',
    });
    if (!enabled) handle.setEnabled(false);
    this.entries.set(id, { handle, bounds, enabled });
  }

  enable(id: string, enabled: boolean): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.enabled = enabled;
    e.handle.setEnabled(enabled);
  }

  enableAll(ids: readonly string[], enabled: boolean): void {
    for (const id of ids) this.enable(id, enabled);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  bounds(id: string): Rect | null {
    return this.entries.get(id)?.bounds ?? null;
  }

  center(id: string): Point | null {
    const b = this.bounds(id);
    return b ? centerOf(b) : null;
  }

  remove(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.handle.remove();
    this.entries.delete(id);
  }

  clear(): void {
    for (const e of this.entries.values()) e.handle.remove();
    this.entries.clear();
  }
}
