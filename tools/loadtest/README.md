# shriii-loadtest: ingestion and research API load tests (QA-05, ING-02)

A kiosk-fleet simulator for `POST /api/v1/events/batch` and the research read API. It replays realistic
sessions from `stats/simulator` through the real `UploadBatch` contract (JCS checksum, gapless `seq`,
optional X25519 sealed-box + AES-256-GCM chunks), measures latency, and then **verifies the database**: every
event stored exactly once, nothing left in consent parking, nothing dead-lettered.

Results and recommendations: [RESULTS.md](RESULTS.md). Proposed API patches: [proposals/](proposals/).
Targets: [targets.yaml](targets.yaml) (ING-02: p95 < 300 ms per 500-event batch with 50 kiosks; zero
duplicates).

## Layout

| Path | Purpose |
|---|---|
| `src/shriii_loadtest/corpus.py` | Simulated template sessions (cached in `.cache/`), re-targeted per kiosk with fresh ids and wall clock |
| `src/shriii_loadtest/batches.py` | Kiosk outbox packing (≤ 500 events, session order) and `UploadBatch` building, plain or sealed |
| `src/shriii_loadtest/scenarios.py` | `steady`, `saturate`, `retry`, `dup_storm`, `out_of_order` (incl. 1970 / +3 day clocks), `reconnect` |
| `src/shriii_loadtest/runner.py` | Async driver with the outbox retry policy (retryable events, 5xx, 429, `Retry-After`), research readers |
| `src/shriii_loadtest/verify.py` | Exactly-once verification, `pg_stat_statements` top statements, table sizes |
| `src/shriii_loadtest/report.py` | Percentiles, ING-02 verdict, Markdown/JSON reports |
| `src/shriii_loadtest/profile_ingest.py` | In-process cProfile of `ingest_batch` (no HTTP) |
| `locustfile.py` | Locust users (`KioskUser`, `ResearcherUser`) for live UI / distributed runs |
| `docker-compose.yml` | Dedicated Postgres 18 on port 55442 (project `shriii-loadtest`), with `pg_stat_statements` |
| `docker-compose.fastdisk.yml` | Override that turns off fsync to separate app cost from storage cost (never for real data) |
| `results/<label>/` | Committed run reports (`*.md`, `*.json`) and profiles |
| `tests/` | Unit tests plus an end-to-end test against the real API in-process (needs Postgres) |

## Run it

All commands from the repository root. The API must run in `ENV=dev` or `test` (synthetic events and
`none_dev` chunks are refused elsewhere; use `--encryption sealed` against staging).

```bash
# 1. Database for load tests (separate from the dev DB)
docker compose -f tools/loadtest/docker-compose.yml up -d --wait

# 2. API against it (a .env at the repo root works too: ENV=dev, DATABASE_URL=...)
export ENV=dev DATABASE_URL=postgresql+psycopg://load:load@localhost:55442/shriii_load LOG_LEVEL=WARNING
uv run shriii-api migrate
uv run shriii-api seed --demo
uv run shriii-api serve --port 8077           # or: uv run uvicorn shriii_api.main:create_app --factory --workers 4

# 3. Fleet and corpus
uv run --package shriii-loadtest shriii-loadtest --base-url http://127.0.0.1:8077 provision --kiosks 60
uv run --package shriii-loadtest shriii-loadtest corpus

# 4. One scenario, or the standard suite (writes results/<label>/)
uv run --package shriii-loadtest shriii-loadtest --base-url http://127.0.0.1:8077 run saturate --kiosks 50
uv run --package shriii-loadtest shriii-loadtest --base-url http://127.0.0.1:8077 suite --label my-run

# 5. Profiling
uv run --package shriii-loadtest python -m shriii_loadtest.profile_ingest --batches 12 --out tools/loadtest/results/my-run/profile
py-spy record -o flame.svg --pid <uvicorn pid> --duration 60     # while a scenario runs
```

Verification reads the database at `--db-url` (default `postgresql://load:load@localhost:55442/shriii_load`,
or `LOADTEST_DATABASE_URL`).

Locust (live UI at http://localhost:8089):

```bash
uv run --package shriii-loadtest locust -f tools/loadtest/locustfile.py --host http://127.0.0.1:8077 \
    --users 60 --spawn-rate 10 KioskUser ResearcherUser
```

## Tests

```bash
uv run --package shriii-loadtest pytest tools/loadtest/tests -q
```

The end-to-end tests (`test_against_api.py`) start the API in-process (ASGI) against their own
`shriii_loadtest_it` databases on the load-test Postgres (or `LOADTEST_TEST_DATABASE_URL`) and are skipped
when no server is reachable, unless `SHRIII_REQUIRE_DB=1`.

## Reading the numbers

- **ING-02 metric:** first attempt of fresh, full (500-event) batches, HTTP 200, not `duplicate_batch`.
- A replayed `batch_id` returns the *stored* statuses with `duplicate_batch=true`; those are never counted
  as new acceptances.
- Timeouts (60 s client timeout) and 5xx are retried with the same body, as the kiosk outbox does; the
  database verification shows whether anything was lost or duplicated.
- The client runs on the same host as the API and database in the recorded baseline runs; see RESULTS.md for
  the environment and how to read it. Raw run output under `results/` is git-ignored: CI uploads it as the
  `loadtest-*` workflow artifact, and the earlier committed baselines remain in git history (before the
  October 2026 layout reorganisation).
