# shriii-rbridge

This package provides the `RBackend` implementation for `shriii_validation`. It runs the
[`shriiipsy`](../../r/psychometrics/README.md) R package in one of two ways:

- **Docker:** through the pinned image `shriii/r-psychometrics:0.1.0`, run with `--network none` and a bind-mounted temp directory. The container never pulls an image implicitly (`--pull never`), drops all capabilities, disables privilege escalation and has a read-only root filesystem with a tmpfs `/tmp`. Each run has a unique container name, so a run that times out is killed instead of left running.
- **Local:** through a local `Rscript` that has shriiipsy installed.

```python
from shriii_rbridge import backend_from_env

r = backend_from_env()  # RscriptBackend, or UnavailableRBackend with the reason
res = r.invariance_lavaan(df, "f =~ y1 + y2 + y3 + y4", "language", ordered=["y1", "y2", "y3", "y4"])
res.details["decision"]  # e.g. "partial_scalar"; res.estimate = level code
```

The `RBackend` protocol methods are `invariance_lavaan`, `irt_dif_mirt`, `continuous_norms` and
`bayesian_approximate_invariance`. Further typed wrappers are `irt_grm`, `ordinal_logistic_dif`,
`glmm_dif`, `person_random_slopes` and `reliability_cross_check`. `run(analysis, data, params)` calls
any analysis directly.

- **Thresholds:** every request carries the thresholds from `scoring/gates.yaml` and
  `validation_params.yaml` (`project_thresholds()`). The documents' SHA-256 hashes are recorded in
  `details["r_backend"]["threshold_sources"]`.
- **Failures:** if the process fails, a timeout occurs or the schema doesn't match, you get
  `status="failed"` with the reason. The backend never falls back silently to another method.
- **Configuration:** `SHRIII_R_RUNNER` takes `auto` (default: local Rscript first, then Docker),
  `docker` or `local`. `SHRIII_R_IMAGE` overrides the image tag.

Tests that need R are marked `@pytest.mark.r`. They skip cleanly when Docker or the image is missing.

```sh
docker build -f infra/docker/r-psychometrics.Dockerfile -t shriii/r-psychometrics:0.1.0 r/psychometrics
uv run pytest python/shriii_rbridge/tests            # unit + R tests
uv run pytest python/shriii_rbridge/tests -m "not r" # no R needed
```
