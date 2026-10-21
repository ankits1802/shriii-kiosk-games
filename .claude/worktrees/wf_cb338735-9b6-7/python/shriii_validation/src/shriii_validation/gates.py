"""Gate evaluator (VAL-14; plan section 7.7) driven only by ``scoring/gates.yaml``.

* Trait gate per (trait, language, pathway): ``unvalidated | research_only | validated_broad_style |
  validated_banded | withheld``.
* Battery release gate per (language, pathway, site_mode): ``closed | open``.

Fail closed: any missing, non-observed or insufficient evidence keeps a trait ``unvalidated`` and a battery
``closed``. Evaluate-only mode computes the would-be status but can never promote. Caps (integrity, risk,
teamwork, style constructs) and permanent withholds come from ``gates.yaml``. Disattenuated statistics are
rejected as convergent evidence. History is append-only and regressions re-close automatically.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

__all__ = [
    "BatteryEvidence",
    "BatteryGateDecision",
    "GateHistory",
    "TraitEvidence",
    "TraitGateDecision",
    "evaluate_battery_gate",
    "evaluate_trait_gate",
]

TraitStatus = Literal["unvalidated", "research_only", "validated_broad_style", "validated_banded", "withheld"]
STATUS_ORDER: dict[str, int] = {
    "withheld": 0,
    "unvalidated": 1,
    "research_only": 2,
    "validated_broad_style": 3,
    "validated_banded": 4,
}
Rule = Literal["pass", "fail", "missing"]


@dataclass(frozen=True, slots=True)
class TraitEvidence:
    """Evidence for one (trait, language, pathway). ``None`` means the evidence does not exist yet."""

    trait: str
    language: str
    pathway: str
    retest_icc_a1: float | None = None
    retest_icc_a1_lower: float | None = None
    retest_pairs: int | None = None
    retest_pooled: bool = False
    reliability: float | None = None
    reliability_lower: float | None = None
    convergent_r: float | None = None
    convergent_lower: float | None = None
    convergent_sign_correct: bool | None = None
    convergent_holm_passed: bool | None = None
    convergent_observed: bool = True
    pattern_passed: bool | None = None
    nomological_passed: bool | None = None
    invariance: Mapping[str, bool] | None = None
    norms: Literal["provisional", "final"] | None = None
    signoffs: Sequence[str] = ()
    partner_rating_passed: bool = False


@dataclass(frozen=True, slots=True)
class TraitGateDecision:
    """Outcome of a trait gate evaluation."""

    trait: str
    language: str
    pathway: str
    status: TraitStatus
    evaluated_status: TraitStatus
    rules: Mapping[str, Rule]
    reasons: tuple[str, ...]
    capped: bool
    evaluate_only: bool
    gates_sha256: str | None = None

    @property
    def meets_b1_b2(self) -> bool:
        return self.rules.get("B1") == "pass" and self.rules.get("B2") == "pass"


def _rule(value: bool | None) -> Rule:
    return "missing" if value is None else ("pass" if value else "fail")


def evaluate_trait_gate(
    evidence: TraitEvidence,
    gates: Mapping[str, Any],
    construct: Mapping[str, Any],
    *,
    evaluate_only: bool = True,
    gates_sha256: str | None = None,
) -> TraitGateDecision:
    """Evaluate trait-gate rules B1-B6 for one (trait, language, pathway).

    ``construct`` is the construct entry of ``shared.yaml`` (kind, pathway status). Style constructs (kind S)
    use their nomological prediction in place of the convergent own > discriminant pattern.
    """
    tg = gates["trait_gate"]
    reasons: list[str] = []
    for w in gates.get("permanent_withhold", []):
        if w["construct"] == evidence.trait and w["pathway"] == evidence.pathway:
            return TraitGateDecision(
                evidence.trait,
                evidence.language,
                evidence.pathway,
                "withheld",
                "withheld",
                {},
                (f"permanently withheld: {w['reason']}",),
                False,
                evaluate_only,
                gates_sha256,
            )
    pw_status = construct.get("pathways", {}).get(evidence.pathway, {}).get("status")
    if pw_status in ("withheld", "group_only"):
        return TraitGateDecision(
            evidence.trait,
            evidence.language,
            evidence.pathway,
            "withheld",
            "withheld",
            {},
            (f"construct is {pw_status} for pathway {evidence.pathway}",),
            False,
            evaluate_only,
            gates_sha256,
        )
    rt = tg["retest"]
    b1: bool | None = None
    if (
        evidence.retest_icc_a1 is not None
        and evidence.retest_icc_a1_lower is not None
        and evidence.retest_pairs is not None
    ):
        if evidence.retest_pairs < int(rt["min_pairs_per_cell"]):
            reasons.append(f"B1: {evidence.retest_pairs} retest pairs < {rt['min_pairs_per_cell']}")
            b1 = None
        else:
            point_min = float(rt["pooled_language_point_min"] if evidence.retest_pooled else rt["point_min"])
            b1 = evidence.retest_icc_a1 >= point_min and evidence.retest_icc_a1_lower >= float(rt["lower_bound_min"])
    rl = tg["reliability"]
    b2 = (
        None
        if evidence.reliability is None or evidence.reliability_lower is None
        else evidence.reliability >= float(rl["point_min"])
        and evidence.reliability_lower >= float(rl["lower_bound_min"])
    )
    cv = tg["convergent"]
    b3: bool | None
    if not evidence.convergent_observed and cv.get("observed_only", True):
        b3 = False
        reasons.append("B3: only observed correlations may feed gates (disattenuated evidence rejected)")
    elif construct.get("kind") == "S":
        b3 = evidence.nomological_passed
    elif evidence.convergent_lower is None or evidence.convergent_sign_correct is None:
        b3 = None
    else:
        b3 = (
            evidence.convergent_lower > float(cv["lower_bound_gt"])
            and (evidence.convergent_sign_correct or not cv["require_correct_sign"])
            and bool(evidence.convergent_holm_passed if evidence.convergent_holm_passed is not None else False)
            and (bool(evidence.pattern_passed) if cv["require_pattern_own_gt_discriminant"] else True)
        )
        if cv["require_pattern_own_gt_discriminant"] and evidence.pattern_passed is None:
            b3 = None
    required = list(tg["invariance"]["required_groupings"])
    b4: bool | None
    if evidence.invariance is None or any(g not in evidence.invariance for g in required):
        b4 = None
        if evidence.invariance is not None:
            reasons.append(f"B4: missing invariance groupings {[g for g in required if g not in evidence.invariance]}")
    else:
        b4 = all(evidence.invariance[g] for g in required)
    b5 = None if evidence.norms is None else True
    b6 = len(set(evidence.signoffs)) >= int(tg["min_named_signers"])
    rules: dict[str, Rule] = {
        "B1": _rule(b1),
        "B2": _rule(b2),
        "B3": _rule(b3),
        "B4": _rule(b4),
        "B5": _rule(b5),
        "B6": "pass" if b6 else "missing",
    }
    for k, v in rules.items():
        if v != "pass":
            reasons.append(f"{k}: {v}")
    if any(rules[k] == "fail" for k in ("B1", "B2", "B3")):
        would: TraitStatus = "research_only"
    elif all(v == "pass" for v in rules.values()):
        would = "validated_banded"
    else:
        would = "unvalidated"
    capped = False
    if would == "validated_banded":
        cap = next((c for c in gates.get("caps", []) if c["construct"] == evidence.trait), None)
        if cap is not None and not (evidence.trait == "teamwork" and evidence.partner_rating_passed):
            would = cap["max_status"]
            capped = True
            reasons.append(f"capped at {cap['max_status']}: {cap['reason']}")
        report_cap = construct.get("report", {}).get("max_status")
        if report_cap and STATUS_ORDER[report_cap] < STATUS_ORDER[would]:
            would = report_cap
            capped = True
    promote = (not evaluate_only) or bool(gates.get("rules", {}).get("evaluate_only_can_promote", False))
    status: TraitStatus = would if promote else ("research_only" if would == "research_only" else "unvalidated")
    if evaluate_only and not promote:
        reasons.append("evaluate-only mode: status is never promoted")
    return TraitGateDecision(
        evidence.trait,
        evidence.language,
        evidence.pathway,
        status,
        would,
        rules,
        tuple(reasons),
        capped,
        evaluate_only,
        gates_sha256,
    )


@dataclass(frozen=True, slots=True)
class BatteryEvidence:
    """Battery-level fairness and governance evidence for one (language, pathway, site_mode)."""

    language: str
    pathway: str
    site_mode: str
    criterion_invariance_passed: bool | None = None
    unresolved_large_dif: bool | None = None
    differential_exclusion_pp: float | None = None
    mode_equivalence_passed: bool | None = None
    signoff_roles: Sequence[str] = ()


@dataclass(frozen=True, slots=True)
class BatteryGateDecision:
    """Outcome of a battery release gate evaluation."""

    language: str
    pathway: str
    site_mode: str
    status: Literal["closed", "open"]
    rules: Mapping[str, Rule]
    reasons: tuple[str, ...]
    qualifying_languages: tuple[str, ...]


def _a2(
    lang: str,
    pathway: str,
    decisions: Sequence[TraitGateDecision],
    tier1: Sequence[str],
    share_min: float,
    *,
    count_withheld_as_fail: bool = True,
) -> bool:
    """Share of Tier-1 constructs meeting B1 and B2. Withheld constructs stay in the denominator (as
    fails) unless ``count_withheld_as_fail`` is false; a construct with no decision always counts as a fail."""
    by_trait = {d.trait: d for d in decisions if d.language == lang and d.pathway == pathway}
    pool = [t for t in tier1 if count_withheld_as_fail or t not in by_trait or by_trait[t].status != "withheld"]
    if not pool:
        return False
    met = sum(1 for t in pool if t in by_trait and by_trait[t].status != "withheld" and by_trait[t].meets_b1_b2)
    return met / len(pool) >= share_min


def _a3(ev: BatteryEvidence | None, bg: Mapping[str, Any]) -> bool | None:
    if ev is None:
        return None
    parts: list[bool | None] = []
    if bg["require_criterion_invariance"]:
        parts.append(ev.criterion_invariance_passed)
    if bg["require_no_unresolved_large_dif"]:
        parts.append(None if ev.unresolved_large_dif is None else not ev.unresolved_large_dif)
    parts.append(
        None
        if ev.differential_exclusion_pp is None
        else ev.differential_exclusion_pp <= float(bg["differential_exclusion_max_pp"])
    )
    if any(p is None for p in parts):
        return None
    return all(bool(p) for p in parts)


def evaluate_battery_gate(
    language: str,
    pathway: str,
    site_mode: str,
    *,
    trait_decisions: Sequence[TraitGateDecision],
    battery_evidence: Mapping[tuple[str, str, str], BatteryEvidence],
    gates: Mapping[str, Any],
    tier1_constructs: Sequence[str],
) -> BatteryGateDecision:
    """Battery release gate rules A1-A5.

    ``tier1_constructs`` are the pathway's Tier-1 constructs (withheld ones count as fails when
    ``count_withheld_as_fail``). A1 needs at least ``min_language_groups`` languages (including this one)
    that each meet A2 and A3 for the pathway.
    """
    bg = gates["battery_gate"]
    share = float(bg["tier1_reliability_share_min"])
    withheld_fail = bool(bg.get("count_withheld_as_fail", True))
    tier1 = list(tier1_constructs)
    languages = sorted(
        {d.language for d in trait_decisions if d.pathway == pathway}
        | {k[0] for k in battery_evidence if k[1] == pathway}
    )
    qualifying = []
    for lang in languages:
        ev = battery_evidence.get((lang, pathway, site_mode)) or battery_evidence.get((lang, pathway, "supervised"))
        if (
            _a2(lang, pathway, trait_decisions, tier1, share, count_withheld_as_fail=withheld_fail)
            and _a3(ev, bg) is True
        ):
            qualifying.append(lang)
    own = battery_evidence.get((language, pathway, site_mode))
    a2 = _a2(language, pathway, trait_decisions, tier1, share, count_withheld_as_fail=withheld_fail)
    a3 = _a3(own, bg)
    a1 = language in qualifying and len(qualifying) >= int(bg["min_language_groups"])
    a4: bool | None = True
    if site_mode == "open_public" and bg["open_public_requires_mode_equivalence"]:
        a4 = None if own is None else own.mode_equivalence_passed
    a5 = own is not None and set(bg["signoff_roles"]) <= set(own.signoff_roles)
    rules: dict[str, Rule] = {
        "A1": _rule(a1),
        "A2": _rule(a2),
        "A3": _rule(a3),
        "A4": _rule(a4),
        "A5": "pass" if a5 else "missing",
    }
    reasons = [f"{k}: {v}" for k, v in rules.items() if v != "pass"]
    if not a1:
        reasons.append(f"qualifying languages {qualifying} (< {bg['min_language_groups']} or excludes {language})")
    status: Literal["closed", "open"] = "open" if all(v == "pass" for v in rules.values()) else "closed"
    return BatteryGateDecision(language, pathway, site_mode, status, rules, tuple(reasons), tuple(qualifying))


@dataclass(slots=True)
class GateHistory:
    """Append-only gate history; the current status is the latest entry (regressions re-close)."""

    entries: list[dict[str, Any]] = field(default_factory=list)

    def append(self, key: tuple[str, ...], status: str, reasons: Sequence[str], at: datetime | None = None) -> None:
        self.entries.append(
            {"key": key, "status": status, "reasons": list(reasons), "at": (at or datetime.now(UTC)).isoformat()}
        )

    def current(self, key: tuple[str, ...]) -> str | None:
        for e in reversed(self.entries):
            if e["key"] == key:
                return str(e["status"])
        return None

    def regressions(self) -> list[dict[str, Any]]:
        """Entries whose status is lower than the previous status for the same key."""
        last: dict[tuple[str, ...], str] = {}
        out = []
        for e in self.entries:
            prev = last.get(e["key"])
            if prev is not None and STATUS_ORDER.get(e["status"], 1) < STATUS_ORDER.get(prev, 1):
                out.append(e)
            last[e["key"]] = e["status"]
        return out
