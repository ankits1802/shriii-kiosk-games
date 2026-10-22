/**
 * Tower art: glazed clay pots (each colour carries its own band pattern: dots, stripes, zig-zag, so
 * colour is never the only cue), wooden pegs whose height shows their capacity (one carved seat per
 * pot that fits) and the goal picture painted on the potter's easel.
 */
import { Container, Graphics } from 'pixi.js';
import { darken, lighten } from '../../art/color.ts';
import { rgrad, vgrad } from '../../art/draw.ts';
import { MELA } from '../../art/palettes.ts';
import type { PotId, TowerState } from '../../paradigms/tower.ts';

export const POT_STYLE: Readonly<
  Record<PotId, { readonly glaze: number; readonly band: 'dots' | 'stripes' | 'zigzag' }>
> = {
  pot_red: { glaze: 0xc8432c, band: 'dots' },
  pot_green: { glaze: 0x3f8a4a, band: 'stripes' },
  pot_blue: { glaze: 0x2f5aa0, band: 'zigzag' },
};

/** A pot of height h whose base sits at (0, 0) (y up negative). */
export function drawPot(id: PotId, h: number): Container {
  const c = new Container();
  const g = new Graphics();
  const w = h * 1.2;
  const st = POT_STYLE[id];
  // Body.
  g.moveTo(-w * 0.28, -h)
    .lineTo(w * 0.28, -h)
    .lineTo(w * 0.22, -h * 0.86)
    .bezierCurveTo(w * 0.62, -h * 0.74, w * 0.6, -h * 0.08, w * 0.24, 0)
    .lineTo(-w * 0.24, 0)
    .bezierCurveTo(-w * 0.6, -h * 0.08, -w * 0.62, -h * 0.74, -w * 0.22, -h * 0.86)
    .closePath()
    .fill(
      rgrad(
        [
          [0, lighten(st.glaze, 0.35)],
          [0.6, st.glaze],
          [1, darken(st.glaze, 0.4)],
        ],
        { x: 0.36, y: 0.35 },
        0.75,
      ),
    );
  // Rim.
  g.ellipse(0, -h, w * 0.3, h * 0.07).fill(darken(st.glaze, 0.25));
  g.ellipse(0, -h, w * 0.22, h * 0.04).fill(darken(st.glaze, 0.55));
  // Cream band with the pot's own pattern.
  const by = -h * 0.5;
  g.moveTo(-w * 0.5, by)
    .quadraticCurveTo(0, by + h * 0.06, w * 0.5, by)
    .stroke({ width: h * 0.16, color: MELA.cream, alpha: 0.95 });
  const ink = darken(st.glaze, 0.2);
  if (st.band === 'dots') {
    for (let i = -3; i <= 3; i += 1)
      g.circle(i * w * 0.12, by + h * 0.01 * (3 - Math.abs(i)) * 0.6, h * 0.045).fill(ink);
  } else if (st.band === 'stripes') {
    for (let i = -4; i <= 4; i += 1) {
      g.moveTo(i * w * 0.1 - h * 0.03, by - h * 0.06)
        .lineTo(i * w * 0.1 + h * 0.03, by + h * 0.07)
        .stroke({ width: h * 0.035, color: ink });
    }
  } else {
    const pts: number[] = [];
    for (let i = 0; i <= 10; i += 1)
      pts.push(-w * 0.45 + (i / 10) * w * 0.9, by + (i % 2 ? h * 0.05 : -h * 0.05));
    g.poly(pts, false).stroke({ width: h * 0.035, color: ink });
  }
  // Highlight and foot shadow.
  g.ellipse(-w * 0.2, -h * 0.66, w * 0.08, h * 0.16).fill({ color: 0xffffff, alpha: 0.3 });
  c.addChild(g);
  return c;
}

/** A wooden peg on a brick plinth, with `capacity` carved seats; base centre at (0, 0). */
export function drawPeg(capacity: number, potH: number, plinthW: number): Container {
  const c = new Container();
  const g = new Graphics();
  // Plinth (terracotta bricks).
  const ph = potH * 0.3;
  g.roundRect(-plinthW / 2, 0, plinthW, ph, ph * 0.2).fill(
    vgrad([
      [0, lighten(MELA.terracotta, 0.15)],
      [1, darken(MELA.terracotta, 0.3)],
    ]),
  );
  for (let i = 1; i < 4; i += 1)
    g.rect(-plinthW / 2 + (i / 4) * plinthW, 0, 2, ph).fill({
      color: darken(MELA.terracotta, 0.45),
      alpha: 0.6,
    });
  g.rect(-plinthW / 2, ph * 0.5, plinthW, 2).fill({
    color: darken(MELA.terracotta, 0.45),
    alpha: 0.6,
  });
  // Pole: height shows how many pots fit.
  const poleH = potH * capacity + potH * 0.25;
  const pw = potH * 0.12;
  g.roundRect(-pw / 2, -poleH, pw, poleH, pw * 0.4).fill(
    vgrad([
      [0, lighten(MELA.wood, 0.35)],
      [1, MELA.woodDark],
    ]),
  );
  g.circle(0, -poleH, pw * 0.85).fill(MELA.brass);
  // Seats: one carved ring per pot that fits (faint, so capacity is readable without colour).
  for (let k = 0; k < capacity; k += 1) {
    const y = -potH * k - potH * 0.08;
    g.ellipse(0, y, potH * 0.55, potH * 0.12).stroke({
      width: Math.max(2, potH * 0.035),
      color: MELA.cream,
      alpha: 0.55,
    });
  }
  c.addChild(g);
  return c;
}

/** Goal picture: a small painted scene of pegs and pots on parchment (w x h, top-left origin). */
export function drawGoalPicture(
  state: TowerState,
  capacities: readonly number[],
  w: number,
  h: number,
): Container {
  const c = new Container();
  const g = new Graphics();
  // Easel board with a carved frame.
  g.roundRect(-w * 0.04, -h * 0.05, w * 1.08, h * 1.1, w * 0.04).fill(MELA.wood);
  g.roundRect(0, 0, w, h, w * 0.03).fill(
    vgrad([
      [0, 0xfffaee],
      [1, MELA.parchment],
    ]),
  );
  g.roundRect(w * 0.03, h * 0.04, w * 0.94, h * 0.92, w * 0.02).stroke({
    width: Math.max(2, w * 0.012),
    color: MELA.brass,
  });
  c.addChild(g);
  const potH = h * 0.2;
  const colW = w / 3;
  const baseY = h * 0.86;
  state.forEach((basket, i) => {
    const peg = drawPeg(capacities[i] ?? 3, potH, colW * 0.78);
    peg.position.set(colW * (i + 0.5), baseY);
    c.addChild(peg);
    basket.forEach((pot, k) => {
      const p = drawPot(pot, potH * 0.92);
      p.position.set(colW * (i + 0.5), baseY - potH * k);
      c.addChild(p);
    });
  });
  return c;
}
