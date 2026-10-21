# Load run: reconnect-50k-backlog

- label: `baseline-durable-1w`
- scenario: `reconnect`
- options: `{'kiosks': 50, 'sessions_per_kiosk': 4, 'jitter_s': 2.0}`
- research_users: `0`
- finished_at: `2026-10-21T16:11:37+00:00`
- corpus: `shriii_simulator, 32 templates, mean 1618.1 B/event`
- plan: 50 kiosks, 200 sessions, 223273 unique events, 471 planned requests, batch bytes mean 766,033 (max 819,434)
- wall time 424.53 s, 1.3 req/s, 443.5 new events/s

## Checks

| Check | Target | Observed | Result |
|---|---|---|---|
| ing02_p95 | 300 | 58,523.1 | FAIL |
| terminal_failures | 0 | 0 | PASS |
| duplicate_rows | 0 | 0 | PASS |
| still_parked | 0 | 0 | PASS |
| exactly_once |  | 0 | PASS |

## Latency by request kind (HTTP 200 only, ms)

| Kind | Requests | p50 | p95 | p99 | max | retryable | dup-batch | errors |
|---|---|---|---|---|---|---|---|---|
| reconnect | 553 | 30,275.8 | 57,907.4 | 59,910.3 | 60,580.6 | 0 | 70 | 82 |

Full 500-event batches, first attempt: n=342, p50 31,975.3, p95 58,523.1, p99 60,044.3 ms.

Per-event statuses: `{'accepted': 223273}`

## Database verification

```
sessions: 200
expected_events: 223273
stored_rows: 223273
stored_distinct: 223273
duplicate_rows: 0
sessions_with_missing_events: 0
missing_events: 0
still_parked: 0
dead_letters: {}
dedup_states: {'accepted': 223273}
passed: True
examples: {'missing': {}, 'duplicated': {}}
```
