/**
 * The fair the cart leaves at sunset (intro): a few stalls with striped awnings, bunting and a
 * Ferris wheel turning against the low sun. It slides away behind the cart as the journey begins.
 */
import { Container, Graphics } from 'pixi.js';
import { AWNING_COLOURWAYS, drawStall, type StallGoods } from '../../../art/backdrop/props.ts';
import { drawFerrisWheel } from '../../../art/backdrop/structures.ts';
import { catenary } from '../../../art/draw.ts';
import { MELA } from '../../../art/palettes.ts';
import { type EpisodeArt, splitLit } from './art.ts';
import type { GroundMetrics } from './landscape.ts';

export class FairPiece {
  readonly view = new Container();
  private readonly wheel: Container;
  /** Unlit art (takes the scene light). */
  readonly body: Container;
  private readonly tick = (): void => {
    this.wheel.rotation += Math.min(0.05, this.art.ticker.deltaMS / 1000) * 0.18 * this.art.motion;
  };

  constructor(
    private readonly art: EpisodeArt,
    m: GroundMetrics,
  ) {
    this.view.label = 'fair';
    this.view.eventMode = 'none';
    const u = art.unit;
    const fw = drawFerrisWheel(art.h * 0.18);
    fw.frame.position.set(-art.w * 0.18, m.horizonY + art.h * 0.04);
    fw.wheel.position.set(-art.w * 0.18 + fw.hub.x, m.horizonY + art.h * 0.04 + fw.hub.y);
    this.wheel = fw.wheel;
    this.view.addChild(fw.frame, fw.wheel);
    const goods: StallGoods[] = ['spice', 'fruit', 'flowers', 'sweets'];
    const stallY = m.roadY - m.roadH * 0.62;
    goods.forEach((g, i) => {
      const [a, b] = AWNING_COLOURWAYS[(i * 2) % AWNING_COLOURWAYS.length] ?? [
        MELA.saffron,
        MELA.cream,
      ];
      const st = drawStall(
        { goods: g, stripeA: a, stripeB: b, cloth: MELA.peacock, seed: 300 + i },
        u * 0.62,
      );
      st.view.position.set(-art.w * 0.42 + i * art.w * 0.15, stallY);
      this.view.addChild(st.view);
    });
    const bunting = new Graphics();
    const pts = catenary(
      -art.w * 0.5,
      stallY - art.h * 0.26,
      art.w * 0.15,
      stallY - art.h * 0.24,
      art.h * 0.05,
      24,
    );
    const [p0, ...rest] = pts;
    if (p0) {
      bunting.moveTo(p0.x, p0.y);
      for (const p of rest) bunting.lineTo(p.x, p.y);
      bunting.stroke({ width: 1.5 * u, color: 0x5a4030 });
    }
    const colours = [MELA.vermilion, MELA.marigold, MELA.peacock, MELA.rose, MELA.saffron];
    pts.forEach((p, i) => {
      if (i % 2) return;
      bunting
        .poly([p.x - 9 * u, p.y, p.x + 9 * u, p.y, p.x, p.y + 20 * u])
        .fill(colours[(i / 2) % colours.length] ?? MELA.saffron);
    });
    this.view.addChild(bunting);
    this.body = splitLit(this.view);
    art.ticker.add(this.tick);
  }

  destroy(): void {
    this.art.ticker.remove(this.tick);
    this.view.destroy({ children: true });
  }
}
