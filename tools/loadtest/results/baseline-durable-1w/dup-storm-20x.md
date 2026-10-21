# Load run: dup-storm-20x

- label: `baseline-durable-1w`
- scenario: `dup_storm`
- options: `{'kiosks': 20, 'storm_batches': 20, 'copies': 10}`
- research_users: `0`
- finished_at: `2026-10-21T15:51:30+00:00`
- corpus: `shriii_simulator, 32 templates, mean 1618.1 B/event`
- plan: 20 kiosks, 20 sessions, 23348 unique events, 438 planned requests, batch bytes mean 649,846 (max 811,474)
- wall time 225.73 s, 4.39 req/s, 1036.0 new events/s

## Checks

| Check | Target | Observed | Result |
|---|---|---|---|
| ing02_p95 | 300 | 58,235.2 | FAIL |
| terminal_failures | 0 | 0 | PASS |
| duplicate_rows | 0 | 0 | PASS |
| still_parked | 0 | 0 | PASS |
| exactly_once |  | 0 | PASS |

## Latency by request kind (HTTP 200 only, ms)

| Kind | Requests | p50 | p95 | p99 | max | retryable | dup-batch | errors |
|---|---|---|---|---|---|---|---|---|
| fresh | 38 | 10,845.7 | 37,370.2 | 43,790.6 | 47,451.6 | 0 | 0 | 0 |
| storm | 352 | 52,149.3 | 58,933.9 | 59,334.4 | 59,758.5 | 3 | 187 | 149 |
| storm_repacked | 602 | 42,569.2 | 58,353.2 | 59,990.5 | 61,375.3 | 257 | 32 | 145 |

Full 500-event batches, first attempt: n=163, p50 52,261.1, p95 58,235.2, p99 58,837.8 ms.

Per-event statuses: `{'retryable': 130000, 'accepted': 104348, 'duplicate': 109000}`

## Database verification

```
sessions: 20
expected_events: 23348
stored_rows: 23348
stored_distinct: 23348
duplicate_rows: 0
sessions_with_missing_events: 0
missing_events: 0
still_parked: 0
dead_letters: {}
dedup_states: {'accepted': 23348}
passed: True
examples: {'missing': {}, 'duplicated': {}}
```
