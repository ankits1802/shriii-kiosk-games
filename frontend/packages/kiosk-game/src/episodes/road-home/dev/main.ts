/**
 * Dev-only entry: runs The Road Home standalone through the real module harness with the Mela art
 * kit and the procedural audio engine. Not part of the library build.
 *
 *   ?module=road_home&level=L2&lang=en-IN&seed=123[&bot=1][&tier=medium][&reducedMotion]
 *
 * The harness state (events, result) is published on `globalThis.__shriiiHarness` for Playwright.
 */
import { validateEventEnvelope } from '@shriii/contracts/validators/event-envelope';
import { gsap } from 'gsap';
import { createArtKit } from '../../../art/ArtKit.ts';
import { parseQualityTier } from '../../../art/quality.ts';
import { AudioEngine } from '../../../audio/AudioEngine.ts';
import { loadGameContent } from '../../../engine/content.ts';
import { parseModuleHarnessParams } from '../../../engine/dev-harness.ts';
import { SilentVoiceService } from '../../../engine/fallbacks/silent-audio.ts';
import { GameModuleRegistry } from '../../../engine/registry.ts';
import { ajvEventValidator } from '../../../logging/event-logger.ts';
import { launchModuleHarness } from '../../../session/module-harness.ts';
import { createRoadHomeEpisode } from '../index.ts';
import { StillModule } from './stills.ts';

gsap.ticker.lagSmoothing(0);
// Software-GL CI runs: speed up decorative animation only (windows and timers are untouched).
const fast = Number(new URLSearchParams(location.search).get('fast') ?? '1');
if (fast > 1) gsap.globalTimeline.timeScale(fast);

const host = document.getElementById('host') as HTMLElement;
const err = document.getElementById('err') as HTMLElement;
const query = new URLSearchParams(location.search);
if (!query.has('module')) query.set('module', 'road_home');
const params = parseModuleHarnessParams(query, loadGameContent());
if (!params) throw new Error('missing module parameter');

let episode: ReturnType<typeof createRoadHomeEpisode> | null = null;
const still = query.get('still');
const registry = new GameModuleRegistry({
  road_home: () => {
    if (still) return new StillModule(still, host);
    episode = createRoadHomeEpisode();
    return episode;
  },
});
// Trial params of the running plan (the scorer's join table) for the Playwright export.
Object.defineProperty(globalThis, '__roadHomePlanParams', {
  get: () => episode?.currentPlan?.trialParams ?? null,
});
let audio: AudioEngine | null = null;
const handle = await launchModuleHarness(host, params, {
  registry,
  strictTargets: true,
  validate: ajvEventValidator(validateEventEnvelope),
  artFactory: (app, layout) =>
    createArtKit({
      app,
      layout,
      quality: {
        tier: parseQualityTier(query.get('tier')),
        reducedMotion: query.has('reducedMotion'),
      },
    }),
  audioFactory: (clock) => {
    audio = new AudioEngine({ clock });
    return audio;
  },
  voiceFactory: (clock) =>
    new SilentVoiceService(clock, { lineMs: Number(query.get('lineMs') ?? 2400) }),
});
const unlock = (): void => void (audio as AudioEngine | null)?.unlock().catch(() => undefined);
host.addEventListener('pointerdown', unlock, { once: true });
unlock();
handle.done.then(
  (r) => {
    host.dataset.result = JSON.stringify(r);
  },
  (e: unknown) => {
    err.textContent = String(e);
  },
);
window.addEventListener('error', (e) => {
  err.textContent += `\n${e.message}`;
});
window.addEventListener('unhandledrejection', (e) => {
  err.textContent += `\n${String((e as PromiseRejectionEvent).reason)}`;
});
