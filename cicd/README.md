# cicd/

Everything the pipelines run that is not a workflow definition: CI gates, CI helper scripts and their tests.

GitHub only reads workflow files from `.github/workflows/` at the repository root, so the workflow YAML (and
the CodeQL config and Renovate config it uses) stays under `.github/`. Workflows call into this directory
for the actual logic, which keeps the scripts testable with plain `pytest` and runnable on a laptop.

| Path | What it is | Run locally |
|---|---|---|
| `plan-lint/` | PLT-08: parses the feature headers in `docs/IMPLEMENTATION_PLAN.md`, fails on unknown IDs, cycles and milestone or priority inversions; prints the build order | `uv run python cicd/plan-lint/plan_lint.py --order` |
| `trial-budget/` | SCR-03 / ONB-08: trial-time budget sheet (measured seconds per trial x required trials from the dictionary) against the plan section 4.4 session budget | `uv run python cicd/trial-budget/trial_budget.py --out trial-budget.md` |
| `scripts/schema_compat.py` | PLT-02: contract compatibility between two copies of `contracts/schemas` (breaking / forward / safe) | `python cicd/scripts/schema_compat.py --base <dir> --head contracts/schemas --migrations contracts/migrations` |
| `scripts/sim_recovery.py` | QA-02: simulated-player parameter-recovery run (small per PR, full nightly) | `uv run python cicd/scripts/sim_recovery.py --n 50 --pathways B --out-dir sim-out` |
| `scripts/loadtest_summary.py` | QA-05 / ING-02: turns a `tools/loadtest/results/<label>` run into the job summary and verdict | `python cicd/scripts/loadtest_summary.py tools/loadtest/results/<label>` |
| `scripts/ecs_migrate.sh` | Deploy: runs the Alembic migrations as a one-off ECS task before the service rollout | used by `deploy.yml` only |
| `scripts/tests/` | Tests for the helper scripts | `uv run pytest cicd/scripts/tests` |
| `e2e/smoke.py` | Playwright smoke: kiosk build against a seeded API | `uv run --with playwright python cicd/e2e/smoke.py --api-url http://127.0.0.1:8000 ...` |

All tool tests at once: `uv run pytest cicd/plan-lint cicd/trial-budget cicd/scripts/tests -q`.

## Workflows (`.github/workflows/`)

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | push to main, pull request, merge queue, manual | Plan lint and trial budget; Node lint, typecheck, test, build; Python ruff, mypy, pytest against PostgreSQL 18 and a small recovery run; side tools (`tools/audio-pipeline`, `tools/asr-bakeoff`, `frontend/packages/session-crypto/python`); Playwright smoke; Docker images and the compose stack; OpenTofu validate. `CI OK` is the single required check. |
| `schema-compat.yml` | pull requests touching `contracts/schemas` or `contracts/migrations`, pushes to main touching the schemas | Compares the PR's schemas with the merge base using `cicd/scripts/schema_compat.py`. |
| `codeql.yml` | push to main, pull request, weekly | CodeQL for JavaScript/TypeScript, Python and Actions (`.github/codeql/codeql-config.yml` excludes generated code). |
| `osv-scanner.yml` | push to main, pull request, merge queue, daily | Vulnerability scan of `pnpm-lock.yaml`, `uv.lock` and container bases. |
| `kiosk-electron.yml` | push to main; pull requests touching the Electron runtime or its packages | Typecheck and unit tests, the real-Electron self-test under Xvfb, an unsigned Linux pack and the packed self-test. |
| `kiosk-release.yml` | `kiosk-v*` tags, manual | Deploy-order gate, reproducible kiosk build, SBOM, cosign signatures, GitHub release with the app x content x dictionary tuple. |
| `deploy.yml` | manual (until the AWS environment exists) | Builds the api, worker, web and kiosk images, pushes and signs them, runs migrations (`cicd/scripts/ecs_migrate.sh`) and applies OpenTofu for staging or production. |
| `r-psychometrics.yml` | push to main; pull requests touching `stats/r-psychometrics`, `stats/rbridge`, `stats/validation` or the gates | Builds the pinned R image, runs testthat inside it, then the `r`-marked bridge tests. |
| `nightly-sim.yml` | nightly, manual | Full parameter-recovery run (n = 400) and the slow simulator/validation tests; opens an issue on failure. |
| `loadtest.yml` | nightly, manual, PRs touching the harness | Ingestion load test against PostgreSQL 18; results are uploaded as the `loadtest-<run id>` artifact. |

Renovate reads its configuration from `.github/renovate.json`.
