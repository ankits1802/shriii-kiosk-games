"""Sample-size section (VAL-02 planning assumptions) computed with ``shriii_validation.power``.

Inputs: the planning block of the generator config (true r, power, planned n), the primary family's alpha
and size from ``hypotheses.yaml`` (Holm smallest per-test alpha = alpha / m) and the retest thresholds from
``gates.yaml`` (trait_gate.retest). Nothing here is a gate threshold; the section documents whether the
planned n supports the registered tests.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from shriii_validation.power import (
    icc_ci_halfwidth,
    n_for_correlation_lower_bound,
    n_for_icc_halfwidth,
    power_correlation_lower_bound,
)

from shriii_prereg.inputs import as_list, as_map

__all__ = ["compute_power"]


def _primary_family(hyp: Mapping[str, Any]) -> tuple[str | None, float | None, int]:
    for raw in as_list(hyp.get("families")):
        f = as_map(raw)
        if f.get("kind") == "confirmatory":
            fid = str(f.get("id"))
            m = sum(1 for h in as_list(hyp.get("hypotheses")) if as_map(h).get("family") == fid)
            alpha = f.get("alpha")
            return fid, (None if alpha is None else float(alpha)), m
    return None, None, 0


def compute_power(
    cfg: Mapping[str, Any], hyp: Mapping[str, Any], gates: Mapping[str, Any], *, n_languages: int
) -> dict[str, Any]:
    """Planning calculations. Rows carry ``required``, ``planned`` and ``adequate`` where both exist."""
    p = as_map(cfg.get("power"))
    planned = as_map(p.get("planned"))
    power_target = float(p.get("target_power", 0.80))
    r_true = float(p["r_true"]) if p.get("r_true") is not None else None
    defaults = as_map(hyp.get("defaults"))
    r0 = float(defaults.get("r0", 0.10))
    fam_id, fam_alpha, m = _primary_family(hyp)
    rows: list[dict[str, Any]] = []
    notes: list[str] = []

    if r_true is not None and fam_alpha is not None and m > 0:
        holm_alpha = fam_alpha / m
        req = n_for_correlation_lower_bound(r_true, r0, alpha=holm_alpha, power=power_target)
        per_arm_lang = planned.get("per_arm_per_language")
        per_lang = planned.get("per_language")
        if per_arm_lang is not None:
            n_pooled_arm = int(per_arm_lang) * n_languages
            rows.append(
                {
                    "id": "primary_pooled_per_arm",
                    "test": f"Primary lower-bound test (true r = {r_true:g} vs r0 = {r0:g}), Holm smallest "
                    f"per-test alpha = {fam_alpha:g}/{m} = {holm_alpha:.5f}, one-sided, pooled languages, per arm",
                    "required_n": req,
                    "planned_n": n_pooled_arm,
                    "achieved_power": power_correlation_lower_bound(n_pooled_arm, r_true, r0, alpha=holm_alpha),
                    "adequate": n_pooled_arm >= req,
                }
            )
        if per_lang is not None:
            n_pooled_all = int(per_lang) * n_languages
            rows.append(
                {
                    "id": "primary_pooled_all",
                    "test": f"Primary lower-bound test, pooled languages and arms (shared-paradigm indicators), "
                    f"alpha = {holm_alpha:.5f}",
                    "required_n": req,
                    "planned_n": n_pooled_all,
                    "achieved_power": power_correlation_lower_bound(n_pooled_all, r_true, r0, alpha=holm_alpha),
                    "adequate": n_pooled_all >= req,
                }
            )
        sign_r0 = float(p.get("per_language_sign_r0", 0.0))
        sign_alpha = float(p.get("per_language_alpha", 0.05))
        if per_arm_lang is not None:
            req_sign = n_for_correlation_lower_bound(r_true, sign_r0, alpha=sign_alpha, power=power_target)
            rows.append(
                {
                    "id": "per_language_arm_sign",
                    "test": f"Per-language consistency check (correct sign, lower bound > {sign_r0:g}), "
                    f"alpha = {sign_alpha:g} one-sided, per language and arm",
                    "required_n": req_sign,
                    "planned_n": int(per_arm_lang),
                    "achieved_power": power_correlation_lower_bound(
                        int(per_arm_lang), r_true, sign_r0, alpha=sign_alpha
                    ),
                    "adequate": int(per_arm_lang) >= req_sign,
                }
            )
    else:
        notes.append(
            "Primary-family power not computed: r_true, the confirmatory family alpha or its hypotheses are missing."
        )

    retest = as_map(as_map(gates.get("trait_gate")).get("retest"))
    icc_plan = p.get("retest_icc_planning_value")
    pairs = planned.get("retest_pairs_per_language")
    if icc_plan is not None and pairs is not None:
        ci_level = float(retest.get("ci_level", 0.95))
        hw_lang = icc_ci_halfwidth(int(pairs), float(icc_plan), ci_level=ci_level)
        hw_pooled = icc_ci_halfwidth(int(pairs) * n_languages, float(icc_plan), ci_level=ci_level)
        row: dict[str, Any] = {
            "id": "retest_icc",
            "test": f"Retest ICC(A,1) {ci_level:.0%} CI half-width at planning ICC = {float(icc_plan):g} "
            f"(Bonett, 2002)",
            "planned_n": int(pairs),
            "halfwidth_per_language": hw_lang,
            "halfwidth_pooled": hw_pooled,
            "pooled_n": int(pairs) * n_languages,
        }
        point_min = retest.get("point_min")
        lb_min = retest.get("lower_bound_min")
        if point_min is not None and lb_min is not None:
            target_hw = float(point_min) - float(lb_min)
            req_pairs = n_for_icc_halfwidth(float(point_min), target_hw, ci_level=ci_level)
            row.update(
                {
                    "required_n": req_pairs,
                    "required_basis": f"pairs so that ICC = {float(point_min):g} has a lower bound >= "
                    f"{float(lb_min):g} (half-width {target_hw:g}; gates.yaml trait_gate.retest)",
                    "adequate": int(pairs) >= req_pairs,
                }
            )
        if retest.get("min_pairs_per_cell") is not None:
            row["min_pairs_per_cell"] = int(retest["min_pairs_per_cell"])
        rows.append(row)

    for key, label, simulated in (
        ("live_dyads_pooled", "Live-dyad substudy (teamwork partner rating), dyads pooled across languages", True),
        ("unattended_sessions_per_language", "Unattended-mode substudy (S4u), open-public sessions per language", True),
        (
            "retest_invitations_per_language",
            "Retest invitations per language (to reach the planned completed pairs)",
            False,
        ),
    ):
        if planned.get(key) is not None:
            rows.append({"id": key, "test": label, "planned_n": int(planned[key]), "simulation_pending": simulated})

    notes.append(
        "Simulation power for the r_contrast-CV pattern statistic and for trial-level invariance and DIF models "
        "is produced by the VAL-02 report and cited by the protocol; it is not reproduced here."
    )
    return {
        "status": p.get("status", "pending_val02"),
        "review": p.get("review"),
        "target_power": power_target,
        "r_true": r_true,
        "r0": r0,
        "sides": p.get("sides", "one_sided"),
        "n_languages": n_languages,
        "primary_family": fam_id,
        "primary_family_size": m,
        "planned": dict(planned),
        "rows": rows,
        "fallback_options": list(as_list(p.get("fallback_options"))),
        "notes": notes,
    }
