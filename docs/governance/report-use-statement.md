# Report-use statement

**Version:** 0.1 DRAFT, 2026-10-21. **Owner:** PI. **Approvers:** PI, Ethics Officer, legal counsel.
**Config key:** `report_use_statement_key = report_use.personal_reflection_v1` (DeploymentPolicy, plan 1.4).
**Related:** REP-01 to REP-03, `stats/measurement-model/gates.yaml` (`display_rule`, `report`), plan 1.3.

> **[STAKEHOLDER REVIEW] [LEGAL REVIEW]** The default use is "personal reflection only". Any other use
> needs a stakeholder decision, a DPIA update, new consent wording, IEC approval and new validation evidence
> for that use.

## 1. The statement (source text for the consent audio and the participant report)

**What the report is.** A short, picture-based summary of how you played today. It describes a few broad
strengths and styles in everyday words. It is a snapshot of one session, not a test result and not a
diagnosis.

**What it is for.** For you to reflect on, if you wish. That is its only purpose.

**What it is not for.** It must not be used to decide on a job, a loan, school or college admission, a
medical or psychological diagnosis, or anything else important about you. Nobody should ask you to show it.
You do not have to show it to anyone.

**What it does not contain.** No scores, no numbers, no ranking, no negative labels, and nothing about
honesty or morality.

## 2. Rules that make the statement true

| Rule | Enforcement |
|---|---|
| No participant report until the battery has passed reliability and fairness checks in at least two language groups and been signed off | Battery release gate (`gates.yaml battery_gate`), fail closed; otherwise thank-you only |
| A trait is shown only when its gate is validated, the session is valid, the estimate is not "not enough to say", and the release pack is valid and unexpired | `gates.yaml display_rule` |
| 3 strengths-framed bands; at most 5 traits | `gates.yaml report` |
| No numbers, no negative labels | Phrase allowlist in the signed release pack; the `ReportArtefact` schema has no numeric fields |
| Integrity and honesty never shown for an individual | Dice is group level only; integrity capped or withheld |
| Spoken summary, printed picture page and QR retrieval; the QR token expires | REP-02; retention: token expiry plus 30 days |
| Third-party requests for a participant's report (employer, family, institution) are refused | Staff procedure; retrieval only with the participant's own token |

## 3. Institutional use

If an organisation wants to use the games or the participant reports for any decision about people (for
example recruitment, training placement, admission), the answer under this statement is **no**. A future
use would require:

1. a stakeholder decision naming the use and the population;
2. criterion-validity evidence for that specific use (Stage 5) and fairness evidence for the groups affected;
3. a DPIA update and legal review;
4. new consent wording and re-consent of anyone whose data would be used;
5. IEC approval.

## 4. Where the statement appears

- Consent audio, core segment 4 ([core consent script](consent/core.md)).
- The end of the spoken summary and the footer of the printed picture page (pictograms plus a short line
  read aloud).
- The study information sheet given at supervised sites.
- The Stage 5 report and the technical manual (the `stats/reports/` templates mark this as a review item).
