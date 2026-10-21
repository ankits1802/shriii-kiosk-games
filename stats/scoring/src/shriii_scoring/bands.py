"""Layer 5 reference: composites, strengths-framed bands and the "not enough to say" SEM rule (REP-01).

This is the single Python reference that produces bands from a release pack; the kiosk TypeScript
evaluator must match it exactly (REP-01 parity). No numbers ever leave this module towards a player:
outputs are band codes and allowlisted phrase keys only. Every rule threshold comes from ``gates.yaml``
(``trait_gate.norms.sem_rule``, ``display_rule``, ``report``) and the release pack (cut points, SEM).
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

from scipy import stats

from shriii_scoring._version import BAND_ALGORITHM_VERSION

__all__ = [
    "BandResult",
    "ReportDecision",
    "band_for",
    "composite_score",
    "display_allowed",
    "release_pack_valid",
    "report_bands",
]

Band = Literal["pole_a", "centre", "pole_b"]


@dataclass(frozen=True, slots=True)
class BandResult:
    """Band for one trait (``band is None`` when not enough to say)."""

    trait: str
    band: Band | None
    not_enough_to_say: bool
    reason: str | None
    ci_low: float | None
    ci_high: float | None
    phrase_key: str | None
    algorithm_version: str = BAND_ALGORITHM_VERSION


def composite_score(values: Mapping[str, float | None], composite: Mapping[str, Any]) -> float | None:
    """Unit-weighted z (or factor-score) composite from release-pack parameters; fails closed (None) when any
    retained indicator is missing or has a non-positive SD."""
    total = 0.0
    weight = 0.0
    for ind in composite["indicators"]:
        v = values.get(ind["indicator_id"])
        sd = float(ind["sd"])
        if v is None or not math.isfinite(float(v)) or sd <= 0:
            return None
        sign = 1.0 if ind["direction"] == "positive" else -1.0
        total += float(ind["weight"]) * sign * (float(v) - float(ind["mean"])) / sd
        weight += abs(float(ind["weight"]))
    return total / weight if weight > 0 else None


def band_for(
    trait: str,
    score: float | None,
    cut_points: Sequence[float],
    sem: float,
    sem_rule: Mapping[str, Any],
    *,
    phrase_allowlist: Sequence[Mapping[str, str]] = (),
) -> BandResult:
    """Three-band lookup with the SEM rule from ``gates.yaml``.

    Not enough to say when: the score is missing; the ``ci_level`` CI (score +- z * SEM) overlaps more than
    ``max_band_boundaries_overlapped`` boundaries; or the score lies in the centre band and that band is
    narrower than ``min_band_width_sem`` SEMs.
    """
    if score is None or not math.isfinite(score):
        return BandResult(trait, None, True, "no_score", None, None, None)
    lo_cut, hi_cut = sorted(float(c) for c in cut_points)
    z = float(stats.norm.ppf(0.5 + float(sem_rule["ci_level"]) / 2.0))
    lo, hi = score - z * sem, score + z * sem
    overlapped = sum(1 for c in (lo_cut, hi_cut) if lo < c < hi)
    band: Band = "pole_a" if score < lo_cut else "centre" if score < hi_cut else "pole_b"
    if overlapped > int(sem_rule["max_band_boundaries_overlapped"]):
        return BandResult(trait, None, True, "ci_overlaps_band_boundaries", lo, hi, None)
    if band == "centre" and (hi_cut - lo_cut) < float(sem_rule["min_band_width_sem"]) * sem:
        return BandResult(trait, None, True, "band_narrower_than_sem_rule", lo, hi, None)
    phrase = next((p["phrase_key"] for p in phrase_allowlist if p["trait"] == trait and p["band"] == band), None)
    if phrase_allowlist and phrase is None:
        return BandResult(trait, None, True, "no_allowlisted_phrase", lo, hi, None)
    return BandResult(trait, band, False, None, lo, hi, phrase)


def release_pack_valid(
    pack: Mapping[str, Any], now: datetime, dictionary_sha256: Mapping[str, str] | None = None
) -> bool:
    """Fail closed on an expired pack or a dictionary SHA mismatch (signature checking is the kiosk's job)."""
    expires = datetime.fromisoformat(str(pack["expires_at"]).replace("Z", "+00:00"))
    issued = datetime.fromisoformat(str(pack["issued_at"]).replace("Z", "+00:00"))
    if not issued <= now < expires:
        return False
    if dictionary_sha256 is not None:
        for pw, sha in dictionary_sha256.items():
            if pack["dictionary_sha256"].get(pw) != sha:
                return False
    return True


def display_allowed(
    *,
    display_rule: Mapping[str, Any],
    battery_gate: str,
    trait_status: str,
    session_valid_for_report: bool,
    not_enough_to_say: bool,
    release_pack_ok: bool,
    report_mode: str,
) -> bool:
    """The ``gates.yaml`` display rule: show a trait iff every condition holds (fail closed otherwise)."""
    return (
        battery_gate == display_rule["battery_gate"]
        and trait_status in set(display_rule["trait_status_in"])
        and (session_valid_for_report or not display_rule["session_valid_for_report"])
        and (not not_enough_to_say or not display_rule["exclude_not_enough_to_say"])
        and (release_pack_ok or not display_rule["release_pack_valid_and_unexpired"])
        and report_mode == display_rule["report_mode"]
    )


@dataclass(frozen=True, slots=True)
class ReportDecision:
    """What a session's report may contain: band codes and phrase keys only, plus the disclaimer key."""

    mode: str
    traits: tuple[BandResult, ...]
    disclaimer_key: str | None
    withheld_reason: str | None


def report_bands(
    *,
    indicator_values: Mapping[str, float | None],
    release_pack: Mapping[str, Any],
    gates: Mapping[str, Any],
    language: str,
    pathway: str,
    site_mode: str,
    session_valid_for_report: bool,
    report_mode: str,
    now: datetime,
    dictionary_sha256: Mapping[str, str] | None = None,
) -> ReportDecision:
    """Assemble a player report from a release pack (thank-you only whenever anything fails)."""
    pack_ok = release_pack_valid(release_pack, now, dictionary_sha256)
    rule = gates["display_rule"]
    battery = next(
        (
            b["status"]
            for b in release_pack["battery_gates"]
            if b["language"] == language and b["pathway"] == pathway and b["site_mode"] == site_mode
        ),
        "closed",
    )
    if report_mode != rule["report_mode"]:
        return ReportDecision(report_mode, (), None, "not_player_report_mode")
    if not pack_ok:
        return ReportDecision(report_mode, (), None, "release_pack_invalid")
    if battery != "open":
        return ReportDecision(report_mode, (), None, "battery_gate_closed")
    if not session_valid_for_report:
        return ReportDecision(report_mode, (), None, "session_not_valid_for_report")
    sem_rule = gates["trait_gate"]["norms"]["sem_rule"]
    shown: list[tuple[float, BandResult]] = []
    for comp in release_pack["composites"]:
        if comp["language"] != language or comp["pathway"] != pathway:
            continue
        trait = comp["trait"]
        status = next(
            (
                t["status"]
                for t in release_pack["trait_gates"]
                if t["trait"] == trait and t["language"] == language and t["pathway"] == pathway
            ),
            "unvalidated",
        )
        norm = next(
            (
                n
                for n in release_pack["norm_tables"]
                if n["trait"] == trait and n["language"] == language and n["pathway"] == pathway
            ),
            None,
        )
        if norm is None:
            continue
        res = band_for(
            trait,
            composite_score(indicator_values, comp),
            norm["cut_points"],
            float(norm["sem"]),
            sem_rule,
            phrase_allowlist=release_pack.get("phrase_allowlist", ()),
        )
        if display_allowed(
            display_rule=rule,
            battery_gate=battery,
            trait_status=status,
            session_valid_for_report=session_valid_for_report,
            not_enough_to_say=res.not_enough_to_say,
            release_pack_ok=pack_ok,
            report_mode=report_mode,
        ):
            shown.append((float(norm["sem"]), res))
    shown.sort(key=lambda x: (x[0], x[1].trait))
    limit = int(gates["report"]["max_traits_shown"])
    traits = tuple(r for _, r in shown[:limit])
    if not traits:
        return ReportDecision(report_mode, (), None, "no_trait_released")
    return ReportDecision(report_mode, traits, release_pack.get("disclaimer_key"), None)
