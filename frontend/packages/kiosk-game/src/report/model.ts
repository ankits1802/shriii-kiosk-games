/**
 * REP-01/02 report model: decides between the thank-you scene (default, fail-closed) and a player
 * report, applying the display rule from gates.yaml in full:
 *
 *   policy allows player reports
 *   AND release pack present, signature-valid, unexpired, dictionary-matched
 *   AND battery gate open for (language, pathway, site_mode) AND open in >= min_language_groups languages
 *   AND session valid for report
 *   AND per trait: status (capped by the construct's max status) in trait_status_in, not permanently
 *       withheld, band computed (not "not enough to say"), phrase key allowlisted by BOTH the pack and
 *       the dictionary, no digits anywhere.
 *
 * Demo mode is built ONLY from a fictional {@link DemoProfile} (no session-derived inputs by type).
 */
import type {
  ConstructId,
  LanguageTag,
  Pathway,
  ReleasePack,
  SiteMode,
  TraitGateStatus,
} from '@shriii/contracts';
import type {
  BandCode,
  DemoProfile,
  DemoReportModel,
  PlayerReportModel,
  ReleasePackReader,
  ReportModel,
  ReportTrait,
  ThankYouReportModel,
} from '../core/contracts.ts';
import type { BandOutcome } from './bands.ts';
import type { PackFailure } from './releasePack.ts';
import {
  CONSTRUCT_REPORT,
  DISPLAY_RULE,
  PERMANENT_WITHHOLD,
  REPORT_LIMITS,
} from './rules/rules.generated.ts';

export type DeliveryMode = 'spoken' | 'printed' | 'qr' | 'screen';

/** A displayed trait plus its presentation style (banded vs broad style). */
export interface DisplayTrait extends ReportTrait {
  readonly style: 'banded' | 'broad_style';
}

/** Default disclaimer key ("a snapshot, not a diagnosis") when no pack is available. */
export const DEFAULT_DISCLAIMER_KEY = 'report.disclaimer.snapshot';

const STATUS_RANK: Readonly<Record<string, number>> = {
  withheld: -1,
  unvalidated: 0,
  research_only: 1,
  validated_broad_style: 2,
  validated_banded: 3,
};

/** Lower of two statuses (`withheld` always wins). */
export function capStatus(status: TraitGateStatus | string, cap: string): string {
  const a = STATUS_RANK[status] ?? -1;
  const b = STATUS_RANK[cap] ?? -1;
  if (a < 0 || b < 0) return 'withheld';
  return a <= b ? status : cap;
}

const HAS_DIGIT = /\d/;

export interface PlayerReportInputs {
  readonly language: LanguageTag;
  readonly pathway: Pathway;
  readonly siteMode: SiteMode;
  /** Deployment policy: `thank_you` forces the thank-you scene. */
  readonly policyMode: 'thank_you' | 'player_report';
  readonly sessionValidForReport: boolean;
  readonly packReader: ReleasePackReader & { failure?(): PackFailure | null };
  /** Band for a trait from the session's indicator preview through the pack (REP-01 evaluator). */
  readonly bandFor: (trait: ConstructId, pack: ReleasePack) => BandOutcome;
  readonly deliveryModes?: readonly DeliveryMode[];
}

function thankYou(
  language: LanguageTag,
  reason: ThankYouReportModel['reason'],
  deliveryModes: readonly DeliveryMode[],
): ThankYouReportModel {
  return {
    mode: 'thank_you',
    reason,
    language,
    disclaimerKey: DEFAULT_DISCLAIMER_KEY,
    deliveryModes,
  };
}

/** True when the battery gate is open for this cell and in enough language groups (gates.yaml A1). */
export function batteryGateOpen(
  pack: ReleasePack,
  language: LanguageTag,
  pathway: Pathway,
  siteMode: SiteMode,
): boolean {
  const cell = pack.battery_gates.find(
    (g) => g.language === language && g.pathway === pathway && g.site_mode === siteMode,
  );
  if (!cell || cell.status !== DISPLAY_RULE.batteryGate) return false;
  const openLanguages = new Set(
    pack.battery_gates
      .filter(
        (g) =>
          g.pathway === pathway &&
          g.site_mode === siteMode &&
          g.status === DISPLAY_RULE.batteryGate,
      )
      .map((g) => g.language),
  );
  return openLanguages.size >= REPORT_LIMITS.batteryMinLanguageGroups;
}

/** Build the report model; any failed condition yields the thank-you model (fail closed). */
export function buildPlayerReportModel(inputs: PlayerReportInputs): ReportModel {
  const modes = inputs.deliveryModes ?? ['spoken', 'screen'];
  if (inputs.policyMode !== DISPLAY_RULE.reportMode)
    return thankYou(inputs.language, 'policy_thank_you_only', modes);
  const pack = inputs.packReader.current();
  if (!pack) {
    const why = inputs.packReader.failure?.() ?? 'missing';
    return thankYou(
      inputs.language,
      why === 'expired' ? 'release_pack_expired' : 'release_pack_invalid',
      modes,
    );
  }
  if (!batteryGateOpen(pack, inputs.language, inputs.pathway, inputs.siteMode))
    return thankYou(inputs.language, 'battery_gate_closed', modes);
  if (DISPLAY_RULE.sessionValidForReport && !inputs.sessionValidForReport)
    return thankYou(inputs.language, 'session_not_valid_for_report', modes);
  if (HAS_DIGIT.test(pack.disclaimer_key))
    return thankYou(inputs.language, 'release_pack_invalid', modes);

  const candidates: { trait: DisplayTrait; sem: number }[] = [];
  for (const gate of pack.trait_gates) {
    if (gate.language !== inputs.language || gate.pathway !== inputs.pathway) continue;
    const rule = CONSTRUCT_REPORT[gate.trait];
    if (!rule) continue;
    if (PERMANENT_WITHHOLD.some((w) => w.construct === gate.trait && w.pathway === inputs.pathway))
      continue;
    const effective = capStatus(gate.status, rule.maxStatus);
    if (!DISPLAY_RULE.traitStatusIn.includes(effective)) continue;
    const band = inputs.bandFor(gate.trait, pack);
    if (band === 'unavailable') continue;
    // "Not enough to say" is never shown as a trait (display_rule.exclude_not_enough_to_say; the kiosk
    // has no card for it, so it is excluded even if the rule were relaxed: fail closed).
    if (band === 'not_enough_to_say') continue;
    const allowed = pack.phrase_allowlist.find(
      (p) => p.trait === gate.trait && p.band === band,
    )?.phrase_key;
    const dictionaryKey = rule.phraseKeys[band];
    if (!allowed || allowed !== dictionaryKey || HAS_DIGIT.test(allowed)) continue;
    const norm = pack.norm_tables.find(
      (n) =>
        n.trait === gate.trait && n.pathway === inputs.pathway && n.language === inputs.language,
    );
    candidates.push({
      trait: {
        trait: gate.trait,
        band: band as BandCode,
        phraseKey: allowed,
        style: effective === 'validated_banded' ? 'banded' : 'broad_style',
      },
      sem: norm?.sem ?? Number.POSITIVE_INFINITY,
    });
  }
  // The most reliable released traits first (smallest SEM), capped at max_traits_shown.
  candidates.sort((a, b) => a.sem - b.sem);
  const traits = candidates.slice(0, REPORT_LIMITS.maxTraitsShown).map((c) => c.trait);
  if (traits.length === 0 || traits.length < REPORT_LIMITS.minTraitsShown)
    return thankYou(inputs.language, 'no_trait_released', modes);
  const shown = new Set(traits.map((t) => t.trait));
  const normProvisional = pack.norm_tables.some(
    (n) =>
      shown.has(n.trait) &&
      n.pathway === inputs.pathway &&
      n.language === inputs.language &&
      n.provisional,
  );
  const model: PlayerReportModel = {
    mode: 'player_report',
    language: inputs.language,
    disclaimerKey: pack.disclaimer_key,
    deliveryModes: modes,
    releasePackVersion: pack.release_pack_version,
    traits,
    normProvisional,
  };
  return model;
}

/**
 * Demo report for think-aloud comprehension testing: fictional profile only, labelled "example".
 * The signature takes no session data, so session indicators cannot reach it (REP-02 AC).
 */
export function buildDemoReportModel(
  profile: DemoProfile,
  language: LanguageTag,
  deliveryModes: readonly DeliveryMode[] = ['spoken', 'screen', 'printed'],
): DemoReportModel {
  const traits = profile.traits
    .filter((t) => !HAS_DIGIT.test(t.phraseKey) && CONSTRUCT_REPORT[t.trait] !== undefined)
    .slice(0, REPORT_LIMITS.maxTraitsShown)
    .map(
      (t) =>
        ({
          ...t,
          style:
            CONSTRUCT_REPORT[t.trait]?.maxStatus === 'validated_banded' ? 'banded' : 'broad_style',
        }) as DisplayTrait,
    );
  return {
    mode: 'demo',
    demoProfileId: profile.demoProfileId,
    traits,
    language,
    disclaimerKey: DEFAULT_DISCLAIMER_KEY,
    deliveryModes,
  };
}

/** Spoken summary line ids for a model (pre-recorded segments concatenated, REP-02). */
export function spokenLines(model: ReportModel): string[] {
  if (model.mode === 'thank_you') return ['report.thank_you', 'report.what_this_is_about'];
  const lines = model.mode === 'demo' ? ['report.example_label', 'report.intro'] : ['report.intro'];
  for (const t of model.traits) lines.push(t.phraseKey);
  lines.push(model.disclaimerKey);
  return lines;
}

/** A fictional example profile (demo mode only). */
export const EXAMPLE_DEMO_PROFILE: DemoProfile = {
  demoProfileId: 'demo.example_a',
  traits: [
    { trait: 'persistence', band: 'pole_b', phraseKey: 'report.persistence.pole_b' },
    { trait: 'teamwork', band: 'centre', phraseKey: 'report.teamwork.centre' },
    { trait: 'adaptability', band: 'pole_a', phraseKey: 'report.adaptability.pole_a' },
    { trait: 'composure', band: 'pole_b', phraseKey: 'report.composure.pole_b' },
  ],
};
