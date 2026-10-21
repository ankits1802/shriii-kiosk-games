# shriii-api: backend API, database and job worker

This package is the FastAPI service, the PostgreSQL 18 schema with its Alembic migrations, and the Postgres-backed job worker. It covers layer 1 (raw events) and stores layers 2 to 5. Indicator formulas and psychometrics are computed by `shriii_scoring` and `shriii_validation`, which this package calls through thin adapters in `src/shriii_api/adapters/`.

## Run

```bash
docker compose up -d postgres                 # this machine maps Postgres to 55432; see note below
export DATABASE_URL=postgresql+psycopg://dev:dev@localhost:55432/shriii
uv run shriii-api migrate                     # research DB + identity vault (IDENTITY_DATABASE_URL)
uv run shriii-api seed --demo                 # instruments, dictionary, games, demo study, dev kiosk token
uv run shriii-api serve --reload              # http://127.0.0.1:8000/docs
uv run shriii-api worker                      # job worker (or: worker --once)
uv run shriii-api ingest-synthetic --participants 20   # end-to-end synthetic data (ENV=dev/test only)
uv run shriii-api export-openapi              # writes apps/api/openapi.json (OpenAPI 3.1)
uv run shriii-api dev-token --roles researcher
uv run shriii-api demo-pipeline               # end-to-end synthetic demo (ENV=dev/test only), see below
```

### End-to-end demo

`shriii-api demo-pipeline` migrates and seeds, creates a fresh demo study, simulates synthetic players with
`shriii_simulator` (default 400 per language for hi-IN and ta-IN, 100 of them with a T2 retest, item-level criterion
responses with rotating planned-missing blocks, 2 % careless responders, and planted DIF: no-go errors harder in ta-IN at
equal latent self-control), uploads every raw event through `POST /api/v1/events/batch`, links participants and stores
the criterion administrations, then runs the worker (event validation, trials, features, batch scoring with group-level
private-report estimates), matching, a frozen snapshot, every validation analysis (confirmatory construct validity on
the registered primary hypotheses), a registered model with an untouched holdout cohort, provisional norms, gate
evaluation (evaluate-only), a fail-closed release pack and report, kiosk health and a retention dry run. It prints a
digest (`--json` for everything) and writes the full summary to `DATA_DIR/demo/<study>.json`. Options:
`--participants-per-language`, `--languages`, `--retests`, `--seed`, `--workers` (processes for upload, criterion and
jobs), `--models`, `--n-boot`. Point `DATABASE_URL`/`IDENTITY_DATABASE_URL` at a scratch database.

To run the tests: `uv run pytest apps/api/tests`. They need a reachable Postgres, either from `SHRIII_TEST_DATABASE_URL` or found on localhost:5432 or localhost:55432. The tests create their own `shriii_api_test*` databases. If no server is reachable, the tests are skipped, unless `SHRIII_REQUIRE_DB=1` is set.

## Contracts the clients rely on

- **Batch checksum.** `UploadBatch.sha256` is the lower-case hex SHA-256 of the RFC 8785 (JCS) serialisation of `session_chunks`. In JavaScript this is `JSON.stringify` with recursively sorted keys. See `shriii_api.canonical`.
- **Encrypted chunks.** The 32-byte DEK is sealed with libsodium `crypto_box_seal` to the backend X25519 public key, which `POST /api/v1/admin/kiosks` returns. The ciphertext is AES-256-GCM with a 12-byte nonce and no AAD, over NDJSON (one event per line). `none_dev` plaintext chunks are accepted only when `ENV` is dev or test.
- **Device auth.** Kiosks send `Authorization: Bearer kdt_...`. The device token is shown once when the kiosk is registered. Users send OIDC JWTs, or in dev a token from `POST /api/v1/auth/dev-login`.
- **Per-event statuses.** Each event gets one of `accepted`, `duplicate`, `parked`, `rejected_terminal` or `retryable`. A replayed `batch_id` returns the stored result with `duplicate_batch=true`.

## Data layout

| Schema | Contents |
|---|---|
| `kiosk_raw` | batches, raw chunks, `event_dedup`, `events` (partitioned by `server_received_date`), `consent_parking`, `dead_letter`, sessions |
| `scored` | trait registry (constructs, indicators, feature definitions, mappings), `trials_canonical`, `indicators_long`, `trait_estimates`, `session_quality_flags`, scoring runs |
| `criterion` | instruments, versions, items, language versions, keys, permissions, responses (append-only), scale scores, imports |
| `linkage` / `consent` | participants (pid only), links, pairing codes, withdrawals / consent artefacts (immutable), session keys, erasure requests, receipts, tombstones |
| `study` | studies, protocols, cohorts, quotas, arms, randomisation blocks, enrollments, occasions, retests, deviations, freezes |
| `validation` | analysis plans, snapshots and members, matched records, runs and results, decisions, gates, release packs, models, norms |
| `reporting`, `governance`, `ops`, `games` | reports and templates; audit, kiosks, deployments, content versions, settings, holds, retention; jobs; game definitions |
| `identity_vault` | contacts and relink audit, in a **separate DB and connection** (`IDENTITY_DATABASE_URL`) with its own Alembic environment (`-n identity`) |

Database triggers reject UPDATE on raw events, criterion responses, consent artefacts and audit events. DELETE on those tables is allowed only after a transaction sets `shriii.mutation_purpose` to `erasure` or `retention`.

## Privacy lifecycle

- **Declined core consent or an under-18 exit** (`consent.declined` with `consent_kind=core`, or `session.abandoned` with reason `consent_declined`/`under_age`) queues a session-scope erasure. The session row, raw events, raw chunks, consent artefacts and dead letters are deleted, and a tombstone refuses re-uploads. The only thing kept is an anonymous counter: a `governance.system_events` row (`session_discarded.<reason>`) holding the kiosk id and nothing else (ONB-02, ONB-04).
- **Dead letters** for declined or tombstoned sessions keep metadata only, with no payload. Other dead letters, including `no_consent` after the parking window, keep the encrypted payload for triage and replay under the DLQ retention rule.
- **A session-scope erasure** also deletes matched records that reference the session. It tombstones every snapshot that holds the session's participant and queues rebuilds. Participant-scope erasure behaves as before.
- **Retention:** the play-only rule removes whole sessions, meaning raw events, raw chunks and the session DEK. Legal holds also protect dead letters, expired reports and parked events.

## Scoring engines

- **Criterion scores (layer 3)** come from `shriii_scoring.criterion.score_criterion`, run on the exact stored instrument version. The API's reference scorer is used only when that engine is missing.
- **Performance tasks** are recorded as `<item>.<measure>` responses (Tower of London, criterion card sort). A `.moves` measure needs `expected_response` set to the problem's minimum moves.
- **Attention checks** also store `expected_response`, so a correction is re-evaluated against the key and the whole occasion is rescored.
- **Trait estimates (layer 4)** use `shriii_scoring.bands.composite_score` and `band_for` with the release pack and the `gates.yaml` SEM rule.
- **Validation (layer 4)** runs in `shriii_validation` through `adapters/validation.py` (`run_analysis`, `train_model`, `generate_norms`, `evaluate_gates`). There is no API-side fallback: without the engine a job fails with `adapter_unavailable`. Each `validation.statistical_results` row stores N, CI, threshold, pass/fail, `exclusions` (rows available/used/excluded and the frame-level exclusions) and `provenance` (snapshot id and sha256, dictionary/gates/hypotheses sha256, algorithm version, git sha, inputs hash). `POST /api/v1/validation/datasets/{id}/gate-evaluation` evaluates the trait and battery gates from the snapshot's latest results without promoting anything.
- **Batch scoring** (`batch_scoring` job, `POST /api/v1/features/batch-scoring`) rescores a study x pathway per language so model-based indicators (partial pooling) exist, and writes group-level private-report estimates to `scored.group_indicators` (no session or participant column; small cells suppressed). Snapshots use only indicator values with status `ok`.
- **Planned missingness:** `planned_missing_items` are validated and stored on every response row of the administration and reused by every rescore (corrections, key updates).
- **Report policy:** `config/report_policy.yaml` withholds constructs from player reports on top of `gates.yaml` (integrity, BUILD_DECISIONS #6); their phrases are also left out of release-pack allowlists.
