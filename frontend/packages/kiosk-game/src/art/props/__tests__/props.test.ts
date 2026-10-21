/**
 * Props: pictured quantities (no numerals), the brass scale's balance physics, carts and lantern.
 */
import '../../../onboarding/__tests__/canvasStub.ts';
import { type Container, Text } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import {
  BrassScale,
  BullockCart,
  balanceForWeights,
  createBasket,
  createCoinPile,
  createCoinRow,
  createCoinStack,
  createFuelCan,
  createGoodsPile,
  createSack,
  GOODS_KINDS,
  HandCart,
  HandLantern,
} from '../index.ts';

function hasText(c: Container): boolean {
  if (c instanceof Text) return true;
  return c.children.some((ch) => hasText(ch as Container));
}

describe('pictured quantities', () => {
  it('builds every good as a pile without any text', () => {
    for (const kind of GOODS_KINDS) {
      const pile = createGoodsPile(kind, 6);
      expect(pile.label).toBe(`pile:${kind}:6`);
      expect(hasText(pile)).toBe(false);
    }
    for (const c of [
      createCoinStack(5),
      createCoinRow(3),
      createCoinPile(12),
      createBasket({ contents: 'onion', count: 7 }),
      createSack({ open: true, contents: 'rice' }),
      createFuelCan(),
    ])
      expect(hasText(c)).toBe(false);
  });

  it('larger quantities make visibly larger piles', () => {
    const small = createGoodsPile('tomato', 2).getLocalBounds();
    const large = createGoodsPile('tomato', 10).getLocalBounds();
    expect(large.width).toBeGreaterThan(small.width);
    expect(large.height).toBeGreaterThan(small.height);
    expect(createCoinStack(8).getLocalBounds().height).toBeGreaterThan(
      createCoinStack(2).getLocalBounds().height,
    );
  });
});

describe('brass scale', () => {
  it('maps loads to a saturating balance', () => {
    expect(balanceForWeights(1, 1)).toBe(0);
    expect(balanceForWeights(0, 0)).toBe(0);
    expect(balanceForWeights(1, 3)).toBeGreaterThan(0);
    expect(balanceForWeights(3, 1)).toBeLessThan(0);
    expect(balanceForWeights(0, 100)).toBeLessThanOrEqual(1);
    expect(balanceForWeights(1, 2)).toBeLessThan(balanceForWeights(1, 4));
  });

  it('swings past the target, then settles on it', async () => {
    const s = new BrassScale();
    s.setBalance(1);
    let peak = 0;
    for (let i = 0; i < 600; i++) {
      s.update(1 / 60);
      peak = Math.max(peak, s.balance);
    }
    expect(peak).toBeGreaterThan(1.01); // a little overshoot reads as weight
    expect(s.balance).toBeCloseTo(1, 2);
    await s.settled();
    s.setBalance(-0.5, true);
    expect(s.balance).toBeCloseTo(-0.5, 6);
    s.destroy();
  });

  it('pans carry goods', () => {
    const s = new BrassScale();
    s.leftPan.addChild(createGoodsPile('onion', 3));
    expect(s.leftPan.children.length).toBe(1);
    s.destroy();
  });
});

describe('vehicles and lantern', () => {
  it('wheels turn with ground speed', () => {
    const cart = new BullockCart();
    cart.setSpeed(88 * cart.artScale);
    cart.update(1);
    expect(cart.wheelAngle).toBeCloseTo(2, 3);
    expect(cart.seat.y).toBeLessThan(-100);
    cart.destroy();
    const h = new HandCart();
    h.setSpeed(24);
    h.update(1);
    h.destroy();
  });

  it('the lantern flame flickers', () => {
    const l = new HandLantern();
    l.update(0.1);
    l.setLit(1);
    expect(l.light.y).toBeGreaterThan(0);
    l.destroy();
  });
});
