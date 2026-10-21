# Load run: saturate-50k-sealed

- label: `baseline-durable-1w`
- scenario: `saturate`
- options: `{'kiosks': 50, 'sessions_per_kiosk': 1, 'encryption': 'sealed', 'max_body_bytes': 1048576}`
- research_users: `0`
- finished_at: `2026-10-21T15:44:54+00:00`
- corpus: `shriii_simulator, 32 templates, mean 1618.1 B/event`
- plan: 50 kiosks, 50 sessions, 54450 unique events, 226 planned requests, batch bytes mean 519,440 (max 985,750)
- wall time 216.71 s, 1.21 req/s, 208.8 new events/s

## Checks

| Check | Target | Observed | Result |
|---|---|---|---|
| ing02_p95 | 300 | n/a | FAIL |
| terminal_failures | 0 | 0 | PASS |
| duplicate_rows | 0 | 0 | PASS |
| still_parked | 0 | 0 | PASS |
| exactly_once |  | 0 | PASS |

## Latency by request kind (HTTP 200 only, ms)

| Kind | Requests | p50 | p95 | p99 | max | retryable | dup-batch | errors |
|---|---|---|---|---|---|---|---|---|
| fresh | 262 | 35,216.6 | 56,792.7 | 58,898.2 | 59,749.1 | 0 | 34 | 36 |

Full 500-event batches, first attempt: n=0, p50 n/a, p95 n/a, p99 n/a ms.

Per-event statuses: `{'accepted': 54450}`

## Database verification

```
sessions: 50
expected_events: 54450
stored_rows: 54450
stored_distinct: 54450
duplicate_rows: 0
sessions_with_missing_events: 0
missing_events: 0
still_parked: 0
dead_letters: {}
dedup_states: {'accepted': 54450}
passed: True
examples: {'missing': {}, 'duplicated': {}}
```
