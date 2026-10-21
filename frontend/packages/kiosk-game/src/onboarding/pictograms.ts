/**
 * Pictograms for onboarding: picture bands (ONB-04), consent topics (ONB-02) and practice items
 * (ONB-05). No text and no numerals: life stages are shown as people of different ages, frequency as
 * day/night pictures, schooling as slate -> book -> books -> graduation cap. Every picture is paired
 * with a spoken line where the catalogue has one.
 */

import type {
  AgeBand,
  DeviceFamiliarity,
  EduBand,
  Gender,
  LiteracyBand,
  PlayedBefore,
} from '@shriii/contracts';
import { Container, Graphics } from 'pixi.js';
import { CHILD_VARIANT } from '../art/characters/appearance.ts';
import { darken, lighten } from '../art/color.ts';
import { rgrad, softShadow } from '../art/draw.ts';
import { KIOSK_PALETTE, MELA } from '../art/palettes.ts';
import { drawIcon, drawPersonGlyph } from '../art/ui/icons.ts';
import type { OnboardingArt, RichCharacter } from './types.ts';

/** A pictogram plus the characters it owns (destroyed with the tile). */
export interface Pictogram {
  readonly view: Container;
  readonly characters: readonly RichCharacter[];
}

const ICON_INK = MELA.indigo;

function iconPic(id: string, size: number, color: number = ICON_INK): Container {
  const c = new Container();
  c.addChild(drawIcon(id, size, color));
  return c;
}

function badge(id: string, size: number, face: number, x: number, y: number): Container {
  const c = new Container();
  const g = new Graphics();
  g.circle(0, 0, size * 0.5)
    .fill(face)
    .circle(0, 0, size * 0.5)
    .stroke({ width: size * 0.07, color: MELA.cream });
  c.addChild(g, drawIcon(id, size * 0.7, MELA.cream));
  c.position.set(x, y);
  return c;
}

/** A villager figure fitted into a tile of edge `px`. */
function figure(
  art: OnboardingArt,
  id: string,
  variant: number,
  px: number,
  role: 'customer' | 'player' = 'customer',
): Pictogram {
  const ch = art.createCharacter({ id, role, variant, scale: (px * 0.00305) / art.unit });
  const c = new Container();
  // Soft floor disc inside the tile.
  const floor = new Graphics();
  floor.ellipse(0, px * 0.41, px * 0.3, px * 0.05).fill({ color: MELA.sandstone, alpha: 0.5 });
  ch.view.position.set(0, px * 0.42);
  c.addChild(floor, ch.view);
  return { view: c, characters: [ch] };
}

/** Life-stage pictures for the age bands (and the polite under-18 child). */
export function agePictogram(
  art: OnboardingArt,
  band: AgeBand | 'under_18',
  px: number,
): Pictogram {
  const variants: Record<AgeBand | 'under_18', number> = {
    under_18: CHILD_VARIANT,
    '18_24': 7,
    '25_34': 5,
    '35_44': 1,
    '45_59': 4,
    '60_plus': 6,
    prefer_not_to_say: -1,
  };
  if (band === 'prefer_not_to_say') return { view: iconPic('hush', px * 0.62), characters: [] };
  return figure(
    art,
    `age-${band}`,
    variants[band],
    px,
    band === 'under_18' ? 'player' : 'customer',
  );
}

/** Literacy: a letter read easily, read with difficulty, or not readable. */
export function literacyPictogram(band: LiteracyBand, px: number): Pictogram {
  if (band === 'prefer_not_to_say') return { view: iconPic('hush', px * 0.62), characters: [] };
  const c = new Container();
  const letter = drawIcon('newspaper', px * 0.6, MELA.parchment);
  const frame = new Graphics();
  frame
    .roundRect(-px * 0.2, -px * 0.17, px * 0.4, px * 0.33, px * 0.03)
    .stroke({ width: px * 0.02, color: darken(MELA.parchment, 0.5) });
  c.addChild(letter, frame);
  const face =
    band === 'easily' ? 'face_happy' : band === 'with_difficulty' ? 'face_neutral' : 'no';
  if (band === 'not_at_all') {
    c.addChild(drawIcon('no', px * 0.7, MELA.vermilion));
  } else {
    const b = new Container();
    b.addChild(drawIcon(face, px * 0.34, MELA.ink));
    b.position.set(px * 0.24, px * 0.22);
    c.addChild(b);
    if (band === 'with_difficulty') {
      // Squiggle lines: hard to read.
      const sq = new Graphics();
      for (let k = 0; k < 3; k++) {
        sq.moveTo(-px * 0.16, -px * 0.04 + k * px * 0.06);
        for (let x = 0; x <= 8; x++)
          sq.lineTo(
            -px * 0.16 + x * px * 0.04,
            -px * 0.04 + k * px * 0.06 + (x % 2 ? px * 0.015 : -px * 0.015),
          );
        sq.stroke({ width: px * 0.012, color: MELA.vermilion, alpha: 0.8 });
      }
      c.addChild(sq);
    }
  }
  return { view: c, characters: [] };
}

/** Schooling stages. */
export function educationPictogram(band: EduBand, px: number): Pictogram {
  switch (band) {
    case 'none':
      return { view: iconPic('home', px * 0.62, MELA.terracotta), characters: [] };
    case 'primary':
      return { view: iconPic('slate', px * 0.62, MELA.cream), characters: [] };
    case 'secondary':
      return { view: iconPic('book', px * 0.62, MELA.peacock), characters: [] };
    case 'higher_secondary': {
      const c = new Container();
      const b1 = drawIcon('book', px * 0.5, MELA.peacock);
      b1.position.set(-px * 0.08, px * 0.08);
      const b2 = drawIcon('book', px * 0.5, MELA.vermilion);
      b2.position.set(px * 0.06, -px * 0.08);
      c.addChild(b1, b2);
      return { view: c, characters: [] };
    }
    case 'graduate_plus':
      return { view: iconPic('gradcap', px * 0.66, MELA.indigo), characters: [] };
    case 'prefer_not_to_say':
      return { view: iconPic('hush', px * 0.62), characters: [] };
  }
}

/** Gender (optional question). */
export function genderPictogram(art: OnboardingArt, g: Gender, px: number): Pictogram {
  if (g === 'woman') return figure(art, 'gender-woman', 0, px);
  if (g === 'man') return figure(art, 'gender-man', 1, px);
  if (g === 'another') {
    const c = new Container();
    const gg = new Graphics();
    drawPersonGlyph(gg, -px * 0.12, px * 0.3, px * 0.55, MELA.peacock);
    drawPersonGlyph(gg, px * 0.12, px * 0.3, px * 0.55, MELA.saffron, { skirt: true });
    gg.circle(0, -px * 0.32, px * 0.06).fill(MELA.marigold);
    c.addChild(gg);
    return { view: c, characters: [] };
  }
  return { view: iconPic('hush', px * 0.62), characters: [] };
}

/** Smartphone use: never / sometimes / daily (day-and-night). */
export function devicePictogram(d: DeviceFamiliarity, px: number): Pictogram {
  if (d === 'prefer_not_to_say') return { view: iconPic('hush', px * 0.62), characters: [] };
  const c = new Container();
  const phone = drawIcon('phone', px * 0.6, MELA.indigo);
  c.addChild(phone);
  if (d === 'never') c.addChild(drawIcon('no', px * 0.72, MELA.vermilion));
  if (d === 'sometimes') c.addChild(badge('sun', px * 0.3, MELA.peacock, px * 0.26, -px * 0.24));
  if (d === 'daily') {
    c.addChild(badge('sun', px * 0.28, MELA.peacock, -px * 0.27, -px * 0.25));
    c.addChild(badge('moon', px * 0.28, MELA.indigoDeep, px * 0.27, -px * 0.25));
  }
  return { view: c, characters: [] };
}

/** Played this before? */
export function playedBeforePictogram(p: PlayedBefore, px: number): Pictogram {
  if (p === 'prefer_not_to_say') return { view: iconPic('hush', px * 0.62), characters: [] };
  const c = new Container();
  c.addChild(drawIcon('repeat', px * 0.56, MELA.indigo));
  if (p === 'yes')
    c.addChild(badge('tick', px * 0.32, KIOSK_PALETTE.confirm, px * 0.24, px * 0.24));
  if (p === 'no') c.addChild(badge('cross', px * 0.32, KIOSK_PALETTE.cancel, px * 0.24, px * 0.24));
  if (p === 'not_sure')
    c.addChild(badge('question_wave', px * 0.32, MELA.saffron, px * 0.24, px * 0.24));
  return { view: c, characters: [] };
}

/** Consent topic pictures (what we play, keep, no audio, stop, erase, report, snapshot-not-diagnosis). */
export type ConsentTopic = 'play' | 'keep' | 'no_audio' | 'stop' | 'erase' | 'report' | 'snapshot';

export function consentPictogram(topic: ConsentTopic, px: number): Pictogram {
  const c = new Container();
  switch (topic) {
    case 'play':
      c.addChild(drawIcon('game', px * 0.66, MELA.saffron));
      break;
    case 'keep':
      c.addChild(drawIcon('chest', px * 0.66, MELA.wood));
      break;
    case 'no_audio':
      c.addChild(drawIcon('mic', px * 0.6, MELA.indigo), drawIcon('no', px * 0.74, MELA.vermilion));
      break;
    case 'stop':
      c.addChild(drawIcon('hand', px * 0.6, 0x8e2f4a));
      break;
    case 'erase':
      c.addChild(drawIcon('bin', px * 0.6, MELA.indigo));
      break;
    case 'report':
      c.addChild(drawIcon('card', px * 0.62, MELA.peacock));
      break;
    case 'snapshot': {
      const cam = drawIcon('camera', px * 0.42, MELA.indigo);
      cam.position.set(-px * 0.17, 0);
      const st = new Container();
      st.addChild(
        drawIcon('stethoscope', px * 0.36, MELA.smoke),
        drawIcon('no', px * 0.44, MELA.vermilion),
      );
      st.position.set(px * 0.2, 0);
      c.addChild(cam, st);
      break;
    }
  }
  return { view: c, characters: [] };
}

/** Practice target: a glowing marigold to tap. */
export function marigoldTarget(px: number): Container {
  const c = new Container();
  const g = new Graphics();
  softShadow(g, 0, px * 0.42, px * 0.35, px * 0.07, MELA.ink, 0.4);
  g.circle(0, 0, px * 0.55).fill(
    rgrad([
      [0, '#fff2b0aa'],
      [0.6, '#ffd27a33'],
      [1, '#ffd27a00'],
    ]),
  );
  for (let ring = 0; ring < 3; ring++) {
    const n = 12 - ring * 2;
    const r = px * (0.34 - ring * 0.1);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + ring * 0.25;
      g.ellipse(Math.cos(a) * r * 0.6, Math.sin(a) * r * 0.6, r * 0.42, r * 0.3).fill(
        ring === 0 ? MELA.saffron : ring === 1 ? MELA.marigold : lighten(MELA.marigold, 0.25),
      );
    }
  }
  g.circle(0, 0, px * 0.07).fill(darken(MELA.saffron, 0.35));
  c.addChild(g);
  return c;
}

/** Practice hold target: a brass diya to keep pressed until its flame fills. */
export function diyaTarget(px: number): Container {
  const c = new Container();
  c.addChild(drawIcon('diya', px * 0.8, MELA.terracotta));
  return c;
}
