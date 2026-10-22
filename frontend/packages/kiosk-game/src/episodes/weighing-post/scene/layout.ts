/**
 * Pure layout of The Weighing Post for landscape (1920x1080 class) and portrait (1080x1920 class)
 * kiosks. Shared by the rendered and the headless scene so bots tap exactly where players tap.
 *
 * Touch rules (KSK-05/06): every token is at least {@link TOKEN_MM} (>= 20 mm), tokens are spaced
 * >= 8 mm apart, and every interactive element lives in the lower two-thirds of the screen.
 *
 * Choice tokens are spread evenly across the safe area (column centres at (i + 1/2) / n of its width), so
 * different answers land in different cells of the scorer's 3 x 3 careless-responding grid
 * (`quality.careless.position_grid`): a player who varies their answers never looks like a player who
 * taps one spot. The confirm seal appears directly above the selected token.
 */
import type { Layout, Point, Rect } from '../../../core/contracts.ts';
import type { ChoiceKind, ChoiceSlot, ControlRects } from './types.ts';

/** Choice token edge in millimetres (well above the 20 mm minimum). */
export const TOKEN_MM = 32;
/** Gap between neighbouring targets in millimetres (>= 8 mm). */
export const TOKEN_GAP_MM = 11;
/** Round control (confirm / inspect) diameter in millimetres. */
export const CONTROL_MM = 30;
export const REPLAY_MM = 22;

export interface SceneGeometry {
  readonly width: number;
  readonly height: number;
  readonly safe: Rect;
  readonly portrait: boolean;
  /** Short-edge scale unit (short edge / 1080). */
  readonly u: number;
  readonly tokenPx: number;
  readonly gapPx: number;
  readonly controlPx: number;
  /** Top of the counter (the front plank the tokens rest on). */
  readonly counterTop: number;
  /** Centre line of the token row. */
  readonly rowY: number;
  /** Second line (portrait: luck faces' second row and the inspect control). */
  readonly row2Y: number;
  /** Scale base (on the counter) and its drawn height. */
  readonly scaleBase: Point;
  readonly scaleHeight: number;
  /** Where the customer, assistant and guide stand (feet). */
  readonly customer: Point;
  readonly assistant: Point;
  readonly guide: Point;
  readonly queue: Point;
  /** Character scale relative to the rig's ~330-unit standing height. */
  readonly characterScale: number;
  /** Rule placard centre. */
  readonly placard: Point;
  readonly placardScale: number;
  /** Centre of the luck screen / probe baskets on the counter. */
  readonly stageCentre: Point;
}

export function geometry(
  layout: Pick<Layout, 'width' | 'height' | 'metrics'> & { readonly safeArea?: Rect },
): SceneGeometry {
  const W = layout.width;
  const H = layout.height;
  const safe = layout.safeArea ?? { x: 0, y: 0, width: W, height: H };
  const portrait = H > W;
  const u = Math.min(W, H) / 1080;
  const mm = layout.metrics.pxPerMm;
  const tokenPx = Math.max(TOKEN_MM * mm, layout.metrics.minTargetPx * 1.4, 128 * u);
  const gapPx = Math.max(TOKEN_GAP_MM * mm, layout.metrics.minSpacingPx * 1.2, 34 * u);
  const controlPx = Math.max(CONTROL_MM * mm, layout.metrics.minTargetPx * 1.3, 112 * u);
  if (!portrait) {
    const counterTop = H * 0.755;
    return {
      width: W,
      height: H,
      safe,
      portrait,
      u,
      tokenPx,
      gapPx,
      controlPx,
      counterTop,
      rowY: counterTop + (H - counterTop) * 0.52,
      row2Y: counterTop + (H - counterTop) * 0.52,
      scaleBase: { x: W * 0.5, y: counterTop + 6 * u },
      scaleHeight: H * 0.6,
      customer: { x: W * 0.255, y: counterTop + 150 * u },
      assistant: { x: W * 0.765, y: counterTop + 150 * u },
      guide: { x: W * 0.085, y: H + 40 * u },
      queue: { x: W * 0.06, y: counterTop + 110 * u },
      characterScale: 1.62 * u,
      placard: { x: W * 0.905, y: H * 0.36 },
      placardScale: u,
      stageCentre: { x: W * 0.5, y: counterTop - 4 * u },
    };
  }
  const counterTop = H * 0.69;
  return {
    width: W,
    height: H,
    safe,
    portrait,
    u,
    tokenPx,
    gapPx,
    controlPx,
    counterTop,
    rowY: counterTop + (H - counterTop) * 0.36,
    row2Y: counterTop + (H - counterTop) * 0.74,
    scaleBase: { x: W * 0.5, y: counterTop + 4 * u },
    scaleHeight: H * 0.36,
    customer: { x: W * 0.17, y: counterTop + 120 * u },
    assistant: { x: W * 0.84, y: counterTop + 120 * u },
    guide: { x: W * 0.13, y: H * 0.985 },
    queue: { x: -W * 0.05, y: counterTop + 90 * u },
    characterScale: 1.3 * u,
    placard: { x: W * 0.82, y: H * 0.17 },
    placardScale: u * 0.92,
    stageCentre: { x: W * 0.5, y: counterTop - 4 * u },
  };
}

function rectAt(cx: number, cy: number, size: number): Rect {
  return { x: cx - size / 2, y: cy - size / 2, width: size, height: size };
}

/** Column centre `i` of `n` evenly spread across the safe area. */
function columnX(g: SceneGeometry, i: number, n: number): number {
  return g.safe.x + (g.safe.width * (i + 0.5)) / n;
}

/** The confirm seal directly above a token (>= 8 mm clear of it). */
export function confirmAbove(g: SceneGeometry, token: Rect): Rect {
  const cx = token.x + token.width / 2;
  const cy = token.y - g.gapPx - g.controlPx / 2;
  return rectAt(cx, cy, g.controlPx);
}

/** Rects of the persistent controls (confirm: its default spot above the centre column). */
export function controlRects(g: SceneGeometry): ControlRects {
  const replaySize = Math.max(g.controlPx * (REPLAY_MM / CONTROL_MM), 88 * g.u);
  const replay = rectAt(replaySize * 0.5 + 30 * g.u, g.height * 0.42, replaySize);
  const centreToken = rectAt(columnX(g, 1, 3), g.rowY, g.tokenPx);
  const inspect = g.portrait
    ? rectAt(g.width / 2, g.row2Y, g.controlPx)
    : rectAt(g.safe.x + g.safe.width / 3, g.rowY, g.controlPx);
  return { replay, inspect, confirm: confirmAbove(g, centreToken) };
}

/** Token rects for a choice kind. */
export function choiceSlots(
  g: SceneGeometry,
  kind: ChoiceKind,
  codes: readonly string[],
): ChoiceSlot[] {
  const n = codes.length;
  const size = kind === 'luck' ? g.tokenPx * 0.92 : g.tokenPx;
  const perRow = g.portrait && n > 4 ? Math.ceil(n / 2) : n;
  const rows: string[][] = [];
  for (let i = 0; i < n; i += perRow) rows.push(codes.slice(i, i + perRow));
  const ys = rows.length === 1 ? [g.rowY] : [g.rowY, g.row2Y];
  const out: ChoiceSlot[] = [];
  rows.forEach((row, r) => {
    row.forEach((code, i) => {
      out.push({ code, rect: rectAt(columnX(g, i, row.length), ys[r] ?? g.rowY, size) });
    });
  });
  return out;
}

/** Centre of a rect. */
export function centreOf(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}
