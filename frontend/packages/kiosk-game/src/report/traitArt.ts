/**
 * Strengths-framed pictorial trait cards. Each construct has an emblem and one picture per pole; BOTH
 * poles are strengths (a careful lotus and a lively sun are both good). Banded traits show a brass
 * balance beam with a glowing bead at the band position (no numbers, no scale marks); broad-style traits
 * (capped constructs such as integrity and risk preference) show only the pole picture with a soft
 * ribbon, never a position. Meaning is carried by the spoken, allowlisted phrase.
 */

import type { ConstructId } from '@shriii/contracts';
import { Container, Graphics } from 'pixi.js';
import { darken, lighten } from '../art/color.ts';
import { glowDisc, softShadow, vgrad } from '../art/draw.ts';
import { MELA } from '../art/palettes.ts';
import { drawIcon } from '../art/ui/icons.ts';
import type { DisplayTrait } from './model.ts';

/** Emblem and pole pictures per construct. */
export const TRAIT_ART: Readonly<
  Record<
    ConstructId,
    {
      readonly emblem: string;
      readonly poleA: string;
      readonly poleB: string;
      readonly hue: number;
    }
  >
> = {
  self_control: { emblem: 'hand', poleA: 'lotus', poleB: 'sun', hue: MELA.peacock },
  emotional_regulation: { emblem: 'heart', poleA: 'lotus', poleB: 'flower', hue: MELA.rose },
  composure: { emblem: 'diya', poleA: 'diya', poleB: 'star', hue: MELA.saffron },
  response_consistency: { emblem: 'repeat', poleA: 'repeat', poleB: 'flower', hue: MELA.lapis },
  task_organisation: { emblem: 'chest', poleA: 'chest', poleB: 'star', hue: MELA.wood },
  decisiveness: { emblem: 'pointer', poleA: 'pointer', poleB: 'ear', hue: MELA.vermilion },
  adaptability: { emblem: 'repeat', poleA: 'home', poleB: 'flower', hue: MELA.mango },
  persistence_of_style: { emblem: 'star', poleA: 'repeat', poleB: 'flower', hue: MELA.indigo },
  stability: { emblem: 'home', poleA: 'home', poleB: 'sun', hue: MELA.terracotta },
  expressive_restraint: {
    emblem: 'lotus',
    poleA: 'lotus',
    poleB: 'speaker',
    hue: MELA.peacockDeep,
  },
  teamwork: { emblem: 'people', poleA: 'people', poleB: 'star', hue: MELA.peacock },
  judgement: { emblem: 'balance', poleA: 'balance', poleB: 'heart', hue: MELA.brass },
  problem_solving: { emblem: 'game', poleA: 'chest', poleB: 'star', hue: MELA.saffron },
  integrity: { emblem: 'lotus', poleA: 'lotus', poleB: 'heart', hue: MELA.rose },
  initiative: { emblem: 'sun', poleA: 'sun', poleB: 'ear', hue: MELA.marigoldDeep },
  risk_preference: { emblem: 'mango', poleA: 'home', poleB: 'star', hue: MELA.vermilion },
  persistence: { emblem: 'diya', poleA: 'diya', poleB: 'sun', hue: MELA.kumkum },
};

/** Build one card of width `w` (height 1.32 w), centred at (0, 0). Returns the card and its glow. */
export function traitCard(
  trait: DisplayTrait,
  w: number,
  options: { readonly print?: boolean } = {},
): { view: Container; glow: Graphics } {
  const art = options.print ? { ...TRAIT_ART[trait.trait], hue: 0x111111 } : TRAIT_ART[trait.trait];
  const h = w * 1.32;
  const view = new Container();
  const glow = new Graphics();
  glowDisc(glow, 0, 0, w * 0.95, 0xffd27a, 0.9);
  glow.blendMode = 'add';
  glow.alpha = 0;
  const g = new Graphics();
  if (options.print) {
    // Thermal print: pure white card with a crisp black frame (no shading to dither into noise).
    g.roundRect(-w / 2, -h / 2, w, h, w * 0.12)
      .fill(0xffffff)
      .stroke({ width: w * 0.025, color: 0x000000 });
  } else {
    softShadow(g, 0, h * 0.5, w * 0.48, w * 0.06, MELA.ink, 0.5);
    g.roundRect(-w / 2, -h / 2 + w * 0.03, w, h, w * 0.12).fill(darken(art.hue, 0.35));
    g.roundRect(-w / 2, -h / 2, w, h, w * 0.12).fill(
      vgrad([
        [0, 0xfffaf0],
        [1, MELA.parchment],
      ]),
    );
  }
  g.roundRect(-w / 2 + w * 0.04, -h / 2 + w * 0.04, w * 0.92, h - w * 0.08, w * 0.09).stroke({
    width: w * 0.02,
    color: art.hue,
    alpha: 0.9,
  });
  for (const [cx, cy] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ] as const) {
    g.circle(cx * w * 0.38, cy * (h / 2 - w * 0.12), w * 0.02).fill(MELA.marigold);
  }
  // Emblem medallion at the top.
  g.circle(0, -h / 2 + w * 0.2, w * 0.15)
    .fill(art.hue)
    .circle(0, -h / 2 + w * 0.2, w * 0.15)
    .stroke({ width: w * 0.02, color: MELA.brass });
  view.addChild(glow, g);
  const emblem = drawIcon(art.emblem, w * 0.22, MELA.cream);
  emblem.position.set(0, -h / 2 + w * 0.2);
  view.addChild(emblem);
  const midY = -h * 0.02;
  if (trait.band === 'centre') {
    const a = drawIcon(art.poleA, w * 0.36, art.hue);
    a.position.set(-w * 0.2, midY);
    const b = drawIcon(art.poleB, w * 0.36, art.hue);
    b.position.set(w * 0.2, midY);
    view.addChild(a, b);
  } else {
    const p = drawIcon(trait.band === 'pole_a' ? art.poleA : art.poleB, w * 0.5, art.hue);
    p.position.set(0, midY);
    view.addChild(p);
  }
  const by = h / 2 - w * 0.2;
  const beam = new Graphics();
  if (trait.style === 'banded') {
    // Balance beam with the two pole pictures at its ends and a glowing bead at the band (no numbers).
    beam.roundRect(-w * 0.3, by - w * 0.012, w * 0.6, w * 0.024, w * 0.012).fill(MELA.brass);
    const bx = trait.band === 'pole_a' ? -w * 0.22 : trait.band === 'pole_b' ? w * 0.22 : 0;
    glowDisc(beam, bx, by, w * 0.1, 0xffd27a, 0.9);
    beam
      .circle(bx, by, w * 0.045)
      .fill(lighten(MELA.marigold, 0.2))
      .circle(bx, by, w * 0.045)
      .stroke({ width: w * 0.012, color: MELA.wood });
    view.addChild(beam);
    const ea = drawIcon(art.poleA, w * 0.13, darken(art.hue, 0.1));
    ea.position.set(-w * 0.38, by);
    const eb = drawIcon(art.poleB, w * 0.13, darken(art.hue, 0.1));
    eb.position.set(w * 0.38, by);
    view.addChild(ea, eb);
  } else {
    // Broad style: a soft ribbon, never a position.
    beam.moveTo(-w * 0.3, by);
    for (let i = 0; i <= 12; i++)
      beam.lineTo(-w * 0.3 + (i * w * 0.6) / 12, by + Math.sin(i * 0.9) * w * 0.02);
    beam.stroke({ width: w * 0.022, color: art.hue, alpha: 0.7, cap: 'round' });
    view.addChild(beam);
  }
  return { view, glow };
}

/** "A snapshot, not a diagnosis" badge (always shown with any trait). */
export function snapshotBadge(size: number): Container {
  const c = new Container();
  const g = new Graphics();
  g.roundRect(-size, -size * 0.45, size * 2, size * 0.9, size * 0.3)
    .fill({ color: 0xfffaf0, alpha: 0.95 })
    .stroke({ width: size * 0.04, color: MELA.brass });
  const cam = drawIcon('camera', size * 0.62, MELA.indigo);
  cam.position.set(-size * 0.45, 0);
  const st = new Container();
  st.addChild(
    drawIcon('stethoscope', size * 0.55, MELA.smoke),
    drawIcon('no', size * 0.68, MELA.vermilion),
  );
  st.position.set(size * 0.48, 0);
  c.addChild(g, cam, st);
  return c;
}

/** "Example" stamp for demo reports (REP-02: labelled example in audio and print). */
export function exampleStamp(size: number): Container {
  const c = new Container();
  const g = new Graphics();
  g.roundRect(-size, -size * 0.5, size * 2, size, size * 0.2).stroke({
    width: size * 0.08,
    color: MELA.vermilion,
  });
  for (let i = 0; i < 5; i++)
    g.circle(-size * 0.6 + i * size * 0.3, 0, size * 0.09).fill(MELA.vermilion);
  const card = drawIcon('card', size * 0.6, MELA.vermilion);
  card.position.set(0, -size * 0.85);
  c.addChild(g, card);
  c.rotation = -0.12;
  return c;
}
