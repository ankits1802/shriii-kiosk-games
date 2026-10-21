"""``RscriptBackend``: the :class:`shriii_validation.rbackend.RBackend` implementation over shriiipsy.

Every call writes the input table as Parquet plus a ``request.json`` into a private temporary directory,
runs the shriiipsy CLI through a runner (pinned Docker image or local Rscript) and converts the typed JSON
result into an :class:`EvidenceResult`. Process failures become ``status="failed"`` results with the
reason; nothing falls back silently to a different method.
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import uuid
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, Literal

from shriii_validation.rbackend import RBackend, UnavailableRBackend
from shriii_validation.results import EvidenceResult

from shriii_rbridge._version import BRIDGE_VERSION, DEFAULT_IMAGE, REQUEST_SCHEMA
from shriii_rbridge.convert import as_dataframe, result_from_json, write_parquet
from shriii_rbridge.runner import (
    DockerRunner,
    LocalRscriptRunner,
    RRunError,
    RRunner,
    docker_available,
    docker_image_present,
    local_shriiipsy_available,
)
from shriii_rbridge.thresholds import ThresholdSet, project_thresholds

__all__ = ["RscriptBackend", "backend_from_env"]

GROUP_COLUMN = "group"
DEFAULT_TIMEOUT_S = 3600.0
CrossCheckKind = Literal["icc_a1", "icc_c1", "alpha", "pearson"]


def _clean(params: Mapping[str, Any]) -> dict[str, Any]:
    """Drop ``None`` values and turn tuples into lists for JSON."""
    out: dict[str, Any] = {}
    for k, v in params.items():
        if v is None:
            continue
        out[k] = list(v) if isinstance(v, tuple) else v
    return out


class RscriptBackend:
    """Runs shriiipsy analyses; satisfies the ``RBackend`` protocol and adds typed wrappers for the rest."""

    def __init__(
        self,
        runner: RRunner | None = None,
        *,
        thresholds: ThresholdSet | None = None,
        timeout: float = DEFAULT_TIMEOUT_S,
        seed: int | None = 20261021,
        keep_workdirs: bool = False,
    ) -> None:
        self.runner: RRunner = runner or DockerRunner()
        self.name = f"rscript-{self.runner.kind}"
        self.thresholds = thresholds if thresholds is not None else project_thresholds()
        self.timeout = timeout
        self.seed = seed
        self.keep_workdirs = keep_workdirs

    # ------------------------------------------------------------------ generic execution

    def run(
        self,
        analysis: str,
        data: Any,
        params: Mapping[str, Any],
        *,
        columns: Sequence[str] | None = None,
        seed: int | None = None,
        thresholds: Mapping[str, Any] | None = None,
    ) -> EvidenceResult:
        """Run any shriiipsy analysis on ``data`` (DataFrame / mapping / 2-D array) with ``params``."""
        run_id = uuid.uuid4().hex
        workdir = Path(tempfile.mkdtemp(prefix="shriiipsy-"))
        try:
            df = as_dataframe(data, columns)
            write_parquet(df, workdir / "data.parquet")
            th: dict[str, Any] = {k: dict(v) for k, v in self.thresholds.overrides.items()}
            for section, values in (thresholds or {}).items():
                th.setdefault(section, {}).update(values)
            request = {
                "schema": REQUEST_SCHEMA,
                "analysis": analysis,
                "run_id": run_id,
                "data": {"path": "data.parquet", "format": "parquet"},
                "params": _clean(params),
                "thresholds": th,
                "seed": seed if seed is not None else self.seed,
            }
            (workdir / "request.json").write_text(json.dumps(request, allow_nan=False), encoding="utf-8")
            bridge = {
                "r_backend": {
                    **self.runner.describe(),
                    "bridge_version": BRIDGE_VERSION,
                    "run_id": run_id,
                    "threshold_sources": dict(self.thresholds.sources),
                }
            }
            try:
                raw = self.runner.run(workdir, timeout=self.timeout)
            except RRunError as exc:
                msg = str(exc) + (f"; stderr: {exc.stderr.strip()}" if exc.stderr.strip() else "")
                return EvidenceResult.unavailable(analysis, f"shriiipsy:{self.name}", msg, n=len(df), status="failed")
            return result_from_json(raw, extra_details=bridge)
        finally:
            if not self.keep_workdirs:
                shutil.rmtree(workdir, ignore_errors=True)

    # ------------------------------------------------------------------ RBackend protocol

    def invariance_lavaan(
        self,
        data: Any,
        model: str,
        group: str,
        *,
        estimator: str | None = None,
        ordered: Sequence[str] = (),
        partial: Mapping[str, Any] | None = None,
        levels: Sequence[str] = ("configural", "metric", "scalar"),
        missing: str | None = None,
        parameterization: str | None = None,
    ) -> EvidenceResult:
        """Multi-group CFA invariance (VAL-07/VAL-08a). ``estimate`` = level code (0 none ... 4 strict).

        ``partial`` keys: ``search`` (bool, default True), ``free`` (parameters freed a priori, lavaan
        syntax such as ``"x3~1"``), ``max_freed_share`` (default from gates.yaml), ``alpha``.
        """
        return self.run(
            "measurement_invariance",
            data,
            {
                "model": model,
                "group": group,
                "estimator": estimator,
                "ordered": list(ordered),
                "partial": dict(partial or {}),
                "levels": list(levels),
                "missing": missing,
                "parameterization": parameterization,
            },
        )

    def irt_dif_mirt(
        self,
        responses: Any,
        group: Sequence[str],
        *,
        anchors: Sequence[str] = (),
        itemtype: str = "graded",
    ) -> EvidenceResult:
        """Likelihood-ratio IRT DIF (mirt) with anchor selection; ``estimate`` = share of items flagged."""
        df = as_dataframe(responses)
        if len(group) != len(df):
            raise ValueError("group must have one entry per response row")
        if GROUP_COLUMN in df.columns:
            raise ValueError(f"response columns must not be named {GROUP_COLUMN!r}")
        items = list(df.columns)
        df[GROUP_COLUMN] = [str(g) for g in group]
        return self.run(
            "irt_dif", df, {"group": GROUP_COLUMN, "items": items, "anchors": list(anchors), "itemtype": itemtype}
        )

    def continuous_norms(
        self,
        scores: Any,
        age: Any,
        *,
        weights: Any = None,
        method: str = "cNORM",
        education: Any = None,
        margins: Mapping[str, Mapping[str, float]] | None = None,
        strata: Mapping[str, Sequence[str]] | None = None,
        family: str | None = None,
        norm_table_version: str | None = None,
    ) -> EvidenceResult:
        """Weighted continuous norms (VAL-11): cNORM (age) or GAMLSS (age + education).

        Supply ``weights`` (post-stratification weights) or ``margins`` (population shares per stratum
        variable) together with ``strata`` (the respondents' stratum values) for raking in R.
        """
        cols: dict[str, Any] = {"score": list(scores), "age": list(age)}
        if weights is not None:
            cols["weight"] = list(weights)
        if education is not None:
            cols["education"] = list(education)
        for var, values in (strata or {}).items():
            cols[var] = [str(v) for v in values]
        if margins and not strata:
            raise ValueError("margins need the matching strata columns")
        return self.run(
            "continuous_norms",
            cols,
            {
                "score": "score",
                "age": "age",
                "weights": "weight" if weights is not None else None,
                "education": "education" if education is not None else None,
                "margins": {k: dict(v) for k, v in margins.items()} if margins else None,
                "method": "GAMLSS" if method.upper() == "GAMLSS" else "cNORM",
                "family": family,
                "norm_table_version": norm_table_version,
            },
        )

    def bayesian_approximate_invariance(
        self,
        data: Any,
        model: str,
        group: str,
        *,
        wiggle: Sequence[str] = ("loadings", "intercepts"),
        ordered: Sequence[str] = (),
        chains: int | None = None,
        burnin: int | None = None,
        sample: int | None = None,
        wiggle_sd: float | None = None,
    ) -> EvidenceResult:
        """blavaan approximate invariance for small groups; ``estimate`` = posterior predictive p."""
        return self.run(
            "bayesian_approximate_invariance",
            data,
            {
                "model": model,
                "group": group,
                "wiggle": list(wiggle),
                "ordered": list(ordered),
                "chains": chains,
                "burnin": burnin,
                "sample": sample,
                "wiggle_sd": wiggle_sd,
            },
        )

    # ------------------------------------------------------------------ further typed wrappers

    def irt_grm(
        self, responses: Any, *, itemtype: str = "graded", return_scores: bool = False, id_column: str | None = None
    ) -> EvidenceResult:
        """Graded response model for a criterion scale; ``estimate`` = marginal reliability."""
        df = as_dataframe(responses)
        items = [c for c in df.columns if c != id_column]
        return self.run(
            "irt_grm", df, {"items": items, "itemtype": itemtype, "return_scores": return_scores, "id": id_column}
        )

    def ordinal_logistic_dif(self, responses: Any, group: Sequence[str]) -> EvidenceResult:
        """lordif ordinal logistic DIF with IRT-purified matching; ``estimate`` = share flagged."""
        df = as_dataframe(responses)
        if len(group) != len(df):
            raise ValueError("group must have one entry per response row")
        items = list(df.columns)
        df[GROUP_COLUMN] = [str(g) for g in group]
        return self.run("ordinal_logistic_dif", df, {"group": GROUP_COLUMN, "items": items})

    def glmm_dif(
        self,
        trials: Any,
        *,
        person: str,
        item: str,
        group: str,
        response: str,
        family: str = "binomial",
        covariates: Sequence[str] = (),
        transform: str | None = None,
        reference: str | None = None,
        omnibus: bool = True,
    ) -> EvidenceResult:
        """Explanatory IRT / GLMM DIF on trial-level data (VAL-08/09); ``estimate`` = share flagged."""
        return self.run(
            "glmm_dif",
            trials,
            {
                "person": person,
                "item": item,
                "group": group,
                "response": response,
                "family": family,
                "covariates": list(covariates),
                "transform": transform,
                "reference": reference,
                "omnibus": omnibus,
            },
        )

    def person_random_slopes(
        self,
        trials: Any,
        *,
        person: str,
        condition: str,
        response: str,
        family: str = "binomial",
        focal: str | None = None,
        item: str | None = None,
        covariates: Sequence[str] = (),
        transform: str | None = None,
        bootstrap_n: int | None = None,
        ci_level: float | None = None,
    ) -> EvidenceResult:
        """Person random slopes (e.g. composure accuracy under pressure); ``estimate`` = EB reliability."""
        return self.run(
            "person_random_slopes",
            trials,
            {
                "person": person,
                "condition": condition,
                "response": response,
                "family": family,
                "focal": focal,
                "item": item,
                "covariates": list(covariates),
                "transform": transform,
                "bootstrap_n": bootstrap_n,
                "ci_level": ci_level,
            },
        )

    def reliability_cross_check(
        self,
        data: Any,
        kind: CrossCheckKind,
        *,
        columns: Sequence[str] | None = None,
        x: str | None = None,
        y: str | None = None,
        ci_level: float | None = None,
    ) -> EvidenceResult:
        """R recomputation of ICC(A,1)/(C,1) (irr), alpha (psych) or Pearson r for the VAL-01 sidecar check."""
        df = as_dataframe(data)
        cols = list(columns) if columns is not None else (None if kind == "pearson" else list(df.columns))
        return self.run(
            "reliability_cross_check", df, {"kind": kind, "columns": cols, "x": x, "y": y, "ci_level": ci_level}
        )


def backend_from_env(image: str | None = None) -> RBackend:
    """The configured backend: ``SHRIII_R_RUNNER`` = ``docker`` | ``local`` | ``auto`` (default).

    ``auto`` prefers a local Rscript with shriiipsy installed, then the Docker image
    (``SHRIII_R_IMAGE``, default ``shriii/r-psychometrics:0.1.0``). When neither is usable it returns an
    :class:`UnavailableRBackend` explaining why.
    """
    mode = os.environ.get("SHRIII_R_RUNNER", "auto").lower()
    img = image or os.environ.get("SHRIII_R_IMAGE", DEFAULT_IMAGE)
    if mode in ("local", "auto") and local_shriiipsy_available():
        return RscriptBackend(LocalRscriptRunner(shutil.which("Rscript") or "Rscript"))
    if mode == "local":
        return UnavailableRBackend("SHRIII_R_RUNNER=local but no Rscript with the shriiipsy package was found.")
    if mode in ("docker", "auto"):
        if not docker_available():
            return UnavailableRBackend("Docker is not available and no local Rscript with shriiipsy was found.")
        if not docker_image_present(img):
            return UnavailableRBackend(
                f"Docker image {img} is missing; build it with "
                "`docker build -f infra/docker/r-psychometrics.Dockerfile -t " + img + " r/psychometrics`."
            )
        return RscriptBackend(DockerRunner(image=img))
    return UnavailableRBackend(f"unknown SHRIII_R_RUNNER value {mode!r} (use docker, local or auto)")
