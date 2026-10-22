"""Self-contained HTML timeline for QA (no scripts, fonts or assets from the network).

Layout: verdict and session facts, issues, a whole-session overview, then one section per module with
an SVG swimlane (phases, trials, stimuli, prompt ends, responses with latency spans, shifts, walkaway)
and a trial table, and finally the indicator reproducibility table whose rows link to their trials.
"""

from __future__ import annotations

import math
from html import escape
from typing import Any

from shriii_replay.replay import ReplayReport
from shriii_replay.timeline import Marker, ModuleSpan, ResponseRow, TrialRow

PHASE_COLOURS = {
    "practice": "#9aa5b1",
    "warmup": "#b7a57a",
    "main": "#4c8bf5",
    "pressure": "#e8833a",
    "shift_pre": "#7b6cd9",
    "shift_post": "#22a39f",
}
OUTCOME_COLOURS = {
    "correct": "#2e9e5b",
    "incorrect": "#d9534f",
    "omission": "#c0841a",
    "commission": "#b23c8c",
    "timeout": "#8a8f98",
    "aborted": "#5a5f68",
    "not_applicable": "#6c8ebf",
}
MARKER_COLOURS = {
    "shift": "#e8833a",
    "walkaway.prompted": "#d9534f",
    "walkaway.resumed": "#2e9e5b",
    "session.abandoned": "#8b1e1e",
    "idle": "#8a8f98",
    "invalid": "#9b59b6",
    "instruction_replay": "#3fa7d6",
    "ui.replay": "#3fa7d6",
    "onlooker_reported": "#c0841a",
    "researcher_annotation": "#6c8ebf",
    "device_health": "#5a5f68",
}
MODULE_PALETTE = ["#4c8bf5", "#22a39f", "#e8833a", "#7b6cd9", "#d9534f", "#2e9e5b", "#c0841a", "#b23c8c"]

CSS = """
:root{--bg:#f7f8fa;--panel:#fff;--text:#1d2330;--muted:#5d6675;--grid:#e3e6eb;--ok:#2e9e5b;--bad:#d9534f;
--warn:#c0841a;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#12151a;--panel:#1b2027;--text:#e6e9ee;--muted:#9aa4b2;
--grid:#2c333d;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);
font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1280px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:4px 0 12px}h2{font-size:16px;margin:24px 0 8px}h3{font-size:14px;margin:0}
section,.card{background:var(--panel);border-radius:8px;padding:12px 14px;margin-bottom:12px}
.badges{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.badge{padding:3px 10px;border-radius:999px;font-weight:600;font-size:12px;color:#fff}
.ok{background:var(--ok)}.bad{background:var(--bad)}.warn{background:var(--warn)}.na{background:#6b7280}
table{border-collapse:collapse;width:100%;font-size:12.5px}th,td{padding:4px 6px;border-bottom:1px solid var(--grid);
text-align:left;vertical-align:top}th{color:var(--muted);font-weight:600;position:sticky;top:0;background:var(--panel)}
td.num{text-align:right;font-variant-numeric:tabular-nums}
.facts{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:4px 16px;font-size:13px}
.facts div span{color:var(--muted)}
.scroll{overflow-x:auto;border:1px solid var(--grid);border-radius:6px}
.tablewrap{max-height:420px;overflow:auto}
svg text{fill:var(--text);font:11px system-ui,sans-serif}svg .muted{fill:var(--muted)}
svg .grid{stroke:var(--grid)}
.legend{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12px;color:var(--muted)}
.sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:-1px}
details>summary{cursor:pointer;font-weight:600}
.sev-error{color:var(--bad);font-weight:600}.sev-warning{color:var(--warn);font-weight:600}
.sev-info{color:var(--muted)}
tr:target{outline:2px solid var(--warn)}
code{font-size:12px}
"""


def _f(v: Any, digits: int = 1) -> str:
    if v is None:
        return "-"
    if isinstance(v, bool):
        return "yes" if v else "no"
    if isinstance(v, float):
        return f"{v:.{digits}f}"
    return escape(str(v))


def _badge(label: str, state: bool | None) -> str:
    cls = "na" if state is None else ("ok" if state else "bad")
    word = "n/a" if state is None else ("pass" if state else "fail")
    return f'<span class="badge {cls}">{escape(label)}: {word}</span>'


def _trial_anchor(t: TrialRow) -> str:
    # Escaped: replay renders events that failed validation, so ids are untrusted text.
    return escape(f"t-{t.module_id}-{t.trial_id}".replace(":", "_"), quote=True)


class _Scale:
    def __init__(self, t0: float, t1: float, width: float, left: float = 110.0) -> None:
        self.t0, self.t1, self.left = t0, max(t1, t0 + 1.0), left
        self.width = width

    def x(self, t: float) -> float:
        return self.left + (t - self.t0) / (self.t1 - self.t0) * self.width


def _axis(sc: _Scale, y: float, height: float) -> list[str]:
    span_s = (sc.t1 - sc.t0) / 1000.0
    step = next(
        (s for s in (1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600) if span_s / s <= 14),
        max(3600, math.ceil(span_s / 14 / 3600) * 3600),
    )
    out = []
    k = 0.0
    while k <= span_s + 1e-9:
        x = sc.x(sc.t0 + k * 1000.0)
        out.append(f'<line class="grid" x1="{x:.1f}" y1="{y}" x2="{x:.1f}" y2="{y + height}"/>')
        out.append(f'<text class="muted" x="{x + 2:.1f}" y="{y + height + 12}">{k:g}s</text>')
        k += step
    return out


def _marker_svg(m: Marker, sc: _Scale, y: float, h: float) -> str:
    colour = MARKER_COLOURS.get(m.kind, "#888")
    x = sc.x(m.t_ms)
    tip = escape(f"{m.label} (seq {m.seq}, t={m.t_ms:.0f} ms)")
    if m.kind == "shift":
        return (
            f'<g><title>{tip}</title><line x1="{x:.1f}" y1="{y}" x2="{x:.1f}" y2="{y + h}" stroke="{colour}" '
            f'stroke-width="2" stroke-dasharray="4 3"/><path d="M{x - 5:.1f},{y} L{x + 5:.1f},{y} L{x:.1f},{y + 7}Z" '
            f'fill="{colour}"/></g>'
        )
    return (
        f'<g><title>{tip}</title><rect x="{x - 4:.1f}" y="{y + h / 2 - 4:.1f}" width="8" height="8" '
        f'transform="rotate(45 {x:.1f} {y + h / 2:.1f})" fill="{colour}"/></g>'
    )


def _response_svg(r: ResponseRow, t: TrialRow, sc: _Scale, y: float) -> list[str]:
    out: list[str] = []
    mode = r.input_mode
    colour = "#d9534f" if r.barge_in else ("#8a8f98" if mode == "timeout" else "#1d6fe0")
    x = sc.x(r.t_ms)
    tip = escape(
        f"{t.trial_id}: {r.value or mode} via {mode}; latency {r.latency_ms} ms from {r.latency_anchor}"
        f"{' (barge-in)' if r.barge_in else ''}; seq {r.seq}"
    )
    if r.anchor_ms is not None and r.latency_ms is not None:
        xa = sc.x(r.anchor_ms)
        out.append(
            f'<line x1="{xa:.1f}" y1="{y}" x2="{x:.1f}" y2="{y}" stroke="{colour}" stroke-width="2" opacity=".7"/>'
        )
    if mode == "timeout":
        shape = (
            f'<path d="M{x - 4:.1f},{y - 4} L{x + 4:.1f},{y + 4} M{x + 4:.1f},{y - 4} L{x - 4:.1f},{y + 4}" '
            f'stroke="{colour}" stroke-width="2"/>'
        )
    elif mode == "voice":
        shape = f'<path d="M{x:.1f},{y - 5} L{x + 5:.1f},{y} L{x:.1f},{y + 5} L{x - 5:.1f},{y}Z" fill="{colour}"/>'
    elif mode == "voice_then_touch_confirm":
        shape = f'<rect x="{x - 4:.1f}" y="{y - 4}" width="8" height="8" fill="{colour}"/>'
    else:
        shape = f'<circle cx="{x:.1f}" cy="{y}" r="4" fill="{colour}"/>'
    out.append(f"<g><title>{tip}</title>{shape}</g>")
    return out


def _module_svg(m: ModuleSpan, markers: list[Marker]) -> str:
    t0 = m.start_ms
    t1 = m.end_ms if m.end_ms is not None else max((t.end_ms or t.start_ms) for t in m.trials)
    width = max(1000.0, (t1 - t0) / 1000.0 * 14.0)
    sc = _Scale(t0, t1, width)
    lanes = [("phase", 14), ("trials", 22), ("stimuli", 16), ("responses", 22), ("events", 18)]
    top = 8
    ys: dict[str, tuple[float, float]] = {}
    y = top
    for name, h in lanes:
        ys[name] = (y, h)
        y += h + 6
    total_h = y + 18
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width + 130:.0f}" height="{total_h:.0f}" '
        f'role="img" aria-label="timeline of {escape(m.module_id)}">'
    ]
    parts.extend(_axis(sc, top, y - top - 4))
    for name, (ly, lh) in ys.items():
        parts.append(f'<text class="muted" x="4" y="{ly + lh / 2 + 4:.1f}">{name}</text>')
    py, ph = ys["phase"]
    ty, th = ys["trials"]
    sy, sh = ys["stimuli"]
    ry, rh = ys["responses"]
    for t in m.trials:
        xs, xe = sc.x(t.start_ms), sc.x(t.end_ms if t.end_ms is not None else t.start_ms + 200)
        w = max(xe - xs, 1.5)
        pc = PHASE_COLOURS.get(t.phase or "", "#999")
        parts.append(
            f'<rect x="{xs:.1f}" y="{py}" width="{w:.1f}" height="{ph}" fill="{pc}" opacity=".85">'
            f"<title>{escape(str(t.phase))}</title></rect>"
        )
        oc = OUTCOME_COLOURS.get(t.outcome or "", "#bbb")
        flags = ", ".join(t.timing_flags) or "ok"
        tip = escape(
            f"{t.trial_id} #{t.trial_index} {t.trial_type} [{t.phase}] outcome={t.outcome} "
            f"scorable={t.scorable} shift_active={t.shift_active} timing={flags} seq {t.seq_min}-{t.seq_max}"
        )
        stroke = ' stroke="#d9534f" stroke-width="2"' if t.timing_flags or t.interrupted else ""
        dash = "" if t.scorable else ' stroke-dasharray="3 2" stroke="#888" fill-opacity=".45"'
        parts.append(
            f'<a href="#{_trial_anchor(t)}"><rect x="{xs:.1f}" y="{ty}" width="{w:.1f}" height="{th}" rx="2" '
            f'fill="{oc}"{stroke}{dash}><title>{tip}</title></rect></a>'
        )
        if t.onset_ms is not None:
            x = sc.x(t.onset_ms)
            parts.append(
                f"<g><title>{escape(f'stimulus {t.stimulus_id} presented at {t.onset_ms:.1f} ms')}</title>"
                f'<line x1="{x:.1f}" y1="{sy}" x2="{x:.1f}" y2="{sy + sh}" stroke="#7b6cd9" stroke-width="2"/></g>'
            )
        if t.audio_end_ms is not None:
            x = sc.x(t.audio_end_ms)
            parts.append(
                f"<g><title>{escape(f'prompt audio ended at {t.audio_end_ms:.1f} ms')}</title>"
                f'<path d="M{x:.1f},{sy} L{x + 6:.1f},{sy + sh / 2:.1f} L{x:.1f},{sy + sh}Z" fill="#22a39f"/></g>'
            )
        for r in t.responses:
            parts.extend(_response_svg(r, t, sc, ry + rh / 2))
    ey, eh = ys["events"]
    for mk in markers:
        if t0 - 1 <= mk.t_ms <= t1 + 1:
            if mk.kind == "shift":
                parts.append(_marker_svg(mk, sc, top, y - top - 4))
            else:
                parts.append(_marker_svg(mk, sc, ey, eh))
    parts.append("</svg>")
    return "".join(parts)


def _overview_svg(report: ReplayReport) -> str:
    tl = report.timeline
    width = 1100.0
    sc = _Scale(tl.start_ms, tl.end_ms, width)
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width + 130:.0f}" height="112" role="img" '
        'aria-label="session overview">'
    ]
    parts.extend(_axis(sc, 6, 82))
    parts.append('<text class="muted" x="4" y="22">state</text>')
    parts.append('<text class="muted" x="4" y="50">modules</text>')
    parts.append('<text class="muted" x="4" y="78">events</text>')
    states = tl.states
    for i, s in enumerate(states):
        end = states[i + 1].t_ms if i + 1 < len(states) else tl.end_ms
        x0, x1 = sc.x(s.t_ms), sc.x(end)
        parts.append(
            f'<rect x="{x0:.1f}" y="10" width="{max(x1 - x0, 1):.1f}" height="16" fill="#9aa5b1" '
            f'opacity="{0.35 + 0.15 * (i % 3):.2f}">'
            f"<title>{escape(s.label)} from {s.t_ms:.0f} ms</title></rect>"
        )
    for i, m in enumerate(tl.modules):
        x0 = sc.x(m.start_ms)
        x1 = sc.x(m.end_ms if m.end_ms is not None else m.start_ms)
        colour = MODULE_PALETTE[i % len(MODULE_PALETTE)]
        parts.append(
            f'<a href="#mod-{escape(m.module_id)}"><rect x="{x0:.1f}" y="38" width="{max(x1 - x0, 2):.1f}" height="18" '
            f'fill="{colour}" rx="3"><title>{escape(m.module_id)}: {len(m.trials)} trials, ended '
            f"{escape(str(m.ended_reason))}</title></rect></a>"
        )
        if x1 - x0 > 50:
            parts.append(f'<text x="{x0 + 4:.1f}" y="51" style="fill:#fff">{escape(m.module_id[:18])}</text>')
    for mk in tl.markers:
        parts.append(_marker_svg(mk, sc, 66, 18))
    parts.append("</svg>")
    return "".join(parts)


def _legend() -> str:
    items = [f'<span><i class="sw" style="background:{c}"></i>{escape(p)}</span>' for p, c in PHASE_COLOURS.items()]
    items += [f'<span><i class="sw" style="background:{c}"></i>{escape(o)}</span>' for o, c in OUTCOME_COLOURS.items()]
    items += [
        "<span>&#9679; touch</span><span>&#9670; voice</span><span>&#9632; voice then touch confirm</span>"
        "<span>&#10005; timeout</span><span style='color:#d9534f'>&#9679; barge-in</span>"
        "<span>| stimulus onset</span><span>&#9654; prompt audio end</span><span>&#9660; context shift</span>"
        "<span>&#9670; walkaway / idle / invalid</span><span>dashed trial = not scorable</span>"
        "<span>red outline = timing flag / interrupted</span>"
    ]
    return f'<div class="legend">{"".join(items)}</div>'


def _trial_table(m: ModuleSpan) -> str:
    rows = []
    for t in m.trials:
        r = t.responses[-1] if t.responses else None
        delta = (
            None
            if r is None or r.recomputed_latency_ms is None or r.latency_ms is None
            else r.recomputed_latency_ms - r.latency_ms
        )
        rows.append(
            f'<tr id="{_trial_anchor(t)}"><td class="num">{_f(t.trial_index)}</td>'
            f"<td><code>{escape(t.trial_id)}</code></td>"
            f"<td>{_f(t.phase)}</td><td>{_f(t.trial_type)}</td><td>{_f(t.stimulus_id)}</td><td>{_f(t.outcome)}</td>"
            f"<td>{_f(r.value if r else None)}</td><td>{_f(r.input_mode if r else None)}</td>"
            f'<td class="num">{_f(r.latency_ms if r else None)}</td><td>{_f(r.latency_anchor if r else None)}</td>'
            f'<td class="num">{_f(delta, 3)}</td><td>{_f(r.barge_in if r else None)}</td><td>{_f(t.scorable)}</td>'
            f"<td>{_f(t.shift_active)}</td><td>{escape(', '.join(t.timing_flags)) or 'ok'}</td>"
            f'<td class="num">{t.seq_min}-{t.seq_max}</td></tr>'
        )
    head = (
        "<tr><th>#</th><th>trial</th><th>phase</th><th>type</th><th>stimulus</th><th>outcome</th><th>response</th>"
        "<th>input</th><th>latency ms</th><th>anchor</th><th>log - anchor - latency</th><th>barge-in</th>"
        "<th>scorable</th><th>shift</th><th>timing</th><th>seq</th></tr>"
    )
    return f'<div class="tablewrap"><table>{head}{"".join(rows)}</table></div>'


def _issues(report: ReplayReport) -> str:
    issues = report.all_issues
    if not issues:
        return "<p>No issues.</p>"
    order = {"error": 0, "warning": 1, "info": 2}
    issues = sorted(issues, key=lambda i: order[i.severity])
    main_rows = [i for i in issues if i.severity != "info"]
    info_rows = [i for i in issues if i.severity == "info"]

    def table(rows: list[Any]) -> str:
        body = "".join(
            f'<tr><td class="sev-{i.severity}">{i.severity}</td><td><code>{escape(i.code)}</code></td>'
            f"<td>{escape(i.where)}</td><td>{escape(i.message)}</td></tr>"
            for i in rows
        )
        head = "<tr><th>severity</th><th>code</th><th>where</th><th>message</th></tr>"
        return f'<div class="tablewrap"><table>{head}{body}</table></div>'

    out = table(main_rows) if main_rows else "<p>No errors or warnings.</p>"
    if info_rows:
        out += f"<details><summary>{len(info_rows)} info</summary>{table(info_rows)}</details>"
    return out


def _indicators(report: ReplayReport) -> str:
    rp = report.reproducibility
    if rp is None:
        return "<p>Rescoring was skipped.</p>"
    trials = report.timeline.trials

    def link(seq: int | None) -> str:
        if seq is None:
            return "-"
        for t in trials:
            if t.seq_min <= seq <= t.seq_max:
                return f'<a href="#{_trial_anchor(t)}">{escape(t.trial_id)}</a>'
        return str(seq)

    prov = "".join(
        f"<tr><td>{escape(p['field'])}</td><td><code>{escape(', '.join(p['stored']))}</code></td>"
        f"<td><code>{escape(p['current'])}</code></td><td>{_badge('match', p['match'])}</td></tr>"
        for p in rp.provenance
    )
    d = rp.dictionary
    head = (
        f"<p>Mode: <b>{escape(rp.mode)}</b> (tolerance {rp.tolerance:g}, partition complete: "
        f"{_f(rp.partition_complete)}). Dictionary {escape(str(d.get('pathway')))} v{escape(str(d.get('version')))} "
        f"<code>{escape(str(d.get('sha256', ''))[:16])}</code> frozen={_f(d.get('frozen'))}. Scoring run "
        f"<code>{escape(rp.scoring_run_id[:16])}</code>. Quality: {escape(str(rp.quality.get('grade')))} "
        f"{escape(', '.join(rp.quality.get('flags', [])))}</p>"
    )
    if prov:
        head += f"<table><tr><th>provenance</th><th>stored</th><th>current</th><th></th></tr>{prov}</table>"
    rows = []
    for c in rp.comparisons:
        cls = {"match": "ok", "mismatch": "bad", "stored_only": "bad", "partition_dependent": "warn"}.get(
            c.outcome, "na"
        )
        rows.append(
            f"<tr><td><code>{escape(c.indicator_id)}</code></td><td>{escape(c.construct)}</td>"
            f"<td>{escape(c.formula_kind)}</td><td>{escape(c.computed_status)}</td>"
            f'<td class="num">{_f(c.computed_value, 6)}</td><td>{_f(c.stored_status)}</td>'
            f'<td class="num">{_f(c.stored_value, 6)}</td><td class="num">{_f(c.abs_delta, 12)}</td>'
            f'<td class="num">{c.n_valid}</td><td>{link(c.source_seq_min)} .. {link(c.source_seq_max)}</td>'
            f'<td><span class="badge {cls}">{escape(c.outcome)}</span></td></tr>'
        )
    table = (
        '<div class="tablewrap"><table><tr><th>indicator</th><th>construct</th><th>formula</th><th>status</th>'
        "<th>value</th><th>stored status</th><th>stored value</th><th>|delta|</th><th>n valid</th>"
        f"<th>source trials</th><th>outcome</th></tr>{''.join(rows)}</table></div>"
    )
    counts = ", ".join(f"{k}: {v}" for k, v in sorted(rp.counts.items()))
    return head + f"<p>{escape(counts)}</p>" + table


def render_html(report: ReplayReport) -> str:
    tl = report.timeline
    rp = report.reproducibility
    badges = "".join(
        [
            _badge("contracts and seq", report.valid),
            _badge("reproducible", report.reproducible),
            _badge("dictionary sha", rp.dictionary_sha_match if rp else None),
        ]
    )
    v = tl.versions
    facts = {
        "session": report.session_id,
        "participant": tl.participant_pid,
        "pathway / arm": f"{tl.pathway} / {tl.battery_arm}",
        "language": tl.language,
        "mode / site": f"{tl.mode} / {tl.site_mode}",
        "synthetic": tl.synthetic,
        "seed": tl.seed,
        "duration": f"{(tl.end_ms - tl.start_ms) / 1000:.1f} s",
        "end reason": tl.end_reason,
        "events": f"{report.n_events} ({report.n_events_clean} clean, {report.validation_mode})",
        "input modes": ", ".join(f"{k} {n}" for k, n in sorted(tl.input_modes.items())) or "-",
        "app / bundle": f"{v.get('app_version')} / {str(v.get('bundle_hash'))[:12]}",
        "scoring dict / indicator set": f"{v.get('scoring_dict_version')} / {v.get('indicator_set_version')}",
        "hardware / timing profile": f"{v.get('hardware_sku')} / {v.get('timing_profile_version')}",
        "input": f"{report.input['path']} ({report.input['kind']})",
    }
    facts_html = "".join(f"<div><span>{escape(k)}:</span> {_f(val)}</div>" for k, val in facts.items())
    modules_html = []
    for m in tl.modules:
        if not m.trials:
            continue
        modules_html.append(
            f'<section id="mod-{escape(m.module_id)}"><details open><summary>{escape(m.module_id)} '
            f"({escape(str(m.kind))}, {len(m.trials)} trials, ended {escape(str(m.ended_reason))}, "
            f"{((m.end_ms or m.start_ms) - m.start_ms) / 1000:.1f} s)</summary>"
            f'<div class="scroll">{_module_svg(m, tl.markers)}</div>{_trial_table(m)}</details></section>'
        )
    title = f"Session replay {report.session_id}"
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'\">"
        f"<title>{escape(title)}</title><style>{CSS}</style></head><body><main>"
        f'<h1>{escape(title)}</h1><div class="badges">{badges}</div>'
        f'<section class="facts">{facts_html}</section>'
        f"<h2>Issues</h2><section>{_issues(report)}</section>"
        f'<h2>Session overview</h2><section><div class="scroll">{_overview_svg(report)}</div>{_legend()}</section>'
        f"<h2>Modules</h2>{''.join(modules_html) or '<p>No trials.</p>'}"
        f"<h2>Indicators</h2><section>{_indicators(report)}</section>"
        "</main></body></html>\n"
    )
