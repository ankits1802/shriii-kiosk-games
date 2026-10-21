"""SHRIII stage reports and technical manual (VAL-15).

Report bundles (``ValidationResult`` entries wrapping ``shriii_validation`` ``EvidenceResult`` objects, plus
sample, exclusion, gate and provenance data) render through Jinja2 templates to Markdown, HTML and
Quarto ``.qmd``. Confirmatory and exploratory results are separated using the hypothesis registry.
"""

from __future__ import annotations

from shriii_reports.model import REPORT_KINDS, ReportBundle, ResultEntry
from shriii_reports.prepare import Registry, load_registry, prepare_context
from shriii_reports.render import FORMATS, REPORT_SPECS, load_bundle, render_report, write_report

__all__ = [
    "FORMATS",
    "REPORT_KINDS",
    "REPORT_SPECS",
    "Registry",
    "ReportBundle",
    "ResultEntry",
    "load_bundle",
    "load_registry",
    "prepare_context",
    "render_report",
    "write_report",
]
