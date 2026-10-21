/**
 * Coins as pictured quantities (ENG-11: no numerals). A stack, a row and a scattered pile, each made of
 * countable brass coins so amounts can be compared by eye and spoken by pre-recorded voice.
 */
import { Container, Graphics } from 'pixi.js';
import { darken } from '../color.ts';
import { softShadow } from '../draw.ts';
import { MELA } from '../palettes.ts';
import { ArtRandom } from '../rand.ts';
import { drawGood } from './goods.ts';

/** Vertical stack of `count` coins (origin at the base). */
export function createCoinStack(count: number, s = 1.6): Container {
  const c = new Container();
  c.label = `coins:stack:${count}`;
  const g = new Graphics();
  const n = Math.max(0, Math.floor(count));
  if (n > 0) softShadow(g, 0, 0, 13 * s, 3.5 * s, MELA.ink, 0.3);
  for (let i = 0; i < n; i++)
    drawGood(g, 'coin', ((i * 37) % 5) * 0.25 * s - 0.5 * s, -i * 2.6 * s, s);
  c.addChild(g);
  return c;
}

/** A row of coins lying flat (easy to count at a glance). */
export function createCoinRow(count: number, s = 1.6): Container {
  const c = new Container();
  c.label = `coins:row:${count}`;
  const g = new Graphics();
  const n = Math.max(0, Math.floor(count));
  const gap = 16 * s;
  for (let i = 0; i < n; i++) {
    const x = (i - (n - 1) / 2) * gap;
    softShadow(g, x, 0, 8 * s, 2.5 * s, MELA.ink, 0.25);
    drawGood(g, 'coin', x, 0, s);
  }
  c.addChild(g);
  return c;
}

/** A loose heap of coins (seeded scatter), denser for larger counts. */
export function createCoinPile(count: number, s = 1.6, seed = 3): Container {
  const c = new Container();
  c.label = `coins:pile:${count}`;
  const g = new Graphics();
  const n = Math.max(0, Math.floor(count));
  const rnd = new ArtRandom(seed + n);
  const radius = (6 + Math.sqrt(n) * 6) * s;
  if (n > 0) softShadow(g, 0, 0, radius + 6 * s, 5 * s, MELA.ink, 0.28);
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = rnd.range(0, Math.PI * 2);
    const r = Math.sqrt(rnd.next()) * radius;
    const heap = (1 - r / Math.max(1, radius)) * Math.sqrt(n) * 2.4 * s;
    pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r * 0.3 - heap });
  }
  pts.sort((p, q) => p.y - q.y);
  for (const p of pts.reverse()) drawGood(g, 'coin', p.x, p.y, s);
  // A few coins standing on edge glint.
  for (let i = 0; i < Math.min(3, Math.floor(n / 6)); i++) {
    const x = rnd.range(-radius * 0.6, radius * 0.6);
    g.ellipse(x, -4 * s, 2 * s, 6 * s).fill(MELA.brass);
    g.ellipse(x, -4 * s, 2 * s, 6 * s).stroke({ width: 0.8, color: darken(MELA.brass, 0.3) });
  }
  c.addChild(g);
  return c;
}
