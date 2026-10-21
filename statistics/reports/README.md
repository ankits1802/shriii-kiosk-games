# shriii-reports: stage reports and technical manual (VAL-15)

Jinja2 templates that render **report bundles** (ValidationResult JSON) to Markdown, HTML and Quarto
`.qmd`, plus a renderer CLI.

| Report kind | Template | Plan section |
|---|---|---|
| `stage2_pilot` | `src/shriii_reports/templates/stage2_pilot.j2` | 7.4 Stage 2 pilot with criterion battery |
| `stage3_retest` | `stage3_retest.j2` | 7.5 Stage 3 retest |
| `stage4_fairness` | `stage4_fairness.j2` | 7.6 Stage 4 fairness and mode equivalence (ITC) |
| `stage5_norming` | `stage5_norming.j2` | 7.9 Stage 5 criterion validity and norming |
| `technical_manual` | `technical_manual.j2` | Skeleton after the AERA/APA/NCME Standards and ITC Guidelines |

Each body template is written once; the format comes from a macro set (`_md.j2`, `_html.j2`, `_qmd.j2`).
Shared blocks (sample flow, exclusions, differential exclusion, result tables, gates, norms, provenance,
sign-off) live in `_blocks.j2`. The `.qmd` output has YAML front matter (`format: html` and `pdf`, TOC) and
Quarto callouts; render it with `quarto render <file>.qmd`.

## Input: the report bundle

`src/shriii_reports/model.py` (Pydantic, `extra="forbid"`). Each `results[]` entry is one ValidationResult
(plan section 6.2 / `validation.statistical_results`): `section`, `subject`, `metric`, `hypothesis_id`,
`family`, `confirmatory`, `pathway`, `language`, `subgroup`, `threshold`, `threshold_rule`, `passed`,
`run_id`, and `evidence`, which is exactly `shriii_validation.results.EvidenceResult.to_dict()`
(estimate, CI, n, method, status, assumptions, warnings, details, provenance). Flat rows with the estimate
at the top level are lifted into `evidence`. The bundle also carries `report` metadata, `provenance`
(analysis run, snapshot sha256, prereg id, hypotheses/gates/dictionary sha256, git sha, image digest,
erasures applied), `sample`, `exclusions` (with per-group rates), `targets`, `trait_gates`, `battery_gates`,
`indicator_decisions` and `norm_tables`. `shriii-reports schema` prints the JSON Schema.

## Integrity rules (applied in `prepare.py`, never in templates)

- **Confirmatory vs exploratory.** Confirmatory only when `hypothesis_id` is in a confirmatory family of
  `hypotheses.yaml`; registered non-confirmatory families are secondary; everything else is shown as
  unregistered (descriptive or exploratory). False claims are demoted and listed in the report.
- **No number without evidence.** A result whose status is not `ok` shows its reason, never an estimate or
  a pass.
- **Disclosure control.** Subgroup results and norm cells with n below `gates.yaml quality.fairness_cell_min_n`
  are suppressed.
- **Provenance.** Hash mismatches between the bundle and the hypotheses/gates files used to render, a
  missing `prereg_id` from S2 onwards, and final indicator decisions in a Stage 2 report are flagged.
  Differential exclusion is compared against `battery_gate.differential_exclusion_max_pp`.
- Every report carries the bundle's canonical-JSON sha256, per-result input hashes and a sign-off table.

## Usage

```bash
uv run shriii-reports render path/to/bundle.json --out-dir build/reports           # md + html + qmd
uv run shriii-reports render bundle.json --formats html --strict                   # exit 1 on any integrity warning
uv run shriii-reports validate bundle.json
uv run shriii-reports kinds
```

By default `scoring/hypotheses.yaml` and `scoring/gates.yaml` are found by walking up from the working
directory; `--hypotheses/--gates` override, `--no-registry` renders without classification checks.

## Stakeholder and legal review

Narrative sections are placeholders (`[TO BE COMPLETED]`) and interpretation sections are marked
`[REVIEW REQUIRED: ...]` with the role that must sign off (PI/Research Lead, Ethics Officer, and for
Stage 5 report-use content also the DPO and legal counsel). Tables are generated; narrative is not.

## Fixtures and tests

`tests/fixtures/*.json` are built by `tests/fixtures/build_fixtures.py` from real `shriii_validation`
results on seeded synthetic data (`uv run python reports/tests/fixtures/build_fixtures.py`).
Tests: `uv run pytest reports/tests`.
