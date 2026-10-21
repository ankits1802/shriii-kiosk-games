# Load run: single

- label: `smoke`
- scenario: `saturate`
- options: `{'kiosks': 1, 'sessions_per_kiosk': 3, 'encryption': 'none_dev', 'max_body_bytes': None, 'think_s': 5.0, 'copies': 10, 'storm_batches': 10, 'seed': 1}`
- research_users: `0`
- finished_at: `2026-10-21T15:29:38+00:00`
- corpus: `shriii_simulator, 32 templates, mean 1618.1 B/event`
- plan: 1 kiosks, 3 sessions, 3933 unique events, 8 planned requests, batch bytes mean 793,477 (max 812,404)
- wall time 31.22 s, 0.26 req/s, 126.0 new events/s

## Checks

| Check | Target | Observed | Result |
|---|---|---|---|
| ing02_p95 | 300 | 4,580.7 | FAIL |
| terminal_failures | 0 | 0 | PASS |
| duplicate_rows | 0 | 0 | PASS |
| still_parked | 0 | 0 | PASS |
| exactly_once |  | 0 | PASS |

## Latency by request kind (HTTP 200 only, ms)

| Kind | Requests | p50 | p95 | p99 | max | retryable | dup-batch | errors |
|---|---|---|---|---|---|---|---|---|
| fresh | 8 | 3,982.8 | 4,558.3 | 4,684.0 | 4,715.4 | 0 | 0 | 0 |

Full 500-event batches, first attempt: n=7, p50 4,060.1, p95 4,580.7, p99 4,688.4 ms.

Per-event statuses: `{'accepted': 3933}`

## Database verification

```
sessions: 3
expected_events: 3933
stored_rows: 3933
stored_distinct: 3933
duplicate_rows: 0
sessions_with_missing_events: 0
missing_events: 0
still_parked: 0
dead_letters: {}
dedup_states: {'accepted': 3933}
passed: True
examples: {'missing': {}, 'duplicated': {}}
```
