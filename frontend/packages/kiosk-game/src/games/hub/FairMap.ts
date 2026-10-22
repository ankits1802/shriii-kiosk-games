/**
 * The carousel fair map (MG-10): the six Pathway B booths along a winding lantern-lit lane through the
 * fair, in the fixed carousel order (Don't-Tap -> Card Sort -> Balloon -> Tower -> Share-the-Pot ->
 * slot). Between modules the guide walks the player from the booth just played to the next one.
 * Played booths glow with a lit lantern and a marigold garland; the next booth pulses. Progress is
 * shown only as a position on this journey (ENG-11): no numbers, no counts, no scores.
 */
import { gsap } from 'gsap';
import { Container, Graphics, type Sprite } from 'pixi.js';
import { darken, lighten } from '../../art/color.ts';
import { MELA } from '../../art/palettes.ts';
import type { Character, MicroGameId, Point } from '../../core/contracts.ts';
import { createBooth } from './booths.ts';
import type { GameStage } from './kit/stage.ts';

/** Normalised booth spots (x, y on the ground; y grows towards the viewer). */
const SPOTS_LANDSCAPE: readonly Point[] = [
  { x: 0.2, y: 0.9 },
  { x: 0.46, y: 0.83 },
  { x: 0.78, y: 0.77 },
  { x: 0.6, y: 0.69 },
  { x: 0.31, y: 0.645 },
  { x: 0.55, y: 0.6 },
];
const SPOTS_PORTRAIT: readonly Point[] = [
  { x: 0.25, y: 0.9 },
  { x: 0.72, y: 0.82 },
  { x: 0.33, y: 0.73 },
  { x: 0.7, y: 0.66 },
  { x: 0.32, y: 0.6 },
  { x: 0.62, y: 0.555 },
];

interface BoothView {
  readonly root: Container;
  readonly glow: Sprite;
  readonly lantern: Graphics;
  readonly garland: Graphics;
  readonly ring: Graphics;
}

export class FairMap {
  readonly root = new Container();
  private readonly booths: BoothView[] = [];
  private readonly spots: Point[];
  private readonly horizon: number;
  readonly guide: Character;
  private readonly entrance: Point;

  constructor(
    private readonly stage: GameStage,
    readonly order: readonly MicroGameId[],
  ) {
    const W = stage.width;
    const H = stage.height;
    this.horizon = stage.portrait ? 0.5 : 0.55;
    const norm = stage.portrait ? SPOTS_PORTRAIT : SPOTS_LANDSCAPE;
    this.spots = norm.map((p) => ({ x: p.x * W, y: p.y * H }));
    this.entrance = { x: W * 0.5, y: H * 1.04 };
    stage.propLayer.addChild(this.root);
    this.drawLane();
    order.forEach((id, i) => {
      const p = this.spots[i] as Point;
      const s = this.scaleAt(p.y) * 230 * stage.u;
      const root = new Container();
      root.position.set(p.x, p.y);
      root.zIndex = p.y;
      const ring = new Graphics();
      ring
        .ellipse(0, 0, s * 0.62, s * 0.16)
        .stroke({ width: s * 0.04, color: MELA.marigold, alpha: 0.95 });
      ring.visible = false;
      const glow = stage.glowSprite(s * 0.9, 0xffd27a, 0);
      glow.position.set(0, -s * 0.5);
      const booth = createBooth(id, s);
      const lantern = new Graphics();
      lantern
        .moveTo(-s * 0.48, -s * 0.55)
        .lineTo(-s * 0.48, -s * 0.85)
        .stroke({ width: s * 0.02, color: MELA.woodDark });
      lantern.roundRect(-s * 0.54, -s * 0.85, s * 0.12, s * 0.16, s * 0.04).fill(0x6b5a4a);
      const garland = new Graphics();
      for (let k = 0; k < 9; k++) {
        const a = Math.PI * (0.05 + 0.9 * (k / 8));
        garland
          .circle(Math.cos(a) * s * 0.42, -s * 0.56 + Math.sin(a) * s * 0.12, s * 0.035)
          .fill(k % 2 ? MELA.marigold : MELA.saffron);
      }
      garland.visible = false;
      root.addChild(ring, glow, booth, lantern, garland);
      stage.actorLayer.addChild(root);
      this.booths.push({ root, glow, lantern, garland, ring });
    });
    this.guide = stage.character(
      { id: 'hub.guide', role: 'guide', facing: 'right', scale: 0.8 },
      this.entrance,
    );
  }

  /** Perspective scale for a ground y. */
  scaleAt(y: number): number {
    const hz = this.horizon * this.stage.height;
    const d = Math.max(0, Math.min(1, (y - hz) / (this.stage.height - hz)));
    return 0.35 + 0.85 * d;
  }

  /** Booth ground position by carousel index (-1 = the entrance). */
  spot(index: number): Point {
    return index < 0 ? this.entrance : (this.spots[index] ?? this.entrance);
  }

  /**
   * Where the guide stands at a booth: beside it on the lane side and a step towards the viewer, so
   * she is never hidden by the booth and never covers its doorway. -1 = the entrance.
   */
  standAt(index: number): Point {
    if (index < 0) return this.entrance;
    const p = this.spot(index);
    const s = this.scaleAt(p.y) * 230 * this.stage.u;
    const side = p.x > this.stage.width * 0.5 ? -1 : 1;
    return { x: p.x + side * s * 0.62, y: p.y + s * 0.08 };
  }

  private drawLane(): void {
    const pts = [this.entrance, ...this.spots];
    const lane = new Graphics();
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i] as Point;
      const b = pts[i + 1] as Point;
      const steps = 14;
      for (let k = 0; k < steps; k++) {
        const t0 = k / steps;
        const x0 = a.x + (b.x - a.x) * t0;
        const y0 = a.y + (b.y - a.y) * t0;
        const w = this.scaleAt(y0) * 70 * this.stage.u;
        lane
          .ellipse(x0, y0, w, w * 0.32)
          .fill({ color: lighten(MELA.sandstone, 0.18), alpha: 0.85 });
      }
    }
    // Footprint dashes along the lane.
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i] as Point;
      const b = pts[i + 1] as Point;
      for (let k = 1; k < 6; k++) {
        const t = k / 6;
        const x = a.x + (b.x - a.x) * t;
        const y = a.y + (b.y - a.y) * t;
        const s = this.scaleAt(y) * 7 * this.stage.u;
        lane
          .ellipse(x + (k % 2 ? s : -s), y, s, s * 0.55)
          .fill({ color: darken(MELA.sandstone, 0.25), alpha: 0.5 });
      }
    }
    this.root.addChild(lane);
  }

  /** Show which booths are already played and which one is next. */
  setProgress(played: number, next: number): void {
    this.booths.forEach((b, i) => {
      const done = i < played;
      b.garland.visible = done;
      b.lantern.tint = done ? 0xffd27a : 0xffffff;
      b.glow.alpha = done ? 0.35 : 0;
      b.root.alpha = done || i === next ? 1 : 0.82;
      b.ring.visible = i === next;
      if (i === next) {
        gsap.killTweensOf(b.glow);
        gsap.fromTo(
          b.glow,
          { alpha: 0.2 },
          { alpha: 0.85, duration: 0.45, yoyo: true, repeat: -1, ease: 'sine.inOut' },
        );
      }
    });
  }

  /** The next booth lights up as the guide arrives. */
  arrive(next: number): void {
    const b = this.booths[next];
    if (!b) return;
    gsap.killTweensOf(b.glow);
    gsap.to(b.glow, { alpha: 1, duration: 0.25 });
    this.stage.burst(
      'sparkle',
      this.stage.toScreen({ x: b.root.x, y: b.root.y - 80 * this.stage.u }),
      18,
    );
  }

  destroy(): void {
    for (const b of this.booths) gsap.killTweensOf(b.glow);
  }
}
