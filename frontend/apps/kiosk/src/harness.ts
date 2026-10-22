/**
 * Module dev harness inside the kiosk app (dev and bridge builds only): runs one registered module
 * standalone with the Mela art kit, the procedural audio engine and strict event validation, and
 * publishes `globalThis.__shriiiHarness` for scripted bots and screenshots.
 *
 * Query: module, level, lang, seed, form, pathway (see parseModuleHarnessParams).
 */
import {
  ajvEventValidator,
  launchModuleHarness,
  loadGameContent,
  parseModuleHarnessParams,
} from '@shriii/kiosk-game';
import { createArtKit } from '@shriii/kiosk-game/art';
import { AudioEngine } from '@shriii/kiosk-game/audio';

export async function startHarness(container: HTMLElement, search: string): Promise<void> {
  const [{ validateEventEnvelope }] = await Promise.all([
    import('@shriii/contracts/validators/event-envelope'),
  ]);
  const params = parseModuleHarnessParams(search, loadGameContent());
  if (!params) throw new Error('harness: no module');
  container.style.position = 'fixed';
  container.style.inset = '0';
  let audio: AudioEngine | null = null;
  const handle = await launchModuleHarness(container, params, {
    strictTargets: true,
    validate: ajvEventValidator(validateEventEnvelope),
    artFactory: (app, layout) => createArtKit({ app, layout }),
    audioFactory: (clock) => {
      audio = new AudioEngine({ clock });
      return audio;
    },
  });
  container.addEventListener('pointerdown', () => void (audio as AudioEngine | null)?.unlock(), {
    once: true,
  });
  void handle.done.then((r) => {
    document.body.dataset.harnessResult = r.endedReason;
  });
}
