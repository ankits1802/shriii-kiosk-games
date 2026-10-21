"""Render the document model to Markdown and HTML (one Jinja2 body template, two macro sets) and JSON."""

from __future__ import annotations

import json
import re
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any

from jinja2 import Environment, PackageLoader, StrictUndefined
from markupsafe import Markup

__all__ = ["FORMATS", "inputs_json", "render_document", "write_outputs"]

FORMATS: dict[str, str] = {"md": "_md.j2", "html": "_html.j2"}
EXTENSIONS: dict[str, str] = {"md": ".md", "html": ".html", "json": ".json"}


# ----------------------------------------------------------------------------- value formatting


def num(v: Any, digits: int = 4) -> str:
    """Compact number: integers as-is, floats with ``digits`` significant digits (0.1, 0.00625, 0.6)."""
    if v is None:
        return "-"
    if isinstance(v, bool):
        return "yes" if v else "no"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        return f"{v:.{digits}g}"
    return str(v)


def pct(v: Any) -> str:
    if v is None:
        return "-"
    return f"{float(v) * 100:g}%"


def yn(v: Any) -> str:
    if v is None:
        return "-"
    return "yes" if v else "no"


def text(v: Any) -> str:
    """Plain-text rendering of any value for a table cell."""
    if v is None or v in ("", []):
        return "-"
    if isinstance(v, bool):
        return yn(v)
    if isinstance(v, float):
        return num(v)
    if isinstance(v, Mapping):
        return "; ".join(f"{k}: {text(x)}" for k, x in v.items())
    if isinstance(v, list | tuple):
        return ", ".join(text(x) for x in v)
    return str(v)


def md_cell(v: Any) -> str:
    return text(v).replace("\\", "\\\\").replace("|", "\\|").replace("\r", " ").replace("\n", " ")


def rows(items: Iterable[Mapping[str, Any]], keys: Sequence[str]) -> list[list[Any]]:
    return [[it.get(k) for k in keys] for it in items]


def hypothesis_rows(hyps: Iterable[Mapping[str, Any]]) -> list[list[Any]]:
    out = []
    for h in hyps:
        if h.get("criterion"):
            crit: Any = h["criterion"]
        elif h.get("convergent_criteria") or h.get("discriminant_criteria"):
            crit = f"own: {text(h.get('convergent_criteria'))}; discriminant: {text(h.get('discriminant_criteria'))}"
        else:
            crit = None
        out.append(
            [
                h.get("id"),
                h.get("construct"),
                h.get("pathways"),
                h.get("type"),
                h.get("indicators"),
                crit,
                h.get("expected_sign") or "not specified",
                h.get("r0"),
                h.get("statistic"),
                h.get("pooling"),
                h.get("notes"),
            ]
        )
    return out


def module_rows(modules: Iterable[Mapping[str, Any]], pathway: str) -> list[list[Any]]:
    return [[pathway, m.get("id"), m.get("kind"), m.get("order"), m.get("slot")] for m in modules]


def construct_rows(
    constructs: Iterable[Mapping[str, Any]], pathways: Sequence[str], coverage: Iterable[Mapping[str, Any]]
) -> list[list[Any]]:
    cov = {c.get("construct"): c for c in coverage}
    out = []
    for c in constructs:
        cv = cov.get(c.get("id"), {})
        reg = " / ".join(text(cv.get(p)) for p in pathways)
        row: list[Any] = [
            c.get("number"),
            f"{c.get('name')} ({c.get('id')})",
            c.get("kind"),
            c.get("tier"),
            c.get("restricted"),
        ]
        row.extend(c.get("pathways", {}).get(p) for p in pathways)
        row.extend([reg, c.get("max_status")])
        out.append(row)
    return out


def basis_summary(counts: Mapping[str, int]) -> str:
    return ", ".join(f"{k} {v}" for k, v in sorted(counts.items()))


def indicator_rows(inds: Iterable[Mapping[str, Any]]) -> list[list[Any]]:
    return [
        [
            i.get("id"),
            i.get("construct"),
            i.get("role"),
            i.get("tier"),
            i.get("kind"),
            i.get("module"),
            i.get("direction"),
            i.get("transformation"),
            i.get("reliability_method"),
            i.get("level_rule"),
            i.get("min_valid_trials"),
            i.get("exclusions"),
            i.get("gate_eligible"),
            i.get("group_only"),
        ]
        for i in inds
    ]


def criterion_ids(hyps: Iterable[Mapping[str, Any]]) -> list[str]:
    ids: set[str] = set()
    for h in hyps:
        if h.get("criterion"):
            ids.add(str(h["criterion"]))
        ids.update(str(x) for x in h.get("convergent_criteria") or [])
        ids.update(str(x) for x in h.get("discriminant_criteria") or [])
    return sorted(ids)


def multiplicity_rows(families: Iterable[Mapping[str, Any]]) -> list[list[Any]]:
    out = []
    for f in families:
        smallest = f.get("smallest_per_test_alpha")
        out.append(
            [
                f.get("id"),
                f.get("correction_label"),
                f.get("n_hypotheses"),
                f.get("alpha"),
                "-" if smallest is None or f.get("correction") == "none" else f"{smallest:.5f}",
            ]
        )
    return out


def trait_gate_rows(tg: Mapping[str, Any]) -> list[list[str]]:
    r = tg.get("retest", {})
    rel = tg.get("reliability", {})
    cv = tg.get("convergent", {})
    inv = tg.get("invariance", {})
    norms = tg.get("norms", {})
    sem = norms.get("sem_rule", {})
    return [
        [
            "B1 Retest",
            f"{r.get('statistic')} point >= {num(r.get('point_min'))} and {pct(r.get('ci_level'))} lower bound >= "
            f"{num(r.get('lower_bound_min'))}; pooled across languages only where invariance holds, with "
            f"language-specific point >= {num(r.get('pooled_language_point_min'))}; at least "
            f"{text(r.get('min_pairs_per_cell'))} pairs per cell; Pearson allowed: {yn(r.get('pearson_allowed'))}",
        ],
        [
            "B2 Reliability",
            f"composite reliability by method: point >= {num(rel.get('point_min'))}, {pct(rel.get('ci_level'))} lower "
            f"bound >= {num(rel.get('lower_bound_min'))}",
        ],
        [
            "B3 Convergent validity",
            f"observed r only: {yn(cv.get('observed_only'))}; lower bound > {num(cv.get('lower_bound_gt'))} "
            f"({text(cv.get('correction'))}-corrected for the primary family); correct sign required: "
            f"{yn(cv.get('require_correct_sign'))}; own > discriminant pattern required: "
            f"{yn(cv.get('require_pattern_own_gt_discriminant'))}; "
            f"upper bound: {text(cv.get('upper_bound') or 'none')}",
        ],
        [
            "B4 Invariance and DIF",
            f"passes for groupings: {text(inv.get('required_groupings'))}; at most "
            f"{pct(inv.get('max_freed_parameter_share'))} freed parameters; groups below n = "
            f"{text(inv.get('small_group_n'))} use Bayesian approximate invariance / moderated MIMIC",
        ],
        [
            "B5 Norms and SEM rule",
            f"norm table required: {text(norms.get('required'))}; 'not enough to say' when the "
            f"{pct(sem.get('ci_level'))} SEM-based CI overlaps more than "
            f"{text(sem.get('max_band_boundaries_overlapped'))} "
            f"band boundary or bands are narrower than {num(sem.get('min_band_width_sem'))} SEM",
        ],
        ["B6 Sign-off", f"PLT-09 sign-off by at least {text(tg.get('min_named_signers'))} named people"],
    ]


def battery_gate_rows(bg: Mapping[str, Any]) -> list[list[str]]:
    return [
        ["Scope", text(bg.get("scope"))],
        [
            "A1 Language groups",
            f"at least {text(bg.get('min_language_groups'))} language groups "
            "(this one plus others) each meet A2 and A3",
        ],
        [
            "A2 Reliability across the battery",
            f">= {pct(bg.get('tier1_reliability_share_min'))} of the pathway's Tier-1 constructs meet B1 and B2 "
            f"(withheld counted as fail: {yn(bg.get('count_withheld_as_fail'))})",
        ],
        [
            "A3 Fairness across the battery",
            f"criterion invariance required: {yn(bg.get('require_criterion_invariance'))}; no unresolved large DIF: "
            f"{yn(bg.get('require_no_unresolved_large_dif'))}; differential exclusion <= "
            f"{num(bg.get('differential_exclusion_max_pp'))} pp",
        ],
        [
            "A4 Open public",
            f"mode equivalence (VAL-18) required: {yn(bg.get('open_public_requires_mode_equivalence'))}",
        ],
        ["A5 Sign-off", text(bg.get("signoff_roles"))],
        ["When closed", text(bg.get("closed_behaviour"))],
    ]


def power_rows(prow: Iterable[Mapping[str, Any]]) -> list[list[Any]]:
    out = []
    for r in prow:
        hw = None
        if r.get("halfwidth_per_language") is not None:
            hw = f"{r['halfwidth_per_language']:.3f} / {r['halfwidth_pooled']:.3f} (pooled n = {r['pooled_n']})"
        req = r.get("required_n")
        if req is not None and r.get("required_basis"):
            req = f"{req} ({r['required_basis']})"
        out.append(
            [
                r.get("test"),
                req if req is not None else ("simulation (VAL-02)" if r.get("simulation_pending") else None),
                r.get("planned_n"),
                None if r.get("achieved_power") is None else f"{r['achieved_power']:.3f}",
                hw,
                r.get("adequate"),
            ]
        )
    return out


def prefix(v: Any, p: str) -> str:
    return f"{p}{v}"


# ----------------------------------------------------------------------------- environment


def inputs_json(doc: Mapping[str, Any]) -> str:
    """Machine-readable input manifest embedded in an HTML comment (``--`` escaped)."""
    payload = {
        "generator": doc["meta"]["generator"],
        "generator_version": doc["meta"]["generator_version"],
        "generated_at": doc["meta"]["generated_at"],
        "inputs": [{"role": f["role"], "path": f["path"], "sha256": f["sha256"]} for f in doc["inputs"]],
    }
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).replace("--", "-\\u002d")


def _environment(fmt: str) -> Environment:
    env = Environment(
        loader=PackageLoader("shriii_prereg", "templates"),
        autoescape=fmt == "html",
        trim_blocks=True,
        lstrip_blocks=True,
        keep_trailing_newline=True,
        undefined=StrictUndefined,
    )
    env.filters.update(
        {
            "cell": text if fmt == "html" else md_cell,
            "num": num,
            "pct": pct,
            "yn": yn,
            "rows": rows,
            "hypothesis_rows": hypothesis_rows,
            "module_rows": module_rows,
            "construct_rows": construct_rows,
            "basis_summary": basis_summary,
            "indicator_rows": indicator_rows,
            "criterion_ids": criterion_ids,
            "multiplicity_rows": multiplicity_rows,
            "trait_gate_rows": trait_gate_rows,
            "battery_gate_rows": battery_gate_rows,
            "power_rows": power_rows,
            "prefix": prefix,
        }
    )
    return env


def render_document(doc: Mapping[str, Any], fmt: str) -> str:
    """Render the document model in ``md``, ``html`` or ``json``."""
    if fmt == "json":
        return json.dumps(doc, indent=2, sort_keys=False, ensure_ascii=False) + "\n"
    if fmt not in FORMATS:
        raise ValueError(f"unknown format {fmt!r}; expected one of {[*FORMATS, 'json']}")
    env = _environment(fmt)
    out = env.get_template("prereg.j2").render(doc=doc, macros=FORMATS[fmt], inputs_json=Markup(inputs_json(doc)))
    out = re.sub(r"\n{3,}", "\n\n", out)
    return out.strip() + "\n"


def _refuse_scoring_dir(out_dir: Path, repo_root: Path | None) -> None:
    if repo_root is None:
        return
    scoring = (repo_root / "scoring").resolve()
    target = out_dir.resolve()
    if target == scoring or scoring in target.parents:
        raise ValueError(f"refusing to write into the read-only scoring directory: {target}")


def write_outputs(
    doc: Mapping[str, Any],
    out_dir: Path,
    *,
    formats: Sequence[str] = ("md", "html", "json"),
    basename: str = "preregistration",
    repo_root: Path | None = None,
) -> dict[str, Path]:
    """Write each requested format to ``out_dir`` and return the paths."""
    _refuse_scoring_dir(out_dir, repo_root)
    out_dir.mkdir(parents=True, exist_ok=True)
    written: dict[str, Path] = {}
    for fmt in formats:
        if fmt not in EXTENSIONS:
            raise ValueError(f"unknown format {fmt!r}")
        path = out_dir / f"{basename}{EXTENSIONS[fmt]}"
        path.write_text(render_document(doc, fmt), encoding="utf-8", newline="\n")
        written[fmt] = path
    return written
