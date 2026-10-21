/**
 * Expression symbols: non-colour cues that make an expression readable at a glance (KSK-06): sweat drop,
 * anger mark (vein), steam puffs, sparkles, a thought bubble and a sigh puff. Animated well under 3 Hz.
 */
import { Container, Graphics } from 'pixi.js';
import type { ExpressionSymbol } from '../expressions.ts';

export class SymbolLayer {
  readonly view = new Container();
  private symbol: ExpressionSymbol = 'none';
  private intensity = 1;
  private time = 0;

  constructor(private readonly headCY: number) {
    this.view.label = 'symbols';
  }

  get current(): ExpressionSymbol {
    return this.symbol;
  }

  /** Show a symbol (rebuilds only when it or the intensity changed). */
  set(symbol: ExpressionSymbol, intensity: number): void {
    if (symbol === this.symbol && intensity === this.intensity) return;
    this.symbol = symbol;
    this.intensity = intensity;
    this.build();
  }

  update(dt: number, motionScale: number): void {
    if (this.view.children.length === 0) return;
    this.time += dt;
    const t = this.time;
    const ms = Math.max(0.3, motionScale);
    const cy = this.headCY;
    for (const c of this.view.children) {
      const label = c.label;
      if (label === 'sweat') {
        c.y = cy - 26 + ((t * 10) % 14) * ms;
        c.alpha = 1 - ((t * 10) % 14) / 20;
      } else if (label === 'vein') {
        c.scale.set(1 + 0.12 * Math.max(0, Math.sin(t * Math.PI * 2 * 1.6)) * ms);
      } else if (label.startsWith('steam')) {
        const i = Number(label.slice(5));
        const phase = (t * 0.9 + i * 0.37) % 1;
        c.y = cy - 46 - phase * 40 * ms;
        c.alpha = 1 - phase;
        c.scale.set(0.6 + phase * 0.8);
      } else if (label.startsWith('sparkle')) {
        const i = Number(label.slice(7));
        c.alpha = 0.5 + 0.5 * Math.sin(t * 2.4 + i * 2);
        c.rotation = t * 0.8;
      } else if (label === 'thought') {
        c.y = cy - 40 + Math.sin(t * 1.5) * 3 * ms;
      } else if (label === 'sigh') {
        const phase = (t * 0.5) % 1;
        c.x = -30 - phase * 30 * ms;
        c.alpha = 1 - phase;
      }
    }
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }

  private build(): void {
    for (const c of this.view.removeChildren()) c.destroy({ children: true });
    this.time = 0;
    const cy = this.headCY;
    const add = (g: Graphics, x: number, y: number, label: string): void => {
      g.position.set(x, y);
      g.label = label;
      this.view.addChild(g);
    };
    switch (this.symbol) {
      case 'none':
        return;
      case 'sweat': {
        const g = new Graphics();
        g.moveTo(0, -10)
          .quadraticCurveTo(9, 4, 0, 9)
          .quadraticCurveTo(-9, 4, 0, -10)
          .fill(0xdff3ff)
          .stroke({ width: 2, color: 0x2a4a6a });
        add(g, 46, cy - 26, 'sweat');
        return;
      }
      case 'vein': {
        const count = this.intensity >= 3 ? 2 : 1;
        for (let i = 0; i < count; i++)
          add(veinMark(6), i === 0 ? 30 : -34, cy - 46 + i * 6, 'vein');
        return;
      }
      case 'steam': {
        for (let i = 0; i < (this.intensity >= 3 ? 4 : 2); i++) {
          const g = new Graphics();
          g.circle(0, 0, 9)
            .circle(8, -4, 7)
            .circle(-7, -3, 6)
            .fill({ color: 0xffffff, alpha: 0.95 })
            .stroke({ width: 2, color: 0x6a5a5a });
          add(g, (i % 2 === 0 ? 1 : -1) * (40 + (i >> 1) * 8), cy - 46, `steam${i}`);
        }
        const v = new Graphics();
        for (let q = 0; q < 4; q++) {
          const ang = (q / 4) * Math.PI * 2 + Math.PI / 4;
          v.moveTo(Math.cos(ang) * 10, Math.sin(ang) * 10)
            .lineTo(Math.cos(ang) * 4, Math.sin(ang) * 4)
            .stroke({ width: 5, color: 0x2a0a0a })
            .moveTo(Math.cos(ang) * 10, Math.sin(ang) * 10)
            .lineTo(Math.cos(ang) * 4, Math.sin(ang) * 4)
            .stroke({ width: 2.5, color: 0xe0402a });
        }
        add(v, 30, cy - 44, 'vein');
        return;
      }
      case 'sparkle': {
        for (let i = 0; i < 3; i++) {
          const g = new Graphics();
          g.poly([0, -9, 2.2, -2.2, 9, 0, 2.2, 2.2, 0, 9, -2.2, 2.2, -9, 0, -2.2, -2.2])
            .fill(0xfff2b0)
            .stroke({ width: 1.2, color: 0xb8862a });
          add(g, [-66, 64, 58][i] ?? 0, cy + ([-34, -52, 18][i] ?? 0), `sparkle${i}`);
        }
        return;
      }
      case 'thought': {
        const g = new Graphics();
        g.circle(0, 0, 4)
          .circle(10, -12, 6)
          .circle(24, -28, 9)
          .fill({ color: 0xffffff, alpha: 0.95 })
          .stroke({ width: 2, color: 0x5a4a4a });
        add(g, 40, cy - 40, 'thought');
        return;
      }
      case 'sigh': {
        const g = new Graphics();
        g.circle(0, 0, 6)
          .circle(9, -2, 5)
          .circle(16, 1, 4)
          .fill({ color: 0xffffff, alpha: 0.9 })
          .stroke({ width: 1.6, color: 0x6a5a5a });
        add(g, -30, cy + 26, 'sigh');
        return;
      }
    }
  }
}

function veinMark(r: number): Graphics {
  const g = new Graphics();
  for (let q = 0; q < 4; q++) {
    const ang = (q / 4) * Math.PI * 2 + Math.PI / 4;
    const cx = Math.cos(ang) * r;
    const cyy = Math.sin(ang) * r;
    const ax = cx + Math.cos(ang + 1.2) * r;
    const ay = cyy + Math.sin(ang + 1.2) * r;
    const bx = cx + Math.cos(ang - 1.2) * r;
    const by = cyy + Math.sin(ang - 1.2) * r;
    g.moveTo(ax, ay)
      .quadraticCurveTo(cx * 0.2, cyy * 0.2, bx, by)
      .stroke({ width: 6, color: 0x2a0a0a })
      .moveTo(ax, ay)
      .quadraticCurveTo(cx * 0.2, cyy * 0.2, bx, by)
      .stroke({ width: 3, color: 0xe0402a });
  }
  return g;
}
