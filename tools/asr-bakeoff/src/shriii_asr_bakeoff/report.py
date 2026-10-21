"""Self-contained HTML report of a results JSON (per-language report with CIs, VOX-06 AC)."""

from __future__ import annotations

from html import escape
from pathlib import Path
from typing import Any

CSS = """
:root{--bg:#fbfaf7;--fg:#1f1d1a;--muted:#6b665e;--line:#e4e0d8;--pass:#1d7a46;--fail:#b3261e;--chip:#f1eee8;
--bar:#3d5a80;--ci:#98a9c0}
@media (prefers-color-scheme: dark){:root{--bg:#171614;--fg:#ece8e1;--muted:#a39d93;--line:#34312c;--pass:#5cc58a;
--fail:#ff8a80;--chip:#24221f;--bar:#8fb3e0;--ci:#4b5b70}}
*{box-sizing:border-box}body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);
font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:1200px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px}h2{font-size:18px;margin:28px 0 6px}h3{font-size:15px;margin:18px 0 6px}
.muted{color:var(--muted)}.warn{background:var(--chip);border-left:4px solid var(--fail);padding:8px 12px;margin:12px 0}
.scroll{overflow-x:auto;border:1px solid var(--line);border-radius:8px;margin:6px 0}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap;vertical-align:top}
th{font-size:12px;color:var(--muted);font-weight:600}td.num{text-align:right}td.wrap{white-space:normal}
.pass{color:var(--pass);font-weight:700}.fail{color:var(--fail);font-weight:700}
svg.ci rect.bar{fill:var(--bar)}svg.ci line{stroke:var(--fg);stroke-width:1.5}
svg.ci line.goal{stroke:var(--fail);stroke-dasharray:3 2}
"""


def _pct(v: float | None) -> str:
    return "&ndash;" if v is None else f"{100 * v:.1f}%"


def _ci_svg(p: dict[str, Any], goal: float | None = None, width: int = 140) -> str:
    if p["p"] is None:
        return ""

    def x(v: float) -> float:
        return round(v * width, 1)

    goal_line = f'<line class="goal" x1="{x(goal)}" y1="0" x2="{x(goal)}" y2="14"/>' if goal is not None else ""
    return (
        f'<svg class="ci" width="{width}" height="14" role="img" aria-label="{_pct(p["p"])}">'
        f'<rect class="bar" x="0" y="4" width="{x(p["p"])}" height="6" rx="2"/>'
        f'<line x1="{x(p["ci_low"])}" y1="7" x2="{x(p["ci_high"])}" y2="7"/>{goal_line}</svg>'
    )


def _prop(p: dict[str, Any]) -> str:
    return f"{_pct(p['p'])} <span class='muted'>[{_pct(p['ci_low'])}, {_pct(p['ci_high'])}] n={p['n']}</span>"


def _table(title: str, head: list[str], rows: list[str]) -> str:
    th = "".join(f"<th>{h}</th>" for h in head)
    body = "".join(rows)
    return f"<h3>{title}</h3><div class='scroll'><table><thead><tr>{th}</tr></thead><tbody>{body}</tbody></table></div>"


def _tr(*cells: str) -> str:
    return "<tr>" + "".join(c if c.startswith("<td") else f"<td>{c}</td>" for c in cells) + "</tr>"


def _language_section(e: dict[str, Any], lr: dict[str, Any], pol: dict[str, Any]) -> str:
    goal = pol["min_accuracy"]
    out = [
        f"<h2>{escape(e['engine_id'])} &middot; {escape(lr['language'])}</h2>",
        f"<p class='muted'>{lr['heldout_speakers']} held-out speakers &middot; latency p50 "
        f"{lr['latency_ms']['p50']:.0f} ms, p95 {lr['latency_ms']['p95']:.0f} ms &middot; RTF p95 "
        f"{lr['rtf']['p95']:.3f} &middot; CPU {lr['cpu']['cpu_ms_per_audio_s']:.0f} ms per audio second "
        f"&middot; peak RSS {lr['cpu']['peak_rss_mb']:.0f} MB</p>",
    ]
    out.append(
        _table(
            "Accuracy by SNR (held-out)",
            ["SNR dB", "Accuracy [95% CI]", "", "Rejections"],
            [
                _tr(
                    escape(str(a["snr_db"])),
                    _prop(a["accuracy"]),
                    _ci_svg(a["accuracy"], goal),
                    f"<td class='num'>{a['rejections']}</td>",
                )
                for a in lr["accuracy"]
            ],
        )
    )
    out.append(
        _table(
            "False accepts on keyword-free trials",
            ["SNR dB", "Source", "Rate [95% CI]"],
            [_tr(escape(str(f["snr_db"])), escape(f["source"]), _prop(f["rate"])) for f in lr["false_accepts"]],
        )
    )
    gaps = ", ".join(f"{escape(k)}: {'&ndash;' if v is None else f'{v:.1f} pp'}" for k, v in lr["gap_pp"].items())
    out.append(
        _table(
            f"Accuracy by age and gender at {pol['reference_snr_db']:g} dB <span class='muted'>(gaps: {gaps})</span>",
            ["Field", "Group", "Speakers", "Accuracy [95% CI]", ""],
            [
                _tr(
                    escape(s["field"]),
                    escape(s["group"]),
                    f"<td class='num'>{s['speakers']}</td>",
                    _prop(s["accuracy"]),
                    _ci_svg(s["accuracy"], goal),
                )
                for s in lr["subgroups"]
            ],
        )
    )
    out.append(
        _table(
            "Prompt policy (VOX-06)",
            ["Prompt", "Codes", "Accuracy [95% CI]", "Verdict", "Reasons"],
            [
                _tr(
                    escape(p["prompt_id"]),
                    escape(", ".join(p["vocabulary"])),
                    _prop(p["accuracy"]),
                    f"<td class='{'pass' if p['voice_enabled'] else 'fail'}'>"
                    f"{'voice' if p['voice_enabled'] else 'touch only'}</td>",
                    f"<td class='wrap muted'>{escape('; '.join(p['reasons']))}</td>",
                )
                for p in lr["prompts"]
            ],
        )
    )
    return "".join(out)


def render(results: dict[str, Any]) -> str:
    pol = results["policy"]
    ds = results["dataset"]
    parts = [
        f"<h1>ASR bake-off &middot; {escape(results['run_id'])}</h1>",
        f"<p class='muted'>Dataset {escape(ds['dataset_id'])} ({escape(ds['kind'])}, {ds['utterances']} utterances) "
        f"&middot; noise: {escape(results['conditions']['noise_source'])} &middot; policy: accuracy &ge; "
        f"{_pct(pol['min_accuracy'])} at {pol['reference_snr_db']:g} dB, gap &le; {pol['max_gap_pp']:g} pp, "
        f"&ge; {pol['min_heldout_speakers']} held-out speakers, false accepts &le; "
        f"{_pct(pol['max_false_accept_rate'])} &middot; {escape(results['host']['platform'])}</p>",
    ]
    if ds["kind"] == "synthetic_placeholder":
        parts.append(
            "<div class='warn'>Synthetic placeholder data: these numbers exercise the pipeline only and say "
            "nothing about real-speech accuracy. Voice must not be enabled from this run.</div>"
        )
    if results["conditions"]["noise_source"] == "synthetic":
        parts.append(
            "<div class='warn'>Synthetic market noise was used; VOX-05 requires recorded 75 dBA market noise.</div>"
        )
    parts.append(
        _table(
            "Winners",
            ["Language", "Engine", "Voice-enabled prompts", "Why"],
            [
                _tr(
                    escape(lang),
                    escape(w["engine_id"] or "none (touch only)"),
                    f"<td class='wrap'>{escape(', '.join(w['voice_enabled_prompts']) or '-')}</td>",
                    f"<td class='wrap muted'>{escape(w['reason'])}</td>",
                )
                for lang, w in sorted(results["winners"].items())
            ],
        )
    )
    unavailable = [e for e in results["engines"] if e.get("unavailable_reason")]
    if unavailable:
        items = "".join(
            f"<li><b>{escape(e['engine_id'])}</b>: {escape(e['unavailable_reason'])}</li>" for e in unavailable
        )
        parts.append(f"<h3>Engines not run (per language)</h3><ul>{items}</ul>")
    for e in results["engines"]:
        for lr in e["languages"]:
            parts.append(_language_section(e, lr, pol))
    body = "".join(parts)
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        f"<title>ASR Bake-off Report</title><style>{CSS}</style></head><body><main>{body}</main></body></html>"
    )


def write_report(results: dict[str, Any], out_dir: Path) -> Path:
    path = out_dir / f"report-{results['run_id']}.html"
    path.write_text(render(results), encoding="utf-8")
    return path
