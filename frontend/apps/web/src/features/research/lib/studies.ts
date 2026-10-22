/**
 * Study-management helpers (spec section 8): retest windows from measurement occasions, retest
 * candidates from completed first-occasion sessions, and protocol-document hashing.
 */
import type { OccasionRow, SessionOut } from '../api/types';

export type WindowState = 'not_open' | 'open' | 'closed' | 'done';

export interface RetestCandidate {
  readonly pid: string;
  /** First-occasion completion date (YYYY-MM-DD). */
  readonly anchor: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly state: WindowState;
  readonly daysSinceAnchor: number;
}

const DAY = 86_400_000;
const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Window state for a retest anchored at `anchorMs`, given `min`/`max` offset days. */
export function windowState(
  anchorMs: number,
  nowMs: number,
  min: number,
  max: number,
  done: boolean,
): WindowState {
  if (done) return 'done';
  const days = (nowMs - anchorMs) / DAY;
  if (days < min) return 'not_open';
  if (days <= max) return 'open';
  return 'closed';
}

/**
 * Retest candidates: participants whose first occasion has a completed, linked session. Participants
 * already seen at the retest occasion are marked done.
 */
export function retestCandidates(
  sessions: readonly SessionOut[],
  first: OccasionRow,
  retest: OccasionRow,
  nowMs: number,
): RetestCandidate[] {
  const min = retest.offset_days_min ?? 14;
  const max = retest.offset_days_max ?? 28;
  const anchors = new Map<string, number>();
  const done = new Set<string>();
  for (const s of sessions) {
    if (!s.participant_pid || s.status !== 'completed') continue;
    if (s.occasion_id === retest.occasion_id) done.add(s.participant_pid);
    if (s.occasion_id === first.occasion_id) {
      const t = Date.parse(s.completed_at ?? s.started_at);
      const prev = anchors.get(s.participant_pid);
      if (Number.isFinite(t) && (prev === undefined || t > prev)) anchors.set(s.participant_pid, t);
    }
  }
  return [...anchors.entries()]
    .map(([pid, t]) => ({
      pid,
      anchor: isoDate(t),
      windowStart: isoDate(t + min * DAY),
      windowEnd: isoDate(t + max * DAY),
      state: windowState(t, nowMs, min, max, done.has(pid)),
      daysSinceAnchor: Math.floor((nowMs - t) / DAY),
    }))
    .sort((a, b) => a.windowStart.localeCompare(b.windowStart) || a.pid.localeCompare(b.pid));
}

export function windowCounts(candidates: readonly RetestCandidate[]): Record<WindowState, number> {
  const out: Record<WindowState, number> = { not_open: 0, open: 0, closed: 0, done: 0 };
  for (const c of candidates) out[c.state] += 1;
  return out;
}

/** The occasion with sequence 1 and the first later one with a retest window, if any. */
export function retestPair(
  occasions: readonly OccasionRow[],
): { first: OccasionRow; retest: OccasionRow } | null {
  const sorted = [...occasions].sort((a, b) => a.sequence - b.sequence);
  const first = sorted[0];
  const retest = sorted.find((o) => o !== first && o.offset_days_min !== null);
  return first && retest ? { first, retest } : null;
}

/** SHA-256 of a protocol document (hex), computed in the browser before registering it. */
export async function sha256Hex(data: ArrayBuffer | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Study ids accepted by the API (studies.py StudyIn pattern). */
export const STUDY_ID_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,127}$/;
