"""Provenance and analysis context for layer-4 jobs (BUILD_DECISIONS non-negotiable 9).

Every validation result records the snapshot it was computed from (id and Parquet sha256), the scoring
dictionary, gates and hypotheses hashes, the engine's algorithm version and the source revision (git sha),
so any coefficient can be traced back and recomputed from raw events.
"""

from __future__ import annotations

import subprocess
from functools import lru_cache
from typing import Any

from shriii_contracts.paths import repo_root

import shriii_api
from shriii_api import content
from shriii_api.adapters import validation as validation_adapter
from shriii_api.db.models.validation import DatasetSnapshot
from shriii_api.settings import Settings


@lru_cache(maxsize=1)
def _git_head() -> str | None:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=repo_root(),
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    sha = out.stdout.strip()
    if out.returncode != 0 or len(sha) != 40:
        return None
    dirty = subprocess.run(
        ["git", "status", "--porcelain", "--untracked-files=no"],
        cwd=repo_root(),
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    return f"{sha}-dirty" if dirty.returncode == 0 and dirty.stdout.strip() else sha


def git_sha(settings: Settings) -> str:
    """``GIT_SHA`` when configured, else the checkout's HEAD (``-dirty`` with local changes), else ``unknown``."""
    return settings.git_sha or _git_head() or "unknown"


def dictionary_hashes() -> dict[str, str]:
    return {
        "shared": content.dictionary_shared().sha256,
        **{p: content.dictionary_pathway(p).sha256 for p in ("A", "B")},
    }


def base_provenance(settings: Settings, snapshot: DatasetSnapshot | None = None) -> dict[str, Any]:
    """Provenance shared by every layer-4 row produced from ``snapshot``."""
    prov: dict[str, Any] = {
        "git_sha": git_sha(settings),
        "api_version": shriii_api.__version__,
        "validation_engine": validation_adapter.engine_version(),
        "dictionary_sha256": dictionary_hashes(),
        "dictionary_version": str(content.dictionary_shared().data.get("version")),
        "gates_sha256": content.gates().sha256,
        "gates_version": str(content.gates().data.get("version")),
        "hypotheses_sha256": content.hypotheses().sha256,
        "hypotheses_version": str(content.hypotheses().data.get("version")),
    }
    if snapshot is not None:
        prov.update(
            {
                "snapshot_id": str(snapshot.snapshot_id),
                "snapshot_sha256": snapshot.sha256,
                "snapshot_version": snapshot.version,
                "snapshot_status": snapshot.status,
                "snapshot_dictionary_sha256": snapshot.manifest.get("dictionary_sha256"),
            }
        )
    return prov


def dictionary_context(pathway: str | None) -> dict[str, Any]:
    """Dictionary indicators (of ``pathway`` or both), shared constructs and shared parameters."""
    pathways = [pathway] if pathway in ("A", "B") else ["A", "B"]
    indicators: list[dict[str, Any]] = []
    seen: set[str] = set()
    for p in pathways:
        for ind in content.dictionary_pathway(p).data.get("indicators", []):
            if ind["id"] not in seen:
                seen.add(ind["id"])
                indicators.append(dict(ind))
    shared = content.dictionary_shared().data
    return {
        "indicators": indicators,
        "constructs": {c["id"]: dict(c) for c in shared.get("constructs", [])},
        "shared_params": {k: shared[k] for k in ("private_report",) if k in shared},
    }


def analysis_context(
    settings: Settings, snapshot: DatasetSnapshot, *, hypothesis_ids: list[str], pathway: str | None = None
) -> dict[str, Any]:
    """The ``context`` the validation engine receives for an analysis of ``snapshot``."""
    pw = pathway or snapshot.spec.get("pathway")
    return {
        **dictionary_context(pw),
        "gates": content.gates().data,
        "hypotheses": content.hypotheses().data,
        "hypothesis_ids": list(hypothesis_ids),
        "pathway": pw,
        "snapshot_exclusions": dict(snapshot.exclusions or {}),
        "provenance": base_provenance(settings, snapshot),
    }
