# Load run: saturate

- label: `smoke`
- scenario: `saturate`
- options: `{'kiosks': 5, 'sessions_per_kiosk': 1, 'encryption': 'none_dev', 'max_body_bytes': None, 'think_s': 5.0, 'copies': 10, 'storm_batches': 10, 'seed': 1}`
- research_users: `0`
- finished_at: `2026-10-21T15:28:24+00:00`
- corpus: `shriii_simulator, 32 templates, mean 1618.1 B/event`
- plan: 5 kiosks, 5 sessions, 5197 unique events, 13 planned requests, batch bytes mean 646,585 (max 810,357)
- wall time 10.32 s, 1.26 req/s, 503.5 new events/s

## Checks

| Check | Target | Observed | Result |
|---|---|---|---|
| ing02_p95 | 300 | 4,215.9 | FAIL |
| terminal_failures | 0 | 0 | PASS |
| duplicate_rows | 0 | 0 | PASS |
| still_parked | 0 | 0 | PASS |
| exactly_once |  | 0 | PASS |

## Latency by request kind (HTTP 200 only, ms)

| Kind | Requests | p50 | p95 | p99 | max | retryable | dup-batch | errors |
|---|---|---|---|---|---|---|---|---|
| fresh | 13 | 3,700.3 | 4,215.1 | 4,216.7 | 4,217.1 | 0 | 0 | 0 |

Full 500-event batches, first attempt: n=8, p50 4,020.5, p95 4,215.9, p99 4,216.9 ms.

Per-event statuses: `{'accepted': 5197}`

## Database verification

```
sessions: 5
expected_events: 5197
stored_rows: 5197
stored_distinct: 5197
duplicate_rows: 0
sessions_with_missing_events: 0
missing_events: 0
still_parked: 0
dead_letters: {}
dedup_states: {'accepted': 5197}
passed: True
examples: {'missing': {}, 'duplicated': {}}
```
