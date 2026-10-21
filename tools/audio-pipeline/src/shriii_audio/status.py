"""Recording-status update file (``out/recording-status.yaml``).

``content/i18n/lines.yaml`` is never edited by the pipeline. Instead this file proposes, per line and
language, the ``recording`` block (``status`` + ``itc_state``, the ``LineRecordingStatus`` shape of the
catalogue schema) together with the evidence (clip sha256, take, QC result and issues). The localisation
workflow (``tools/translation``, VOX-07) reviews and merges it.
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml

from shriii_audio.catalogue import itc_rank
from shriii_audio.process import BatchResult, ClipResult


def _proposal(c: ClipResult, current_itc: str) -> dict[str, Any]:
    if c.deliverable:
        status, itc = "audio_qc", "audio_qc"
        # never propose moving a line backwards when its catalogue state is already past audio_qc
        if itc_rank(current_itc) > itc_rank("audio_qc"):
            itc = current_itc
    else:
        status, itc = "recorded", "flagged_for_revision"
    return {
        "status": status,
        "itc_state": itc,
        "qc": c.status,
        "take": c.take,
        "source_file": c.source_file,
        "source_sha256": c.source_sha256,
        "clip_file": c.output_file,
        "clip_sha256": c.output_sha256 if c.deliverable else None,
        "duration_ms": c.duration_ms,
        "issues": [f"{i.severity}:{i.code}: {i.message}" for i in c.issues if i.severity != "info"],
    }


def build_status(batch: BatchResult, now: datetime | None = None) -> dict[str, Any]:
    cat = batch.catalogue
    languages: dict[str, Any] = {}
    for lang in batch.languages:
        updates: dict[str, Any] = {}
        for c in batch.selected(lang):
            line = cat.get(c.line_id)
            assert line is not None
            current = line.recording.get(lang)
            updates[c.line_id] = {
                "current": {"status": current.status, "itc_state": current.itc_state} if current else None,
                "proposed": _proposal(c, current.itc_state if current else "draft"),
            }
        languages[lang] = {
            "summary": {
                "catalogue_lines": len(cat.lines),
                "processed": len(updates),
                "passed": sum(1 for u in updates.values() if u["proposed"]["qc"] == "pass"),
                "warnings": sum(1 for u in updates.values() if u["proposed"]["qc"] == "warn"),
                "failed": sum(1 for u in updates.values() if u["proposed"]["qc"] == "fail"),
                "missing": len(batch.missing(lang)),
            },
            "updates": dict(sorted(updates.items())),
            "missing_lines": batch.missing(lang),
        }
    return {
        "schema_version": "1.0",
        "kind": "recording_status_update",
        "generated_at": (now or datetime.now(UTC)).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "catalogue": {"path": "content/i18n/lines.yaml", "catalogue_version": cat.catalogue_version},
        "note": "Proposed recording/ITC updates. lines.yaml is NOT modified; merge through the VOX-07 workflow.",
        "rejected_files": [{"file": f, "reason": r} for f, r in batch.rejected_files],
        "languages": languages,
    }


def write_status(batch: BatchResult, out_dir: Path, now: datetime | None = None) -> Path:
    path = out_dir / "recording-status.yaml"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        yaml.safe_dump(build_status(batch, now), sort_keys=False, allow_unicode=True, width=120),
        encoding="utf-8",
    )
    return path
