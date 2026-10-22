/**
 * Server-only loader for the content snapshot (runs during `next build` / server render, never in
 * the browser). Reads the committed voice-line catalogue, recording-script translations, the ITC
 * workflow and the audio QC thresholds, validates them, and returns a plain serializable object.
 *
 * The API has no content-line endpoint yet (see missing-endpoints.ts); once it exists the content
 * page should read from it and this loader becomes a fallback for offline review.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readVoiceLineCatalogue } from '@shriii/contracts';
import { parse } from 'yaml';
import type {
  CatalogueLine,
  ContentSnapshot,
  ContentSource,
  HistoryEvent,
  QcThresholds,
  TranslationEntry,
  TranslationFile,
  Workflow,
  WorkflowStatus,
} from './content-types';

type Raw = Record<string, unknown>;

const isRaw = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

export const CONTENT_PATHS = {
  catalogue: 'content/i18n/lines.yaml',
  workflow: 'content/i18n/translations/workflow.yaml',
  translation: (lang: string) => `content/i18n/translations/${lang}.yaml`,
  qc: 'tools/audio-pipeline/config/qc.yaml',
} as const;

/** Repository root: the nearest ancestor holding pnpm-workspace.yaml. */
export function findRepoRoot(start: string = process.cwd()): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(/*turbopackIgnore: true*/ dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`repository root not found above ${start}`);
    dir = parent;
  }
}

/** NFC + collapsed whitespace, then sha256 truncated to 16 hex (tools/i18n `source_hash`). */
export function sourceHash(referenceText: string): string {
  const normalised = referenceText.normalize('NFC').split(/\s+/).filter(Boolean).join(' ');
  return createHash('sha256').update(normalised, 'utf8').digest('hex').slice(0, 16);
}

function readDoc(root: string, rel: string, sources: ContentSource[]): unknown {
  const bytes = readFileSync(join(/*turbopackIgnore: true*/ root, rel));
  sources.push({ path: rel, sha256: createHash('sha256').update(bytes).digest('hex') });
  return parse(bytes.toString('utf8'));
}

function toLines(raw: Raw): CatalogueLine[] {
  return (Array.isArray(raw.lines) ? raw.lines : []).filter(isRaw).map((l) => {
    const recording: Record<string, { status: string; itcState: string }> = {};
    if (isRaw(l.recording)) {
      for (const [lang, r] of Object.entries(l.recording)) {
        if (isRaw(r))
          recording[lang] = {
            status: str(r.status, 'not_scripted'),
            itcState: str(r.itc_state, 'draft'),
          };
      }
    }
    return {
      id: str(l.id),
      category: str(l.category),
      moduleId: typeof l.module_id === 'string' ? l.module_id : null,
      speakerRole: str(l.speaker_role),
      context: str(l.context),
      referenceText: str(l.reference_text),
      targetDurationMs: typeof l.target_duration_ms === 'number' ? l.target_duration_ms : 0,
      tone: str(l.tone),
      voiceForbidden: l.voice_forbidden === true,
      recording,
    };
  });
}

function toWorkflow(raw: unknown, problems: string[]): Workflow {
  if (!isRaw(raw)) {
    problems.push(`${CONTENT_PATHS.workflow}: not a mapping`);
    raw = {};
  }
  const w = raw as Raw;
  const statuses: WorkflowStatus[] = (Array.isArray(w.statuses) ? w.statuses : [])
    .filter(isRaw)
    .map((s) => ({
      id: str(s.id),
      rank: typeof s.rank === 'number' ? s.rank : null,
      label: str(s.label, str(s.id)),
      description: str(s.description).trim(),
      signoffRole: typeof s.signoff_role === 'string' ? s.signoff_role : null,
      requires: strs(s.requires),
      machineDraft: s.machine_draft === true,
    }));
  const transitions: Record<string, string[]> = {};
  if (isRaw(w.transitions))
    for (const [k, v] of Object.entries(w.transitions)) transitions[k] = strs(v);
  const ids = new Set(statuses.map((s) => s.id));
  for (const [from, tos] of Object.entries(transitions)) {
    for (const to of [from, ...tos])
      if (!ids.has(to))
        problems.push(`${CONTENT_PATHS.workflow}: unknown status "${to}" in transitions`);
  }
  const pack: Record<string, string[]> = {};
  if (isRaw(w.pack_eligibility))
    for (const [k, v] of Object.entries(w.pack_eligibility)) pack[k] = strs(v);
  return {
    initialStatus: str(w.initial_status, statuses[0]?.id ?? ''),
    roles: strs(w.roles),
    statuses,
    transitions,
    independentSigners: (Array.isArray(w.independent_signers) ? w.independent_signers : [])
      .map(strs)
      .filter((p) => p.length === 2)
      .map((p) => [p[0] as string, p[1] as string] as const),
    packEligibility: pack,
    languages: (Array.isArray(w.languages) ? w.languages : []).filter(isRaw).map((l) => ({
      tag: str(l.tag),
      name: str(l.name, str(l.tag)),
      script: str(l.script),
    })),
  };
}

function needNumber(section: unknown, key: string, problems: string[], where: string): number {
  const v = isRaw(section) ? section[key] : undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    problems.push(`${CONTENT_PATHS.qc}: ${where}.${key} missing`);
    return Number.NaN;
  }
  return v;
}

function toQc(raw: unknown, problems: string[]): QcThresholds {
  const q = isRaw(raw) ? raw : {};
  const n = (section: string, key: string) => needNumber(q[section], key, problems, section);
  return {
    targetLufs: n('loudness', 'target_lufs'),
    toleranceLu: n('loudness', 'tolerance_lu'),
    truePeakCeilingDbtp: n('loudness', 'true_peak_ceiling_dbtp'),
    minSampleRateHz: n('input', 'min_sample_rate_hz'),
    maxChannels: n('input', 'max_channels'),
    minDurationMs: n('input', 'min_duration_ms'),
    maxDurationMs: n('input', 'max_duration_ms'),
    clipSampleThreshold: n('clipping', 'sample_threshold'),
    clipMinRunSamples: n('clipping', 'min_run_samples'),
    clipMaxEventsReject: n('clipping', 'max_events_reject'),
    durationTargetTolerance: n('duration', 'target_tolerance_fraction'),
    maxRatioToSource: n('duration', 'max_ratio_to_source'),
    longClipIsError: isRaw(q.duration) && q.duration.long_clip_is_error === true,
  };
}

function toHistory(v: unknown): HistoryEvent[] {
  return (Array.isArray(v) ? v : []).filter(isRaw).map((h) => ({
    fromStatus: str(h.from_status),
    toStatus: str(h.to_status),
    by: str(h.by),
    role: str(h.role),
    date: h.date instanceof Date ? h.date.toISOString().slice(0, 10) : str(h.date),
    comment: str(h.comment),
    source: str(h.source, 'manual'),
  }));
}

function toTranslation(
  raw: unknown,
  lang: string,
  lineText: ReadonlyMap<string, string>,
  problems: string[],
): TranslationFile {
  const t = isRaw(raw) ? raw : {};
  if (str(t.language) !== lang)
    problems.push(`${CONTENT_PATHS.translation(lang)}: language field is "${str(t.language)}"`);
  const entries: Record<string, TranslationEntry> = {};
  for (const e of (Array.isArray(t.entries) ? t.entries : []).filter(isRaw)) {
    const id = str(e.id);
    const ref = lineText.get(id);
    if (ref === undefined) {
      problems.push(`${CONTENT_PATHS.translation(lang)}: entry "${id}" is not in the catalogue`);
      continue;
    }
    entries[id] = {
      id,
      status: str(e.status),
      text: str(e.text).trim(),
      backTranslation: str(e.back_translation).trim(),
      registerNote: str(e.register_note).trim(),
      translatorNote: str(e.translator_note).trim(),
      record: e.record !== false,
      stale: str(e.source_hash) !== sourceHash(ref),
      history: toHistory(e.history),
    };
  }
  return {
    language: lang,
    script: str(t.script),
    provenance: str(t.provenance).trim(),
    sourceCatalogueVersion: str(t.source_catalogue_version),
    entries,
  };
}

/** Load and validate the content snapshot from the repository. */
export function loadContentSnapshot(root: string = findRepoRoot()): ContentSnapshot {
  const sources: ContentSource[] = [];
  const problems: string[] = [];

  const rawCatalogue = readDoc(root, CONTENT_PATHS.catalogue, sources);
  const checked = readVoiceLineCatalogue(rawCatalogue);
  if (!checked) {
    for (const e of readVoiceLineCatalogue.errors ?? []) {
      problems.push(`${CONTENT_PATHS.catalogue}${e.instancePath}: ${e.message ?? e.keyword}`);
    }
  }
  const cat = isRaw(rawCatalogue) ? rawCatalogue : {};
  const lines = toLines(cat);
  const lineText = new Map(lines.map((l) => [l.id, l.referenceText]));

  const workflow = toWorkflow(readDoc(root, CONTENT_PATHS.workflow, sources), problems);
  const translations: Record<string, TranslationFile> = {};
  for (const { tag } of workflow.languages) {
    const rel = CONTENT_PATHS.translation(tag);
    if (!existsSync(join(/*turbopackIgnore: true*/ root, rel))) {
      problems.push(`${rel}: missing`);
      continue;
    }
    translations[tag] = toTranslation(readDoc(root, rel, sources), tag, lineText, problems);
  }
  const qc = toQc(readDoc(root, CONTENT_PATHS.qc, sources), problems);

  return {
    catalogueVersion: str(cat.catalogue_version),
    referenceLanguage: str(cat.reference_language, 'en-IN'),
    languages: strs(cat.languages),
    lines,
    translations,
    workflow,
    qc,
    sources,
    builtAt: new Date().toISOString(),
    problems,
  };
}
