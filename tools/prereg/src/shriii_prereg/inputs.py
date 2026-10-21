"""Locate and load the (read-only) pre-registration inputs and hash each one.

Hashes use the repository's canonical convention (``shriii_scoring.resources.sha256_bytes``: SHA-256 of the
file bytes with CRLF normalised to LF), so the values match ``validation.analysis_plans.*_sha256`` and the
scoring-run manifests regardless of the checkout's line-ending settings.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, cast

import yaml
from shriii_scoring.resources import sha256_bytes

__all__ = [
    "DEFAULT_CONFIG",
    "InputFile",
    "PreregInputs",
    "find_repo_root",
    "load_inputs",
]

DEFAULT_CONFIG = Path("tools") / "prereg" / "prereg.config.yaml"
"""Repository-relative default config: study metadata and planning (power) assumptions."""


@dataclass(frozen=True, slots=True)
class InputFile:
    """One hashed input document."""

    role: str
    """hypotheses | gates | dictionary.shared | dictionary.A | dictionary.B | config"""
    path: Path
    rel_path: str
    sha256: str
    data: Mapping[str, Any]

    @property
    def version(self) -> str | None:
        v = self.data.get("version")
        return None if v is None else str(v)

    @property
    def status(self) -> str | None:
        v = self.data.get("status")
        return None if v is None else str(v)

    @property
    def frozen_at(self) -> str | None:
        v = self.data.get("frozen_at")
        return None if v is None else str(v)

    def manifest_entry(self) -> dict[str, Any]:
        return {
            "role": self.role,
            "path": self.rel_path,
            "sha256": self.sha256,
            "version": self.version,
            "status": self.status,
            "frozen_at": self.frozen_at,
        }


@dataclass(frozen=True, slots=True)
class PreregInputs:
    """All inputs needed to build the document."""

    repo_root: Path
    hypotheses: InputFile
    gates: InputFile
    dictionaries: Mapping[str, InputFile]
    """keyed ``shared``, ``A``, ``B`` (pathway documents keyed by their ``pathway`` field)"""
    config: InputFile
    extra: Mapping[str, Any] = field(default_factory=dict)

    def all_files(self) -> list[InputFile]:
        files = [self.hypotheses, self.gates]
        files.extend(self.dictionaries[k] for k in sorted(self.dictionaries))
        files.append(self.config)
        return files

    @property
    def shared(self) -> Mapping[str, Any]:
        return self.dictionaries["shared"].data

    def pathway_dictionaries(self) -> dict[str, Mapping[str, Any]]:
        return {k: v.data for k, v in sorted(self.dictionaries.items()) if k != "shared"}


def find_repo_root(start: Path | None = None) -> Path:
    """Directory containing ``scoring/hypotheses.yaml`` (``SHRIII_REPO_ROOT`` overrides)."""
    env = os.environ.get("SHRIII_REPO_ROOT")
    if env:
        return Path(env).resolve()
    here = (start or Path(__file__)).resolve()
    for parent in [here, *here.parents]:
        if (parent / "scoring" / "hypotheses.yaml").is_file() and (parent / "scoring" / "gates.yaml").is_file():
            return parent
    raise FileNotFoundError("cannot locate the repository root (scoring/hypotheses.yaml); set SHRIII_REPO_ROOT")


def _rel(path: Path, root: Path) -> str:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return path.resolve().as_posix()


def _load(role: str, path: Path, root: Path) -> InputFile:
    if not path.is_file():
        raise FileNotFoundError(f"pre-registration input {role!r} not found: {path}")
    raw = path.read_bytes()
    data = yaml.safe_load(raw.decode("utf-8"))
    if not isinstance(data, Mapping):
        raise ValueError(f"{path} is not a YAML mapping")
    return InputFile(role=role, path=path.resolve(), rel_path=_rel(path, root), sha256=sha256_bytes(raw), data=data)


def load_inputs(
    scoring_dir: Path | None = None,
    config_path: Path | None = None,
    repo_root: Path | None = None,
) -> PreregInputs:
    """Load hypotheses, gates, every ``dictionary/*.yaml`` and the generator config (all read-only)."""
    root = (repo_root or find_repo_root()).resolve()
    sdir = (scoring_dir or root / "scoring").resolve()
    hyp = _load("hypotheses", sdir / "hypotheses.yaml", root)
    gates = _load("gates", sdir / "gates.yaml", root)
    dict_dir = sdir / "dictionary"
    dict_files = sorted(dict_dir.glob("*.yaml"))
    if not dict_files:
        raise FileNotFoundError(f"no scoring dictionary files in {dict_dir}")
    dictionaries: dict[str, InputFile] = {}
    for f in dict_files:
        probe = _load("dictionary", f, root)
        document = probe.data.get("document")
        if document == "shared":
            key = "shared"
        elif document == "pathway":
            key = str(probe.data.get("pathway"))
        else:
            raise ValueError(f"{f}: unknown dictionary document type {document!r}")
        if key in dictionaries:
            raise ValueError(f"duplicate dictionary document {key!r}: {dictionaries[key].path} and {f}")
        dictionaries[key] = InputFile(f"dictionary.{key}", probe.path, probe.rel_path, probe.sha256, probe.data)
    if "shared" not in dictionaries:
        raise ValueError(f"{dict_dir} has no shared dictionary document")
    cfg = _load("config", (config_path or root / DEFAULT_CONFIG), root)
    if cfg.data.get("schema") != "shriii-prereg-config":
        raise ValueError(f"{cfg.path} is not a shriii-prereg-config document")
    return PreregInputs(
        repo_root=root,
        hypotheses=hyp,
        gates=gates,
        dictionaries=dictionaries,
        config=cfg,
    )


def as_list(value: Any) -> list[Any]:
    """``value`` as a list (``None`` -> ``[]``)."""
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def as_map(value: Any) -> Mapping[str, Any]:
    return cast(Mapping[str, Any], value) if isinstance(value, Mapping) else {}
