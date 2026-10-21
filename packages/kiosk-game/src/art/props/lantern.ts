/**
 * Hand-held hurricane lantern (brass tank, glass globe, wire guard, bail handle) with a flickering
 * flame. Origin = the top of the bail handle (the point a hand grips), so it hangs naturally from a
 * character's hand socket. An optional glow sprite (additive) can be supplied by the caller.
 */
import { Container, Graphics, type Sprite } from 'pixi.js';
import { darken, lighten } from '../color.ts';
import { lgrad, rgrad } from '../draw.ts';
import { MELA } from '../palettes.ts';

export class HandLantern {
  readonly view = new Container();
  /** Light centre (local) for glow placement. */
  readonly light = { x: 0, y: 46 };
  private readonly flame = new Graphics();
  private glow: Sprite | null = null;
  private t = 0;
  private lit = 1;

  constructor(
    private readonly size = 1,
    private readonly glassTint: number = MELA.marigold,
  ) {
    this.view.label = 'hand-lantern';
    const back = new Graphics();
    const front = new Graphics();
    this.draw(back, front);
    this.view.addChild(back, this.flame, front);
    this.light.y = 46 * size;
    this.drawFlame(1);
  }

  /** Attach a glow sprite (anchored at its centre). */
  setGlow(glow: Sprite): void {
    this.glow = glow;
    glow.position.set(this.light.x, this.light.y);
    this.view.addChildAt(glow, 0);
  }

  /** Brightness 0..1 (glow follows dusk lighting). */
  setLit(level: number): void {
    this.lit = Math.max(0, Math.min(1, level));
  }

  update(dt: number, motionScale = 1): void {
    this.t += dt;
    const t = this.t;
    const flick = 1 + 0.08 * motionScale * (Math.sin(t * 17.3) * 0.6 + Math.sin(t * 7.1 + 1) * 0.4);
    this.drawFlame(flick);
    if (this.glow) this.glow.alpha = (0.35 + 0.55 * this.lit) * (0.94 + 0.06 * flick);
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }

  private drawFlame(k: number): void {
    const s = this.size;
    const f = this.flame;
    f.clear();
    const y = 50 * s;
    const h = 13 * s * k;
    f.moveTo(0, y)
      .quadraticCurveTo(-5 * s, y - h * 0.4, 0, y - h)
      .quadraticCurveTo(5 * s, y - h * 0.4, 0, y)
      .fill(0xffc24a);
    f.moveTo(0, y)
      .quadraticCurveTo(-2.5 * s, y - h * 0.35, 0, y - h * 0.6)
      .quadraticCurveTo(2.5 * s, y - h * 0.35, 0, y)
      .fill(0xfff6d0);
  }

  private draw(back: Graphics, front: Graphics): void {
    const s = this.size;
    const brass = MELA.brass;
    // Bail handle.
    back
      .moveTo(-14 * s, 22 * s)
      .quadraticCurveTo(-16 * s, -2 * s, 0, 0)
      .quadraticCurveTo(16 * s, -2 * s, 14 * s, 22 * s)
      .stroke({ width: 2 * s, color: darken(brass, 0.35) });
    // Cap and chimney.
    back.roundRect(-9 * s, 12 * s, 18 * s, 8 * s, 3 * s).fill(brass);
    back
      .moveTo(-12 * s, 22 * s)
      .lineTo(12 * s, 22 * s)
      .lineTo(8 * s, 16 * s)
      .lineTo(-8 * s, 16 * s)
      .closePath()
      .fill(darken(brass, 0.12));
    // Glass globe (tinted, translucent).
    back
      .moveTo(-8 * s, 24 * s)
      .bezierCurveTo(-17 * s, 34 * s, -17 * s, 52 * s, -8 * s, 60 * s)
      .lineTo(8 * s, 60 * s)
      .bezierCurveTo(17 * s, 52 * s, 17 * s, 34 * s, 8 * s, 24 * s)
      .closePath()
      .fill(
        rgrad(
          [
            [0, lighten(this.glassTint, 0.6)],
            [0.6, this.glassTint],
            [1, darken(this.glassTint, 0.3)],
          ],
          { x: 0.5, y: 0.6 },
          0.7,
        ),
      );
    // Wire guard.
    for (const x of [-12, 0, 12])
      front
        .moveTo(x * 0.55 * s, 23 * s)
        .quadraticCurveTo(x * 1.25 * s, 42 * s, x * 0.6 * s, 61 * s)
        .stroke({ width: 1.3 * s, color: darken(brass, 0.4) });
    front.ellipse(0, 42 * s, 15 * s, 3 * s).stroke({ width: 1.3 * s, color: darken(brass, 0.4) });
    front.ellipse(-5 * s, 36 * s, 2.5 * s, 7 * s).fill({ color: 0xffffff, alpha: 0.35 });
    // Fuel tank.
    front
      .moveTo(-15 * s, 61 * s)
      .lineTo(15 * s, 61 * s)
      .quadraticCurveTo(19 * s, 70 * s, 13 * s, 76 * s)
      .lineTo(-13 * s, 76 * s)
      .quadraticCurveTo(-19 * s, 70 * s, -15 * s, 61 * s)
      .fill(
        lgrad({ x: 0, y: 0 }, { x: 1, y: 0 }, [
          [0, darken(brass, 0.25)],
          [0.35, MELA.brassLight],
          [1, darken(brass, 0.35)],
        ]),
      );
    front.roundRect(-4 * s, 60 * s, 8 * s, 3 * s, 1 * s).fill(darken(brass, 0.4));
    front.circle(16 * s, 66 * s, 2.5 * s).fill(darken(brass, 0.3));
  }
}
