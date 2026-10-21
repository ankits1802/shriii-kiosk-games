"""Thin adapter over ``shriii_scoring`` (layers 2-4), with fallbacks while it is being built.

The API never re-implements indicator formulas: layer-2 extraction is delegated to
``shriii_scoring`` and fails with :class:`AdapterUnavailableError` when no engine is installed. Trial
reconstruction and criterion scoring have reference fallbacks because they are fully specified by the
contracts and the instrument YAML (reverse keys, scale membership, prorating) and are needed by the
ingestion and battery paths from day one.

Entry points probed (first match wins):

* trials: ``shriii_scoring.canonical.canonicalise(events) -> list[SessionRecord]``
* indicators: ``shriii_scoring.engine.score_session(events, pathway=...)`` or
  ``shriii_scoring.indicators.compute_indicators(events, pathway=...)`` returning an iterable of
  objects/dicts with ``indicator_id``, ``value``, ``n_valid_trials``, ``status``, ``flags``
* criterion: ``shriii_scoring.criterion.score_criterion(responses, attention_key=, performance_keys=,
  administered_blocks=, instruments_dir=)`` returning ``criterion-scale-score.v1`` records
* composites/bands: ``shriii_scoring.bands.estimate(...)``
"""

from __future__ import annotations

import importlib
import json
import logging
import math
import tempfile
from collections import defaultdict
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

log = logging.getLogger(__name__)

FALLBACK_TRIALS_VERSION = "api-fallback-trials-0.1.0"
FALLBACK_CRITERION_VERSION = "api-fallback-criterion-0.1.0"


class AdapterUnavailableError(RuntimeError):
    """The required engine entry point is not installed (non-retryable job error)."""


def _probe(candidates: Sequence[tuple[str, str]]) -> Callable[..., Any] | None:
    for module_name, attr in candidates:
        try:
            module = importlib.import_module(module_name)
        except ImportError:
            continue
        fn = getattr(module, attr, None)
        if callable(fn):
            return fn  # type: ignore[no-any-return]
    return None


def _get(obj: Any, name: str, default: Any = None) -> Any:
    if isinstance(obj, Mapping):
        return obj.get(name, default)
    return getattr(obj, name, default)


def engine_versions() -> dict[str, str]:
    """Algorithm versions reported by the installed engine (or fallbacks)."""
    out = {"trials": FALLBACK_TRIALS_VERSION, "criterion": FALLBACK_CRITERION_VERSION, "indicators": "unavailable"}
    try:
        v = importlib.import_module("shriii_scoring._version")
        out["indicators"] = str(getattr(v, "INDICATOR_ALGORITHM_VERSION", "unknown"))
        if _probe([("shriii_scoring.criterion", "score_criterion")]):
            out["criterion"] = "shriii_scoring-" + str(getattr(v, "CRITERION_ALGORITHM_VERSION", "unknown"))
        if _probe([("shriii_scoring.canonical", "canonicalise")]):
            out["trials"] = "shriii_scoring-" + str(getattr(v, "INDICATOR_ALGORITHM_VERSION", "unknown"))
    except ImportError:
        pass
    return out


# ---------------------------------------------------------------- trials


@dataclass(slots=True)
class TrialRow:
    module_id: str | None
    episode_id: str | None
    block_id: str | None
    trial_id: str
    trial_index: int
    phase: str | None
    condition_id: str | None
    scorable: bool
    start_seq: int | None
    end_seq: int | None
    outcome: str | None
    correctness: bool | None
    latency_ms: float | None
    input_mode: str | None
    timing_flag: str | None
    interrupted: bool
    complete: bool
    exclusion_reasons: list[str] = field(default_factory=list)

    @property
    def eligible(self) -> bool:
        return self.scorable and self.complete and not self.exclusion_reasons


def _eligibility(
    *,
    scorable: bool,
    phase: str | None,
    timing_flag: str | None,
    interrupted: bool,
    complete: bool,
    input_mode: str | None,
) -> list[str]:
    reasons: list[str] = []
    if not scorable or phase in ("practice", "warmup"):
        reasons.append("not_scorable")
    if not complete:
        reasons.append("missing_trial_end")
    if interrupted:
        reasons.append("interrupted_trial")
    if timing_flag not in (None, "ok"):
        reasons.append("timing_flagged")
    if input_mode == "timeout":
        reasons.append("timeout_latency")
    return reasons


def _trials_from_engine(fn: Callable[..., Any], events: Sequence[Mapping[str, Any]]) -> list[TrialRow]:
    rows: list[TrialRow] = []
    for session in fn(events):
        for trial in session.trials:
            response = trial.response
            complete = bool(getattr(trial, "closed", trial.end_ms is not None))
            input_mode = response.input_mode if response is not None else None
            reasons = _eligibility(
                scorable=trial.scorable,
                phase=trial.phase,
                timing_flag=trial.timing_flag,
                interrupted=trial.interrupted,
                complete=complete,
                input_mode=input_mode,
            )
            rows.append(
                TrialRow(
                    module_id=trial.module_id,
                    episode_id=trial.episode_id,
                    block_id=trial.block,
                    trial_id=trial.trial_id,
                    trial_index=trial.trial_index,
                    phase=trial.phase,
                    condition_id=trial.condition_id,
                    scorable=trial.scorable,
                    start_seq=trial.seq_min,
                    end_seq=trial.seq_max,
                    outcome=trial.outcome,
                    correctness=trial.correct,
                    latency_ms=response.latency_ms if response is not None else None,
                    input_mode=input_mode,
                    timing_flag=trial.timing_flag,
                    interrupted=trial.interrupted,
                    complete=complete,
                    exclusion_reasons=reasons,
                )
            )
    return rows


def _trials_fallback(events: Sequence[Mapping[str, Any]]) -> list[TrialRow]:
    """Group trial events by (module, block, trial_id, trial_index) in seq order."""
    groups: dict[tuple[Any, ...], list[Mapping[str, Any]]] = defaultdict(list)
    for e in sorted(events, key=lambda ev: int(ev["seq"])):
        task = e.get("task") or {}
        if not task.get("trial_id"):
            continue
        key = (task.get("module_id"), task.get("block_id"), task["trial_id"], task.get("trial_index") or 0)
        groups[key].append(e)
    rows: list[TrialRow] = []
    for (module_id, block_id, trial_id, trial_index), evs in groups.items():
        first = evs[0]
        cond = first.get("condition") or {}
        types = [e["event_type"] for e in evs]
        responses = [e for e in evs if e["event_type"] == "response"]
        end = next((e for e in reversed(evs) if e["event_type"] == "trial_end"), None)
        response = responses[-1]["payload"] if responses else None
        scorable = all(bool(e["timing"]["scorable"]) for e in evs) and cond.get("phase") not in ("practice", "warmup")
        timing_flag = next((e["timing"]["timing_flag"] for e in evs if e["timing"]["timing_flag"] != "ok"), "ok")
        interrupted = any(bool(e["timing"].get("interrupted")) for e in evs)
        complete = "trial_start" in types and end is not None
        input_mode = response.get("input_mode") if response else None
        correctness = response.get("correctness") if response else None
        if correctness is None and end is not None:
            correctness = end["payload"].get("correctness")
        rows.append(
            TrialRow(
                module_id=module_id,
                episode_id=(first.get("task") or {}).get("episode_id"),
                block_id=block_id,
                trial_id=trial_id,
                trial_index=int(trial_index),
                phase=cond.get("phase"),
                condition_id=cond.get("condition_id"),
                scorable=scorable,
                start_seq=int(evs[0]["seq"]),
                end_seq=int(evs[-1]["seq"]),
                outcome=end["payload"].get("outcome") if end is not None else None,
                correctness=correctness,
                latency_ms=response.get("latency_ms") if response else None,
                input_mode=input_mode,
                timing_flag=timing_flag,
                interrupted=interrupted,
                complete=complete,
                exclusion_reasons=_eligibility(
                    scorable=scorable,
                    phase=cond.get("phase"),
                    timing_flag=timing_flag,
                    interrupted=interrupted,
                    complete=complete,
                    input_mode=input_mode,
                ),
            )
        )
    rows.sort(key=lambda r: r.start_seq or 0)
    return rows


def canonical_trials(events: Sequence[Mapping[str, Any]]) -> tuple[list[TrialRow], str]:
    """Reconstruct trials for one session; returns (rows, algorithm_version)."""
    fn = _probe([("shriii_scoring.canonical", "canonicalise")])
    if fn is not None:
        try:
            return _trials_from_engine(fn, events), engine_versions()["trials"]
        except (AttributeError, TypeError) as exc:  # engine shape drifted: fall back loudly
            log.warning("shriii_scoring.canonical shape mismatch, using fallback: %s", exc)
    return _trials_fallback(events), FALLBACK_TRIALS_VERSION


# ---------------------------------------------------------------- indicators (layer 2)


@dataclass(slots=True)
class IndicatorRow:
    indicator_id: str
    construct_id: str | None
    value: float | None
    n_valid_trials: int | None
    status: str
    flags: list[str]


def _indicator_rows(items: Iterable[Any]) -> list[IndicatorRow]:
    out: list[IndicatorRow] = []
    for item in items:
        value = _get(item, "value")
        n_valid = _get(item, "n_valid_trials")
        out.append(
            IndicatorRow(
                indicator_id=str(_get(item, "indicator_id")),
                construct_id=_get(item, "construct_id") or _get(item, "construct"),
                value=None if value is None or (isinstance(value, float) and math.isnan(value)) else float(value),
                n_valid_trials=n_valid if n_valid is not None else _get(item, "n_valid"),
                status=str(_get(item, "status", "ok")),
                flags=list(_get(item, "flags", []) or []),
            )
        )
    return out


def extract_indicators(
    events: Sequence[Mapping[str, Any]], pathway: str, *, allow_synthetic: bool = False
) -> tuple[list[IndicatorRow], str]:
    """Layer-2 indicators for one session via shriii_scoring. Raises AdapterUnavailableError when absent."""
    score_events = _probe([("shriii_scoring.engine", "score_events")])
    if score_events is not None:
        result = score_events(
            list(events), pathways=(pathway,), allow_synthetic=allow_synthetic, on_missing_params="flag"
        )
        rows = list(result.rows)
        version = str(rows[0].algorithm_version) if rows else engine_versions()["indicators"]
        return _indicator_rows(rows), f"shriii_scoring-{version}"
    fn = _probe([("shriii_scoring.indicators", "compute_indicators"), ("shriii_scoring", "score_session")])
    if fn is None:
        raise AdapterUnavailableError("shriii_scoring does not expose an indicator engine yet")
    result = fn(list(events), pathway=pathway)
    items: Iterable[Any] = _get(result, "indicators", result) if not isinstance(result, list) else result
    return _indicator_rows(items), engine_versions()["indicators"]


@dataclass(slots=True)
class GroupRow:
    """A group-level estimate (private reports). Deliberately carries no session or participant key."""

    indicator_id: str
    construct_id: str | None
    partition: dict[str, Any]
    estimate: float | None
    ci_low: float | None
    ci_high: float | None
    n_participants: int
    n_reports: int
    details: dict[str, Any]


@dataclass(slots=True)
class BatchScoring:
    rows: dict[str, list[IndicatorRow]]
    """session_id -> indicator rows (model-based indicators pooled within the batch partition)."""
    group_rows: list[GroupRow]
    algorithm: str
    manifest: dict[str, Any]


def _finite(value: Any) -> float | None:
    if value is None:
        return None
    v = float(value)
    return v if math.isfinite(v) else None


def score_batch(events: Sequence[Mapping[str, Any]], pathway: str, *, allow_synthetic: bool = False) -> BatchScoring:
    """Layer-2 indicators for many sessions at once (``shriii_scoring.engine.score_events``).

    Batch scoring is required for model-based indicators (partial pooling within language x calibration
    level) and for the group-level private-report estimators; per-session extraction leaves those null.
    """
    fn = _probe([("shriii_scoring.engine", "score_events")])
    if fn is None:
        raise AdapterUnavailableError("shriii_scoring.engine.score_events is not installed")
    result = fn(list(events), pathways=(pathway,), allow_synthetic=allow_synthetic, on_missing_params="flag")
    by_session: dict[str, list[Any]] = defaultdict(list)
    for r in result.rows:
        by_session[str(r.session_id)].append(r)
    version = str(result.rows[0].algorithm_version) if result.rows else engine_versions()["indicators"]
    groups = [
        GroupRow(
            indicator_id=str(g.indicator_id),
            construct_id=str(g.construct) if g.construct else None,
            partition={str(k): v for k, v in dict(g.partition).items()},
            estimate=_finite(g.estimate),
            ci_low=_finite(g.ci_low),
            ci_high=_finite(g.ci_high),
            n_participants=int(g.n_participants),
            n_reports=int(g.n_reports),
            details=dict(g.details),
        )
        for g in result.group_rows
    ]
    manifest = getattr(result, "manifest", None)
    manifest_dict: dict[str, Any] = (
        dict(manifest.to_dict()) if manifest is not None and hasattr(manifest, "to_dict") else {}
    )
    return BatchScoring(
        rows={sid: _indicator_rows(rows) for sid, rows in by_session.items()},
        group_rows=groups,
        algorithm=f"shriii_scoring-{version}",
        manifest=json.loads(json.dumps(manifest_dict, default=str)),
    )


# ---------------------------------------------------------------- criterion (layer 3)


@dataclass(slots=True)
class ScaleResult:
    scale_id: str
    score: float | None
    raw_mean: float | None
    score_type: str
    n_answered: int
    n_items: int
    prorated: bool
    planned_missing: bool
    na_reason: str | None
    flags: list[str]
    source_item_ids: list[str]


def reverse_code(value: float, scale_min: float, scale_max: float) -> float:
    """``min + max - x`` (the only reverse formula the instrument schema allows)."""
    return scale_min + scale_max - value


def _fallback_score_instrument(
    instrument: Mapping[str, Any],
    responses: Mapping[str, float | None],
    attention_failed: bool,
    planned_missing_items: frozenset[str],
) -> list[ScaleResult]:
    scale = instrument["response_scale"]
    smin, smax = scale.get("min"), scale.get("max")
    reverse_ok = scale.get("reverse_formula") == "min_plus_max_minus_x" and smin is not None and smax is not None
    items = {it["item_id"]: it for it in instrument["items"]}
    prorate_min = float(instrument["scoring"]["prorate_min_prop"])
    results: list[ScaleResult] = []
    for sc in instrument["subscales"]:
        member_ids: list[str] = list(sc["items"])
        planned = bool(member_ids) and all(i in planned_missing_items for i in member_ids)
        keyed: list[float] = []
        answered: list[str] = []
        for item_id in member_ids:
            value = responses.get(item_id)
            if value is None:
                continue
            item = items.get(item_id, {})
            v = float(value)
            if item.get("reverse_keyed"):
                if not reverse_ok:
                    raise ValueError(f"{item_id} is reverse keyed but the scale has no reverse formula")
                v = reverse_code(v, float(smin), float(smax))
            keyed.append(v)
            answered.append(item_id)
        n_items, n_answered = len(member_ids), len(answered)
        score_type = sc["score_type"]
        min_prop = max(prorate_min, float(sc["min_answered_prop"]))
        flags: list[str] = []
        na_reason: str | None = None
        score: float | None = None
        raw_mean: float | None = None
        prorated = False
        if planned:
            na_reason = "planned_missing"
        elif n_answered == 0 or n_answered / n_items + 1e-12 < min_prop:
            na_reason = "insufficient_items"
        else:
            raw_mean = sum(keyed) / n_answered
            prorated = n_answered < n_items
            if score_type == "mean":
                score = raw_mean
            elif score_type == "sum":
                score = raw_mean * n_items if prorated else sum(keyed)
            elif score_type == "count":
                score = float(sum(1 for v in keyed if v))
            elif score_type == "proportion":
                score = sum(1 for v in keyed if v) / n_answered
            else:  # time_s
                score = sum(keyed)
            if prorated:
                flags.append("prorated")
        if attention_failed:
            flags.append("criterion_careless")
        results.append(
            ScaleResult(
                scale_id=sc["scale_id"],
                score=score,
                raw_mean=raw_mean,
                score_type=score_type,
                n_answered=n_answered,
                n_items=n_items,
                prorated=prorated,
                planned_missing=planned,
                na_reason=na_reason,
                flags=flags,
                source_item_ids=answered,
            )
        )
    return results


@dataclass(frozen=True, slots=True)
class ResponseInput:
    """One current (non-superseded) item response handed to criterion scoring."""

    item_id: str
    raw_response: float | None
    response_id: str | None = None
    block: str | None = None
    expected_response: float | None = None
    """Administration-file key: attention-check answer, or min moves of a ``<problem>.moves`` measure."""
    administration_mode: str | None = None


def _as_inputs(responses: Mapping[str, float | None] | Sequence[ResponseInput]) -> list[ResponseInput]:
    if isinstance(responses, Mapping):
        return [ResponseInput(item_id=k, raw_response=v) for k, v in responses.items()]
    return list(responses)


def split_measure(items: Mapping[str, Any], item_id: str) -> tuple[str, str | None]:
    """``("tol_board.p1", "moves")`` for a performance measure id, ``(item_id, None)`` for a plain item."""
    if item_id in items:
        return item_id, None
    base, _, measure = item_id.rpartition(".")
    if base in items and measure:
        return base, measure
    return item_id, None


def _careless_policy() -> str:
    try:
        params_mod = importlib.import_module("shriii_scoring.params")
        return str(params_mod.load_params().get("criterion.careless_policy"))
    except (ImportError, KeyError, AttributeError):
        return "flag"


def _engine_score_criterion(
    instrument: Mapping[str, Any],
    inputs: Sequence[ResponseInput],
    attention_failed: bool,
    planned_missing_items: frozenset[str],
) -> list[ScaleResult] | None:
    """Score with ``shriii_scoring.criterion.score_criterion`` (the single layer-3 implementation).

    The stored instrument version is written to a private directory so the engine scores with exactly
    the key the responses were collected under. Returns None when the engine is not installed.
    """
    fn = _probe([("shriii_scoring.criterion", "score_criterion")])
    if fn is None:
        return None
    items = {str(it["item_id"]): it for it in instrument["items"]}
    rows: list[dict[str, Any]] = []
    attention_key: dict[str, float] = {}
    performance_keys: dict[str, dict[str, float]] = {}
    administered: set[str] = set()
    by_response: dict[str, str] = {}
    for n, r in enumerate(inputs):
        rid = r.response_id or f"r{n}"
        by_response[rid] = r.item_id
        base, measure = split_measure(items, r.item_id)
        item = items.get(base, {})
        if item.get("block") is not None and r.raw_response is not None:
            administered.add(str(item["block"]))
        if r.block:
            administered.add(r.block)
        if r.expected_response is not None:
            if item.get("attention_check"):
                attention_key[r.item_id] = float(r.expected_response)
            elif measure == "moves":
                performance_keys[base] = {"min_moves": float(r.expected_response)}
        rows.append(
            {
                "response_id": rid,
                "pid": "subject",
                "study_id": "study",
                "wave": 1,
                "occasion_id": "occasion",
                "instrument_id": instrument["instrument_id"],
                "item_id": r.item_id,
                "raw_response": r.raw_response,
                "block": r.block or item.get("block") or "X",
                "rater_role": "self",
                "administration_mode": r.administration_mode or "self",
                "recorded_at": f"{n:08d}",
            }
        )
    with tempfile.TemporaryDirectory(prefix="shriii-instrument-") as tmp:
        Path(tmp, "instrument.yaml").write_text(yaml.safe_dump(dict(instrument), allow_unicode=True), "utf-8")
        result = fn(
            rows,
            attention_key=attention_key or None,
            performance_keys=performance_keys or None,
            administered_blocks={("subject", "occasion"): sorted(administered)},
            instruments_dir=Path(tmp),
        )
    careless_policy = _careless_policy()
    subscales = {str(sc["scale_id"]): sc for sc in instrument["subscales"]}
    out: list[ScaleResult] = []
    for rec in result.scores:
        sub = subscales[str(rec["scale_id"])]
        score, na_reason = rec["score"], rec["na_reason"]
        planned = bool(rec["planned_missing"])
        flags = set(rec["flags"])
        if sub["items"] and all(i in planned_missing_items for i in sub["items"]):
            score, na_reason, planned = None, "planned_missing", True
            flags.add("planned_missing")
        if attention_failed and instrument["instrument_id"] != "attention_checks":
            flags.add("criterion_careless")
            if careless_policy == "exclude":
                score, na_reason = None, "criterion_careless"
        n_items = int(rec["n_items"])
        score_type = str(rec["score_type"])
        raw_mean: float | None = None
        if score is not None:
            if score_type == "mean":
                raw_mean = float(score)
            elif score_type == "sum" and n_items:
                raw_mean = float(score) / n_items
        out.append(
            ScaleResult(
                scale_id=str(rec["scale_id"]),
                score=None if score is None else float(score),
                raw_mean=raw_mean,
                score_type=score_type,
                n_answered=int(rec["n_answered"]),
                n_items=n_items,
                prorated=bool(rec["prorated"]),
                planned_missing=planned,
                na_reason=na_reason,
                flags=sorted(flags),
                source_item_ids=sorted({by_response[i] for i in rec["source_response_ids"] if i in by_response}),
            )
        )
    return out


def score_instrument(
    instrument: Mapping[str, Any],
    responses: Mapping[str, float | None] | Sequence[ResponseInput],
    *,
    attention_failed: bool = False,
    planned_missing_items: frozenset[str] = frozenset(),
) -> tuple[list[ScaleResult], str]:
    """Score one administration with the versioned key in ``instrument``; returns (scales, algorithm).

    ``shriii_scoring.criterion.score_criterion`` is the scoring implementation. The reference fallback
    is used only when the engine is not installed, or when ``instrument`` is not a complete registry
    document (no ``instrument_id``/``kind``, as in unit fixtures).
    """
    inputs = _as_inputs(responses)
    if "instrument_id" in instrument and "kind" in instrument:
        engine_result = _engine_score_criterion(instrument, inputs, attention_failed, planned_missing_items)
        if engine_result is not None:
            return engine_result, engine_versions()["criterion"]
    if instrument.get("kind") == "performance":
        raise AdapterUnavailableError("performance instruments need shriii_scoring.criterion")
    values = {r.item_id: r.raw_response for r in inputs}
    return (
        _fallback_score_instrument(instrument, values, attention_failed, planned_missing_items),
        FALLBACK_CRITERION_VERSION,
    )


# ---------------------------------------------------------------- composites (layer 4)


@dataclass(slots=True)
class TraitEstimateRow:
    trait: str
    composite: float | None
    sem: float | None
    band: str | None
    not_enough_to_say: bool


def estimate_traits(
    indicator_values: Mapping[str, float | None],
    release_pack: Mapping[str, Any],
    *,
    pathway: str,
    language: str,
    sem_rule: Mapping[str, Any] | None = None,
) -> tuple[list[TraitEstimateRow], str]:
    """Layer-4 composites and bands from the release pack (the implementation lives in shriii_scoring).

    Uses ``shriii_scoring.bands.composite_score`` + ``band_for`` (the same reference the kiosk evaluator
    must match) for every composite of this language x pathway that has a norm table. ``sem_rule`` is
    ``gates.yaml`` ``trait_gate.norms.sem_rule``. Composites without a norm table produce no estimate.
    """
    try:
        bands = importlib.import_module("shriii_scoring.bands")
        version = str(importlib.import_module("shriii_scoring._version").BAND_ALGORITHM_VERSION)
    except (ImportError, AttributeError) as exc:
        raise AdapterUnavailableError("shriii_scoring.bands is not installed") from exc
    composite_score = getattr(bands, "composite_score", None)
    band_for = getattr(bands, "band_for", None)
    if not callable(composite_score) or not callable(band_for):
        raise AdapterUnavailableError("shriii_scoring.bands lacks composite_score/band_for")
    if sem_rule is None:
        raise ValueError("sem_rule (gates.yaml trait_gate.norms.sem_rule) is required")
    rows: list[TraitEstimateRow] = []
    allowlist = list(release_pack.get("phrase_allowlist", ()))
    for comp in release_pack.get("composites", ()):
        if comp["language"] != language or comp["pathway"] != pathway:
            continue
        trait = str(comp["trait"])
        norm = next(
            (
                n
                for n in release_pack.get("norm_tables", ())
                if n["trait"] == trait and n["language"] == language and n["pathway"] == pathway
            ),
            None,
        )
        if norm is None:
            continue
        score = composite_score(indicator_values, comp)
        result = band_for(trait, score, norm["cut_points"], float(norm["sem"]), sem_rule, phrase_allowlist=allowlist)
        rows.append(
            TraitEstimateRow(
                trait=trait,
                composite=None if score is None else float(score),
                sem=float(norm["sem"]),
                band=_get(result, "band"),
                not_enough_to_say=bool(_get(result, "not_enough_to_say", True)),
            )
        )
    return rows, f"shriii_scoring-bands-{version}"
