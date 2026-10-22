/**
 * Dev entry for the set-2 micro-games and the carousel hub (visual QA, screenshots, bot playthroughs).
 * Never part of a production bundle. URL parameters:
 *
 *   ?module=share_pot|steady_hands|four_stalls|private_dice  run one module through the real module host
 *   &level=L1|L2|L3  &lang=en-IN  &seed=123  &form=form_1
 *   &bot=1           scripted bot plays (DevFlags.headless) through real pointer events
 *   &tier=high|medium|low  &reducedMotion   art quality tier / reduced-motion tier
 *   &bench=1         certified *synthetic* timing profile (bot verification runs only)
 *   &headset=1 &site=open_public   private-report rules
 *   ?carousel=1&slot=<slot>  the hub plus set-2 modules in one synthetic session (placeholders for
 *                            core modules owned elsewhere unless &only=set2)
 *   ?hub=1&at=<0..5>&slot=<slot>  just the fair-map bridge into booth `at`
 *
 * State for tooling is published on `window.__set2`.
 */
import type { EventEnvelope } from '@shriii/contracts';
import { validateEventEnvelope } from '@shriii/contracts/validators/event-envelope';
import { gsap } from 'gsap';
import { Application, Container } from 'pixi.js';
import 'pixi.js/unsafe-eval';
import type { CalibrationLevel, SlotForm } from '@shriii/contracts';
import { createArtKit } from '../../../art/ArtKit.ts';
import { parseQualityTier } from '../../../art/quality.ts';
import { AudioEngine } from '../../../audio/AudioEngine.ts';
import type { ModuleId, ModuleResult, SiteMode, TimingProfile } from '../../../core/contracts.ts';
import { SessionClock } from '../../../engine/clock.ts';
import type { GameContent } from '../../../engine/content.ts';
import { loadGameContent } from '../../../engine/content.ts';
import { seedFromParam } from '../../../engine/dev-harness.ts';
import type { PlayServices } from '../../../engine/module-host.ts';
import { GameModuleRegistry } from '../../../engine/registry.ts';
import { createSessionRng } from '../../../engine/rng.ts';
import { DomInputService } from '../../../input/input-service.ts';
import { CSS_PX_PER_MM } from '../../../input/metrics.ts';
import { ajvEventValidator } from '../../../logging/event-logger.ts';
import { TimedSilentVoice } from '../../../onboarding/harness/devServices.ts';
import { createHostLayout } from '../../../session/runtime.ts';
import { CarouselHubRunner, carouselOrder } from '../CarouselHubRunner.ts';
import type { PhaseInfo } from '../kit/runtime.ts';
import { type Set2Module, set2ModuleFactories } from '../modules.ts';
import { runSet2Session } from '../session-run.ts';

// Headless QA renders slowly in software; keep tweens on wall-clock time so screenshots are accurate.
gsap.ticker.lagSmoothing(0);

/** Synthetic certified profile for bot verification runs only (never a real SKU certification). */
const BENCH_PROFILE: TimingProfile = {
  version: 'dev-bench-synthetic',
  certified: true,
  displayOffsetMs: 0,
  audioOutputOffsetMs: 0,
  touchOffsetMs: 0,
  refreshHz: 60,
};

interface Set2DevState {
  state: 'loading' | 'running' | 'ended' | 'error';
  phase: string;
  phases: PhaseInfo[];
  result: ModuleResult | null;
  results: ModuleResult[];
  error: string | null;
  sessionId: string | null;
  events(): Promise<EventEnvelope[]>;
  trialParams(): Record<string, Record<string, unknown>>;
}

const dev: Set2DevState = {
  state: 'loading',
  phase: 'loading',
  phases: [],
  result: null,
  results: [],
  error: null,
  sessionId: null,
  events: async () => [],
  trialParams: () => ({}),
};
(globalThis as { __set2?: Set2DevState }).__set2 = dev;

async function main(): Promise<void> {
  const host = document.getElementById('host');
  if (!host) throw new Error('set2 dev: #host missing');
  const q = new URLSearchParams(location.search);
  const content = loadGameContent();
  const pxPerMm = Number(q.get('pxPerMm') ?? CSS_PX_PER_MM);
  const layout = createHostLayout(host, pxPerMm);
  const app = new Application();
  await app.init({
    resizeTo: host,
    background: 0x2b1b30,
    antialias: true,
    autoDensity: true,
    resolution: Math.min(2, globalThis.devicePixelRatio || 1),
  });
  app.canvas.style.position = 'absolute';
  app.canvas.style.inset = '0';
  app.canvas.style.touchAction = 'none';
  host.appendChild(app.canvas);
  const moduleLayer = new Container();
  app.stage.addChild(moduleLayer);
  app.renderer.on('resize', () => layout.refresh());

  const clock = new SessionClock(q.get('bench') === '1' ? { profile: BENCH_PROFILE } : {});
  const art = createArtKit({
    app,
    layout,
    quality: { tier: parseQualityTier(q.get('tier')), reducedMotion: q.has('reducedMotion') },
  });
  const audio = new AudioEngine({ clock });
  const voice = new TimedSilentVoice(q.get('lang') ?? 'en-IN', () => clock.now());
  const input = new DomInputService({
    clock,
    metrics: layout.metrics,
    element: host,
    stageSize: () => ({ width: layout.width, height: layout.height }),
    safeArea: () => layout.safeArea,
    strictTargets: true,
    voice,
  });
  host.addEventListener('pointerdown', () => void audio.unlock(), { once: true });

  const created: Set2Module[] = [];
  const registry = new GameModuleRegistry(
    set2ModuleFactories(
      {
        onPhase: (info) => {
          dev.phase = `${info.moduleId}:${info.phase}`;
          dev.phases.push(info);
        },
      },
      (m) => created.push(m),
    ),
  );
  dev.trialParams = () => Object.assign({}, ...created.map((m) => m.trialParams()));

  const services: PlayServices = {
    app,
    layout,
    audio,
    voice,
    input,
    art,
    createStage: () => {
      const c = new Container();
      moduleLayer.addChild(c);
      art.raiseOverlay();
      return c;
    },
    releaseStage: (c: Container) => {
      moduleLayer.removeChild(c);
      c.destroy({ children: true });
    },
  };

  // Modules: ?module=<id> | ?modules=a,b,c | ?carousel=1&slot=<slot> (share_pot then the slot).
  const ids = (q.get('modules') ?? q.get('module') ?? '')
    .split(',')
    .map((x) => x.trim().replaceAll('-', '_'))
    .filter(Boolean) as ModuleId[];
  const slot = (q.get('slot') as SlotForm | null) ?? null;
  const carousel = q.get('carousel') === '1';
  const modules: ModuleId[] = carousel ? ['share_pot', ...(slot ? [slot] : [])] : ids;
  for (const m of modules) if (!content.has(m)) throw new Error(`set2 dev: unknown module '${m}'`);
  if (q.get('hub') === '1') {
    await runBridgeOnly(services, content, Number(q.get('at') ?? 0), slot, clock);
    return;
  }
  const level = (q.get('level') ?? 'L2').toUpperCase() as CalibrationLevel;
  const run = runSet2Session({
    content,
    registry,
    services,
    modules,
    seedHex: seedFromParam(q.get('seed') ?? '1'),
    level,
    language: q.get('lang') ?? 'en-IN',
    ...(q.get('form') ? { formId: q.get('form') as string } : {}),
    ...(slot ? { slot } : {}),
    siteMode: (q.get('site') as SiteMode | null) ?? 'supervised',
    headset: q.get('headset') === '1',
    clock,
    validate: ajvEventValidator(validateEventEnvelope),
    dev: { headless: q.get('bot') === '1' },
    hub: carousel || q.get('withHub') === '1',
    onBridge: (b) => {
      dev.phase = `hub:bridge.${b.phase}.${b.index}`;
      dev.phases.push({
        moduleId: 'hub',
        phase: `bridge.${b.phase}`,
        trialIndex: b.index,
        tMs: clock.now(),
      });
    },
  });
  dev.sessionId = run.sessionId;
  dev.events = () => run.events();
  dev.state = 'running';
  host.dataset.state = 'running';
  const results = await run.results;
  dev.result = results.at(-1) ?? null;
  dev.results = results;
  dev.state = 'ended';
  dev.phase = 'ended';
  host.dataset.state = 'ended';
}

/** Render one hub bridge into booth `at` (screenshots of the fair map). */
async function runBridgeOnly(
  services: PlayServices,
  content: GameContent,
  at: number,
  slot: SlotForm | null,
  clock: SessionClock,
): Promise<void> {
  const order = carouselOrder(content.plan, slot ?? 'four_stalls');
  const target = order[Math.max(0, Math.min(order.length - 1, at))] as ModuleId;
  const hub = new CarouselHubRunner({
    inner: {
      run: async (r) => ({
        moduleId: r.moduleId,
        endedReason: 'completed',
        durationMs: 0,
        trialsCompleted: 0,
        scorableTrials: 0,
        contextShiftIndex: null,
      }),
    },
    services,
    plan: content.plan,
    onBridge: (b) => {
      dev.phase = `hub:bridge.${b.phase}`;
      dev.phases.push({
        moduleId: 'hub',
        phase: `bridge.${b.phase}`,
        trialIndex: b.index,
        tMs: clock.now(),
      });
    },
  });
  // Pretend the earlier booths were played this session.
  const sessionId = 'hub-preview';
  const session = {
    sessionId,
    pathway: 'B' as const,
    mode: 'pilot' as const,
    siteMode: 'supervised' as const,
    formId: 'form_1',
    slotForm: slot ?? ('four_stalls' as SlotForm),
    headset: false,
    slowPace: false,
  };
  const base = {
    level: 'L2' as const,
    language: 'en-IN',
    logger: undefined as never,
    rng: createSessionRng('0000000000000001'),
    clock,
    session,
    signal: new AbortController().signal,
  };
  hub.markPlayed(sessionId, at);
  dev.state = 'running';
  await hub.run({ ...base, moduleId: target });
  dev.state = 'ended';
  dev.phase = 'ended';
}

main().catch((err: unknown) => {
  console.error(err);
  dev.state = 'error';
  dev.error = err instanceof Error ? (err.stack ?? err.message) : String(err);
});
