# Load run: reconnect-50k-backlog

- label: `baseline-fastdisk-1w`
- scenario: `reconnect`
- options: `{'kiosks': 50, 'sessions_per_kiosk': 4, 'jitter_s': 2.0}`
- research_users: `0`
- finished_at: `2026-10-21T16:27:28+00:00`
- corpus: `shriii_simulator, 32 templates, mean 1618.1 B/event`
- plan: 50 kiosks, 200 sessions, 223273 unique events, 471 planned requests, batch bytes mean 766,033 (max 819,434)
- wall time 480.49 s, 1.2 req/s, 464.7 unique events/s stored (responses reported 375.3 new events/s)

## Checks

| Check | Target | Observed | Result |
|---|---|---|---|
| ing02_p95 | 300 | 56,982.6 | FAIL |
| terminal_failures | 0 | 0 | PASS |
| duplicate_rows | 0 | 0 | PASS |
| still_parked | 0 | 0 | PASS |
| exactly_once |  | 0 | PASS |

## Latency by request kind (HTTP 200 only, ms)

| Kind | Requests | p50 | p95 | p99 | max | retryable | dup-batch | errors |
|---|---|---|---|---|---|---|---|---|
| reconnect | 575 | 32,737.4 | 56,453.8 | 58,263.1 | 59,524.3 | 0 | 86 | 104 |

Full 500-event batches, first attempt: n=329, p50 41,749.8, p95 56,982.6, p99 58,372.5 ms.

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
