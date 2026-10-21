/**
 * Art kit invariants: time-of-day palette interpolation, colour-blind-safe UI tokens (KSK-06: dE >= 20
 * between paired categories under dichromat simulation, icon contrast), physical target sizing and
 * spacing (KSK-05), quality tiers and reduced motion, character expression model and tone mapping.
 */
import '../../onboarding/__tests__/canvasStub.ts';
import { describe, expect, it } from 'vitest';
import { TOUCH_SPACING_MIN_MM, TOUCH_TARGET_MIN_MM } from '../../core/contracts.ts';
import {
  appearanceFor,
  CHILD_APPEARANCE,
  CHILD_VARIANT,
  GUIDE_APPEARANCE,
  VILLAGERS,
} from '../characters/appearance.ts';
import { EXPRESSIONS, intensify, toneExpression } from '../characters/expressions.ts';
import { contrastRatio, deltaE, mixColor, simulateColorBlind } from '../color.ts';
import { arrangeChoices, physicalMetrics, rectsSeparated, staticLayout } from '../layout.ts';
import { KIOSK_PALETTE, MELA, scenePaletteAt, TIME_PALETTES } from '../palettes.ts';
import { qualityProfile } from '../quality.ts';
import { BUTTON_TOKENS, DEFAULT_BUTTON_MM, IconButton } from '../ui/buttons.ts';
import { ICONS } from '../ui/icons.ts';

describe('palettes', () => {
  it('interpolates time of day continuously from morning to dusk', () => {
    expect(scenePaletteAt(1).skyTop).toBe(TIME_PALETTES.midday.skyTop);
    expect(scenePaletteAt(3).lights).toBe(1);
    const mid = scenePaletteAt(2.5);
    expect(mid.lights).toBeGreaterThan(TIME_PALETTES.golden_hour.lights);
    expect(mid.lights).toBeLessThan(TIME_PALETTES.dusk.lights);
    expect(scenePaletteAt(-5).skyTop).toBe(TIME_PALETTES.morning.skyTop);
    expect(scenePaletteAt(9).skyTop).toBe(TIME_PALETTES.dusk.skyTop);
  });

  it('lights (diyas, string lights) only come on as the day ends', () => {
    expect(TIME_PALETTES.midday.lights).toBe(0);
    expect(TIME_PALETTES.golden_hour.lights).toBeGreaterThan(0);
    expect(TIME_PALETTES.dusk.fireflies).toBeGreaterThan(0);
    expect(TIME_PALETTES.midday.fireflies).toBe(0);
  });

  it('mixes colours in linear light', () => {
    expect(mixColor(0x000000, 0xffffff, 0)).toBe(0x000000);
    expect(mixColor(0x000000, 0xffffff, 1)).toBe(0xffffff);
  });
});

describe('colour-blind-safe UI (KSK-06)', () => {
  it('confirm and cancel stay distinguishable for every dichromacy (dE >= 20)', () => {
    for (const kind of ['protanopia', 'deuteranopia', 'tritanopia'] as const) {
      const a = simulateColorBlind(KIOSK_PALETTE.confirm, kind);
      const b = simulateColorBlind(KIOSK_PALETTE.cancel, kind);
      expect(deltaE(a, b), kind).toBeGreaterThanOrEqual(20);
    }
  });

  it('confirm and cancel also differ by shape and icon, never colour alone', () => {
    expect(BUTTON_TOKENS.confirm.shape).not.toBe(BUTTON_TOKENS.cancel.shape);
    expect(BUTTON_TOKENS.confirm.defaultIcon).not.toBe(BUTTON_TOKENS.cancel.defaultIcon);
    const shapes = new Set(Object.values(BUTTON_TOKENS).map((t) => `${t.shape}:${t.defaultIcon}`));
    expect(shapes.size).toBe(Object.keys(BUTTON_TOKENS).length - 1); // primary and secondary share shape+icon, differ in face
  });

  it('icons contrast with their button faces (>= 4.5:1, KSK-06)', () => {
    for (const [variant, t] of Object.entries(BUTTON_TOKENS)) {
      expect(contrastRatio(t.face, t.iconColor), variant).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('every default icon exists and draws', () => {
    for (const t of Object.values(BUTTON_TOKENS)) expect(ICONS[t.defaultIcon]).toBeDefined();
  });
});

describe('physical sizing (KSK-05)', () => {
  it('buttons are never smaller than 20 mm at the configured density', () => {
    const metrics = physicalMetrics(4);
    const b = new IconButton({
      spec: { id: 'x', iconId: 'tick', audioKey: 'a', variant: 'confirm', sizeMm: 5 },
      metrics,
    });
    expect(b.sizePx).toBeGreaterThanOrEqual(metrics.minTargetPx);
    expect(metrics.minTargetPx).toBe(Math.ceil(TOUCH_TARGET_MIN_MM * 4));
    const d = new IconButton({
      spec: { id: 'y', iconId: 'tick', audioKey: 'a', variant: 'confirm' },
      metrics,
    });
    expect(d.sizePx).toBe(Math.round(DEFAULT_BUTTON_MM * 4));
    b.destroy();
    d.destroy();
  });

  it('arranged choices keep >= 8 mm spacing and sit in the lower two-thirds, both orientations', () => {
    for (const [w, h] of [
      [1920, 1080],
      [1080, 1920],
    ] as const) {
      const layout = staticLayout(w, h, 4);
      for (const count of [2, 3, 4, 6, 7]) {
        const size = layout.metrics.pxPerMm * 32;
        const pts = arrangeChoices(layout, count, size);
        expect(pts).toHaveLength(count);
        const rects = pts.map((p) => ({
          x: p.x - size / 2,
          y: p.y - size / 2,
          width: size,
          height: size,
        }));
        for (let i = 0; i < rects.length; i++) {
          const ri = rects[i];
          if (!ri) continue;
          expect(ri.y).toBeGreaterThanOrEqual(h / 3 - 1);
          for (let j = i + 1; j < rects.length; j++) {
            const rj = rects[j];
            if (rj) expect(rectsSeparated(ri, rj, TOUCH_SPACING_MIN_MM * 4 - 1)).toBe(true);
          }
        }
      }
    }
  });
});

describe('quality tiers', () => {
  it('reduced motion removes camera moves and birds and damps motion', () => {
    const p = qualityProfile({ tier: 'high', reducedMotion: true });
    expect(p.cameraMoves).toBe(false);
    expect(p.birds).toBe(false);
    expect(p.motionScale).toBeLessThan(0.3);
    expect(qualityProfile({ tier: 'low', reducedMotion: false }).bloom).toBe(false);
    expect(qualityProfile({ tier: 'high', reducedMotion: false }).godrays).toBe(true);
  });
});

describe('characters', () => {
  it('appearance is deterministic and diverse', () => {
    expect(appearanceFor('customer', 3)).toBe(appearanceFor('customer', 3));
    expect(appearanceFor('guide')).toBe(GUIDE_APPEARANCE);
    expect(GUIDE_APPEARANCE.lantern).toBe(true);
    expect(appearanceFor('player', CHILD_VARIANT)).toBe(CHILD_APPEARANCE);
    const feminine = VILLAGERS.filter((v) => v.feminine).length;
    expect(feminine).toBeGreaterThanOrEqual(3);
    expect(VILLAGERS.length - feminine).toBeGreaterThanOrEqual(3);
    expect(new Set(VILLAGERS.map((v) => v.skin)).size).toBeGreaterThanOrEqual(5);
    expect(VILLAGERS.some((v) => v.age > 0.7)).toBe(true);
    expect(new Set(VILLAGERS.map((v) => v.lower)).size).toBeGreaterThanOrEqual(6);
  });

  it('tone levels map to calm -> impatient -> annoyed -> angry with rising intensity', () => {
    expect(toneExpression(0).expression).toBe('calm');
    expect(toneExpression(1).expression).toBe('impatient');
    expect(toneExpression(2).expression).toBe('annoyed');
    expect(toneExpression(3)).toEqual({ expression: 'angry', intensity: 2 });
    expect(toneExpression(4)).toEqual({ expression: 'angry', intensity: 3 });
  });

  it('negative expressions carry non-colour cues (symbol and posture), positives do not frown', () => {
    for (const e of ['impatient', 'annoyed', 'angry'] as const) {
      expect(EXPRESSIONS[e].symbol).not.toBe('none');
      expect(EXPRESSIONS[e].arms).not.toBe('relaxed');
      expect(EXPRESSIONS[e].params.smile).toBeLessThan(0);
    }
    for (const e of ['calm', 'happy', 'pleased'] as const)
      expect(EXPRESSIONS[e].params.smile).toBeGreaterThan(0);
    const a2 = intensify(EXPRESSIONS.angry.params, 3);
    expect(a2.browAngle).toBeGreaterThan(EXPRESSIONS.angry.params.browAngle);
  });

  it('palette tokens are original mela pigments', () => {
    expect(MELA.marigold).toBe(0xf6b11f);
  });
});
