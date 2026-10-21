# shriii-prereg: pre-registration generator (CRT-11)

Generates the OSF-style pre-registration document (Markdown, HTML and a JSON document model) directly from
the science inputs, which it only reads:

| Input | Used for |
|---|---|
| `stats/measurement-model/hypotheses.yaml` | Hypothesis families, corrections (Holm, BH-FDR), every hypothesis, targets, teamwork exception, research-only path, construct coverage |
| `stats/measurement-model/gates.yaml` | Trait gate B1-B6, battery gate A1-A5, caps, permanent withholds, group-only indicators, display rule, quality thresholds |
| `stats/measurement-model/dictionary/*.yaml` | Constructs, task modules, indicators (transformation, reliability method, min valid trials and its basis), exclusion rules, missing-data policies |
| `stats/prereg/prereg.config.yaml` | Study metadata and the VAL-02 planning assumptions (no thresholds) |

The SHA-256 of every input (CRLF normalised to LF, the repository convention used by
`shriii_scoring.resources.sha256_bytes`) is embedded in every output: YAML front matter and an HTML comment
in the Markdown, `<meta>` tags and an HTML comment in the HTML, and the `inputs` array in the JSON.

## Usage

```bash
# from the repository root
uv run shriii-prereg generate --out-dir build/prereg            # md + html + json
uv run shriii-prereg generate --generated-at 2026-10-21T00:00:00Z --strict --require-frozen
uv run shriii-prereg verify build/prereg/preregistration.md     # exit 1 if any input changed since generation
```

- `--strict` fails (exit 1) on cross-reference errors: unknown family, construct, indicator or exclusion rule;
  a group-only indicator used in an individual-level test; a confirmatory or secondary convergent hypothesis
  without an expected sign or r0; a construct without a coverage row; a construct registered as confirmatory
  for a pathway without a confirmatory hypothesis.
- `--require-frozen` fails unless every input has `status: frozen` and `frozen_at` set. A draft document
  carries a "Not for submission" banner.
- Output into `stats/measurement-model/` is refused.

## Sample-size section

Computed with `shriii_validation.power` from the planning block of the config, the primary family in
`hypotheses.yaml` (Holm smallest per-test alpha = alpha / m) and `gates.yaml trait_gate.retest`:
the primary lower-bound test (true r vs r0), the per-language sign check, and the retest ICC CI half-width
(plus the pairs needed so that ICC = `point_min` has a lower bound >= `lower_bound_min`). Simulation power
for the pattern statistic, invariance and DIF is produced by the VAL-02 report and cited, not reproduced.

## Review

Everything sourced from `prereg.config.yaml` (title, contributors, languages, funding, planning n) is marked
**REVIEW REQUIRED** in the document and must be confirmed by the PI, Research Lead and Ethics Officer before
submission. The document is regenerated after every PLT-09 amendment.

Tests: `uv run pytest stats/prereg/tests`. `test_governance_docs.py` also checks the ethics evidence pack
for consistency: every consent kind in the contracts has a script in `docs/governance/consent/`, every
retention-engine rule (`backend/api/.../config/retention.yaml`) appears in the retention policy, every
implemented RBAC role appears in the access-control policy, and relative links in `docs/governance/` resolve.
