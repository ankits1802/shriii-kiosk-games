/**
 * Science inputs shown by the research pages, read server-side from the frozen YAML files
 * (see load-science.server.ts). Plain data so it can cross the server/client boundary.
 */
export interface HypothesisInfo {
  readonly id: string;
  readonly family: string | null;
  readonly construct: string | null;
  readonly criterion: string | null;
  readonly kind: string | null;
  readonly pathways: readonly string[];
  readonly expectedSign: string | null;
  readonly note: string | null;
}

export interface ScienceConfig {
  readonly gates: {
    readonly path: string;
    readonly version: string;
    readonly status: string;
    readonly sha256: string;
    readonly retest: {
      readonly statistic: string;
      readonly pointMin: number | null;
      readonly lowerBoundMin: number | null;
      readonly ciLevel: number;
      readonly pooledLanguagePointMin: number | null;
      readonly minPairsPerCell: number | null;
    };
    readonly reliability: {
      readonly pointMin: number | null;
      readonly lowerBoundMin: number | null;
    };
    readonly convergent: {
      readonly lowerBoundGt: number | null;
      readonly correction: string | null;
    };
    readonly invariance: {
      readonly requiredGroupings: readonly string[];
      readonly maxFreedParameterShare: number | null;
    };
    readonly battery: {
      readonly minLanguageGroups: number | null;
      readonly differentialExclusionMaxPp: number | null;
      readonly signoffRoles: readonly string[];
    };
    readonly minNamedSigners: number | null;
    readonly fairnessCellMinN: number | null;
    readonly practiceEffectDFlag: number | null;
    readonly floorCeilingFlagShare: number | null;
    readonly caps: readonly { construct: string; maxStatus: string; reason: string | null }[];
    readonly withholds: readonly { construct: string; pathway: string; reason: string | null }[];
  };
  readonly hypotheses: {
    readonly path: string;
    readonly version: string;
    readonly status: string;
    readonly sha256: string;
    readonly r0: number | null;
    readonly ciLevel: number;
    readonly items: readonly HypothesisInfo[];
  };
}

/** Rules B1-B6 of the trait gate, with what each one checks (gates.yaml comments). */
export const TRAIT_GATE_RULES: Readonly<Record<string, string>> = {
  B1: 'Retest ICC(A,1) meets the point and lower-bound targets',
  B2: 'Composite reliability (omega) meets the point and lower-bound targets',
  B3: 'Observed convergent r lower bound above r0 with the right sign; own > discriminant',
  B4: 'Measurement invariance across the required groupings',
  B5: 'Provisional or final norms exist; SEM rule leaves bands interpretable',
  B6: 'Named sign-offs recorded',
};

/** Rules A1-A5 of the battery release gate. */
export const BATTERY_GATE_RULES: Readonly<Record<string, string>> = {
  A1: 'At least the minimum number of language groups qualify',
  A2: 'Enough Tier-1 constructs meet trait rules B1 and B2',
  A3: 'Criterion invariance, no unresolved large DIF, exclusion rates within tolerance',
  A4: 'Open-public mode equivalence (only for open_public)',
  A5: 'PI / research lead and ethics officer sign-off',
};
