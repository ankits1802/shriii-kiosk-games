"""Typed access to config/*.yaml (policy, conditions, engines, vocabularies)."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

import yaml

TOOL_ROOT = Path(__file__).resolve().parents[2]
CONFIG_DIR = TOOL_ROOT / "config"
SCHEMA_DIR = TOOL_ROOT / "schemas"

Snr = float | Literal["clean"]


class ConfigError(ValueError):
    pass


def _load(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ConfigError(f"{path}: expected a mapping")
    return data


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


@dataclass(frozen=True, slots=True)
class Policy:
    reference_snr_db: float
    min_accuracy: float
    ci_level: float
    judge_on: Literal["point", "lower_ci"]
    max_gap_pp: float
    subgroup_fields: tuple[str, ...]
    min_speakers_per_subgroup: int
    min_heldout_speakers: int
    min_trials_per_code: int
    max_false_accept_rate: float
    false_accept_judge_at: Literal["worst", "reference"]
    max_p95_latency_ms: float
    max_rtf: float
    propose_min_precision: float
    commit_min_precision: float
    runtime: dict[str, float]
    sha256: str


def load_policy(path: Path | None = None) -> Policy:
    path = path or CONFIG_DIR / "policy.yaml"
    raw = _load(path)
    try:
        acc, fair, samp, fa, lat, tiers = (
            raw["accuracy"],
            raw["fairness"],
            raw["sample"],
            raw["false_accepts"],
            raw["latency"],
            raw["confidence_tiers"],
        )
        judge = acc["judge_on"]
        if judge not in ("point", "lower_ci"):
            raise ConfigError("accuracy.judge_on must be point or lower_ci")
        fa_judge = fa.get("judge_at", "worst")
        if fa_judge not in ("worst", "reference"):
            raise ConfigError("false_accepts.judge_at must be worst or reference")
        runtime = {k: float(v) for k, v in raw["runtime"].items()}
        for k in ("noise_max_dbfs", "max_listen_ms", "vad_preroll_ms", "settle_ms"):
            if k not in runtime:
                raise ConfigError(f"runtime.{k} missing")
        return Policy(
            reference_snr_db=float(acc["reference_snr_db"]),
            min_accuracy=float(acc["min_accuracy"]),
            ci_level=float(acc["ci_level"]),
            judge_on=judge,
            max_gap_pp=float(fair["max_gap_pp"]),
            subgroup_fields=tuple(fair["subgroup_fields"]),
            min_speakers_per_subgroup=int(fair["min_speakers_per_subgroup"]),
            min_heldout_speakers=int(samp["min_heldout_speakers"]),
            min_trials_per_code=int(samp["min_trials_per_code"]),
            max_false_accept_rate=float(fa["max_rate"]),
            false_accept_judge_at=fa_judge,
            max_p95_latency_ms=float(lat["max_p95_ms"]),
            max_rtf=float(lat["max_rtf"]),
            propose_min_precision=float(tiers["propose_min_precision"]),
            commit_min_precision=float(tiers["commit_min_precision"]),
            runtime=runtime,
            sha256=file_sha256(path),
        )
    except KeyError as exc:
        raise ConfigError(f"{path}: missing key {exc}") from exc


@dataclass(frozen=True, slots=True)
class Conditions:
    seed: int
    snr_db: tuple[Snr, ...]
    noise_dir: Path
    synthetic_fallback: bool
    noise_only_per_prompt: int
    oov_per_prompt: int
    window_s: float


def load_conditions(path: Path | None = None) -> Conditions:
    path = path or CONFIG_DIR / "conditions.yaml"
    raw = _load(path)
    snrs: list[Snr] = []
    for s in raw["snr_db"]:
        snrs.append("clean" if s == "clean" else float(s))
    noise_dir = Path(raw["noise"]["recordings_dir"])
    if not noise_dir.is_absolute():
        noise_dir = TOOL_ROOT / noise_dir
    neg = raw["negatives"]
    return Conditions(
        seed=int(raw["seed"]),
        snr_db=tuple(snrs),
        noise_dir=noise_dir,
        synthetic_fallback=bool(raw["noise"]["synthetic_fallback"]),
        noise_only_per_prompt=int(neg["noise_only_per_prompt"]),
        oov_per_prompt=int(neg["oov_per_prompt"]),
        window_s=float(neg["window_s"]),
    )


@dataclass(frozen=True, slots=True)
class EngineSpec:
    id: str
    kind: str
    description: str
    languages: tuple[str, ...] | None
    params: dict[str, Any] = field(default_factory=dict)

    def path_param(self, key: str, language: str | None = None) -> Path:
        value = str(self.params[key])
        if language is not None:
            value = value.replace("{lang}", language)
        p = Path(value)
        return p if p.is_absolute() else (TOOL_ROOT / p).resolve()


def load_engines(path: Path | None = None) -> list[EngineSpec]:
    path = path or CONFIG_DIR / "engines.yaml"
    raw = _load(path)
    specs = []
    for e in raw["engines"]:
        langs = e.get("languages")
        specs.append(
            EngineSpec(
                id=str(e["id"]),
                kind=str(e["kind"]),
                description=str(e.get("description", "")).strip(),
                languages=tuple(langs) if langs else None,
                params=dict(e.get("params") or {}),
            )
        )
    ids = [s.id for s in specs]
    if len(set(ids)) != len(ids):
        raise ConfigError("duplicate engine ids")
    return specs


@dataclass(frozen=True, slots=True)
class Vocabulary:
    """Per-language code -> phrases, and prompt -> codes."""

    prompts: dict[str, tuple[str, ...]]
    languages: dict[str, dict[str, tuple[str, ...]]]

    def codes(self, language: str) -> list[str]:
        return sorted(self.languages[language])

    def phrases(self, language: str, code: str) -> tuple[str, ...]:
        return self.languages[language][code]


def load_vocab(path: Path | None = None) -> Vocabulary:
    path = path or CONFIG_DIR / "vocab.yaml"
    raw = _load(path)
    for v in raw["prompts"].values():
        if any(not isinstance(c, str) for c in v):
            raise ConfigError(f"{path}: prompt codes must be strings (quote yes/no: YAML reads them as booleans)")
    for spec in raw["languages"].values():
        if any(not isinstance(c, str) for c in spec["codes"]):
            raise ConfigError(f"{path}: codes must be strings (quote yes/no: YAML reads them as booleans)")
    prompts = {str(k): tuple(str(c) for c in v) for k, v in raw["prompts"].items()}
    langs: dict[str, dict[str, tuple[str, ...]]] = {}
    for lang, spec in raw["languages"].items():
        langs[str(lang)] = {str(code): tuple(str(p) for p in c["phrases"]) for code, c in spec["codes"].items()}
    for pid, codes in prompts.items():
        for lang, table in langs.items():
            missing = [c for c in codes if c not in table]
            if missing:
                raise ConfigError(f"prompt {pid}: codes {missing} have no phrases in {lang}")
    return Vocabulary(prompts=prompts, languages=langs)
