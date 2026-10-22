/**
 * Voice-line ids used by The Weighing Post. Lines listed in `config.audio_keys` exist in the catalogue
 * (`content/i18n/lines.yaml`); the others are requested additions and play only once the voice
 * service has them (`VoiceService.has`), so the episode never depends on an unrecorded clip: a missing
 * prompt simply anchors latency on the visual go signal instead of the prompt's end.
 */
import type { LineId } from '../../core/contracts.ts';
import type { WeighItem } from '../../paradigms/weighing-post.ts';
import { discrepancyTicks } from './schedule.ts';

export const LINE = {
  intro: 'weighing_post.intro',
  practice: 'weighing_post.practice',
  outro: 'weighing_post.outro',
  replay: 'weighing_post.replay',
  newRule: 'weighing_post.new_rule',
  quantityPrefix: 'weighing_post.quantity_prefix',
} as const satisfies Record<string, LineId>;

/** Spoken reading of the needle (pictured quantity, never a numeral on screen). */
export function readingLine(
  item: Pick<WeighItem, 'trueWeight' | 'declaredWeight'>,
  steady: boolean,
): LineId {
  if (!steady) return 'weighing_post.reading.unsteady';
  const d = discrepancyTicks(item);
  if (d === 0) return 'weighing_post.reading.balanced';
  const n = Math.min(3, Math.abs(d));
  return d > 0 ? `weighing_post.reading.light_${n}` : `weighing_post.reading.heavy_${n}`;
}

/** Spoken prompt of a dilemma / gamble / luck / probe trial. */
export function promptLine(kind: string): LineId {
  return `weighing_post.${kind}.prompt`;
}

/** Long-press help line of a choice token. */
export function optionLine(kind: string, code: string): LineId {
  return `weighing_post.option.${kind}.${code}`;
}

/** Requested lines that are not yet in the catalogue (for the content owner). */
export function requestedLines(): LineId[] {
  const out: LineId[] = ['weighing_post.reading.unsteady', 'weighing_post.reading.balanced'];
  for (const n of [1, 2, 3])
    out.push(`weighing_post.reading.light_${n}`, `weighing_post.reading.heavy_${n}`);
  for (const k of [
    'bribe',
    'overpayment',
    'assistant_mistake',
    'fraud_found',
    'gamble',
    'luck_token',
  ])
    out.push(promptLine(k));
  return out;
}
