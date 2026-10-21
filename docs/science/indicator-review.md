# Indicator review: estimators, never-scorable indicators and design problems

Status: measurement-science stream, October 2026. Inputs: the wave-1 verifier findings, the parameter-recovery
harness (`stats/simulator/src/shriii_simulator/recovery.py`) and the VAL-02 study
([VAL-02-trial-requirements.md](VAL-02-trial-requirements.md)). Recovery on simulated players shows whether the
scoring pipeline gets back what the simulator planted. It is not evidence that the games measure the traits. Only
Stages 2–5 can show that.

Unless a table says otherwise, the numbers come from two parallel occasions with identical latents (stability 1),
seed 11. **r latent** is the Spearman correlation between the occasion-1 estimate and the planted latent of the
indicator's construct. **Parallel rel** is the Spearman correlation between the two occasions. **Model rel** is the
partition's model-based reliability, `1 − mean(posterior variance) / τ²`. **Strongest other latent** is the other
construct the estimate correlates with most, which shows contamination.

## 1. Summary of changes

| Area | Finding | Change | Effect |
|---|---|---|---|
| Composure accuracy slope | The linear-probability mixed model (LPM) had no trial-type term, so near-ceiling go trials diluted the slope and the slope tracked RT-tail variability | Laplace logistic mixed model (`stats/scoring/src/shriii_scoring/glmm.py`) with trial type as a fixed effect is now the default (`models.binary_outcome_model: logistic_glmm`) | B: r latent .30 → .47 (n = 200). Contamination by response consistency .50 → .30. See §2 |
| Stability shift slopes | Model rel 0–.45, r latent ≤ .30 (B) and ≈ 0 (A) | Early-window contrast option (`models.shift_window_trials`, default unchanged). Longer blocks quantified | No estimator rescues them. The simulator plants little stability signal, and shift performance is dominated by adaptability and emotional regulation. See §3 |
| Effort discounting log k (B) | Model rel .05–.20: 4 fixed offers, about 46% of players choose "hard" every time | Simulator supports a titrated (adjusting-amount) schedule; design study across 7 schedules | An 8-trial staircase brings parallel rel from .38 to .64 and r with true log k from .59 to .81 (+20 s). See §4 |
| Never-scorable indicators | 5 indicators (7 pathway entries) never produced a value | 4 fixed by event mapping or minimum; 2 marked `not_scorable_v1` | See §5 |
| EZ-diffusion drift (no-go) | r latent .48 against parallel rel .83; correlates .73 with response consistency | Reported only | See §6 |

## 2. Composure: accuracy under pressure (logistic vs linear-probability mixed model)

**Problem.** `hier.pressure_slope_accuracy` fitted `correct ~ pressure + position + (1 + pressure | person)` as a
linear-probability model. Go trials make up 70% of the rows and are about 98% correct whatever the condition. The
no-go trials carry the composure effect in the simulator (`gng.commission_pressure_composure`), and the LPM gives
them no more weight than the near-certain go trials. Go accuracy under pressure is also driven by omissions when
slow RTs overrun the shorter window. People with long ex-Gaussian tails (low response consistency) lose more go
trials under pressure. The v0 slope was therefore stable but measured the wrong construct.

**Estimator.** `glmm.py` fits `logit P(correct) = x'β + b0 + b1·pressure` with `(b0, b1) ~ N(0, G)` by the Laplace
approximation. This is lme4's `nAGQ = 0` scheme: fixed effects and spherical random effects are found jointly by
PIRLS with a Schur complement over per-person 2 × 2 blocks, and the Laplace deviance is minimised over the Cholesky
factor of `G`. The u-parametrisation keeps a singular `G` finite. Person estimates are the fixed slope plus the
conditional mode, and their conditional SDs give the model reliability. The R backend design
(`stats/r-psychometrics/R/glmm.R`, `person_random_slopes`, read-only here) fits the same model with
`lme4::glmer(..., (1 + cond | person))` (Laplace, `nAGQ = 1`, which also optimises β in the outer loop), with an
optional `(1 | item)` term and the same `1 − mean(PEV)/τ²` reliability. The two should agree to Laplace-approximation
error. Parity is to be checked when the R image runs in CI, because R cannot run locally. Unit tests
(`stats/scoring/tests/test_glmm.py`) check recovery of fixed effects and slope variance, and check that GLMM slopes
recover at least as well as LPM slopes on ceiling-heavy data.

**Results** (Pathway B, n = 200, steady-hands slot form; v0 row from the n = 200 baseline recovery run):

| Variant | r latent | Parallel rel | Model rel | Strongest other latent |
|---|---|---|---|---|
| v0: LPM, no trial-type term | .30 | .36 | .46 | — |
| LPM + trial type | .41 | .65 | .46 | response consistency (.50) |
| **Logistic GLMM + trial type (new default)** | **.47** | .29 | .26 | composure first; response consistency .30 |
| Logistic GLMM, no-go trials only | .35 | unstable | .17 | self-control (.23) |

The LPM's higher parallel reliability is the problem, not a virtue: it is reliable variance from the wrong construct.
On the logit scale the slope is about 50% more valid (r .47 vs .30) and less contaminated. It is still short of the
plan criterion `r ≥ √rel − .05`, because each pressure block has only 11 no-go trials. Pathway A has 6 + 5 no-go
trials around the timed rush, and recovery stays near zero under every estimator (r ≤ .06). VAL-02 gives the trial
counts that would be needed.

**Full-size check** (VAL-02, n = 500, three B slot forms pooled). B: GLMM r .48 / parallel rel .31 / model rel .21,
strongest other latent stability (.26); LPM + trial type .41 / .58 / .41 with response consistency at .44. The
ordering is unchanged. A: no variant recovers composure (r −.10 to .08), and the GLMM's parallel reliability is
negative (−.39) because with 6 + 5 no-go trials most person slopes sit at the boundary of the logit scale. VAL-02
classes the A accuracy slope as `no_reliable_signal`.

**Recommendation.** Keep the GLMM. Report the A accuracy slope as `research_only` unless the Stall adds no-go trials
around the rush (proposal in VAL-02 §5). Keep composure gating on the RT slope, which recovers well (B r .75, A .70).

## 3. Stability: shift slopes

**Problem.** Model reliabilities of the shift slopes were 0–.45 and recovery was weak (B r .13–.30; A r ≈ 0–.21).

**What the simulator plants.** Stability enters the generative model only through small terms:
`card_sort.shift_lapse_stability` (early post-shift lapses), `perseveration_stability` (.3 against 1.1 for
adaptability), `gng.commission_pressure_stability` (.15), `weighing.compliance_stability` (.25 against .8 for
adaptability), and the Road Home reversal perseveration (.3 against 1.1). Post-shift performance is therefore mainly
adaptability (rule shifts) or emotional regulation (rude customers). A shift slope that is reliable in a parallel-form
sense still measures those constructs. The rude-run slope, now scorable (§5), has parallel rel .60 but r latent .17
(VAL-02 full size), and its strongest other latent is emotional regulation (.71).

**Estimators compared** (n = 150 per condition; the full-size comparison is in the VAL-02 artifacts):

| Pathway | Indicator | All post-shift trials (v0) | Early window, 6 trials | Early window, 4 | Blocks ×2, v0 | Blocks ×2, window 6 |
|---|---|---|---|---|---|---|
| B | `shift_slope` (pooled) | r .30 / rel .27 | .28 / .25 | .16 / .22 | .36 / .31 | .33 / .22 |
| B | `shift_slope_rule_switch` | .08 / .23 | .13 / .35 | .07 / .36 | .20 / .13 | **.36 / .33** |
| B | `shift_slope_pressure` | .25 / .25 | .23 / .15 | .14 / .05 | .29 / .40 | .07 / .03 |
| A | `shift_slope` (pooled) | .08 / .42 | .08 / .27 | .04 / .24 | — | — |
| A | `shift_slope_new_rule` | .02 / .35 | .02 / .31 | .02 / .19 | — | — |
| A | `shift_slope_reversal` | .04 / .05 | .00 / .18 | .00 / .17 | — | — |

Cells show r latent / parallel rel. With n = 150, the standard error of r is about .08.

* Hierarchical shrinkage is already in place: the person estimate is the BLUP. The empirical-Bayes OLS fallback is
  never better, because it uses the same information with a cruder variance model.
* An early-window contrast helps the rule-switch slope when blocks are long enough (r .20 → .36 at ×2). It hurts the
  pressure slope, because the pressure manipulation is sustained rather than transient. A single global window is
  therefore the wrong default. `models.shift_window_trials` stays `null` (v0) until the full-size comparison is in.
* More trials help modestly. Doubling the blocks raises the pooled B slope from .30 to .36.
* In A no variant recovers stability. The planted effect is close to zero relative to adaptability and emotional
  regulation.

**Recommendation.** Keep stability `research_only` as the plan's risk register already anticipates ("difference-score
unreliability"). Candidate for v2: a purer B contrast. The card-sort non-perseverative error rate in the first 6
post-shift trials is the simulator's stability channel (`shift_lapse`) and is listed in SCR-06 but not scored. Add it
as an exploratory indicator after Stage 1 shows whether real players produce such lapses. Do not gate on A shift
slopes.

## 4. Effort discounting: why log k is unidentifiable with 4 choices, and a better design

**Problem.** Wait-or-Now offers 2 coins with no hold against 5, 6, 8 or 10 coins with a 2.5 s hold, always in that
order. With the simulator's population of log k (−1 ± 0.7) the value of the hard option exceeds 2 coins for most
people at every offer. About 46% of players choose "hard" four times, which bounds log k on one side only, so the
estimate collapses onto the empirical-Bayes prior. The model-based reliability is .05–.20.

**Design study** (`stats/simulator/src/shriii_simulator/discounting_design.py`; same chooser as the simulator and the
engine's estimator `fit_discounting_eb`; full-size artifact `val02-effort-designs`, n = 400, two parallel occasions;
the staircase halves its step only at reversals, so it can reach the whole 2.5–12 coin range):

| Design | Choices | r(est, true log k) | Parallel rel | Model rel | All hard |
|---|---|---|---|---|---|
| fixed4_v0 (5, 6, 8, 10) | 4 | .59 | .38 | .20 | 46% |
| fixed8_wide (2.5 … 12) | 8 | .76 | .57 | .51 | 3% |
| titrated4 (start 6, step 2) | 4 | .60 | .45 | .06 | 2% |
| titrated6 | 6 | .68 | .52 | .13 | 1% |
| titrated8 | 8 | .81 | .64 | .43 | 0% |
| titrated8, two staircases (3.5 / 9) | 8 | .77 | .58 | .51 | 3% |
| titrated12, two staircases | 12 | .84 | .71 | .60 | 0% |

A titrated staircase's model reliability is lower than its parallel reliability because the offers converge on
each person's indifference point, where single choices are close to coin flips; the parallel-form number is the
one that matters for ranking people. (An earlier local run, n = 300 with the step halved every trial, gave
somewhat higher numbers for the short staircases; the table above supersedes it.)

**Recommendation for the Wait-or-Now owners.** Replace the four fixed offers with an **8-trial adjusting-amount
staircase on the hard amount** (2.5–12 coins, start 6, step 2, step halved on reversal), or two interleaved 4-trial
staircases starting at 3.5 and 9. Cost: +4 effort trials × 5.0 s (L2 median) ≈ **+20 s**. Even at 4 trials,
titration alone removes the ceiling (all-hard 46% → 2%, parallel rel .38 → .45) at no time cost. The simulator implements
the schedule (`design.wait_or_now.effort_design: titrated`). The engine's estimator works with any schedule because
it reads the offers from the trial parameters.

## 5. Indicators that could never be scored

| Pathway | Indicator | Cause | Resolution |
|---|---|---|---|
| A | `stability.shift_slope_rude_run` | Dictionary phases `[shift_pre, shift_post]`, but the pre-shift baseline block (`tone_calm`) has phase `main`, so the contrast had no "pre" cell | **Fixed**: phases `[main, shift_post]`. Now scored for all players (parallel rel ≈ .6), but it measures emotional regulation (see §3) |
| A | `response_consistency.loc_scale_sigma` | Phases `[main]` select only the 20-trial Stall service block (≈ 14 RT trials), below the 40-trial minimum | **Fixed**: all scored RT phases. ≈ 58 RT trials. The location model removes each block's mean and trend and scales by the block's pooled residual SD |
| A | `expressive_restraint.iti_rvi` | Minimum 30 trials, but the selected block has 20 | **Fixed**: minimum 20 (exploratory, `val02_pending`) |
| B | `expressive_restraint.iti_rvi` | Minimum 40 trials, but Don't-Tap main has 36 | **Fixed**: minimum 30 (exploratory, `val02_pending`) |
| B | `persistence.effort_completion_rate` | A hold exists only after a "hard" choice, so the number of completion opportunities is behaviour-dependent (median 3 of 4) and confounded with discounting | **`not_scorable_v1`**, not gate-eligible. Pathway A's 4 forced uphill holds carry the paradigm. v2: add forced-hold trials to Wait-or-Now |
| B | `self_control.choice_consistency` | Requires 12 delay choices (`plan_ac`), but 8 are scheduled (already waived in `cicd/trial-budget`). Under titration, consistency with the fitted curve mostly reflects choice noise near indifference | **`not_scorable_v1`**, not gate-eligible. Game owners: +4 delay trials (+20 s) or retire it at the next amendment |
| A, B | `teamwork.response_to_partner_error`, `emotional_regulation.tone_after_unfair_loss_b` | Single scripted event (`kind: single_event_unscorable`) | Unchanged, by design |

`not_scorable_v1` is written as the first token of the indicator's `notes` with the rationale, and the indicator is
set to `gate_eligible: false`. The dictionary schema has no status for it, and changing the schema belongs to the
contracts owners. A test (`stats/simulator/tests/test_val02.py`) keeps every `not_scorable_v1` indicator out of
gating and checks that the fixed indicators now score. `status` stays `provisional` (plan: no drops before Stage 3).
The trial-budget waiver for `choice_consistency` is still needed, because the shortfall is unchanged.

## 6. Other findings for the dictionary owners

| Indicator | Observation | Suggestion |
|---|---|---|
| `self_control.ezd_drift_nogo` (A, B) | Parallel rel .73–.83 but r latent .48. Strongest other latent is response consistency (.73): EZ drift is a function of RT variance, which the RT tail drives | Treat as a robustness indicator; do not count it towards the self-control gate until real data shows discriminant validity from response-consistency indicators |
| `problem_solving.planning_time`, `initiative.planning_time_before_first_move` | Same Tower measure on two constructs (documented method overlap) | Keep the shared-measure purity correction in recovery; consider dropping one at v1 |
| `persistence_of_style.lag1_autocorr` | Parallel rel ≈ 0: 2–4 trial probe runs are too short | Candidate for retirement (no trial budget can fix it within 15 min) |
| `response_consistency.choice_entropy_repeats` | Parallel rel .19–.36 with 3 repeats per situation | VAL-02 projects the repeats needed. Likely infeasible |
| `composure.error_type_shift` | Parallel rel ≈ 0 | Sign depends on whether pressure costs speed or inhibition. Keep exploratory |

## 7. Reproducing

```bash
uv run pytest stats/scoring/tests/test_glmm.py stats/simulator/tests/test_val02.py   # fast checks
SHRIII_RUN_SLOW=1 uv run pytest stats/simulator/tests/test_recovery.py              # n = 800 recovery
uv run python -m shriii_simulator.val02 --profile local                             # smoke-size study (~10 min)
```

The full-size study (`--profile full`) runs in `.github/workflows/measurement-science.yml`. It is triggered by
workflow_dispatch, nightly, or a PR labelled `val02-full`, and uploads `val02-A`, `val02-B` and
`val02-effort-designs`.
