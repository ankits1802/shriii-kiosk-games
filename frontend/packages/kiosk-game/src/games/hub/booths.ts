/**
 * Booth miniatures for the carousel fair map: one hand-drawn booth per Pathway B module, recognisable
 * by its centrepiece (the Don't-Tap fruit cart, the card tent, the balloon stall, the pot tower, the
 * share-circle banyan, and the four slot booths). No text or numerals (ENG-11).
 */
import { Container, Graphics } from 'pixi.js';
import { darken, lighten } from '../../art/color.ts';
import { rgrad, softShadow, vgrad } from '../../art/draw.ts';
import { MELA } from '../../art/palettes.ts';
import type { MicroGameId } from '../../core/contracts.ts';

/** Striped awning tent body shared by most booths; origin = ground centre, size = width. */
function tent(g: Graphics, s: number, a: number, b: number): void {
  softShadow(g, 0, 0, s * 0.62, s * 0.12, MELA.ink, 0.35);
  g.rect(-s * 0.42, -s * 0.55, s * 0.84, s * 0.55).fill(
    vgrad([
      [0, lighten(MELA.parchment, 0.1)],
      [1, darken(MELA.parchment, 0.2)],
    ]),
  );
  g.rect(-s * 0.16, -s * 0.38, s * 0.32, s * 0.38).fill(darken(MELA.wood, 0.25));
  // Scalloped striped roof.
  const n = 6;
  for (let i = 0; i < n; i++) {
    const x0 = -s * 0.5 + (i * s) / n;
    g.poly([x0, -s * 0.55, x0 + s / n, -s * 0.55, 0, -s * 0.98]).fill(i % 2 ? a : b);
    g.circle(x0 + s / (2 * n), -s * 0.53, s / (2 * n)).fill(i % 2 ? a : b);
  }
  g.moveTo(0, -s * 0.98)
    .lineTo(0, -s * 1.14)
    .stroke({ width: s * 0.025, color: MELA.woodDark });
  g.poly([0, -s * 1.14, s * 0.16, -s * 1.09, 0, -s * 1.04]).fill(MELA.vermilion);
}

function balloon(g: Graphics, x: number, y: number, r: number, c: number): void {
  g.moveTo(x, y + r)
    .lineTo(x - r * 0.2, y + r * 3)
    .stroke({ width: r * 0.08, color: MELA.ink, alpha: 0.6 });
  g.ellipse(x, y, r * 0.85, r).fill(
    rgrad(
      [
        [0, lighten(c, 0.45)],
        [1, darken(c, 0.15)],
      ],
      { x: 0.35, y: 0.3 },
      0.8,
    ),
  );
}

/** Draw the booth for a module; origin = ground centre; `s` = width in px. */
export function createBooth(id: MicroGameId, s: number): Container {
  const c = new Container();
  const g = new Graphics();
  switch (id) {
    case 'dont_tap': {
      // Fruit cart with a raised palm sign.
      softShadow(g, 0, 0, s * 0.55, s * 0.1, MELA.ink, 0.35);
      g.roundRect(-s * 0.45, -s * 0.42, s * 0.9, s * 0.3, s * 0.05).fill(MELA.wood);
      for (const x of [-0.3, 0.3])
        g.circle(s * x, -s * 0.08, s * 0.1)
          .fill(MELA.woodDark)
          .circle(s * x, -s * 0.08, s * 0.04)
          .fill(MELA.brass);
      for (let i = 0; i < 7; i++)
        g.circle(-s * 0.36 + i * s * 0.12, -s * 0.47, s * 0.06).fill(
          i % 2 ? MELA.mango : MELA.saffron,
        );
      g.moveTo(s * 0.38, -s * 0.42)
        .lineTo(s * 0.38, -s * 0.9)
        .stroke({ width: s * 0.03, color: MELA.woodDark });
      g.circle(s * 0.38, -s * 0.95, s * 0.12)
        .fill(MELA.cream)
        .circle(s * 0.38, -s * 0.95, s * 0.12)
        .stroke({ width: s * 0.02, color: MELA.vermilion });
      g.roundRect(s * 0.33, -s * 1.0, s * 0.1, s * 0.11, s * 0.03).fill(MELA.terracotta);
      break;
    }
    case 'card_sort': {
      tent(g, s, MELA.indigo, MELA.marigold);
      for (const [x, rot, col] of [
        [-0.12, -0.25, MELA.vermilion],
        [0.0, 0, MELA.peacock],
        [0.12, 0.25, MELA.marigold],
      ] as const) {
        const card = new Graphics();
        card
          .roundRect(-s * 0.07, -s * 0.1, s * 0.14, s * 0.2, s * 0.02)
          .fill(MELA.cream)
          .stroke({ width: s * 0.01, color: MELA.ink });
        card.circle(0, 0, s * 0.035).fill(col);
        card.position.set(s * x, -s * 0.72);
        card.rotation = rot;
        c.addChild(card);
      }
      break;
    }
    case 'balloon': {
      tent(g, s, MELA.rose, MELA.cream);
      balloon(g, -s * 0.32, -s * 1.2, s * 0.11, MELA.vermilion);
      balloon(g, -s * 0.14, -s * 1.32, s * 0.12, MELA.peacockLight);
      balloon(g, s * 0.06, -s * 1.25, s * 0.11, MELA.marigold);
      break;
    }
    case 'tower': {
      softShadow(g, 0, 0, s * 0.6, s * 0.1, MELA.ink, 0.35);
      for (const x of [-0.32, 0, 0.32]) {
        g.ellipse(s * x, -s * 0.12, s * 0.13, s * 0.05).fill(darken(0xc9954f, 0.3));
        g.moveTo(s * (x - 0.14), -s * 0.12)
          .quadraticCurveTo(s * x, s * 0.02, s * (x + 0.14), -s * 0.12)
          .fill(0xc9954f);
      }
      for (const [x, y, col] of [
        [-0.32, -0.2, MELA.terracotta],
        [-0.32, -0.36, MELA.vermilion],
        [0, -0.2, MELA.clay],
        [0.32, -0.2, MELA.terracotta],
        [0.32, -0.36, MELA.marigoldDeep],
        [0.32, -0.52, MELA.clay],
      ] as const) {
        g.ellipse(s * x, s * y, s * 0.09, s * 0.075).fill(col);
        g.rect(s * x - s * 0.04, s * y - s * 0.1, s * 0.08, s * 0.04).fill(darken(col, 0.2));
      }
      break;
    }
    case 'share_pot': {
      softShadow(g, 0, 0, s * 0.6, s * 0.1, MELA.ink, 0.35);
      g.rect(-s * 0.06, -s * 0.55, s * 0.12, s * 0.5).fill(MELA.wood);
      for (const [x, y, r] of [
        [0, -0.85, 0.32],
        [-0.3, -0.72, 0.22],
        [0.3, -0.72, 0.22],
      ] as const)
        g.circle(s * x, s * y, s * r).fill(
          rgrad(
            [
              [0, lighten(MELA.banyan, 0.25)],
              [1, darken(MELA.banyan, 0.25)],
            ],
            { x: 0.4, y: 0.35 },
            0.8,
          ),
        );
      g.ellipse(0, -s * 0.03, s * 0.45, s * 0.08).fill(MELA.sandstone);
      g.ellipse(0, -s * 0.15, s * 0.11, s * 0.1).fill(MELA.brass);
      g.rect(-s * 0.05, -s * 0.27, s * 0.1, s * 0.05).fill(darken(MELA.brass, 0.2));
      break;
    }
    case 'wait_or_now': {
      tent(g, s, MELA.lapis, MELA.cream);
      g.circle(-s * 0.18, -s * 0.72, s * 0.1).fill(MELA.marigold);
      g.circle(s * 0.18, -s * 0.72, s * 0.1).fill(MELA.cream);
      g.circle(s * 0.22, -s * 0.75, s * 0.08).fill(MELA.parchment);
      break;
    }
    case 'steady_hands': {
      softShadow(g, 0, 0, s * 0.5, s * 0.1, MELA.ink, 0.35);
      g.ellipse(0, -s * 0.04, s * 0.2, s * 0.06).fill(MELA.brass);
      g.rect(-s * 0.025, -s * 0.7, s * 0.05, s * 0.66).fill(MELA.brass);
      g.ellipse(0, -s * 0.7, s * 0.24, s * 0.05).fill(darken(MELA.brass, 0.15));
      for (let i = -2; i <= 2; i++) {
        g.moveTo(s * i * 0.1, -s * 0.72)
          .bezierCurveTo(
            s * (i * 0.1 - 0.04),
            -s * 0.78,
            s * i * 0.1,
            -s * 0.86,
            s * i * 0.1,
            -s * 0.9,
          )
          .bezierCurveTo(
            s * i * 0.1,
            -s * 0.86,
            s * (i * 0.1 + 0.04),
            -s * 0.78,
            s * i * 0.1,
            -s * 0.72,
          )
          .fill(0xffb347);
      }
      break;
    }
    case 'four_stalls': {
      softShadow(g, 0, 0, s * 0.62, s * 0.1, MELA.ink, 0.35);
      const cols = [MELA.saffron, MELA.peacock, MELA.indigo, MELA.rose];
      cols.forEach((col, i) => {
        const x = -s * 0.42 + i * s * 0.28;
        g.rect(x - s * 0.11, -s * 0.36, s * 0.22, s * 0.36).fill(MELA.parchment);
        g.poly([x - s * 0.14, -s * 0.36, x + s * 0.14, -s * 0.36, x, -s * 0.6]).fill(col);
      });
      break;
    }
    case 'private_dice': {
      tent(g, s, MELA.kumkum, MELA.parchment);
      g.roundRect(-s * 0.12, -s * 0.84, s * 0.24, s * 0.24, s * 0.05)
        .fill(MELA.cream)
        .stroke({ width: s * 0.015, color: MELA.sandstone });
      for (const [x, y] of [
        [-0.06, -0.78],
        [0, -0.72],
        [0.06, -0.66],
      ] as const)
        g.circle(s * x, s * y, s * 0.022).fill(MELA.ink);
      break;
    }
    default:
      tent(g, s, MELA.saffron, MELA.cream);
  }
  c.addChildAt(g, 0);
  return c;
}
