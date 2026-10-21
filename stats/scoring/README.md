# shriii-scoring

Layer 2 (behavioural indicators), layer 3 (criterion scale scores) and the layer 5 band reference for the
SHRIII kiosk behavioural games. Pure Python; no web code.

```python
from shriii_scoring import IndicatorEngine, score_criterion

result = IndicatorEngine().score(events, trial_params)  # raw events -> indicator rows
rows = result.to_polars()  # indicators_long
wide = result.wide()  # analysis_wide (carries calibration_level)
scales = score_criterion(responses, attention_key=key)  # criterion-scale-score.v1 records
```

## What the engine does

1. **Canonicalise** (`canonical.py`): group events by `session_id`, order by `seq`, drop duplicate
   `event_id`s, record seq gaps / conflicts and `invalid` placeholders, assemble trials (events sharing
   `task.trial_id`), attach `context_shift` events to modules, join `GameTrialSpec.params` by
   `(session_id, trial_id)`. Output is invariant to input row order (tested).
2. **Quality** (`quality.py`, SCR-12): careless responding (RT < 150 ms runs, same position >= 90 %, zero
   variance), walkaway / abandonment, ASR confidence, timing flags, uncertified timing profile, possible
   assistance, repeat play, seq integrity -> `usable | caution | exclude`, `valid_for_validation`,
   `valid_for_report`; differential exclusion across groups. Private reports never feed these checks.
3. **Indicators**: for each dictionary indicator, select the task's trials (`conventions.TASKS`, blocks
   filtered by the dictionary `phases`), apply the listed exclusion rules (`exclusions.py`, generic
   evaluator of `shared.yaml` rules; latency-only rules mask latency instead of dropping the trial), run
   the registered formula (`formulas/`), enforce `min_valid_trials`, apply the transformation.
4. **Batch model step** per partition (`models.partition_keys`, default pathway x language x calibration
   level): person random slopes (REML LMM, `lmm.py`, parity-tested against statsmodels), hierarchical
   hyperbolic discounting (empirical-Bayes MAP), location-scale residual SD, cross-segment style
   correlations. Model-based reliability and posterior SDs are written.
5. **Group-level estimators** (private dice / luck tokens) go to `GroupIndicatorRow`s, which have no
   session or participant key (schema-level separation from individual tables). A group with fewer than
   `private_report.min_group_participants` participants (30) is suppressed (null estimate, flag
   `suppressed_small_group` in details) so that a "group" estimate can never describe one identifiable person.

Every `IndicatorRow` carries `scoring_run_id` (content-addressed), dictionary version + SHA-256, shared
dictionary SHA-256, parameter-file SHA-256, algorithm version, source event range and event-stream hash.
Rows from an unfrozen dictionary are labelled `exploratory`. `ScoringRunManifest` records git SHA, library
versions and BLAS/thread settings.

Row statuses: `ok`, `insufficient_trials`, `module_incomplete`, `planned_missing`, `not_applicable`
(substudy only), `module_absent`, `missing_context_shift` (error, never inferred), `group_only`,
`unscorable_individual` (single-event indicators), `session_excluded`, `model_failed`, `error`
(missing solver output when `on_missing_params="flag"`; the default raises).

## Thresholds

All thresholds come from YAML: `stats/measurement-model/dictionary/*.yaml`, `stats/measurement-model/gates.yaml` and the packaged
`data/scoring_params.yaml` (parameters not yet present in the frozen dictionary; each cites its source and
is a candidate for promotion at the next dictionary amendment).

## Event conventions the formulas rely on

The envelope schema fixes the event types; `conventions.py` fixes the closed vocabularies inside them.
The simulator emits exactly these; kiosk modules must too.

| Module | `trial_type` values | committed `response_value` | `GameTrialSpec.params` keys |
|---|---|---|---|
| dont_tap / stall (serving) | `go`, `nogo` | `serve`; withholding = timeout | `feedback` (`negative` marks scripted feedback) |
| card_sort | `sort` | `pile_1..4` | `rule`, `previous_rule`, `matches` (dimension -> pile) |
| balloon | `balloon` (pump events; collect = pump with `collected=true` + response `collect`) | `collect` | `risk_colour`, `explosion_point`, `max_pumps` |
| tower | `solvable`, `unsolvable` (move events) | `skip` | `problem_id`, `min_moves` / `cap_ms`, `skip_icon_ms` |
| share_pot / road_home fuel pot | `round` / `fuel_round` (contribution + partner_action events) | `contribute` | - |
| wait_or_now | `delay_choice`, `effort_choice` (+ `input.hold`) | `now`/`wait`, `easy`/`hard` | `ss_amount`, `ss_delay`, `ll_amount`, `ll_delay`; `easy_amount`, `easy_effort`, `hard_amount`, `hard_effort` |
| steady_hands | `target` (blocks `free`, `held`) | `tap` | `distractor` |
| four_stalls | `choice` | `stall_a..d` | `repeat_group_id`, `high_variance_stalls` |
| private_dice / luck tokens | `report` / `luck_token` (report events) | - | - |
| stall tone | `tone_choice` (`condition.customer_tone_level` 0-4) | `firm`/`neutral`/`warm` | - |
| weighing_post | `weigh_decision` (inspections = on-target taps on `*inspect_more`), `bribe`, `overpayment`, `assistant_mistake`, `fraud_found` (credit_allocation), `gamble_inspection` | `approve`/`warn`/`fine`, `accept`/`decline`, `return`/`keep`, `gamble`/`inspect` | `required_inspections`, `compliant_responses` |
| road_home | `errand_map` (route_step events), `optional_opportunity`, `fork_choice`, `blocked_route`, `effort_hold` | `take`, `left`/`right`, `fallback` | `map_id`, `optimal_order`, `optimal_cost`, `optimal_fuel`, `n_errands`; `mentioning_lines`; `rule_option`, `old_rule_option`; `post_block_optimal_cost` |
| coplay | `turn` (turn_event), `credit_round` (credit_allocation) | - | - |
| every module | `probe` (block `probe`, `task.probe_group_id` = segment) | `safe`/`risky` (+ `revisions`) | `repeat_group_id` |

`task.block_id` is `"<module_id>.<block_id>"`; `task.trial_index` counts every trial of the module from 0;
`context_shift.payload.shift_index` is the trial index of the first trial under the new condition.

## Dictionary / content inconsistencies reported at engine start

`IndicatorEngine.consistency_warnings` (also in every run manifest) lists task blocks whose content-config
phase is outside the dictionary `phases`. Where the dictionary phases match none of the task's blocks
(Weighing Post decisions and Road Home errand-map indicators declare `main`, but those blocks are
`shift_pre` / `shift_post`), all task blocks are used and rows carry `phase_mismatch_fallback`.
