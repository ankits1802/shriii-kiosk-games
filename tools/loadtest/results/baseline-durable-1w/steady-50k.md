# Load run: steady-50k

- label: `baseline-durable-1w`
- scenario: `steady`
- options: `{'kiosks': 50, 'sessions_per_kiosk': 1, 'think_s': 3.0}`
- research_users: `0`
- finished_at: `2026-10-21T15:41:05+00:00`
- corpus: `shriii_simulator, 32 templates, mean 1618.1 B/event`
- plan: 50 kiosks, 50 sessions, 57907 unique events, 143 planned requests, batch bytes mean 654,182 (max 811,407)
- wall time 58.75 s, 2.43 req/s, 985.6 new events/s

## Checks

| Check | Target | Observed | Result |
|---|---|---|---|
| ing02_p95 | 300 | 25,515.4 | FAIL |
| terminal_failures | 0 | 0 | PASS |
| duplicate_rows | 0 | 0 | PASS |
| still_parked | 0 | 0 | PASS |
| exactly_once |  | 0 | PASS |

## Latency by request kind (HTTP 200 only, ms)

| Kind | Requests | p50 | p95 | p99 | max | retryable | dup-batch | errors |
|---|---|---|---|---|---|---|---|---|
| fresh | 143 | 16,495.0 | 24,741.3 | 28,178.3 | 29,448.3 | 0 | 0 | 0 |

Full 500-event batches, first attempt: n=93, p50 19,535.5, p95 25,515.4, p99 28,920.4 ms.

Per-event statuses: `{'accepted': 57907}`

## Database verification

```
sessions: 50
expected_events: 57907
stored_rows: 57907
stored_distinct: 57907
duplicate_rows: 0
sessions_with_missing_events: 0
missing_events: 0
still_parked: 0
dead_letters: {}
dedup_states: {'accepted': 57907}
passed: True
examples: {'missing': {}, 'duplicated': {}}
```
