# Access control policy

**Version:** 0.1 DRAFT, 2026-10-21. **Owner:** Security lead. **Approvers:** DPO and PI.
**Plan features:** PRV-04 (pseudonymisation and identity vault), PRV-07 (encryption and keys), PRV-08 (RBAC and audit).

## 1. Principles

1. **Least privilege.** Each person gets the smallest role that lets them do their job, scoped to the
   studies they work on.
2. **Separation of identity and research data.** Contact details live in a separate vault database with
   separate keys. Nobody who analyses data can read the vault.
3. **Field staff never see scores.** Field administrators run sessions and the criterion battery but cannot
   read indicators, scores or gate results (PRV-08 acceptance criterion).
4. **Two people for sensitive actions.** Manual participant linkage, re-identification, policy approval,
   gate sign-off and battery-gate sign-off each need two named people.
5. **Everything is logged.** Every read of restricted data and every export is in the append-only audit
   trail.

## 2. Roles

The plan defines the target roles (PRV-08). The current API implements a smaller set (`rbac.py`); the
mapping shows which implemented role each target role uses until the full set exists.

| Target role (plan) | Implemented role | What the role is for |
|---|---|---|
| Researcher | `researcher` | Study design, data processing, validation runs, reports, within assigned studies |
| ResearchLead | `researcher` + governance sign-off rights | As Researcher, plus gate and amendment sign-off (through PLT-09 records) |
| FieldAdministrator | `administrator` | Runs sessions and the criterion battery, enrols participants, records consent and contact details, takes withdrawal requests. **No scores.** |
| IdentitySteward | not yet implemented (use `admin` with two-person rule) | The only role that may re-link contact details to a `pid`, with a written justification |
| FleetOperator | `admin` (kiosk and deployment permissions only, by procedure) | Kiosk provisioning, health, remote commands, OTA |
| ContentEditor / ContentReviewer | `admin` (content permissions only, by procedure) | Game content, audio packs, ITC workflow |
| EthicsOfficer | governance sign-off (PLT-09) | Gate and policy co-sign-off, complaint handling, IEC liaison |
| DPO | `admin` (audit, retention, erasure) | Data protection oversight, erasure execution, retention runs, breach decisions |
| Analyst-deidentified | `analyst` | De-identified research views and validation runs only; no linkage, consent, raw events or identity |
| Kiosk device | `kiosk_device` | Machine identity (mutual-TLS certificate): ingest events, heartbeats, read gate status and release packs |

> Until IdentitySteward, FleetOperator and the content roles exist as separate roles, `admin` accounts are
> limited to the named DPO and Security lead, and every use of `admin` for those duties follows the written
> procedure and is reviewed monthly from the audit trail.

## 3. Access matrix by data class

R = read, W = write, X = execute (run jobs that use the data), - = no access. "Scoped" means only within
assigned studies.

| Data class | Researcher | Field administrator | Analyst | DPO | Kiosk device |
|---|---|---|---|---|---|
| Raw events (`kiosk_raw`) | R scoped | - | - | R (erasure only) | W (ingest only) |
| Indicators and scores (`scored`, criterion scale scores) | R scoped | - | R (de-identified views) | - | - |
| Criterion answers | R/W scoped | W (entry only) | R (de-identified views) | R (erasure only) | - |
| Linkage (`pid` to sessions) | R/W scoped (two people for manual links) | W (scan only) | - | R (erasure only) | W (scan only) |
| Consent artefacts | R/W scoped | W | - | R | W |
| Identity vault (contact details) | - | W (entry only, no read-back) | - | Re-link only as IdentitySteward, two people, justified | - |
| Validation results, gates | R/W scoped | - | R | - | R (gate status only) |
| Analysis snapshots | R/W scoped | - | R | R (erasure rebuild) | - |
| Research exports | X with justification over 50 rows | - | X de-identified, with justification over 50 rows | Approve data-use agreements | - |
| Audit trail | - | - | - | R | - |

Enforcement is in two places: permission checks in the API, and PostgreSQL row-level security on the
restricted schemas. A permission-matrix test runs in CI (PRV-08 acceptance criterion).

## 4. Authentication

- Staff: OIDC single sign-on with MFA required for every role. Development uses a local signed-JWT login that
  is disabled in production builds.
- Kiosks: mutual TLS with short-lived device certificates from the internal CA; keys sealed in the TPM.
  A revoked certificate fails within 5 minutes.
- Sessions time out after 30 minutes of inactivity for staff accounts with restricted access.
  **[STAKEHOLDER REVIEW: confirm time-out]**

## 5. Account lifecycle

| Event | Action | Deadline |
|---|---|---|
| Joiner | Role request approved by the PI (and the DPO for any `admin` or vault access); data-protection and ethics training completed first | Before access |
| Mover | Roles and study scopes re-approved; old scopes removed | Within 2 working days |
| Leaver | All accounts disabled; tokens revoked; shared secrets rotated if the person held any | Same day |
| Quarterly review | PI and DPO review every account, role and scope against current duties; unused accounts disabled | Every 3 months |

## 6. Exports and disclosure control

- Any export of more than 50 rows needs a written justification, recorded in the audit trail.
- Research exports to third parties contain only participants with archive consent, are de-identified, meet
  k-anonymity >= 5, come with a codebook, and need a data-use agreement recorded in the export recipient
  register (VAL-17).
- Reports suppress subgroup cells with fewer than 30 participants (`gates.yaml quality.fairness_cell_min_n`).

## 7. Keys and encryption

TLS 1.3 in transit. At rest: database encryption, column envelope encryption for the vault, object storage
with KMS-managed keys, per-session data keys (DEKs) wrapped by a backend key held in the KMS, separate backup
keys. Key rotation at least yearly and after any suspected compromise; the HMAC pepper rotation keeps
existing links (PRV-04 acceptance criterion).

## 8. Break-glass access

Emergency access to restricted data (for example during an incident) uses a sealed break-glass account,
needs two people to open, is limited to 24 hours, raises an alert, and is reviewed by the DPO afterwards.

## 9. Audit

The append-only audit table records logins, reads of restricted data, writes, exports, erasures, policy
changes and gate sign-offs. It is exported daily to versioned storage and kept for one year online.
Alarms fire on anomalous exports, authentication bursts and any vault read (see the
[incident response runbook](incident-response-runbook.md)).
