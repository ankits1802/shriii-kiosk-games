# Load run: saturate-50k

- label: `baseline-durable-1w`
- scenario: `saturate`
- options: `{'kiosks': 50, 'sessions_per_kiosk': 2}`
- research_users: `0`
- finished_at: `2026-10-21T15:39:09+00:00`
- corpus: `shriii_simulator, 32 templates, mean 1618.1 B/event`
- plan: 50 kiosks, 100 sessions, 110900 unique events, 245 planned requests, batch bytes mean 731,522 (max 816,261)
- wall time 260.8 s, 1.12 req/s, 342.8 new events/s

## Checks

| Check | Target | Observed | Result |
|---|---|---|---|
| ing02_p95 | 300 | 58,108.7 | FAIL |
| terminal_failures | 0 | 0 | PASS |
| duplicate_rows | 0 | 0 | PASS |
| still_parked | 0 | 0 | PASS |
| exactly_once |  | 0 | PASS |

## Latency by request kind (HTTP 200 only, ms)

| Kind | Requests | p50 | p95 | p99 | max | retryable | dup-batch | errors |
|---|---|---|---|---|---|---|---|---|
| fresh | 291 | 37,179.7 | 56,372.3 | 59,585.3 | 59,834.9 | 0 | 43 | 46 |

Full 500-event batches, first attempt: n=151, p50 43,082.6, p95 58,108.7, p99 59,675.5 ms.

Per-event statuses: `{'accepted': 110900}`

## Database verification

```
sessions: 100
expected_events: 110900
stored_rows: 110900
stored_distinct: 110900
duplicate_rows: 0
sessions_with_missing_events: 0
missing_events: 0
still_parked: 0
dead_letters: {}
dedup_states: {'accepted': 110900}
passed: True
examples: {'missing': {}, 'duplicated': {}}
```
