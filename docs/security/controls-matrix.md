# Security and privacy controls matrix

Each control is mapped to the plan features it implements (mainly PRV-*, plus the KSK, ING and REP
features that carry security acceptance criteria), the threats it addresses
([threat-model.md](threat-model.md)), its wave-1 status and how it is verified.

**Status** (as of commit `1b01cae`, 2026-10-21): **Implemented** = code exists and a test or measurement
verifies it; **Partial** = some of the control exists, the gap is named; **Planned** = not built yet, owned by
the named feature; **Process** = an organisational control, not code; **Gap** = needed but not in any plan
feature yet (proposed owner given).

## Matrix

| ID | Control | Plan features | Threats | Wave-1 status and evidence | Verification |
|---|---|---|---|---|---|
| C-01 | Signed, versioned `DeploymentPolicy`; kiosk refuses invalid or expired policy; rejected combinations (minors, live D at open_public, player_report without release pack); no camera/voice-tone flags exist | PRV-01, PRV-12 | T-02, K-14, A-10 | Planned. Content manifests exist in `contracts`; policy signing and kiosk verification are not built | Unit tests for the validator; kiosk start-up test with tampered and expired policy |
| C-02 | Consent-first ingestion: tap-confirmed consent artefact, consent parking for scorable events, 72 h expiry to DLQ, decline discards the session and keeps an anonymous counter | PRV-02, ING-02, ONB-02, ONB-04 | K-09, consent bypass | **Implemented** server-side: `services/ingestion.py` (`_process_chunk`, `_unpark`, `request_session_discard`), `services/consent.py`. Load harness `out_of_order` scenario: parked events released, `still_parked = 0` | `tools/loadtest/tests/test_against_api.py::test_out_of_order_with_skewed_clocks_unparks`; API tests `test_privacy_lifecycle.py` |
| C-03 | Audio non-retention: mic closed outside consented prompt windows; no audio in storage, logs, telemetry; forbidden field names scrubbed from tolerated unknown fields | PRV-03, KSK-03, VOX-04 | K-07, A-13 | Partial. Electron permission handler denies all media (`frontend/apps/kiosk/electron/main.ts`); `payload_ext` drops `text, free_text, transcript, audio, asr_alternatives` but only by leaf name (SF-05) | KSK-03 AC integration test (no audio track pre-consent); recursive scrub unit test |
| C-04 | Pseudonymous pid (random, Crockford + Luhn); identity vault in a separate DB with separate keys; HMAC is the only link; relink needs IdentitySteward + justification | PRV-04, CRT-06 | D-02, I-02 | Partial. Separate engine and Alembic env (`migrations_identity`), relink audit table, `keyed_hmac` with pepper version. `IDENTITY_DATABASE_URL` falls back to the research DB when unset (SF-04) | Config check in readiness probe; PRV-04 AC "analysis role cannot read the vault" as a DB-role test |
| C-05 | Retention schedule from YAML, nightly report, legal holds | PRV-05 | D-04 | **Implemented**: `config/retention.yaml`, `services/retention.py`, `POST /admin/retention/run`, legal holds | API tests (backdated records purged; hold blocks purge) |
| C-06 | Erasure: delete by session or pid across events, chunks, indicators, criterion, links, DLQ, parking; delete wrapped DEK (crypto-shred); tombstones refuse re-uploads; snapshot tombstone + rebuild; signed receipt | PRV-06a, PRV-06, ING-08 | D-04 | **Implemented** in DB scope (`services/erasure.py`, `consent.session_keys`, tombstones, Ed25519 receipts). S3 versions, export-register removal and backup drill are Planned | `test_erasure.py`; PRV-06 drill (restore backup, re-apply tombstones, zero readable rows) |
| C-07 | TLS 1.3 only; kiosk mTLS with step-ca short-lived certificates; revoked certificate fails within 5 min; certificate pinning on kiosk | PRV-07, KSK-10 | T-01, T-02, A-01, K-13 | Planned (deployment). Wave 1 has device bearer tokens only | sslyze scan in CI against staging; revocation test |
| C-08 | Per-session DEK: AES-256-GCM over NDJSON, DEK sealed to backend X25519 key; backend re-wraps DEK under KMS KEK (AAD = session id); keys in KMS, separated by purpose, rotatable | PRV-07, KSK-07, ING-08 | T-01, K-04, D-09 | Partial. Server unseal/re-wrap implemented (`security.py`, `_decrypt_events`), `kek_version` column. Keys come from env vars, the same KEK wraps DEKs and DLQ payloads (SF-07); kiosk sealing is Planned (browser build sends `none_dev`) | `test_batches_scenarios.py::test_sealed_batch_round_trips_with_server_crypto`; ING-08 AC (decrypt fails after DEK deletion) |
| C-09 | Column envelope encryption for vault contact fields | PRV-04, PRV-07 | D-02 | **Implemented**: `encrypt_field`/`decrypt_field` (AES-GCM, AAD) | API tests for contacts |
| C-10 | RBAC permission matrix per endpoint; study scoping; FieldAdministrator cannot read scores; devices cannot use user JWT roles | PRV-08 | A-03, W-06 | **Implemented** in API: `auth/rbac.py`, `require()`, `ensure_study_access`; `test_rbac.py` permission matrix | CI permission-matrix test (PRV-08 AC) |
| C-11 | Audit: one append-only row per write and per research read, in its own transaction (denials recorded) | PRV-08, ING-07 | A-09, I-06 | **Implemented**: `audit.py` middleware, `governance.audit_events`. Records full URL path, which leaks report tokens (SF-03) | API tests; review of audit rows in pentest |
| C-12 | Append-only DB triggers on raw events, criterion responses, consent artefacts and audit; DELETE only with `shriii.mutation_purpose` = erasure/retention | PRV-08, ING-01 | D-03, I-06 | **Implemented**: migration `0002_guards_roles_partitions.py` | Trigger tests; pentest attempts UPDATE/DELETE as app role |
| C-13 | Separate DB roles (`shriii_app`, `shriii_erasure`, `shriii_analyst`); Postgres RLS for study scoping | PRV-08 | A-03, D-08 | Partial. Roles and grants created when the migrating user can create roles; the app connects as one user; no RLS | DB-role tests; RLS policy tests (planned) |
| C-14 | MFA for all users (phishing-resistant for admin, IdentitySteward, DPO); API checks `amr`/`acr` | PRV-08 | W-01 | Planned (IdP configuration); API does not check MFA claims (SF-08) | IdP policy export reviewed; API test rejecting tokens without MFA claim |
| C-15 | Export controls: justification for > 50 rows; de-identified snapshots; download audit | PRV-08, VAL-17, ING-06 | W-04, D-05 | Partial. Snapshot download is audited; the justification rule is not implemented (SF-12) | API test for justification; export audit review |
| C-16 | Idempotent ingestion: `batch_id` replay returns stored result; `event_id` dedup; `(session_id, seq)` uniqueness; seq-conflict DLQ; per-session advisory lock | ING-02, PRV-09 | T-04 | **Implemented** and load-verified: 0 duplicate rows across retry, re-pack, 10× concurrent storm and clock-skew scenarios (`tools/loadtest/RESULTS.md`) | `tools/loadtest` suite + `test_against_api.py`; ING-02 AC |
| C-17 | Batch integrity: JCS sha256 of `session_chunks`; `batch_id` reuse with different content returns 409 | ING-02 | T-03 | **Implemented** (`canonical.py`, `ingest_batch`) | Harness JCS parity tests; API tests |
| C-18 | Batch authenticity: device signature over the batch (Ed25519 key in TPM), checked server-side | PRV-09 | T-03, A-01 | Planned | Signature verification unit tests; invalid signature rejected with a reason (PRV-09 AC) |
| C-19 | Device credential lifecycle: per-kiosk token stored as digest, bound to `kiosk_id`, rotate and revoke endpoints | KSK-10 | A-01, K-13 | **Implemented** (`api/v1/admin.py`, `deps._resolve_device`, `ingest_batch` kiosk check) | API tests; revoked token rejected |
| C-20 | Abuse resistance: request-size limit at the proxy, per-kiosk and per-IP rate limits, ingest concurrency limiter with 503 + `Retry-After`, statement timeouts, pagination on research reads | PRV-09, QA-05 | A-05, A-06, A-12, D-07 | **Gap** (SF-01, SF-02, SF-11). Proposed patches in `tools/loadtest/proposals/` | Load suite (`tools/loadtest`), ING-02 AC |
| C-21 | Dependency, SAST, secret and container scanning in CI; SBOM; licence check | PRV-09, PLT-04 | I-07, supply chain | Partial. Manual scan this iteration ([scan-findings.md](scan-findings.md)): pip-audit, pnpm audit, semgrep clean of real issues. CI wiring Planned | CI job results; [supply-chain-policy.md](supply-chain-policy.md) |
| C-22 | Kiosk OS lockdown: Ubuntu Core model assertion, secure boot, TPM-backed FDE, no desktop, USB storage disabled, HID allow-list, firmware password, port blockers, tamper switch | KSK-09 | K-02, K-03, K-04 | Planned. Hardening guide: [kiosk-hardening-ubuntu-core.md](kiosk-hardening-ubuntu-core.md) | KSK-09 escape checklist; pentest §1 |
| C-23 | Signed OTA with rings, rollback, downgrade protection, wave freeze; signed content, dictionary, policy and release-pack manifests | KSK-11, PLT-03 | T-02, K-12, A-10 | Planned | KSK-11 ACs (unsigned/downgraded packs rejected) |
| C-24 | Onlooker privacy: privacy film, never-voice rule, headset-only private steps, show privately, auto-clear, onlooker icon, picture-digit pad | KSK-05, KSK-12, ONB-03 | K-05, K-06 | Partial. `voice_forbidden` exists in the content-manifest schema; kiosk enforcement to be verified | KSK-05/KSK-12 ACs; QA-04 E2E |
| C-25 | Admin unlock: NFC card or corner long-press + rotating picture PIN; 5 failures lock for 15 min; all attempts logged; admin bezel | KSK-13 | K-01 | Gap in wave 1: dev PIN is a static build-time value with default `2468` (SF-06). DevPanel is excluded from production builds | KSK-13 ACs; pentest §1 |
| C-26 | Release-pack gating: reports fail closed without a valid, signed (Ed25519), unexpired pack; revocation | REP-03, PRV-01 | A-10, AS-5 | **Implemented** server-side (`services/gates.py`, `services/reports.py`, `/admin/gates/release-pack/*`) | API tests (`test_reports.py`) |
| C-27 | Report tokens: 128-bit random, stored as SHA-256 digest, expiring, withdrawable; erase-by-token | REP-02, PRV-06a | A-07, A-12 | Partial. Tokens leak into audit `path` and access logs (SF-03) | Pentest log review; unit test for redaction |
| C-28 | Synthetic data separation: `synthetic=true`, refused outside dev/test, snapshot flag | QA-02 | D-06 | **Implemented** (`_prepare` refuses synthetic outside dev; snapshot spec) | API tests |
| C-29 | Plaintext (`none_dev`) chunks refused outside dev/test | ING-02, PRV-07 | T-01 | **Implemented** (`settings.accept_plaintext_chunks`, `ingest_batch`) | Settings unit test; staging smoke test |
| C-30 | Tamper-evident audit chain with daily anchors; SIEM correlation | PRV-13 | I-06, D-03 | Planned (P2, deferred) | Verifier detects a modified entry (PRV-13 AC) |
| C-31 | Incident response: alarms (exports, auth bursts, tamper, cert misuse, vault reads), DPDP runbook, notification templates, stolen-kiosk drill | PRV-10 | all | Planned | Tabletop scopes pids within 4 h; stolen-kiosk drill |
| C-32 | DPIA, age assurance limits, minors preconditions | PRV-12, PRV-11 | K-14 | Process | DPIA hash in IRB pack |
| C-33 | Electron hardening: sandbox, contextIsolation, no nodeIntegration, strict CSP, deny permissions, block navigation/new windows/webviews, devtools off when packaged; add Electron fuses and ASAR integrity | KSK-01 | K-03, K-12 | Partial. All listed except fuses/ASAR integrity (SF-09) | KSK-01 ACs; `@electron/fuses` check in CI |
| C-34 | Encrypted backups with separate keys, ≤ 14-day retention for DB and `session_keys` backups | PRV-05, PRV-07, ING-08 | D-01, D-04 | Planned (infra, PLT-05) | Backup policy review; PRV-06 restore drill |
| C-35 | Secrets hygiene: settings validator requires explicit keys outside dev/test, refuses `AUTH_MODE=dev` and the default dev secret; no secrets in repo | PRV-07 | A-11, D-09 | **Implemented** (`settings.py` `_fill_dev_defaults`); semgrep `p/secrets` clean | Settings tests; secret scanning in CI |
| C-36 | Change control: branch protection, two-person review, CODEOWNERS for security-sensitive paths, PLT-09 sign-off records for gates, dictionary and policy | PLT-09, PLT-04 | I-03, I-07 | Process | Repository settings audit |

## Coverage by plan feature

| Feature | Controls | Overall wave-1 state |
|---|---|---|
| PRV-01 Deployment policy | C-01, C-26 | Planned |
| PRV-02 Consent ledger | C-02 | Implemented (server) |
| PRV-03 Audio non-retention | C-03 | Partial |
| PRV-04 Pseudonymisation and vault | C-04, C-09 | Partial (SF-04) |
| PRV-05 Retention | C-05, C-34 | Implemented (app), Planned (backups) |
| PRV-06a / PRV-06 Erasure | C-06 | Implemented (DB), drills Planned |
| PRV-07 Encryption and keys | C-07, C-08, C-29, C-35 | Partial (KMS, mTLS Planned) |
| PRV-08 RBAC and audit | C-10, C-11, C-12, C-13, C-14, C-15 | Partial (RLS, MFA claims, export justification) |
| PRV-09 Hardening and threat model | C-16, C-17, C-18, C-20, C-21, this document set | Partial (C-20 gap, C-18 planned) |
| PRV-10 Incident response | C-31 | Planned |
| PRV-11 IRB evidence pack | C-32, C-36 | Process |
| PRV-12 DPIA and age | C-01, C-32 | Process |
| PRV-13 Audit chain and SIEM | C-30 | Deferred |
| KSK-01, KSK-09 to KSK-13 | C-22 to C-25, C-33 | Partial (Electron) / Planned (OS, OTA) |
| ING-02, ING-08 | C-08, C-16, C-17 | Implemented except latency AC (see `tools/loadtest/RESULTS.md`) |
| REP-02, REP-03 | C-26, C-27 | Implemented with SF-03 |
