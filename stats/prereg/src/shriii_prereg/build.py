"""Build the pre-registration document model from the loaded inputs.

The model is a plain, JSON-serialisable dict consumed by the Jinja2 templates and written verbatim as the
JSON manifest. No threshold is invented here: every number comes from the inputs (hypotheses, gates,
dictionary) or from the planning section of the generator config, and computed sample sizes are derived
with ``shriii_validation.power`` from those values.

Cross-reference checks produce ``issues`` (severity ``error`` or ``warning``). ``strict`` turns errors
(and, with ``require_frozen``, unfrozen inputs) into a :class:`PreregBuildError`.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Iterable, Mapping
from datetime import UTC, datetime
from typing import Any

from shriii_prereg._version import GENERATOR_VERSION
from shriii_prereg.inputs import PreregInputs, as_list, as_map
from shriii_prereg.power import compute_power

__all__ = ["CORRECTION_LABELS", "PreregBuildError", "build_document"]

CORRECTION_LABELS: dict[str, str] = {
    "holm": "Holm step-down (family-wise error rate)",
    "bh_fdr": "Benjamini-Hochberg (false discovery rate)",
    "bonferroni": "Bonferroni (family-wise error rate)",
    "none": "No multiplicity correction (estimation against pre-registered thresholds)",
}

OP_SYMBOLS: dict[str, str] = {
    "eq": "=",
    "ne": "!=",
    "lt": "<",
    "le": "<=",
    "gt": ">",
    "ge": ">=",
    "in": "in",
    "not_in": "not in",
}

_ROLE_ORDER = {"primary": 0, "secondary": 1, "exploratory": 2}


class PreregBuildError(ValueError):
    """Raised in strict mode when the inputs fail a cross-reference check."""

    def __init__(self, issues: list[dict[str, str]]) -> None:
        self.issues = issues
        lines = "; ".join(f"[{i['severity']}] {i['message']}" for i in issues)
        super().__init__(f"pre-registration inputs failed checks: {lines}")


def _fmt(v: Any) -> str:
    if v is None:
        return "-"
    if isinstance(v, bool):
        return "yes" if v else "no"
    if isinstance(v, float):
        return f"{v:g}"
    if isinstance(v, list | tuple):
        return ", ".join(_fmt(x) for x in v) if v else "-"
    return str(v)


def _condition(when: Iterable[Mapping[str, Any]]) -> str:
    parts = []
    for c in when:
        op = OP_SYMBOLS.get(str(c.get("op")), str(c.get("op")))
        parts.append(f"{c.get('field')} {op} {_fmt(c.get('value'))}")
    return " AND ".join(parts) if parts else "-"


def _issue(issues: list[dict[str, str]], severity: str, code: str, message: str) -> None:
    issues.append({"severity": severity, "code": code, "message": message})


def _min_trials(ind: Mapping[str, Any]) -> str:
    mvt = as_map(ind.get("min_valid_trials"))
    if not mvt:
        return "-"
    count = mvt.get("count")
    unit = mvt.get("unit") or ""
    basis = mvt.get("basis") or "unspecified"
    return f"{_fmt(count)} {unit} ({basis})".replace("  ", " ").strip()


def _indicator_rows(pathway: str, doc: Mapping[str, Any]) -> list[dict[str, Any]]:
    rows = []
    for raw in as_list(doc.get("indicators")):
        ind = as_map(raw)
        src = as_map(ind.get("source"))
        rows.append(
            {
                "pathway": pathway,
                "id": ind.get("id"),
                "construct": ind.get("construct"),
                "role": ind.get("role"),
                "tier": ind.get("tier"),
                "status": ind.get("status"),
                "kind": ind.get("kind"),
                "module": src.get("module_id") or src.get("episode_id"),
                "unit": ind.get("unit"),
                "direction": ind.get("direction"),
                "transformation": ind.get("transformation"),
                "aggregation": ind.get("aggregation"),
                "reliability_method": ind.get("reliability_method"),
                "level_rule": ind.get("level_rule"),
                "min_valid_trials": _min_trials(ind),
                "min_trials_basis": as_map(ind.get("min_valid_trials")).get("basis"),
                "exclusions": list(as_list(ind.get("exclusions"))),
                "missing_data": ind.get("missing_data"),
                "group_only": bool(ind.get("group_only")),
                "gate_eligible": bool(ind.get("gate_eligible")),
                "timing_sensitive": bool(ind.get("timing_sensitive")),
            }
        )
    rows.sort(key=lambda r: (str(r["construct"]), _ROLE_ORDER.get(str(r["role"]), 9), str(r["id"])))
    return rows


def _hypothesis_row(h: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "id": h.get("id"),
        "family": h.get("family"),
        "construct": h.get("construct"),
        "pathways": list(as_list(h.get("pathways"))),
        "type": h.get("type"),
        "indicators": list(as_list(h.get("indicators"))),
        "criterion": h.get("criterion"),
        "convergent_criteria": list(as_list(h.get("convergent_criteria"))),
        "discriminant_criteria": list(as_list(h.get("discriminant_criteria"))),
        "expected_sign": h.get("expected_sign"),
        "r0": h.get("r0"),
        "statistic": h.get("statistic"),
        "pooling": h.get("pooling"),
        "notes": h.get("notes"),
    }


def _check_cross_references(inputs: PreregInputs, issues: list[dict[str, str]]) -> None:
    hyp = inputs.hypotheses.data
    shared = inputs.shared
    families = {str(f.get("id")): as_map(f) for f in as_list(hyp.get("families"))}
    construct_ids = [str(c.get("id")) for c in as_list(shared.get("constructs"))]
    indicators_by_pathway = {
        p: {str(i.get("id")): as_map(i) for i in as_list(d.get("indicators"))}
        for p, d in inputs.pathway_dictionaries().items()
    }
    group_only = set(as_list(inputs.gates.data.get("group_only_indicators")))

    expected_count = shared.get("construct_count")
    if expected_count is not None and int(expected_count) != len(construct_ids):
        _issue(
            issues,
            "error",
            "construct_count",
            f"shared dictionary declares construct_count={expected_count} but lists {len(construct_ids)} constructs",
        )

    seen: Counter[str] = Counter(str(h.get("id")) for h in as_list(hyp.get("hypotheses")))
    for hid, k in seen.items():
        if k > 1:
            _issue(issues, "error", "duplicate_hypothesis", f"hypothesis id {hid!r} appears {k} times")

    for raw in as_list(hyp.get("hypotheses")):
        h = as_map(raw)
        hid = str(h.get("id"))
        fam_id = str(h.get("family"))
        fam = families.get(fam_id)
        if fam is None:
            _issue(issues, "error", "unknown_family", f"{hid}: family {fam_id!r} is not declared")
            continue
        if h.get("construct") not in construct_ids:
            _issue(
                issues,
                "error",
                "unknown_construct",
                f"{hid}: construct {h.get('construct')!r} not in shared dictionary",
            )
        if fam.get("kind") in {"confirmatory", "secondary"} and h.get("type") == "convergent_lower_bound":
            if h.get("expected_sign") is None:
                _issue(
                    issues, "error", "missing_sign", f"{hid}: confirmatory/secondary hypothesis without expected_sign"
                )
            if h.get("r0") is None:
                _issue(issues, "error", "missing_r0", f"{hid}: confirmatory/secondary hypothesis without r0")
        for ind in as_list(h.get("indicators")):
            if ind in group_only and fam.get("kind") != "group_level":
                _issue(
                    issues,
                    "error",
                    "group_only_in_individual_test",
                    f"{hid}: group-only indicator {ind!r} used outside the group_level family",
                )
            pathways = [str(p) for p in as_list(h.get("pathways"))]
            found = [p for p in pathways if ind in indicators_by_pathway.get(p, {})]
            if not found:
                _issue(
                    issues,
                    "error",
                    "unknown_indicator",
                    f"{hid}: indicator {ind!r} not defined in the dictionary of any listed pathway {pathways}",
                )

    coverage = {str(c.get("construct")): as_map(c) for c in as_list(hyp.get("coverage"))}
    for cid in construct_ids:
        if cid not in coverage:
            _issue(issues, "error", "coverage_missing", f"construct {cid!r} has no coverage row in hypotheses.yaml")
    primary_ids = [fid for fid, f in families.items() if f.get("kind") == "confirmatory"]
    for cid, row in coverage.items():
        for pathway in sorted(indicators_by_pathway):
            if row.get(pathway) != "confirmatory":
                continue
            has = any(
                as_map(h).get("construct") == cid
                and as_map(h).get("family") in primary_ids
                and pathway in as_list(as_map(h).get("pathways"))
                for h in as_list(hyp.get("hypotheses"))
            )
            if not has:
                _issue(
                    issues,
                    "error",
                    "confirmatory_without_hypothesis",
                    f"construct {cid!r} is confirmatory for pathway {pathway} but has no confirmatory hypothesis",
                )

    for f in inputs.all_files():
        if f.role == "config":
            continue
        if f.status != "frozen" or f.frozen_at is None:
            _issue(
                issues,
                "warning",
                "not_frozen",
                f"{f.rel_path} is status={f.status!r} (frozen_at={f.frozen_at}); this document is a DRAFT "
                "and must not be submitted until all inputs are frozen by a PLT-09 record",
            )


def build_document(
    inputs: PreregInputs,
    *,
    generated_at: datetime | None = None,
    strict: bool = False,
    require_frozen: bool = False,
) -> dict[str, Any]:
    """Assemble the document model (JSON-serialisable)."""
    issues: list[dict[str, str]] = []
    _check_cross_references(inputs, issues)

    hyp = inputs.hypotheses.data
    gates = inputs.gates.data
    shared = inputs.shared
    cfg = inputs.config.data
    study = as_map(cfg.get("study"))

    hyps = [_hypothesis_row(as_map(h)) for h in as_list(hyp.get("hypotheses"))]
    families = []
    for raw in as_list(hyp.get("families")):
        f = as_map(raw)
        members = [h for h in hyps if h["family"] == f.get("id")]
        m = len(members)
        alpha = f.get("alpha")
        correction = str(f.get("correction"))
        smallest = None
        # Holm/Bonferroni: smallest step alpha/m; BH: smallest critical value q/m.
        if alpha is not None and m and correction in {"holm", "bonferroni", "bh_fdr"}:
            smallest = float(alpha) / m
        families.append(
            {
                "id": f.get("id"),
                "kind": f.get("kind"),
                "correction": correction,
                "correction_label": CORRECTION_LABELS.get(correction, correction),
                "alpha": alpha,
                "description": f.get("description"),
                "n_hypotheses": m,
                "smallest_per_test_alpha": smallest,
                "hypotheses": members,
            }
        )

    constructs: list[dict[str, Any]] = []
    for raw in as_list(shared.get("constructs")):
        c = as_map(raw)
        pw = as_map(c.get("pathways"))
        constructs.append(
            {
                "id": c.get("id"),
                "number": c.get("number"),
                "name": c.get("name"),
                "kind": c.get("kind"),
                "tier": c.get("tier"),
                "restricted": bool(c.get("restricted")),
                "definition": c.get("definition"),
                "pathways": {k: as_map(v).get("status") for k, v in sorted(pw.items())},
                "max_status": as_map(c.get("report")).get("max_status"),
            }
        )
    constructs.sort(key=lambda c: int(str(c["number"] or 0)))

    coverage = [
        {"construct": r.get("construct"), **{k: v for k, v in as_map(r).items() if k != "construct"}}
        for r in as_list(hyp.get("coverage"))
    ]
    pathway_keys = sorted(inputs.pathway_dictionaries())

    exclusion_rules = [
        {
            "id": r.get("id"),
            "applies_to": r.get("applies_to"),
            "description": r.get("description"),
            "condition": _condition(as_list(as_map(r).get("when"))),
        }
        for r in as_list(shared.get("exclusion_rules"))
    ]
    exclusion_usage: Counter[str] = Counter()
    indicators: dict[str, list[dict[str, Any]]] = {}
    basis_counts: dict[str, dict[str, int]] = {}
    for p, d in inputs.pathway_dictionaries().items():
        rows = _indicator_rows(p, d)
        indicators[p] = rows
        basis_counts[p] = dict(Counter(str(r["min_trials_basis"]) for r in rows))
        for r in rows:
            exclusion_usage.update(r["exclusions"])
    for r in exclusion_rules:
        r["n_indicators"] = exclusion_usage.get(str(r["id"]), 0)
    known_rules = {str(r["id"]) for r in exclusion_rules}
    for p, rows in indicators.items():
        for r in rows:
            for ex in r["exclusions"]:
                if ex not in known_rules:
                    _issue(issues, "error", "unknown_exclusion", f"{p}:{r['id']}: exclusion {ex!r} is not defined")

    modules = {
        p: [
            {
                "id": m.get("id"),
                "kind": m.get("kind"),
                "slot": bool(m.get("slot")),
                "order": m.get("order"),
            }
            for m in (as_map(x) for x in as_list(d.get("modules")))
        ]
        for p, d in inputs.pathway_dictionaries().items()
    }

    power = compute_power(
        cfg, hyp, gates, n_languages=len(as_list(as_map(as_map(cfg.get("design")).get("languages")).get("values")))
    )

    inputs_manifest = [f.manifest_entry() for f in inputs.all_files()]
    frozen = all(f.status == "frozen" and f.frozen_at for f in inputs.all_files() if f.role != "config")
    when = (generated_at or datetime.now(UTC)).astimezone(UTC).replace(microsecond=0)

    errors = [i for i in issues if i["severity"] == "error"]
    if strict and errors:
        raise PreregBuildError(errors)
    if require_frozen and not frozen:
        raise PreregBuildError([i for i in issues if i["code"] == "not_frozen"])

    return {
        "schema": "shriii-prereg-document",
        "schema_version": "1.0",
        "meta": {
            "title": study.get("title"),
            "short_title": study.get("short_title") or study.get("title"),
            "registry": study.get("registry"),
            "template": study.get("template"),
            "prereg_id": study.get("prereg_id") or hyp.get("prereg_id"),
            "protocol_id": study.get("protocol_id"),
            "registry_id": hyp.get("registry_id"),
            "hypotheses_version": hyp.get("version"),
            "gates_version": gates.get("version"),
            "dictionary_version": shared.get("version"),
            "status": "frozen" if frozen else "draft",
            "generator": "shriii-prereg",
            "generator_version": GENERATOR_VERSION,
            "generated_at": when.isoformat().replace("+00:00", "Z"),
            "governance_records": {
                "hypotheses": hyp.get("governance_record"),
                "gates": gates.get("governance_record"),
            },
        },
        "inputs": inputs_manifest,
        "issues": issues,
        "study": dict(study),
        "design": dict(as_map(cfg.get("design"))),
        "sampling": dict(as_map(cfg.get("sampling"))),
        "defaults": dict(as_map(hyp.get("defaults"))),
        "families": families,
        "hypotheses": hyps,
        "targets": dict(as_map(hyp.get("targets"))),
        "exceptions": [dict(as_map(e)) for e in as_list(hyp.get("exceptions"))],
        "research_only_path": [dict(as_map(s)) for s in as_list(hyp.get("research_only_path"))],
        "coverage": coverage,
        "pathways": pathway_keys,
        "constructs": constructs,
        "modules": modules,
        "gates": {
            "fail_closed": gates.get("fail_closed"),
            "battery_gate": dict(as_map(gates.get("battery_gate"))),
            "trait_gate": dict(as_map(gates.get("trait_gate"))),
            "caps": [dict(as_map(c)) for c in as_list(gates.get("caps"))],
            "permanent_withhold": [dict(as_map(c)) for c in as_list(gates.get("permanent_withhold"))],
            "group_only_indicators": list(as_list(gates.get("group_only_indicators"))),
            "rules": dict(as_map(gates.get("rules"))),
            "display_rule": dict(as_map(gates.get("display_rule"))),
            "report": dict(as_map(gates.get("report"))),
            "reliability_methods": dict(as_map(gates.get("reliability_methods"))),
            "quality": dict(as_map(gates.get("quality"))),
            "asr_policy": dict(as_map(gates.get("asr_policy"))),
            "stage_exits": dict(as_map(gates.get("stage_exits"))),
        },
        "exclusion_rules": exclusion_rules,
        "missing_data_policies": [dict(as_map(m)) for m in as_list(shared.get("missing_data_policies"))],
        "transformations": [dict(as_map(t)) for t in as_list(shared.get("transformations"))],
        "indicators": indicators,
        "min_trials_basis_counts": basis_counts,
        "power": power,
    }
