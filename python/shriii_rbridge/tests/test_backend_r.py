"""End-to-end tests against the shriiipsy R backend (Docker image or local Rscript); marked ``r``."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest
from scipy import stats
from shriii_rbridge import RscriptBackend, backend_from_env
from shriii_validation.rbackend import RBackend
from shriii_validation.reliability import cronbach_alpha, icc

pytestmark = pytest.mark.r

HS_MODEL = "visual =~ x1 + x2 + x3\ntextual =~ x4 + x5 + x6\nspeed =~ x7 + x8 + x9"


@pytest.fixture(scope="module")
def hs() -> pd.DataFrame:
    from semopy.examples import holzinger39  # noqa: PLC0415

    return holzinger39.get_data()[["school", *[f"x{i}" for i in range(1, 10)]]]


def _steps(r: object) -> dict[str, dict[str, object]]:
    return {s["step"]: s for s in r.details["steps"]}  # type: ignore[attr-defined]


def test_backend_from_env_is_an_rbackend() -> None:
    b = backend_from_env()
    assert isinstance(b, RscriptBackend)
    assert isinstance(b, RBackend)


def test_holzinger_swineford_invariance_reference_values(r_backend: RscriptBackend, hs: pd.DataFrame) -> None:
    """lavaan tutorial: configural 115.851/48, metric 124.044/54, scalar 164.103/60; x3 and x7 intercepts."""
    r = r_backend.invariance_lavaan(hs, HS_MODEL, "school", estimator="ML", partial={"max_freed_share": 0.25})
    assert r.status == "ok", r.warnings
    s = _steps(r)
    assert s["configural"]["chisq"] == pytest.approx(115.851, abs=2e-3)
    assert s["metric"]["chisq"] == pytest.approx(124.044, abs=2e-3)
    assert s["scalar"]["full_model"]["chisq"] == pytest.approx(164.103, abs=2e-3)  # type: ignore[index]
    assert sorted(s["scalar"]["freed"]) == ["x3~1", "x7~1"]  # type: ignore[arg-type]
    assert r.details["decision"] == "partial_scalar"
    assert r.est == 3
    assert r.provenance is not None and r.provenance.library_versions["lavaan"]
    assert r.details["r_backend"]["runner"] in ("docker", "local")


def test_gates_yaml_cap_on_freed_parameters_reaches_r(r_backend: RscriptBackend, hs: pd.DataFrame) -> None:
    """gates.yaml max_freed_parameter_share = 0.20 allows 1 of 9 intercepts, so scalar invariance fails."""
    r = r_backend.invariance_lavaan(hs, HS_MODEL, "school", estimator="ML")
    assert r.details["decision"] == "metric"
    assert r.details["passes_required_level"] is False
    assert r.details["thresholds"]["max_freed_parameter_share"] == pytest.approx(0.20)


def test_r_and_python_agree_on_icc_alpha_and_r(r_backend: RscriptBackend) -> None:
    """VAL-01 AC: R and Python agree within 1e-6 on alpha, ICC(A,1) and r."""
    rng = np.random.default_rng(3)
    f = rng.normal(size=120)
    ratings = np.column_stack([f + rng.normal(0, 0.6, 120) + shift for shift in (0.0, 0.3, -0.2)])
    py_a1 = icc(ratings, "ICC_A1")
    r_a1 = r_backend.reliability_cross_check(ratings, "icc_a1")
    assert r_a1.est == pytest.approx(py_a1.est, abs=1e-6)
    assert r_a1.lo == pytest.approx(py_a1.lo, abs=1e-6)
    assert r_a1.hi == pytest.approx(py_a1.hi, abs=1e-6)
    py_c1 = icc(ratings, "ICC_C1")
    r_c1 = r_backend.reliability_cross_check(ratings, "icc_c1")
    assert r_c1.est == pytest.approx(py_c1.est, abs=1e-6)
    items = np.column_stack([f + rng.normal(0, 1, 120) for _ in range(6)])
    py_alpha = cronbach_alpha(items)
    r_alpha = r_backend.reliability_cross_check(items, "alpha")
    assert r_alpha.est == pytest.approx(py_alpha.est, abs=1e-6)
    assert r_alpha.lo == pytest.approx(py_alpha.lo, abs=1e-6)
    assert r_alpha.hi == pytest.approx(py_alpha.hi, abs=1e-6)
    xy = pd.DataFrame({"x": items[:, 0], "y": items[:, 1]})
    r_r = r_backend.reliability_cross_check(xy, "pearson", x="x", y="y")
    assert r_r.est == pytest.approx(stats.pearsonr(xy["x"], xy["y"])[0], abs=1e-6)


def _simulate_grm(rng: np.random.Generator, theta: np.ndarray, a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Graded response model: P(X >= k) = logistic(a (theta - b_k))."""
    p_ge = 1.0 / (1.0 + np.exp(-a[None, :, None] * (theta[:, None, None] - b[None, :, :])))
    u = rng.random((theta.size, a.size, 1))
    return (u < p_ge).sum(axis=2)


def test_irt_dif_detects_planted_item(r_backend: RscriptBackend) -> None:
    rng = np.random.default_rng(11)
    n_items, n = 8, 700
    a = rng.uniform(1.0, 2.0, n_items)
    b = np.sort(rng.normal(0, 0.3, (n_items, 3)) + np.array([-1.0, 0.0, 1.0]), axis=1)
    b_focal = b.copy()
    b_focal[4] += 0.9  # item i5 harder for the focal group at equal theta
    ref = _simulate_grm(rng, rng.normal(size=n), a, b)
    foc = _simulate_grm(rng, rng.normal(-0.4, 1, size=n), a, b_focal)
    resp = pd.DataFrame(np.vstack([ref, foc]), columns=[f"i{k + 1}" for k in range(n_items)])
    group = ["ref"] * n + ["focal"] * n
    r = r_backend.irt_dif_mirt(resp, group)
    assert r.status == "ok", r.warnings
    assert r.details["flagged"] == ["i5"]
    assert "i5" not in r.details["anchors"]


def test_glmm_dif_and_composure_slopes(r_backend: RscriptBackend) -> None:
    rng = np.random.default_rng(5)
    n_person, n_items = 240, 10
    grp = np.where(np.arange(n_person) % 2 == 0, "A", "B")
    theta = rng.normal(size=n_person) - 0.4 * (grp == "B")
    bdiff = np.linspace(-1.5, 1.5, n_items)
    pp, ii = np.meshgrid(np.arange(n_person), np.arange(n_items), indexing="ij")
    eta = theta[pp] - bdiff[ii] + 1.3 * ((ii == 2) & (grp[pp] == "B"))
    trials = pd.DataFrame(
        {
            "person": [f"p{p}" for p in pp.ravel()],
            "item": [f"s{i:02d}" for i in ii.ravel()],
            "group": grp[pp.ravel()],
            "correct": (rng.random(eta.size) < 1 / (1 + np.exp(-eta.ravel()))).astype(int),
        }
    )
    dif = r_backend.glmm_dif(trials, person="person", item="item", group="group", response="correct")
    assert dif.status == "ok", dif.warnings
    assert dif.details["flagged"] == ["s02"]

    n_p, n_t = 150, 60
    b0 = rng.normal(2.6, 0.6, n_p)
    b1 = rng.normal(-0.8, 0.7, n_p)
    person = np.repeat(np.arange(n_p), n_t)
    pressure = np.tile((np.arange(n_t) >= n_t // 2).astype(int), n_p)
    p = 1 / (1 + np.exp(-(b0[person] + b1[person] * pressure)))
    slopes_df = pd.DataFrame(
        {
            "person": [f"p{x}" for x in person],
            "condition": np.where(pressure == 1, "pressure", "calm"),
            "correct": (rng.random(p.size) < p).astype(int),
        }
    )
    sl = r_backend.person_random_slopes(
        slopes_df, person="person", condition="condition", response="correct", focal="pressure", bootstrap_n=10
    )
    assert sl.status == "ok", sl.warnings
    assert 0.0 < sl.est < 1.0
    assert sl.details["fixed_slope"]["estimate"] == pytest.approx(-0.8, abs=0.3)
    assert len(sl.details["person_slopes"]) == n_p


def test_weighted_gamlss_norms(r_backend: RscriptBackend) -> None:
    rng = np.random.default_rng(9)
    n = 900
    age = rng.uniform(18, 70, n)
    score = rng.normal(20 + 0.15 * age, 3 + 0.02 * age)
    sex = rng.choice(["f", "m"], n, p=[0.35, 0.65])
    r = r_backend.continuous_norms(
        score,
        age,
        method="GAMLSS",
        margins={"sex": {"f": 0.5, "m": 0.5}},
        strata={"sex": sex},
        norm_table_version="pytest-1",
    )
    assert r.status == "ok", r.warnings
    assert r.details["publishable"] is True
    assert r.details["norm_status"] == "provisional"
    assert r.details["effective_n"] < n
    assert len(r.details["norm_table"]) == 25 * 7


def test_grm_and_failure_reporting(r_backend: RscriptBackend) -> None:
    rng = np.random.default_rng(2)
    a = np.array([0.9, 1.3, 1.7, 2.1, 1.1])
    b = np.sort(rng.normal(0, 0.2, (5, 2)) + np.array([-0.7, 0.7]), axis=1)
    resp = pd.DataFrame(_simulate_grm(rng, rng.normal(size=1500), a, b), columns=list("abcde"))
    g = r_backend.irt_grm(resp)
    assert g.status == "ok"
    got = [it["parameters"]["a"] for it in g.details["items"]]
    assert np.corrcoef(got, a)[0, 1] > 0.9
    bad = r_backend.invariance_lavaan(resp.assign(g=["x", "y"] * 750), "f =~ nope1 + nope2", "g")
    assert bad.status == "failed"
    assert any("indicator" in w for w in bad.warnings)
