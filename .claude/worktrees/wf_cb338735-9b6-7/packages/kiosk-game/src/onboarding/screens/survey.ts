/**
 * ONB-07 micro-survey (enjoyment on three faces; play again as tick or cross; skippable; 10 s timeout)
 * and ONB-03 contact opt-in (one yes/no after the report; timeout or skip counts as "no"; touch only).
 *
 * Emits `survey.enjoy`, `survey.play_again` and `optin.contact` (boolean only: contact details never
 * enter event tables).
 */
import { Container } from 'pixi.js';
import { MELA } from '../../art/palettes.ts';
import { drawIcon } from '../../art/ui/icons.ts';
import type { SessionMachineEvent } from '../../core/contracts.ts';
import type { ScreenKit } from '../ScreenKit.ts';
import type { SizedButton } from '../types.ts';

export interface SurveyResult {
  readonly event: Extract<SessionMachineEvent, { type: 'SURVEY_DONE' }>;
  readonly enjoy: 'happy' | 'neutral' | 'sad' | 'skipped';
  readonly playAgain: 'yes' | 'no' | 'skipped';
}

function faceTile(
  kit: ScreenKit,
  id: string,
  icon: string,
  sizeMm: number,
  x: number,
  y: number,
): SizedButton {
  const pic = new Container();
  pic.addChild(drawIcon(icon, kit.mm(sizeMm) * 0.78, MELA.ink));
  return kit.tile(id, pic, sizeMm, x, y, 'survey.enjoy', MELA.marigold);
}

export async function runSurvey(kit: ScreenKit): Promise<SurveyResult> {
  const { services, config } = kit;
  kit.clearUi();
  kit.setScene('report', 'dusk');
  const guide = kit.ensureGuide();
  guide.setExpression('happy');
  const area = kit.contentRect();
  kit.focusPanel();
  const cx = area.x + area.width / 2;
  const cy = area.y + area.height * 0.42;
  const size = 42;
  const step = kit.mm(size) + kit.mm(14);
  const faces = [
    { code: 'happy', icon: 'face_happy' },
    { code: 'neutral', icon: 'face_neutral' },
    { code: 'sad', icon: 'face_sad' },
  ] as const;
  const tiles = faces.map((f, i) =>
    faceTile(kit, `survey.enjoy.${f.code}`, f.icon, size, cx + (i - 1) * step, cy),
  );
  const skip = kit.button(
    {
      id: 'survey.skip',
      iconId: 'skip',
      audioKey: 'survey.enjoy',
      variant: 'secondary',
      sizeMm: 24,
    },
    area.x + area.width - kit.mm(18),
    area.y + area.height - kit.mm(18),
  );
  void kit.say('survey.enjoy');
  const r1 = await kit.waitTap([...tiles, skip], config.surveyTimeoutMs);
  kit.ensureActive();
  let enjoy: SurveyResult['enjoy'] = 'skipped';
  if (r1.kind === 'tap' && r1.tap.targetId !== skip.targetId) {
    const idx = tiles.findIndex((t) => t.targetId === r1.tap.targetId);
    enjoy = faces[idx]?.code ?? 'skipped';
    tiles[idx]?.setSelected?.(true);
    services.audio.playSfx('confirm');
  } else {
    services.audio.playSfx('tap_soft');
  }
  services.voice.stop();
  kit.logger.log('survey.enjoy', { face: enjoy });
  await kit.pause(500);
  kit.ensureActive();
  kit.clearUi();
  kit.focusPanel();

  const yes = kit.button(
    {
      id: 'survey.again.yes',
      iconId: 'tick',
      audioKey: 'survey.play_again',
      variant: 'confirm',
      sizeMm: 38,
    },
    cx + kit.mm(34),
    cy,
  );
  const no = kit.button(
    {
      id: 'survey.again.no',
      iconId: 'cross',
      audioKey: 'survey.play_again',
      variant: 'cancel',
      sizeMm: 38,
    },
    cx - kit.mm(34),
    cy,
  );
  const skip2 = kit.button(
    {
      id: 'survey.skip2',
      iconId: 'skip',
      audioKey: 'survey.play_again',
      variant: 'secondary',
      sizeMm: 24,
    },
    area.x + area.width - kit.mm(18),
    area.y + area.height - kit.mm(18),
  );
  const icon = new Container();
  icon.addChild(drawIcon('repeat', kit.mm(26), MELA.cream));
  icon.position.set(cx, cy - kit.mm(36));
  kit.ui.addChild(icon);
  void kit.say('survey.play_again');
  const r2 = await kit.waitTap([yes, no, skip2], config.surveyTimeoutMs);
  kit.ensureActive();
  const playAgain: SurveyResult['playAgain'] =
    r2.kind === 'tap' && r2.tap.targetId === yes.targetId
      ? 'yes'
      : r2.kind === 'tap' && r2.tap.targetId === no.targetId
        ? 'no'
        : 'skipped';
  services.voice.stop();
  services.audio.playSfx(playAgain === 'skipped' ? 'tap_soft' : 'confirm');
  kit.logger.log('survey.play_again', { answer: playAgain });
  kit.clearUi();
  return { event: { type: 'SURVEY_DONE' }, enjoy, playAgain };
}

export interface ContactOptInResult {
  readonly event: Extract<SessionMachineEvent, { type: 'OPTIN_DONE' }>;
}

/** One yes/no for later contact (default no). Number entry is handled by the vault flow (ONB-03). */
export async function runContactOptIn(kit: ScreenKit): Promise<ContactOptInResult> {
  const { services, config } = kit;
  kit.clearUi();
  kit.setScene('report', 'dusk');
  kit.ensureGuide().setExpression('calm');
  const area = kit.contentRect();
  kit.focusPanel();
  const cx = area.x + area.width / 2;
  const cy = area.y + area.height * 0.48;
  const phone = new Container();
  phone.addChild(drawIcon('phone', kit.mm(30), MELA.cream));
  phone.position.set(cx, cy - kit.mm(40));
  kit.ui.addChild(phone);
  const yes = kit.button(
    {
      id: 'optin.contact.yes',
      iconId: 'tick',
      audioKey: 'optin.contact.question',
      variant: 'confirm',
      sizeMm: 36,
    },
    cx + kit.mm(32),
    cy,
  );
  const no = kit.button(
    {
      id: 'optin.contact.no',
      iconId: 'cross',
      audioKey: 'optin.contact.question',
      variant: 'cancel',
      sizeMm: 36,
    },
    cx - kit.mm(32),
    cy,
  );
  void kit.say('optin.contact.question');
  const r = await kit.waitTap([yes, no], config.optInTimeoutMs);
  kit.ensureActive();
  const granted = r.kind === 'tap' && r.tap.targetId === yes.targetId;
  services.voice.stop();
  services.audio.playSfx(granted ? 'confirm' : 'tap_soft');
  kit.logger.log('optin.contact', { granted });
  if (granted) await kit.say('optin.thanks');
  kit.clearUi();
  return { event: { type: 'OPTIN_DONE', contactOptIn: granted } };
}
