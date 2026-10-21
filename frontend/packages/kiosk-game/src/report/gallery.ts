/**
 * Gallery previews of the report screens (dev/QA): thank-you (fail-closed default), a player report
 * built through the full gate logic from a sample pack, the demo report with QR, and the dithered print.
 */

import type { ReleasePack } from '@shriii/contracts';
import { type Application, Container, Graphics, Sprite, Texture } from 'pixi.js';
import { type RouteDef, registerRoutes } from '../art/gallery/routes.ts';
import type { ReportModel } from '../core/contracts.ts';
import { createDevServices, TimedSilentVoice } from '../onboarding/harness/devServices.ts';
import { ScreenAbortedError, ScreenKit } from '../onboarding/ScreenKit.ts';
import { runSurvey } from '../onboarding/screens/survey.ts';
import { buildDemoReportModel, buildPlayerReportModel, EXAMPLE_DEMO_PROFILE } from './model.ts';
import { buildPrintSummary, monoToRgba, rasterisePrintSummary } from './print.ts';
import { runReport } from './ReportScreen.ts';
import { createReleasePackReader, NO_PACK } from './releasePack.ts';

/** A sample (unsigned, preview-only) pack: wrapped as "verified" ONLY inside the gallery. */
export function samplePack(): ReleasePack {
  const now = Date.now();
  const traits = ['persistence', 'teamwork', 'adaptability', 'composure', 'integrity'] as const;
  return {
    schema_version: '1.0',
    release_pack_version: '0.1.0',
    issued_at: new Date(now - 3600_000).toISOString(),
    expires_at: new Date(now + 14 * 86_400_000).toISOString(),
    dictionary_versions: { A: '0.1.0', B: '0.1.0' },
    dictionary_sha256: { A: 'a'.repeat(64), B: 'b'.repeat(64) },
    battery_gates: ['en-IN', 'hi-IN'].map((language) => ({
      language,
      pathway: 'B' as const,
      evidence_ids: ['ev1'],
      approvers: ['pi', 'ethics'],
      effective_from: new Date(now - 86_400_000).toISOString(),
      site_mode: 'supervised' as const,
      status: 'open' as const,
    })),
    trait_gates: traits.map((trait) => ({
      trait,
      language: 'en-IN',
      pathway: 'B' as const,
      evidence_ids: ['ev1'],
      approvers: ['pi', 'ethics'],
      effective_from: new Date(now - 86_400_000).toISOString(),
      status: 'validated_banded' as const,
    })),
    composites: [],
    norm_tables: traits.map((trait, i) => ({
      norm_table_version: '0.1.0',
      trait,
      pathway: 'B' as const,
      language: 'en-IN',
      cut_points: [-0.5, 0.5] as [number, number],
      sem: 0.1 + i * 0.02,
      ci_level: 0.9,
      provisional: true,
      effective_n: 500,
    })),
    phrase_allowlist: traits.flatMap((trait) =>
      (['pole_a', 'centre', 'pole_b'] as const).map((band) => ({
        trait,
        band,
        phrase_key: `report.${trait}.${band}`,
      })),
    ),
    disclaimer_key: 'report.disclaimer.snapshot',
    signature: { algorithm: 'ed25519', key_id: 'gallery', value: 'AA==' },
  } as unknown as ReleasePack;
}

function sampleModel(): ReportModel {
  const pack = samplePack();
  const bands = {
    persistence: 'pole_b',
    teamwork: 'centre',
    adaptability: 'pole_a',
    composure: 'pole_b',
    integrity: 'pole_a',
  } as const;
  return buildPlayerReportModel({
    language: 'en-IN',
    pathway: 'B',
    siteMode: 'supervised',
    policyMode: 'player_report',
    sessionValidForReport: true,
    packReader: createReleasePackReader({ status: 'valid', pack }),
    bandFor: (trait) =>
      (bands as Record<string, 'pole_a' | 'centre' | 'pole_b'>)[trait] ?? 'unavailable',
    deliveryModes: ['spoken', 'screen', 'qr'],
  });
}

function reportRoute(
  pattern: RegExp,
  model: () => ReportModel,
  options: { qr?: boolean } = {},
): RouteDef {
  return {
    pattern,
    mount(app: Application) {
      const dev = createDevServices(app);
      const voice = new TimedSilentVoice('en-IN', () => dev.services.clock.now());
      const services = dev.services.voice.isDevPlaceholder
        ? dev.services
        : { ...dev.services, voice };
      const kit = new ScreenKit(services, dev.config);
      void runReport(kit, model(), {
        retrievalUrl: options.qr ? 'https://r.shriii.example/t/3q2k9v7xw4m8pd5ta6hc1ybz0e' : null,
        lingerMs: 600_000,
      }).catch((e: unknown) => {
        if (!(e instanceof ScreenAbortedError)) console.error('report failed', e);
      });
      return () => {
        kit.destroy();
        dev.dispose();
      };
    },
  };
}

const ROUTES: RouteDef[] = [
  reportRoute(/^\/report\/thank-you$/, () =>
    buildPlayerReportModel({
      language: 'en-IN',
      pathway: 'B',
      siteMode: 'supervised',
      policyMode: 'player_report',
      sessionValidForReport: true,
      packReader: NO_PACK,
      bandFor: () => 'unavailable',
    }),
  ),
  reportRoute(/^\/report\/player$/, sampleModel, { qr: true }),
  reportRoute(/^\/report\/demo$/, () => buildDemoReportModel(EXAMPLE_DEMO_PROFILE, 'en-IN'), {
    qr: true,
  }),
  {
    pattern: /^\/report\/print$/,
    mount(app: Application) {
      const bg = new Graphics().rect(0, 0, app.screen.width, app.screen.height).fill(0x3a3a46);
      app.stage.addChild(bg);
      const page = buildPrintSummary(
        sampleModel(),
        'https://r.shriii.example/t/3q2k9v7xw4m8pd5ta6hc1ybz0e',
      );
      const raster = rasterisePrintSummary(app, page);
      page.destroy({ children: true });
      const holder = new Container();
      if (raster) {
        const canvas = document.createElement('canvas');
        canvas.width = raster.bitmap.width;
        canvas.height = raster.bitmap.height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const img = ctx.createImageData(raster.bitmap.width, raster.bitmap.height);
          img.data.set(monoToRgba(raster.bitmap));
          ctx.putImageData(img, 0, 0);
        }
        const s = new Sprite(Texture.from(canvas));
        const scale = Math.min(1, (app.screen.height * 0.95) / raster.bitmap.height);
        s.scale.set(scale);
        s.position.set(
          (app.screen.width - raster.bitmap.width * scale) / 2,
          (app.screen.height - raster.bitmap.height * scale) / 2,
        );
        holder.addChild(s);
      }
      app.stage.addChild(holder);
      return () => {
        for (const c of app.stage.removeChildren()) c.destroy({ children: true });
      };
    },
  },
  {
    pattern: /^\/report\/survey$/,
    mount(app: Application) {
      const dev = createDevServices(app);
      const kit = new ScreenKit(dev.services, dev.config);
      void runSurvey(kit).catch(() => undefined);
      return () => {
        kit.destroy();
        dev.dispose();
      };
    },
  },
];

let registered = false;
/** Register the report previews with the gallery (idempotent). */
export function registerReportGalleryRoutes(): void {
  if (registered) return;
  registered = true;
  registerRoutes(ROUTES, {
    title: 'Report',
    prefix: '/report',
    items: [
      { path: '/report/thank-you', label: 'thank-you (fail closed)' },
      { path: '/report/player', label: 'player report (sample pack)' },
      { path: '/report/demo', label: 'demo report (example)' },
      { path: '/report/print', label: 'printed summary (1-bit)' },
    ],
  });
}
