/**
 * Report gating (REP-01/02/03): fail closed on every missing condition; signed-pack verification; band
 * evaluation with the SEM rule; demo isolation; ESC/POS output; QR; and the screen's report events.
 */
import '../../onboarding/__tests__/canvasStub.ts';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ConstructId, ReleasePack } from '@shriii/contracts';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { makeRig } from '../../onboarding/__tests__/fakes.ts';
import { ScreenKit } from '../../onboarding/ScreenKit.ts';
import { bandForComposite, compositeScore, inverseNormalCdf } from '../bands.ts';
import { ditherToMono, escposRaster } from '../escpos.ts';
import {
  batteryGateOpen,
  buildDemoReportModel,
  buildPlayerReportModel,
  capStatus,
  type DisplayTrait,
  EXAMPLE_DEMO_PROFILE,
  spokenLines,
} from '../model.ts';
import { encodeQr } from '../qr.ts';
import { runReport } from '../ReportScreen.ts';
import {
  canonicalJson,
  createReleasePackReader,
  NO_PACK,
  type ReleasePackTrust,
  signingPayload,
  verifyReleasePack,
} from '../releasePack.ts';
import {
  CONSTRUCT_REPORT,
  DISPLAY_RULE,
  PERMANENT_WITHHOLD,
  REPORT_LIMITS,
  SEM_RULE,
} from '../rules/rules.generated.ts';

const FIXTURE = resolve(
  process.cwd(),
  '../../../contracts/fixtures/valid/release-pack/all_closed.json',
);
const NOW = new Date('2026-10-25T12:00:00Z');
const TRAITS: ConstructId[] = [
  'persistence',
  'teamwork',
  'adaptability',
  'composure',
  'integrity',
  'self_control',
  'decisiveness',
];

function basePack(): ReleasePack {
  const p = JSON.parse(readFileSync(FIXTURE, 'utf8')) as ReleasePack;
  p.battery_gates = p.battery_gates.map((g) => ({
    ...g,
    status:
      g.pathway === 'B' &&
      g.site_mode === 'supervised' &&
      (g.language === 'hi-IN' || g.language === 'mr-IN')
        ? 'open'
        : 'closed',
  }));
  p.trait_gates = TRAITS.map((trait) => ({
    trait,
    language: 'hi-IN',
    pathway: 'B',
    status: 'validated_banded',
    evidence_ids: ['e1'],
    approvers: ['pi', 'eo'],
    effective_from: '2026-10-21T00:00:00Z',
  }));
  p.norm_tables = TRAITS.map((trait, i) => ({
    norm_table_version: '0.1.0',
    trait,
    pathway: 'B',
    language: 'hi-IN',
    cut_points: [-0.5, 0.5],
    sem: 0.05 + i * 0.01,
    ci_level: 0.9,
    provisional: i % 2 === 0,
    effective_n: 400,
  }));
  p.phrase_allowlist = TRAITS.flatMap((trait) =>
    (['pole_a', 'centre', 'pole_b'] as const).map((band) => ({
      trait,
      band,
      phrase_key: `report.${trait}.${band}`,
    })),
  );
  return p;
}

const allPoleB = (): 'pole_b' => 'pole_b';

function inputs(
  pack: ReleasePack | null,
  over: Partial<Parameters<typeof buildPlayerReportModel>[0]> = {},
): Parameters<typeof buildPlayerReportModel>[0] {
  return {
    language: 'hi-IN',
    pathway: 'B',
    siteMode: 'supervised',
    policyMode: 'player_report',
    sessionValidForReport: true,
    packReader: pack ? createReleasePackReader({ status: 'valid', pack }, () => NOW) : NO_PACK,
    bandFor: allPoleB,
    ...over,
  };
}

function hasTraitInfo(model: unknown): boolean {
  return JSON.stringify(model).includes('"trait"') || JSON.stringify(model).includes('pole_');
}

describe('report gating: fail closed (REP-01/02/03)', () => {
  it('no pack -> thank-you (release_pack_invalid), with no trait information at all', () => {
    const m = buildPlayerReportModel(inputs(null));
    expect(m.mode).toBe('thank_you');
    expect(m.mode === 'thank_you' && m.reason).toBe('release_pack_invalid');
    expect(hasTraitInfo(m)).toBe(false);
  });

  it('expired pack -> release_pack_expired, even if it was valid when loaded', () => {
    const pack = basePack();
    let now = NOW;
    const reader = createReleasePackReader({ status: 'valid', pack }, () => now);
    expect(buildPlayerReportModel(inputs(pack, { packReader: reader })).mode).toBe('player_report');
    now = new Date('2026-11-05T00:00:00Z');
    const m = buildPlayerReportModel(inputs(pack, { packReader: reader }));
    expect(m.mode === 'thank_you' && m.reason).toBe('release_pack_expired');
  });

  it('deployment policy thank-you only wins over everything', () => {
    const m = buildPlayerReportModel(inputs(basePack(), { policyMode: 'thank_you' }));
    expect(m.mode === 'thank_you' && m.reason).toBe('policy_thank_you_only');
  });

  it('battery gate closed for this cell -> thank-you', () => {
    const m = buildPlayerReportModel(inputs(basePack(), { language: 'ta-IN' }));
    expect(m.mode === 'thank_you' && m.reason).toBe('battery_gate_closed');
    const m2 = buildPlayerReportModel(inputs(basePack(), { siteMode: 'open_public' }));
    expect(m2.mode === 'thank_you' && m2.reason).toBe('battery_gate_closed');
  });

  it('battery gate open in fewer than the required language groups -> thank-you', () => {
    const pack = basePack();
    pack.battery_gates = pack.battery_gates.map((g) =>
      g.language === 'mr-IN' ? { ...g, status: 'closed' } : g,
    );
    expect(REPORT_LIMITS.batteryMinLanguageGroups).toBe(2);
    expect(batteryGateOpen(pack, 'hi-IN', 'B', 'supervised')).toBe(false);
    const m = buildPlayerReportModel(inputs(pack));
    expect(m.mode === 'thank_you' && m.reason).toBe('battery_gate_closed');
  });

  it('session not valid for report -> thank-you', () => {
    const m = buildPlayerReportModel(inputs(basePack(), { sessionValidForReport: false }));
    expect(m.mode === 'thank_you' && m.reason).toBe('session_not_valid_for_report');
  });

  it('no trait passes -> thank-you (no_trait_released)', () => {
    const pack = basePack();
    pack.trait_gates = pack.trait_gates.map((t) => ({ ...t, status: 'research_only' }));
    expect(buildPlayerReportModel(inputs(pack)).mode).toBe('thank_you');
    const m = buildPlayerReportModel(inputs(basePack(), { bandFor: () => 'not_enough_to_say' }));
    expect(m.mode === 'thank_you' && m.reason).toBe('no_trait_released');
    expect(buildPlayerReportModel(inputs(basePack(), { bandFor: () => 'unavailable' })).mode).toBe(
      'thank_you',
    );
  });

  it('shows at most max_traits_shown, most reliable (smallest SEM) first, banded or broad style per caps', () => {
    const m = buildPlayerReportModel(inputs(basePack()));
    expect(m.mode).toBe('player_report');
    if (m.mode !== 'player_report') return;
    expect(m.traits.length).toBe(REPORT_LIMITS.maxTraitsShown);
    expect(m.traits.map((t) => t.trait)).toEqual(TRAITS.slice(0, 5));
    const integrity = m.traits.find((t) => t.trait === 'integrity') as DisplayTrait | undefined;
    expect(integrity?.style).toBe('broad_style');
    expect((m.traits.find((t) => t.trait === 'persistence') as DisplayTrait).style).toBe('banded');
    expect(m.disclaimerKey).toBe('report.disclaimer.snapshot');
    expect(m.normProvisional).toBe(true);
    expect(m.traits.every((t) => !/\d/.test(t.phraseKey))).toBe(true);
  });

  it('withheld status, permanent withholds and phrase-key mismatches are never shown', () => {
    const pack = basePack();
    pack.trait_gates = pack.trait_gates.map((t) =>
      t.trait === 'persistence' ? { ...t, status: 'withheld' } : t,
    );
    pack.trait_gates.push({
      trait: 'judgement',
      language: 'hi-IN',
      pathway: 'B',
      status: 'validated_banded',
      evidence_ids: [],
      approvers: [],
      effective_from: '2026-10-21T00:00:00Z',
    });
    pack.phrase_allowlist = pack.phrase_allowlist.map((p) =>
      p.trait === 'teamwork' ? { ...p, phrase_key: 'report.teamwork.other' } : p,
    );
    const m = buildPlayerReportModel(inputs(pack));
    expect(m.mode).toBe('player_report');
    if (m.mode !== 'player_report') return;
    const shown = m.traits.map((t) => t.trait);
    expect(shown).not.toContain('persistence');
    expect(shown).not.toContain('teamwork');
    expect(PERMANENT_WITHHOLD.some((w) => w.construct === 'judgement' && w.pathway === 'B')).toBe(
      true,
    );
    expect(shown).not.toContain('judgement');
  });

  it('caps follow the dictionary/gates YAML (integrity and risk preference broad style only)', () => {
    expect(CONSTRUCT_REPORT.integrity?.maxStatus).toBe('validated_broad_style');
    expect(CONSTRUCT_REPORT.risk_preference?.maxStatus).toBe('validated_broad_style');
    expect(capStatus('validated_banded', 'validated_broad_style')).toBe('validated_broad_style');
    expect(capStatus('withheld', 'validated_banded')).toBe('withheld');
    expect(DISPLAY_RULE.traitStatusIn).toEqual(['validated_banded', 'validated_broad_style']);
  });

  it('thank-you is the outcome for random failure combinations (property)', () => {
    const pack = basePack();
    for (let i = 0; i < 64; i++) {
      const policy = i & 1 ? 'player_report' : 'thank_you';
      const valid = Boolean(i & 2);
      const withPack = Boolean(i & 4);
      const lang = i & 8 ? 'hi-IN' : 'ta-IN';
      const band = i & 16 ? 'pole_a' : 'not_enough_to_say';
      const ok =
        policy === 'player_report' && valid && withPack && lang === 'hi-IN' && band === 'pole_a';
      const m = buildPlayerReportModel(
        inputs(withPack ? pack : null, {
          policyMode: policy,
          sessionValidForReport: valid,
          language: lang,
          bandFor: () => band,
        }),
      );
      expect(m.mode).toBe(ok ? 'player_report' : 'thank_you');
      if (m.mode === 'thank_you') expect(hasTraitInfo(m)).toBe(false);
    }
  });

  it('demo reports come only from a fictional profile and are labelled "example" when spoken', () => {
    const m = buildDemoReportModel(EXAMPLE_DEMO_PROFILE, 'hi-IN');
    expect(m.mode).toBe('demo');
    expect(m.demoProfileId).toBe(EXAMPLE_DEMO_PROFILE.demoProfileId);
    expect(buildDemoReportModel.length).toBeLessThanOrEqual(3);
    const lines = spokenLines(m);
    expect(lines[0]).toBe('report.example_label');
    expect(lines[lines.length - 1]).toBe('report.disclaimer.snapshot');
  });

  it('generated rules match stats/measurement-model/gates.yaml', () => {
    const g = parse(
      readFileSync(resolve(process.cwd(), '../../../stats/measurement-model/gates.yaml'), 'utf8'),
    ) as {
      display_rule: { trait_status_in: string[] };
      report: { max_traits_shown: number };
      battery_gate: { min_language_groups: number };
      trait_gate: {
        norms: {
          sem_rule: {
            ci_level: number;
            min_band_width_sem: number;
            max_band_boundaries_overlapped: number;
          };
        };
      };
    };
    expect(DISPLAY_RULE.traitStatusIn).toEqual(g.display_rule.trait_status_in);
    expect(REPORT_LIMITS.maxTraitsShown).toBe(g.report.max_traits_shown);
    expect(REPORT_LIMITS.batteryMinLanguageGroups).toBe(g.battery_gate.min_language_groups);
    expect(SEM_RULE.ciLevel).toBe(g.trait_gate.norms.sem_rule.ci_level);
    expect(SEM_RULE.minBandWidthSem).toBe(g.trait_gate.norms.sem_rule.min_band_width_sem);
    expect(SEM_RULE.maxBandBoundariesOverlapped).toBe(
      g.trait_gate.norms.sem_rule.max_band_boundaries_overlapped,
    );
  });
});

describe('release pack verification (REP-03)', () => {
  async function keypair(): Promise<{
    trust: ReleasePackTrust;
    sign: (p: ReleasePack) => Promise<ReleasePack>;
  }> {
    const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
    const b64 = btoa(String.fromCharCode(...raw));
    const trust: ReleasePackTrust = {
      publicKeys: { 'release-dev-1': b64 },
      dictionary: {
        versions: { A: '0.1.0', B: '0.1.0' },
        sha256: { A: `${'0'.repeat(63)}a`, B: `${'0'.repeat(63)}b` },
      },
    };
    const sign = async (p: ReleasePack): Promise<ReleasePack> => {
      const sig = new Uint8Array(
        await crypto.subtle.sign(
          { name: 'Ed25519' },
          kp.privateKey,
          signingPayload(p) as BufferSource,
        ),
      );
      return {
        ...p,
        signature: {
          algorithm: 'ed25519',
          key_id: 'release-dev-1',
          value: btoa(String.fromCharCode(...sig)),
        },
      };
    };
    return { trust, sign };
  }

  it('accepts a correctly signed, unexpired, dictionary-matched pack', async () => {
    const { trust, sign } = await keypair();
    const signed = await sign(basePack());
    const v = await verifyReleasePack(signed, trust, NOW);
    expect(v.status).toBe('valid');
  });

  it('rejects tampering, unknown keys, expiry, future issue, dictionary mismatch, malformed and missing', async () => {
    const { trust, sign } = await keypair();
    const signed = await sign(basePack());
    const tampered = {
      ...signed,
      trait_gates: signed.trait_gates.map((t) => ({
        ...t,
        status: 'validated_banded' as const,
        trait: 'integrity' as const,
      })),
    };
    expect((await verifyReleasePack(tampered, trust, NOW)).status).toBe('bad_signature');
    expect(
      (
        await verifyReleasePack(
          { ...signed, signature: { ...signed.signature, key_id: 'other' } },
          trust,
          NOW,
        )
      ).status,
    ).toBe('unknown_key');
    expect((await verifyReleasePack(signed, trust, new Date('2026-11-04T00:00:00Z'))).status).toBe(
      'expired',
    );
    expect((await verifyReleasePack(signed, trust, new Date('2026-10-01T00:00:00Z'))).status).toBe(
      'not_yet_valid',
    );
    expect(
      (
        await verifyReleasePack(
          signed,
          { ...trust, dictionary: { ...trust.dictionary, versions: { A: '0.2.0', B: '0.1.0' } } },
          NOW,
        )
      ).status,
    ).toBe('dictionary_mismatch');
    expect((await verifyReleasePack({ hello: 'world' }, trust, NOW)).status).toBe('malformed');
    expect((await verifyReleasePack(null, trust, NOW)).status).toBe('missing');
  });

  it('a reader over any failure never yields a pack', async () => {
    for (const status of [
      'missing',
      'malformed',
      'bad_signature',
      'expired',
      'dictionary_mismatch',
    ] as const) {
      const r = createReleasePackReader({ status });
      expect(r.current()).toBeNull();
      expect(r.failure()).toBe(status);
    }
  });

  it('canonical JSON sorts keys recursively and drops undefined members', () => {
    expect(canonicalJson({ b: 1, a: [true, null, { d: 'x', c: 2.5 }], e: undefined })).toBe(
      '{"a":[true,null,{"c":2.5,"d":"x"}],"b":1}',
    );
  });
});

describe('band evaluation (REP-01)', () => {
  const norm = {
    norm_table_version: '0.1.0',
    trait: 'persistence',
    pathway: 'B',
    language: 'hi-IN',
    cut_points: [-0.5, 0.5] as [number, number],
    sem: 0.1,
    ci_level: 0.9,
    provisional: false,
    effective_n: 300,
  } as const;

  it('computes unit-weighted z composites with negative indicators flipped; missing -> null', () => {
    const params = {
      trait: 'persistence',
      pathway: 'B',
      language: 'hi-IN',
      method: 'unit_weighted_z',
      indicators: [
        { indicator_id: 'persistence.a', weight: 1, mean: 10, sd: 2, direction: 'positive' },
        { indicator_id: 'persistence.b', weight: 1, mean: 0.5, sd: 0.1, direction: 'negative' },
      ],
    } as const;
    const v = new Map([
      ['persistence.a', 12],
      ['persistence.b', 0.3],
    ]);
    expect(compositeScore(params as never, v)).toBeCloseTo((1 + 2) / 2, 12);
    expect(compositeScore(params as never, new Map([['persistence.a', 12]]))).toBeNull();
  });

  it('bands by cut points and applies the SEM rule from gates.yaml', () => {
    expect(bandForComposite(-1, norm)).toBe('pole_a');
    expect(bandForComposite(0, norm)).toBe('centre');
    expect(bandForComposite(1, norm)).toBe('pole_b');
    expect(bandForComposite(null, norm)).toBe('unavailable');
    // CI wider than the centre band overlaps both boundaries -> not enough to say.
    expect(bandForComposite(0, { ...norm, sem: 0.4 })).toBe('not_enough_to_say');
    // Centre band narrower than 2 SEM -> not enough to say.
    expect(bandForComposite(1, { ...norm, cut_points: [-0.05, 0.05] })).toBe('not_enough_to_say');
    // Overlapping exactly one boundary is still banded (rule: more than one).
    expect(bandForComposite(0.52, norm)).toBe('pole_b');
  });

  it('inverse normal CDF is accurate', () => {
    expect(inverseNormalCdf(0.95)).toBeCloseTo(1.6448536, 5);
    expect(inverseNormalCdf(0.975)).toBeCloseTo(1.959964, 5);
    expect(inverseNormalCdf(0.5)).toBeCloseTo(0, 6);
  });
});

describe('print and QR', () => {
  it('dithers to 1-bit and wraps an ESC/POS GS v 0 raster', () => {
    const w = 16;
    const h = 2;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w; i++) rgba.set([0, 0, 0, 255], i * 4);
    for (let i = w; i < w * h; i++) rgba.set([255, 255, 255, 255], i * 4);
    const bmp = ditherToMono(rgba, w, h);
    expect(bmp.bytesPerRow).toBe(2);
    expect([...bmp.data]).toEqual([0xff, 0xff, 0x00, 0x00]);
    const cmd = escposRaster(bmp);
    const at = cmd.indexOf(0x1d);
    expect([...cmd.slice(at, at + 8)]).toEqual([0x1d, 0x76, 0x30, 0x00, 2, 0, 2, 0]);
  });

  it('encodes the retrieval URL as a scannable QR', () => {
    const m = encodeQr('https://r.example/t/3q2k9v7xw4m8pd5ta6hc1ybz0e');
    expect(m.size).toBeGreaterThanOrEqual(25);
    expect(m.get(0, 0)).toBe(true);
    expect(m.get(7, 7)).toBe(false);
  });
});

describe('report screen events', () => {
  it('thank-you logs report.withheld with the reason and speaks no trait lines', async () => {
    const rig = makeRig(() => null);
    const kit = new ScreenKit(rig.services, rig.config);
    const res = await runReport(kit, buildPlayerReportModel(inputs(null)), { lingerMs: 10 });
    kit.destroy();
    expect(res.event).toEqual({ type: 'REPORT_DONE' });
    expect(rig.logger.ofType('report.withheld')[0]?.payload).toEqual({
      report_mode: 'thank_you',
      release_pack_version: null,
      reason: 'release_pack_invalid',
    });
    expect(rig.logger.ofType('report.delivered')).toHaveLength(0);
    expect(
      rig.voice.played.filter((l) => /^report\.[a-z_]+\.(pole_a|centre|pole_b)$/.test(l)),
    ).toHaveLength(0);
    expect(rig.voice.played).toEqual(['report.thank_you', 'report.what_this_is_about']);
  });

  it('player report logs report.delivered with modes and count, speaks phrases and the disclaimer', async () => {
    const rig = makeRig(() => null);
    const kit = new ScreenKit(rig.services, rig.config);
    const model = buildPlayerReportModel(inputs(basePack()));
    const res = await runReport(kit, model, {
      lingerMs: 10,
      retrievalUrl: 'https://r.example/t/abc',
    });
    kit.destroy();
    const ev = rig.logger.ofType('report.delivered')[0]?.payload;
    expect(ev?.report_mode).toBe('player_report');
    expect(ev?.traits_shown_count).toBe(5);
    expect(ev?.release_pack_version).toBe('0.1.0');
    expect(ev?.delivery_modes).toEqual(expect.arrayContaining(['screen', 'spoken', 'qr']));
    expect(res.deliveredModes).toContain('qr');
    expect(rig.voice.played).toContain('report.disclaimer.snapshot');
    expect(rig.voice.played).toContain('report.persistence.pole_b');
  });

  it('a failed print falls back to the QR', async () => {
    const rig = makeRig(() => null);
    const kit = new ScreenKit(rig.services, rig.config);
    const res = await runReport(kit, buildDemoReportModel(EXAMPLE_DEMO_PROFILE, 'hi-IN'), {
      lingerMs: 10,
      retrievalUrl: 'https://r.example/t/abc',
      printer: async () => false,
    });
    kit.destroy();
    expect(res.deliveredModes).toContain('qr');
    expect(res.deliveredModes).not.toContain('printed');
    expect(rig.logger.ofType('report.delivered')[0]?.payload.report_mode).toBe('demo');
  });
});
