"""Render a report bundle to Markdown, HTML or Quarto (.qmd) with Jinja2.

One body template per report kind; three macro sets (``_md.j2``, ``_html.j2``, ``_qmd.j2``) supply the
format. All integrity logic lives in :mod:`shriii_reports.prepare`.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any

from jinja2 import Environment, PackageLoader, StrictUndefined

from shriii_reports.model import ReportBundle
from shriii_reports.prepare import SECTION_TITLES, Registry, prepare_context, section_title

__all__ = ["FORMATS", "REPORT_SPECS", "load_bundle", "render_report", "write_report"]

FORMATS: dict[str, tuple[str, str]] = {
    "md": ("_md.j2", ".md"),
    "html": ("_html.j2", ".html"),
    "qmd": ("_qmd.j2", ".qmd"),
}

REPORT_SPECS: dict[str, dict[str, Any]] = {
    "stage2_pilot": {
        "template": "stage2_pilot.j2",
        "sections": [
            "descriptives",
            "reliability",
            "criterion_invariance",
            "convergent",
            "discriminant_pattern",
            "nomological",
            "pathway_comparison",
        ],
    },
    "stage3_retest": {
        "template": "stage3_retest.j2",
        "sections": ["attrition", "retest", "practice_effects", "reliability", "nomological"],
    },
    "stage4_fairness": {
        "template": "stage4_fairness.j2",
        "sections": ["criterion_invariance", "invariance", "dif", "differential_exclusion", "mode_equivalence", "asr"],
    },
    "stage5_norming": {
        "template": "stage5_norming.j2",
        "sections": ["criterion_validity", "incremental_validity", "norming"],
    },
    "technical_manual": {"template": "technical_manual.j2", "sections": list(SECTION_TITLES)},
}


def _text(v: Any) -> str:
    if v is None or v in ("", []):
        return "-"
    if isinstance(v, bool):
        return "yes" if v else "no"
    if isinstance(v, float):
        return f"{v:.4g}"
    if isinstance(v, list | tuple):
        return ", ".join(_text(x) for x in v)
    return str(v)


_TAG_START = re.compile(r"<(?=[A-Za-z/!?])")


def _md_prose(v: Any) -> str:
    """Free text for Markdown / Quarto: one line, and no raw HTML (a tag start ``<x`` becomes ``&lt;x``).

    Pandoc and most Markdown renderers pass raw HTML through, so bundle text such as notes or rationale
    could otherwise inject markup or script into the rendered page.
    """
    text = "" if v is None else str(v)
    return _TAG_START.sub("&lt;", text.replace("\r\n", " ").replace("\r", " ").replace("\n", " "))


def _md_cell(v: Any) -> str:
    return _md_prose(_text(v).replace("\\", "\\\\").replace("|", "\\|"))


def _yaml_str(v: Any) -> str:
    """A double-quoted YAML scalar (JSON strings are valid YAML), safe for front matter."""
    return json.dumps("" if v is None else str(v), ensure_ascii=False)


def _num(v: Any) -> str:
    if v is None:
        return "-"
    if isinstance(v, bool):
        return "yes" if v else "no"
    if isinstance(v, int):
        return str(v)
    return f"{float(v):.4g}"


def _pct(v: Any) -> str:
    return "-" if v is None else f"{float(v) * 100:g}%"


def _rows(items: Iterable[Mapping[str, Any]], keys: Sequence[str]) -> list[list[Any]]:
    return [[it.get(k) for k in keys] for it in items]


def _flagged_rows(items: Iterable[Mapping[str, Any]]) -> list[list[Any]]:
    return [
        [
            r["subject"],
            r["metric"],
            r["group"],
            "; ".join(r["failed_assumptions"]) or "-",
            "; ".join(r["warnings"]) or "-",
        ]
        for r in items
    ]


def _norm_rows(cells: Iterable[Mapping[str, Any]]) -> list[list[Any]]:
    return [[c["label"], c["n"], c["effective_n"], c["provisional"], *c["values"]] for c in cells]


def _provenance_rows(items: Iterable[Mapping[str, Any]]) -> list[list[Any]]:
    return [
        [
            r["id"] or "-",
            r["section"],
            r["subject"],
            r["metric"],
            r["run_id"],
            r["algorithm_version"] or "-",
            r["provenance_sha"] or "-",
        ]
        for r in items
    ]


def _signoff_row(role: str) -> list[str]:
    return [role, "", "", "", ""]


def _environment(fmt: str) -> Environment:
    env = Environment(
        loader=PackageLoader("shriii_reports", "templates"),
        autoescape=fmt == "html",
        trim_blocks=True,
        lstrip_blocks=True,
        keep_trailing_newline=True,
        undefined=StrictUndefined,
    )
    env.filters.update(
        {
            "cell": _text if fmt == "html" else _md_cell,
            "prose": str if fmt == "html" else _md_prose,
            "yaml_str": _yaml_str,
            "num": _num,
            "pct": _pct,
            "rows": _rows,
            "flagged_rows": _flagged_rows,
            "norm_rows": _norm_rows,
            "provenance_rows": _provenance_rows,
            "section_title": section_title,
            "signoff_row": _signoff_row,
        }
    )
    return env


def load_bundle(path: Path) -> ReportBundle:
    """Parse and validate a report bundle JSON file."""
    return ReportBundle.model_validate(json.loads(path.read_text(encoding="utf-8")))


def render_report(bundle: ReportBundle, fmt: str, registry: Registry | None = None) -> str:
    """Render ``bundle`` (its ``report.kind`` picks the template) in ``md``, ``html`` or ``qmd``."""
    if fmt not in FORMATS:
        raise ValueError(f"unknown format {fmt!r}; expected one of {list(FORMATS)}")
    spec = REPORT_SPECS[bundle.report.kind]
    ctx = prepare_context(bundle, registry or Registry(), section_order=spec["sections"])
    env = _environment(fmt)
    out = env.get_template(spec["template"]).render(macros=FORMATS[fmt][0], **ctx)
    out = re.sub(r"\n{3,}", "\n\n", out)
    return out.strip() + "\n"


def write_report(
    bundle: ReportBundle,
    out_dir: Path,
    *,
    formats: Sequence[str] = ("md", "html", "qmd"),
    basename: str | None = None,
    registry: Registry | None = None,
) -> dict[str, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = basename or f"{bundle.report.study_id}_{bundle.report.kind}"
    stem = re.sub(r"[^A-Za-z0-9._-]+", "_", stem)
    written: dict[str, Path] = {}
    for fmt in formats:
        if fmt not in FORMATS:
            raise ValueError(f"unknown format {fmt!r}")
        path = out_dir / f"{stem}{FORMATS[fmt][1]}"
        path.write_text(render_report(bundle, fmt, registry), encoding="utf-8", newline="\n")
        written[fmt] = path
    return written
