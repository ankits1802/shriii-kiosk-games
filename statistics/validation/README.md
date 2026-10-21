# shriii-validation

Layer 4 psychometric evidence for the SHRIII battery. Every analysis returns an `EvidenceResult`
(estimate, CI, n, method, assumption checks, warnings, provenance with input hash and library versions).
Analyses that cannot run return `insufficient` / `not_available` with the reason; they never return a
number that could be mistaken for evidence.

| Module | Contents |
|---|---|
| `reliability` | permutation split-half (stratified, Spearman-Brown, CI), Cronbach alpha (Feldt CI) and McDonald omega with assumption checks, six ICC forms with McGraw & Wong CIs (Shrout & Fleiss reference values tested), retest (ICC(A,1) primary, ICC(C,1), Pearson never for gates, SEM, SDC, Bland-Altman, practice effect), G-studies for fully crossed random designs, difference-score, model-based and Mosier composite reliability, group-wise reliability |
| `validity` | Pearson / Spearman with Fisher-z and bootstrap (percentile, BCa) CIs, partial correlations, lower-bound tests, Steiger and Zou dependent-correlation comparisons, Holm and BH-FDR, effect sizes, disattenuation (secondary, never feeds gates), Westen & Rosenthal r_contrast-CV pattern statistic with bootstrap CI and permutation p, MTMM matrix, `evaluate_hypotheses` against `scoring/hypotheses.yaml` |
| `structure` | Horn parallel analysis, ML EFA with oblimin rotation, CFA via semopy (CFI, TLI, RMSEA, SRMR), nested model comparison, ML multi-group CFA with mean structure (configural / metric / scalar / partial scalar, Chen 2007 change-in-fit rules), redundancy |
| `fairness` | logistic-regression DIF (uniform / non-uniform / combined LR tests, Nagelkerke delta R^2 with Zumbo-Thomas and Jodoin-Gierl classes, purification, BH-FDR), regression DIF for continuous indicators, TOST (two-sample, one-sample, proportions), Cleary differential prediction, group-wise calibration, disparity, device-familiarity effects |
| `prediction` | participant-grouped nested CV (ridge, elastic net, random forest, XGBoost), the four spec 6.4 comparisons and incremental CV R^2 (pre-declared primary model = first listed, paired participant-clustered bootstrap CI; never the model with the largest gain), hierarchical delta R^2 with clustered bootstrap, deterministic participant-level holdout, leakage guard |
| `norming` | post-stratification and raking weights with trimming and Kish effective n, weighted percentile norms by age x education with provisional / suppressed cells and crossing checks |
| `gates` | trait gates B1-B6 and battery gate A1-A5 from `scoring/gates.yaml`, fail closed, evaluate-only never promotes, caps, permanent withholds, append-only history |
| `power` | correlation lower-bound n / power, ICC CI half-width (Bonett), DIF power simulation records |
| `rbackend` | `RBackend` protocol for lavaan/semTools, mirt, cNORM/GAMLSS, blavaan; `UnavailableRBackend` returns `not_available` until R is installed |

## Entry points for the API worker

| Function | Input | Output |
|---|---|---|
| `run_analysis(analysis, frame, params=, context=)` | a snapshot frame (`research_id`, design columns, `ind__*`, `crit__*`) | `AnalysisReport`: `ResultRecord` rows (estimate, CI, N, threshold, pass/fail, subgroup, details, exclusions, provenance), frame-level exclusions by reason x language, notes, provenance |
| `train_model(frame, features=, target=, algorithm=, params=, holdout_cohort=)` | one registered model | nested participant-grouped CV metrics with clustered-bootstrap CIs, out-of-fold and holdout predictions (by `research_id`), holdout metrics |
| `generate_norms(frame, indicator_ids=, directions=, reliability=, quantiles=, ci_level=)` | one trait x language slice | weighted cut-points, SEM, Kish effective n, standardisation for the release-pack composite, age x education cells, band-width-in-SEM check |
| `evaluate_gates(rows, gates=, constructs=, hypotheses=, pathway=, languages=)` | persisted result rows | trait gates B1-B6 and battery gates A1-A5, evaluate-only (never promotes) |

Analyses (`shriii_validation.ANALYSES`): `descriptives`, `reliability` (retest ICC(A,1) per measure and construct
composite, per language and pooled; composite omega/alpha), `construct_validity` (the `hypotheses.yaml` registry with
family corrections, discriminant pattern, nomological; exploratory indicator x criterion r), `mtmm`, `factor_structure`
(parallel analysis, EFA, CFA), `measurement_invariance` (multi-group CFA per grouping with a bounded partial-scalar
search; criterion-scale invariance reported `not_available` because snapshots carry no items), `dif` (regression DIF
matched on an external criterion or rest composite, BH-FDR, Jodoin-Gierl classes), `fairness` (TOST, Cleary, calibration,
missingness and manifest-level differential exclusion, device familiarity) and `incremental_validity` (the four spec 6.4
comparisons, incremental CV R^2 with the pre-declared primary model, hierarchical delta R^2, untouched holdout).

Shared frame rules (`shriii_validation.frame`): group-level-only indicators are dropped before any individual analysis;
holdout-cohort rows are only used by the final holdout evaluation; criterion values of careless responders are blanked;
cross-sectional analyses use the baseline occasion. Every exclusion is counted by reason and language.

Analysis conventions not in `gates.yaml` (change-in-fit rules, DIF bounds, norming cell sizes, CV folds)
live in `data/validation_params.yaml` with citations.
