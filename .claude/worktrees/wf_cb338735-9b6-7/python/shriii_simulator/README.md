# shriii-simulator

Synthetic players with known latent trait parameters (QA-02). Simulator data is always marked
`context.synthetic = true`; the indicator engine excludes it unless `allow_synthetic=True`.

```python
from shriii_simulator import simulate_study
from shriii_simulator.recovery import run_recovery

study = simulate_study(400, "B", seed=1, occasions=2, stability=0.7)  # events + trial params + truth
report = run_recovery(400, "A", seed=11)  # parameter-recovery harness
```

* **Population** (`population.py`): 17 latent traits, multivariate normal with the correlation matrix in
  `data/simulator.yaml`; nuisance ability, motor speed, language, literacy, age, education, gender, device
  familiarity; gaming strategies (speed tapper, same-position tapper, always-share, over-reporter) and an
  optimal bot; retest latents with a chosen stability.
* **Sessions** (`session.py`, `modules_a.py`, `modules_b.py`): contract-valid event streams for every
  Pathway B module (with the planned-missingness slot fixed per person) and Pathway A episode (plus the
  co-play substudy): ex-Gaussian go RTs, commission errors, BART pumps with seeded explosion points,
  Tower moves against a solver optimum, card-sort perseveration, conditional cooperation, hyperbolic delay
  and effort discounting, holds, tone choices with regulation / mirroring / drift, dilemmas, credit and
  blame, private reports with group-level over-reporting, probe segments with persistent style, walkaways
  and timing glitches.
* **Criterion battery** (`criterion.py`): congeneric item responses from scale true scores with known
  loadings (reverse-keyed items answered on the raw scale), rotating blocks A/B/C, attention checks,
  ToL board and criterion card sort, optional item DIF; score pairs with a planted ICC(A,1) and practice
  shift; 2PL item responses with planted uniform / non-uniform DIF and impact.
* **Recovery** (`recovery.py`): two parallel occasions with identical latents, scored by the real engine;
  `r(construct-keyed estimate, latent)` against `sqrt(parallel-form reliability) - .05`, model-based slope
  reliability against parallel-form reliability. Recovery shows the pipeline is internally correct; it is
  not evidence that the games measure the traits.

All generative coefficients live in `data/simulator.yaml` (override with `SimParams.with_overrides`).
