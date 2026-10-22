# Load-test results (ING-02, QA-05)

Summary of the recorded `shriii-loadtest` runs against `POST /api/v1/events/batch` and the research read API.
Raw per-run reports (`*.md`, `*.json`, profiles) are no longer committed: `tools/loadtest/results/` is
git-ignored, and the [Load test workflow](../../.github/workflows/loadtest.yml) uploads each run as the
`loadtest-<run id>` artifact, with the ING-02 table in the job summary. The baselines summarised here are in
git history (`git show 6d632ef^:tools/loadtest/results/<label>/<scenario>.md`).

Targets come from [targets.yaml](targets.yaml): ING-02 p95 < 300 ms for a full 500-event batch with 50 kiosks,
zero duplicate rows, nothing left in consent parking, zero terminal failures. The research-API p95 (800 ms)
and the reconnect drain time are proposed working SLOs, not plan targets.

## Verdict

| Check | Result |
|---|---|
| Exactly-once storage (duplicate rows, missing events, dead letters) | **Pass in every run**, including 10x replay storms, re-packed batches and kiosk clocks at 1970 / +3 days |
| Consent parking drained (`still_parked = 0`) | **Pass in every run** |
| Terminal failures (data loss from the kiosk's point of view) | **Pass in every run** (0) |
| ING-02 latency, p95 < 300 ms per 500-event batch at 50 kiosks | **Fail**: p95 of tens of seconds under 50 concurrent kiosks; 1.5 to 4 s per batch even with one kiosk |
| Research API p95 < 800 ms during ingestion (proposed) | **Fail**: p95 19.6 s in the mixed run |

Correctness (C-16 in the [controls matrix](../../docs/security/controls-matrix.md)) is verified; the latency
acceptance criterion is open and tracked as SF-01 / A-05 in the
[threat model](../../docs/security/threat-model.md) and [scan findings](../../docs/security/scan-findings.md).

## Environment

- Client, API (one uvicorn process unless noted) and PostgreSQL 18 on the same host, so the client competes
  with the server for CPU. Absolute numbers are pessimistic; relative comparisons between runs hold.
- `durable`: stock PostgreSQL settings. `fastdisk`: [docker-compose.fastdisk.yml](docker-compose.fastdisk.yml)
  (fsync off) to separate application cost from storage cost; never for real data.
- Corpus: 32 simulated session templates from `stats/simulator`, mean 1.6 kB per event, batches of up to 500
  events (about 0.65 to 0.8 MB per request).
- ING-02 metric: first attempt of fresh, full (500-event) batches with HTTP 200 (see the README).

## Baseline, durable storage, 1 worker (`baseline-durable-1w`)

| Scenario | Kiosks | Unique events | ING-02 n | p50 (ms) | p95 (ms) | Duplicates | Parked | Terminal |
|---|---|---|---|---|---|---|---|---|
| steady-50k | 50 | 57,907 | 93 | 19,535 | 25,515 | 0 | 0 | 0 |
| saturate-50k | 50 | 110,900 | 151 | 43,083 | 58,109 | 0 | 0 | 0 |
| saturate-50k-sealed (X25519 + AES-GCM, 1 MiB body cap) | 50 | 54,450 | 0 (no full batch fits the cap) | n/a | n/a | 0 | 0 | 0 |
| retry-50k | 50 | 57,907 | 101 | 32,132 | 46,051 | 0 | 0 | 0 |
| dup-storm-20x (20 batches x 10 copies) | 20 | 23,348 | 163 | 52,261 | 58,235 | 0 | 0 | 0 |
| out-of-order-skew (1970 / +3 day clocks) | 50 | 58,163 | 25 | 38,322 | 47,887 | 0 | 0 | 0 |
| reconnect-50k-backlog (4 sessions per kiosk) | 50 | 223,273 | 342 | 31,975 | 58,523 | 0 | 0 | 0 |
| mixed-research (ingestion + research readers) | 50 | 57,907 | 51 | 24,654 | 56,220 | 0 | 0 | 0 |

In mixed-research the research read API had p95 19,620 ms against the proposed 800 ms.

## Baseline, fast disk, 1 worker (`baseline-fastdisk-1w`)

| Scenario | Kiosks | ING-02 n | p50 (ms) | p95 (ms) | Stored events/s |
|---|---|---|---|---|---|
| single-kiosk | 1 | 9 | 965 | 1,464 | 479 |
| saturate-50k | 50 | 188 | 30,844 | 40,417 | 715 |
| reconnect-50k-backlog | 50 | 329 | 41,750 | 56,983 | 465 |

Turning fsync off helps only modestly (saturate p95 58 s to 40 s): the cost is in the application, not in storage.
A cProfile of `ingest_batch` over six batches (`python -m shriii_loadtest.profile_ingest`, 28 s profiled) spent
about 40 % waiting on database round trips (`select.select`); most of the rest was CPU in one GIL-bound process:
the recursive unknown-field walk in `shriii_contracts.strictness` (4.6 s cumulative), JCS canonicalisation,
pydantic validation and SQLAlchemy bind-parameter compilation for the inserts.

## With the proposed patches (`patched-0001-0002-fastdisk-*`)

[proposals/](proposals/) holds unreviewed API patches: `0001-ingest-hot-path` (ingestion service and
`strictness.py`: cheaper unknown-field filtering, direct `Jsonb` binding) and `0002-ingest-admission-control`
(an `anyio.CapacityLimiter` on the batch endpoint answering 503 with `Retry-After`, which the kiosk outbox
already honours). `0001-ingestion-optimisations-unreviewed` touches the same files as the two together
(ingestion, strictness, endpoint, settings, CLI and OpenAPI).

| Run | Scenario | ING-02 n | p50 (ms) | p95 (ms) | Stored events/s |
|---|---|---|---|---|---|
| 1 worker | saturate-50k | 81 | 6,633 | 11,495 | 893 |
| 1 worker | single-kiosk | 9 | 1,538 | 7,991 | 175 |
| 4 workers | saturate-50k | 124 | 10,409 | 45,032 | 451 |
| 4 workers | single-kiosk | 9 | 1,582 | 9,310 | 165 |

The patches cut the saturated p95 about 3.5x with one worker and raise throughput, but stay far above 300 ms;
four workers on the same shared host made things worse (CPU contention with the client and the database).
Neither patch is applied: both need review before they change the ingestion contract.

## Recommendations

1. Re-measure on separate hosts (client, API, database) before judging the 300 ms target; the CI job reports
   p95 without gating on it unless `enforce_p95` is set for exactly this reason.
2. Review and land `0002` (admission control) first: it bounds latency and protects the database under
   reconnect storms without changing stored data.
3. Rework the hot path (`0001` or equivalent): bulk inserts and validating each event once.
4. Consider smaller kiosk batches (for example 100 to 200 events) if the per-request p95 stays above target;
   ING-02 would then need re-wording with the PI.
5. Keep the exactly-once checks gating in CI: they caught no defects, and they are the property that must
   never regress.
