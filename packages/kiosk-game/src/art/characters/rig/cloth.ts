/**
 * Secondary motion: Verlet rope chains for cloth tails (dupatta ends, saree pallu, pagri tail, gamcha,
 * braid) and short pendulums (earrings, a carried lantern).
 *
 * Simulated in the character's figure space with an inertial term: when the figure accelerates (walk
 * start, a hop) the cloth lags behind, and air drag on the WORLD velocity (point velocity plus the
 * figure's own velocity) makes tails trail while walking. A soft "shape memory" pulls each node towards
 * its rest direction so cloth keeps a drape instead of hanging like string. Fixed 120 Hz sub-steps keep
 * the result frame-rate independent and stable for long frames.
 */

export interface ClothOptions {
  /** Number of segments (points = segments + 1). */
  readonly segments: number;
  /** Total rest length (rig units). */
  readonly length: number;
  /** Rest direction (unit-ish vector, figure space; default straight down). */
  readonly restDir?: { readonly x: number; readonly y: number };
  /** Shape-memory stiffness towards the rest drape (0 = string). */
  readonly stiffness?: number;
  /** Velocity damping per sub-step (0..1, fraction kept). */
  readonly damping?: number;
  /** Air drag coefficient. */
  readonly drag?: number;
  /** Gravity (rig units / s^2). */
  readonly gravity?: number;
  /** Ambient breeze amplitude (rig units / s^2). */
  readonly wind?: number;
  /** Seed phase for the breeze. */
  readonly phase?: number;
}

export interface ClothPoint {
  x: number;
  y: number;
  px: number;
  py: number;
}

const SUB = 1 / 120;

export class ClothChain {
  readonly points: ClothPoint[];
  readonly segLen: number;
  private readonly restDir: { x: number; y: number };
  private readonly stiffness: number;
  private readonly damping: number;
  private readonly drag: number;
  private readonly gravity: number;
  private readonly wind: number;
  private time: number;
  private acc = 0;
  private anchor = { x: 0, y: 0 };

  constructor(opts: ClothOptions, anchorX = 0, anchorY = 0) {
    const n = Math.max(1, Math.round(opts.segments));
    this.segLen = opts.length / n;
    const rd = opts.restDir ?? { x: 0, y: 1 };
    const l = Math.hypot(rd.x, rd.y) || 1;
    this.restDir = { x: rd.x / l, y: rd.y / l };
    this.stiffness = opts.stiffness ?? 6;
    this.damping = opts.damping ?? 0.985;
    this.drag = opts.drag ?? 1.4;
    this.gravity = opts.gravity ?? 900;
    this.wind = opts.wind ?? 30;
    this.time = opts.phase ?? 0;
    this.points = [];
    for (let i = 0; i <= n; i++) {
      const x = anchorX + this.restDir.x * this.segLen * i;
      const y = anchorY + this.restDir.y * this.segLen * i;
      this.points.push({ x, y, px: x, py: y });
    }
    this.anchor = { x: anchorX, y: anchorY };
  }

  /** Snap the whole chain to its rest drape at an anchor (on view changes / teleports). */
  reset(anchorX: number, anchorY: number): void {
    this.anchor = { x: anchorX, y: anchorY };
    this.points.forEach((p, i) => {
      p.x = anchorX + this.restDir.x * this.segLen * i;
      p.y = anchorY + this.restDir.y * this.segLen * i;
      p.px = p.x;
      p.py = p.y;
    });
  }

  /**
   * Advance by `dt` seconds. `anchor` is the attachment point (figure space); `frameVel` and `frameAcc`
   * are the figure's own velocity and acceleration in the parent (for drag and inertia).
   */
  update(
    dt: number,
    anchor: { readonly x: number; readonly y: number },
    frameVel: { readonly x: number; readonly y: number } = { x: 0, y: 0 },
    frameAcc: { readonly x: number; readonly y: number } = { x: 0, y: 0 },
    motionScale = 1,
  ): void {
    this.acc += Math.min(0.1, Math.max(0, dt));
    const start = { ...this.anchor };
    let steps = 0;
    const total = Math.floor(this.acc / SUB);
    while (this.acc >= SUB) {
      this.acc -= SUB;
      steps++;
      const u = total > 0 ? steps / total : 1;
      this.anchor = {
        x: start.x + (anchor.x - start.x) * u,
        y: start.y + (anchor.y - start.y) * u,
      };
      this.step(SUB, frameVel, frameAcc, motionScale);
    }
    if (total === 0) this.anchor = { x: anchor.x, y: anchor.y };
    const first = this.points[0];
    if (first) {
      first.x = this.anchor.x;
      first.y = this.anchor.y;
    }
  }

  private step(
    h: number,
    vel: { readonly x: number; readonly y: number },
    acc: { readonly x: number; readonly y: number },
    motionScale: number,
  ): void {
    this.time += h;
    const pts = this.points;
    const first = pts[0];
    if (!first) return;
    first.px = first.x;
    first.py = first.y;
    first.x = this.anchor.x;
    first.y = this.anchor.y;
    const breeze =
      this.wind *
      motionScale *
      (Math.sin(this.time * 1.7) * 0.6 + Math.sin(this.time * 4.3 + 1) * 0.4);
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i];
      if (!p) continue;
      const vx = (p.x - p.px) / h;
      const vy = (p.y - p.py) / h;
      // Shape memory towards the rest drape from the anchor.
      const rx = this.anchor.x + this.restDir.x * this.segLen * i;
      const ry = this.anchor.y + this.restDir.y * this.segLen * i;
      const ax =
        -acc.x - this.drag * (vx + vel.x) + this.stiffness * (rx - p.x) + breeze * (i / pts.length);
      const ay = this.gravity - acc.y - this.drag * (vy + vel.y) + this.stiffness * (ry - p.y);
      const nx = p.x + (p.x - p.px) * this.damping + ax * h * h;
      const ny = p.y + (p.y - p.py) * this.damping + ay * h * h;
      p.px = p.x;
      p.py = p.y;
      p.x = nx;
      p.y = ny;
    }
    // Distance constraints (two passes, anchor fixed).
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 1e-6;
        const diff = (d - this.segLen) / d;
        if (i === 1) {
          b.x -= dx * diff;
          b.y -= dy * diff;
        } else {
          a.x += dx * diff * 0.5;
          a.y += dy * diff * 0.5;
          b.x -= dx * diff * 0.5;
          b.y -= dy * diff * 0.5;
        }
      }
    }
  }
}

/** Damped pendulum for earrings and hanging props: angle from vertical (radians). */
export class Pendulum {
  angle = 0;
  private vel = 0;

  constructor(
    private readonly length: number,
    private readonly damping = 3.5,
  ) {}

  /** Advance with the pivot's horizontal acceleration (rig units / s^2). */
  update(dt: number, pivotAccX: number, motionScale = 1): number {
    const g = 900;
    let left = Math.min(0.1, Math.max(0, dt));
    while (left > 0) {
      const h = Math.min(SUB, left);
      left -= h;
      const a =
        (-g / this.length) * Math.sin(this.angle) -
        (pivotAccX * motionScale * Math.cos(this.angle)) / this.length -
        this.damping * this.vel;
      this.vel += a * h;
      this.angle += this.vel * h;
    }
    return this.angle;
  }
}
