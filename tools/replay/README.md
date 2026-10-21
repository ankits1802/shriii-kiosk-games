# Session replay and reproducibility check (ING-07, SCR-13)

Definition of done #2 of the spec: *every scored indicator is reconstructable from versioned raw events.*
`shriii-replay` takes the raw events of one session and runs these steps:

1. **Loads** NDJSON events, a JSON array, or development `UploadBatch` documents (one, an array or
   NDJSON). Plain `none_dev` chunks are read; encrypted chunks must be decrypted first.
2. **Validates** every event against the canonical contracts (read-only). Checks: jsonschema
   (`--mode strict` writer profile or `reader` tolerant profile), the Pydantic models
   (`shriii_contracts.parse_event`) and the semantic invariants (`check_event_invariants`). For each batch
   it checks the schema, the JCS `sha256` of `session_chunks`, `first_seq`/`last_seq`/`event_count`, and
   the session id.
3. **Checks the sequence**: gapless `seq` from 0, no conflicting `seq`, a single session, non-decreasing
   `t_mono_ms`, `session_start` first and `session_end` last. Exact re-sends are dropped as the
   ingestion API does.
4. **Rebuilds the trial timeline**: modules, trials (phase, type, stimulus, outcome, scorable, timing
   flags), stimulus onsets, prompt audio ends, responses (input mode, logged and re-derived latency,
   barge-in), context shifts, walkaway / idle / invalid markers and state changes.
5. **Re-runs the indicator engine** (`shriii_scoring.IndicatorEngine`, read-only). It compares with
   stored values within 1e-8 (plan section 7.10) and checks provenance (`dictionary_sha256`,
   `shared_sha256`, `params_sha256`, `algorithm_version`, `event_stream_sha256`). Without stored values it
   checks determinism instead (two independent runs). The report also carries `raw_events_sha256`, a JCS
   hash of the ordered events that covers payloads. The engine's `event_stream_sha256` hashes only event
   ids and `seq`.
6. **Renders** a self-contained HTML timeline (no scripts or network assets) and a JSON report.

```
uv run shriii-replay fixture --pathway B --seed 11 --out fx         # simulator fixture session
uv run shriii-replay check fx/events.ndjson --trial-params fx/trial_params.json \
    --stored fx/stored_indicators.json --html replay.html --json report.json
uv run shriii-replay check fx/upload_batches.json --trial-params fx/trial_params.json \
    --stored fx/stored_indicators.json --partition-events fx/partition_events.ndjson
uv run shriii-replay score fx/events.ndjson --trial-params fx/trial_params.json --out indicators.json
```

Exit codes: 0 valid and reproducible; 1 usage or input error; 2 contract or sequence errors; 3 valid
but not reproducible.

## Partition-dependent indicators

Session formulas depend only on the session's own events, so they must reproduce exactly. Two kinds of
value depend on the other sessions of the scoring partition (pathway x language x calibration level):

* batch-model formulas (person random slopes, hierarchical discounting, location-scale);
* the `z_within_level_language` transformation.

These are reported as `partition_dependent`, not as mismatches, unless the input holds the whole
partition (`--partition-events`). In that case they are compared like the others.

## Inputs

* `--trial-params`: `GameTrialSpec.params`, either as `session_id -> trial_id -> params` or as
  `trial_id -> params` for one session. Without it, formulas that need solver output report
  `status=error` (`missing_trial_params`) instead of failing.
* `--stored`: indicator rows as written by `ScoringResult.to_records()` (a JSON array, `{"rows": [...]}`,
  or NDJSON). Rows need `indicator_id`, `value` and `status`; the provenance columns are checked when present.

## Tests

`tests/test_replay.py` generates sessions with `stats/simulator` (Pathway A and B) and scores them with the
real engine. Scenarios covered:

* clean sessions reproduce, with matching dictionary sha;
* batch indicators become comparable with the full partition;
* tampered latencies, a wrong dictionary sha, an edited stored value, a seq gap, a seq conflict, a schema
  violation, a broken invariant, a bad batch hash and a bad chunk range are each detected;
* re-sends are deduplicated;
* the timeline has shifts and consistent latencies;
* the HTML is self-contained and links indicators to trials;
* the narrowed per-event-type validator agrees with the full envelope schema;
* the CLI works end to end.

CI: `.github/workflows/tools-timing-replay.yml`.
