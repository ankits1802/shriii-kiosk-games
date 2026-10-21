# Load run: saturate-50k

- label: `patched-0001-0002-fastdisk-1w`
- scenario: `saturate`
- options: `{'kiosks': 50, 'sessions_per_kiosk': 2}`
- research_users: `0`
- finished_at: `2026-10-21T17:06:24+00:00`
- corpus: `shriii_simulator, 32 templates, mean 1618.1 B/event`
- plan: 50 kiosks, 100 sessions, 110900 unique events, 245 planned requests, batch bytes mean 731,522 (max 816,261)
- wall time 124.2 s, 4.44 req/s, 892.9 unique events/s stored (responses reported 892.9 new events/s)

## Checks

| Check | Target | Observed | Result |
|---|---|---|---|
| ing02_p95 | 300 | 11,495.2 | FAIL |
| terminal_failures | 0 | 0 | PASS |
| duplicate_rows | 0 | 0 | PASS |
| still_parked | 0 | 0 | PASS |
| exactly_once |  | 0 | PASS |

## Latency by request kind (HTTP 200 only, ms)

| Kind | Requests | p50 | p95 | p99 | max | retryable | dup-batch | errors |
|---|---|---|---|---|---|---|---|---|
| fresh | 551 | 6,667.8 | 11,574.9 | 15,694.0 | 16,105.5 | 0 | 0 | 306 |

Full 500-event batches, first attempt: n=81, p50 6,633.0, p95 11,495.2, p99 15,708.2 ms.

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
