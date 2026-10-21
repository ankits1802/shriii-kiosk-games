/**
 * "ASR only proposes" (VOX-04): helpers the input layer uses to turn a speech result into UI behaviour.
 * A voice result is always mirrored by an icon: it can only name a code that is on screen, a proposal
 * highlights that icon, and only a tap (or a high-confidence result where the prompt allows it) commits.
 */
import type { AsrRuntimePolicy } from './types.ts';

export type ProposalAction =
  /** Nothing usable: keep waiting for touch. */
  | { readonly kind: 'none' }
  /** Highlight the icon; a tap on it (or the confirm tick) commits. */
  | { readonly kind: 'propose'; readonly code: string; readonly confidence: number }
  /** Commit by voice (icon is highlighted as the committed answer). */
  | { readonly kind: 'commit'; readonly code: string; readonly confidence: number };

export interface ClassifyOptions {
  /** Codes currently shown as icons (touch options). */
  readonly touchCodes: readonly string[];
  /** Prompt requires a tick confirmation anyway: voice can never commit on its own. */
  readonly requireConfirm?: boolean;
  /** Private report or consent-like prompt: voice is ignored entirely. */
  readonly touchOnly?: boolean;
}

export function classifyProposal(
  result: { readonly label: string | null; readonly confidence: number | null },
  policy: Pick<AsrRuntimePolicy, 'min_propose_confidence' | 'min_commit_confidence'>,
  options: ClassifyOptions,
): ProposalAction {
  if (options.touchOnly || result.label === null || result.confidence === null)
    return { kind: 'none' };
  if (!options.touchCodes.includes(result.label)) return { kind: 'none' }; // never a code without an icon
  if (result.confidence < policy.min_propose_confidence) return { kind: 'none' };
  if (!options.requireConfirm && result.confidence >= policy.min_commit_confidence) {
    return { kind: 'commit', code: result.label, confidence: result.confidence };
  }
  return { kind: 'propose', code: result.label, confidence: result.confidence };
}

/** VOX-04 AC: voiceOptions must be a subset of touchOptions for every SayOrTouch prompt. */
export function assertVoiceSubset(
  promptId: string,
  voiceCodes: readonly string[],
  touchCodes: readonly string[],
): void {
  const extra = voiceCodes.filter((c) => !touchCodes.includes(c));
  if (extra.length > 0) {
    throw new Error(`prompt ${promptId}: voice codes [${extra.join(', ')}] have no touch option`);
  }
}
