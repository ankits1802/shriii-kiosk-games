# plan-lint (PLT-08)

Lints the feature dependency graph in `docs/IMPLEMENTATION_PLAN.md`. Every feature header reads
`#### ID · Title — Priority · Milestone · deps: A, B · src: …`. The tool fails on:

| Code | Meaning |
|---|---|
| `malformed-header` | a `#### XXX-NN` header that does not match the format |
| `duplicate-id` | a feature ID declared twice |
| `unknown-dep` | a dependency on an ID that is not in the plan |
| `cycle` | a dependency cycle (including a self-dependency), printed as a path |
| `later-milestone-dep` | a dependency whose milestone starts later than the feature's milestone |
| `lower-priority-dep` | a dependency with a lower priority (P0 < P1 < P2 < PG) |
| `unknown-milestone` | a milestone the plan does not define |
| `appendix-counts` | Appendix A ("feature counts") disagrees with the headers |

Milestone start months come from the plan itself (`Milestones are defined in §8: M0 P5–P7, …`; PG = after the grant),
so M1 (P6) may depend on M2 (P6) but not on M3 (P8). Standard library only.

```bash
uv run python tools/plan-lint/plan_lint.py            # lint (exit 1 on findings, 2 on unreadable input)
uv run python tools/plan-lint/plan_lint.py --order    # + topological build order grouped by milestone
uv run python tools/plan-lint/plan_lint.py --counts   # + regenerate the Appendix A table
uv run python tools/plan-lint/plan_lint.py --json     # machine-readable findings and order
uv run python tools/plan-lint/plan_lint.py --features-yaml features.yaml   # lint a YAML mirror instead
uv run pytest tools/plan-lint                          # tests
```

CI: the `plan` job in `.github/workflows/ci.yml`.
