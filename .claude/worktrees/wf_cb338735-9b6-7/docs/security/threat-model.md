# STRIDE threat model

Feature: PRV-09 (security hardening and threat model). Status: **draft v1, 2026-10-21**, written against
the wave-1 code (commit `1b01cae`) and the target architecture in `docs/IMPLEMENTATION_PLAN.md`. Review
again before Stage 2 (PRV-09 AC: ASVS L2 checklist passes before Stage 2) and after any change to the
ingestion contract, key handling or kiosk image.

Read with: [data-flows.md](data-flows.md) (diagrams and trust boundaries),
[controls-matrix.md](controls-matrix.md) (control IDs `C-nn` used below),
[scan-findings.md](scan-findings.md) (findings `SF-nn` from the automated scan and code review),
[pentest-checklist.md](pentest-checklist.md) and [kiosk-hardening-ubuntu-core.md](kiosk-hardening-ubuntu-core.md).

## 1. Scope, assets and assumptions

**In scope:** the kiosk (hardware, OS, Electron app, outbox), the kiosk-to-backend transport, the FastAPI
service and worker, the PostgreSQL data platform and object storage, the identity vault, the research web
app (`apps/web`, `/research/*` and `/admin/*`), operators and insiders, and the build and update supply
chain (detail in [supply-chain-policy.md](supply-chain-policy.md)).

**Out of scope:** cloud-provider internals, the OIDC provider's own security, and physical security of
the hosting region.

### Assets

| ID | Asset | Why it matters | Where it lives |
|---|---|---|---|
| AS-1 | Raw behavioural events (layer 1) | Personal data under DPDP (behavioural profile, coarse demographics, language). Re-identifiable when combined with time and site. | Kiosk outbox, `kiosk_raw.*`, raw chunks (DB, later S3) |
| AS-2 | Consent artefacts and withdrawals | Legal basis for all processing. Must be immutable and provable. | `consent.*`, kiosk outbox |
| AS-3 | Contact details (phone for retest/IVR) | Directly identifying. | `identity_vault` (separate DB) |
| AS-4 | pid linkage and criterion responses | Links games to psychometric answers (BFI-2, DERS-16: sensitive). | `linkage.*`, `criterion.*` |
| AS-5 | Derived scores, trait estimates, reports | Could be misused for decisions about people; must stay release-gated. | `scored.*`, `reporting.*`, report tokens |
| AS-6 | Keys: backend X25519 private key, session-key KEK, vault key, pid pepper, Ed25519 release key, kiosk mTLS keys, device tokens | Compromise defeats encryption, crypto-shredding or authenticity. | Env/KMS (backend), TPM (kiosk) |
| AS-7 | Scientific integrity: dictionary, gates, release packs, synthetic/real separation | Tampering yields invalid science or premature reports. | `scoring/*.yaml`, `validation.*`, signed packs |
| AS-8 | Kiosk availability and the participant experience | Field sessions are costly; a broken or hijacked kiosk harms people and the study. | Field sites |
| AS-9 | Audit trail | Needed to prove access, investigate incidents and meet DPDP duties. | `governance.audit_events` |

### Actors

| Actor | Capability assumed |
|---|---|
| Player | Physical touch access during a session; may be curious, may try to game the task, rarely technical. Adults 18+. |
| Onlooker | Can see and hear the kiosk; may film the screen. |
| Opportunistic vandal or thief | Minutes of unsupervised physical access at an open site; can pull cables, plug USB devices, steal the kiosk. |
| Skilled local attacker | Hours with a stolen kiosk; can image disks, probe ports, try boot media. |
| Network attacker | On the kiosk's network (venue Wi-Fi, LTE MITM) or on the internet. |
| Malicious or compromised kiosk | Holds a valid device credential; can send arbitrary well-formed batches. |
| External web attacker | Reaches public endpoints (report token pages, auth, API). |
| Insider: field administrator, researcher, analyst, fleet operator, developer | Legitimate access to some data or systems; may be careless, coerced or malicious. |
| Supply-chain attacker | Publishes a malicious package version or compromises a build step. |

### Assumptions

1. Stages 1 to 3 run at **supervised** sites; `open_public` kiosks run thank-you mode only (plan §1.4).
2. Hosting is AWS ap-south-1 with KMS; wave 1 runs under Docker Compose with environment-variable keys.
3. Users authenticate through OIDC with MFA enforced at the IdP (PRV-08). Devices use device tokens now and
   mTLS later (PRV-07, KSK-10).
4. No camera, facial or voice-tone processing exists (BUILD_DECISIONS non-negotiable 5). No audio is retained
   outside supervised research consent (PRV-03).

## 2. Risk rating

Likelihood (L) and impact (I) are rated 1 (low) to 3 (high); risk = L × I: **1-2 low, 3-4 medium, 6-9 high**.
Status: **Mitigated** (control implemented and verified), **Partial** (some controls in place, residual risk
noted), **Open** (planned control not yet built), **Accepted** (owner decision required, see §9).

## 3. Kiosk: physical access, tampering, onlookers, USB (TB-1, TB-2)

| ID | STRIDE | Threat scenario | L | I | Risk | Controls | Status |
|---|---|---|---|---|---|---|---|
| K-01 | S | A player or passer-by impersonates the field administrator by finding the admin unlock (corner long-press) and guessing the PIN. The wave-1 dev PIN defaults to `2468` and is compiled into the bundle (SF-06). | 2 | 3 | 6 | C-25 rotating picture PIN, NFC card, 5-try lockout, admin bezel; C-22 no OS access | Open (KSK-13) |
| K-02 | T | Someone with physical access boots from USB or swaps the disk to plant software or read data. | 2 | 3 | 6 | C-22 secure boot, TPM-sealed FDE, firmware password, port blockers, tamper switch | Open (KSK-09) |
| K-03 | T | A USB HID device (rubber-ducky keyboard) injects keystrokes to escape kiosk mode or open devtools. | 2 | 3 | 6 | C-22 USB storage disabled, USB HID allow-list (touch controller only), ports inside enclosure; C-33 devtools off in packaged builds, no navigation, no new windows | Partial: Electron side done, OS side open |
| K-04 | I | A thief steals a kiosk and reads unsynced sessions, device token or mTLS key from disk. | 2 | 3 | 6 | C-22 TPM-backed FDE; C-08 events encrypted with per-session DEK sealed to backend key (kiosk cannot decrypt after sealing); C-19 remote revoke; PRV-10 stolen-kiosk drill | Open (wave-1 browser outbox is plaintext IndexedDB) |
| K-05 | I | An onlooker reads private answers (dice, bribe, report) or hears the phone number read back. | 3 | 2 | 6 | C-24 privacy film, never-voice rule (`voice_forbidden`), headset-only private steps, "show privately", 60 s auto-clear, "someone watching?" icon; picture-digit pad | Partial (manifest flag exists; kiosk enforcement to verify in QA-04) |
| K-06 | I | The next player sees the previous player's report or answers (walk-away). | 3 | 2 | 6 | KSK-04 wipe within 1 s of countdown; report auto-clear; memory wipe on attract | Partial (KSK-04 AC test pending) |
| K-07 | I | The microphone records bystanders before consent (always-listening risk). | 2 | 3 | 6 | C-03 mic closed outside consented prompt windows, permission handler denies media by default, no wake word, no audio retention, forbidden-field scrub | Partial (Electron deny-all done; SF-05 scrub is shallow) |
| K-08 | T | A player games the tasks (coaching, repeated play, "fake sessions") to obtain a better report. | 3 | 1 | 3 | No visible scores; reports gated and banded; quality flags (SCR-12); repeat-play detection via pid only in supervised mode | Accepted (scientific, not a security control) |
| K-09 | R | A player denies having consented, or claims data was kept after declining. | 1 | 3 | 3 | C-02 tap-confirmed consent artefact with script hash; decline discards session and keeps only an anonymous counter; signed erasure receipts | Mitigated (server); kiosk part Partial |
| K-10 | D | Vandalism, cable pulls, power cuts or a jammed touchscreen take the kiosk down mid-session. | 3 | 1 | 3 | KSK-07 power-cut-safe outbox (seq in-txn); KSK-08 self-test and out-of-service screen; heartbeat alerts | Partial |
| K-11 | T | A malicious QR code shown to the kiosk camera or NFC reader (admin pid QR) injects data or URLs. | 1 | 2 | 2 | No camera; pid QR only in admin mode; strict pid pattern + Luhn check; CSP blocks navigation | Mitigated (design), verify in pentest |
| K-12 | E | A renderer exploit (malicious content pack, PixiJS bug) gains Node access. | 1 | 3 | 3 | C-33 sandbox, contextIsolation, no nodeIntegration, preload allow-list, signed content packs (C-23), CSP `script-src 'self'`; Electron fuses (SF-09) | Partial |
| K-13 | S | A cloned kiosk (copied disk image) uploads under a real kiosk's identity. | 1 | 3 | 3 | C-07 mTLS key non-exportable in TPM; C-19 device token per kiosk, rotation and revoke; heartbeat clock and hardware fingerprint anomaly alerts | Open |
| K-14 | T | A minor plays despite the 18+ rule. | 2 | 3 | 6 | Self-declared age band ends the session and discards data (ONB-04); DPIA records the limitation (PRV-12); supervised sites | Accepted with DPIA (PRV-12) |

## 4. Transport (TB-3)

| ID | STRIDE | Threat scenario | L | I | Risk | Controls | Status |
|---|---|---|---|---|---|---|---|
| T-01 | I | A network attacker on venue Wi-Fi or LTE reads uploads. | 2 | 3 | 6 | C-07 TLS 1.3 only (sslyze AC); C-08 chunk payloads sealed end to end, so even a TLS-terminating proxy only sees ciphertext and metadata | Partial (wave-1 dev uses `none_dev` plaintext; prod refuses plaintext, C-29) |
| T-02 | S | A fake backend (DNS hijack, captive portal) collects kiosk uploads or pushes fake policy/content. | 2 | 3 | 6 | Certificate pinning to the step-ca/backend CA; C-01 and C-23 signed policy, content and release packs verified on the kiosk; uploads are sealed to the backend public key | Open |
| T-03 | T | An attacker modifies a batch in flight. | 1 | 3 | 3 | TLS; JCS sha256 detects accidental corruption but is **not** authentication; AES-GCM tag per chunk; C-18 batch signatures (PRV-09) | Partial |
| T-04 | R/T | A captured batch is replayed later to inject duplicates. | 2 | 2 | 4 | C-16 batch_id idempotency, event_id dedup, (session_id, seq) uniqueness, seq-conflict DLQ; verified by the load harness: 0 duplicate rows under replay storms (tools/loadtest RESULTS.md) | Mitigated |
| T-05 | I | Metadata leakage: batch size and timing reveal session activity per site. | 2 | 1 | 2 | Uploads paused during play and batched after the session; accept | Accepted |
| T-06 | D | Kiosk uplink blocked for days. | 3 | 1 | 3 | Offline-first outbox with 7-day soak (QA-04); quota stop rather than silent loss | Partial |

## 5. Backend API (TB-3, TB-4)

| ID | STRIDE | Threat scenario | L | I | Risk | Controls | Status |
|---|---|---|---|---|---|---|---|
| A-01 | S | A stolen device token is used from elsewhere to upload fabricated sessions. | 2 | 2 | 4 | C-19 digest-stored tokens, kiosk_id binding, revoke/rotate; C-07 mTLS binds token to hardware key; heartbeat geography/clock anomaly; fabricated data detectable by SCR-12 quality flags | Partial |
| A-02 | S | JWT forgery or algorithm confusion. | 1 | 3 | 3 | PyJWT with fixed algorithms, issuer, audience, `exp` required; dev HS256 refused outside dev/test; OIDC JWKS. Recommend asymmetric-only allow-list (SF-08) | Mitigated (with SF-08 hardening) |
| A-03 | E | Broken access control: a researcher reads another study, an administrator reads scores, an analyst reads the vault. | 2 | 3 | 6 | C-10 permission matrix + study scoping (`ensure_study_access`), CI permission tests (test_rbac.py); C-13 DB roles; RLS planned | Partial (no RLS yet) |
| A-04 | T | Injection through event payloads (SQL, JSON) or import files (CSV/XLSX formula injection on export). | 1 | 3 | 3 | SQLAlchemy bound parameters throughout; f-string SQL only with constants (semgrep triage, scan-findings §2); strict Pydantic event models; CSV export must neutralise leading `= + - @` (pentest item) | Mitigated (SQL); verify exports |
| A-05 | D | Ingestion overload: a reconnect storm of 50 kiosks or a malicious kiosk sending max-size batches exhausts the single API process (GIL-bound CPU), the DB pool and the threadpool. Measured: p95 tens of seconds and client timeouts under 50 concurrent kiosks (tools/loadtest/RESULTS.md). | 3 | 2 | 6 | C-20 per-kiosk rate limit, body-size limit at the proxy, ingest concurrency limiter with 503 + Retry-After, multiple workers; kiosk exponential backoff (KSK-07) | Open (SF-01) |
| A-06 | D | Oversized or deeply nested JSON bodies cause memory/CPU exhaustion before validation. | 2 | 2 | 4 | `max_batch_bytes` (1 MiB) checked after the body is fully read; Pydantic limits; add proxy `client_max_body_size` and streaming limit (SF-02) | Partial |
| A-07 | I | Report bearer tokens leak through logs: the token is in the URL path and is written to `governance.audit_events.path` and to access logs (SF-03). | 2 | 2 | 4 | 128-bit tokens, digest-stored, expiring, withdrawable; fix: redact path in audit/access logs, `Referrer-Policy: no-referrer`, move token to fragment or POST body | Open (SF-03) |
| A-08 | I | Verbose errors or OpenAPI docs disclose internals in production. | 2 | 1 | 2 | Stable error codes; disable `/docs` and `/openapi.json` outside dev or put behind auth (SF-10) | Partial |
| A-09 | R | A user denies having exported data or changed a gate. | 1 | 3 | 3 | C-11 audit middleware writes one row per write and research read in its own transaction; append-only triggers (C-12); PRV-13 hash chain deferred | Mitigated (tamper-evidence deferred) |
| A-10 | T | Replay of an old release pack or downgrade of the policy to re-enable reports. | 1 | 3 | 3 | C-26 Ed25519-signed release packs with expiry and revocation; kiosk rejects downgraded packs (KSK-11 AC) | Partial (server done) |
| A-11 | E | Synthetic or test paths reachable in production (`ingest-synthetic`, dev-login, plaintext chunks). | 1 | 3 | 3 | C-28/C-29/C-35: settings validator refuses dev auth, default secrets and plaintext outside dev/test; synthetic events refused outside dev | Mitigated |
| A-12 | I | Brute force of report tokens, pairing codes or device tokens. | 1 | 2 | 2 | 128-bit report tokens, 256-bit device tokens; pairing codes are short (6 chars, admin-only, expiring): rate-limit and lock out (C-20) | Partial |
| A-13 | T | Mass-assignment or unknown fields smuggle forbidden data (free text, transcripts) into storage via `payload_ext`. The scrub only checks the leaf name of the unknown key (SF-05). | 2 | 2 | 4 | C-03 forbidden-field scrub; fix: recursive scrub of unknown subtrees and size cap on `payload_ext` | Open (SF-05) |

## 6. Data platform (TB-4, TB-5)

| ID | STRIDE | Threat scenario | L | I | Risk | Controls | Status |
|---|---|---|---|---|---|---|---|
| D-01 | I | DB snapshot, backup or replica copy leaks raw events. | 2 | 3 | 6 | RDS encryption + separate backup keys (C-34); events table holds plaintext JSONB (needed for analysis) so backups are as sensitive as the DB; ≤ 14-day backups | Open (infra) |
| D-02 | I | The identity vault is reachable with research credentials. Wave-1 default: `IDENTITY_DATABASE_URL` falls back to `DATABASE_URL` (SF-04). | 2 | 3 | 6 | C-04 separate DB, separate credentials and keys, column encryption (C-09), IdentitySteward-only relink with justification | Partial (SF-04) |
| D-03 | T | A privileged DB user edits raw events or consent to change results or hide a withdrawal. | 1 | 3 | 3 | C-12 append-only triggers (UPDATE refused; DELETE only with `shriii.mutation_purpose`); C-11 audit; PRV-13 hash chain | Partial (a superuser can disable triggers) |
| D-04 | I | Erasure is incomplete: plaintext copies survive (events, DLQ, snapshots, backups, logs, exports). | 2 | 3 | 6 | C-06 erasure job deletes events, chunks, DLQ, links, parking; deletes wrapped DEK (crypto-shred); tombstones snapshots; replay guard; PRV-06 drill; backups ≤ 14 days | Partial (export register and backup drill open) |
| D-05 | I | Re-identification of de-identified snapshots via quasi-identifiers (site, date, language, age band, gender, literacy). | 2 | 3 | 6 | VAL-17 de-identified export; coarse bands; date shifting/k-anonymity check before external release; export justification >50 rows (PRV-08) | Open |
| D-06 | T | Synthetic data contaminates real analyses. | 1 | 3 | 3 | `synthetic=true` label, DB constraint, refused outside dev; snapshots include synthetic only on explicit dev flag (C-28) | Mitigated |
| D-07 | D | Unbounded research queries (e.g. `/features/matrix` loads a whole study) or job storms starve ingestion. | 2 | 2 | 4 | Pagination, statement timeouts per role, separate read replica for research, worker concurrency limits | Open (SF-11) |
| D-08 | E | The application DB role can DELETE guarded tables outside erasure. | 1 | 3 | 3 | Trigger requires `mutation_purpose`; use a separate `shriii_erasure` login for the erasure job only (roles exist in migration 0002) | Partial |
| D-09 | I | Key compromise: env-var keys readable by anyone with host or container access; one KEK protects both DEKs and DLQ payloads. | 2 | 3 | 6 | C-08 KMS-held keys, key separation per purpose, rotation (`kek_version` column exists), no keys in images or logs | Open (SF-07) |

## 7. Research web app (`apps/web`, TB-6)

| ID | STRIDE | Threat scenario | L | I | Risk | Controls | Status |
|---|---|---|---|---|---|---|---|
| W-01 | S | Phishing or credential stuffing takes over a researcher account. | 2 | 3 | 6 | C-14 OIDC with enforced MFA (phishing-resistant for admin and IdentitySteward); short sessions; API can additionally require `amr`/`acr` claims (SF-08) | Open |
| W-02 | T/E | XSS in dashboards (participant-supplied strings, import file content, instrument metadata) steals tokens. | 2 | 3 | 6 | React escaping, no `dangerouslySetInnerHTML`, strict CSP with nonces, tokens in memory or httpOnly cookies (not localStorage), Trusted Types | Open (wave 2 builds the app) |
| W-03 | T | CSRF on state-changing admin actions. | 1 | 3 | 3 | Bearer tokens in `Authorization` header (not cookies) are CSRF-immune; if cookies are used: SameSite=strict + CSRF token. CORS allow-list with credentials is explicit (`api_cors_origins`) | Mitigated for bearer design |
| W-04 | I | Bulk export of participant-level data to an unmanaged laptop. | 2 | 3 | 6 | Export justification > 50 rows (PRV-08, not yet implemented, SF-12); de-identified snapshots only; download audit; watermark exports with request id | Open |
| W-05 | I | Dashboards show small cells that identify individuals (e.g. one 60+ Tamil woman at a site). | 2 | 2 | 4 | Minimum cell size suppression in dashboards and exports | Open |
| W-06 | E | Admin functions (gates, release packs, kiosk tokens, legal holds) used by the wrong role. | 1 | 3 | 3 | C-10 RBAC per endpoint; two-person approval for gate and release-pack changes (PLT-09) | Partial (two-person rule is process) |

## 8. Insider risk

| ID | STRIDE | Threat scenario | L | I | Risk | Controls | Status |
|---|---|---|---|---|---|---|---|
| I-01 | I | A field administrator photographs contact details or pairs a pid to a known person. | 2 | 3 | 6 | Contact capture on picture-digit pad with headset readback; vault write-only for administrators; administrators cannot read scores (PRV-08 AC); training and confidentiality agreements | Partial |
| I-02 | I | An IdentitySteward re-links pids to contacts without cause. | 1 | 3 | 3 | Relink needs a justification and is audited (`identity_vault.relink_audit`); periodic review by the DPO; alert on vault reads (PRV-10) | Partial |
| I-03 | T | A researcher edits gates or the dictionary after seeing data (p-hacking, premature release). | 2 | 3 | 6 | Frozen, hashed dictionary and gates (PLT-09 records), pre-registration, signed release packs, audit; two-person approval | Partial |
| I-04 | T/E | A developer with production access runs ad-hoc SQL to change or extract data. | 2 | 3 | 6 | No standing prod access; break-glass with approval and session recording; DB audit logging (pgaudit); separate prod accounts | Open |
| I-05 | I | A fleet operator pulls kiosk logs containing personal data. | 2 | 2 | 4 | Scrubbed logs only (KSK-10 remote "pull scrubbed logs"); heartbeat carries no participant identifiers (AC) | Open |
| I-06 | R | An insider deletes audit rows to hide access. | 1 | 3 | 3 | Append-only audit trigger; daily export to versioned S3 (PRV-08); hash chain + SIEM (PRV-13, deferred) | Partial |
| I-07 | T | A malicious contributor adds a dependency or build step (see supply-chain policy). | 1 | 3 | 3 | Two-person review, CODEOWNERS for security-sensitive paths, lockfiles, pinned actions, provenance | Open |

## 9. Abuse cases (PRV-09 list) and how they are handled

| Abuse case | Threat IDs | Handling |
|---|---|---|
| **Replay** of captured or retried batches | T-04 | Idempotent `batch_id`, `event_id` PK in `event_dedup`, `(session_id, seq)` uniqueness, seq-conflict DLQ. The load harness proves zero duplicate rows under 10× concurrent copies, re-packed copies and retries (`tools/loadtest`). |
| **Fake sessions** from a stolen or cloned device credential | A-01, K-13 | Device tokens bound to kiosk_id, revocable; mTLS with TPM key (planned); per-kiosk rate limits and plausibility checks (session duration vs `t_mono_ms`, seq density, heartbeat presence); SCR-12 quality flags; supervised-site linkage for criterion data. |
| **Malicious QR** (admin pid QR, report QR page) | K-11, A-07, A-12 | pid pattern + Luhn check; admin-only scanning; report page tokens are 128-bit random and expiring; no URL from QR content is ever opened on the kiosk. |
| **Theft** of a kiosk | K-02, K-04, K-13 | TPM-sealed FDE, sealed DEKs, remote revoke and wipe, stolen-kiosk drill (PRV-10). |
| **Coaching** (someone tells the player what to do) | K-08 | Not a security control: think-aloud and quality flags; reports are reflection-only and gated; onlooker icon logs `onlooker_reported`. |
| **Consent bypass** (scorable data without core consent) | K-09 | Server parks scorable events until `consent.granted(core)` and purges them after 72 h; kiosk statechart property test (KSK-02). Verified by the out-of-order load scenario (events parked then released, 0 left parked). |

## 10. Residual risks needing an owner decision

1. **Plaintext events at rest in PostgreSQL** (`kiosk_raw.events.envelope`). Crypto-shredding protects raw
   chunks; events and derived tables are protected by deletion plus disk encryption only. Accept with
   ≤ 14-day backups, or move to column encryption with the session DEK (costly for analysis).
2. **Self-declared age** at anonymous kiosks (K-14). Accepted in the DPIA pending legal review (PRV-12).
3. **Wave-1 dev defaults** (plaintext chunks, derived dev keys, dev JWT secret) are safe only because the
   settings validator refuses them outside dev/test. Any new environment name must keep that rule.
4. **Single API instance capacity** (A-05): until the SF-01 optimisations and limits ship, a fleet reconnect
   can degrade ingestion for minutes. Data is not lost (kiosks retry; verified), but the ING-02 latency AC is
   not met.

## 11. Review checklist for changes

Re-run this model (and update the controls matrix) when a change: adds an endpoint or role; changes the
event envelope or `UploadBatch`; touches key handling, consent or erasure; adds a kiosk peripheral or OS
interface; adds a data export path; or adds a third-party service.
