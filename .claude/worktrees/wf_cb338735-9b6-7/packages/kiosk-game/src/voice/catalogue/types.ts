/** Metadata for one voice line (from content/i18n/lines.yaml). */
export interface LineMeta {
  readonly category: string;
  readonly moduleId: string | null;
  readonly speakerRole: string;
  /** Never-voice list (KSK-05): refused on the speaker output. */
  readonly voiceForbidden: boolean;
  readonly targetDurationMs: number;
  /** Recording status per language (e.g. `scripted`, `recorded`, `approved`). */
  readonly recording: Readonly<Record<string, string>>;
}
