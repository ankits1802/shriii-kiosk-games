# Data management plan (DMP)

**Version:** 0.1 DRAFT, 2026-10-21. **Owner:** Research Lead. **Approvers:** PI and DPO.
**Plan features:** PRV-11, ING-06 (snapshots), SCR-13 (reproducible scoring), VAL-17 (de-identified export), plan 7.10 (reproducibility).

## 1. Data description

| Dataset | Content | Format | Expected volume (Stage 2) |
|---|---|---|---|
| Raw events | Append-only game events with versions and timing (plan 6.1) | NDJSON in encrypted batches; PostgreSQL `kiosk_raw` (partitioned by server receive date) | About 1,350 sessions x a few thousand events |
| Session context | Picture-band answers, device, mode, arm | PostgreSQL | One row per session |
| Indicators | Layer-2 behavioural indicators per session (versioned scoring dictionary) | PostgreSQL `scored`; Parquet in snapshots | About 100 indicators per pathway |
| Criterion data | Item answers, scale scores (versioned keys) | PostgreSQL `criterion` | One battery per participant per wave |
| Linkage | `pid` to sessions and criterion waves | PostgreSQL `linkage` (restricted) | One row per link |
| Consent | Immutable consent artefacts | PostgreSQL `consent` | Several per participant |
| Analysis snapshots | De-identified participant x occasion tables | Parquet with a manifest (sha256 per partition) | Per study and wave |
| Validation results | Estimates with CI, n, method, provenance | PostgreSQL `validation`; report bundles (JSON) | Per analysis run |
| Reports | Stage reports, technical manual | Markdown, HTML, Quarto (`stats/reports/`) | Per stage |
| Research audio, ASR clips | Think-aloud and closed-vocabulary recordings | Encrypted files with deletion timers | Small; short-lived |

## 2. Documentation and metadata

- **Scoring dictionary** (`stats/measurement-model/dictionary/*.yaml`): every indicator's definition, formula reference,
  exclusions, transformation, reliability method and minimum trials; frozen per pathway with a sha256.
- **Event contract** (`contracts/schemas/*.json`, JSON Schema 2020-12) with generated types.
- **Pre-registration** generated from `stats/measurement-model/hypotheses.yaml` and `stats/measurement-model/gates.yaml` by `stats/prereg`,
  with the sha256 of every input embedded.
- **Codebook** for every export (variables, codes, missing-data codes, transformations).
- **Instrument registry** with licences; licensed item wording is not stored in the repository.

## 3. Versioning, provenance and reproducibility

- Waves are frozen on app x content x dictionary x protocol x release pack.
- Every scoring run writes a manifest (dictionary sha per pathway, git sha, image digest, lock hashes,
  partition hashes, seeds, BLAS and thread settings, erasure receipts).
- Every coefficient traces to `analysis_run_id` -> snapshot manifest -> partitions; report footers carry these
  hashes (`stats/reports/`).
- Numeric reproducibility is checked with tolerances (1e-8), not byte equality. Reruns after erasures are
  "reproducible modulo erasures", with erasures counted in each manifest.

## 4. Storage, backup and security

- India-region hosting; encryption in transit (TLS 1.3) and at rest (database, object storage with KMS keys,
  per-session data keys, separate backup keys).
- Database backups and session-key backups kept for 14 days or less.
- Access by role and study scope with MFA ([access control policy](access-control-policy.md)).
- Kiosk data is encrypted per session until upload; offline capacity 30 days.

## 5. Quality assurance

- Contract validation at the kiosk (strict) and at ingest (tolerant reader), dead-letter queue with triage.
- Session reconstruction and integrity checks (gapless sequence numbers, version tuples).
- Data-quality flag engine (session grades) and differential-exclusion monitoring.
- Synthetic players with known parameters for parameter recovery; golden-session fixtures; scoring parity
  tests.
- Criterion data: double entry checks for performance tasks, attention-check items, 15% double-coding of
  observed cooperation.

## 6. Retention and deletion

See the [retention and deletion policy](retention-and-deletion-policy.md). Erasure covers raw, derived,
snapshot, export and backup layers.

## 7. Sharing and reuse

- Within the team: de-identified research views for analysts; restricted schemas for named researchers.
- External: de-identified exports (CSV, Parquet, .sav) with a codebook, only for participants with archive
  consent, k-anonymity >= 5, under a data-use agreement recorded in the export recipient register.
- Re-importing an export must reproduce the snapshot statistics within 1e-8 (VAL-17 acceptance criterion).
- Aggregate results are published with the pre-registration; confirmatory and exploratory results are
  separated.

## 8. Long-term preservation

The de-identified archive (archive consent only) is deposited in [TBD: institutional repository], with the
scoring dictionary, codebooks, pre-registration and the analysis code at the tagged commit. Proposed
retention 10 years. **[STAKEHOLDER REVIEW]**

## 9. Responsibilities

| Task | Role |
|---|---|
| DMP ownership, snapshots, codebooks | Research Lead |
| Retention runs, erasure, DPIA | DPO |
| Security, keys, backups | Security lead |
| Consent records, IEC liaison | Ethics Officer |
| Approval of external data sharing | PI and DPO |

## 10. Review

Reviewed before each stage and whenever a new data class, store or sharing arrangement is added.
