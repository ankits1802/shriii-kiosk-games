/** Typed shapes of the generated report rules (sourced from stats/measurement-model/*.yaml). */

export interface DisplayRule {
  readonly batteryGate: string;
  readonly traitStatusIn: readonly string[];
  readonly sessionValidForReport: boolean;
  readonly excludeNotEnoughToSay: boolean;
  readonly releasePackValidAndUnexpired: boolean;
  readonly reportMode: string;
}

export interface ReportLimits {
  readonly bandCount: number;
  readonly minTraitsShown: number;
  readonly maxTraitsShown: number;
  readonly disclaimerRequired: boolean;
  /** Battery gate must be open in at least this many language groups (gates.yaml battery_gate A1). */
  readonly batteryMinLanguageGroups: number;
  readonly releasePackDefaultExpiryDays: number;
}

export interface ConstructReportRule {
  readonly maxStatus: string;
  readonly restricted: boolean;
  readonly phraseKeys: {
    readonly pole_a: string;
    readonly centre: string;
    readonly pole_b: string;
  };
}

export interface SemRule {
  /** CI level for the SEM band check (e.g. 0.90). */
  readonly ciLevel: number;
  /** A CI overlapping MORE than this many band boundaries means "not enough to say". */
  readonly maxBandBoundariesOverlapped: number;
  /** Bands narrower than this many SEMs mean "not enough to say". */
  readonly minBandWidthSem: number;
}
