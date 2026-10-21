"""Self-contained QC HTML report (no external assets; works offline and prints cleanly)."""

from __future__ import annotations

from datetime import UTC, datetime
from html import escape
from pathlib import Path

from shriii_audio.config import QcConfig
from shriii_audio.process import BatchResult, ClipResult

CSS = """
:root{--bg:#fbfaf7;--fg:#1f1d1a;--muted:#6b665e;--line:#e4e0d8;--pass:#1d7a46;--warn:#a86400;--fail:#b3261e;
--chip:#f1eee8;--wave:#3d5a80}
@media (prefers-color-scheme: dark){:root{--bg:#171614;--fg:#ece8e1;--muted:#a39d93;--line:#34312c;
--pass:#5cc58a;--warn:#f0a43a;--fail:#ff8a80;--chip:#24221f;--wave:#8fb3e0}}
*{box-sizing:border-box}body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);
font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1280px;margin:0 auto}h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}
.muted{color:var(--muted)}.tiles{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}
.tile{background:var(--chip);border-radius:8px;padding:8px 12px;min-width:110px}
.tile b{display:block;font-size:20px;font-variant-numeric:tabular-nums}
.scroll{overflow-x:auto;border:1px solid var(--line);border-radius:8px}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top;white-space:nowrap}
th{font-weight:600;font-size:12px;color:var(--muted);position:sticky;top:0;background:var(--bg)}
td.num{text-align:right}td.issues{white-space:normal;min-width:260px}
.st{font-weight:700;text-transform:uppercase;font-size:11px;letter-spacing:.04em}
.pass{color:var(--pass)}.warn{color:var(--warn)}.fail{color:var(--fail)}
.issue{display:block}.issue.error{color:var(--fail)}.issue.warning{color:var(--warn)}.issue.info{color:var(--muted)}
svg.wave{display:block}svg.wave path{fill:var(--wave)}
@media print{body{padding:0}.scroll{overflow:visible;border:0}th{position:static}}
"""


def _fmt(v: float | int | None, digits: int = 1) -> str:
    if v is None:
        return "&ndash;"
    if isinstance(v, int):
        return str(v)
    return f"{v:.{digits}f}"


def _wave(c: ClipResult, width: int = 120, height: int = 26) -> str:
    env = c.envelope
    if not env:
        return ""
    step = width / len(env)
    mid = height / 2
    top = " ".join(f"L{i * step:.1f},{mid - max(0.0, hi) * mid:.1f}" for i, (_lo, hi) in enumerate(env))
    bottom = " ".join(
        f"L{i * step:.1f},{mid - min(0.0, lo) * mid:.1f}" for i, (lo, _hi) in reversed(list(enumerate(env)))
    )
    return (
        f'<svg class="wave" width="{width}" height="{height}" viewBox="0 0 {width} {height}" aria-hidden="true">'
        f'<path d="M0,{mid} {top} {bottom} Z"/></svg>'
    )


def _row(c: ClipResult) -> str:
    issues = "".join(
        f'<span class="issue {i.severity}">{escape(i.severity)}: {escape(i.code)} &mdash; {escape(i.message)}</span>'
        for i in c.issues
    )
    take = "" if c.take is None else f" (take {c.take})"
    sel = "" if c.selected else ' <span class="muted">superseded</span>'
    return (
        "<tr>"
        f'<td><span class="st {c.status}">{c.status}</span></td>'
        f"<td><code>{escape(c.line_id)}</code>{escape(take)}{sel}</td>"
        f"<td>{_wave(c)}</td>"
        f'<td class="num">{_fmt(c.duration_ms)}</td>'
        f'<td class="num">{_fmt(c.target_duration_ms)}</td>'
        f'<td class="num">{_fmt(c.ratio_to_source, 2)}</td>'
        f'<td class="num">{_fmt(c.input_lufs)}</td>'
        f'<td class="num">{_fmt(c.output_lufs, 2)}</td>'
        f'<td class="num">{_fmt(c.output_true_peak_dbtp, 2)}</td>'
        f'<td class="num">{_fmt(c.peak_dbfs)}</td>'
        f'<td class="num">{_fmt(c.noise_floor_dbfs)}</td>'
        f'<td class="num">{_fmt(c.snr_db)}</td>'
        f'<td class="num">{_fmt(c.clipping_events)}</td>'
        f'<td class="num">{_fmt(c.lead_trim_ms, 0)} / {_fmt(c.tail_trim_ms, 0)}</td>'
        f"<td>{escape(c.normalization_type or '')}</td>"
        f'<td class="issues">{issues}</td>'
        "</tr>"
    )


HEAD = (
    "<tr><th>QC</th><th>Line</th><th>Waveform</th><th>Dur ms</th><th>Target ms</th><th>&times; src</th>"
    "<th>In LUFS</th><th>Out LUFS</th><th>Out dBTP</th><th>Raw peak dBFS</th><th>Floor dBFS</th><th>SNR dB</th>"
    "<th>Clip ev.</th><th>Trim ms lead/tail</th><th>Loudnorm</th><th>Issues</th></tr>"
)


def render_report(batch: BatchResult, cfg: QcConfig, now: datetime | None = None) -> str:
    stamp = (now or datetime.now(UTC)).replace(microsecond=0).isoformat()
    sections = []
    for lang in batch.languages:
        clips = sorted((c for c in batch.clips if c.language == lang), key=lambda c: (c.line_id, c.take or 0))
        sel = [c for c in clips if c.selected]
        counts = {s: sum(1 for c in sel if c.status == s) for s in ("pass", "warn", "fail")}
        missing = batch.missing(lang)
        tiles = "".join(
            f'<div class="tile"><span class="muted">{label}</span><b class="{cls}">{n}</b></div>'
            for label, cls, n in (
                ("Passed", "pass", counts["pass"]),
                ("Warnings", "warn", counts["warn"]),
                ("Failed", "fail", counts["fail"]),
                ("Missing", "", len(missing)),
                ("Catalogue lines", "", len(batch.catalogue.lines)),
            )
        )
        rows = "".join(_row(c) for c in clips) or '<tr><td colspan="16" class="muted">No recordings.</td></tr>'
        missing_html = (
            f'<details><summary>{len(missing)} line(s) still to record</summary><p class="muted">'
            + ", ".join(f"<code>{escape(m)}</code>" for m in missing)
            + "</p></details>"
            if missing
            else ""
        )
        sections.append(
            f'<section><h2>{escape(lang)}</h2><div class="tiles">{tiles}</div>'
            f'<div class="scroll"><table><thead>{HEAD}</thead><tbody>{rows}</tbody></table></div>'
            f"{missing_html}</section>"
        )
    rejected = ""
    if batch.rejected_files:
        items = "".join(f"<li><code>{escape(f)}</code> &mdash; {escape(r)}</li>" for f, r in batch.rejected_files)
        rejected = f'<section><h2 class="fail">Rejected files</h2><ul>{items}</ul></section>'
    loud = cfg.loudness
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        f"<title>Voice QC Report</title><style>{CSS}</style></head><body><main>"
        "<h1>Voice-over QC report</h1>"
        f'<p class="muted">Generated {escape(stamp)} &middot; catalogue {escape(batch.catalogue.catalogue_version)} '
        f"&middot; target {loud.target_lufs} LUFS &plusmn; {loud.tolerance_lu} LU, "
        f"&le; {loud.true_peak_ceiling_dbtp} dBTP "
        f"&middot; Opus {cfg.encode.bitrate_kbps} kbps {cfg.encode.sample_rate_hz // 1000} kHz mono</p>"
        f"{rejected}{''.join(sections)}</main></body></html>"
    )


def write_report(batch: BatchResult, cfg: QcConfig, out_dir: Path, now: datetime | None = None) -> Path:
    path = out_dir / "qc-report.html"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(render_report(batch, cfg, now), encoding="utf-8")
    return path
