/**
 * Dev harness page for The Weighing Post: runs the episode standalone through the real module host
 * with the Mela art kit, the procedural audio engine, strict event validation and (with `bot=1`) the
 * scripted bot. Publishes `globalThis.__wp` for the screenshot / playthrough script.
 * Dev only: never imported by an app build.
 */
import type { EventEnvelope } from '@shriii/contracts';
import { validateEventEnvelope } from '@shriii/contracts/validators/event-envelope';
import { MelaArtKit } from '../../../art/ArtKit.ts';
import { parseQualityTier } from '../../../art/quality.ts';
import { AudioEngine } from '../../../audio/AudioEngine.ts';
import type { Clock, LineId } from '../../../core/contracts.ts';
import { loadGameContent } from '../../../engine/content.ts';
import { parseModuleHarnessParams } from '../../../engine/dev-harness.ts';
import { SilentVoiceService } from '../../../engine/fallbacks/silent-audio.ts';
import { CSS_PX_PER_MM } from '../../../input/metrics.ts';
import { ajvEventValidator } from '../../../logging/event-logger.ts';
import { launchModuleHarness } from '../../../session/module-harness.ts';
import { createHostLayout } from '../../../session/runtime.ts';
import { LINES } from '../../../voice/catalogue/lines.generated.ts';
import { createWeighingPost } from '../index.ts';
import { choiceSlots, confirmAbove, controlRects, geometry } from '../scene/layout.ts';
import type { ChoiceKind } from '../scene/types.ts';
import { type EpisodePlan, trialParamsOf } from '../schedule.ts';

/** Silent dev voice that only "has" catalogued lines (like the manifest voice in production). */
class CatalogueVoice extends SilentVoiceService {
  override has(lineId: LineId): boolean {
    return Object.hasOwn(LINES, lineId);
  }
}

const q = new URLSearchParams(location.search);
const err = document.getElementById('err');
const host = document.getElementById('host');
const reduced = q.get('reduced') === '1';

async function main(): Promise<void> {
  if (!host) throw new Error('#host missing');
  const content = loadGameContent();
  const query = new URLSearchParams({
    module: 'weighing_post',
    level: q.get('level') ?? 'L2',
    lang: q.get('lang') ?? 'en-IN',
    seed: q.get('seed') ?? '123',
    pathway: 'A',
  });
  if (q.get('form')) query.set('form', q.get('form') ?? '');
  if (q.get('bot') === '1') query.set('bot', '1');
  const params = parseModuleHarnessParams(query, content);
  if (!params) throw new Error('harness params');
  let plan: EpisodePlan | null = null;
  let audio: AudioEngine | null = null;
  const handle = await launchModuleHarness(host, params, {
    registry: {
      weighing_post: () =>
        createWeighingPost({
          onPlan: (p) => {
            plan = p;
          },
          scene: { reducedMotion: reduced },
        }),
    },
    artFactory: (app, layout) =>
      new MelaArtKit({
        app,
        layout,
        quality: { tier: parseQualityTier(q.get('tier')), reducedMotion: reduced },
      }),
    audioFactory: (clock: Clock) => {
      audio = new AudioEngine({ clock });
      return audio;
    },
    voiceFactory: (clock: Clock) =>
      new CatalogueVoice(clock, { lineMs: Number(q.get('lineMs') ?? 1400) }),
    validate: ajvEventValidator(validateEventEnvelope),
    strictTargets: true,
  });
  host.addEventListener('pointerdown', () => void audio?.unlock(), { once: true });
  // Same layout maths as the episode (used by the player script to tap like a player).
  const layout = createHostLayout(host, CSS_PX_PER_MM);
  const rects = (kind: ChoiceKind, codes: readonly string[]) => {
    layout.refresh();
    const geo = geometry(layout);
    const slots = choiceSlots(geo, kind, codes);
    return {
      slots,
      confirm: Object.fromEntries(slots.map((sl) => [sl.code, confirmAbove(geo, sl.rect)])),
      controls: controlRects(geo),
    };
  };
  const g = globalThis as { __wp?: unknown };
  g.__wp = {
    handle,
    state: () => handle.state,
    result: () => handle.result,
    plan: () => plan,
    trialParams: () => (plan ? { [handle.run.sessionId]: trialParamsOf(plan) } : {}),
    events: (): Promise<EventEnvelope[]> => handle.events(),
    rects,
  };
  handle.done.catch((e: unknown) => {
    if (err) err.textContent = String(e);
  });
}

main().catch((e: unknown) => {
  console.error(e);
  if (err) err.textContent = e instanceof Error ? (e.stack ?? e.message) : String(e);
});
