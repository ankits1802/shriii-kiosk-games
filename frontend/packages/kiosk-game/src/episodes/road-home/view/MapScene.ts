/**
 * The illustrated village map (errand maps, the fallen tree, the flooded river). Top-down terrain
 * with oblique storybook places, dirt roads whose fodder cost is pictured as little hay bundles
 * along each road, plank bridges where roads cross the river, and the cart token that rolls from
 * waypoint to waypoint. Light follows the story clock (map tint + untinted window glows and
 * fireflies at night). In portrait the map is transposed so the same graph fills a tall screen;
 * the measured graph never changes with orientation.
 */
import { gsap } from 'gsap';
import { Container, Graphics, type Sprite } from 'pixi.js';
import { darken, lighten, mixColor } from '../../../art/color.ts';
import { softShadow, vgrad } from '../../../art/draw.ts';
import { MELA } from '../../../art/palettes.ts';
import { ArtRandom } from '../../../art/rand.ts';
import type { Point, Rect } from '../../../core/contracts.ts';
import { edgeKey } from '../../../paradigms/route-planning.ts';
import type { BlockedEvent, RoadMap } from '../maps.ts';
import type { EpisodeArt } from './art.ts';
import type { RoadPalette } from './palette.ts';
import {
  drawBoat,
  drawBridge,
  drawCartToken,
  drawErrandPicture,
  drawFallenTree,
  drawPlace,
  ERRAND_PICTURES,
} from './places.ts';
import { drawBundle } from './stops.ts';

interface Road {
  readonly a: Point;
  readonly b: Point;
  readonly c: Point;
}

function bezier(r: Road, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * r.a.x + 2 * u * t * r.c.x + t * t * r.b.x,
    y: u * u * r.a.y + 2 * u * t * r.c.y + t * t * r.b.y,
  };
}

function tangent(r: Road, t: number): number {
  const u = 1 - t;
  const dx = 2 * u * (r.c.x - r.a.x) + 2 * t * (r.b.x - r.c.x);
  const dy = 2 * u * (r.c.y - r.a.y) + 2 * t * (r.b.y - r.c.y);
  return Math.atan2(dy, dx);
}

interface Ring {
  readonly node: string;
  readonly glow: Sprite;
  readonly ring: Graphics;
}

export class MapScene {
  readonly view = new Container();
  private readonly terrain = new Container();
  private readonly lights = new Container();
  private readonly overlay = new Container();
  private readonly rings = new Container();
  private readonly tokenLayer = new Container();
  private readonly fx = new Container();
  private readonly flies: { s: Sprite; x: number; y: number; ph: number }[] = [];
  private readonly lamps: Sprite[] = [];
  private readonly bubbles = new Map<string, Container>();
  private readonly ringList: Ring[] = [];
  private map: RoadMap | null = null;
  private roads = new Map<string, Road>();
  private nodes = new Map<string, Point>();
  private token: Container | null = null;
  private boat: Container | null = null;
  private queue: Promise<void> = Promise.resolve();
  private palette: RoadPalette | null = null;
  private t = 0;
  private hurry = false;
  area: Rect = { x: 0, y: 0, width: 1, height: 1 };
  private placeSize = 100;
  private waterG: Graphics | null = null;

  constructor(private readonly art: EpisodeArt) {
    this.view.label = 'map';
    this.view.eventMode = 'none';
    this.view.addChild(
      this.terrain,
      this.lights,
      this.overlay,
      this.rings,
      this.tokenLayer,
      this.fx,
    );
  }

  setHurry(h: boolean): void {
    this.hurry = h;
  }

  /** Screen point of a node. */
  pos(node: string): Point {
    return this.nodes.get(node) ?? { x: this.area.x, y: this.area.y };
  }

  private toScreen(nx: number, ny: number): Point {
    const a = this.area;
    return this.art.portrait
      ? { x: a.x + ny * a.width, y: a.y + nx * a.height }
      : { x: a.x + nx * a.width, y: a.y + ny * a.height };
  }

  /** Build the whole map. */
  build(map: RoadMap, seed: string): void {
    this.clear();
    this.map = map;
    const { w, h } = this.art;
    const portrait = this.art.portrait;
    // Keep the top row of waypoint targets (22 mm) clear of the replay button (22 mm, 5 mm inset)
    // by the 8 mm spacing rule on any panel size: 5 + 22 + 8 + 11 = 46 mm to a node centre.
    const top = Math.max(h * (portrait ? 0.14 : 0.18), this.art.mm(46));
    this.area = portrait
      ? { x: w * 0.07, y: top, width: w * 0.86, height: h - top - h * 0.06 }
      : { x: w * 0.06, y: top, width: w * 0.88, height: h - top - h * 0.05 };
    const cellW = (portrait ? this.area.height : this.area.width) / Math.max(1, map.cols);
    const cellH = (portrait ? this.area.width : this.area.height) / Math.max(1, map.rows);
    this.placeSize = Math.min(cellW, cellH * 1.4) * 0.38;
    for (const n of map.nodes) {
      const p = map.positions[n] ?? { x: 0.5, y: 0.5 };
      this.nodes.set(n, this.toScreen(p.x, p.y));
    }
    const rnd = new ArtRandom(seed);
    for (const e of map.edges) {
      const a = this.pos(e.a);
      const b = this.pos(e.b);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const bend = rnd.range(-0.12, 0.12) * len;
      const nx = -(b.y - a.y) / (len || 1);
      const ny = (b.x - a.x) / (len || 1);
      this.roads.set(edgeKey(e.a, e.b), { a, b, c: { x: mx + nx * bend, y: my + ny * bend } });
    }
    this.drawGround(rnd);
    this.drawRiver(map, rnd);
    this.drawFields(map, rnd);
    this.drawRoads(map);
    this.drawBridges(map);
    this.drawTrees(map, rnd);
    this.drawPlaces(map);
    this.buildFlies(rnd);
    this.token = drawCartToken(this.placeSize * 0.82);
    const s = this.pos(map.start);
    this.token.position.set(s.x, s.y);
    this.tokenLayer.addChild(this.token);
    if (this.palette) this.apply(this.palette);
  }

  private clear(): void {
    gsap.killTweensOf(this.token ?? {});
    for (const c of [
      this.terrain,
      this.lights,
      this.overlay,
      this.rings,
      this.tokenLayer,
      this.fx,
    ]) {
      for (const ch of c.removeChildren()) ch.destroy({ children: true });
    }
    this.flies.length = 0;
    this.lamps.length = 0;
    this.bubbles.clear();
    this.ringList.length = 0;
    this.roads = new Map();
    this.nodes = new Map();
    this.token = null;
    this.boat = null;
    this.waterG = null;
    this.swollen = false;
    this.queue = Promise.resolve();
  }

  private drawGround(rnd: ArtRandom): void {
    const { w, h, unit: u } = this.art;
    const g = new Graphics();
    g.rect(0, 0, w, h).fill(
      vgrad([
        [0, 0xbccd7e],
        [0.5, 0xadc26e],
        [1, 0x9cb563],
      ]),
    );
    // Painterly patches.
    for (let i = 0; i < 70; i += 1) {
      const x = rnd.range(0, w);
      const y = rnd.range(0, h);
      const r = rnd.range(40, 140) * u;
      g.ellipse(x, y, r, r * rnd.range(0.5, 0.9)).fill({
        color: rnd.chance(0.5) ? 0xd8dc96 : 0x8fae5a,
        alpha: 0.35,
      });
    }
    // A soft parchment vignette frames the storybook map.
    for (let i = 0; i < 5; i += 1) {
      const inset = i * 7 * u;
      g.rect(inset, inset, w - 2 * inset, h - 2 * inset).stroke({
        width: 8 * u,
        color: 0x8a7a4a,
        alpha: 0.11 - i * 0.02,
      });
    }
    this.terrain.addChild(g);
  }

  private riverY(map: RoadMap, nx: number): number {
    const base = (map.riverRow + 1) / Math.max(1, map.rows) - 0.05;
    return base + Math.sin(nx * Math.PI * 2.2 + map.rows) * 0.025;
  }

  private drawRiver(map: RoadMap, rnd: ArtRandom): void {
    if (map.riverRow < 0) return;
    const u = this.art.unit;
    const pts: Point[] = [];
    for (let i = 0; i <= 48; i += 1) {
      const nx = -0.05 + (i / 48) * 1.1;
      pts.push(this.toScreen(nx, this.riverY(map, nx)));
    }
    const width = Math.min(this.area.width, this.area.height) * 0.07;
    const bank = new Graphics();
    const water = new Graphics();
    const shine = new Graphics();
    const stroke = (g: Graphics, wd: number, color: number, alpha = 1): void => {
      const [p0, ...rest] = pts;
      if (!p0) return;
      g.moveTo(p0.x, p0.y);
      for (const p of rest) g.lineTo(p.x, p.y);
      g.stroke({ width: wd, color, alpha, cap: 'round', join: 'round' });
    };
    stroke(bank, width * 1.5, 0xd8c69a);
    stroke(bank, width * 1.25, 0x9aa25a, 0.5);
    stroke(water, width, 0xffffff);
    stroke(shine, width * 0.25, 0xffffff, 0.35);
    this.terrain.addChild(bank, water, shine);
    water.label = 'river-water';
    shine.label = 'river-shine';
    // Reeds along the banks.
    const reeds = new Graphics();
    for (let i = 0; i < 40; i += 1) {
      const p = pts[rnd.int(0, pts.length - 1)];
      if (!p) continue;
      const side = rnd.chance(0.5) ? 1 : -1;
      const x = p.x + rnd.range(-10, 10) * u;
      const y = p.y + side * width * 0.62;
      reeds
        .moveTo(x, y)
        .lineTo(x + rnd.range(-3, 3) * u, y - 12 * u)
        .stroke({ width: 1.6 * u, color: 0x5f7a3a });
    }
    this.terrain.addChild(reeds);
    this.waterG = water;
  }

  private drawFields(map: RoadMap, rnd: ArtRandom): void {
    const g = new Graphics();
    const occupied = new Set(map.nodes.map((n) => `${map.cells[n]?.col},${map.cells[n]?.row}`));
    for (let r = 0; r < map.rows; r += 1) {
      for (let c = 0; c < map.cols; c += 1) {
        const free = !occupied.has(`${c},${r}`);
        const n = free ? 3 : 1;
        for (let k = 0; k < n; k += 1) {
          const nx = (c + rnd.range(0.15, 0.85)) / map.cols;
          const ny = (r + rnd.range(free ? 0.2 : 0.62, free ? 0.8 : 0.85)) / map.rows;
          if (map.riverRow >= 0 && Math.abs(ny - this.riverY(map, nx)) < 0.07) continue;
          const p = this.toScreen(nx, ny);
          const fw = this.placeSize * rnd.range(0.7, 1.3);
          const fh = fw * rnd.range(0.45, 0.7);
          const col = rnd.pick([0xd8b85a, 0x8fae4e, 0xc9a24a, 0x7fa04a, 0xb8c46a, 0xe0c67a]);
          const rot = rnd.range(-0.25, 0.25);
          const f = new Graphics();
          f.roundRect(-fw / 2, -fh / 2, fw, fh, fh * 0.18).fill(col);
          for (let i = 1; i < 6; i += 1) {
            const yy = -fh / 2 + (fh * i) / 6;
            f.moveTo(-fw * 0.46, yy)
              .lineTo(fw * 0.46, yy)
              .stroke({ width: Math.max(1, fh * 0.035), color: darken(col, 0.22), alpha: 0.55 });
          }
          f.roundRect(-fw / 2, -fh / 2, fw, fh, fh * 0.18).stroke({
            width: 2,
            color: darken(col, 0.3),
            alpha: 0.5,
          });
          f.position.set(p.x, p.y);
          f.rotation = rot;
          g.addChild(f);
        }
      }
    }
    this.terrain.addChild(g);
  }

  private drawRoads(map: RoadMap): void {
    const u = this.art.unit;
    const edges = new Graphics();
    const fill = new Graphics();
    const width = Math.max(14 * u, this.placeSize * 0.17);
    for (const e of map.edges) {
      const r = this.roads.get(edgeKey(e.a, e.b));
      if (!r) continue;
      edges
        .moveTo(r.a.x, r.a.y)
        .quadraticCurveTo(r.c.x, r.c.y, r.b.x, r.b.y)
        .stroke({ width: width * 1.35, color: 0x9a7a4e, cap: 'round' });
      fill
        .moveTo(r.a.x, r.a.y)
        .quadraticCurveTo(r.c.x, r.c.y, r.b.x, r.b.y)
        .stroke({ width, color: 0xe6cfa0, cap: 'round' });
      fill
        .moveTo(r.a.x, r.a.y)
        .quadraticCurveTo(r.c.x, r.c.y, r.b.x, r.b.y)
        .stroke({ width: width * 0.12, color: 0xc8aa78, alpha: 0.6, cap: 'round' });
    }
    this.terrain.addChild(edges, fill);
    // Pictured fodder cost: one little hay bundle per fodder unit, along the middle of the road.
    const pips = new Container();
    for (const e of map.edges) {
      const r = this.roads.get(edgeKey(e.a, e.b));
      if (!r) continue;
      const step = 0.13;
      for (let k = 0; k < e.cost; k += 1) {
        const t = 0.5 + (k - (e.cost - 1) / 2) * step;
        const p = bezier(r, t);
        const b = drawBundle(Math.max(0.36, this.placeSize / 260));
        b.position.set(p.x, p.y + 8 * u);
        pips.addChild(b);
      }
    }
    this.terrain.addChild(pips);
  }

  private drawBridges(map: RoadMap): void {
    if (map.riverRow < 0) return;
    const width = Math.max(14 * this.art.unit, this.placeSize * 0.2);
    for (const k of map.bridges) {
      const r = this.roads.get(k);
      if (!r) continue;
      // Find where the road crosses the river (the t whose y is closest to the river line).
      let best = 0.5;
      let bestD = Number.POSITIVE_INFINITY;
      for (let i = 1; i < 40; i += 1) {
        const t = i / 40;
        const p = bezier(r, t);
        const n = this.fromScreen(p);
        const d = Math.abs(n.y - this.riverY(map, n.x));
        if (d < bestD) {
          bestD = d;
          best = t;
        }
      }
      const p = bezier(r, best);
      const bridge = drawBridge(Math.min(this.area.width, this.area.height) * 0.14, width);
      bridge.position.set(p.x, p.y);
      bridge.rotation = tangent(r, best);
      bridge.label = `bridge:${k}`;
      this.terrain.addChild(bridge);
    }
  }

  private fromScreen(p: Point): { x: number; y: number } {
    const a = this.area;
    const fx = (p.x - a.x) / a.width;
    const fy = (p.y - a.y) / a.height;
    return this.art.portrait ? { x: fy, y: fx } : { x: fx, y: fy };
  }

  private drawTrees(map: RoadMap, rnd: ArtRandom): void {
    const g = new Graphics();
    const near = (p: Point): boolean => {
      for (const n of this.nodes.values())
        if (Math.hypot(n.x - p.x, n.y - p.y) < this.placeSize * 0.95) return true;
      for (const r of this.roads.values()) {
        for (let i = 0; i <= 10; i += 1) {
          const q = bezier(r, i / 10);
          if (Math.hypot(q.x - p.x, q.y - p.y) < this.placeSize * 0.35) return true;
        }
      }
      return false;
    };
    for (let i = 0; i < 46; i += 1) {
      const p = { x: rnd.range(0, this.art.w), y: rnd.range(this.area.y - 20, this.art.h) };
      if (near(p)) continue;
      const n = this.fromScreen(p);
      if (map.riverRow >= 0 && Math.abs(n.y - this.riverY(map, n.x)) < 0.06) continue;
      const r = this.placeSize * rnd.range(0.16, 0.26);
      softShadow(g, p.x + r * 0.4, p.y + r * 0.3, r * 1.1, r * 0.7, MELA.ink, 0.28);
      const base = rnd.pick([MELA.neem, MELA.banyan, MELA.mango, 0x5f8a3a]);
      for (let k = 0; k < 5; k += 1) {
        const a = rnd.range(0, Math.PI * 2);
        const d = rnd.range(0, r * 0.4);
        g.circle(p.x + Math.cos(a) * d, p.y + Math.sin(a) * d, r * rnd.range(0.55, 0.75)).fill(
          darken(base, rnd.range(0, 0.2)),
        );
      }
      g.circle(p.x - r * 0.25, p.y - r * 0.25, r * 0.38).fill({
        color: lighten(base, 0.25),
        alpha: 0.55,
      });
    }
    this.terrain.addChild(g);
  }

  private drawPlaces(map: RoadMap): void {
    const s = this.placeSize;
    const u = this.art.unit;
    const errandAt = new Map(map.errands.map((e, i) => [e.node, i] as const));
    // Draw places in screen-y order so nearer places overlap farther ones.
    const order = [...map.nodes].sort((a, b) => this.pos(a).y - this.pos(b).y);
    for (const n of order) {
      const p = this.pos(n);
      const kind = map.places[n] ?? 'hamlet';
      // Waypoint: a whitewashed stepping stone where the cart stops.
      const stone = new Graphics();
      const r = Math.max(this.art.mm(6.5), s * 0.15);
      softShadow(stone, p.x + r * 0.15, p.y + r * 0.3, r * 1.25, r * 0.55, MELA.ink, 0.3);
      stone.ellipse(p.x, p.y, r, r * 0.62).fill(
        vgrad([
          [0, 0xf8f2e2],
          [1, 0xd8cdb6],
        ]),
      );
      stone.ellipse(p.x, p.y, r, r * 0.62).stroke({ width: 2 * u, color: 0xa89a7e });
      stone.ellipse(p.x, p.y - r * 0.08, r * 0.55, r * 0.3).fill({ color: 0xffffff, alpha: 0.5 });
      this.terrain.addChild(stone);
      const place = drawPlace(kind, s, n.length * 13 + (map.places[n]?.length ?? 0));
      place.position.set(p.x, p.y - r * 0.55);
      this.terrain.addChild(place);
      // Night lights at homes, hamlets, temples and the market.
      if (
        kind === 'home' ||
        kind === 'hamlet' ||
        kind === 'market' ||
        kind === 'temple' ||
        kind === 'tea_stall'
      ) {
        const lamp = this.art.glow(s * 0.55, 0xffb04a, 0);
        lamp.position.set(p.x, p.y - s * 0.55);
        this.lights.addChild(lamp);
        this.lamps.push(lamp);
      }
      const ei = errandAt.get(n);
      if (ei !== undefined) {
        const bubble = new Container();
        const plate = new Graphics();
        const br = Math.max(this.art.mm(5), s * 0.2);
        plate.circle(0, 0, br * 1.1).fill({ color: MELA.ink, alpha: 0.18 });
        plate.circle(0, -2 * u, br).fill(MELA.cream);
        plate.circle(0, -2 * u, br).stroke({ width: 3 * u, color: MELA.marigold });
        plate.poly([-br * 0.3, br * 0.82, br * 0.3, br * 0.82, 0, br * 1.3]).fill(MELA.cream);
        bubble.addChild(plate);
        const pic = drawErrandPicture(ERRAND_PICTURES[ei] ?? 'pot', br * 1.5);
        pic.y = -2 * u;
        bubble.addChild(pic);
        bubble.position.set(p.x + s * 0.42, p.y - s * 1.05);
        this.overlay.addChild(bubble);
        this.bubbles.set(n, bubble);
      }
    }
  }

  private buildFlies(rnd: ArtRandom): void {
    const n = Math.round(30 * Math.max(0.3, this.art.profile.particleScale));
    for (let i = 0; i < n; i += 1) {
      const s = this.art.glow(8 * this.art.unit, 0xd8ff7a, 0);
      this.lights.addChild(s);
      this.flies.push({
        s,
        x: rnd.range(0, this.art.w),
        y: rnd.range(this.area.y, this.art.h),
        ph: rnd.range(0, 6.3),
      });
    }
  }

  /** Dotted cart tracks along the usual way (before a block). */
  showUsualWay(path: readonly string[]): void {
    const u = this.art.unit;
    const g = new Graphics();
    g.label = 'usual-way';
    for (let i = 0; i + 1 < path.length; i += 1) {
      const r = this.roads.get(edgeKey(path[i] as string, path[i + 1] as string));
      if (!r) continue;
      const forward =
        r.a.x === this.pos(path[i] as string).x && r.a.y === this.pos(path[i] as string).y;
      for (let k = 1; k < 12; k += 1) {
        const t = forward ? k / 12 : 1 - k / 12;
        const p = bezier(r, t);
        const a = tangent(r, t) + Math.PI / 2;
        for (const side of [-1, 1]) {
          g.circle(
            p.x + Math.cos(a) * side * 5 * u,
            p.y + Math.sin(a) * side * 5 * u,
            2.3 * u,
          ).fill({ color: 0x6a4a2a, alpha: 0.55 });
        }
      }
    }
    this.overlay.addChildAt(g, 0);
  }

  /** The block appears (onset): a fallen tree across the road, or every bridge under water. */
  revealBlock(event: BlockedEvent): void {
    const u = this.art.unit;
    for (const k of event.blockedEdges) {
      const r = this.roads.get(k);
      if (!r) continue;
      if (event.kind === 'fallen_tree') {
        const p = bezier(r, 0.5);
        const tree = drawFallenTree(this.placeSize * 0.95);
        tree.position.set(p.x, p.y);
        tree.rotation = tangent(r, 0.5) + Math.PI / 2;
        this.overlay.addChild(tree);
        this.art.burst(this.fx, 'leaves', p, 14, 2500);
        this.art.burst(this.fx, 'dust', p, 16, 2000);
      } else {
        if (!this.swollen) this.swellRiver();
        const bridge = this.terrain.children.find((c) => c.label === `bridge:${k}`);
        const at = bridge ? { x: bridge.x, y: bridge.y } : bezier(r, 0.5);
        const g = new Graphics();
        // Water pours over the planks: a churning pool with foam curls.
        const len = Math.min(this.area.width, this.area.height) * 0.17;
        g.ellipse(0, 0, len * 0.62, len * 0.3).fill({ color: 0x3f6aa0, alpha: 0.75 });
        g.ellipse(0, 0, len * 0.46, len * 0.22).fill({ color: 0x6f9ed0, alpha: 0.8 });
        for (let i = 0; i < 7; i += 1) {
          const a = (i / 7) * Math.PI * 2;
          const fx = Math.cos(a) * len * 0.36;
          const fy = Math.sin(a) * len * 0.17;
          g.moveTo(fx - 9 * u, fy)
            .quadraticCurveTo(fx, fy - 9 * u, fx + 9 * u, fy)
            .stroke({ width: 3.2 * u, color: 0xffffff, alpha: 0.9, cap: 'round' });
        }
        g.position.set(at.x, at.y);
        this.overlay.addChild(g);
        this.art.burst(this.fx, 'sparkle', at, 8, 1500);
      }
    }
  }

  private swollen = false;

  /** The river swells: a wider, brighter flood band with foam along its length. */
  private swellRiver(): void {
    const map = this.map;
    if (!map || map.riverRow < 0) return;
    this.swollen = true;
    const u = this.art.unit;
    const pts: Point[] = [];
    for (let i = 0; i <= 48; i += 1) {
      const nx = -0.05 + (i / 48) * 1.1;
      pts.push(this.toScreen(nx, this.riverY(map, nx)));
    }
    const width = Math.min(this.area.width, this.area.height) * 0.11;
    const g = new Graphics();
    const [p0, ...rest] = pts;
    if (!p0) return;
    g.moveTo(p0.x, p0.y);
    for (const p of rest) g.lineTo(p.x, p.y);
    g.stroke({ width, color: 0x5a86bc, alpha: 0.55, cap: 'round', join: 'round' });
    for (let i = 2; i < pts.length - 1; i += 3) {
      const p = pts[i] as Point;
      const side = i % 2 ? 1 : -1;
      const y = p.y + side * width * 0.32;
      g.moveTo(p.x - 10 * u, y)
        .quadraticCurveTo(p.x, y - 6 * u, p.x + 10 * u, y)
        .stroke({ width: 2.4 * u, color: 0xffffff, alpha: 0.75, cap: 'round' });
    }
    this.overlay.addChildAt(g, 0);
  }

  /** Glowing rings on the waypoints the player can tap now. */
  setReachable(nodes: readonly string[]): void {
    this.clearReachable();
    const u = this.art.unit;
    for (const n of nodes) {
      const p = this.pos(n);
      const r = Math.max(this.art.mm(9), this.placeSize * 0.22);
      const glow = this.art.glow(r * 2.2, 0xfff2b0, 0.45);
      glow.position.set(p.x, p.y);
      const ring = new Graphics();
      ring.ellipse(0, 0, r, r * 0.66).stroke({ width: 4 * u, color: 0xfff6d8, alpha: 0.95 });
      ring.ellipse(0, 0, r * 1.18, r * 0.78).stroke({ width: 2 * u, color: 0xfff6d8, alpha: 0.45 });
      ring.position.set(p.x, p.y);
      this.rings.addChild(glow, ring);
      this.ringList.push({ node: n, glow, ring });
    }
  }

  clearReachable(): void {
    for (const r of this.ringList) {
      r.glow.destroy();
      r.ring.destroy();
    }
    this.ringList.length = 0;
  }

  /** Brief brighter pulse on every reachable ring (the step window passed). */
  nudge(): void {
    for (const r of this.ringList) {
      gsap.fromTo(
        r.ring.scale,
        { x: 1, y: 1 },
        { x: 1.18, y: 1.18, duration: 0.35, yoyo: true, repeat: 1, ease: 'sine.inOut' },
      );
    }
  }

  /** Touch ripple at a stage point. */
  ripple(p: Point): void {
    const u = this.art.unit;
    const g = new Graphics();
    g.circle(0, 0, 30 * u).stroke({ width: 4 * u, color: 0xffffff, alpha: 0.9 });
    g.position.set(p.x, p.y);
    this.fx.addChild(g);
    gsap.to(g.scale, { x: 2, y: 2, duration: 0.45, ease: 'power2.out' });
    gsap.to(g, { alpha: 0, duration: 0.45, onComplete: () => g.destroy() });
  }

  /**
   * Animate the cart over one road (queued after earlier moves). A blocked attempt rolls towards the
   * obstacle and bounces back. `ferry` crosses the water by boat.
   */
  move(
    from: string,
    to: string,
    opts: { readonly blocked: boolean; readonly ferry: boolean; readonly durationMs: number },
  ): Promise<void> {
    const run = async (): Promise<void> => {
      const token = this.token;
      if (!token) return;
      const a = this.pos(from);
      const b = this.pos(to);
      const k = edgeKey(from, to);
      const road: Road = this.roads.get(k) ?? {
        a,
        b,
        c: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      };
      const forward = Math.hypot(road.a.x - a.x, road.a.y - a.y) < 1;
      const dur = (opts.durationMs / 1000) * (this.hurry ? 0.6 : 1);
      if (opts.ferry) {
        this.boat ??= drawBoat(this.placeSize * 0.8);
        this.tokenLayer.addChildAt(this.boat, 0);
        this.boat.position.set(a.x, a.y);
        this.boat.rotation = Math.atan2(b.y - a.y, b.x - a.x);
      }
      const state = { t: 0 };
      const span = opts.blocked ? 0.34 : 1;
      await new Promise<void>((resolve) => {
        gsap.to(state, {
          t: span,
          duration: opts.blocked ? dur * 0.45 : dur,
          ease: opts.blocked ? 'power2.out' : 'sine.inOut',
          onUpdate: () => {
            const tt = forward ? state.t : 1 - state.t;
            const p = opts.ferry
              ? { x: a.x + (b.x - a.x) * state.t, y: a.y + (b.y - a.y) * state.t }
              : bezier(road, tt);
            token.position.set(p.x, p.y);
            token.rotation = opts.ferry
              ? Math.atan2(b.y - a.y, b.x - a.x)
              : tangent(road, tt) + (forward ? 0 : Math.PI);
            if (this.boat && opts.ferry) this.boat.position.set(p.x, p.y);
          },
          onComplete: () => resolve(),
          onInterrupt: () => resolve(),
        });
      });
      if (opts.blocked) {
        const hit = bezier(road, forward ? 0.34 : 0.66);
        this.art.burst(this.fx, 'dust', hit, 10, 1500);
        gsap.fromTo(
          token.scale,
          { x: 1.12, y: 0.9 },
          { x: 1, y: 1, duration: 0.3, ease: 'elastic.out(1, 0.4)' },
        );
        await new Promise<void>((resolve) => {
          gsap.to(state, {
            t: 0,
            duration: dur * 0.4,
            ease: 'power2.inOut',
            onUpdate: () => {
              const tt = forward ? state.t : 1 - state.t;
              const p = bezier(road, tt);
              token.position.set(p.x, p.y);
            },
            onComplete: () => resolve(),
            onInterrupt: () => resolve(),
          });
        });
      } else {
        // Squash on arrival.
        gsap.fromTo(
          token.scale,
          { x: 0.92, y: 1.08 },
          { x: 1, y: 1, duration: 0.25, ease: 'back.out(3)' },
        );
        if (opts.ferry && this.boat) gsap.to(this.boat, { alpha: 0, duration: 0.4, delay: 0.1 });
      }
    };
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  /** Wait for queued moves. */
  idle(): Promise<void> {
    return this.queue;
  }

  /** An errand is done at `node`: its picture leaves the bubble with a sparkle. */
  errandDone(node: string): void {
    const b = this.bubbles.get(node);
    const p = this.pos(node);
    this.art.burst(this.fx, 'sparkle', { x: p.x, y: p.y - this.placeSize * 0.5 }, 18, 1800);
    if (b) {
      gsap.to(b.scale, { x: 1.3, y: 1.3, duration: 0.18, yoyo: true, repeat: 1 });
      gsap.to(b, { alpha: 0, y: b.y - 30 * this.art.unit, duration: 0.5, delay: 0.3 });
    }
  }

  /** Arrival flourish at home. */
  arrive(node: string): void {
    const p = this.pos(node);
    this.art.burst(this.fx, 'petals', { x: p.x, y: p.y - this.placeSize * 0.6 }, 22, 2600);
  }

  /** The ferry is called: a boat glides to the ghat with a ripple trail. */
  callFerry(ghat: string, landing: string): void {
    const a = this.pos(ghat);
    const b = this.pos(landing);
    const u = this.art.unit;
    const g = new Graphics();
    const n = 10;
    for (let i = 1; i < n; i += 1) {
      const t = i / n;
      g.circle(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, 3 * u).fill({
        color: 0xffffff,
        alpha: 0.7,
      });
    }
    this.overlay.addChild(g);
    this.boat ??= drawBoat(this.placeSize * 0.8);
    this.boat.alpha = 0;
    this.boat.position.set(b.x, b.y);
    this.boat.rotation = Math.atan2(a.y - b.y, a.x - b.x);
    this.tokenLayer.addChildAt(this.boat, 0);
    gsap.to(this.boat, { alpha: 1, duration: 0.3 });
    gsap.to(this.boat, { x: a.x, y: a.y, duration: 1.0, ease: 'sine.inOut' });
  }

  /** Stage rectangle of a node's touch target (>= 24 mm). */
  targetRect(node: string): Rect {
    const p = this.pos(node);
    const s = Math.max(this.art.mm(24), this.placeSize * 0.62);
    return { x: p.x - s / 2, y: p.y - s / 2, width: s, height: s };
  }

  apply(p: RoadPalette): void {
    this.palette = p;
    this.terrain.tint = mixColor(p.mapTint, 0xffffff, 0.12);
    const water = this.waterG;
    if (water) water.tint = mixColor(p.water, p.waterLit, 0.18);
    for (const l of this.lamps) l.alpha = p.lights * 0.85;
  }

  update(dt: number): void {
    this.t += dt;
    const p = this.palette;
    const m = this.art.motion;
    for (const [i, r] of this.ringList.entries()) {
      r.glow.alpha = 0.32 + 0.16 * Math.sin(this.t * 2.4 + i) * m;
    }
    if (p) {
      const alpha = p.fireflies * p.night;
      for (const f of this.flies) {
        f.ph += dt;
        f.x += Math.sin(f.ph * 0.8) * 12 * dt * m;
        f.y += Math.cos(f.ph * 1.1) * 9 * dt * m;
        f.s.position.set(f.x, f.y);
        f.s.alpha = alpha * (0.2 + 0.8 * Math.max(0, Math.sin(f.ph * 1.6)));
      }
    }
  }

  destroy(): void {
    this.clear();
    this.view.destroy({ children: true });
  }
}
