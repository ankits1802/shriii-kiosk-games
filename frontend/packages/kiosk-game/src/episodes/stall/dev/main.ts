/**
 * Dev-only entry for The Stall (never part of the library or kiosk build). Runs the episode through the
 * real module host with the Mela art kit, a timed silent voice (catalogue target durations), the
 * engine's DomInputService on the page and a strict contract validator, and publishes
 * `globalThis.__stallHarness` for Playwright (debug state, events, trial params).
 *
 * Query: seed, level, lang, form, tier (high|medium|low), reduced=1, speed (dev fast-forward of the
 * session clock, animations and rig ticker), autoplay=1 (an in-page player taps the live targets
 * through the input layer; screenshots only), audio=1 (procedural audio after the first tap),
 * start=<block> / nocap=1 (dev QA: begin at a block, lift the caps), think=<factor> (slower autoplay
 * answers), keep=1 (leave the last frame on screen after the module ends).
 */
import { validateEventEnvelope } from '@shriii/contracts/validators/event-envelope';
import { gsap } from 'gsap';
import { Application, Container } from 'pixi.js';
import 'pixi.js/unsafe-eval';
import { createArtKit } from '../../../art/ArtKit.ts';
import { parseQualityTier } from '../../../art/quality.ts';
import { AudioEngine } from '../../../audio/AudioEngine.ts';
import type { AudioService } from '../../../core/contracts.ts';
import { SessionClock } from '../../../engine/clock.ts';
import { loadGameContent } from '../../../engine/content.ts';
import { parseModuleHarnessParams, runModuleHarness } from '../../../engine/dev-harness.ts';
import { SilentAudioService } from '../../../engine/fallbacks/silent-audio.ts';
import { GameModuleRegistry } from '../../../engine/registry.ts';
import { createSessionRng } from '../../../engine/rng.ts';
import { DomInputService } from '../../../input/input-service.ts';
import { CSS_PX_PER_MM } from '../../../input/metrics.ts';
import { ajvEventValidator } from '../../../logging/event-logger.ts';
import { TimedSilentVoice } from '../../../onboarding/harness/devServices.ts';
import { createHostLayout } from '../../../session/runtime.ts';
import {
  createStallEpisode,
  defaultStallView,
  type StallEpisode,
  type StallEpisodeOptions,
  trialParamsOf,
} from '../index.ts';

gsap.ticker.lagSmoothing(0);
const q = new URLSearchParams(location.search);
const speed = Math.max(0.25, Math.min(8, Number(q.get('speed') ?? 1)));
const host = document.getElementById('host') as HTMLElement;

async function main(): Promise<void> {
  const loaded = loadGameContent();
  // `nocap=1`: lift the soft/hard caps (slow software rendering in headless QA inflates frame waits).
  const content =
    q.get('nocap') === '1'
      ? Object.assign(Object.create(loaded) as typeof loaded, {
          get: (id: Parameters<typeof loaded.get>[0]) => {
            const c = loaded.get(id);
            return id === 'stall'
              ? { ...c, budget: { ...c.budget, soft_cap_ms: 1e8, hard_cap_ms: 1e8 } }
              : c;
          },
        })
      : loaded;
  const query = new URLSearchParams(q);
  query.set('module', 'stall');
  query.delete('bot');
  const params = parseModuleHarnessParams(query, content);
  if (!params) throw new Error('stall dev: params');
  const layout = createHostLayout(host, CSS_PX_PER_MM);
  const app = new Application();
  await app.init({
    resizeTo: host,
    background: 0x1b1838,
    antialias: true,
    autoDensity: true,
    resolution: 1,
  });
  app.canvas.style.position = 'absolute';
  app.canvas.style.inset = '0';
  app.canvas.style.touchAction = 'none';
  host.appendChild(app.canvas);
  app.renderer.on('resize', () => layout.refresh());
  // Dev fast-forward: scale the session clock, GSAP and the Pixi ticker together.
  const t0 = performance.now();
  const scaled = (t: number): number => t0 + (t - t0) * speed;
  const clock = new SessionClock({
    platform: {
      perfNow: () => scaled(performance.now()),
      requestFrame: (cb) => requestAnimationFrame((ts) => cb(scaled(ts))),
      setTimer: (cb, ms) => setTimeout(cb, ms / speed),
    },
  });
  gsap.globalTimeline.timeScale(speed);
  app.ticker.speed = speed;
  const moduleLayer = new Container();
  app.stage.addChild(moduleLayer);
  const kit = createArtKit({
    app,
    layout,
    quality: { tier: parseQualityTier(q.get('tier')), reducedMotion: q.get('reduced') === '1' },
  });
  let audio: AudioService = new SilentAudioService(clock);
  if (q.get('audio') === '1') {
    const engine = new AudioEngine({ clock });
    audio = engine;
    host.addEventListener('pointerdown', () => void engine.unlock(), { once: true });
  }
  const voice = new TimedSilentVoice(params.language, () => clock.now(), 1 / speed);
  const input = new DomInputService({
    clock,
    metrics: layout.metrics,
    element: host,
    stageSize: () => ({ width: layout.width, height: layout.height }),
    safeArea: () => layout.safeArea,
    strictTargets: true,
    voice,
  });
  let episode: StallEpisode | null = null;
  const registry = new GameModuleRegistry({
    stall: () => {
      const start = q.get('start');
      const options: StallEpisodeOptions = start ? { devStartBlock: start } : {};
      episode = createStallEpisode({
        ...options,
        view: (ctx) => {
          const v = defaultStallView(ctx);
          // Exposed for visual-QA probes (dev route only).
          (globalThis as Record<string, unknown>).__stallScene = v;
          // `keep=1`: the scene survives the module's teardown, so the outro's last frame stays up.
          if (q.get('keep') === '1') v.destroy = () => {};
          return v;
        },
      });
      return episode;
    },
  });
  const run = runModuleHarness(params, {
    content,
    registry,
    clock,
    validate: ajvEventValidator(validateEventEnvelope),
    services: {
      app,
      layout,
      audio,
      voice,
      input,
      art: kit,
      createStage: () => {
        const c = new Container();
        moduleLayer.addChild(c);
        return c;
      },
      releaseStage: (c) => {
        // `keep=1` (visual QA): leave the last frame on screen after the module ends.
        if (q.get('keep') === '1') return;
        moduleLayer.removeChild(c);
        c.destroy({ children: true });
      },
    },
  });
  input.setLogger(run.logger);
  const state = { ended: false, result: null as unknown };
  void run.result.then((r) => {
    state.ended = true;
    state.result = r;
    host.dataset.state = 'ended';
  });
  host.dataset.state = 'running';
  (globalThis as Record<string, unknown>).__stallHarness = {
    get debug() {
      return (episode as StallEpisode | null)?.debug ?? null;
    },
    get ended() {
      return state.ended;
    },
    get result() {
      return state.result;
    },
    sessionId: run.sessionId,
    events: () => run.events(),
    trialParams: () => {
      const p = (episode as StallEpisode | null)?.currentPlan;
      return p ? trialParamsOf(p) : {};
    },
    /** Tap a stage point through the input layer at the current session time (dev autoplay). */
    tap: (x: number, y: number) => {
      const rect = host.getBoundingClientRect();
      const ts = clock.anchorPerfMs + clock.now();
      const base = {
        pointerId: Math.floor(Math.random() * 1e6),
        clientX: rect.left + x,
        clientY: rect.top + y,
        pointerType: 'touch' as const,
        width: 8,
        height: 8,
      };
      input.inject({ ...base, kind: 'down', timeStamp: ts });
      input.inject({ ...base, kind: 'up', timeStamp: ts + 50 });
    },
  };
  if (q.get('autoplay') === '1') autoplay(clock, params.seedHex);
}

/** Screenshot autoplay: answers each stimulus after a short think (deterministic per seed). */
function autoplay(clock: SessionClock, seedHex: string): void {
  const rng = createSessionRng(seedHex).stream('dev.autoplay');
  // `think=<factor>` (visual QA): slower answers so slow headless screenshots catch the stimulus.
  const thinkScale = Math.max(0.1, Math.min(10, Number(q.get('think') ?? 1)));
  let answered: string | null = null;
  const h = (globalThis as Record<string, unknown>).__stallHarness as {
    debug: {
      phase: string;
      trialId: string | null;
      expected: string | null;
      targets: Record<string, { x: number; y: number }>;
    } | null;
    tap(x: number, y: number): void;
  };
  const loop = (): void => {
    const d = h.debug;
    if (d && d.phase === 'stimulus' && d.trialId && d.trialId !== answered) {
      answered = d.trialId;
      const ids = Object.keys(d.targets);
      const think =
        (d.expected === 'tone' ? 1400 : d.expected === 'probe' ? 500 : 420) * thinkScale;
      const serve = d.expected === 'serve' ? rng.bool(0.95) : rng.bool(0.15);
      const id =
        d.expected === 'serve' || d.expected === 'withhold'
          ? serve
            ? ids[0]
            : null
          : rng.pick(ids);
      if (id) {
        const at = clock.now() + think;
        const fire = (): void => {
          if (clock.now() < at) {
            requestAnimationFrame(fire);
            return;
          }
          const c = h.debug?.targets[id];
          if (c) h.tap(c.x, c.y);
        };
        requestAnimationFrame(fire);
      }
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

main().catch((err: unknown) => {
  console.error(err);
  host.dataset.state = 'error';
  host.textContent = String(err instanceof Error ? err.stack : err);
  host.style.color = '#fff';
});
