# trial-budget (SCR-03 / ONB-08)

The trial-time budget sheet. It reads, and never writes:

- `content/games/**/*.json`: blocks, trials, protected minimums (`min_trials`, `min_counts`), seconds per trial per
  level and bot, intro/outro, soft and hard caps;
- `content/games/session-plan.json`: the 900 s cap, the 890 s target, segment ceilings, scored-play limits, module
  and episode ranges, the Pathway B core order and slot candidates, the Pathway A order;
- `stats/measurement-model/dictionary/dictionary.{A,B}.yaml`: `min_valid_trials` per indicator (fed by VAL-02);
- `docs/IMPLEMENTATION_PLAN.md` section 4.4: per-segment ceilings, scored-play design targets, total and cap.

It recomputes each module's duration (same model as `content/games/README.md`), sums every session form
(Pathway B: 5 core modules plus each planned-missingness slot; Pathway A: the three episodes; the co-play
substudy is reported but sits outside the budget), and checks:

| Check | Rule |
|---|---|
| `module-range`, `episode-range` | B modules 60–120 s (median and trimmed slow bot, every level); A episodes 180–216 s at L2 |
| `soft-cap`, `hard-cap` | median within the soft cap; slow bot trimmed to minimums within the hard cap |
| `warmup` | warm-up hard cap within the practice/warm-up segment |
| `scored-play` | median scored play at L2 within the session-plan limits (540–630 s) |
| `session-ceiling` | segment ceilings + module hard caps ≤ 890 s |
| `slow-bot` | segment ceilings + slow bot at L1 (each module capped at its hard cap) ≤ 900 s |
| `min-duration` | segment ceilings + summed minimum durations at L2 ≤ 890 s (SCR-03 AC) |
| `plan-4.4` | session-plan ceilings, target and cap agree with the plan section 4.4 table |
| `design-target` (warning) | median scored play more than ±30 s from the plan's "≈" design target |
| `trial-supply` | the schedule's protected minimums guarantee each indicator's `min_valid_trials` |

Trial supply is defined per dictionary task and unit in `budget.yaml` (block minimums, `min_counts` keys, probe
segments, context shifts). A shortfall is an error when the indicator's `basis` is `plan_ac` or
`literature_prior`, a warning when it is a `val02_pending` placeholder, and accepted when the indicator is
demoted (`research_only`, `withheld`, `retired`). Known shortfalls can be waived temporarily in `budget.yaml` with a
reason; a waiver that is no longer needed fails the run so it gets removed.

```bash
uv run python cicd/trial-budget/trial_budget.py                 # Markdown sheet (exit 1 on errors)
uv run python cicd/trial-budget/trial_budget.py --format csv     # one row per indicator (spreadsheet)
uv run python cicd/trial-budget/trial_budget.py --format json    # everything, machine-readable
uv run python cicd/trial-budget/trial_budget.py --strict         # warnings fail too
uv run pytest cicd/trial-budget                                  # tests
```

Current finding (waived, owner: scoring dictionary): `B:self_control.choice_consistency` requires 12 delay choices
(`plan_ac`), but Wait-or-Now schedules 8 delay trials.
