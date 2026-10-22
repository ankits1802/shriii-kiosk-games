import { gsap } from 'gsap';
import { Container } from 'pixi.js';
import { describe, expect, it } from 'vitest';
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
});
