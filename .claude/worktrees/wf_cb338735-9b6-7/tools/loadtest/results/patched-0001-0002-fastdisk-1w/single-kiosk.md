# Load run: single-kiosk

- label: `patched-0001-0002-fastdisk-1w`
- scenario: `saturate`
- options: `{'kiosks': 1, 'sessions_per_kiosk': 4}`
- research_users: `0`
- finished_at: `2026-10-21T17:03:19+00:00`
- corpus: `shriii_simulator, 32 templates, mean 1618.1 B/event`
- plan: 1 kiosks, 4 sessions, 4750 unique events, 10 planned requests, batch bytes mean 767,638 (max 813,451)
- wall time 27.18 s, 0.37 req/s, 174.8 unique events/s stored (responses reported 174.8 new events/s)

## Checks

| Check | Target | Observed | Result |
|---|---|---|---|
| ing02_p95 | 300 | 7,990.7 | FAIL |
| terminal_failures | 0 | 0 | PASS |
| duplicate_rows | 0 | 0 | PASS |
| still_parked | 0 | 0 | PASS |
| exactly_once |  | 0 | PASS |

## Latency by request kind (HTTP 200 only, ms)

| Kind | Requests | p50 | p95 | p99 | max | retryable | dup-batch | errors |
|---|---|---|---|---|---|---|---|---|
| fresh | 10 | 1,475.3 | 7,897.9 | 8,566.1 | 8,733.2 | 0 | 0 | 0 |

Full 500-event batches, first attempt: n=9, p50 1,538.3, p95 7,990.7, p99 8,584.7 ms.

Per-event statuses: `{'accepted': 4750}`

## Database verification

```
sessions: 4
expected_events: 4750
stored_rows: 4750
stored_distinct: 4750
duplicate_rows: 0
sessions_with_missing_events: 0
missing_events: 0
still_parked: 0
dead_letters: {}
dedup_states: {'accepted': 4750}
passed: True
examples: {'missing': {}, 'duplicated': {}}
```
