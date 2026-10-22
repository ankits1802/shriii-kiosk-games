# VAL-02: minimum trials per indicator

Status: measurement-science stream, October 2026. Plan item VAL-02 (6), input to the SCR-03 trial-time budget.
Companion document: [indicator-review.md](indicator-review.md) (estimators, never-scorable indicators, the
effort-discounting design).

This is a simulation study. It shows how reliability grows with the number of valid trials **if the simulator's
generative model is right**. It does not show that the games measure the traits, and every number here must be
re-estimated from Stage 1–2 data before it binds a game owner. Use it to rank where trial time buys the most
reliability, and to find indicators that no feasible session length can rescue.

## 1. Method

Code: `stats/simulator/src/shriii_simulator/val02.py`, `studies.py`; configuration (every threshold):
`stats/simulator/src/shriii_simulator/data/val02.yaml`.

1. Simulate two parallel occasions with identical latents (stability 1) per pathway: n = 500 persons, seed 11.
   Pathway B is simulated once per planned-missingness slot form that carries individual indicators
   (`wait_or_now`, `steady_hands`, `four_stalls`), so B rows pool up to 1 500 persons.
2. Score every indicator with the production engine at block fractions 0.25, 0.5, 0.75 and 1.0 (each scored block
   truncated to its first fraction of trials, i.e. what a shorter block would have delivered), and at design scale
   ×1 and ×2 (`design.scale` in `simulator.yaml` lengthens every scored block of the scalable modules).
   `min_valid_trials` is lowered to 1 so the curve is visible below the production minimums.
3. Per indicator and condition: parallel-form reliability (Spearman between occasions, the same statistic as the
   recovery harness), r with the planted latent, the strongest other latent, the model reliability and the median
   number of valid units.
4. Fit the Spearman-Brown curve `rel(n) = nρ / (1 + (n − 1)ρ)` by least squares on Fisher-z to the (median valid
   units, reliability) points. The minimum number of units for a target R is `R(1 − ρ) / (ρ(1 − R))`.
5. Convert units to time with the L2 seconds per trial of the indicator's selected blocks (`content/games/*.json`):
   seconds per valid unit = scheduled seconds / valid units the current schedule delivers.

**Verdicts** (target reliability .6; the .7 column is in the artifacts):

| Verdict | Meaning |
|---|---|
| `met_by_current_schedule` | The current schedule already delivers the units needed |
| `needs_more_trials` | Needs more units, at most 3× what the schedule delivers (`infeasible_factor`) |
| `infeasible_in_session` | Needs more than 3× the delivered units: demote, `research_only`, or redesign |
| `beyond_projection_range` | The requirement is more than 6× the largest observed unit count; no number reported |
| `no_reliable_signal` | Single-unit reliability ≤ .002: more trials of the same kind will not help |

**Extra seconds** is the added time at L2 pace for that indicator alone. Indicators scored from the same block share
that cost (e.g. `teamwork.interruptions` and `teamwork.turn_waiting`), so the costs do not add up across rows.

## 2. Where the results are

The full-size study runs in `.github/workflows/measurement-science.yml` (workflow_dispatch, nightly, or a PR
labelled `val02-full`) and uploads three artifacts: `val02-A`, `val02-B` and `val02-effort-designs`, each a JSON
document (curve points, ρ, Spearman-Brown RMSE, requirements, verdicts) plus Markdown tables. The numbers below come
from the run of 2026-10-21 on this branch (n = 500, scales ×1 and ×2). The smoke profile (`--profile local`, n = 40,
Pathway B only) runs on every PR and only checks that the study executes.

## 3. Summary

| Verdict at .6 | Pathway A (50 indicators) | Pathway B (44 indicators) |
|---|---|---|
| Met by current schedule | 14 | 18 |
| Needs more trials | 21 | 16 |
| Infeasible in session | 10 | 7 |
| Beyond projection range | 3 | 2 |
| No reliable signal | 2 | 1 |

* B is in better shape: most primary go/no-go, balloon, Tower and contribution indicators reach .6 now, and several
  have slack (e.g. `response_consistency.loc_scale_sigma` needs 25 of 73 delivered trials, `self_control.ezd_drift_nogo`
  22 of 72). Their dictionary minimums can stay; there is no case for cutting those blocks before Stage 2.
* A's narrative episodes deliver 2–3 units per indicator (maps, dilemmas, events). Many such indicators need 2–5×
  more episodes, which is a content decision, not a trial-count tweak.
* Difference scores and shift slopes (stability, composure accuracy, error-type shift, lag-1 autocorrelation,
  post-loss adjustment) are infeasible or have no signal on both pathways. This matches the risk register
  ("difference-score unreliability") and the indicator review §3.

## 4. Pathway B

**Met by the current schedule (extra seconds ≤ 0 at .6):** `teamwork.mean_contribution`, `decisiveness.time_to_commit`,
`decisiveness.time_to_collect`, `risk_preference.adjusted_pumps`, `self_control.nogo_commission_rate`,
`self_control.ezd_drift_nogo`, `response_consistency.loc_scale_sigma`, `expressive_restraint.premature_taps`,
`expressive_restraint.extra_taps`, `expressive_restraint.held_vs_free_slope`, `problem_solving.excess_moves`,
`problem_solving.planning_time`, `initiative.planning_time_before_first_move`, `adaptability.perseverative_errors`,
`self_control.delay_discount_logk`, `decisiveness.commit_rvi`, `persistence.give_up`, `persistence.time_on_unsolvable`.

**Cheapest top-ups (needs more trials):**

| Indicator | Min (dict) | Delivered | Rel now | Units for .6 | Extra s |
|---|---|---|---|---|---|
| `decisiveness.reversals_before_confirm` | 8 | 8 | .59 | 9 | +9 |
| `initiative.unprompted_share` | 8 | 8 | .57 | 9 | +9 |
| `self_control.effort_discount` | 4 | 4 | .49 | 6 | +10 |
| `adaptability.switch_cost_slope` | 20 | 28 | .55 | 33 | +13 |
| `composure.pressure_slope_rt` | 30 | 44 | .50 | 61 | +29 |
| `risk_preference.high_variance_stall_share` | 20 | 30 | .53 | 49 | +39 |
| `composure.distractor_slope` | 24 | 60 | .50 | 98 | +40 |
| `persistence_of_style.cross_segment_style_r` | 4 | 6 | .49 | 13 | +50 |
| `response_consistency.rt_rvi` | 30 | 36 | .37 | 100 | +68 |
| `adaptability.trials_to_reacquire` | 20 | 28 | .39 | 74 | +85 |
| `response_consistency.pump_rvi` | 10 | 12 | .44 | 26 | +91 |
| `teamwork.response_to_partner_defection` | 3 | 3 | .35 | 7 | +91 |
| `risk_preference.explosion_rate` | 15 | 16 | .39 | 35 | +92 |
| `task_organisation.illegal_move_attempts` | 4 | 4 | .34 | 11 | +133 |

`persistence.effort_completion_rate` and `expressive_restraint.iti_rvi` also fall here but are not gate-eligible
(see indicator review §5). For `self_control.effort_discount` the better fix is the titrated design (§6), which
costs the same +10–20 s and also removes the ceiling.

**Infeasible:** `composure.pressure_slope_accuracy` (263 trials for .6; the 11 no-go trials per pressure block carry
the effect), `stability.shift_slope`, `stability.shift_slope_pressure`, `stability.shift_slope_rule_switch`,
`response_consistency.choice_entropy_repeats`, `problem_solving.recovery_after_failure`,
`persistence_of_style.post_loss_adjustment`. **Beyond range / no signal:** `persistence_of_style.lag1_autocorr`,
`self_control.choice_consistency` (`not_scorable_v1`), `composure.error_type_shift`.

## 5. Pathway A

**Met by the current schedule:** `emotional_regulation.mirroring`, `emotional_regulation.tone_after_provocation`,
`emotional_regulation.drift_slope_difficult_run`, `decisiveness.time_to_commit`, `decisiveness.info_gathered`,
`decisiveness.reversals_before_confirm`, `problem_solving.excess_route_cost`, `problem_solving.replan_quality`,
`teamwork.mean_contribution`, `teamwork.coplay_credit_share`, `task_organisation.resource_allocation_efficiency`,
`self_control.ezd_drift_nogo`, `self_control.nogo_commission_rate`, `judgement.credit_taking`.

**Cheapest top-ups (needs more trials):**

| Indicator | Min (dict) | Delivered | Rel now | Units for .6 | Extra s |
|---|---|---|---|---|---|
| `response_consistency.rt_rvi` | 20 | 20 | .57 | 23 | +7 |
| `expressive_restraint.extra_taps` | 30 | 38 | .53 | 43 | +10 |
| `teamwork.interruptions`, `teamwork.turn_waiting` (shared turns) | 8 | 12 | .55 | 13 | +12 |
| `persistence.effort_completion_rate` | 4 | 4 | .45 | 8 | +14 |
| `response_consistency.loc_scale_sigma` | 40 | 58 | .54 | 62 | +18 |
| `expressive_restraint.premature_taps` | 30 | 38 | .59 | 47 | +19 |
| `task_organisation.idle_time` | 3 | 3 | .53 | 4 | +19 |
| `stability.shift_slope_rude_run` | 8 | 12 | .60 | 15 | +21 |
| `problem_solving.replan_latency` | 2 | 2 | .49 | 4 | +24 |
| `persistence_of_style.cross_segment_style_r` | 4 | 6 | .33 | 18 | +29 |
| `initiative.optional_actions_unprompted` | 4 | 5 | .46 | 8 | +34 |
| `adaptability.post_reversal_errors` | 10 | 12 | .35 | 21 | +36 |
| `initiative.route_planning_time` | 3 | 3 | .51 | 5 | +37 |
| `adaptability.rule_compliance_post_shift` | 6 | 7 | .44 | 15 | +43 |
| `persistence.retries_on_blocked_route` | 2 | 2 | .39 | 6 | +48 |
| `task_organisation.revisits` | 3 | 3 | .47 | 6 | +56 |
| `task_organisation.errand_order_efficiency` | 3 | 3 | .39 | 7 | +75 |
| `composure.pressure_slope_rt` | 20 | 26 | .30 | 69 | +129 |

`stability.shift_slope_rude_run` reaches .6 in parallel form but measures emotional regulation (r latent .17 against
.71 for emotional regulation), so more trials do not make it a stability indicator. The Road Home map indicators
(`task_organisation.*`, `initiative.route_planning_time`) share maps: one extra map (~19–37 s) lifts several at once.

**Infeasible:** `integrity.bribe_acceptance`, `integrity.overpayment_return`, `judgement.blame_shifting` (10 dilemmas
needed against 3 delivered), `adaptability.reversal_trials_to_reacquire`, `stability.shift_slope_reversal`,
`teamwork.response_to_partner_defection`, `response_consistency.choice_entropy_repeats`, and the non-gating
`risk_preference.gamble_rate`, `expressive_restraint.iti_rvi`, `decisiveness.commit_rvi`. **Beyond range / no
signal:** `emotional_regulation.recovery_after_feedback`, `judgement.consistency_across_dilemmas`,
`persistence_of_style.lag1_autocorr`, `composure.error_type_shift`, `composure.pressure_slope_accuracy`.

The single-dilemma integrity and judgement indicators are the main A gap. At 3 dilemmas each, they reach .31–.36.
The plan already treats them as a construct-level composite; reliability should be judged on that composite, which
VAL-02 does not model. They should not gate individually.

## 6. Effort-discounting design (Wait-or-Now)

Full-size design study (n = 400, two parallel occasions; `val02-effort-designs`):

| Design | Choices | r(est, true log k) | Parallel rel | Model rel | All hard |
|---|---|---|---|---|---|
| fixed4_v0 (5, 6, 8, 10) | 4 | .59 | .38 | .20 | 46% |
| fixed8_wide (2.5 … 12) | 8 | .76 | .57 | .51 | 3% |
| titrated4 | 4 | .60 | .45 | .06 | 2% |
| titrated6 | 6 | .68 | .52 | .13 | 1% |
| **titrated8** | 8 | **.81** | **.64** | .43 | 0% |
| titrated8, two staircases | 8 | .77 | .58 | .51 | 3% |
| titrated12, two staircases | 12 | .84 | .71 | .60 | 0% |

Recommendation (detail in indicator review §4): an 8-trial adjusting-amount staircase on the hard amount, +4 trials
≈ +20 s at L2. The model reliability of the single titrated staircase is lower than its parallel reliability because
the offers converge on the indifference point, where each choice is close to a coin flip. The parallel-form number is
the one that matters for ranking people.

## 7. Recommendations

1. **Do not lower any dictionary minimum below the current schedule** on the strength of this study; the B blocks
   that have slack are cheap and the slack protects against real-data noise the simulator does not have.
2. **Cheapest B top-ups (≈ +30 s in total):** 1 extra Weighing round (reversals before confirm, unprompted share),
   the titrated effort schedule (+20 s), and 5 card-sort post-switch trials (switch-cost slope).
3. **Cheapest A top-ups (≈ +45 s in total):** 1 extra Road Home map (idle time, revisits, route planning, errand
   order), 4 Stall service trials (RT RVI, extra and premature taps).
4. **Do not buy trials for** shift slopes, the composure accuracy slope, error-type shift, lag-1 autocorrelation,
   post-loss adjustment or choice entropy: they stay `research_only` / exploratory.
5. **A integrity and judgement:** keep as composites; report single-dilemma indicators descriptively only.
6. Re-run VAL-02 with Stage 1 pilot data (real ρ per indicator) before SCR-03 freezes the trial budget.

## 8. Limitations

* The simulator plants each indicator's signal; real indicators will be noisier and some will have no signal.
  Requirements here are lower bounds.
* Truncating blocks assumes the first trials behave like later ones (no warm-up or fatigue beyond what the simulator
  plants).
* Spearman-Brown assumes parallel units. For slopes and difference scores the fit is poor (see the SB RMSE column in
  the artifacts); treat those projections as indicative only.
* One seed. The standard error of a parallel-form reliability at n = 500 is about .03.

## 9. Reproducing

```bash
uv run python -m shriii_simulator.val02 --profile local --out .cache/val02   # smoke (~10 min, B only)
uv run python -m shriii_simulator.val02 --profile full  --out .cache/val02   # full (CI: ~35 min for B)
```
