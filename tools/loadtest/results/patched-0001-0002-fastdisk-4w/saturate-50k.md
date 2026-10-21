# Load run: saturate-50k

- label: `patched-0001-0002-fastdisk-4w`
- scenario: `saturate`
- options: `{'kiosks': 50, 'sessions_per_kiosk': 2}`
- research_users: `0`
- finished_at: `2026-10-21T17:22:28+00:00`
- corpus: `shriii_simulator, 32 templates, mean 1618.1 B/event`
- plan: 50 kiosks, 100 sessions, 110900 unique events, 245 planned requests, batch bytes mean 731,522 (max 816,261)
- wall time 245.93 s, 1.72 req/s, 450.9 unique events/s stored (responses reported 446.9 new events/s)

## Checks

| Check | Target | Observed | Result |
|---|---|---|---|
| ing02_p95 | 300 | 45,032.2 | FAIL |
| terminal_failures | 0 | 0 | PASS |
| duplicate_rows | 0 | 0 | PASS |
| still_parked | 0 | 0 | PASS |
| exactly_once |  | 0 | PASS |

## Latency by request kind (HTTP 200 only, ms)

| Kind | Requests | p50 | p95 | p99 | max | retryable | dup-batch | errors |
|---|---|---|---|---|---|---|---|---|
| fresh | 423 | 12,701.1 | 39,330.8 | 45,791.5 | 58,889.2 | 0 | 2 | 178 |

Full 500-event batches, first attempt: n=124, p50 10,408.9, p95 45,032.2, p99 47,654.9 ms.

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
