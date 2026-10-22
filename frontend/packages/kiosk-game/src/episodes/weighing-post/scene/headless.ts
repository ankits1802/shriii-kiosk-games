/**
 * Headless presentation for bots and tests (ENG-05: any module runs headlessly). It lays out exactly
 * the same touch slots as the rendered scene but draws nothing. Like the rendered scene it never keeps
 * the private die face.
 */
import type { Layout, Rect } from '../../../core/contracts.ts';
import { choiceSlots, confirmAbove, controlRects, geometry, type SceneGeometry } from './layout.ts';
import type { ChoiceKind, ChoiceSlot, ControlRects, WeighingScene } from './types.ts';

export class HeadlessWeighingScene implements WeighingScene {
  readonly renders = false;
  private readonly geo: SceneGeometry;
  /** Count of private faces shown (never the faces themselves); lets tests assert reveals happened. */
  revealCount = 0;

  constructor(layout: Pick<Layout, 'width' | 'height' | 'metrics' | 'safeArea'>) {
    this.geo = geometry(layout);
  }

  async mount(): Promise<void> {}
  setProgress(): void {}
  controls(): ControlRects {
    return controlRects(this.geo);
  }
  confirmFor(token: Rect): Rect {
    return confirmAbove(this.geo, token);
  }
  layoutChoices(kind: ChoiceKind, codes: readonly string[]): readonly ChoiceSlot[] {
    return choiceSlots(this.geo, kind, codes);
  }
  showChoices(): void {}
  setChoiceState(): void {}
  commitChoice(): void {}
  hideChoices(): void {}
  setInspectVisible(): void {}
  intro(): void {}
  outro(): void {}
  practiceHint(): void {}
  clearHints(): void {}
  weighPrepare(): void {}
  weighReveal(): void {}
  reweigh(): void {}
  weighOutcome(): void {}
  dilemmaPrepare(): void {}
  dilemmaReveal(): void {}
  dilemmaOutcome(): void {}
  gamblePrepare(): void {}
  gambleReveal(): void {}
  gambleOutcome(): void {}
  luckBegin(): void {}
  luckRoll(): void {}
  luckShowFace(_face: number): void {
    this.revealCount += 1;
  }
  luckOutcome(): void {}
  luckClear(): void {}
  luckEnd(): void {}
  newRuleAnnounce(): void {}
  newRuleDone(): void {}
  probeBegin(): void {}
  probePrepare(): void {}
  probeReveal(): void {}
  probeOutcome(): void {}
  probeEnd(): void {}
  speaker(): void {}
  destroy(): void {}
}
