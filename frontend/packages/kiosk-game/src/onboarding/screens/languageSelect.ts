/**
 * ONB-01 Language selection by speaking faces.
 *
 * Native-speaker faces appear in a seeded random order (logged as `face_order`); each greets in turn in
 * its own language with lip-sync and a gentle pulse. Tapping a face plays its confirmation, then a tick
 * confirms (<= 2 taps) or a cross returns to the faces. Emits `language_selected` (BCP-47 code, pack
 * version, manifest hash, taps). Touch only; the microphone stays closed (PRV-03).
 */
import { Container, Graphics } from 'pixi.js';
import { lighten } from '../../art/color.ts';
import { marigold, rgrad } from '../../art/draw.ts';
import { MELA } from '../../art/palettes.ts';
import type { LanguageTag, SessionMachineEvent } from '../../core/contracts.ts';
import type { ScreenKit } from '../ScreenKit.ts';
import type { RichCharacter, SizedButton } from '../types.ts';

/** Line-id suffix for a language tag (`hi-IN` -> `hi_in`). */
export function langKey(lang: LanguageTag): string {
  return lang.toLowerCase().replace(/-/g, '_');
}

/** Villager variant that greets for each language (falls back by position). */
const FACE_VARIANT: Readonly<Record<string, number>> = {
  'hi-IN': 0,
  'mr-IN': 4,
  'ta-IN': 2,
  'en-IN': 7,
};

export interface LanguageSelectResult {
  readonly event: Extract<SessionMachineEvent, { type: 'LANGUAGE_SELECTED' }>;
  readonly faceOrder: readonly LanguageTag[];
  readonly taps: number;
}

/** A face medallion: character bust in a brass ring with a marigold garland. */
function medallion(
  kit: ScreenKit,
  lang: LanguageTag,
  index: number,
  px: number,
): { view: Container; character: RichCharacter; waves: Graphics } {
  const art = kit.services.art;
  const view = new Container();
  const r = px * 0.4;
  const back = new Graphics();
  back.circle(0, 0, r).fill(
    rgrad([
      [0, lighten(MELA.marigold, 0.55)],
      [1, MELA.saffron],
    ]),
  );
  const bust = new Container();
  const ch = art.createCharacter({
    id: `face-${lang}`,
    role: 'customer',
    variant: FACE_VARIANT[lang] ?? index * 3 + 1,
    scale: (px * 0.0047) / art.unit,
  });
  ch.setExpression('calm');
  ch.view.position.set(0, px * 1.18);
  bust.addChild(ch.view);
  const mask = new Graphics().circle(0, 0, r).fill(0xffffff);
  bust.mask = mask;
  const ring = new Graphics();
  ring.circle(0, 0, r).stroke({ width: px * 0.045, color: MELA.brass });
  ring.circle(0, 0, r + px * 0.03).stroke({ width: px * 0.012, color: MELA.brassLight });
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2;
    marigold(
      ring,
      Math.cos(a) * (r + px * 0.045),
      Math.sin(a) * (r + px * 0.045),
      px * 0.032,
      i % 2 === 0 ? MELA.marigold : MELA.vermilion,
    );
  }
  const waves = new Graphics();
  for (let k = 1; k <= 3; k++) {
    waves
      .moveTo(r * 0.95 + k * px * 0.05, -px * 0.08 * k)
      .quadraticCurveTo(r * 1.05 + k * px * 0.08, 0, r * 0.95 + k * px * 0.05, px * 0.08 * k)
      .stroke({ width: px * 0.025, color: MELA.cream, cap: 'round' });
  }
  waves.alpha = 0;
  view.addChild(back, bust, mask, ring, waves);
  return { view, character: ch, waves };
}

/** Run language selection. `initial` is pre-selected when the globe returned here. */
export async function runLanguageSelect(
  kit: ScreenKit,
  initial: LanguageTag | null = null,
): Promise<LanguageSelectResult> {
  const { services, config } = kit;
  kit.clearUi();
  kit.setScene('attract', 'golden_hour');
  const guide = kit.ensureGuide();
  const order = services.rng.shuffle(config.languages);
  const area = kit.contentRect();
  kit.focusPanel();
  const n = order.length;
  const perRow = kit.portrait ? Math.min(2, n) : Math.min(4, n);
  const rows = Math.ceil(n / perRow);
  const sizeMm = Math.min(
    58,
    (area.width / kit.mm(1) - 12 * (perRow - 1)) / perRow,
    (area.height / kit.mm(1) - 50) / rows,
  );
  const px = kit.mm(sizeMm);
  const gap = kit.mm(12);
  const tiles: { lang: LanguageTag; tile: SizedButton; face: ReturnType<typeof medallion> }[] = [];
  order.forEach((lang, i) => {
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    const inRow = Math.min(perRow, n - row * perRow);
    const x = area.x + area.width / 2 + (col - (inRow - 1) / 2) * (px + gap);
    const y = area.y + px / 2 + kit.mm(6) + row * (px + gap);
    const face = medallion(kit, lang, i, px);
    const tile = kit.tile(
      `lang.${langKey(lang)}`,
      face.view,
      sizeMm,
      x,
      y,
      `onboarding.language_face.${langKey(lang)}`,
      MELA.peacock,
    );
    kit.adopt([face.character]);
    tiles.push({ lang, tile, face });
  });

  let taps = 0;
  let chosen: LanguageTag | null = initial;
  let cycling = true;
  // Faces greet one after another, each in its own language.
  const cycle = async (): Promise<void> => {
    let i = 0;
    await kit.pause(600);
    while (cycling) {
      const t = tiles[i % tiles.length];
      i++;
      if (!t) break;
      await services.voice.setLanguage(t.lang);
      // Stop when a face was tapped or the screen was torn down (walkaway, exit).
      if (!cycling || t.tile.view.destroyed) break;
      t.tile.pulse();
      t.face.waves.alpha = 1;
      const pb = services.voice.play(`onboarding.language_face.${langKey(t.lang)}`);
      void t.face.character.speak(pb);
      await pb.ended;
      if (t.face.waves.destroyed) break;
      t.face.waves.alpha = 0;
      if (!cycling) break;
      await kit.pause(700);
      if (config.pacing === 0 && i >= tiles.length) break;
    }
  };

  for (;;) {
    let faceTap: LanguageTag | null = chosen;
    if (!faceTap) {
      cycling = true;
      void cycle();
      const res = await kit.waitTap(tiles.map((t) => t.tile));
      cycling = false;
      services.voice.stop();
      if (res.kind !== 'tap') throw new Error('language selection aborted');
      taps++;
      faceTap = tiles.find((t) => t.tile.targetId === res.tap.targetId)?.lang ?? null;
      services.audio.playSfx('tap');
    }
    chosen = null;
    if (!faceTap) continue;
    const sel = tiles.find((t) => t.lang === faceTap);
    for (const t of tiles) t.tile.setSelected?.(t.lang === faceTap);
    await services.voice.setLanguage(faceTap);
    // Confirmation with tick and cross under the chosen face.
    const by = Math.min(
      area.y + area.height - kit.mm(18),
      (sel?.tile.view.y ?? area.y) + px / 2 + kit.mm(26),
    );
    const cx = area.x + area.width / 2;
    const tick = kit.button(
      {
        id: 'lang.confirm',
        iconId: 'tick',
        audioKey: `onboarding.language_confirm.${langKey(faceTap)}`,
        variant: 'confirm',
        sizeMm: 30,
      },
      cx + kit.mm(24),
      by,
    );
    const cross = kit.button(
      {
        id: 'lang.cancel',
        iconId: 'cross',
        audioKey: 'onboarding.globe_hint',
        variant: 'cancel',
        sizeMm: 30,
      },
      cx - kit.mm(24),
      by,
    );
    if (sel) {
      sel.face.waves.alpha = 1;
      const pb = services.voice.play(`onboarding.language_confirm.${langKey(faceTap)}`);
      void sel.face.character.speak(pb);
      void pb.ended.then(() => {
        // A barge-in tap (confirm or cancel before the line ends) already removed these.
        if (!sel.face.waves.destroyed) sel.face.waves.alpha = 0;
        if (!tick.view.destroyed) tick.pulse();
      });
    }
    const res = await kit.waitTap([tick, cross]);
    if (res.kind !== 'tap') throw new Error('language selection aborted');
    taps++;
    services.voice.stop();
    const confirmed = res.tap.targetId === tick.targetId;
    kit.removeButton(tick);
    kit.removeButton(cross);
    if (confirmed) {
      services.audio.playSfx('confirm');
      kit.logger.log('language_selected', {
        language: faceTap,
        face_order: order as [LanguageTag, ...LanguageTag[]],
        pack_version: config.packVersion,
        manifest_hash: config.manifestHash,
        taps,
      });
      void guide.play('nod');
      kit.clearUi();
      return { event: { type: 'LANGUAGE_SELECTED', language: faceTap }, faceOrder: order, taps };
    }
    services.audio.playSfx('cancel');
    for (const t of tiles) t.tile.setSelected?.(false);
  }
}
