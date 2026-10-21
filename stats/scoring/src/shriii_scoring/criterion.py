"""Layer 3: criterion scale scores from item responses and versioned scoring keys (CRT-04).

Reads ``content/instruments/*.yaml`` (structure, reverse keys, subscales, prorating) and produces records
conforming to ``criterion-scale-score.v1``. Rules:

* corrections supersede earlier responses (``supersedes_id``); the latest response per item wins;
* read-aloud records from a public-kiosk context are rejected (returned in ``rejected``);
* reverse-keyed items use ``min + max - x``; out-of-range responses count as missing (flag ``out_of_range``);
* ``mean`` scales average answered items when the answered share reaches ``min_answered_prop``; ``sum``
  scales are prorated (mean x number of items, flag ``prorated``) when some items are missing; too few
  items gives null with ``na_reason = insufficient_items``;
* planned missingness: a subscale whose items belong to a rotating block the occasion did not administer
  is null with ``planned_missing = true`` (FIML / multiple imputation downstream);
* attention checks are scored against the administration key; any failure flags every scale score of the
  occasion ``criterion_careless`` (or nulls them when ``criterion.careless_policy = exclude``);
* performance tasks (ToL board, criterion card sort) are scored from ``<item>.<measure>`` responses.

Scored in Python only; R reads the scale scores.
"""

from __future__ import annotations

import math
import uuid
from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from shriii_scoring._version import CRITERION_ALGORITHM_VERSION
from shriii_scoring.content import load_instruments
from shriii_scoring.params import ScoringParams, load_params
from shriii_scoring.provenance import RUN_NAMESPACE, hash_json
from shriii_scoring.resources import load_yaml

__all__ = ["CriterionScoringResult", "score_criterion"]

ROTATING_BLOCKS = frozenset({"A", "B", "C"})


@dataclass(slots=True)
class CriterionScoringResult:
    """Scale scores plus rejected responses and the scoring run id."""

    scoring_run_id: str
    scores: list[dict[str, Any]]
    rejected: list[dict[str, Any]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def score(self, pid: str, instrument: str, scale: str, occasion: str | None = None) -> float | None:
        for s in self.scores:
            if (
                s["pid"] == pid
                and s["instrument_id"] == instrument
                and s["scale_id"] == scale
                and (occasion is None or s["occasion_id"] == occasion)
            ):
                value = s["score"]
                return None if value is None else float(value)
        raise KeyError((pid, instrument, scale, occasion))


def _latest(responses: Iterable[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    rows = list(responses)
    superseded = {r["supersedes_id"] for r in rows if r.get("supersedes_id")}
    live = [r for r in rows if r["response_id"] not in superseded]
    best: dict[tuple[str, str, str, str], Mapping[str, Any]] = {}
    for r in sorted(live, key=lambda r: (str(r.get("recorded_at", "")), str(r["response_id"]))):
        owner = r.get("rated_pid") if r.get("rater_role") == "partner" and r.get("rated_pid") else r["pid"]
        best[(str(owner), str(r["occasion_id"]), str(r["instrument_id"]), str(r["item_id"]))] = r
    return list(best.values())


def _owner(r: Mapping[str, Any]) -> str:
    return str(r.get("rated_pid") if r.get("rater_role") == "partner" and r.get("rated_pid") else r["pid"])


def score_criterion(
    responses: Iterable[Mapping[str, Any]],
    *,
    attention_key: Mapping[str, float] | None = None,
    performance_keys: Mapping[str, Mapping[str, float]] | None = None,
    administered_blocks: Mapping[tuple[str, str], Iterable[str]] | None = None,
    public_kiosk_context: bool = False,
    instruments_dir: Path | None = None,
    params: ScoringParams | None = None,
    data_snapshot_id: str | None = None,
    computed_at: datetime | None = None,
) -> CriterionScoringResult:
    """Score criterion responses into scale scores.

    ``attention_key``: attention item id -> expected response (from the administration file).
    ``performance_keys``: performance item id -> parameters (e.g. ``{"tol_board.p1": {"min_moves": 2}}``).
    ``administered_blocks``: (pid, occasion_id) -> blocks given; by default inferred from the responses.
    """
    prm = params or load_params()
    instruments = _load_from(instruments_dir) if instruments_dir is not None else load_instruments()
    all_rows = list(responses)
    rejected: list[dict[str, Any]] = []
    rows: list[Mapping[str, Any]] = []
    for r in all_rows:
        if public_kiosk_context and r.get("administration_mode") == "read_aloud":
            rejected.append({**r, "rejection_reason": "read_aloud_in_public_kiosk_context"})
        else:
            rows.append(r)
    rows = _latest(rows)
    run_id = str(
        uuid.uuid5(
            RUN_NAMESPACE,
            hash_json(
                {
                    "alg": CRITERION_ALGORITHM_VERSION,
                    "keys": sorted((k, v[1]) for k, v in instruments.items()),
                    "responses": sorted(str(r["response_id"]) for r in rows),
                    "attention": dict(sorted((attention_key or {}).items())),
                    "performance": performance_keys or {},
                    "params": prm.sha256,
                }
            ),
        )
    )
    now = (computed_at or datetime.now(UTC)).isoformat()
    shared = {str(s["instrument"]): s for s in prm.get("criterion.shared_items")}
    perf_map = prm.get("criterion.performance_measures")
    careless_policy = str(prm.get("criterion.careless_policy"))

    by_occ: dict[tuple[str, str], list[Mapping[str, Any]]] = defaultdict(list)
    for r in rows:
        by_occ[(_owner(r), str(r["occasion_id"]))].append(r)

    scores: list[dict[str, Any]] = []
    warnings: list[str] = []
    for (pid, occ), occ_rows in sorted(by_occ.items()):
        by_item: dict[str, Mapping[str, Any]] = {str(r["item_id"]): r for r in occ_rows}
        blocks = (
            set(administered_blocks.get((pid, occ), ())) if administered_blocks else {str(r["block"]) for r in occ_rows}
        )
        meta = occ_rows[0]
        careless = False
        occ_scores: list[dict[str, Any]] = []
        present_instruments = {str(r["instrument_id"]) for r in occ_rows}
        for inst_id, (inst, _sha) in sorted(instruments.items()):
            alias = shared.get(inst_id)
            if inst_id not in present_instruments and not (alias and str(alias["source"]) in present_instruments):
                continue
            items = {str(it["item_id"]): it for it in inst["items"]}
            resp_for: dict[str, Mapping[str, Any]] = {}
            for iid, it in items.items():
                if iid in by_item:
                    resp_for[iid] = by_item[iid]
                elif alias is not None:
                    lo, hi = (int(v) for v in alias["numbers"])
                    if lo <= int(it["number"]) <= hi:
                        src = f"{alias['source']}.i{int(it['number']):02d}"
                        if src in by_item:
                            resp_for[iid] = by_item[src]
            scale = inst["response_scale"]
            smin, smax = scale.get("min"), scale.get("max")
            kind = str(inst["kind"])
            for sub in inst["subscales"]:
                rec = _score_subscale(
                    inst,
                    sub,
                    items=items,
                    resp_for=resp_for,
                    by_item=by_item,
                    blocks=blocks,
                    smin=smin,
                    smax=smax,
                    kind=kind,
                    attention_key=attention_key,
                    performance_keys=performance_keys,
                    perf_map=perf_map.get(inst_id, {}),
                )
                if rec is None:
                    continue
                if inst_id == "attention_checks" and sub["scale_id"] == "failed_count" and (rec["score"] or 0) >= 1:
                    careless = True
                rec.update(
                    {
                        "schema_version": "1.0",
                        "pid": pid,
                        "study_id": meta["study_id"],
                        "wave": meta["wave"],
                        "occasion_id": occ,
                        "instrument_id": inst_id,
                        "instrument_version": inst["version"],
                        "scale_id": sub["scale_id"],
                        "score_type": sub["score_type"],
                        "n_items": len(sub["items"]),
                        "key_version": inst["scoring"]["key_version"],
                        "algorithm_version": CRITERION_ALGORITHM_VERSION,
                        "scoring_run_id": run_id,
                        "data_snapshot_id": data_snapshot_id,
                        "computed_at": now,
                    }
                )
                rec["score_id"] = str(uuid.uuid5(RUN_NAMESPACE, f"{run_id}|{pid}|{occ}|{inst_id}|{sub['scale_id']}"))
                occ_scores.append(rec)
        if careless:
            for rec in occ_scores:
                rec["flags"] = sorted({*rec["flags"], "criterion_careless"})
                if careless_policy == "exclude" and rec["instrument_id"] != "attention_checks":
                    rec["score"] = None
                    rec["na_reason"] = "criterion_careless"
        scores.extend(occ_scores)
    ordered_keys = (
        "schema_version",
        "score_id",
        "pid",
        "study_id",
        "wave",
        "occasion_id",
        "instrument_id",
        "instrument_version",
        "scale_id",
        "score",
        "score_type",
        "n_answered",
        "n_items",
        "key_version",
        "algorithm_version",
        "prorated",
        "planned_missing",
        "na_reason",
        "flags",
        "source_response_ids",
        "scoring_run_id",
        "data_snapshot_id",
        "computed_at",
    )
    scores = [{k: s[k] for k in ordered_keys} for s in scores]
    return CriterionScoringResult(run_id, scores, rejected, warnings)


def _load_from(directory: Path) -> dict[str, tuple[Mapping[str, Any], str]]:
    out: dict[str, tuple[Mapping[str, Any], str]] = {}
    for f in sorted(directory.glob("*.yaml")):
        doc = load_yaml(f)
        out[str(doc.data["instrument_id"])] = (doc.data, doc.sha256)
    return out


def _score_subscale(
    inst: Mapping[str, Any],
    sub: Mapping[str, Any],
    *,
    items: Mapping[str, Mapping[str, Any]],
    resp_for: Mapping[str, Mapping[str, Any]],
    by_item: Mapping[str, Mapping[str, Any]],
    blocks: set[str],
    smin: float | None,
    smax: float | None,
    kind: str,
    attention_key: Mapping[str, float] | None,
    performance_keys: Mapping[str, Mapping[str, float]] | None,
    perf_map: Mapping[str, Any],
) -> dict[str, Any] | None:
    sub_items = [str(i) for i in sub["items"]]
    n_items = len(sub_items)
    sub_blocks = {str(items[i]["block"]) for i in sub_items if i in items}
    rec: dict[str, Any] = {
        "score": None,
        "n_answered": 0,
        "prorated": False,
        "planned_missing": False,
        "na_reason": None,
        "flags": [],
        "source_response_ids": [],
    }
    missing_blocks = {b for b in sub_blocks if b in ROTATING_BLOCKS and b not in blocks}
    if kind == "performance":
        return _score_performance(
            inst, sub, perf_map=perf_map, by_item=by_item, performance_keys=performance_keys, rec=rec
        )
    answered: list[tuple[str, float]] = []
    flags: set[str] = set()
    for iid in sub_items:
        r = resp_for.get(iid)
        if r is None or r.get("raw_response") is None:
            continue
        x = float(r["raw_response"])
        if (smin is not None and x < float(smin)) or (smax is not None and x > float(smax)) or not math.isfinite(x):
            flags.add("out_of_range")
            continue
        rec["source_response_ids"].append(str(r["response_id"]))
        if items[iid].get("attention_check"):
            if attention_key is None or iid not in attention_key:
                flags.add("attention_key_missing")
                continue
            answered.append((iid, 0.0 if x == float(attention_key[iid]) else 1.0))
            continue
        if items[iid].get("reverse_keyed"):
            if inst["response_scale"].get("reverse_formula") != "min_plus_max_minus_x" or smin is None or smax is None:
                raise ValueError(f"{iid}: reverse-keyed item without a min_plus_max_minus_x response scale")
            x = float(smin) + float(smax) - x
        answered.append((iid, x))
    rec["n_answered"] = len(answered)
    rec["source_response_ids"] = sorted(set(rec["source_response_ids"]))
    if missing_blocks and len(answered) < n_items:
        rec.update(
            {"planned_missing": True, "na_reason": "planned_missing", "flags": sorted(flags | {"planned_missing"})}
        )
        return rec
    if not answered and "attention_key_missing" not in flags:
        rec.update({"na_reason": "not_administered", "flags": sorted(flags)})
        return rec
    prop = len(answered) / n_items
    min_prop = float(sub["min_answered_prop"])
    if prop + 1e-9 < min_prop:
        rec.update({"na_reason": "insufficient_items", "flags": sorted(flags)})
        return rec
    vals = [v for _, v in answered]
    st = str(sub["score_type"])
    if st == "mean":
        score = sum(vals) / len(vals)
        if len(vals) < n_items:
            flags.add("prorated")
            rec["prorated"] = True
    elif st == "sum":
        if len(vals) < n_items:
            score = sum(vals) / len(vals) * n_items
            flags.add("prorated")
            rec["prorated"] = True
        else:
            score = sum(vals)
    elif st == "count":
        score = sum(vals)
    elif st == "proportion":
        score = sum(vals) / len(vals)
    else:
        score = sum(vals) / len(vals)
    rec.update({"score": float(score), "flags": sorted(flags)})
    return rec


def _score_performance(
    inst: Mapping[str, Any],
    sub: Mapping[str, Any],
    *,
    perf_map: Mapping[str, Any],
    by_item: Mapping[str, Mapping[str, Any]],
    performance_keys: Mapping[str, Mapping[str, float]] | None,
    rec: dict[str, Any],
) -> dict[str, Any]:
    spec = perf_map.get(sub["scale_id"])
    if spec is None:
        raise ValueError(f"no performance measure mapping for {inst['instrument_id']}.{sub['scale_id']}")
    measure = str(spec["measure"])
    agg = str(spec["aggregate"])
    vals: list[float] = []
    ids: list[str] = []
    n_items = len(sub["items"])
    for item in sub["items"]:
        r = by_item.get(f"{item}.{measure}")
        if r is None or r.get("raw_response") is None:
            continue
        x = float(r["raw_response"])
        if agg == "excess_over_min_moves":
            key = (performance_keys or {}).get(str(item))
            if key is None or "min_moves" not in key:
                raise ValueError(f"performance key with min_moves required for {item} (administration file)")
            x = max(0.0, x - float(key["min_moves"]))
        vals.append(x)
        ids.append(str(r["response_id"]))
    rec["n_answered"] = len(vals)
    rec["source_response_ids"] = sorted(ids)
    if not vals:
        rec["na_reason"] = "not_administered"
        return rec
    if len(vals) / n_items + 1e-9 < float(sub["min_answered_prop"]):
        rec["na_reason"] = "insufficient_items"
        return rec
    flags: list[str] = []
    if agg in ("excess_over_min_moves", "sum"):
        score = sum(vals)
        if len(vals) < n_items:
            score = score / len(vals) * n_items
            rec["prorated"] = True
            flags.append("prorated")
    elif agg == "mean":
        score = sum(vals) / len(vals)
    else:
        score = vals[0]
    rec["score"] = float(score)
    rec["flags"] = flags
    return rec


def items_by_block(instrument: Mapping[str, Any]) -> dict[str, list[str]]:
    """Item ids grouped by administration block (helper for planned-missingness designs)."""
    out: dict[str, list[str]] = defaultdict(list)
    for it in instrument["items"]:
        out[str(it["block"])].append(str(it["item_id"]))
    return dict(out)


def required_blocks(instruments: Sequence[Mapping[str, Any]]) -> set[str]:
    """Every administration block used by the given instruments."""
    return {str(it["block"]) for inst in instruments for it in inst["items"]}
