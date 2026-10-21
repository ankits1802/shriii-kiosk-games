"""Turn a validated :class:`ReportBundle` into the template context.

Integrity rules applied here (never in templates):

* **Confirmatory vs exploratory** (CRT-11 AC, VAL-15): a result is confirmatory only if it cites a
  ``hypothesis_id`` whose family in ``hypotheses.yaml`` is of kind ``confirmatory``. Registered
  non-confirmatory families are ``secondary``; anything else is ``exploratory``. A result that claims to be
  confirmatory without such a citation is demoted and the demotion is listed in the report.
* **No number without evidence**: results whose status is not ``ok`` show the reason, never an estimate.
* **Small-cell suppression** (VAL-16, disclosure control): subgroup results and norm cells with
  n below ``gates.yaml quality.fairness_cell_min_n`` are suppressed.
* **Provenance consistency**: the bundle's hypotheses/gates hashes must match the registry files used for
  rendering; a mismatch is reported prominently.
"""

from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from shriii_reports.model import ReportBundle, ResultEntry

__all__ = ["SECTION_TITLES", "Registry", "load_registry", "prepare_context", "section_title"]

SECTION_TITLES: dict[str, str] = {
    "descriptives": "Descriptives and data quality",
    "reliability": "Reliability by indicator kind",
    "criterion_invariance": "Criterion-scale invariance across languages and modes",
    "convergent": "Convergent validity (observed r)",
    "discriminant_pattern": "Discriminant pattern (r_contrast-CV)",
    "nomological": "Nomological predictions (style constructs)",
    "pathway_comparison": "Pathway B vs A comparison",
    "retest": "Test-retest stability",
    "practice_effects": "Practice and form effects",
    "attrition": "Retest attrition",
    "invariance": "Trial-level measurement invariance",
    "dif": "Differential item functioning (purified matching)",
    "differential_exclusion": "Differential exclusion",
    "mode_equivalence": "Supervised vs unattended mode equivalence",
    "asr": "ASR accuracy gaps",
    "incremental_validity": "Incremental validity",
    "criterion_validity": "Criterion validity",
    "norming": "Norming diagnostics",
    "structure": "Factor structure",
    "group_level": "Group-level estimators (never individual)",
}


def section_title(key: str) -> str:
    """Display title of a result section (unknown keys are humanised)."""
    return SECTION_TITLES.get(key, key.replace("_", " ").capitalize())


@dataclass(frozen=True, slots=True)
class Registry:
    """Optional science inputs used while rendering (read-only)."""

    hypotheses: Mapping[str, Any] | None = None
    hypotheses_sha256: str | None = None
    gates: Mapping[str, Any] | None = None
    gates_sha256: str | None = None
    families: Mapping[str, Mapping[str, Any]] = field(default_factory=dict)
    hypothesis_family: Mapping[str, str] = field(default_factory=dict)

    @property
    def min_cell_n(self) -> int | None:
        if not self.gates:
            return None
        v = self.gates.get("quality", {}).get("fairness_cell_min_n")
        return None if v is None else int(v)


def _sha(raw: bytes) -> str:
    return hashlib.sha256(raw.replace(b"\r\n", b"\n")).hexdigest()


def load_registry(hypotheses_path: Path | None, gates_path: Path | None) -> Registry:
    hyp = gates = None
    hsha = gsha = None
    if hypotheses_path is not None:
        raw = hypotheses_path.read_bytes()
        hyp, hsha = yaml.safe_load(raw.decode("utf-8")), _sha(raw)
    if gates_path is not None:
        raw = gates_path.read_bytes()
        gates, gsha = yaml.safe_load(raw.decode("utf-8")), _sha(raw)
    families: dict[str, Mapping[str, Any]] = {}
    hyp_family: dict[str, str] = {}
    if hyp:
        families = {str(f["id"]): f for f in hyp.get("families", [])}
        hyp_family = {str(h["id"]): str(h["family"]) for h in hyp.get("hypotheses", [])}
    return Registry(hyp, hsha, gates, gsha, families, hyp_family)


# ----------------------------------------------------------------------------- formatting


def fmt_num(v: float | None, digits: int = 3) -> str:
    if v is None:
        return "-"
    return f"{v:.{digits}f}"


def fmt_ci(lo: float | None, hi: float | None, level: float | None, digits: int = 3) -> str:
    if lo is None or hi is None:
        return "-"
    lv = f"{level * 100:g}% " if level is not None else ""
    return f"{lv}[{lo:.{digits}f}, {hi:.{digits}f}]"


def fmt_group(group: Mapping[str, Any]) -> str:
    return ", ".join(f"{k}={v}" for k, v in group.items()) if group else "all"


def _p_value(details: Mapping[str, Any]) -> str:
    for key, label in (("p_adjusted", " (adj.)"), ("p_holm", " (Holm)"), ("p_bh", " (BH)"), ("p_value", ""), ("p", "")):
        v = details.get(key)
        if isinstance(v, int | float) and not isinstance(v, bool) and math.isfinite(v):
            return (f"{v:.4f}" if v >= 0.0001 else "<0.0001") + label
    return "-"


def _classify(r: ResultEntry, reg: Registry, warnings: list[str]) -> str:
    ref = f"{r.result_id or r.subject}/{r.metric}"
    if r.hypothesis_id is None:
        if r.confirmatory:
            warnings.append(f"{ref}: claimed confirmatory without a hypothesis_id; shown as exploratory")
        return "exploratory"
    if reg.hypotheses is None:
        # Without the registry the family cannot be checked: trust only an explicit confirmatory flag.
        return "confirmatory" if r.confirmatory else ("secondary" if r.family else "exploratory")
    fam_id = reg.hypothesis_family.get(r.hypothesis_id)
    if fam_id is None:
        warnings.append(f"{ref}: hypothesis_id {r.hypothesis_id!r} is not in the registry; shown as exploratory")
        return "exploratory"
    if r.family is not None and r.family != fam_id:
        warnings.append(f"{ref}: family {r.family!r} differs from registry family {fam_id!r}; registry used")
    kind = str(reg.families.get(fam_id, {}).get("kind", "exploratory"))
    if kind == "confirmatory":
        return "confirmatory"
    if r.confirmatory:
        warnings.append(
            f"{ref}: claimed confirmatory but {r.hypothesis_id!r} is in family {fam_id!r} ({kind}); demoted"
        )
    if kind in {"secondary", "group_level"}:
        return "secondary"
    return "exploratory"


def _result_view(r: ResultEntry, reg: Registry, warnings: list[str]) -> dict[str, Any]:
    ev = r.evidence
    tier = _classify(r, reg, warnings)
    min_n = reg.min_cell_n
    suppressed = bool(r.subgroup) and min_n is not None and ev.n < min_n
    if suppressed:
        estimate, ci, p, decision = "suppressed", "-", "-", f"suppressed (n < {min_n})"
    elif not ev.ok:
        reason = "; ".join(ev.warnings) or "no estimate"
        estimate, ci, p, decision = "-", "-", "-", f"not available ({ev.status}): {reason}"
    else:
        estimate = fmt_num(ev.estimate)
        ci = fmt_ci(ev.ci_low, ev.ci_high, ev.ci_level)
        p = _p_value(ev.details)
        decision = "-" if r.passed is None else ("pass" if r.passed else "fail")
    threshold = r.threshold_rule or ("-" if r.threshold is None else fmt_num(r.threshold))
    failed_assumptions = [a.name + (f" ({a.detail})" if a.detail else "") for a in ev.assumptions if not a.passed]
    return {
        "id": r.result_id,
        "section": r.section,
        "subject": r.subject,
        "subject_kind": r.subject_kind,
        "metric": r.metric,
        "hypothesis_id": r.hypothesis_id or "-",
        "tier": tier,
        "pathway": r.pathway or "-",
        "language": r.language or "-",
        "group": fmt_group(r.subgroup),
        "estimate": estimate,
        "ci": ci,
        "n": ev.n,
        "p": p,
        "threshold": threshold,
        "decision": decision,
        "passed": None if suppressed or not ev.ok else r.passed,
        "method": ev.method,
        "status": ev.status,
        "suppressed": suppressed,
        "warnings": list(ev.warnings),
        "failed_assumptions": failed_assumptions,
        "provenance_sha": ev.provenance.inputs_sha256 if ev.provenance else None,
        "algorithm_version": ev.provenance.algorithm_version if ev.provenance else None,
        "run_id": r.run_id or "-",
    }


def _canonical_sha(bundle: ReportBundle) -> str:
    payload = json.dumps(bundle.model_dump(mode="json", by_alias=True), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def prepare_context(bundle: ReportBundle, reg: Registry, *, section_order: Sequence[str] = ()) -> dict[str, Any]:
    """Template context for any report kind."""
    warnings: list[str] = []
    views = [_result_view(r, reg, warnings) for r in bundle.results]

    sections: dict[str, list[dict[str, Any]]] = {}
    for v in views:
        sections.setdefault(v["section"], []).append(v)
    ordered = [s for s in section_order if s in sections] + [s for s in sections if s not in section_order]

    def split(rows: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
        return {t: [r for r in rows if r["tier"] == t] for t in ("confirmatory", "secondary", "exploratory")}

    prov = bundle.provenance
    integrity: list[str] = []
    if reg.hypotheses_sha256 and prov.hypotheses_sha256 and reg.hypotheses_sha256 != prov.hypotheses_sha256:
        integrity.append(
            f"Results were computed against hypotheses.yaml sha256 {prov.hypotheses_sha256[:12]}..., but the registry "
            f"used for rendering has {reg.hypotheses_sha256[:12]}... Classification may not match the registered plan."
        )
    if reg.gates_sha256 and prov.gates_sha256 and reg.gates_sha256 != prov.gates_sha256:
        integrity.append(
            f"Results were computed against gates.yaml sha256 {prov.gates_sha256[:12]}..., but the gates file used "
            f"for rendering has {reg.gates_sha256[:12]}..."
        )
    if reg.hypotheses_sha256 and not prov.hypotheses_sha256 and any(v["tier"] != "exploratory" for v in views):
        integrity.append(
            "The bundle does not record the hypotheses.yaml sha256 the analysis used, so registered "
            "(confirmatory/secondary) classifications cannot be tied to the registered plan."
        )
    if reg.gates_sha256 and not prov.gates_sha256 and (bundle.trait_gates or bundle.battery_gates):
        integrity.append(
            "The bundle does not record the gates.yaml sha256 the gate evaluations used; the thresholds "
            "behind these decisions cannot be verified."
        )
    stage = bundle.report.stage.upper()
    if stage not in {"S1", "S1B"} and not prov.prereg_id and bundle.report.kind != "technical_manual":
        integrity.append(
            f"No prereg_id recorded for stage {bundle.report.stage}: "
            "from S2 onwards analyses require a registered plan (CRT-07)."
        )
    if bundle.report.kind == "stage2_pilot" and reg.gates is not None:
        allows = bool(reg.gates.get("stage_exits", {}).get("stage2_allows_drops", False))
        drops = [d.indicator_id for d in bundle.indicator_decisions if d.decision in {"drop", "revise", "retain"}]
        if drops and not allows:
            integrity.append(
                "Stage 2 exit allows provisional flags only (gates.yaml stage_exits.stage2_allows_drops = false), "
                "but final "
                f"retain/revise/drop decisions are present for: {', '.join(sorted(drops))}."
            )

    enrolled = bundle.sample.enrolled
    exclusions = []
    diff_max = None
    if reg.gates is not None:
        diff_max = reg.gates.get("battery_gate", {}).get("differential_exclusion_max_pp")
    differential = []
    for e in bundle.exclusions:
        exclusions.append(
            {
                "rule_id": e.rule_id,
                "description": e.description,
                "n_sessions": e.n_sessions,
                "n_participants": "-" if e.n_participants is None else e.n_participants,
                "pct": "-" if enrolled == 0 else f"{100 * e.n_sessions / enrolled:.1f}%",
            }
        )
        for grouping, rates in e.by_group.items():
            if len(rates) < 2:
                continue
            spread = 100 * (max(rates.values()) - min(rates.values()))
            differential.append(
                {
                    "rule_id": e.rule_id,
                    "grouping": grouping,
                    "rates": ", ".join(f"{k} {100 * v:.1f}%" for k, v in sorted(rates.items())),
                    "spread_pp": f"{spread:.1f}",
                    "limit_pp": "-" if diff_max is None else f"{float(diff_max):g}",
                    "within": "-" if diff_max is None else ("yes" if spread <= float(diff_max) else "no"),
                }
            )

    targets = [
        {
            "metric": t.metric,
            "group": fmt_group(t.group),
            "observed": "-" if t.observed is None else f"{100 * t.observed:.1f}%",
            "target": f"{100 * t.target:g}%",
            "n": t.n,
            "met": "-" if t.observed is None else ("yes" if t.observed >= t.target else "no"),
        }
        for t in bundle.targets
    ]

    min_n = reg.min_cell_n
    norm_tables = []
    for nt in bundle.norm_tables:
        pct_keys = sorted({k for c in nt.cells for k in c.percentiles}, key=float)
        cells = []
        for c in nt.cells:
            small = min_n is not None and c.n < min_n
            cells.append(
                {
                    "label": c.label,
                    "n": c.n,
                    "effective_n": f"{c.effective_n:.1f}",
                    "provisional": c.provisional,
                    "values": ["suppressed" if small else fmt_num(c.percentiles.get(k), 2) for k in pct_keys],
                    "suppressed": small,
                }
            )
        norm_tables.append(
            {
                "version": nt.version,
                "trait": nt.trait,
                "language_group": nt.language_group,
                "method": nt.method,
                "weights_scheme": nt.weights_scheme,
                "provisional": nt.provisional,
                "percentile_keys": [f"P{k}" for k in pct_keys],
                "cells": cells,
            }
        )

    flagged = [v for v in views if v["warnings"] or v["failed_assumptions"]]
    counts = {t: sum(1 for v in views if v["tier"] == t) for t in ("confirmatory", "secondary", "exploratory")}

    return {
        "bundle": bundle,
        "report": bundle.report,
        "prov": prov,
        "bundle_sha256": _canonical_sha(bundle),
        "sample": bundle.sample,
        "sample_cells": [
            {"group": fmt_group(c.group), "n": c.n, "target": "-" if c.target is None else c.target}
            for c in bundle.sample.cells
        ],
        "exclusions": exclusions,
        "differential_exclusion": differential,
        "targets": targets,
        "results": views,
        "sections": [
            {"key": s, "title": section_title(s), "rows": sections[s], "by_tier": split(sections[s])} for s in ordered
        ],
        "section_map": {
            s: {"title": section_title(s), "rows": sections[s], "by_tier": split(sections[s])} for s in ordered
        },
        "tier_counts": counts,
        "flagged": flagged,
        "classification_warnings": warnings,
        "integrity_warnings": integrity,
        "trait_gates": [
            {
                "trait": g.trait,
                "language": g.language,
                "pathway": g.pathway,
                "status": g.status,
                "evaluated": g.evaluated_status or "-",
                "rules": ", ".join(f"{k}:{v}" for k, v in sorted(g.rules.items())) or "-",
                "reasons": "; ".join(g.reasons) or "-",
                "capped": g.capped,
                "evaluate_only": g.evaluate_only,
            }
            for g in bundle.trait_gates
        ],
        "battery_gates": [
            {
                "language": g.language,
                "pathway": g.pathway,
                "site_mode": g.site_mode,
                "status": g.status,
                "rules": ", ".join(f"{k}:{v}" for k, v in sorted(g.rules.items())) or "-",
                "reasons": "; ".join(g.reasons) or "-",
                "qualifying": ", ".join(g.qualifying_languages) or "-",
            }
            for g in bundle.battery_gates
        ],
        "indicator_decisions": [
            {
                "indicator": d.indicator_id,
                "pathway": d.pathway,
                "decision": d.decision,
                "flags": ", ".join(d.provisional_flags) or "-",
                "rationale": d.rationale or "-",
                "signers": ", ".join(d.signers) or "-",
            }
            for d in bundle.indicator_decisions
        ],
        "norm_tables": norm_tables,
        "gates": reg.gates or {},
        "hypotheses_registry": reg.hypotheses or {},
        "registry_sha": {"hypotheses": reg.hypotheses_sha256, "gates": reg.gates_sha256},
        "min_cell_n": min_n,
        "notes": list(bundle.notes),
    }
