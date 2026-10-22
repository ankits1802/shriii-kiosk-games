/**
 * Serializable snapshot of the voice-line content the admin console reviews. Built on the server at
 * build time from the repository (content/i18n, tools/audio-pipeline/config/qc.yaml) by
 * `load-content.server.ts`, because the API has no content-line endpoint yet.
 */

export interface LineRecording {
  /** Recording status from lines.yaml: not_scripted | scripted | recorded | audio_qc | approved. */
  readonly status: string;
  /** ITC state carried in lines.yaml (common.v1 itc_state). */
  readonly itcState: string;
}

export interface CatalogueLine {
  readonly id: string;
  readonly category: string;
  readonly moduleId: string | null;
  readonly speakerRole: string;
  readonly context: string;
  /** en-IN reference text: recording-script source only, never synthesised in production. */
  readonly referenceText: string;
  readonly targetDurationMs: number;
  readonly tone: string;
  readonly voiceForbidden: boolean;
  readonly recording: Readonly<Record<string, LineRecording>>;
}

export interface HistoryEvent {
  readonly fromStatus: string;
  readonly toStatus: string;
  readonly by: string;
  readonly role: string;
  readonly date: string;
  readonly comment: string;
  readonly source: string;
}

export interface TranslationEntry {
  readonly id: string;
  readonly status: string;
  readonly text: string;
  readonly backTranslation: string;
  readonly registerNote: string;
  readonly translatorNote: string;
  readonly record: boolean;
  /** The catalogue reference text changed since this translation was made. */
  readonly stale: boolean;
  readonly history: readonly HistoryEvent[];
}

export interface TranslationFile {
  readonly language: string;
  readonly script: string;
  readonly provenance: string;
  readonly sourceCatalogueVersion: string;
  readonly entries: Readonly<Record<string, TranslationEntry>>;
}

export interface WorkflowStatus {
  readonly id: string;
  readonly rank: number | null;
  readonly label: string;
  readonly description: string;
  readonly signoffRole: string | null;
  readonly requires: readonly string[];
  readonly machineDraft: boolean;
}

export interface Workflow {
  readonly initialStatus: string;
  readonly roles: readonly string[];
  readonly statuses: readonly WorkflowStatus[];
  readonly transitions: Readonly<Record<string, readonly string[]>>;
  readonly independentSigners: readonly (readonly [string, string])[];
  readonly packEligibility: Readonly<Record<string, readonly string[]>>;
  readonly languages: readonly {
    readonly tag: string;
    readonly name: string;
    readonly script: string;
  }[];
}

/** Audio QC thresholds (tools/audio-pipeline/config/qc.yaml); never constants in the UI. */
export interface QcThresholds {
  readonly targetLufs: number;
  readonly toleranceLu: number;
  readonly truePeakCeilingDbtp: number;
  readonly minSampleRateHz: number;
  readonly maxChannels: number;
  readonly minDurationMs: number;
  readonly maxDurationMs: number;
  readonly clipSampleThreshold: number;
  readonly clipMinRunSamples: number;
  readonly clipMaxEventsReject: number;
  readonly durationTargetTolerance: number;
  readonly maxRatioToSource: number;
  readonly longClipIsError: boolean;
}

export interface ContentSource {
  readonly path: string;
  readonly sha256: string;
}

export interface ContentSnapshot {
  readonly catalogueVersion: string;
  readonly referenceLanguage: string;
  readonly languages: readonly string[];
  readonly lines: readonly CatalogueLine[];
  readonly translations: Readonly<Record<string, TranslationFile>>;
  readonly workflow: Workflow;
  readonly qc: QcThresholds;
  readonly sources: readonly ContentSource[];
  readonly builtAt: string;
  /** Validation problems found while loading (shown to the reviewer, never hidden). */
  readonly problems: readonly string[];
}
