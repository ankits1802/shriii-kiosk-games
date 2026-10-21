/**
 * Pre-recorded voice by line id x language (VOX-01/02). The dev Web Speech placeholder is intentionally
 * NOT exported: it is reachable only through a compile-time-gated dynamic import inside the service.
 */
export { CATALOGUE_LANGUAGES, CATALOGUE_VERSION, LINES } from './catalogue/lines.generated.ts';
export type { LineMeta } from './catalogue/types.ts';
export {
  buildVoiceManifest,
  loudnessGain,
  missingLines,
  type PackKind,
  playableState,
  type ResolvedClip,
  resolveClip,
  TARGET_LUFS,
  type VoiceManifest,
} from './manifest.ts';
export {
  type ClipFetcher,
  createVoiceService,
  DEV_VOICE_PLACEHOLDER_ALLOWED,
  ManifestVoiceService,
  VOICE_DUCK,
  type VoiceServiceOptions,
} from './VoiceService.ts';
