# Load run: saturate-50k

- label: `baseline-fastdisk-1w`
- scenario: `saturate`
- options: `{'kiosks': 50, 'sessions_per_kiosk': 2}`
- research_users: `0`
- finished_at: `2026-10-21T16:18:07+00:00`
- corpus: `shriii_simulator, 32 templates, mean 1618.1 B/event`
- plan: 50 kiosks, 100 sessions, 110900 unique events, 245 planned requests, batch bytes mean 731,522 (max 816,261)
- wall time 155.06 s, 1.63 req/s, 715.2 unique events/s stored (responses reported 692.6 new events/s)

## Checks

| Check | Target | Observed | Result |
|---|---|---|---|
| ing02_p95 | 300 | 40,416.9 | FAIL |
| terminal_failures | 0 | 0 | PASS |
| duplicate_rows | 0 | 0 | PASS |
| still_parked | 0 | 0 | PASS |
| exactly_once |  | 0 | PASS |

## Latency by request kind (HTTP 200 only, ms)

| Kind | Requests | p50 | p95 | p99 | max | retryable | dup-batch | errors |
|---|---|---|---|---|---|---|---|---|
| fresh | 252 | 29,804.3 | 38,369.0 | 54,356.2 | 57,397.6 | 0 | 7 | 7 |

Full 500-event batches, first attempt: n=188, p50 30,844.0, p95 40,416.9, p99 56,530.2 ms.

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
