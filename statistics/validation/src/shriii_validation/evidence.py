"""Assemble gate evidence from persisted analysis results and evaluate the gates (evaluate-only by default).

The rows are the :class:`~shriii_validation.analysis.ResultRecord` dictionaries produced by
:func:`~shriii_validation.analysis.run_analysis` (as stored in ``validation.statistical_results``). For each
(trait, language, pathway) the evidence is read from:

* B1 - ``reliability`` / ``icc_a1`` rows of the construct composite in that language;
* B2 - ``reliability`` / ``omega_total`` (or ``alpha``) rows of the construct in that language;
* B3 - ``construct_validity`` hypothesis rows in that language: the construct's primary convergent
  hypothesis (sign-aligned lower bound, family-corrected pass), its discriminant pattern and, for style
  constructs, the nomological predictions;
* B4 - ``measurement_invariance`` / ``invariance_level`` rows per required grouping;
* B5 - norm tables supplied by the caller; B6 - named sign-offs supplied by the caller.

Battery evidence (A3) uses the ``criterion_invariance``, DIF and ``differential_exclusion_pp`` rows. Missing
evidence stays missing: the evaluator in :mod:`shriii_validation.gates` keeps such gates closed.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import asdict
from typing import Any

from shriii_validation.gates import (
    BatteryEvidence,
    TraitEvidence,
    TraitGateDecision,
    evaluate_battery_gate,
    evaluate_trait_gate,
)

__all__ = ["battery_evidence_from_results", "evaluate_gates", "trait_evidence_from_results"]

Row = Mapping[str, Any]


def _sub(row: Row) -> Mapping[str, Any]:
    return row.get("subgroup") or {}


def _pick(rows: Sequence[Row], **match: Any) -> list[Row]:
    out = []
    for r in rows:
        ok = True
        for k, v in match.items():
            if k.startswith("sub_"):
                if _sub(r).get(k[4:]) != v:
                    ok = False
                    break
            elif r.get(k) != v:
                ok = False
                break
        if ok:
            out.append(r)
    return out


def _status_ok(row: Row) -> bool:
    return bool((row.get("details") or {}).get("status", "ok") == "ok" and row.get("estimate") is not None)


def trait_evidence_from_results(
    rows: Sequence[Row],
    *,
    trait: str,
    language: str,
    pathway: str,
    hypotheses: Mapping[str, Any],
    required_groupings: Sequence[str],
    norms: str | None = None,
    signoffs: Sequence[str] = (),
) -> TraitEvidence:
    """Evidence for one (trait, language, pathway); absent evidence is ``None`` (fail closed)."""
    icc = [
        r
        for r in _pick(rows, subject=trait, subject_kind="construct", metric="icc_a1", sub_language=language)
        if _status_ok(r)
    ]
    rel = [
        r
        for r in rows
        if r.get("subject") == trait
        and r.get("subject_kind") == "construct"
        and r.get("metric") in ("omega_total", "alpha")
        and _sub(r).get("language") == language
        and _status_ok(r)
    ]
    hyps = {h["id"]: h for h in hypotheses.get("hypotheses", [])}
    hyp_rows = [
        r
        for r in rows
        if r.get("subject_kind") == "hypothesis"
        and _sub(r).get("language") == language
        and _sub(r).get("pathway", pathway) == pathway
        and r.get("hypothesis_id") in hyps
        and hyps[str(r["hypothesis_id"])].get("construct") == trait
        and r.get("metric") in ("pearson_r", "r_contrast_cv")
    ]

    def first(family: str, kind: str) -> Row | None:
        cands = [
            r
            for r in hyp_rows
            if hyps[str(r["hypothesis_id"])].get("family") == family
            and hyps[str(r["hypothesis_id"])].get("type") == kind
        ]
        cands.sort(key=lambda r: str(r["hypothesis_id"]))
        return cands[0] if cands else None

    conv = first("primary", "convergent_lower_bound") or first("secondary", "convergent_lower_bound")
    conv_r = conv_lower = None
    sign_ok = holm = None
    if conv is not None and _status_ok(conv) and conv.get("ci_low") is not None and conv.get("ci_high") is not None:
        exp = {"positive": 1, "negative": -1}.get(str(hyps[str(conv["hypothesis_id"])].get("expected_sign")), 1)
        conv_r = float(conv["estimate"])
        conv_lower = float(conv["ci_low"]) if exp > 0 else -float(conv["ci_high"])
        sign_ok = conv_r * exp > 0
        holm = conv.get("passed")
    pattern = first("discriminant_pattern", "discriminant_pattern")
    nomological = [r for r in hyp_rows if hyps[str(r["hypothesis_id"])].get("type") == "nomological" and _status_ok(r)]
    invariance: dict[str, bool] | None = None
    inv_rows = [
        r for r in rows if r.get("metric") == "invariance_level" and r.get("subject") == trait and _status_ok_level(r)
    ]
    if inv_rows:
        invariance = {}
        for r in inv_rows:
            g = str(_sub(r).get("grouping"))
            invariance[g] = bool(r.get("passed")) and invariance.get(g, True)
    return TraitEvidence(
        trait=trait,
        language=language,
        pathway=pathway,
        retest_icc_a1=float(icc[0]["estimate"]) if icc else None,
        retest_icc_a1_lower=float(icc[0]["ci_low"]) if icc and icc[0].get("ci_low") is not None else None,
        retest_pairs=int(icc[0]["n"]) if icc else None,
        reliability=float(rel[0]["estimate"]) if rel else None,
        reliability_lower=float(rel[0]["ci_low"]) if rel and rel[0].get("ci_low") is not None else None,
        convergent_r=conv_r,
        convergent_lower=conv_lower,
        convergent_sign_correct=sign_ok,
        convergent_holm_passed=holm,
        convergent_observed=True,
        pattern_passed=pattern.get("passed") if pattern is not None and _status_ok(pattern) else None,
        nomological_passed=all(bool(r.get("passed")) for r in nomological) if nomological else None,
        invariance=invariance if invariance is not None and any(g in invariance for g in required_groupings) else None,
        norms="final" if norms == "final" else ("provisional" if norms == "provisional" else None),
        signoffs=tuple(signoffs),
    )


def _status_ok_level(row: Row) -> bool:
    return bool((row.get("details") or {}).get("status", "ok") == "ok")


def battery_evidence_from_results(
    rows: Sequence[Row], *, language: str, pathway: str, site_mode: str, signoff_roles: Sequence[str] = ()
) -> BatteryEvidence:
    """Battery release evidence for one cell (A3/A5); missing parts stay ``None``."""
    crit = [r for r in rows if r.get("metric") == "criterion_invariance" and _status_ok_level(r)]
    dif_rows = [
        r
        for r in rows
        if r.get("metric") == "dif_delta_r2"
        and _sub(r).get("grouping") == "language"
        and language in (_sub(r).get("reference"), _sub(r).get("focal"))
    ]
    excl = [r for r in rows if r.get("metric") == "differential_exclusion_pp" and _status_ok(r)]
    return BatteryEvidence(
        language=language,
        pathway=pathway,
        site_mode=site_mode,
        criterion_invariance_passed=bool(crit[0].get("passed")) if crit else None,
        unresolved_large_dif=any((r.get("details") or {}).get("class") == "C" for r in dif_rows) if dif_rows else None,
        differential_exclusion_pp=float(excl[0]["estimate"]) if excl else None,
        mode_equivalence_passed=None,
        signoff_roles=tuple(signoff_roles),
    )


def evaluate_gates(
    rows: Sequence[Row],
    *,
    gates: Mapping[str, Any],
    constructs: Mapping[str, Mapping[str, Any]],
    hypotheses: Mapping[str, Any],
    pathway: str,
    languages: Sequence[str],
    site_modes: Sequence[str] = ("supervised",),
    norms: Mapping[tuple[str, str], str] | None = None,
    signoffs: Mapping[tuple[str, str], Sequence[str]] | None = None,
    battery_signoffs: Mapping[tuple[str, str], Sequence[str]] | None = None,
    evaluate_only: bool = True,
    gates_sha256: str | None = None,
) -> dict[str, Any]:
    """Evaluate every trait gate of ``pathway`` per language and the battery gate per (language, site_mode).

    Evaluate-only (the default) never promotes; the result is the would-be status with its reasons.
    """
    required = [str(g) for g in gates["trait_gate"]["invariance"]["required_groupings"]]
    decisions: list[TraitGateDecision] = []
    for language in languages:
        for trait, construct in sorted(constructs.items()):
            ev = trait_evidence_from_results(
                rows,
                trait=trait,
                language=language,
                pathway=pathway,
                hypotheses=hypotheses,
                required_groupings=required,
                norms=(norms or {}).get((trait, language)),
                signoffs=(signoffs or {}).get((trait, language), ()),
            )
            decisions.append(
                evaluate_trait_gate(ev, gates, construct, evaluate_only=evaluate_only, gates_sha256=gates_sha256)
            )
    tier1 = [
        c
        for c, spec in constructs.items()
        if int(spec.get("tier") or 0) == 1
        and (spec.get("pathways") or {}).get(pathway, {}).get("status") != "group_only"
    ]
    battery_ev = {
        (lang, pathway, sm): battery_evidence_from_results(
            rows,
            language=lang,
            pathway=pathway,
            site_mode=sm,
            signoff_roles=(battery_signoffs or {}).get((lang, sm), ()),
        )
        for lang in languages
        for sm in site_modes
    }
    battery = [
        evaluate_battery_gate(
            lang,
            pathway,
            sm,
            trait_decisions=decisions,
            battery_evidence=battery_ev,
            gates=gates,
            tier1_constructs=tier1,
        )
        for lang in languages
        for sm in site_modes
    ]
    return {
        "pathway": pathway,
        "evaluate_only": evaluate_only,
        "trait_gates": [
            {
                **{k: v for k, v in asdict(d).items() if k != "rules"},
                "rules": dict(d.rules),
                "meets_b1_b2": d.meets_b1_b2,
            }
            for d in decisions
        ],
        "battery_gates": [{**asdict(b), "rules": dict(b.rules)} for b in battery],
        "battery_evidence": {f"{k[0]}|{k[1]}|{k[2]}": asdict(v) for k, v in battery_ev.items()},
        "tier1_constructs": sorted(tier1),
    }
