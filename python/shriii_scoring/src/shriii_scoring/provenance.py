"""Scoring-run lineage (SCR-13): a manifest that makes every indicator row reproducible.

The run id is content-addressed (UUIDv5 over the input event streams, trial parameters, dictionary and
parameter hashes, algorithm version and partition keys), so re-running the same inputs yields the same id
and values within 1e-8.
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import subprocess
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from importlib import metadata
from pathlib import Path
from typing import Any

__all__ = ["RUN_NAMESPACE", "ScoringRunManifest", "environment_fingerprint", "git_sha", "hash_json"]

RUN_NAMESPACE = uuid.UUID("5b1d3f0e-9c4a-5d2e-8f7b-3a6c1e0d9b42")
_THREAD_VARS = ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS")
_PACKAGES = ("numpy", "scipy", "pandas", "polars", "statsmodels", "pyyaml", "shriii-scoring", "shriii-contracts")


def hash_json(obj: Any) -> str:
    """SHA-256 of a canonical JSON encoding (sorted keys, no whitespace)."""
    return hashlib.sha256(json.dumps(obj, sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest()


def git_sha(start: Path | None = None) -> str | None:
    """Current git commit of the repository, or None outside a work tree / without git."""
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=str(start or Path(__file__).resolve().parent),
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    sha = out.stdout.strip()
    return sha if out.returncode == 0 and len(sha) == 40 else None


def environment_fingerprint() -> dict[str, Any]:
    """Library versions, Python/platform and BLAS/thread settings relevant to numeric reproducibility."""
    versions: dict[str, str | None] = {}
    for pkg in _PACKAGES:
        try:
            versions[pkg] = metadata.version(pkg)
        except metadata.PackageNotFoundError:
            versions[pkg] = None
    blas: list[dict[str, Any]] = []
    try:
        from threadpoolctl import threadpool_info  # type: ignore[import-untyped]  # noqa: PLC0415

        blas = [
            {k: v for k, v in i.items() if k in ("internal_api", "num_threads", "version")} for i in threadpool_info()
        ]
    except ImportError:
        blas = []
    return {
        "python": platform.python_version(),
        "platform": platform.platform(),
        "packages": versions,
        "threads_env": {k: os.environ.get(k) for k in _THREAD_VARS},
        "blas": blas,
    }


@dataclass(frozen=True, slots=True)
class ScoringRunManifest:
    """Lineage record for one scoring run."""

    scoring_run_id: str
    created_at: str
    algorithm_version: str
    dictionaries: Mapping[str, Mapping[str, Any]]
    params_sha256: str
    params_version: str
    input_sha256: str
    trial_params_sha256: str
    partition_keys: tuple[str, ...]
    partition_hashes: Mapping[str, str]
    n_sessions: int
    exploratory: bool
    allow_synthetic: bool
    erasures: int
    git_sha: str | None
    environment: Mapping[str, Any]
    seeds: Mapping[str, Any] = field(default_factory=dict)
    consistency_warnings: Sequence[str] = field(default_factory=tuple)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @staticmethod
    def build(
        *,
        algorithm_version: str,
        dictionaries: Mapping[str, Mapping[str, Any]],
        params_sha256: str,
        params_version: str,
        session_hashes: Mapping[str, str],
        trial_params: Any,
        partition_keys: Sequence[str],
        partition_hashes: Mapping[str, str],
        allow_synthetic: bool,
        erasures: int,
        consistency_warnings: Sequence[str],
        created_at: datetime | None = None,
    ) -> ScoringRunManifest:
        input_sha = hash_json(sorted(session_hashes.items()))
        tp_sha = hash_json(trial_params or {})
        key = hash_json(
            {
                "alg": algorithm_version,
                "dict": dictionaries,
                "params": params_sha256,
                "input": input_sha,
                "trial_params": tp_sha,
                "partition_keys": list(partition_keys),
                "allow_synthetic": allow_synthetic,
            }
        )
        exploratory = any(not d.get("frozen", False) for d in dictionaries.values())
        return ScoringRunManifest(
            scoring_run_id=str(uuid.uuid5(RUN_NAMESPACE, key)),
            created_at=(created_at or datetime.now(UTC)).isoformat(),
            algorithm_version=algorithm_version,
            dictionaries=dictionaries,
            params_sha256=params_sha256,
            params_version=params_version,
            input_sha256=input_sha,
            trial_params_sha256=tp_sha,
            partition_keys=tuple(partition_keys),
            partition_hashes=dict(partition_hashes),
            n_sessions=len(session_hashes),
            exploratory=exploratory,
            allow_synthetic=allow_synthetic,
            erasures=erasures,
            git_sha=git_sha(),
            environment=environment_fingerprint(),
            consistency_warnings=tuple(consistency_warnings),
        )
