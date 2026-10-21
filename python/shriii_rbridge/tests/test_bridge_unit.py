"""Bridge unit tests that need neither R nor Docker (request building, result parsing, runners, thresholds)."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pyarrow.parquet as pq
import pytest
from shriii_rbridge import (
    REQUEST_SCHEMA,
    RESULT_SCHEMA,
    DockerRunner,
    LocalRscriptRunner,
    RRunError,
    RscriptBackend,
    ThresholdSet,
    project_thresholds,
)
from shriii_rbridge.convert import as_dataframe, result_from_json, write_parquet
from shriii_validation.params import load_gates, load_validation_params
from shriii_validation.rbackend import RBackend


def _response(**over: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "schema": RESULT_SCHEMA,
        "analysis": "ICC_A1",
        "estimate": 0.29,
        "ci_low": 0.02,
        "ci_high": 0.76,
        "ci_level": 0.95,
        "n": 6,
        "method": "irr_icc_twoway_agreement_single",
        "status": "ok",
        "assumptions": [{"name": "converged", "passed": True, "statistic": None, "detail": "x"}],
        "warnings": ["w1"],
        "details": {"k": 4},
        "provenance": {
            "analysis": "icc_a1",
            "algorithm_version": "shriiipsy-0.1.0",
            "computed_at": "2026-10-21T00:00:00+00:00",
            "inputs_sha256": "ab" * 32,
            "seed": 1,
            "params": {"kind": "icc_a1"},
            "library_versions": {"R": "4.6.1", "blavaan": None},
        },
        "run_id": "r1",
    }
    base.update(over)
    return base


class FakeRunner:
    """Test double: records the request and returns a canned response (or raises)."""

    kind = "fake"

    def __init__(self, response: dict[str, Any] | None = None, error: RRunError | None = None) -> None:
        self.response = response
        self.error = error
        self.requests: list[dict[str, Any]] = []
        self.frames: list[pd.DataFrame] = []

    def describe(self) -> dict[str, Any]:
        return {"runner": self.kind}

    def run(self, workdir: Path, *, timeout: float | None = None) -> dict[str, Any]:
        req = json.loads((workdir / "request.json").read_text(encoding="utf-8"))
        self.requests.append(req)
        self.frames.append(pq.read_table(workdir / req["data"]["path"]).to_pandas())
        if self.error is not None:
            raise self.error
        assert self.response is not None
        return self.response


def test_result_from_json_builds_typed_evidence() -> None:
    r = result_from_json(_response(), extra_details={"r_backend": {"runner": "docker"}})
    assert r.ok
    assert r.est == pytest.approx(0.29)
    assert (r.lo, r.hi, r.ci_level, r.n) == (0.02, 0.76, 0.95, 6)
    assert r.assumptions[0].name == "converged" and r.assumptions[0].passed
    assert r.warnings == ("w1",)
    assert r.details["k"] == 4 and r.details["r_backend"]["runner"] == "docker"
    assert r.provenance is not None
    assert r.provenance.seed == 1
    assert r.provenance.library_versions == {"R": "4.6.1", "blavaan": None}
    assert r.to_dict()["provenance"]["inputs_sha256"] == "ab" * 32


def test_result_from_json_fails_closed() -> None:
    assert result_from_json(_response(schema="other/2")).status == "failed"
    no_est = result_from_json(_response(estimate=None))
    assert no_est.status == "failed" and not no_est.ok
    assert any("without a finite estimate" in w for w in no_est.warnings)
    weird = result_from_json(_response(status="bogus"))
    assert weird.status == "failed"
    empty_details = result_from_json(_response(details=[]))
    assert dict(empty_details.details) == {}


def test_as_dataframe_variants() -> None:
    arr = np.arange(6.0).reshape(3, 2)
    assert list(as_dataframe(arr).columns) == ["V1", "V2"]
    assert list(as_dataframe(arr, ["a", "b"]).columns) == ["a", "b"]
    df = as_dataframe({"x": [1, 2], "y": np.array([3.0, 4.0])})
    assert df.shape == (2, 2)
    assert list(as_dataframe(pd.DataFrame({"a": [1], "b": [2]}), ["b"]).columns) == ["b"]
    with pytest.raises(KeyError):
        as_dataframe({"x": [1]}, ["nope"])
    with pytest.raises(ValueError, match="2-D"):
        as_dataframe(np.arange(3))


def test_write_parquet_normalises_types(tmp_path: Path) -> None:
    df = pd.DataFrame(
        {"g": pd.Categorical(["a", "b", None]), "o": ["x", None, 3], "b": [True, False, True], "v": [1.0, np.nan, 2]}
    )
    out = pq.read_table(write_parquet(df, tmp_path / "d.parquet")).to_pandas()
    assert out["g"].tolist()[:2] == ["a", "b"] and out["g"].isna().iloc[2]
    assert out["o"].tolist()[0] == "x" and out["o"].tolist()[2] == "3"
    assert out["b"].tolist() == [1, 0, 1]


def test_project_thresholds_mirror_yaml() -> None:
    ts = project_thresholds()
    prm = load_validation_params()
    gates, gates_sha = load_gates()
    o = ts.overrides
    assert o["invariance"]["delta_cfi_max_drop"] == prm.f("invariance.delta_cfi_max_drop")
    assert o["invariance"]["delta_srmr_metric_max"] == prm.f("invariance.delta_srmr_metric_max")
    inv = gates["trait_gate"]["invariance"]
    assert o["invariance"]["max_freed_parameter_share"] == inv["max_freed_parameter_share"]
    assert o["invariance"]["small_group_n"] == gates["trait_gate"]["invariance"]["small_group_n"]
    assert o["dif"]["fdr_alpha"] == prm.f("dif.fdr_alpha")
    assert o["norming"]["percentiles"] == prm.get("norming.percentiles")
    assert o["slopes"]["reliability_min"] == gates["trait_gate"]["reliability"]["point_min"]
    assert ts.sources == {"validation_params_sha256": prm.sha256, "gates_sha256": gates_sha}


def test_backend_builds_requests_and_satisfies_protocol() -> None:
    fake = FakeRunner(_response(analysis="measurement_invariance", estimate=3.0))
    b = RscriptBackend(fake, thresholds=ThresholdSet({"invariance": {"delta_cfi_max_drop": 0.01}}, {"x": "1"}))
    assert isinstance(b, RBackend)
    assert b.name == "rscript-fake"
    df = pd.DataFrame({"x1": [1.0, 2.0], "school": ["a", "b"]})
    r = b.invariance_lavaan(df, "f =~ x1", "school", partial={"max_freed_share": 0.25})
    assert r.ok and r.details["r_backend"]["threshold_sources"] == {"x": "1"}
    req = fake.requests[-1]
    assert req["schema"] == REQUEST_SCHEMA
    assert req["analysis"] == "measurement_invariance"
    assert req["params"]["model"] == "f =~ x1"
    assert req["params"]["partial"] == {"max_freed_share": 0.25}
    assert "estimator" not in req["params"]  # None values are dropped so R picks MLR / WLSMV
    assert req["thresholds"] == {"invariance": {"delta_cfi_max_drop": 0.01}}
    assert req["seed"] == 20261021
    assert fake.frames[-1]["school"].tolist() == ["a", "b"]


def test_backend_irt_dif_and_norms_requests() -> None:
    fake = FakeRunner(_response(analysis="irt_dif", estimate=0.25))
    b = RscriptBackend(fake, thresholds=ThresholdSet({}))
    b.irt_dif_mirt(np.zeros((4, 3)), ["a", "a", "b", "b"], anchors=["V1"])
    req = fake.requests[-1]
    assert req["params"] == {"group": "group", "items": ["V1", "V2", "V3"], "anchors": ["V1"], "itemtype": "graded"}
    assert fake.frames[-1]["group"].tolist() == ["a", "a", "b", "b"]
    with pytest.raises(ValueError, match="one entry per response row"):
        b.irt_dif_mirt(np.zeros((4, 3)), ["a"])
    b.continuous_norms(
        [1.0, 2.0], [20, 30], method="gamlss", margins={"sex": {"f": 0.5, "m": 0.5}}, strata={"sex": ["f", "m"]}
    )
    req = fake.requests[-1]
    assert req["params"]["method"] == "GAMLSS"
    assert req["params"]["margins"] == {"sex": {"f": 0.5, "m": 0.5}}
    assert "weights" not in req["params"]
    with pytest.raises(ValueError, match="strata"):
        b.continuous_norms([1.0], [20], margins={"sex": {"f": 1.0}})


def test_runner_errors_become_failed_results() -> None:
    fake = FakeRunner(error=RRunError("boom", returncode=2, stderr="Error in x"))
    r = RscriptBackend(fake, thresholds=ThresholdSet({})).irt_grm(np.ones((5, 3)))
    assert r.status == "failed" and r.estimate is None
    assert "boom" in r.warnings[0] and "Error in x" in r.warnings[0]


def test_workdirs_are_removed(tmp_path: Path) -> None:
    fake = FakeRunner(_response())
    seen: list[Path] = []
    orig = fake.run

    def spy(workdir: Path, *, timeout: float | None = None) -> dict[str, Any]:
        seen.append(workdir)
        return orig(workdir, timeout=timeout)

    fake.run = spy  # type: ignore[method-assign]
    RscriptBackend(fake, thresholds=ThresholdSet({})).reliability_cross_check(np.ones((4, 2)), "icc_a1")
    assert seen and not seen[0].exists()


def test_runner_commands(tmp_path: Path) -> None:
    cmd = DockerRunner(image="img:1", memory="2g").command(tmp_path)
    assert cmd[:5] == ["docker", "run", "--rm", "--network", "none"]
    assert f"type=bind,source={tmp_path.resolve()},target=/work" in cmd
    assert cmd[-6:] == ["img:1", "run", "--request", "/work/request.json", "--response", "/work/response.json"]
    assert ("--user" in cmd) == (sys.platform != "win32")
    # hardening: never pull implicitly, no capabilities, read-only root, named so a timeout can kill it
    joined = " ".join(cmd)
    for flag in ("--pull never", "--cap-drop ALL", "--security-opt no-new-privileges", "--read-only"):
        assert flag in joined
    named = DockerRunner(image="img:1").command(tmp_path, name="shriiipsy-abc")
    assert named[named.index("--name") + 1] == "shriiipsy-abc"
    assert "--name" not in cmd
    lcmd = LocalRscriptRunner("Rscript").command(tmp_path)
    assert lcmd[0] == "Rscript" and "shriiipsy::cli_main" in lcmd[2]
    assert lcmd[-1] == str(tmp_path / "response.json")


def test_missing_response_raises_run_error(tmp_path: Path) -> None:
    runner = LocalRscriptRunner(sys.executable)
    with pytest.raises(RRunError):
        # python -e is invalid, so the process fails without writing response.json
        runner.run(tmp_path, timeout=60)


def test_docker_timeout_kills_the_container(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[list[str]] = []

    def fake_run(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        calls.append(cmd)
        if cmd[1] == "run":
            raise subprocess.TimeoutExpired(cmd, kwargs.get("timeout") or 0)
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr(subprocess, "run", fake_run)
    with pytest.raises(RRunError, match="timed out"):
        DockerRunner(image="img:1").run(tmp_path, timeout=1)
    name = calls[0][calls[0].index("--name") + 1]
    assert calls[1] == ["docker", "kill", name]
