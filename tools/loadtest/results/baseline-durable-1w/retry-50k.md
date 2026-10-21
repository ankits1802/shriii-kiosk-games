# Load run: retry-50k

- label: `baseline-durable-1w`
- scenario: `retry`
- options: `{'kiosks': 50, 'sessions_per_kiosk': 1, 'think_s': 2.0}`
- research_users: `0`
- finished_at: `2026-10-21T15:47:07+00:00`
- corpus: `shriii_simulator, 32 templates, mean 1618.1 B/event`
- plan: 50 kiosks, 50 sessions, 57907 unique events, 184 planned requests, batch bytes mean 653,859 (max 811,407)
- wall time 106.92 s, 1.72 req/s, 594.0 new events/s

## Checks

| Check | Target | Observed | Result |
|---|---|---|---|
| ing02_p95 | 300 | 46,050.7 | FAIL |
| terminal_failures | 0 | 0 | PASS |
| duplicate_rows | 0 | 0 | PASS |
| still_parked | 0 | 0 | PASS |
| exactly_once |  | 0 | PASS |

## Latency by request kind (HTTP 200 only, ms)

| Kind | Requests | p50 | p95 | p99 | max | retryable | dup-batch | errors |
|---|---|---|---|---|---|---|---|---|
| fresh | 143 | 28,145.6 | 43,103.0 | 49,310.6 | 50,305.2 | 0 | 0 | 0 |
| repacked | 15 | 12,313.3 | 25,967.6 | 25,979.0 | 25,981.9 | 0 | 0 | 0 |
| retry_same_id | 26 | 11,264.7 | 22,605.0 | 26,529.5 | 27,412.9 | 0 | 26 | 0 |

Full 500-event batches, first attempt: n=101, p50 32,132.1, p95 46,050.7, p99 50,155.9 ms.

Per-event statuses: `{'accepted': 68878, 'duplicate': 5607}`

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
