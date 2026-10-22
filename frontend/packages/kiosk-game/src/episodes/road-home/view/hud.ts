/**
 * Diegetic heads-up pieces: the palm-leaf errand chit (pictures, never words or numbers), the
 * fodder tray on the cart (pictured hay bundles that thin as the cart travels; the partner tops it up
 * from the reserve sack when it runs dry), the rest cot offered on the flooded river, and the replay
 * button (instruction replay, >= 20 mm). Errand pictures are laid out as a cluster, not a row, so the
 * chit never suggests an order.
 */
import { gsap } from 'gsap';
import { Container, Graphics, type Sprite } from 'pixi.js';
import { darken } from '../../../art/color.ts';
import { softShadow, vgrad } from '../../../art/draw.ts';
import { MELA } from '../../../art/palettes.ts';
import { IconButton } from '../../../art/ui/buttons.ts';
import type { Rect } from '../../../core/contracts.ts';
import type { EpisodeArt } from './art.ts';
import { drawCharpai, drawErrandPicture, ERRAND_PICTURES } from './places.ts';
import { drawBundle } from './stops.ts';

/** Cluster offsets (in plate radii) for 1..4 pictures. */
const CLUSTER: readonly (readonly (readonly [number, number])[])[] = [
  [[0, 0]],
  [
    [-1.15, 0.2],
    [1.15, -0.2],
  ],
  [
    [-1.2, 0.45],
    [0, -0.55],
    [1.2, 0.45],
  ],
  [
    [-1.2, -0.55],
    [1.2, -0.55],
    [-1.2, 0.6],
    [1.2, 0.6],
  ],
];

export class ErrandChit {
  readonly view = new Container();
  private readonly plates: { root: Container; tick: Graphics }[] = [];

  constructor(art: EpisodeArt, errands: number) {
    this.view.label = 'errand-chit';
    this.view.eventMode = 'none';
    const u = art.unit;
    const r = Math.max(art.mm(6.5), 30 * u);
    const pad = r * 1.1;
    const layout = CLUSTER[Math.max(0, Math.min(3, errands - 1))] ?? [];
    const w = r * 2 * 2.7 + pad;
    const h = r * 2 * 2.1 + pad * 0.6;
    const leaf = new Graphics();
    softShadow(leaf, w / 2 + 6 * u, h + 6 * u, w * 0.5, 10 * u, MELA.ink, 0.25);
    leaf.roundRect(0, 0, w, h, h * 0.22).fill(
      vgrad([
        [0, 0xf6e7bf],
        [1, 0xe2c992],
      ]),
    );
    leaf.roundRect(0, 0, w, h, h * 0.22).stroke({ width: 3 * u, color: 0xa88a52 });
    for (let k = 1; k < 4; k += 1)
      leaf
        .moveTo(w * 0.06, (h * k) / 4)
        .lineTo(w * 0.94, (h * k) / 4)
        .stroke({ width: 1.2 * u, color: 0xc9ab72, alpha: 0.6 });
    // Tied with red thread at both ends.
    for (const x of [w * 0.04, w * 0.96]) leaf.circle(x, h / 2, 6 * u).fill(MELA.vermilion);
    this.view.addChild(leaf);
    for (let i = 0; i < errands; i += 1) {
      const [ox, oy] = layout[i] ?? [0, 0];
      const root = new Container();
      root.position.set(w / 2 + ox * r * 1.25, h / 2 + oy * r * 1.15);
      const plate = new Graphics();
      plate.circle(0, 0, r).fill(MELA.cream);
      plate.circle(0, 0, r).stroke({ width: 3 * u, color: MELA.marigold });
      root.addChild(plate, drawErrandPicture(ERRAND_PICTURES[i] ?? 'pot', r * 1.5));
      const tick = new Graphics();
      tick.circle(r * 0.62, r * 0.62, r * 0.42).fill(0x12707a);
      tick
        .moveTo(r * 0.42, r * 0.62)
        .lineTo(r * 0.58, r * 0.8)
        .lineTo(r * 0.86, r * 0.42)
        .stroke({ width: 4 * u, color: 0xffffff, cap: 'round', join: 'round' });
      tick.visible = false;
      root.addChild(tick);
      this.view.addChild(root);
      this.plates.push({ root, tick });
    }
  }

  /** Errand `index` done: a tick seal appears and the picture dims slightly. */
  done(index: number): void {
    const p = this.plates[index];
    if (!p) return;
    p.tick.visible = true;
    p.tick.scale.set(0.2);
    gsap.to(p.tick.scale, { x: 1, y: 1, duration: 0.35, ease: 'back.out(3)' });
    gsap.to(p.root.scale, { x: 1.15, y: 1.15, duration: 0.15, yoyo: true, repeat: 1 });
  }

  destroy(): void {
    for (const p of this.plates) {
      gsap.killTweensOf(p.tick.scale);
      gsap.killTweensOf(p.root.scale);
    }
    this.view.destroy({ children: true });
  }
}

/** The fodder tray: one pictured bundle per fodder unit. */
export class FodderTray {
  readonly view = new Container();
  private readonly bundles: Container[] = [];
  private readonly sack = new Container();
  private level: number;

  constructor(
    private readonly art: EpisodeArt,
    readonly capacity: number,
  ) {
    this.view.label = 'fodder-tray';
    this.view.eventMode = 'none';
    const u = art.unit;
    // Two neat rows of pictured bundles in a woven tray (never a number).
    const bs = Math.max(0.6, 0.95 * u);
    const perRow = capacity > 8 ? Math.ceil(capacity / 2) : capacity;
    const rows = Math.ceil(capacity / perRow);
    const step = 38 * bs;
    const w = step * perRow + 36 * u;
    const rowH = 40 * bs;
    const trayTop = 16 * u;
    const trayH = rowH * rows + 26 * u;
    const tray = new Graphics();
    softShadow(tray, w / 2, trayTop + trayH + 4 * u, w * 0.52, 10 * u, MELA.ink, 0.25);
    tray.roundRect(0, trayTop, w, trayH, 14 * u).fill(
      vgrad([
        [0, 0xc49a5e],
        [1, 0x8a5a2e],
      ]),
    );
    tray.roundRect(0, trayTop, w, trayH, 14 * u).stroke({ width: 3 * u, color: 0x6a4424 });
    for (let k = 0; k < 16; k += 1)
      tray
        .moveTo((w * k) / 16, trayTop + 4 * u)
        .lineTo((w * (k + 0.5)) / 16, trayTop + trayH - 4 * u)
        .stroke({ width: 1.2 * u, color: darken(0xb98a50, 0.3), alpha: 0.45 });
    this.view.addChild(tray);
    for (let i = 0; i < capacity; i += 1) {
      const b = drawBundle(bs, 200 + i);
      const row = Math.floor(i / perRow);
      const col = i % perRow;
      b.position.set(18 * u + step * (col + 0.5), trayTop + 14 * u + rowH * (row + 1) - 4 * u);
      this.view.addChild(b);
      this.bundles.push(b);
    }
    // Reserve sack the partner dips into when the tray runs dry.
    const sk = new Graphics();
    sk.moveTo(-18 * u, 50 * u)
      .quadraticCurveTo(-24 * u, 16 * u, -8 * u, 6 * u)
      .lineTo(8 * u, 6 * u)
      .quadraticCurveTo(24 * u, 16 * u, 18 * u, 50 * u)
      .closePath()
      .fill(0xc8a76a);
    sk.rect(-9 * u, 8 * u, 18 * u, 5 * u).fill(MELA.vermilion);
    this.sack.addChild(sk);
    this.sack.position.set(w + 26 * u, trayTop + trayH - 52 * u);
    this.sack.scale.set(1.3);
    this.view.addChild(this.sack);
    this.level = capacity;
  }

  /** Show `fuel` bundles left; `reserve` true flashes the sack (partner tops up). */
  set(fuel: number, reserve: boolean): void {
    const n = Math.max(0, Math.min(this.capacity, Math.round(fuel)));
    this.bundles.forEach((b, i) => {
      const on = i < n;
      const was = i < this.level;
      if (on === was) return;
      gsap.to(b, { alpha: on ? 1 : 0.18, duration: 0.3 });
      gsap.fromTo(b.scale, { x: 1.2, y: 0.8 }, { x: 1, y: 1, duration: 0.3, ease: 'back.out(3)' });
    });
    this.level = n;
    if (reserve) {
      gsap.fromTo(
        this.sack.scale,
        { x: 1, y: 1 },
        { x: 1.25, y: 1.25, duration: 0.2, yoyo: true, repeat: 1 },
      );
      this.art.burst(
        this.view,
        'sparkle',
        { x: this.sack.x, y: this.sack.y + 20 * this.art.unit },
        10,
        1500,
      );
    }
  }

  /** Refill (new map). */
  reset(): void {
    this.level = this.capacity;
    for (const b of this.bundles) {
      gsap.killTweensOf(b);
      b.alpha = 1;
    }
  }

  destroy(): void {
    for (const b of this.bundles) {
      gsap.killTweensOf(b);
      gsap.killTweensOf(b.scale);
    }
    gsap.killTweensOf(this.sack.scale);
    this.view.destroy({ children: true });
  }
}

/** The rest cot (flooded river fallback). */
export class RestCot {
  readonly view = new Container();
  private readonly glow: Sprite;
  private t = 0;
  private readonly tick = (): void => {
    this.t += Math.min(0.05, this.art.ticker.deltaMS / 1000);
    this.glow.alpha = 0.3 + 0.14 * Math.sin(this.t * 2.1) * this.art.motion;
  };
  readonly size: number;

  constructor(private readonly art: EpisodeArt) {
    this.view.label = 'rest-cot';
    this.view.eventMode = 'none';
    this.size = Math.max(art.mm(30), 150 * art.unit);
    this.glow = art.glow(this.size * 0.9, 0xfff0c0, 0);
    this.glow.y = -this.size * 0.2;
    this.view.addChild(this.glow, drawCharpai(this.size));
    art.ticker.add(this.tick);
  }

  /** Target rectangle given the cot's stage position (origin at its feet). */
  rect(): Rect {
    const s = this.size;
    return {
      x: this.view.x - s * 0.62,
      y: this.view.y - s * 0.62,
      width: s * 1.24,
      height: s * 0.72,
    };
  }

  /** Brighter invitation once the partner suggests resting (cap reached). */
  invite(): void {
    gsap.fromTo(
      this.view.scale,
      { x: 1, y: 1 },
      { x: 1.12, y: 1.12, duration: 0.4, yoyo: true, repeat: 1 },
    );
  }

  destroy(): void {
    this.art.ticker.remove(this.tick);
    gsap.killTweensOf(this.view.scale);
    this.view.destroy({ children: true });
  }
}

/** Round replay button (instruction replay). */
export function createReplayButton(art: EpisodeArt): IconButton {
  return new IconButton({
    spec: {
      id: 'road_home.replay',
      iconId: 'replay',
      audioKey: 'road_home.replay',
      variant: 'replay',
      sizeMm: 22,
    },
    metrics: {
      pxPerMm: art.pxPerMm,
      minTargetPx: Math.ceil(20 * art.pxPerMm),
      minSpacingPx: Math.ceil(8 * art.pxPerMm),
    },
    reducedMotion: art.reducedMotion,
  });
}

/** Confirm tick for the fodder round. */
export function createConfirmButton(art: EpisodeArt): IconButton {
  return new IconButton({
    spec: {
      id: 'road_home.fuel.confirm',
      iconId: 'tick',
      audioKey: 'road_home.replay',
      variant: 'confirm',
      sizeMm: 24,
    },
    metrics: {
      pxPerMm: art.pxPerMm,
      minTargetPx: Math.ceil(20 * art.pxPerMm),
      minSpacingPx: Math.ceil(8 * art.pxPerMm),
    },
    reducedMotion: art.reducedMotion,
  });
}
