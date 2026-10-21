/**
 * ONB-02 Spoken consent with mandatory tap (adults only).
 *
 * Four pictogram segments (what we play; what we keep + no audio kept; stop anytime + erasure; report
 * use + "a snapshot, not a diagnosis"), each spoken by the guide and replayable (replays counted per
 * segment). A row of diyas lights up as segments progress (no numerals). Only a tap on the big tick
 * commits consent; the cross declines. The archive opt-in is a separate question (default no).
 *
 * Emits `consent.granted` {tap_confirmed: true, script id, version hash, replay counts, policy version}
 * and `optin.archive`, or `consent.declined`. The microphone is never opened (VOX-04: consent is touch only).
 */
import { gsap } from 'gsap';
import { Container, Graphics } from 'pixi.js';
import { glowDisc } from '../../art/draw.ts';
import { MELA } from '../../art/palettes.ts';
import { drawIcon } from '../../art/ui/icons.ts';
import type { SessionMachineEvent } from '../../core/contracts.ts';
import { type ConsentTopic, consentPictogram } from '../pictograms.ts';
import type { ScreenKit } from '../ScreenKit.ts';
import type { SizedButton, WithGlobe } from '../types.ts';

/** Segment -> topics shown (two cards at most). */
export const CONSENT_SEGMENTS: readonly (readonly ConsentTopic[])[] = [
  ['play'],
  ['keep', 'no_audio'],
  ['stop', 'erase'],
  ['report', 'snapshot'],
];

export type ConsentResult =
  | {
      readonly event: Extract<SessionMachineEvent, { type: 'CONSENT_GRANTED' }>;
      readonly replayCounts: readonly number[];
    }
  | {
      readonly event: Extract<SessionMachineEvent, { type: 'CONSENT_DECLINED' }>;
      readonly replayCounts: readonly number[];
    };

function progressLamps(kit: ScreenKit, count: number): { view: Container; light(i: number): void } {
  const view = new Container();
  const lamps: { glow: Graphics }[] = [];
  const size = kit.mm(16);
  for (let i = 0; i < count; i++) {
    const c = new Container();
    const glow = new Graphics();
    glowDisc(glow, size * 0.18, -size * 0.32, size * 0.9, 0xffb347, 1);
    glow.alpha = 0;
    glow.blendMode = 'add';
    c.addChild(glow, drawIcon('diya', size, MELA.terracotta));
    c.position.set((i - (count - 1) / 2) * size * 1.5, 0);
    view.addChild(c);
    lamps.push({ glow });
  }
  return {
    view,
    light: (i: number) => {
      const l = lamps[i];
      if (l) gsap.to(l.glow, { alpha: 1, duration: 0.6, ease: 'sine.out' });
    },
  };
}

/** Run consent. Returns GLOBE when the player asked to change language (before consent only). */
export async function runConsent(kit: ScreenKit): Promise<WithGlobe<ConsentResult>> {
  const { services, config } = kit;
  kit.clearUi();
  kit.setScene('attract', 'golden_hour');
  const guide = kit.ensureGuide();
  guide.setExpression('calm');
  const area = kit.contentRect();
  const replayCounts = CONSENT_SEGMENTS.map(() => 0);
  const lamps = progressLamps(kit, CONSENT_SEGMENTS.length);
  lamps.view.position.set(
    area.x + area.width / 2,
    Math.min(
      kit.height - kit.mm(14),
      area.y + kit.mm(22) + Math.min(kit.mm(62), area.width / 2.6) + kit.mm(24),
    ),
  );
  kit.focusPanel();
  kit.ui.addChild(lamps.view);
  const globe = kit.iconButton(
    { id: 'consent.globe', iconId: 'globe', audioKey: 'onboarding.globe_hint', sizeMm: 22 },
    kit.globePos().x,
    kit.globePos().y,
  );
  const cardsLayer = new Container();
  kit.ui.addChild(cardsLayer);

  const showSegment = (seg: number): void => {
    for (const c of cardsLayer.removeChildren()) c.destroy({ children: true });
    const topics = CONSENT_SEGMENTS[seg] ?? [];
    const cardPx = Math.min(kit.mm(62), area.width / (topics.length + 0.6));
    topics.forEach((t, i) => {
      const card = new Container();
      const g = new Graphics();
      g.roundRect(-cardPx / 2, -cardPx / 2 + cardPx * 0.04, cardPx, cardPx, cardPx * 0.14).fill({
        color: MELA.ink,
        alpha: 0.25,
      });
      g.roundRect(-cardPx / 2, -cardPx / 2, cardPx, cardPx, cardPx * 0.14)
        .fill(0xfffaf0)
        .stroke({ width: cardPx * 0.025, color: MELA.saffron });
      card.addChild(g, consentPictogram(t, cardPx).view);
      card.position.set(
        area.x + area.width / 2 + (i - (topics.length - 1) / 2) * (cardPx + kit.mm(10)),
        area.y + kit.mm(22) + cardPx / 2,
      );
      card.scale.set(0.85);
      card.alpha = 0;
      cardsLayer.addChild(card);
      gsap.to(card, { alpha: 1, duration: 0.35, delay: i * 0.12 });
      gsap.to(card.scale, { x: 1, y: 1, duration: 0.5, delay: i * 0.12, ease: 'back.out(1.8)' });
    });
  };

  // Segments: speak each; the replay button replays the current one; tapping the globe leaves.
  const replay = kit.iconButton(
    { id: 'consent.replay', iconId: 'replay', audioKey: 'consent.core.segment_1', sizeMm: 24 },
    area.x + area.width - kit.mm(16),
    area.y + kit.mm(6),
  );
  for (let seg = 0; seg < CONSENT_SEGMENTS.length; seg++) {
    showSegment(seg);
    lamps.light(seg);
    const line = `consent.core.segment_${seg + 1}`;
    void guide.play(seg % 2 === 0 ? 'point' : 'nod');
    let voiceDone = kit.say(line);
    // While the segment plays (and during a short breath after it) the player may replay it or leave
    // through the globe.
    for (;;) {
      const r = await kit.tapOr(
        [replay, globe],
        voiceDone.then(() => kit.pause(900)),
      );
      kit.ensureActive();
      if (r === null || r.kind !== 'tap') break;
      if (r.tap.targetId === globe.targetId) {
        services.voice.stop();
        return { type: 'GLOBE' };
      }
      replayCounts[seg] = (replayCounts[seg] ?? 0) + 1;
      kit.logger.log('ui.replay', { target_id: replay.targetId });
      voiceDone = kit.say(line, { replay: true });
    }
  }

  // The question: big tick and cross. Only a tap commits.
  for (const c of cardsLayer.removeChildren()) c.destroy({ children: true });
  const yQ = area.y + area.height * 0.55;
  const cx = area.x + area.width / 2;
  const yes = kit.button(
    {
      id: 'consent.yes',
      iconId: 'tick',
      audioKey: 'consent.core.question',
      variant: 'confirm',
      sizeMm: 44,
    },
    cx + kit.mm(40),
    yQ,
  );
  const no = kit.button(
    {
      id: 'consent.no',
      iconId: 'cross',
      audioKey: 'consent.core.question',
      variant: 'cancel',
      sizeMm: 44,
    },
    cx - kit.mm(40),
    yQ,
  );
  void kit.say('consent.core.question').then(() => yes.pulse());
  let answer: SizedButton | null = null;
  for (;;) {
    const r = await kit.waitTap([yes, no, globe, replay]);
    if (r.kind !== 'tap') throw new Error('consent aborted');
    if (r.tap.targetId === globe.targetId) {
      services.voice.stop();
      return { type: 'GLOBE' };
    }
    if (r.tap.targetId === replay.targetId) {
      kit.logger.log('ui.replay', { target_id: replay.targetId });
      void kit.say('consent.core.question', { replay: true });
      continue;
    }
    answer = r.tap.targetId === yes.targetId ? yes : no;
    break;
  }
  services.voice.stop();
  const counts = replayCounts as [number, ...number[]];
  if (answer === no) {
    services.audio.playSfx('cancel');
    kit.logger.log('consent.declined', {
      consent_kind: 'core',
      tap_confirmed: true,
      consent_script_id: config.consentScriptId,
      replay_counts: counts,
    });
    kit.clearUi();
    guide.setExpression('calm');
    await kit.say('consent.declined_thanks');
    return { event: { type: 'CONSENT_DECLINED' }, replayCounts: counts };
  }
  services.audio.playSfx('confirm');
  kit.logger.log('consent.granted', {
    consent_kind: 'core',
    tap_confirmed: true,
    consent_script_id: config.consentScriptId,
    consent_version_hash: config.consentVersionHash,
    replay_counts: counts,
    policy_version: config.policyVersion,
  });
  guide.setExpression('happy');
  void guide.play('nod');
  kit.removeButton(yes);
  kit.removeButton(no);

  // Separate archive opt-in (default no; touch only).
  const aYes = kit.button(
    {
      id: 'archive.yes',
      iconId: 'tick',
      audioKey: 'consent.archive.question',
      variant: 'confirm',
      sizeMm: 36,
    },
    cx + kit.mm(34),
    yQ,
  );
  const aNo = kit.button(
    {
      id: 'archive.no',
      iconId: 'cross',
      audioKey: 'consent.archive.question',
      variant: 'cancel',
      sizeMm: 36,
    },
    cx - kit.mm(34),
    yQ,
  );
  const chest = new Container();
  chest.addChild(drawIcon('chest', kit.mm(30), MELA.wood));
  chest.position.set(cx, yQ - kit.mm(40));
  kit.ui.addChild(chest);
  void kit.say('consent.archive.question');
  const ar = await kit.waitTap([aYes, aNo], config.optInTimeoutMs);
  kit.ensureActive();
  const archiveOptIn = ar.kind === 'tap' && ar.tap.targetId === aYes.targetId;
  services.voice.stop();
  services.audio.playSfx(archiveOptIn ? 'confirm' : 'tap_soft');
  kit.logger.log('optin.archive', { granted: archiveOptIn });
  kit.clearUi();
  return {
    event: { type: 'CONSENT_GRANTED', tapConfirmed: true, archiveOptIn },
    replayCounts: counts,
  };
}
