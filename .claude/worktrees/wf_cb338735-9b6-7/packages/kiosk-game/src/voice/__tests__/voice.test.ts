/**
 * Voice: manifest resolution by line x language and pack kind, loudness correction, recorded playback
 * through the engine's voice bus with ducking and sha256 verification, never-voice routing (KSK-05),
 * audio.played / instruction_replay logging, the dev placeholder gate, and catalogue drift vs YAML.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ContentManifest } from '@shriii/contracts';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { mockFactory } from '../../audio/__tests__/mockAudio.ts';
import { AudioEngine } from '../../audio/AudioEngine.ts';
import { MemoryLogger } from '../../onboarding/harness/basics.ts';
import { LINES } from '../catalogue/lines.generated.ts';
import {
  buildVoiceManifest,
  loudnessGain,
  missingLines,
  playableState,
  resolveClip,
} from '../manifest.ts';
import { DEV_VOICE_PLACEHOLDER_ALLOWED, ManifestVoiceService } from '../VoiceService.ts';

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const CLIP_A = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const CLIP_B = new Uint8Array([9, 9, 9, 9]);

async function manifest(
  packKind: 'production' | 'pilot' | 'dev' = 'production',
): Promise<ContentManifest> {
  const entry = (
    key: string,
    language: string,
    bytes: Uint8Array,
    review: string,
    extra: Partial<ContentManifest['audio_clips'][number]> = {},
  ) => ({
    key,
    language,
    file: `${language}/${key}.opus`,
    sha256: '',
    duration_ms: 1200,
    speaker_id: 'spk1',
    take: 1,
    script_version: '0.1.0',
    review_state: review,
    loudness_lufs: -16,
    true_peak_dbtp: -1.5,
    voice_forbidden: false,
    ...extra,
    _bytes: bytes,
  });
  const clips = [
    entry('consent.core.question', 'hi-IN', CLIP_A, 'approved'),
    entry('report.intro', 'hi-IN', CLIP_B, 'think_aloud_tested'),
    entry('optin.digit.one', 'hi-IN', CLIP_A, 'approved', { voice_forbidden: true }),
    entry('warmup.tap', 'hi-IN', CLIP_A, 'approved', { loudness_lufs: -19 }),
  ];
  for (const c of clips) c.sha256 = await sha256Hex(c._bytes);
  void packKind;
  return {
    schema_version: '1.0',
    manifest_id: 'pack.hi',
    content_pack_version: '1.2.0',
    bundle_hash: 'c'.repeat(64),
    created_at: '2026-10-01T00:00:00Z',
    languages: ['hi-IN'],
    stimuli: [],
    audio_clips: clips.map(({ _bytes, ...rest }) => rest),
    layouts: [],
  } as unknown as ContentManifest;
}

function fetcher(): (url: string) => Promise<ArrayBuffer> {
  return async (url) => {
    const bytes = url.includes('report.intro') ? CLIP_B : CLIP_A;
    return bytes.slice().buffer;
  };
}

describe('voice manifest', () => {
  it('applies pack rules: production = approved only, pilot adds think-aloud tested', async () => {
    const m = await manifest();
    const prod = buildVoiceManifest(m, { baseUrl: '/audio', packKind: 'production' });
    const pilot = buildVoiceManifest(m, { baseUrl: '/audio', packKind: 'pilot' });
    expect(resolveClip(prod, 'consent.core.question', 'hi-IN')?.url).toBe(
      '/audio/hi-IN/consent.core.question.opus',
    );
    expect(resolveClip(prod, 'report.intro', 'hi-IN')).toBeNull();
    expect(resolveClip(pilot, 'report.intro', 'hi-IN')).not.toBeNull();
    expect(resolveClip(prod, 'consent.core.question', 'ta-IN')).toBeNull();
    expect(missingLines(prod, ['consent.core.question', 'report.intro'], 'hi-IN')).toEqual([
      'report.intro',
    ]);
    expect(playableState('draft', 'dev')).toBe(false);
    expect(playableState('recorded', 'dev')).toBe(true);
  });

  it('corrects residual loudness towards -16 LUFS within +-6 dB', () => {
    expect(loudnessGain(-16)).toBeCloseTo(1);
    expect(loudnessGain(-19)).toBeCloseTo(10 ** (3 / 20));
    expect(loudnessGain(-40)).toBeCloseTo(10 ** (6 / 20));
    expect(loudnessGain(null)).toBe(1);
  });
});

describe('ManifestVoiceService', () => {
  async function rig(output: 'speaker' | 'headset' = 'speaker') {
    const { ctx, factory } = mockFactory();
    const engine = new AudioEngine({ contextFactory: factory, output });
    await engine.unlock();
    const logger = new MemoryLogger();
    const vm = buildVoiceManifest(await manifest(), { baseUrl: '/audio', packKind: 'production' });
    const voice = new ManifestVoiceService({
      host: engine.voiceHost(),
      manifest: vm,
      language: 'hi-IN',
      logger,
      fetchClip: fetcher(),
    });
    return { ctx, engine, logger, voice };
  }

  it('plays a recorded clip on the voice bus, ducks music, verifies the hash and logs audio.played', async () => {
    const { ctx, engine, logger, voice } = await rig();
    ctx.currentTime = 5;
    expect(voice.has('consent.core.question')).toBe(true);
    const pb = voice.play('consent.core.question');
    const onset = await pb.started;
    expect(onset).toBeGreaterThan(0);
    expect(engine.duckAmount).toBeGreaterThan(0);
    const sources = ctx
      .ofKind('buffer')
      .filter(
        (s) =>
          (s as unknown as { started: number | null }).started !== null &&
          !(s as unknown as { loop: boolean }).loop,
      );
    const src = sources[sources.length - 1] as unknown as {
      onended: (() => void) | null;
      started: number;
    };
    expect(src.started).toBeCloseTo(5.03);
    src.onended?.();
    const res = await pb.ended;
    expect(res.status).toBe('completed');
    expect(res.placeholder).toBe(false);
    expect(engine.duckAmount).toBe(0);
    const played = logger.ofType('audio.played');
    expect(played).toHaveLength(1);
    expect(played[0]?.payload).toMatchObject({
      key: 'consent.core.question',
      language: 'hi-IN',
      manifest_version: '1.2.0',
      status: 'completed',
      output: 'speaker',
    });
    expect(played[0]?.payload.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses never-voice clips on the speaker but plays them on a headset', async () => {
    const speaker = await rig('speaker');
    expect(speaker.voice.isVoiceForbidden('optin.digit.one')).toBe(true);
    const refused = await speaker.voice.play('optin.digit.one').ended;
    expect(refused.status).toBe('interrupted');
    expect(refused.durationMs).toBe(0);
    expect(speaker.logger.ofType('audio.played')).toHaveLength(0);
    const headset = await rig('headset');
    const pb = headset.voice.play('optin.digit.one');
    await pb.started;
    const srcs = headset.ctx
      .ofKind('buffer')
      .filter(
        (s) =>
          !(s as unknown as { loop: boolean }).loop &&
          (s as unknown as { started: number | null }).started !== null,
      );
    expect(srcs.length).toBeGreaterThan(0);
  });

  it('interrupts with a short fade and logs interrupted', async () => {
    const { logger, voice } = await rig();
    const pb = voice.play('warmup.tap');
    await pb.started;
    pb.interrupt();
    const r = await pb.ended;
    expect(r.status).toBe('interrupted');
    expect(logger.ofType('audio.played')[0]?.payload.status).toBe('interrupted');
  });

  it('logs instruction_replay for player replays of the last instruction', async () => {
    const { logger, voice } = await rig();
    voice.play('warmup.tap').interrupt();
    const again = voice.replayLast();
    expect(again).not.toBeNull();
    again?.interrupt();
    voice.replayLast()?.interrupt();
    const replays = logger.ofType('instruction_replay');
    expect(replays.map((r) => r.payload)).toEqual([
      { line_id: 'warmup.tap', replay_index: 1 },
      { line_id: 'warmup.tap', replay_index: 2 },
    ]);
  });

  it('fails closed on a tampered clip (hash mismatch): nothing plays', async () => {
    const { ctx, factory } = mockFactory();
    const engine = new AudioEngine({ contextFactory: factory });
    await engine.unlock();
    const vm = buildVoiceManifest(await manifest(), { baseUrl: '/audio', packKind: 'production' });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const voice = new ManifestVoiceService({
      host: engine.voiceHost(),
      manifest: vm,
      language: 'hi-IN',
      fetchClip: async () => new Uint8Array([6, 6, 6]).buffer,
    });
    const r = await voice.play('consent.core.question').ended;
    expect(r.status).toBe('interrupted');
    expect(ctx.decoded).toHaveLength(0);
    err.mockRestore();
  });

  it('without a recording or placeholder, a line resolves immediately as interrupted (no TTS)', async () => {
    const { voice } = await rig();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = await voice.play('attract.greeting').ended;
    expect(r.status).toBe('interrupted');
    expect(r.placeholder).toBe(false);
    warn.mockRestore();
  });

  it('the placeholder is off unless the build flag is set, even when requested', async () => {
    expect(DEV_VOICE_PLACEHOLDER_ALLOWED).toBe(false);
    const { factory } = mockFactory();
    const engine = new AudioEngine({ contextFactory: factory });
    const voice = new ManifestVoiceService({
      host: engine.voiceHost(),
      manifest: null,
      language: 'en-IN',
      devPlaceholder: true,
    });
    expect(voice.isDevPlaceholder).toBe(false);
    expect(voice.has('attract.greeting')).toBe(false);
  });

  it('with the dev flag set at build time, the placeholder is allowed', async () => {
    vi.stubEnv('VITE_DEV_VOICE_PLACEHOLDER', 'true');
    vi.resetModules();
    const mod = await import('../VoiceService.ts');
    expect(mod.DEV_VOICE_PLACEHOLDER_ALLOWED).toBe(true);
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});

describe('voice catalogue', () => {
  it('matches content/i18n/lines.yaml (ids, never-voice flags, durations)', () => {
    const yamlPath = resolve(process.cwd(), '../../content/i18n/lines.yaml');
    const raw = parse(readFileSync(yamlPath, 'utf8')) as {
      lines: {
        id: string;
        voice_forbidden: boolean;
        target_duration_ms: number;
        category: string;
      }[];
    };
    expect(Object.keys(LINES).sort()).toEqual(raw.lines.map((l) => l.id).sort());
    for (const l of raw.lines) {
      expect(LINES[l.id]?.voiceForbidden).toBe(l.voice_forbidden);
      expect(LINES[l.id]?.targetDurationMs).toBe(l.target_duration_ms);
      expect(LINES[l.id]?.category).toBe(l.category);
    }
  });

  it('every line the onboarding and report screens speak exists in the catalogue', () => {
    const used = [
      'attract.greeting',
      'attract.touch_to_start',
      'onboarding.globe_hint',
      'consent.core.segment_1',
      'consent.core.segment_4',
      'consent.core.question',
      'consent.archive.question',
      'consent.declined_thanks',
      'bands.age.question',
      'bands.under_18.goodbye',
      'bands.prefer_not_to_say',
      'warmup.intro',
      'warmup.tap',
      'warmup.hold',
      'warmup.choice',
      'warmup.done',
      'feedback.well_done',
      'feedback.try_again',
      'report.thank_you',
      'report.what_this_is_about',
      'report.intro',
      'report.example_label',
      'report.disclaimer.snapshot',
      'report.qr_offer',
      'report.show_privately',
      'survey.enjoy',
      'survey.play_again',
      'optin.contact.question',
      'optin.thanks',
    ];
    for (const id of used) expect(LINES[id], id).toBeDefined();
    for (const lang of ['hi_in', 'mr_in', 'ta_in', 'en_in']) {
      expect(LINES[`onboarding.language_face.${lang}`]).toBeDefined();
      expect(LINES[`onboarding.language_confirm.${lang}`]).toBeDefined();
    }
  });

  it('phone digits are on the never-voice list', () => {
    for (const d of [
      'zero',
      'one',
      'two',
      'three',
      'four',
      'five',
      'six',
      'seven',
      'eight',
      'nine',
    ])
      expect(LINES[`optin.digit.${d}`]?.voiceForbidden).toBe(true);
  });
});
