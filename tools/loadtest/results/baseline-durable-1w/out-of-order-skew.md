# Load run: out-of-order-skew

- label: `baseline-durable-1w`
- scenario: `out_of_order`
- options: `{'kiosks': 50, 'sessions_per_kiosk': 1}`
- research_users: `0`
- finished_at: `2026-10-21T16:00:53+00:00`
- corpus: `shriii_simulator, 32 templates, mean 1618.1 B/event`
- plan: 50 kiosks, 50 sessions, 58163 unique events, 146 planned requests, batch bytes mean 643,392 (max 811,407)
- wall time 492.5 s, 0.78 req/s, 46.2 new events/s

## Checks

| Check | Target | Observed | Result |
|---|---|---|---|
| ing02_p95 | 300 | 47,887.1 | FAIL |
| terminal_failures | 0 | 0 | PASS |
| duplicate_rows | 0 | 0 | PASS |
| still_parked | 0 | 0 | PASS |
| exactly_once |  | 0 | PASS |

## Latency by request kind (HTTP 200 only, ms)

| Kind | Requests | p50 | p95 | p99 | max | retryable | dup-batch | errors |
|---|---|---|---|---|---|---|---|---|
| out_of_order | 386 | 33,806.9 | 57,035.5 | 59,192.3 | 59,912.5 | 0 | 71 | 240 |

Full 500-event batches, first attempt: n=25, p50 38,322.4, p95 47,887.1, p99 52,373.2 ms.

Per-event statuses: `{'accepted': 26375, 'parked': 31788}`

## Database verification

```
sessions: 50
expected_events: 58163
stored_rows: 58163
stored_distinct: 58163
duplicate_rows: 0
sessions_with_missing_events: 0
missing_events: 0
still_parked: 0
dead_letters: {}
dedup_states: {'accepted': 58163}
passed: True
examples: {'missing': {}, 'duplicated': {}}
```
