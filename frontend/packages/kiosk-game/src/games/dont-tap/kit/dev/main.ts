/**
 * Dev-only entry: runs one set-1 micro-game through the engine's module harness with the real art kit
 * (`MelaArtKit`), the procedural audio engine, the catalogue-timed silent voice, strict event
 * validation and strict 20 mm target checks. Not part of the library build.
 *
 * Query: `module`, `level`, `lang`, `seed`, `form`, `bot=1` (scripted player), `rm=1` (reduced
 * motion), `tier=high|medium|low`, `pxmm=<px per mm>` (default CSS density), `relax=1` (screenshot
 * runs in software rendering: caps x4).
 */
import { validateEventEnvelope } from '@shriii/contracts/validators/event-envelope';
import { gsap } from 'gsap';
import { createArtKit } from '../../../../art/ArtKit.ts';
import { parseQualityTier } from '../../../../art/quality.ts';
import { AudioEngine } from '../../../../audio/AudioEngine.ts';
import { loadGameContent } from '../../../../engine/content.ts';
import { parseModuleHarnessParams } from '../../../../engine/dev-harness.ts';
import { CSS_PX_PER_MM } from '../../../../input/metrics.ts';
import { ajvEventValidator } from '../../../../logging/event-logger.ts';
import { launchModuleHarness } from '../../../../session/module-harness.ts';
import { CatalogueTimedVoice } from '../testing/catalogue-voice.ts';
import { DEV_REGISTRY, devTrialParams } from './registry.ts';

// Headless QA renders slowly in software; keep tweens on wall-clock time so screenshots are accurate.
gsap.ticker.lagSmoothing(0);

async function start(): Promise<void> {
  const host = document.getElementById('host');
  const err = document.getElementById('err');
  if (!host || !err) throw new Error('harness: #host missing');
  const q = new URLSearchParams(location.search);
  if (!q.has('module')) q.set('module', 'dont_tap');
  const content = loadGameContent();
  const params = parseModuleHarnessParams(q, content);
  if (!params) throw new Error('harness: no module');
  if (q.get('relax') === '1') {
    // Software-rendered screenshot runs only (headless Chromium draws a few frames per second, so
    // frame-committed onsets stretch the module): relax the caps of this dev bundle so later phases
    // can be reached. Never used for timing checks (those run on virtual time in the unit tests).
    const budget = content.get(params.moduleId).budget as {
      soft_cap_ms: number;
      hard_cap_ms: number;
    };
    budget.soft_cap_ms *= 4;
    budget.hard_cap_ms *= 4;
  }
  const reducedMotion = q.get('rm') === '1';
  const tier = parseQualityTier(q.get('tier'));
  const pxPerMm = Number(q.get('pxmm') ?? CSS_PX_PER_MM);
  let audio: AudioEngine | null = null;
  const handle = await launchModuleHarness(host, params, {
    registry: DEV_REGISTRY,
    pxPerMm,
    strictTargets: true,
    validate: ajvEventValidator(validateEventEnvelope),
    artFactory: (app, layout) => createArtKit({ app, layout, quality: { tier, reducedMotion } }),
    audioFactory: (clock) => {
      audio = new AudioEngine({ clock });
      return audio;
    },
    voiceFactory: (clock) => new CatalogueTimedVoice(clock, params.language),
  });
  // Audio needs a user gesture (or an autoplay flag in headless Chromium).
  const unlock = (): void => {
    void (audio as AudioEngine | null)?.unlock();
  };
  host.addEventListener('pointerdown', unlock, { once: true });
  unlock();
  (globalThis as { __shriiiTrialParams?: unknown }).__shriiiTrialParams = devTrialParams;
  handle.done.then(
    (r) => {
      err.textContent = '';
      document.body.dataset.harnessResult = r.endedReason;
    },
    (e: unknown) => {
      err.textContent = String(e);
    },
  );
}

start().catch((e: unknown) => {
  const err = document.getElementById('err');
  if (err) err.textContent = e instanceof Error ? (e.stack ?? e.message) : String(e);
  console.error(e);
});
