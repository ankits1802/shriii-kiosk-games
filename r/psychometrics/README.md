# shriiipsy: SHRIII R psychometrics backend

`shriiipsy` is the R half of the validation engine (plan VAL-01). It covers the analyses Python does not
handle well. Every analysis returns a typed result whose fields match
`shriii_validation.results.EvidenceResult`: `estimate`, `ci_low`/`ci_high`/`ci_level`, `n`, `method`,
`status`, `assumptions`, `warnings`, `details` and `provenance` (inputs SHA-256, algorithm version, seed,
parameters, R and package versions).

| Analysis (`analysis`) | Plan | What it does | `estimate` |
|---|---|---|---|
| `measurement_invariance` | VAL-07, VAL-08a | Multi-group CFA (semTools `measEq.syntax` + lavaan). Steps run configural → metric → scalar (→ strict), and ordinal items get a thresholds step after configural. Ordinal items use WLSMV with Wu & Estabrook (2016) identification. Each step is judged on ΔCFI/ΔRMSEA/ΔSRMR and a chi-square difference test. A failed step triggers a partial invariance search: score tests (`lavTestScore`) pick the constraints to release, capped at `max_freed_parameter_share`. | level code: 0 none, 1 configural, 2 metric, 3 scalar, 4 strict |
| `bayesian_approximate_invariance` | VAL-08a (n < 200) | blavaan `bcfa` with `wiggle` priors (small-variance) on loadings and intercepts. Reports PPP, R-hat and per-group parameter differences. | PPP |
| `irt_grm` | VAL-07 | mirt graded response model. Rare categories are collapsed. Reports item parameters with SEs, M2/C2, S-X2 item fit and EAP reliability. | marginal reliability |
| `irt_dif` | VAL-09 | Likelihood-ratio IRT DIF (mirt `multipleGroup`). Anchors are chosen rank-based from an all-other screen (Woods 2009) unless you supply them. Uses BH-FDR and empirical effect sizes. | share of items flagged |
| `ordinal_logistic_dif` | VAL-09 | lordif ordinal logistic regression DIF with IRT-purified matching | share flagged |
| `glmm_dif` | VAL-08, VAL-09 | Explanatory IRT / GLMM DIF on trial data with lme4 (binomial, gaussian/log RT) or glmmTMB (other families). Item × group LR tests with iterative anchor purification and BH-FDR. ETS-style classes for logit effects. Also an omnibus random item × group variance test and the impact estimate. | share flagged |
| `person_random_slopes` | SCR-09, VAL-04 | Logistic (or linear) mixed model `y ~ condition + (1 + condition \| person)`, for example composure accuracy under pressure. The logit link removes the ceiling compression of raw accuracy differences. Reports person slopes and empirical-Bayes reliability (1 − mean PEV / τ²) with a parametric bootstrap CI and ceiling diagnostics. | slope reliability |
| `continuous_norms` | VAL-11 | cNORM (age) or GAMLSS (age + education, `pb` smoothers) on supplied or raked, trimmed weights. Reports the Kish effective n and the percentile norm table. Percentile crossing blocks publication. | cNORM adj. R² / GAMLSS pseudo-R² |
| `reliability_cross_check` | VAL-01 AC | ICC(A,1)/(C,1) (irr), alpha with Feldt CI (psych) and Pearson r. The Python sidecar checks agreement within 1e-6. | the coefficient |

## Thresholds live in YAML

Defaults are in `inst/config/thresholds.yaml`. They mirror `scoring/gates.yaml` and
`python/shriii_validation/.../validation_params.yaml`. The Python bridge sends the values from those two
files with every request (`thresholds`), and they override the defaults key by key. No decision threshold
is hard-coded in R.

## CLI (JSON in, JSON out)

```sh
shriiipsy run --request req.json --response resp.json     # "-" = stdin / stdout
shriiipsy analyses                                         # analyses and their parameters
shriiipsy version
```

```json
{"schema": "shriiipsy-request/1", "analysis": "measurement_invariance",
 "data": {"path": "data.parquet", "format": "parquet"},
 "params": {"model": "f =~ y1 + y2 + y3", "group": "language", "ordered": ["y1", "y2", "y3"]},
 "thresholds": {"invariance": {"max_freed_parameter_share": 0.2}}, "seed": 1, "run_id": "..."}
```

`data` can be a Parquet or CSV file, or inline `{"columns": {...}}`. A relative path resolves against
the request file's directory. A failed analysis or a malformed request still produces a result with
`status: "failed"` and the reason. Exit code 2 means the request could not be parsed.

## Reproducible environment

- `renv.lock` pins every package to the Posit Package Manager snapshot **2026-10-15** (R 4.6.1).
  Regenerate it with `tools/update-lock.sh`, which runs inside the pinned base image.
- `tools/system-deps.txt` lists the Ubuntu runtime libraries the binary packages need.
- The image `infra/docker/r-psychometrics.Dockerfile` starts from `rocker/r-ver:4.6.1@sha256:…`
  (digest-pinned). It runs `renv::restore()` from the snapshot's Ubuntu 24.04 binaries, checks every
  locked version and sets single-threaded BLAS/OpenMP for deterministic numerics.

```sh
docker build -f infra/docker/r-psychometrics.Dockerfile -t shriii/r-psychometrics:0.1.0 r/psychometrics
docker run --rm --entrypoint shriiipsy-test shriii/r-psychometrics:0.1.0      # testthat suite
```

## Tests

The testthat suite covers the following:

- The lavaan HolzingerSwineford1939 tutorial values: configural χ² 115.851/48, metric 124.044/54, scalar 164.103/60, and partial scalar invariance with the x3 and x7 intercepts freed.
- The 20% freed-parameter cap.
- Ordinal WLSMV checked against lavaan's configural fit.
- mirt `Science` GRM parity, plus discrimination recovery on simulated data.
- Planted-DIF detection for mirt, lordif and GLMM DIF.
- Composure slope recovery under ceiling: EB reliability ≈ squared correlation of the estimated slopes with the true slopes.
- GAMLSS and cNORM centile recovery, raking, and percentile-crossing detection.
- The Shrout & Fleiss (1979) ICC(2,1) = .29 and ICC(3,1) = .71.
- The CLI request and response contract.

Set `SHRIIIPSY_SKIP_SLOW=1` to skip the lordif and blavaan tests.
