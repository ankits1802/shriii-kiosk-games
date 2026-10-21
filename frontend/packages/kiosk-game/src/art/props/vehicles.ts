/**
 * Vehicles and containers that move: the bullock cart (Road Home) with a walking bullock, rotating
 * spoked wheels, a load bed and a driver's seat socket; the vendor's hand cart (thela) for the push-cart
 * gesture; and a kerosene/fuel can. Side views facing screen-right; origin on the ground under the
 * vehicle's centre; rig units.
 */
import { Container, Graphics, type Ticker } from 'pixi.js';
import { darken, lighten } from '../color.ts';
import { lgrad, rgrad, softShadow, vgrad } from '../draw.ts';
import { MELA } from '../palettes.ts';

function spokedWheel(r: number, rim: number, hub: number): Graphics {
  const g = new Graphics();
  g.circle(0, 0, r).stroke({ width: r * 0.16, color: rim });
  g.circle(0, 0, r - r * 0.08).stroke({ width: 1.5, color: darken(rim, 0.35) });
  const n = 10;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    g.moveTo(Math.cos(a) * r * 0.16, Math.sin(a) * r * 0.16)
      .lineTo(Math.cos(a) * r * 0.92, Math.sin(a) * r * 0.92)
      .stroke({ width: r * 0.075, color: darken(rim, 0.08) });
  }
  g.circle(0, 0, r * 0.2).fill(hub);
  g.circle(0, 0, r * 0.08).fill(darken(hub, 0.5));
  // Iron tyre highlight.
  g.arc(0, 0, r + r * 0.06, -2.4, -1.2).stroke({ width: 2, color: 0x8a8a90, alpha: 0.8 });
  return g;
}

/** Animated bullock (side view, facing right; origin at the hooves' ground centre). */
class Bullock {
  readonly view = new Container();
  private readonly legs: Graphics[] = [];
  private readonly head = new Container();
  private readonly tail = new Graphics();
  private readonly body = new Graphics();
  private phase = 0;

  constructor(private readonly hide = 0xefe6d8) {
    const legXs = [-46, -30, 30, 44];
    for (let i = 0; i < 4; i++) {
      const lg = new Graphics();
      const far = i % 2 === 1;
      const col = far ? darken(hide, 0.18) : hide;
      lg.moveTo(-8, 0)
        .lineTo(8, 0)
        .quadraticCurveTo(7, 16, 6, 22)
        .lineTo(5, 42)
        .lineTo(-5, 42)
        .lineTo(-6, 22)
        .quadraticCurveTo(-8, 14, -8, 0)
        .closePath()
        .fill(col);
      lg.ellipse(0, 22, 6.5, 4).fill(darken(col, 0.06));
      lg.roundRect(-6, 40, 12, 8, 2).fill(0x3a2a22);
      lg.position.set(legXs[i] ?? 0, -54);
      this.legs.push(lg);
    }
    const [l0, l1, l2, l3] = this.legs as [Graphics, Graphics, Graphics, Graphics];
    this.drawBody();
    this.drawHead();
    this.view.addChild(l1, l3, this.tail, this.body, l0, l2, this.head);
    this.head.position.set(66, -92);
  }

  update(dt: number, speed: number): void {
    // Two strides per ~1.1 s at walking speed; legs in diagonal pairs.
    this.phase += dt * Math.min(2.2, Math.abs(speed) / 70) * 0.95;
    const p = this.phase * Math.PI * 2;
    const amp = Math.min(1, Math.abs(speed) / 60) * 0.38;
    const offs = [0, Math.PI, Math.PI, 0];
    this.legs.forEach((lg, i) => {
      lg.rotation = Math.sin(p + (offs[i] ?? 0)) * amp;
    });
    this.body.y = -Math.abs(Math.sin(p)) * 2.2 * (amp > 0 ? 1 : 0);
    this.head.y = -92 + Math.sin(p * 2 + 0.6) * 2 * (amp / 0.38);
    this.head.rotation = Math.sin(p) * 0.03;
    const sw = Math.sin(this.phase * 2.7) * 0.25;
    this.tail.clear();
    this.tail
      .moveTo(-58, -92)
      .quadraticCurveTo(-74 - sw * 20, -70, -68 - sw * 30, -40)
      .stroke({ width: 3, color: darken(this.hide, 0.3) });
    this.tail.circle(-68 - sw * 30, -38, 5).fill(0x3a2a22);
  }

  private drawBody(): void {
    const g = this.body;
    const hide = this.hide;
    g.moveTo(-60, -96)
      .bezierCurveTo(-64, -60, -40, -52, 0, -54)
      .bezierCurveTo(40, -52, 58, -60, 60, -86)
      .bezierCurveTo(58, -104, 40, -112, 22, -108)
      .quadraticCurveTo(10, -126, -6, -110)
      .bezierCurveTo(-30, -112, -58, -112, -60, -96)
      .closePath()
      .fill(
        vgrad([
          [0, lighten(hide, 0.05)],
          [1, darken(hide, 0.16)],
        ]),
      );
    // Hump and dewlap shading.
    g.ellipse(4, -112, 14, 8).fill(lighten(hide, 0.06));
    g.moveTo(50, -76)
      .quadraticCurveTo(58, -58, 46, -54)
      .stroke({ width: 2, color: darken(hide, 0.2) });
    // Painted cloth (jhool) on the back.
    g.moveTo(-36, -106)
      .lineTo(30, -106)
      .lineTo(26, -74)
      .lineTo(-32, -74)
      .closePath()
      .fill(MELA.vermilion);
    g.rect(-32, -80, 58, 5).fill(MELA.marigold);
    for (let k = 0; k < 6; k++) g.circle(-26 + k * 10, -92, 2.5).fill(MELA.brassLight);
  }

  private drawHead(): void {
    const g = new Graphics();
    const hide = this.hide;
    g.moveTo(-10, -12)
      .bezierCurveTo(4, -22, 26, -14, 32, 6)
      .bezierCurveTo(34, 16, 24, 22, 16, 18)
      .bezierCurveTo(4, 14, -6, 8, -12, 4)
      .closePath()
      .fill(lighten(hide, 0.02));
    g.ellipse(26, 13, 7, 6).fill(0xc9a090);
    g.circle(28, 12, 1.4).fill(0x3a2a22);
    g.circle(8, -4, 2.6).fill(0x1a1210);
    g.circle(7.2, -4.8, 0.9).fill(0xffffff);
    g.ellipse(-4, -12, 6, 3).fill(darken(hide, 0.1));
    // Painted horns.
    g.moveTo(-2, -16)
      .quadraticCurveTo(-6, -36, 6, -44)
      .stroke({ width: 5, color: MELA.peacock, cap: 'round' });
    g.moveTo(2, -16)
      .quadraticCurveTo(8, -34, 18, -40)
      .stroke({ width: 4, color: darken(MELA.peacock, 0.25), cap: 'round' });
    g.circle(6, -44, 2.5).fill(MELA.brass);
    // Bell on a cord.
    g.moveTo(4, 14).quadraticCurveTo(0, 26, -4, 30).stroke({ width: 2, color: MELA.vermilion });
    g.circle(-4, 33, 4).fill(MELA.brass);
    this.head.addChild(g);
  }
}

export class BullockCart {
  readonly view = new Container();
  /** Where a seated driver's origin (hip joint) goes, in cart-view units (rig units). */
  readonly seat: { readonly x: number; readonly y: number };
  /** Art scale relative to rig units (default 2.1: a bullock stands about as tall as a person). */
  readonly artScale: number;
  /** Load bed socket (goods/sacks go here, origin at the bed surface). */
  readonly bed = new Container();
  /** Driver layer between the cart body and the near wheel (unscaled rig units). */
  readonly driverLayer = new Container();
  private readonly art = new Container();
  private readonly wheelNearHolder = new Container();
  private readonly wheelFar: Graphics;
  private readonly wheelNear: Graphics;
  private readonly bullock = new Bullock();
  private readonly wheelR = 44;
  private speed = 0;
  private ticker: Ticker | null = null;
  private readonly tick = (t: Ticker): void => this.update(Math.min(0.1, t.deltaMS / 1000));

  constructor(options: { readonly scale?: number } = {}) {
    this.view.label = 'bullock-cart';
    this.artScale = options.scale ?? 2.1;
    this.art.scale.set(this.artScale);
    this.seat = { x: 22 * this.artScale, y: -84 * this.artScale };
    const shadow = new Graphics();
    softShadow(shadow, 30, 0, 150, 10, MELA.ink, 0.32);
    this.wheelFar = spokedWheel(this.wheelR, darken(MELA.wood, 0.25), MELA.woodDark);
    this.wheelFar.position.set(-30, -this.wheelR);
    this.wheelFar.alpha = 0.95;
    this.wheelNear = spokedWheel(this.wheelR, MELA.wood, MELA.brass);
    this.wheelNear.position.set(-24, -this.wheelR);
    const body = new Graphics();
    // Bed with rails.
    body.roundRect(-96, -82, 136, 12, 3).fill(
      lgrad({ x: 0, y: 0 }, { x: 0, y: 1 }, [
        [0, lighten(MELA.wood, 0.12)],
        [1, darken(MELA.wood, 0.25)],
      ]),
    );
    for (let x = -92; x <= 34; x += 18) body.rect(x, -112, 4, 32).fill(darken(MELA.wood, 0.1));
    body.roundRect(-96, -114, 136, 5, 2).fill(MELA.wood);
    // Shaft to the yoke.
    body
      .moveTo(36, -78)
      .lineTo(150, -96)
      .stroke({ width: 7, color: darken(MELA.wood, 0.15), cap: 'round' });
    body.roundRect(140, -104, 34, 8, 3).fill(MELA.woodDark);
    // Painted panel.
    body.rect(-90, -80, 124, 6).fill({ color: MELA.marigold, alpha: 0.9 });
    for (let x = -84; x <= 28; x += 14) body.circle(x, -77, 2).fill(MELA.vermilion);
    this.bed.position.set(-30, -82);
    this.bullock.view.position.set(196, 0);
    // Reins from the driver's hands to the bullock's nose.
    const k = this.artScale;
    const reins = new Graphics()
      .moveTo((this.seat.x + 58) / k, (this.seat.y - 66) / k)
      .quadraticCurveTo(200, -60, 288, -80)
      .stroke({ width: 1.6, color: MELA.woodDark });
    this.art.addChild(shadow, this.wheelFar, this.bullock.view, body, this.bed);
    this.view.addChild(this.art, this.driverLayer, reins, this.wheelNearHolder);
    this.wheelNearHolder.scale.set(k);
    this.wheelNearHolder.addChild(this.wheelNear);
    reins.scale.set(k);
  }

  /** Current wheel angle (radians). */
  get wheelAngle(): number {
    return this.wheelNear.rotation;
  }

  /** Ground speed in rig units per second (animates wheels and the bullock's walk). */
  setSpeed(unitsPerSecond: number): void {
    this.speed = unitsPerSecond;
  }

  attach(ticker: Ticker): void {
    this.ticker?.remove(this.tick);
    this.ticker = ticker;
    ticker.add(this.tick);
  }

  update(dt: number): void {
    const rot = (this.speed * dt) / (this.wheelR * this.artScale);
    this.wheelNear.rotation += rot;
    this.wheelFar.rotation += rot;
    this.bullock.update(dt, this.speed / this.artScale);
  }

  destroy(): void {
    this.ticker?.remove(this.tick);
    this.ticker = null;
    this.view.destroy({ children: true });
  }
}

/** Vendor's push cart (thela): handles at the back (left), two wheels, a goods tray. */
export class HandCart {
  readonly view = new Container();
  /** Tray socket for goods (origin at the tray surface). */
  readonly tray = new Container();
  /** Grip point for a pusher's hands (cart-view units). */
  readonly grip: { readonly x: number; readonly y: number };
  private readonly wheel: Graphics;
  private readonly wheelR = 24;
  private speed = 0;

  constructor(color: number = MELA.peacock, scale = 1.5) {
    this.view.label = 'hand-cart';
    this.grip = { x: -118 * scale, y: -104 * scale };
    const art = new Container();
    art.scale.set(scale);
    const shadow = new Graphics();
    softShadow(shadow, 0, 0, 100, 8, MELA.ink, 0.3);
    const g = new Graphics();
    g.moveTo(-118, -104).lineTo(-70, -74).stroke({ width: 5, color: MELA.woodDark, cap: 'round' });
    g.roundRect(-124, -108, 14, 7, 3).fill(MELA.ink);
    g.roundRect(-74, -78, 150, 12, 3).fill(
      vgrad([
        [0, lighten(MELA.wood, 0.1)],
        [1, darken(MELA.wood, 0.3)],
      ]),
    );
    g.roundRect(-70, -96, 142, 20, 4).fill(color);
    g.rect(-70, -84, 142, 4).fill(MELA.marigold);
    for (let x = -62; x <= 66; x += 16) g.circle(x, -90, 2.2).fill(MELA.cream);
    g.moveTo(60, -66).lineTo(64, -6).stroke({ width: 4, color: MELA.woodDark });
    this.wheel = spokedWheel(this.wheelR, MELA.woodDark, MELA.brass);
    this.wheel.position.set(-10, -this.wheelR);
    this.tray.position.set(0, -96);
    art.addChild(shadow, g, this.tray, this.wheel);
    this.view.addChild(art);
  }

  setSpeed(unitsPerSecond: number): void {
    this.speed = unitsPerSecond;
  }

  update(dt: number): void {
    this.wheel.rotation += (this.speed * dt) / this.wheelR;
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }
}

/** Kerosene/fuel can (painted metal, cap and handle). Origin at the base centre. */
export function createFuelCan(color: number = 0xc0392b, height = 48): Container {
  const c = new Container();
  c.label = 'fuel-can';
  const h = height;
  const w = h * 0.68;
  const g = new Graphics();
  softShadow(g, 0, 0, w * 0.62, 4, MELA.ink, 0.3);
  g.roundRect(-w / 2, -h, w, h, 4).fill(
    lgrad({ x: 0, y: 0 }, { x: 1, y: 0 }, [
      [0, lighten(color, 0.18)],
      [0.4, color],
      [1, darken(color, 0.32)],
    ]),
  );
  // Pressed X ribs.
  g.moveTo(-w * 0.36, -h * 0.82)
    .lineTo(w * 0.36, -h * 0.16)
    .stroke({ width: 2.4, color: darken(color, 0.22) });
  g.moveTo(w * 0.36, -h * 0.82)
    .lineTo(-w * 0.36, -h * 0.16)
    .stroke({ width: 2.4, color: darken(color, 0.22) });
  g.roundRect(-w / 2, -h, w, h, 4).stroke({ width: 1.5, color: darken(color, 0.4) });
  // Handle and spout cap.
  g.roundRect(-w * 0.42, -h - 9, w * 0.5, 8, 3).stroke({ width: 3, color: darken(color, 0.3) });
  g.roundRect(w * 0.14, -h - 8, w * 0.24, 9, 2).fill(
    rgrad(
      [
        [0, 0xd8d8dc],
        [1, 0x8a8a90],
      ],
      { x: 0.4, y: 0.4 },
      0.8,
    ),
  );
  g.ellipse(-w * 0.2, -h * 0.55, w * 0.06, h * 0.22).fill({ color: 0xffffff, alpha: 0.18 });
  c.addChild(g);
  return c;
}
