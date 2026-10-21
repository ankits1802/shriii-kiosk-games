# Load run: mixed-research

- label: `baseline-durable-1w`
- scenario: `steady`
- options: `{'kiosks': 50, 'sessions_per_kiosk': 1, 'think_s': 3.0}`
- research_users: `10`
- finished_at: `2026-10-21T16:14:08+00:00`
- corpus: `shriii_simulator, 32 templates, mean 1618.1 B/event`
- plan: 50 kiosks, 50 sessions, 57907 unique events, 143 planned requests, batch bytes mean 654,182 (max 811,407)
- wall time 127.75 s, 1.45 req/s, 288.9 new events/s

## Checks

| Check | Target | Observed | Result |
|---|---|---|---|
| ing02_p95 | 300 | 56,220.0 | FAIL |
| terminal_failures | 0 | 0 | PASS |
| duplicate_rows | 0 | 0 | PASS |
| still_parked | 0 | 0 | PASS |
| exactly_once |  | 0 | PASS |
| research_p95 | 800 | 19,620.1 | FAIL |

## Latency by request kind (HTTP 200 only, ms)

| Kind | Requests | p50 | p95 | p99 | max | retryable | dup-batch | errors |
|---|---|---|---|---|---|---|---|---|
| fresh | 185 | 14,738.7 | 52,208.0 | 57,837.2 | 59,681.1 | 0 | 42 | 42 |

Full 500-event batches, first attempt: n=51, p50 24,653.7, p95 56,220.0, p99 58,821.4 ms.

Per-event statuses: `{'accepted': 57907}`

## Research API (ms)

| Route | Requests | p50 | p95 | p99 | errors |
|---|---|---|---|---|---|
| /api/v1/assessment-responses/scores | 15 | 101.0 | 54,760.2 | 55,447.2 | 0 |
| /api/v1/features/matrix | 22 | 90.8 | 46,825.3 | 49,973.8 | 0 |
| /api/v1/sessions | 59 | 97.5 | 14,691.8 | 53,626.4 | 0 |
| /api/v1/sessions/{session_id} | 41 | 162.3 | 13,930.2 | 18,279.1 | 0 |
| /api/v1/sessions/{session_id}/events | 19 | 335.2 | 7,334.7 | 12,127.1 | 0 |
| /api/v1/sessions/{session_id}/quality-flags | 24 | 241.5 | 18,379.6 | 20,830.7 | 1 |
| /api/v1/sessions/{session_id}/trials | 13 | 483.4 | 14,970.8 | 18,289.8 | 0 |
| /api/v1/studies | 15 | 97.2 | 9,493.5 | 9,698.3 | 1 |
| /api/v1/validation/datasets | 16 | 1,611.8 | 46,615.4 | 52,174.1 | 0 |

## Database verification

```
sessions: 50
expected_events: 57907
stored_rows: 57907
stored_distinct: 57907
duplicate_rows: 0
sessions_with_missing_events: 0
missing_events: 0
still_parked: 0
dead_letters: {}
dedup_states: {'accepted': 57907}
passed: True
examples: {'missing': {}, 'duplicated': {}}
```
