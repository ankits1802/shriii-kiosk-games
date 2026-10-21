# Scoring rules (layer 2 definitions, pre-registration and gates)

| File | Purpose | Schema |
|---|---|---|
| `dictionary/shared.yaml` | The 17 constructs: kind (E/S/M), tier, definitions, ECD mapping, pathway status, criterion relations, report caps and phrase keys; shared exclusion, missing-data and transformation catalogues | `scoring-dictionary-shared.v1` |
| `dictionary/dictionary.B.yaml` | Pathway B (micro-game carousel) indicators | `scoring-dictionary-pathway.v1` |
| `dictionary/dictionary.A.yaml` | Pathway A (three linked episodes, plus co-play substudy) indicators | `scoring-dictionary-pathway.v1` |
| `hypotheses.yaml` | Pre-registration: Holm-corrected primary family (one per Tier-1 construct), secondary/exploratory (BH-FDR), discriminant pattern, nomological, retest, group-level; targets; teamwork exception | `hypotheses.v1` |
| `gates.yaml` | Battery release gate (>= 2 language groups), trait gates (retest ICC(A,1) target 0.60, reliability, convergent lower bound, invariance, SEM rule), caps, display rule | `gates.v1` |

Status: **v0 draft** (not frozen). `min_valid_trials.basis` records whether a minimum comes from a plan
acceptance criterion (`plan_ac`), a literature prior, or is pending the VAL-02 power report.

Validation: `uv run pytest scoring` (JSON Schema + Pydantic + semantic matrix rules).
