/**
 * Private Dice scene: a quiet, lamp-lit corner of the card tent in the evening, the periphery dimmed ("own corner",
 * KSK-12), the player's own cupped hands holding a carved die, and six picture tiles for the report.
 *
 * Privacy: `showFace(face)` paints pips into a Graphics inside the reveal frame and stores nothing;
 * `hideFace()` clears it. The report tiles are in fixed order 1..6 and nothing is pre-selected.
 */
import { gsap } from 'gsap';
import { Container, Graphics } from 'pixi.js';
import type { ProceduralCharacter } from '../../art/characters/ProceduralCharacter.ts';
import { motionSettings } from '../../art/motion.ts';
import type { Character, UiButton } from '../../core/contracts.ts';
import { popIn, popOut, squash } from '../hub/kit/motion.ts';
import type { GameRuntime } from '../hub/kit/runtime.ts';
import type { GameStage } from '../hub/kit/stage.ts';
import { centerOf } from '../hub/kit/targets.ts';
import { CuppedHands, createDieBlock, createDieFacePicture, drawDieFace } from './art.ts';
import type { PrivateDiceGeometry } from './geometry.ts';

export class PrivateDiceScene {
  readonly guide: Character | null;
  private readonly guideRig: ProceduralCharacter | null;
  private readonly hands: CuppedHands;
  private readonly handsRoot = new Container();
  private readonly dieTop = new Graphics();
  private readonly dieBlock: Container;
  private readonly tiles: UiButton[] = [];
  private onlooker: UiButton | null = null;
  private curtain: Graphics | null = null;
  private destroyed = false;
  private lanternTween: gsap.core.Tween | null = null;

  constructor(
    private readonly stage: GameStage,
    private readonly geo: PrivateDiceGeometry,
    private readonly faces: number,
  ) {
    const { u } = stage;
    // Own corner: the periphery falls away softly while a warm lantern light holds the hands.
    stage.vignette(0.45);
    this.guide = stage.character(
      { id: 'private_dice.guide', role: 'guide', facing: 'right', scale: geo.guideScale },
      { x: -200 * u, y: geo.guide.y },
    );
    this.guideRig = stage.rig(this.guide);
    this.guide.setExpression('calm');
    const pool = stage.lightPool(geo.handsWidth * 0.75, geo.handsWidth * 0.3, 0xffd9a0);
    pool.position.set(geo.handsCenter.x, geo.handsCenter.y + geo.handsWidth * 0.18);
    const lantern = stage.glowSprite(geo.handsWidth * 1.15, 0xffc98a, 0.32);
    lantern.position.set(geo.handsCenter.x, geo.handsCenter.y - geo.handsWidth * 0.05);
    stage.worldFx.addChild(lantern);
    if (!motionSettings.reducedMotion)
      this.lanternTween = gsap.to(lantern, {
        alpha: 0.26,
        duration: 1.7,
        yoyo: true,
        repeat: -1,
        ease: 'sine.inOut',
      });
    stage.ui.addChild(pool);
    this.hands = new CuppedHands(geo.handsWidth);
    this.handsRoot.position.set(geo.handsCenter.x, geo.handsCenter.y);
    this.dieBlock = createDieBlock(geo.handsWidth * 0.22);
    this.dieBlock.position.set(this.hands.seat.x, this.hands.seat.y - geo.handsWidth * 0.04);
    this.dieTop.position.set(this.hands.seat.x, this.hands.seat.y - geo.handsWidth * 0.02);
    this.handsRoot.addChild(this.hands.lower, this.dieBlock, this.dieTop, this.hands.upper);
    this.handsRoot.alpha = 0;
    stage.ui.addChild(this.handsRoot);
    stage.fireflies(
      {
        x: stage.width * 0.1,
        y: stage.height * 0.2,
        width: stage.width * 0.8,
        height: stage.height * 0.5,
      },
      12,
    );
  }

  async intro(rt: GameRuntime): Promise<void> {
    const { stage, geo } = this;
    rt.ctx.audio.setAmbience('quiet', { fadeMs: 1500 });
    void stage.backdrop?.setTimeOfDay('golden_hour', { durationMs: 2000 });
    stage.cameraTo({ x: stage.width / 2, y: stage.height * 0.4, zoom: 1.2 }, 0);
    void stage.cameraTo({ x: stage.width / 2, y: stage.height / 2, zoom: 1 }, 2.6, 'power2.inOut');
    if (this.guideRig) void this.guideRig.walkTo(geo.guide.x);
    else this.guide?.view.position.set(geo.guide.x, geo.guide.y);
    await rt.sleep(1600);
    gsap.to(this.handsRoot, { alpha: 1, duration: 0.6 });
    popIn(this.handsRoot, 0, 0.7);
    this.guide?.setExpression('happy');
    void this.guideRig?.play('namaste');
    await rt.sleep(800);
  }

  /** The "someone watching?" eye (bottom-right). */
  addOnlookerButton(id: string, audioKey: string): void {
    const b = this.stage.art.createIconButton({
      id,
      iconId: 'eye_closed',
      audioKey,
      variant: 'help',
      sizeMm: this.geo.onlooker.width / this.stage.pxPerMm,
    });
    const c = centerOf(this.geo.onlooker);
    b.view.position.set(c.x, c.y);
    b.view.alpha = 0.85;
    this.stage.ui.addChild(b.view);
    this.onlooker = b;
  }

  /** Ready to roll: the closed hands breathe and invite a touch. */
  ready(hint: boolean): void {
    this.dieTop.clear();
    this.dieBlock.visible = true;
    this.hands.upper.position.set(0, 0);
    this.hands.upper.rotation = 0;
    squash(this.handsRoot, 0.04);
    if (hint) this.stage.showHint('tap', this.geo.handsCenter);
  }

  /** Shake: the hands jiggle and the dice rattle. */
  shake(durationMs: number): void {
    this.stage.hideHint();
    this.stage.rt.sfx('dice_shake', { volume: 0.6 });
    if (motionSettings.reducedMotion) return;
    const d = durationMs / 1000;
    gsap
      .timeline()
      .to(this.handsRoot, {
        rotation: 0.08,
        duration: d / 8,
        yoyo: true,
        repeat: 7,
        ease: 'sine.inOut',
      })
      .to(this.handsRoot, { rotation: 0, duration: 0.1 });
    gsap.to(this.handsRoot, {
      y: this.geo.handsCenter.y - 12 * this.stage.u,
      duration: d / 6,
      yoyo: true,
      repeat: 5,
    });
  }

  /**
   * Reveal (inside the reveal frame): the covering hand lifts towards the player and the die's top face
   * shows. `face` is painted and not kept anywhere.
   */
  showFace(face: number): void {
    this.dieBlock.visible = false;
    drawDieFace(this.dieTop, face, this.geo.handsWidth * 0.2);
    this.hands.upper.position.set(0, -this.geo.handsWidth * 0.32);
    this.hands.upper.rotation = -0.12;
    this.hands.upper.alpha = 0.35;
  }

  /** The hands close again; the painted face is cleared. */
  hideFace(): void {
    this.dieTop.clear();
    this.dieBlock.visible = true;
    gsap.to(this.hands.upper, { alpha: 1, duration: 0.15 });
    gsap.to(this.hands.upper.position, { y: 0, duration: 0.18, ease: 'power2.in' });
    gsap.to(this.hands.upper, { rotation: 0, duration: 0.18 });
  }

  /** The six report pictures rise (fixed order, none pre-selected). */
  showTiles(idPrefix: string, audioKey: string): void {
    this.clearTiles();
    for (let k = 1; k <= this.faces; k++) {
      const r = this.geo.faces[k - 1];
      if (!r) continue;
      const pic = createDieFacePicture(k, r.width * 0.62);
      const mela = this.stage.mela;
      const tile: UiButton = mela
        ? mela.createPictureTile(`${idPrefix}${k}`, pic, r.width / this.stage.pxPerMm, 0xc9954f)
        : this.stage.art.createButton({
            id: `${idPrefix}${k}`,
            iconId: 'card',
            audioKey,
            variant: 'secondary',
          });
      const c = centerOf(r);
      tile.view.position.set(c.x, c.y);
      this.stage.ui.addChild(tile.view);
      popIn(tile.view, (k - 1) * 0.04, 0.45);
      this.tiles.push(tile);
    }
  }

  /** A picture was touched: it lifts with its tick badge; the others fade. */
  selectTile(face: number): void {
    this.tiles.forEach((t, i) => {
      if (i === face - 1) {
        (t as { setSelected?: (s: boolean) => void }).setSelected?.(true);
        squash(t.view, 0.12);
      } else gsap.to(t.view, { alpha: 0.35, duration: 0.2 });
    });
    this.stage.rt.sfx('tap', { volume: 0.4 });
  }

  /** Report done: the tiles slip away. */
  async endReport(): Promise<void> {
    await Promise.all(this.tiles.map((t) => popOut(t.view, 0.22)));
    this.clearTiles();
  }

  private clearTiles(): void {
    for (const t of this.tiles.splice(0)) {
      gsap.killTweensOf(t.view);
      gsap.killTweensOf(t.view.scale);
      t.destroy();
    }
  }

  /** "Someone watching?": a soft curtain covers the screen for a moment. */
  hideFromOnlooker(): void {
    if (this.curtain) return;
    const g = new Graphics()
      .rect(0, 0, this.stage.width, this.stage.height)
      .fill({ color: 0x1b1838, alpha: 0.92 });
    g.alpha = 0;
    this.stage.overlay.addChild(g);
    this.curtain = g;
    gsap.to(g, { alpha: 1, duration: 0.2 });
    this.dieTop.clear();
    setTimeout(() => {
      if (this.destroyed) return;
      gsap.to(g, {
        alpha: 0,
        duration: 0.6,
        onComplete: () => {
          g.destroy();
          this.curtain = null;
        },
      });
    }, 1400);
  }

  async outro(): Promise<void> {
    const { stage } = this;
    this.clearTiles();
    gsap.to(this.handsRoot, { alpha: 0, duration: 0.5 });
    this.guide?.setExpression('happy');
    void this.guideRig?.play('namaste');
    stage.burst('sparkle', { x: stage.width / 2, y: stage.height * 0.4 }, 30);
    stage.rt.sfx('chime', { volume: 0.5 });
    await stage.cameraTo(
      { x: stage.width / 2, y: stage.height * 0.5, zoom: 1.05 },
      1.2,
      'power2.out',
    );
  }

  destroy(): void {
    this.destroyed = true;
    this.lanternTween?.kill();
    this.dieTop.clear();
    this.clearTiles();
    this.onlooker?.destroy();
    gsap.killTweensOf(this.handsRoot);
    gsap.killTweensOf(this.hands.upper);
    gsap.killTweensOf(this.hands.upper.position);
  }
}
