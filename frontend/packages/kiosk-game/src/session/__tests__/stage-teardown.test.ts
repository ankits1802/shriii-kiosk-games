import { gsap } from 'gsap';
import { Container, Ticker } from 'pixi.js';
import { describe, expect, it, vi } from 'vitest';
import { destroyStage, installTweenSafeDestroy } from '../stage-teardown.ts';

describe('tween-safe teardown', () => {
  installTweenSafeDestroy();

  it('kills tweens on a container and its children when the tree is destroyed', () => {
    const root = new Container();
    const child = new Container();
    root.addChild(child);
    const a = gsap.to(child, { x: 10, duration: 1 });
    const b = gsap.to(child.scale, { x: 2, duration: 1 });
    destroyStage(root);
    expect(root.destroyed).toBe(true);
    expect(a.isActive() || b.isActive()).toBe(false);
    expect(() => a.progress(0.5)).not.toThrow();
  });

  it('kills a tween created after its target was destroyed instead of throwing', () => {
    const c = new Container();
    c.destroy();
    const t = gsap.to(c, { y: 5, duration: 1 });
    expect(() => t.progress(0.5)).not.toThrow();
  });

  it('removes a ticker listener that touches a destroyed object instead of throwing', () => {
    const ticker = new Ticker();
    ticker.autoStart = false;
    const c = new Container();
    let calls = 0;
    const fn = (): void => {
      calls += 1;
      c.position.set(1, 1);
    };
    ticker.add(fn);
    ticker.update(16);
    c.destroy();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => ticker.update(32)).not.toThrow();
    expect(() => ticker.update(48)).not.toThrow();
    expect(calls).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    ticker.destroy();
  });

  it('keeps remove() working with the original listener', () => {
    const ticker = new Ticker();
    ticker.autoStart = false;
    let calls = 0;
    const fn = (): void => {
      calls += 1;
    };
    ticker.add(fn);
    ticker.update(16);
    ticker.remove(fn);
    ticker.update(32);
    expect(calls).toBe(1);
    ticker.destroy();
  });
});
