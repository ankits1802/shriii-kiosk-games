/**
 * Voice manifest: resolves a line id x language to a loudness-normalised Opus clip from the signed
 * content manifest (`ContentManifest.audio_clips`, VOX-02).
 *
 * Pack rules (VOX-07): production packs play only `approved` clips; pilot packs also accept
 * `think_aloud_tested`; dev packs accept any recorded clip. Anything else resolves to null and the
 * line is treated as missing (production builds are expected to fail earlier on missing keys).
 */
import type { ContentManifest, ItcState, LanguageTag } from '@shriii/contracts';

export type PackKind = 'production' | 'pilot' | 'dev';

/** One resolved clip. */
export interface ResolvedClip {
  readonly key: string;
  readonly language: LanguageTag;
  readonly url: string;
  readonly sha256: string;
  readonly durationMs: number;
  readonly voiceForbidden: boolean;
  /** Linear gain correcting residual loudness error towards -16 LUFS (clamped to +-6 dB). */
  readonly gain: number;
  readonly reviewState: ItcState;
}

export interface VoiceManifest {
  readonly version: string;
  readonly bundleHash: string;
  readonly languages: readonly LanguageTag[];
  readonly packKind: PackKind;
  readonly baseUrl: string;
  readonly clips: ReadonlyMap<string, ReadonlyMap<LanguageTag, ResolvedClip>>;
}

/** Target integrated loudness of every clip (VOX-02). */
export const TARGET_LUFS = -16;

const PILOT_STATES: ReadonlySet<ItcState> = new Set<ItcState>(['approved', 'think_aloud_tested']);
const DEV_STATES: ReadonlySet<ItcState> = new Set<ItcState>([
  'recorded',
  'audio_qc',
  'think_aloud_tested',
  'approved',
]);

/** Whether a review state may be played in a pack of the given kind. */
export function playableState(state: ItcState, packKind: PackKind): boolean {
  if (packKind === 'production') return state === 'approved';
  if (packKind === 'pilot') return PILOT_STATES.has(state);
  return DEV_STATES.has(state);
}

/** Loudness correction gain for a measured clip (1 when unmeasured). */
export function loudnessGain(lufs: number | null): number {
  if (lufs === null || !Number.isFinite(lufs)) return 1;
  const db = Math.max(-6, Math.min(6, TARGET_LUFS - lufs));
  return 10 ** (db / 20);
}

function joinUrl(base: string, file: string): string {
  if (/^[a-z]+:\/\//i.test(file) || file.startsWith('/')) return file;
  return `${base.replace(/\/+$/, '')}/${file.replace(/^\/+/, '')}`;
}

/** Build the runtime manifest from a validated content manifest. */
export function buildVoiceManifest(
  content: ContentManifest,
  options: { readonly baseUrl: string; readonly packKind: PackKind },
): VoiceManifest {
  const clips = new Map<string, Map<LanguageTag, ResolvedClip>>();
  for (const e of content.audio_clips) {
    if (!playableState(e.review_state, options.packKind)) continue;
    let byLang = clips.get(e.key);
    if (!byLang) {
      byLang = new Map();
      clips.set(e.key, byLang);
    }
    byLang.set(e.language, {
      key: e.key,
      language: e.language,
      url: joinUrl(options.baseUrl, e.file),
      sha256: e.sha256,
      durationMs: e.duration_ms,
      voiceForbidden: e.voice_forbidden,
      gain: loudnessGain(e.loudness_lufs),
      reviewState: e.review_state,
    });
  }
  return {
    version: content.content_pack_version,
    bundleHash: content.bundle_hash,
    languages: content.languages,
    packKind: options.packKind,
    baseUrl: options.baseUrl,
    clips,
  };
}

/** Resolve a clip, or null when the line has no playable recording in that language. */
export function resolveClip(
  manifest: VoiceManifest | null,
  lineId: string,
  language: LanguageTag,
): ResolvedClip | null {
  return manifest?.clips.get(lineId)?.get(language) ?? null;
}

/** Lines missing for a language (pack QA; the production build fails on any). */
export function missingLines(
  manifest: VoiceManifest | null,
  lineIds: readonly string[],
  language: LanguageTag,
): string[] {
  return lineIds.filter((id) => resolveClip(manifest, id, language) === null);
}
