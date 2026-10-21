# Game configs

One JSON file per module (`pathway-b/`), episode (`pathway-a/`) and the shared warm-up (`shared/`), validated
by `packages/contracts/schemas/game-config.v1.schema.json`. `session-plan.json` holds the plan section 4.4
session budgets, the fixed Pathway B order with the planned-missingness slot, the Pathway A order and the
idle/walkaway timers.

All load parameters (stimulus durations, windows, ISIs, caps) live in each file's `levels.L1|L2|L3.timing`
table; game code must read them from there (ENG-10: no hard-coded timers).

## Budget model (design targets until the `tools/trial-budget` sheet exists)

```
duration(level, bot, counts) = intro_ms + outro_ms
    + sum over blocks of trials x (budget_trial_ms if set else seconds_per_trial[level][bot] x 1000)
median       = median bot, planned trials        (must be <= soft cap)
slow         = slow bot, planned trials          (may exceed the soft cap: graceful wrap-up)
slow_trimmed = slow bot, block min_trials        (must be <= hard cap; minimums are always protected)
```

`uv run pytest content` recomputes every estimate and checks:

- Pathway B modules last 60-120 s at every level (median and trimmed slow bot);
- Pathway A episodes run 180-216 s at L2 (3.3 +- 0.3 min);
- median scored play at L2 is 540-630 s for every slot form and for Pathway A;
- hard caps plus the onboarding, warm-up, bridge, report and opt-in ceilings stay <= 890 s (cap 900 s);
- every module declares indicators covering >= 2 constructs and resolves them in the pathway dictionary.

Notes: the Road Home uphill-effort beat (persistence evidence in Pathway A) is an iteration-1 design
decision awaiting PI confirmation; the co-play episode is a supervised substudy outside the 15-minute budget.
