# Automated scan and code-review findings (wave 1)

Date: 2026-10-21. Code: commit `1b01cae` (wave 1: monorepo foundation, contracts, scoring dictionary, kiosk
engine, backend API, psychometrics engine). Raw tool output is in [`scans/`](scans/). Findings feed the
threat model ([threat-model.md](threat-model.md)) and the controls matrix
([controls-matrix.md](controls-matrix.md)).

## 1. Tools run

| Tool | Version | Scope | Command (abridged) | Result |
|---|---|---|---|---|
| pip-audit | 2.x (PyPI advisory DB + OSV) | 100 locked packages of the wave-1 Python workspace (`uv export --frozen --no-emit-workspace`) | `pip-audit -r reqs-wave1.txt --no-deps --disable-pip` | **No known vulnerabilities** ([pip-audit-wave1.json](scans/pip-audit-wave1.json)) |
| pip-audit | same | All workspace packages including `tools/loadtest` (locust, gevent, py-spy) | same with `--all-packages` export | **No known vulnerabilities** ([pip-audit-all-packages.json](scans/pip-audit-all-packages.json)) |
| pnpm audit | pnpm 12.10.1 | 256 JS dependencies from `pnpm-lock.yaml` (60 prod, 182 dev, 76 optional) | `pnpm audit --json` | **0 advisories** ([pnpm-audit.json](scans/pnpm-audit.json)) |
| semgrep | 1.182.0, 543 rules | `apps packages python scoring content tools/loadtest docker-compose.yml` (git-tracked files, 620 targets; directory names from before the October 2026 layout reorganisation, see docs/ARCHITECTURE.md) | `semgrep scan --config p/default p/owasp-top-ten p/secrets p/python p/typescript p/jwt p/sql-injection p/dockerfile` | 20 findings, **all triaged below as false positives or informational**; no secrets detected ([semgrep.json](scans/semgrep.json)) |

Re-run: see [README.md](README.md#re-running-the-scans).

## 2. Semgrep triage

| Rule | Location | Verdict | Reasoning |
|---|---|---|---|
| `avoid-sqlalchemy-text` (ERROR) | `backend/api/src/shriii_api/db/partitions.py:30` | False positive | f-string DDL built from a `date` object computed server-side from `server_received_at` and a fixed name pattern; no request data reaches it. Keep, but add a `# nosemgrep` with this reason. |
| `formatted-sql-query`, `sqlalchemy-execute-raw-query` (×6) | `migrations/versions/0002_guards_roles_partitions.py:90,131,132` | False positive | Migration DDL interpolates module-level constant lists of schema/table names. |
| `avoid-sqlalchemy-text` (×6) | `services/retention.py:79,125,144,145,155,158` | False positive | f-strings interpolate module constants (`_HELD_SESSIONS_SQL`, table and column names from the retention registry); values are bound parameters (`:cutoff`, `:s`). |
| `avoid-sqlalchemy-text` (×2) | `worker/queue.py:189,197` | False positive | Interpolates a constant predicate string; `:lease` is bound. |
| `non-literal-import` | `adapters/scoring.py:47` | False positive | `importlib.import_module` over a hard-coded candidate list (adapter probing), not user input. |
| `python37-compatibility-importlib2` (×2) | `services/retention.py:7`, `shriii_scoring/resources.py:12` | Not applicable | Python ≥ 3.13 is required. |
| `unsafe-formatstring` (INFO ×2) | `kiosk-game/src/engine/module-host.ts:220`, `voice/VoiceService.ts:197` | Informational | Template literals in `console.error` with internal ids; no format-string sink. Ensure production builds strip or scrub console output that could contain participant data. |

## 3. Manual review findings

Severity uses impact on participants' data and study integrity in the **target deployment** (supervised
sites first). "Proposed fix" points to a patch under `tools/loadtest/proposals/` where one exists.

### SF-01 · High · Ingestion does not meet ING-02 under load; pool exhaustion turns load into HTTP 500s

*Evidence:* `tools/loadtest/RESULTS.md`. A single 500-event batch takes about 1.5 to 4 s even with one kiosk;
with 50 kiosks, p95 is tens of seconds (ING-02 target: p95 < 300 ms). Under 50 concurrent kiosks the API
log shows `QueuePool limit of size 10 overflow 10 reached` (49 occurrences in one suite) and HTTP 500s; the
kiosks' retries then succeed, so **no data was lost or duplicated**, but the ingest tier is trivially
saturated by a fleet reconnect (threat A-05).
*Root causes:* a single GIL-bound process doing about 1 s of CPU per batch (two full Pydantic model walks per
event, `model_dump`, JCS hashing, SQLAlchemy compilation of a 3,000-parameter multi-row `VALUES` insert, ORM
bulk insert of 500 wide rows), unbounded concurrency into a 20-connection pool, and three pooled connections
per request (device lookup, request session, audit).
*Proposed fix:* `0001-ingest-hot-path.patch`, `0002-ingest-admission-control.patch`; run several workers;
put a per-kiosk rate limit and body-size limit at the proxy.

### SF-02 · Medium · Body-size limit is applied after the whole body is in memory; realistic sealed batches exceed it

`events.py` reads `await request.body()` and `ingest_batch` then compares `len(body)` with
`max_batch_bytes` (1 MiB). Uvicorn imposes no limit, so the limit protects nothing against memory pressure
(A-06). Separately, a realistic 500-event batch from the simulator is about 810 kB as JSON; sealed, the
base64 ciphertext makes it about 1.08 MB, which is **over** the 1 MiB limit, so a kiosk that fills batches to
the contract maximum of 500 events gets 413s. KSK-07 specifies "≤ 500 events or ≤ 256 kB, gzipped", but the
API does not accept `Content-Encoding: gzip` and the chunk format has no compression field, while ciphertext
cannot be compressed after encryption.
*Proposed fix:* enforce the size limit at the proxy and while streaming (`0003-ingest-gzip-and-streaming-limit.patch`
accepts gzip transport with a decompressed-size cap); add `compression: "gzip"` to the chunk contract so
kiosks compress NDJSON **before** encrypting (contract change for `contracts`, not patched here).

### SF-03 · Medium · Report bearer tokens are persisted in the audit log and access logs

`GET /api/v1/reports/by-token/{token}` and `POST .../{token}/erase` carry the token in the path. The audit
middleware stores `path=request.url.path` in `governance.audit_events`, and uvicorn's access log prints it,
which undoes the digest-only storage of tokens (`reports.token_digest`). Anyone with audit-read or log access
can open or erase a participant's report until expiry (A-07).
*Proposed fix:* `0004-security-redaction-and-scrub.patch` redacts the token segment in the audit path; also
disable or filter uvicorn access logs for that route at the proxy, set `Referrer-Policy: no-referrer`, and
consider moving the token to the URL fragment (read client-side, sent in a header).

### SF-04 · Medium · Identity vault falls back to the research database

`Settings.effective_identity_database_url` returns `DATABASE_URL` when `IDENTITY_DATABASE_URL` is unset, in
every environment. PRV-04 requires a separate DB with separate keys; a deployment that forgets the variable
silently co-locates contact data with research data under the same credentials (D-02).
*Proposed fix:* in `0004`, refuse to start outside dev/test unless `IDENTITY_DATABASE_URL` is set and differs
from `DATABASE_URL`.

### SF-05 · Medium · Forbidden-field scrub only checks the leaf name of an unknown field

`shriii_contracts.strictness.payload_ext` drops tolerated unknown fields named `text`, `free_text`,
`transcript`, `audio`, `asr_alternatives`, but only when the *unknown key itself* has that name. An unknown
object such as `payload.meta = {"transcript": "..."}` is stored whole in `payload_ext` (A-13, PRV-03).
*Proposed fix:* `0004` scrubs forbidden names recursively inside unknown subtrees and caps the size of
`payload_ext`.

### SF-06 · Low now, High before open-public use · Static admin PIN compiled into the kiosk bundle

`frontend/apps/kiosk/src/config.ts` reads `VITE_DEV_PIN` (default `2468`) into the bundle. Today the DevPanel is only
mounted in development builds, so production exposure is limited, but KSK-13 (rotating picture PIN or NFC,
lockout, logging) is not implemented and any `VITE_*` value is public in the shipped JavaScript (K-01).
*Fix:* implement KSK-13; remove the PIN from build-time config; verify the bundle has no PIN (pentest 1.7).

### SF-07 · Medium · Key management: environment variables, shared KEK, derived dev keys

The backend X25519 private key, the session-key KEK, the vault key, the pid pepper and the release-pack
signing seed are environment variables. The same KEK wraps session DEKs (AAD = session id) and encrypts
dead-letter payloads (AAD = `dead_letter`), so a KEK rotation or compromise affects both. In dev/test all keys
derive from `DEV_JWT_SECRET` (default `change-me-dev-only`), which is acceptable only because the settings
validator refuses dev defaults outside dev/test (D-09).
*Fix:* KMS-backed key provider (`kms:Decrypt` for unwrap only, per-purpose keys), separate DLQ key, rotation
procedure using the existing `kek_version` column; never use captured dev data outside dev.

### SF-08 · Low · JWT hardening gaps

`OIDC_ALGORITHMS` is configurable without an asymmetric-only check; PRV-08 requires MFA but the API does not
check `amr`/`acr`; 401 messages include the PyJWT exception text (minor information disclosure).
*Fix:* validate algorithms ⊂ {RS256, ES256, EdDSA} at start-up; require configured `amr`/`acr` values for
admin and IdentitySteward roles; return a generic message and log the detail.

### SF-09 · Low · Electron fuses and ASAR integrity not configured

The scaffold sets sandbox, context isolation, CSP and deny-all permissions, but no fuses
(`RunAsNode`, `NodeOptions`, ASAR integrity, only-load-from-ASAR). With physical access these allow running
the Electron binary as Node or loading modified app code (K-12).
*Fix:* set fuses at packaging time and check them in CI (kiosk hardening guide §5).

### SF-10 · Low · API documentation and headers in production

`/docs`, `/redoc` and `/openapi.json` are served in every environment; the API sets no security headers
(expected at the proxy, but there is no proxy configuration yet).
*Fix:* disable docs outside dev/test or require auth; add HSTS, `X-Content-Type-Options`, `Cache-Control:
no-store` for data responses at the proxy.

### SF-11 · Medium · Unbounded research queries

`GET /api/v1/features/matrix` loads every current indicator value of a study into memory with no pagination;
no statement timeout is configured for the API role. With a full Stage 2 dataset this can starve ingestion
(D-07).
*Fix:* pagination or streaming export; per-role `statement_timeout`; research reads from a replica.

### SF-12 · Medium · PRV-08 export justification is not implemented

PRV-08 requires a justification for exports over 50 rows. Snapshot downloads and list endpoints are audited,
but no justification is requested or recorded (W-04).
*Fix:* require a `justification` parameter for snapshot downloads and large list/export responses; store it
in the audit row.

### SF-13 · Medium · Audit row can be lost after a committed write; client gets HTTP 500

The audit middleware writes the audit row in a **separate** transaction after the request transaction has
committed. Under load the audit write timed out on the connection pool ("audit write failed"), so the batch
was stored without an audit row and the client received HTTP 500 for a successful upload (it then retried and
got `duplicate_batch`). For research reads the same path can lose read-audit rows (A-09).
*Fix:* write the audit row inside the request transaction for writes (atomic with the change), keep the
separate transaction only for denials and failures; size the pool so the audit write cannot starve
(`0002` admission control removes the starvation seen in testing).

### SF-14 · Low · No rate limiting

There is no rate limiting on any route (device uploads, report-token pages, pairing codes, auth). Token
entropy makes guessing impractical (128-bit report tokens, 256-bit device tokens), but floods are possible
(A-05, A-12).
*Fix:* proxy rate limits per IP and per device token; application-level 429 for pairing-code attempts.

### SF-15 · Info · Wave-1 kiosk build is not field-ready by design

The browser outbox (Dexie/IndexedDB) stores events in plaintext and sends `none_dev` chunks; the uploader
attaches no device credential. This matches BUILD_DECISIONS (browser-first) and the API refuses plaintext
outside dev/test, but the browser build must never be used with real participants (K-04, T-01).

### SF-16 · Info · Replayed batches return the original per-event statuses

A replayed `batch_id` returns the stored result with `duplicate_batch=true`, including the original
`accepted` statuses. Clients and monitoring must not count those as new acceptances (the load harness
excludes them). Worth stating in the `UploadBatchResult` contract docs.

## 4. Positive observations

- Device tokens, report tokens and QR tokens are stored as SHA-256 digests; device tokens are bound to the
  batch `kiosk_id`.
- Idempotency is robust: across retry, re-pack, 10× concurrent storms, out-of-order uploads and 1970/+3-day
  clocks, the load harness found **0 duplicate rows, 0 missing events, 0 events left parked**.
- Dev-only behaviour (dev login, plaintext chunks, synthetic data, derived keys) is refused outside dev/test
  by the settings validator and in ingestion.
- Append-only triggers protect raw events, criterion responses, consent artefacts and audit rows; deletes
  need an explicit `mutation_purpose`.
- No secrets in the repository (semgrep `p/secrets`); `.env` is git-ignored with a `.env.example`.
- The Electron scaffold already follows the main hardening recommendations (sandbox, context isolation,
  strict CSP, deny-all permissions, no navigation or new windows, devtools off when packaged).
