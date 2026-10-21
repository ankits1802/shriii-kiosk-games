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

Analysis conventions not in `gates.yaml` (change-in-fit rules, DIF bounds, norming cell sizes, CV folds)
live in `data/validation_params.yaml` with citations.
