"""Indicator engine (layer 2): raw events -> versioned indicator rows with lineage.

Pipeline (plan section 7.2 ``events -> trials_canonical -> indicators_long -> model_estimates``):

1. canonicalise events into sessions and trials (:mod:`shriii_scoring.canonical`);
2. grade data quality per session (:mod:`shriii_scoring.quality`);
3. for each indicator of the session's pathway dictionary: select the task's trials, apply the listed
   exclusion rules, run the formula, enforce ``min_valid_trials`` (null + ``insufficient_trials``), apply
   the dictionary transformation;
4. batch model step per partition for model-based indicators; group-level estimators separately.

Every row carries dictionary version + SHA-256, the shared dictionary SHA-256, the parameter-file
SHA-256, the algorithm version, the scoring run id and the source event range.
"""

from __future__ import annotations

import json
import math
from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

import numpy as np

from shriii_scoring import formulas as _formulas  # noqa: F401  (registers formulas)
from shriii_scoring._version import INDICATOR_ALGORITHM_VERSION
from shriii_scoring.canonical import SessionRecord, Trial, canonicalise
from shriii_scoring.content import block_phases, load_game_configs
from shriii_scoring.conventions import TASKS, phase_mismatches
from shriii_scoring.dictionary import Dictionary, IndicatorSpec, Pathway, load_dictionary
from shriii_scoring.exclusions import ExclusionContext, ExclusionOutcome, apply_exclusions
from shriii_scoring.formulas.base import (
    REGISTRY,
    BatchContext,
    BatchUnit,
    FormulaContext,
    GroupValue,
    IndicatorValue,
    MissingTrialParamsError,
)
from shriii_scoring.numerics import fisher_z, logit_corrected
from shriii_scoring.params import ScoringParams, load_params
from shriii_scoring.provenance import ScoringRunManifest, hash_json
from shriii_scoring.quality import SessionQuality, assess_session

__all__ = [
    "GroupIndicatorRow",
    "IndicatorEngine",
    "IndicatorRow",
    "PartitionModel",
    "ScoringResult",
    "score_events",
]

Status = Literal[
    "ok",
    "insufficient_trials",
    "module_incomplete",
    "planned_missing",
    "not_applicable",
    "module_absent",
    "missing_context_shift",
    "group_only",
    "unscorable_individual",
    "session_excluded",
    "model_failed",
    "error",
]


@dataclass(frozen=True, slots=True)
class IndicatorRow:
    """One indicator value for one session (layer 2, ``indicators_long``)."""

    scoring_run_id: str
    session_id: str
    participant_pid: str | None
    pathway: str
    language: str | None
    calibration_level: str | None
    site_mode: str | None
    battery_arm: str | None
    indicator_id: str
    construct: str
    kind: str
    formula_ref: str
    unit: str
    direction: str
    transformation: str
    value: float | None
    value_transformed: float | None
    n_valid: int
    min_valid: int
    se: float | None
    status: str
    flags: tuple[str, ...]
    details: Mapping[str, Any]
    gate_eligible: bool
    exploratory: bool
    synthetic: bool
    quality_grade: str
    dictionary_version: str
    dictionary_sha256: str
    shared_sha256: str
    params_sha256: str
    algorithm_version: str
    source_seq_min: int | None
    source_seq_max: int | None
    source_event_count: int
    event_stream_sha256: str


@dataclass(frozen=True, slots=True)
class GroupIndicatorRow:
    """A group-level estimate. Deliberately has no session or participant key (SCR-08)."""

    scoring_run_id: str
    pathway: str
    partition: Mapping[str, Any]
    indicator_id: str
    construct: str
    formula_ref: str
    estimate: float | None
    ci_low: float | None
    ci_high: float | None
    n_participants: int
    n_reports: int
    details: Mapping[str, Any]
    dictionary_version: str
    dictionary_sha256: str
    algorithm_version: str


@dataclass(frozen=True, slots=True)
class PartitionModel:
    """Partition-level summary of a batch model (model-based reliability, variance, method)."""

    indicator_id: str
    partition: Mapping[str, Any]
    details: Mapping[str, Any]


@dataclass(slots=True)
class ScoringResult:
    """Everything one scoring run produced."""

    manifest: ScoringRunManifest
    rows: list[IndicatorRow]
    group_rows: list[GroupIndicatorRow]
    sessions: list[SessionRecord]
    quality: dict[str, SessionQuality]
    partition_models: list[PartitionModel]
    consistency_warnings: list[str] = field(default_factory=list)

    def value(self, session_id: str, indicator_id: str) -> float | None:
        for r in self.rows:
            if r.session_id == session_id and r.indicator_id == indicator_id:
                return r.value
        raise KeyError((session_id, indicator_id))

    def to_records(self) -> list[dict[str, Any]]:
        out = []
        for r in self.rows:
            d = asdict(r)
            d["flags"] = list(r.flags)
            d["details"] = json.dumps(r.details, sort_keys=True, default=_json_default)
            out.append(d)
        return out

    def to_polars(self) -> Any:
        import polars as pl  # noqa: PLC0415 - optional DataFrame export, imported on demand

        return pl.DataFrame(self.to_records(), infer_schema_length=None)

    def wide(self, value: Literal["value", "value_transformed"] = "value") -> dict[str, dict[str, Any]]:
        """``analysis_wide`` view: session -> {indicator: value, calibration_level, pathway, language, pid}."""
        out: dict[str, dict[str, Any]] = {}
        for r in self.rows:
            rec = out.setdefault(
                r.session_id,
                {
                    "participant_pid": r.participant_pid,
                    "pathway": r.pathway,
                    "language": r.language,
                    "calibration_level": r.calibration_level,
                    "quality_grade": r.quality_grade,
                },
            )
            rec[r.indicator_id] = getattr(r, value) if r.status == "ok" else None
        return out


def _json_default(o: Any) -> Any:
    if isinstance(o, np.generic):
        return o.item()
    if isinstance(o, float) and math.isnan(o):
        return None
    return str(o)


def _clean(v: float | None) -> float | None:
    if v is None:
        return None
    f = float(v)
    return None if math.isnan(f) or math.isinf(f) else f


class IndicatorEngine:
    """Configured engine for one or both pathways (dictionary + parameters + content configs)."""

    def __init__(
        self,
        *,
        pathways: Sequence[Pathway] = ("A", "B"),
        dictionary_dir: Path | None = None,
        params: ScoringParams | None = None,
        content_dir: Path | None = None,
        partition_keys: Sequence[str] | None = None,
        allow_synthetic: bool = False,
        on_missing_params: Literal["raise", "flag"] = "raise",
    ) -> None:
        self.dictionaries: dict[str, Dictionary] = {p: load_dictionary(p, dictionary_dir) for p in pathways}
        self.params = params or load_params()
        self.game_configs = load_game_configs(content_dir)
        self.partition_keys = tuple(partition_keys or self.params.strs("models.partition_keys"))
        self.allow_synthetic = allow_synthetic
        self.on_missing_params = on_missing_params
        self.anticipatory_ms = self._anticipatory_threshold()
        self.latency_only = frozenset(self.params.strs("latency_only_exclusions"))
        self.consistency_warnings = self._consistency_checks()

    # ------------------------------------------------------------------ configuration checks

    def _anticipatory_threshold(self) -> float:
        for d in self.dictionaries.values():
            rule = d.exclusion_rules.get("anticipatory_response")
            if rule is not None:
                for c in rule.when:
                    if c.field == "payload.latency_ms" and c.op == "lt":
                        return float(c.value)
        return self.params.f("rvi.rt_lower_ms")

    def _consistency_checks(self) -> list[str]:
        """Resolve each indicator's blocks: a task block is used when its content-config phase is in the
        dictionary ``phases``. When the dictionary phases match none of the task's blocks (a dictionary /
        content inconsistency), all task blocks are used and every row is flagged
        ``phase_mismatch_fallback``. Both cases are reported as consistency warnings."""
        warnings: list[str] = []
        phases = block_phases(self.game_configs)
        self._blocks: dict[tuple[str, str], dict[str, frozenset[str]]] = {}
        self._fallback: set[tuple[str, str]] = set()
        for p, d in self.dictionaries.items():
            for spec in d.indicators.values():
                if spec.task not in TASKS:
                    raise ValueError(f"{spec.id}: task {spec.task!r} has no selector in conventions.TASKS")
                if spec.formula_ref not in REGISTRY:
                    raise ValueError(f"{spec.id}: formula {spec.formula_ref!r} is not registered")
                chosen: dict[str, frozenset[str]] = {}
                for comp in TASKS[spec.task].components:
                    keep = [b for b in comp.blocks if phases.get((comp.module_id, b), "main") in spec.phases]
                    chosen[comp.module_id] = chosen.get(comp.module_id, frozenset()) | frozenset(keep)
                if not any(chosen.values()):
                    chosen = {}
                    for comp in TASKS[spec.task].components:
                        chosen[comp.module_id] = chosen.get(comp.module_id, frozenset()) | frozenset(comp.blocks)
                    self._fallback.add((p, spec.id))
                    warnings.append(
                        f"dictionary.{p}: {spec.id} phases {list(spec.phases)} match none of the blocks of task "
                        f"{spec.task}; all task blocks used (rows flagged phase_mismatch_fallback)"
                    )
                self._blocks[(p, spec.id)] = chosen
            mism = phase_mismatches({s.id: (s.task, *s.phases) for s in d.indicators.values()}, phases)
            warnings.extend(
                f"dictionary.{p}: {ind} task {task} block {blk} (config phase {ph}) is outside the dictionary phases "
                "and is not used"
                for ind, task, blk, ph in mism
                if (p, ind) not in self._fallback
            )
        return warnings

    # ------------------------------------------------------------------ helpers

    def _select(self, session: SessionRecord, spec: IndicatorSpec) -> list[Trial]:
        selector = TASKS[spec.task]
        blocks = self._blocks[(str(session.pathway), spec.id)]
        out: list[Trial] = []
        for comp in selector.components:
            module = session.modules.get(comp.module_id)
            if module is None:
                continue
            allowed = blocks.get(comp.module_id, frozenset()) & frozenset(comp.blocks)
            out.extend(t for t in module.trials if t.block in allowed and t.trial_type in comp.trial_types)
        return sorted(out, key=lambda t: (t.module_id, t.trial_index))

    def _absent_status(self, session: SessionRecord, spec: IndicatorSpec) -> tuple[Status, tuple[str, ...]] | None:
        modules = TASKS[spec.task].modules
        present = [m for m in modules if m in session.modules and session.modules[m].trials]
        if present:
            incomplete = [
                m for m in present if session.modules[m].ended_reason in ("walkaway", "time_cap", "withdrawn", "error")
            ]
            if incomplete:
                return "module_incomplete", tuple(f"module_ended:{session.modules[m].ended_reason}" for m in incomplete)
            return None
        if spec.missing_data == "substudy_only":
            return "not_applicable", ("substudy_only",)
        d = self.dictionaries[str(session.pathway)]
        slot_modules = {m for m in modules if m in d.modules and d.modules[m].slot}
        if spec.slot or (slot_modules and slot_modules == set(modules)):
            return "planned_missing", ("planned_missing_slot",)
        return "module_absent", ()

    def _transform(self, spec: IndicatorSpec, iv: IndicatorValue) -> tuple[float | None, tuple[str, ...]]:
        v = _clean(iv.value)
        if v is None:
            return None, ()
        t = spec.transformation
        if t in {"none", "z_within_level_language"}:
            return v, ()
        if t == "log":
            return (math.log(v), ()) if v > 0 else (None, ("log_nonpositive",))
        if t == "log1p":
            return (math.log1p(v), ()) if v > -1 else (None, ("log1p_out_of_range",))
        if t == "logit_corrected":
            k = iv.details.get("k")
            n = iv.details.get("n")
            if k is None or n is None:
                return None, ("logit_needs_counts",)
            return logit_corrected(float(k), int(n)), ()
        if t == "fisher_z":
            return fisher_z(v), ()
        raise ValueError(f"unknown transformation {t!r}")

    def _partition(self, session: SessionRecord) -> tuple[tuple[str, Any], ...]:
        values = {
            "pathway": session.pathway,
            "language": session.language,
            "calibration_level": session.calibration_level,
            "site_mode": session.site_mode,
            "battery_arm": session.battery_arm,
            "mode": session.mode,
        }
        return tuple((k, values.get(k)) for k in self.partition_keys)

    # ------------------------------------------------------------------ main entry

    def score(
        self,
        events: Iterable[Mapping[str, Any]],
        trial_params: Mapping[str, Mapping[str, Mapping[str, Any]]] | None = None,
        *,
        erasures: int = 0,
        created_at: datetime | None = None,
    ) -> ScoringResult:
        """Score raw events. ``trial_params``: session_id -> trial_id -> ``GameTrialSpec.params``."""
        sessions = canonicalise(events, trial_params)
        quality = {s.session_id: assess_session(s, self.params) for s in sessions}
        pending: list[
            tuple[SessionRecord, IndicatorSpec, IndicatorValue | None, Status | None, tuple[str, ...], list[Trial]]
        ] = []
        batch_units: dict[tuple[str, str, tuple[tuple[str, Any], ...]], list[BatchUnit]] = defaultdict(list)
        group_units: dict[tuple[str, str, tuple[tuple[str, Any], ...]], list[BatchUnit]] = defaultdict(list)
        partition_hashes: dict[str, list[str]] = defaultdict(list)

        for s in sessions:
            if s.pathway not in self.dictionaries:
                continue
            d = self.dictionaries[s.pathway]
            part = self._partition(s)
            partition_hashes[json.dumps(part, default=str)].append(s.event_stream_sha256)
            ctx_ex = ExclusionContext(
                session=s, quality_grade=quality[s.session_id].grade, allow_synthetic=self.allow_synthetic
            )
            ex_cache: dict[tuple[Any, ...], ExclusionOutcome] = {}
            for spec in d.indicators.values():
                fdef = REGISTRY[spec.formula_ref]
                selected = self._select(s, spec)
                absent = self._absent_status(s, spec)
                if absent is not None and absent[0] != "module_incomplete":
                    pending.append((s, spec, None, absent[0], absent[1], selected))
                    continue
                ex_key = (spec.task, tuple(self._blocks[(s.pathway, spec.id)].items()), spec.exclusions)
                outcome = ex_cache.get(ex_key)
                if outcome is None:
                    outcome = apply_exclusions(selected, spec.exclusions, d.exclusion_rules, ctx_ex, self.latency_only)
                    ex_cache[ex_key] = outcome
                if outcome.session_excluded_by is not None:
                    pending.append(
                        (s, spec, None, "session_excluded", (f"excluded_by:{outcome.session_excluded_by}",), selected)
                    )
                    continue
                extra_flags = absent[1] if absent else ()
                soft: Status | None = absent[0] if absent else None
                if fdef.kind == "group":
                    group_units[(s.pathway, spec.id, part)].append(BatchUnit(s, outcome.kept))
                    pending.append((s, spec, None, "group_only", ("group_level_only",), selected))
                    continue
                if fdef.kind == "batch":
                    batch_units[(s.pathway, spec.id, part)].append(BatchUnit(s, outcome.kept))
                    pending.append((s, spec, None, soft, extra_flags, selected))
                    continue
                ctx = FormulaContext(
                    spec=spec,
                    session=s,
                    dictionary=d,
                    params=self.params,
                    game_configs=self.game_configs,
                    anticipatory_ms=self.anticipatory_ms,
                )
                try:
                    iv = fdef.fn(outcome.kept, ctx)
                except MissingTrialParamsError:
                    if self.on_missing_params == "raise":
                        raise
                    pending.append((s, spec, None, "error", ("missing_trial_params",), selected))
                    continue
                pending.append((s, spec, iv, soft, extra_flags, selected))

        # Batch model step.
        batch_results: dict[tuple[str, str], IndicatorValue] = {}
        partition_models: list[PartitionModel] = []
        cache_by_part: dict[tuple[str, tuple[tuple[str, Any], ...]], dict[str, Any]] = defaultdict(dict)
        for (pw, ind_id, part), units in sorted(
            batch_units.items(), key=lambda kv: (kv[0][0], kv[0][1], str(kv[0][2]))
        ):
            d = self.dictionaries[pw]
            spec = d.indicators[ind_id]
            bctx = BatchContext(
                spec=spec,
                dictionary=d,
                params=self.params,
                game_configs=self.game_configs,
                anticipatory_ms=self.anticipatory_ms,
                partition=dict(part),
                cache=cache_by_part[(pw, part)],
            )
            units_sorted = sorted(units, key=lambda u: u.session.session_id)
            try:
                res = REGISTRY[spec.formula_ref].fn(units_sorted, bctx)
            except MissingTrialParamsError:
                if self.on_missing_params == "raise":
                    raise
                res = {
                    u.session.session_id: IndicatorValue.empty(0, "missing_trial_params", status="error") for u in units
                }
            for sid, iv in res.items():
                batch_results[(sid, ind_id)] = iv
            partition_models.append(PartitionModel(ind_id, dict(part), dict(bctx.partition_details)))

        group_rows_out: list[tuple[str, IndicatorSpec, dict[str, Any], GroupValue]] = []
        for (pw, ind_id, part), units in sorted(
            group_units.items(), key=lambda kv: (kv[0][0], kv[0][1], str(kv[0][2]))
        ):
            d = self.dictionaries[pw]
            spec = d.indicators[ind_id]
            bctx = BatchContext(
                spec=spec,
                dictionary=d,
                params=self.params,
                game_configs=self.game_configs,
                anticipatory_ms=self.anticipatory_ms,
                partition=dict(part),
                cache={},
            )
            gv = REGISTRY[spec.formula_ref].fn(sorted(units, key=lambda u: u.session.session_id), bctx)
            group_rows_out.append((pw, spec, dict(part), gv))

        manifest = ScoringRunManifest.build(
            algorithm_version=INDICATOR_ALGORITHM_VERSION,
            dictionaries={
                p: {
                    "version": d.version,
                    "sha256": d.sha256,
                    "shared_sha256": d.shared_sha256,
                    "frozen": d.frozen,
                    "status": d.status,
                }
                for p, d in sorted(self.dictionaries.items())
            },
            params_sha256=self.params.sha256,
            params_version=self.params.version,
            session_hashes={s.session_id: s.event_stream_sha256 for s in sessions},
            trial_params=trial_params,
            partition_keys=self.partition_keys,
            partition_hashes={k: hash_json(sorted(v)) for k, v in sorted(partition_hashes.items())},
            allow_synthetic=self.allow_synthetic,
            erasures=erasures,
            consistency_warnings=self.consistency_warnings,
            created_at=created_at,
        )
        run_id = manifest.scoring_run_id

        rows: list[IndicatorRow] = []
        for s, spec, pending_iv, status, flags, selected in pending:
            d = self.dictionaries[str(s.pathway)]
            iv = pending_iv
            if iv is None and status in (None, "module_incomplete"):
                iv = batch_results.get((s.session_id, spec.id), IndicatorValue.empty(0, status="model_failed"))
            rows.append(
                self._row(
                    run_id, s, d, spec, iv=iv, status=status, flags=flags, selected=selected, q=quality[s.session_id]
                )
            )
        rows.sort(key=lambda r: (r.session_id, r.indicator_id))
        self._standardise(rows)

        group_rows = [
            GroupIndicatorRow(
                scoring_run_id=run_id,
                pathway=pw,
                partition=part,
                indicator_id=spec.id,
                construct=spec.construct,
                formula_ref=spec.formula_ref,
                estimate=_clean(gv.estimate),
                ci_low=_clean(gv.ci_low),
                ci_high=_clean(gv.ci_high),
                n_participants=gv.n_participants,
                n_reports=gv.n_reports,
                details=dict(gv.details),
                dictionary_version=self.dictionaries[pw].version,
                dictionary_sha256=self.dictionaries[pw].sha256,
                algorithm_version=INDICATOR_ALGORITHM_VERSION,
            )
            for pw, spec, part, gv in group_rows_out
        ]
        return ScoringResult(
            manifest=manifest,
            rows=rows,
            group_rows=group_rows,
            sessions=sessions,
            quality=quality,
            partition_models=partition_models,
            consistency_warnings=list(self.consistency_warnings),
        )

    def _row(
        self,
        run_id: str,
        s: SessionRecord,
        d: Dictionary,
        spec: IndicatorSpec,
        *,
        iv: IndicatorValue | None,
        status: Status | None,
        flags: tuple[str, ...],
        selected: Sequence[Trial],
        q: SessionQuality,
    ) -> IndicatorRow:
        all_flags = list(flags)
        if (d.pathway, spec.id) in self._fallback:
            all_flags.append("phase_mismatch_fallback")
        if d.construct_status(spec.construct) == "withheld":
            all_flags.append("construct_withheld_for_pathway")
        value: float | None = None
        transformed: float | None = None
        n_valid = 0
        se: float | None = None
        details: Mapping[str, Any] = {}
        final: str
        if iv is not None:
            all_flags.extend(iv.flags)
            n_valid = iv.n_valid
            details = iv.details
        hard: str | None = status if status not in (None, "module_incomplete") else None
        if iv is not None and iv.status is not None:
            hard = iv.status
        if hard is not None:
            final = hard
        elif iv is None:
            final = "model_failed"
        elif _clean(iv.value) is None or iv.n_valid < spec.min_valid_count:
            final = "module_incomplete" if status == "module_incomplete" else "insufficient_trials"
        else:
            value = _clean(iv.value)
            se = _clean(iv.se)
            transformed, tflags = self._transform(spec, iv)
            all_flags.extend(tflags)
            final = "unscorable_individual" if spec.kind == "single_event_unscorable" else "ok"
        if final not in ("ok", "unscorable_individual"):
            value = transformed = se = None
        seqs = [t.seq_min for t in selected] + [t.seq_max for t in selected]
        return IndicatorRow(
            scoring_run_id=run_id,
            session_id=s.session_id,
            participant_pid=s.participant_pid,
            pathway=str(s.pathway),
            language=s.language,
            calibration_level=s.calibration_level,
            site_mode=s.site_mode,
            battery_arm=s.battery_arm,
            indicator_id=spec.id,
            construct=spec.construct,
            kind=spec.kind,
            formula_ref=spec.formula_ref,
            unit=spec.unit,
            direction=spec.direction,
            transformation=spec.transformation,
            value=value,
            value_transformed=transformed,
            n_valid=int(n_valid),
            min_valid=spec.min_valid_count,
            se=se,
            status=final,
            flags=tuple(sorted(set(all_flags))),
            details=dict(details),
            gate_eligible=spec.gate_eligible and final == "ok",
            exploratory=d.exploratory,
            synthetic=s.synthetic,
            quality_grade=q.grade,
            dictionary_version=d.version,
            dictionary_sha256=d.sha256,
            shared_sha256=d.shared_sha256,
            params_sha256=self.params.sha256,
            algorithm_version=INDICATOR_ALGORITHM_VERSION,
            source_seq_min=min(seqs) if seqs else None,
            source_seq_max=max(seqs) if seqs else None,
            source_event_count=sum(len(t.event_times) for t in selected),
            event_stream_sha256=s.event_stream_sha256,
        )

    def _standardise(self, rows: list[IndicatorRow]) -> None:
        """Apply ``z_within_level_language`` (standardised within calibration level x language)."""
        groups: dict[tuple[str, str | None, str | None], list[int]] = defaultdict(list)
        for i, r in enumerate(rows):
            if r.transformation == "z_within_level_language" and r.value is not None:
                groups[(r.indicator_id, r.calibration_level, r.language)].append(i)
        for idx in groups.values():
            vals = np.array([rows[i].value for i in idx], dtype=float)
            sd = float(vals.std(ddof=1)) if vals.size > 1 else 0.0
            mean = float(vals.mean())
            for i in idx:
                z = (float(rows[i].value or 0.0) - mean) / sd if sd > 0 else None
                rows[i] = _replace(rows[i], value_transformed=z)


def _replace(row: IndicatorRow, **changes: Any) -> IndicatorRow:
    data = {f: getattr(row, f) for f in row.__dataclass_fields__}
    data.update(changes)
    return IndicatorRow(**data)


def score_events(
    events: Iterable[Mapping[str, Any]],
    trial_params: Mapping[str, Mapping[str, Mapping[str, Any]]] | None = None,
    **engine_kwargs: Any,
) -> ScoringResult:
    """Convenience wrapper: build an :class:`IndicatorEngine` and score ``events``."""
    return IndicatorEngine(**engine_kwargs).score(events, trial_params)
