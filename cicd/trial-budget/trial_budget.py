#!/usr/bin/env python3
"""trial-budget (SCR-03 / ONB-08): the trial-time budget sheet for both pathways.

Reads (never writes) ``content/games/**/*.json``, ``content/games/session-plan.json``, the pathway scoring
dictionaries (``min_valid_trials``) and the plan section 4.4 table, then

1. recomputes every module's duration per level for the median bot, the slow bot and the slow bot trimmed to
   block minimums (``intro + outro + sum(trials x seconds_per_trial | budget_trial_ms)``);
2. sums them per session form (Pathway B: 5 core modules + each planned-missingness slot; Pathway A: the three
   episodes) and checks the 900 s cap, the 890 s target, scored-play limits and the per-segment ceilings;
3. cross-checks the session-plan ceilings against the plan section 4.4 table;
4. checks that the schedule guarantees each indicator's ``min_valid_trials`` (the trial "supply").

Prints a Markdown table (``--format markdown``), JSON or CSV. Exit code 1 on any error (``--strict`` also
fails on warnings). Every threshold comes from the content, dictionary or plan; ``budget.yaml`` only maps them.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import re
import sys
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import yaml

TOOL_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOL_DIR.parents[1]
DEFAULT_CONFIG = TOOL_DIR / "budget.yaml"
BOTS = ("median", "slow")


# ----------------------------------------------------------------------------- data


@dataclass
class Finding:
    severity: str  # "error" | "warning"
    code: str
    subject: str
    message: str

    def render(self) -> str:
        return f"{self.severity.upper():7} [{self.code}] {self.subject}: {self.message}"


@dataclass
class ModuleBudget:
    module_id: str
    kind: str
    pathways: list[str]
    slot: bool
    scorable: bool
    soft_cap_s: float
    hard_cap_s: float
    # level -> {"median", "slow", "slow_trimmed", "min_median"} seconds
    durations: dict[str, dict[str, float]]
    planned_trials: int
    min_trials: int


@dataclass
class FormBudget:
    pathway: str
    form: str
    modules: list[str]
    scored_median_l2_s: float
    scored_min_l2_s: float
    slow_l1_s: float
    hard_caps_s: float
    segments_s: float

    @property
    def ceiling_total_s(self) -> float:
        return self.segments_s + self.hard_caps_s

    @property
    def slow_total_s(self) -> float:
        return self.segments_s + self.slow_l1_s

    @property
    def min_total_s(self) -> float:
        return self.segments_s + self.scored_min_l2_s


@dataclass
class SupplyRow:
    pathway: str
    indicator: str
    construct: str
    task: str
    unit: str
    required: int
    basis: str
    status: str
    supply: int | None
    form: str | None
    behaviour_dependent: bool
    verdict: str  # ok | short | waived | demoted | behaviour_dependent | unmapped


@dataclass
class Report:
    modules: list[ModuleBudget]
    forms: list[FormBudget]
    supply: list[SupplyRow]
    plan_targets: dict[str, Any]
    session_plan: dict[str, Any]
    findings: list[Finding] = field(default_factory=list)

    @property
    def errors(self) -> list[Finding]:
        return [f for f in self.findings if f.severity == "error"]

    @property
    def warnings(self) -> list[Finding]:
        return [f for f in self.findings if f.severity == "warning"]


# ----------------------------------------------------------------------------- loading


def _json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


_LOADER: Any = getattr(yaml, "CSafeLoader", yaml.SafeLoader)


def _yaml(path: Path) -> Any:
    return yaml.load(path.read_text(encoding="utf-8"), Loader=_LOADER)  # safe loader (C or Python)


def load_games(root: Path) -> dict[str, dict[str, Any]]:
    games: dict[str, dict[str, Any]] = {}
    for path in sorted((root / "content" / "games").rglob("*.json")):
        if path.name == "session-plan.json":
            continue
        data = _json(path)
        games[data["module_id"]] = data
    return games


def module_duration_ms(game: Mapping[str, Any], level: str, bot: str, *, trimmed: bool) -> float:
    """Same model as content/games/README.md: intro + outro + sum(trials x per-trial time)."""
    spt = float(game["levels"][level]["seconds_per_trial"][bot])
    total = float(game["budget"]["intro_ms"]) + float(game["budget"]["outro_ms"])
    for block in game["blocks"]:
        n = block["min_trials"] if trimmed else block["trials"]
        per = block["budget_trial_ms"] if block["budget_trial_ms"] is not None else spt * 1000.0
        total += n * float(per)
    return total


def module_budget(game: Mapping[str, Any], levels: Sequence[str]) -> ModuleBudget:
    durations: dict[str, dict[str, float]] = {}
    for level in levels:
        durations[level] = {
            "median": module_duration_ms(game, level, "median", trimmed=False) / 1000.0,
            "slow": module_duration_ms(game, level, "slow", trimmed=False) / 1000.0,
            "slow_trimmed": module_duration_ms(game, level, "slow", trimmed=True) / 1000.0,
            "min_median": module_duration_ms(game, level, "median", trimmed=True) / 1000.0,
        }
    scorable = [b for b in game["blocks"] if b["scorable"]]
    return ModuleBudget(
        module_id=game["module_id"],
        kind=game["kind"],
        pathways=list(game["pathways"]),
        slot=bool(game["slot"]),
        scorable=bool(game["scorable"]),
        soft_cap_s=game["budget"]["soft_cap_ms"] / 1000.0,
        hard_cap_s=game["budget"]["hard_cap_ms"] / 1000.0,
        durations=durations,
        planned_trials=sum(int(b["trials"]) for b in scorable),
        min_trials=sum(int(b["min_trials"]) for b in scorable),
    )


_NUM = r"(\d+(?:\.\d+)?)"


def parse_plan_section_4_4(text: str, cfg: Mapping[str, Any]) -> dict[str, Any]:
    """Extract the plan section 4.4 table: per-segment ceilings, scored-play design targets, total and cap."""
    heading = cfg["heading"]
    start = text.find(heading)
    if start < 0:
        raise ValueError(f"plan heading {heading!r} not found")
    section = text[start:]
    nxt = re.search(r"\n#{2,3} ", section[len(heading) :])
    if nxt:
        section = section[: len(heading) + nxt.start()]
    rows: dict[str, list[str]] = {}
    for line in section.splitlines():
        if line.startswith("|") and not re.match(r"^\|\s*-", line):
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            rows[cells[0].replace("*", "").strip()] = cells[1:]
    out: dict[str, Any] = {"segments": {}, "scored": {}, "total": {}, "cap_s": None}

    def find_row(prefix: str) -> list[str]:
        for label, cells in rows.items():
            if label.startswith(prefix):
                return cells
        raise ValueError(f"plan section 4.4 has no row starting with {prefix!r}")

    def le(cell: str) -> float | None:
        m = re.search(r"≤\s*" + _NUM, cell)
        return float(m.group(1)) if m else None

    for prefix, key in cfg["rows"].items():
        cells = find_row(prefix)
        out["segments"][key] = {"B": le(cells[0]), "A": le(cells[1])}
    scored = find_row(cfg["scored_row"])
    for pathway, cell in zip(("B", "A"), scored[:2], strict=True):
        approx = re.findall(r"≈\s*\**\s*" + _NUM + r"(?:\s*[\u2013-]\s*" + _NUM + r")?", cell)
        if approx:
            lo, hi = approx[-1]
            out["scored"][pathway] = {"min": float(lo), "max": float(hi or lo)}
    total_label = next((label for label in rows if label.startswith(cfg["total_row"])), None)
    if total_label is None:
        raise ValueError("plan section 4.4 has no Total row")
    cap = re.search(r"cap\s+" + _NUM, total_label)
    out["cap_s"] = float(cap.group(1)) if cap else None
    out["total"] = {"B": le(rows[total_label][0]), "A": le(rows[total_label][1])}
    return out


def _span(lo: float, hi: float) -> str:
    return f"{lo:g}" if lo == hi else f"{lo:g}-{hi:g}"


def _dig(data: Any, path: Iterable[str]) -> Any:
    for key in path:
        data = data[key]
    return data


# ----------------------------------------------------------------------------- supply


def term_supply(term: Mapping[str, Any], game: Mapping[str, Any], segment_len: int) -> int:
    blocks = {b["block_id"]: b for b in game["blocks"]}
    counts = game.get("min_counts", {})

    def count(key: str) -> int:
        if key not in counts:
            raise KeyError(f"{game['module_id']}: min_counts has no key {key!r}")
        return int(counts[key])

    if "blocks" in term:
        missing = [b for b in term["blocks"] if b not in blocks]
        if missing:
            raise KeyError(f"{game['module_id']}: unknown block(s) {missing}")
        return sum(int(blocks[b]["min_trials"]) for b in term["blocks"])
    if "count" in term:
        value = count(term["count"]) * int(term.get("times", 1))
        if "times_count" in term:
            value *= count(term["times_count"])
        if "minus_count" in term:
            value -= count(term["minus_count"])
        return value
    if term.get("probe_segments"):
        probe = blocks.get("probe")
        return 0 if probe is None else int(probe["min_trials"]) // segment_len
    if "context_shift" in term:
        return int(bool(term["context_shift"]) and game.get("context_shift") is not None)
    if "beat_blocks" in term:
        return sum(1 for b in game["blocks"] if term["beat_blocks"] in b.get("beats", []))
    raise ValueError(f"unsupported supply term {dict(term)!r}")


def session_forms(session_plan: Mapping[str, Any]) -> dict[str, dict[str, list[str]]]:
    b = session_plan["pathways"]["B"]
    a = session_plan["pathways"]["A"]
    forms_b = {f"slot={slot}": [*b["core_order"], slot] for slot in b["slot_candidates"]}
    forms_a = {"episodes": list(a["order"])}
    forms_a.update({f"substudy={m}": [*a["order"], m] for m in a.get("optional_substudy", [])})
    return {"B": forms_b, "A": forms_a}


def forms_for(
    pathway_forms: Mapping[str, list[str]], source_module: str | None, games: Mapping[str, Any]
) -> dict[str, list[str]]:
    """Session forms in which an indicator is measured.

    Cross-module pseudo-modules (``cross_module``/``cross_episode``) pool every scored form; a slot module only
    counts in forms that contain it; a substudy-only module is evaluated in its substudy form.
    """
    base = {n: m for n, m in pathway_forms.items() if not n.startswith("substudy=")}
    if source_module not in games:
        return base
    containing = {n: m for n, m in base.items() if source_module in m}
    return containing or {n: m for n, m in pathway_forms.items() if source_module in m}


def compute_supply(
    dictionaries: Mapping[str, Mapping[str, Any]],
    games: Mapping[str, Mapping[str, Any]],
    session_plan: Mapping[str, Any],
    cfg: Mapping[str, Any],
    segment_len: int,
) -> tuple[list[SupplyRow], list[Finding]]:
    rows: list[SupplyRow] = []
    findings: list[Finding] = []
    forms = session_forms(session_plan)
    blocking = set(cfg.get("blocking_bases", []))
    demoted = set(cfg.get("demoted_statuses", []))
    waivers = cfg.get("waivers") or {}
    for pathway, dictionary in sorted(dictionaries.items()):
        mapping = (cfg.get("supply") or {}).get(pathway, {})
        for ind in dictionary["indicators"]:
            task = ind["source"]["task"]
            mvt = ind["min_valid_trials"]
            unit, required, basis = mvt["unit"], int(mvt["count"]), mvt["basis"]
            terms = (mapping.get(task) or {}).get(unit)
            base = {
                "pathway": pathway,
                "indicator": ind["id"],
                "construct": ind["construct"],
                "task": task,
                "unit": unit,
                "required": required,
                "basis": basis,
                "status": ind["status"],
            }
            if terms is None:
                rows.append(SupplyRow(**base, supply=None, form=None, behaviour_dependent=False, verdict="unmapped"))
                findings.append(
                    Finding("error", "supply-unmapped", f"{pathway}:{ind['id']}", f"no supply rule for {task}/{unit}")
                )
                continue
            source_module = ind["source"].get("module_id") or ind["source"].get("episode_id")
            relevant = forms_for(forms[pathway], source_module, games)
            worst: tuple[int, str] | None = None
            per_form: dict[str, int] = {}
            try:
                for name, mods in sorted(relevant.items()):
                    total = sum(term_supply(t, games[t["module"]], segment_len) for t in terms if t["module"] in mods)
                    per_form[name] = total
                    if worst is None or total < worst[0]:
                        worst = (total, name)
            except (KeyError, ValueError) as exc:
                findings.append(Finding("error", "supply-config", f"{pathway}:{ind['id']}", str(exc)))
                rows.append(SupplyRow(**base, supply=None, form=None, behaviour_dependent=False, verdict="unmapped"))
                continue
            supply, form = worst if worst is not None else (0, None)
            if len(relevant) > 1 and len(set(per_form.values())) == 1:
                form = "all forms"
            behaviour = any(t.get("behaviour_dependent") for t in terms)
            if supply >= required:
                verdict = "behaviour_dependent" if behaviour else "ok"
            elif ind["id"] in (waivers.get(pathway) or {}):
                verdict = "waived"
            elif ind["status"] in demoted:
                verdict = "demoted"
            elif behaviour:
                verdict = "behaviour_dependent"
            else:
                verdict = "short"
            rows.append(SupplyRow(**base, supply=supply, form=form, behaviour_dependent=behaviour, verdict=verdict))
            subject = f"{pathway}:{ind['id']}"
            detail = f"needs {required} {unit} ({basis}); schedule guarantees {supply} in {form}"
            if verdict == "short":
                severity = "error" if basis in blocking else "warning"
                findings.append(Finding(severity, "trial-supply", subject, detail))
            elif verdict == "waived":
                reason = " ".join(str(waivers[pathway][ind["id"]].get("reason", "")).split())
                findings.append(Finding("warning", "trial-supply-waived", subject, f"{detail}. Waiver: {reason}"))
            elif verdict == "behaviour_dependent" and supply < required:
                findings.append(Finding("warning", "trial-supply-behaviour", subject, detail))
    for pathway, items in waivers.items():
        known = {i["id"] for i in dictionaries.get(pathway, {}).get("indicators", [])}
        for ind_id in items or {}:
            row = next((r for r in rows if r.pathway == pathway and r.indicator == ind_id), None)
            if ind_id not in known:
                findings.append(Finding("error", "stale-waiver", f"{pathway}:{ind_id}", "waiver for unknown indicator"))
            elif row is not None and row.verdict != "waived":
                findings.append(
                    Finding("error", "stale-waiver", f"{pathway}:{ind_id}", "indicator now meets its budget; drop it")
                )
    return rows, findings


# ----------------------------------------------------------------------------- checks


def build_report(root: Path = REPO_ROOT, config_path: Path = DEFAULT_CONFIG) -> Report:
    cfg = _yaml(config_path)
    levels: list[str] = list(cfg["levels"])
    session_plan = _json(root / "content" / "games" / "session-plan.json")
    games = load_games(root)
    plan_targets = parse_plan_section_4_4(
        (root / "docs" / "IMPLEMENTATION_PLAN.md").read_text(encoding="utf-8"), cfg["plan_section_4_4"]
    )
    dictionaries = {
        p: _yaml(root / "stats" / "measurement-model" / "dictionary" / f"dictionary.{p}.yaml") for p in ("A", "B")
    }
    segment_len = int(_dig(_yaml(root / cfg["segment_param"]["file"]), cfg["segment_param"]["path"]))

    modules = {m: module_budget(g, levels) for m, g in games.items()}
    findings: list[Finding] = []
    segments = session_plan["segments_max_s"]
    segments_total = float(sum(segments.values()))

    # Per-module limits.
    b_lo, b_hi = session_plan["b_module_duration_s"]["min"], session_plan["b_module_duration_s"]["max"]
    b_modules = [*session_plan["pathways"]["B"]["core_order"], *session_plan["pathways"]["B"]["slot_candidates"]]
    for mid in b_modules:
        mb = modules[mid]
        if mb.hard_cap_s > b_hi:
            findings.append(Finding("error", "module-range", mid, f"hard cap {mb.hard_cap_s:g}s exceeds {b_hi}s"))
        for level in levels:
            for bot in ("median", "slow_trimmed"):
                d = mb.durations[level][bot]
                if not b_lo <= d <= b_hi:
                    findings.append(
                        Finding("error", "module-range", mid, f"{level} {bot} {d:.1f}s outside {b_lo}-{b_hi}s")
                    )
    a_lo, a_hi = session_plan["a_episode_median_s"]["min"], session_plan["a_episode_median_s"]["max"]
    for mid in session_plan["pathways"]["A"]["order"]:
        d = modules[mid].durations["L2"]["median"]
        if not a_lo <= d <= a_hi:
            findings.append(Finding("error", "episode-range", mid, f"L2 median {d:.1f}s outside {a_lo}-{a_hi}s"))
    for mid, mb in modules.items():
        for level in levels:
            if mb.durations[level]["median"] > mb.soft_cap_s:
                findings.append(
                    Finding("error", "soft-cap", mid, f"{level} median {mb.durations[level]['median']:.1f}s > soft cap")
                )
            if mb.durations[level]["slow_trimmed"] > mb.hard_cap_s:
                findings.append(
                    Finding(
                        "error", "hard-cap", mid, f"{level} trimmed slow {mb.durations[level]['slow_trimmed']:.1f}s"
                    )
                )
    warmup_id = session_plan["pathways"]["B"]["warmup"]
    if modules[warmup_id].hard_cap_s > segments["practice_warmup"]:
        findings.append(
            Finding(
                "error",
                "warmup",
                warmup_id,
                f"hard cap {modules[warmup_id].hard_cap_s:g}s > practice_warmup {segments['practice_warmup']}s",
            )
        )

    # Session forms.
    forms: list[FormBudget] = []
    cap = float(session_plan["session_cap_s"])
    target = float(session_plan["session_target_max_s"])
    sp_lo, sp_hi = session_plan["scored_play_median_s"]["min"], session_plan["scored_play_median_s"]["max"]
    if target > cap:
        findings.append(Finding("error", "session-cap", "session-plan", f"target {target:g}s > cap {cap:g}s"))
    for pathway, pforms in session_forms(session_plan).items():
        for name, mods in pforms.items():
            fb = FormBudget(
                pathway=pathway,
                form=name,
                modules=mods,
                scored_median_l2_s=sum(modules[m].durations["L2"]["median"] for m in mods),
                scored_min_l2_s=sum(modules[m].durations["L2"]["min_median"] for m in mods),
                slow_l1_s=sum(min(modules[m].durations["L1"]["slow"], modules[m].hard_cap_s) for m in mods),
                hard_caps_s=sum(modules[m].hard_cap_s for m in mods),
                segments_s=segments_total,
            )
            forms.append(fb)
            if name.startswith("substudy="):
                continue  # supervised substudy outside the 15-minute budget (reported only)
            subject = f"{pathway}:{name}"
            if not sp_lo <= fb.scored_median_l2_s <= sp_hi:
                findings.append(
                    Finding(
                        "error",
                        "scored-play",
                        subject,
                        f"median scored play {fb.scored_median_l2_s:.1f}s outside {sp_lo}-{sp_hi}s",
                    )
                )
            if fb.ceiling_total_s > target:
                findings.append(
                    Finding("error", "session-ceiling", subject, f"ceilings {fb.ceiling_total_s:.1f}s > {target:g}s")
                )
            if fb.slow_total_s > cap:
                findings.append(
                    Finding("error", "slow-bot", subject, f"slow bot at L1 {fb.slow_total_s:.1f}s > cap {cap:g}s")
                )
            if fb.min_total_s > target:
                findings.append(
                    Finding("error", "min-duration", subject, f"summed minimum {fb.min_total_s:.1f}s > {target:g}s")
                )
            design = plan_targets["scored"].get(pathway)
            tol = float(cfg["plan_section_4_4"]["design_target_tolerance_s"])
            if design and not design["min"] - tol <= fb.scored_median_l2_s <= design["max"] + tol:
                findings.append(
                    Finding(
                        "warning",
                        "design-target",
                        subject,
                        f"median scored play {fb.scored_median_l2_s:.1f}s vs plan section 4.4 design target "
                        f"{_span(design['min'], design['max'])}s (+/-{tol:g}s)",
                    )
                )

    # Plan section 4.4 cross-check.
    if plan_targets["cap_s"] is not None and plan_targets["cap_s"] != cap:
        findings.append(
            Finding("error", "plan-4.4", "session_cap_s", f"session plan {cap:g}s != plan {plan_targets['cap_s']:g}s")
        )
    for pathway, total in plan_targets["total"].items():
        if total is not None and target > total:
            findings.append(Finding("error", "plan-4.4", f"{pathway}:total", f"target {target:g}s > plan {total:g}s"))
    for key, per_pathway in plan_targets["segments"].items():
        if key not in segments:
            findings.append(Finding("error", "plan-4.4", key, "segment missing from session-plan.json"))
            continue
        for pathway, limit in per_pathway.items():
            if limit is not None and segments[key] > limit:
                findings.append(
                    Finding("error", "plan-4.4", f"{pathway}:{key}", f"session plan {segments[key]}s > plan {limit:g}s")
                )

    supply, supply_findings = compute_supply(dictionaries, games, session_plan, cfg, segment_len)
    findings.extend(supply_findings)
    return Report(
        modules=sorted(modules.values(), key=lambda m: (m.kind, m.module_id)),
        forms=forms,
        supply=supply,
        plan_targets=plan_targets,
        session_plan={
            "session_cap_s": cap,
            "session_target_max_s": target,
            "segments_max_s": segments,
            "scored_play_median_s": session_plan["scored_play_median_s"],
        },
        findings=findings,
    )


# ----------------------------------------------------------------------------- rendering


def _table(header: Sequence[str], rows: Iterable[Sequence[Any]]) -> str:
    lines = ["| " + " | ".join(header) + " |", "|" + "|".join("---" for _ in header) + "|"]
    lines.extend("| " + " | ".join(str(c) for c in row) + " |" for row in rows)
    return "\n".join(lines)


def render_markdown(report: Report) -> str:
    sp = report.session_plan
    out = ["## Trial-time budget (SCR-03 / ONB-08)", ""]
    status = "FAIL" if report.errors else "PASS"
    out.append(
        f"**{status}** - {len(report.errors)} error(s), {len(report.warnings)} warning(s). "
        f"Cap {sp['session_cap_s']:g} s, target {sp['session_target_max_s']:g} s, "
        f"non-scored ceilings {sum(sp['segments_max_s'].values())} s "
        f"({', '.join(f'{k} {v}' for k, v in sp['segments_max_s'].items())})."
    )
    out += ["", "### Sessions (seconds)", ""]
    out.append(
        _table(
            [
                "Pathway",
                "Form",
                "Scored median L2",
                "Scored minimum L2",
                "Slow bot L1",
                "Hard caps",
                "Total (ceilings)",
                "Total (slow L1)",
            ],
            (
                [
                    f.pathway,
                    f.form,
                    f"{f.scored_median_l2_s:.1f}",
                    f"{f.scored_min_l2_s:.1f}",
                    f"{f.slow_l1_s:.1f}",
                    f"{f.hard_caps_s:.1f}",
                    f"{f.ceiling_total_s:.1f}",
                    f"{f.slow_total_s:.1f}",
                ]
                for f in report.forms
            ),
        )
    )
    out += ["", "### Modules (seconds; median / slow / slow trimmed)", ""]
    rows = []
    for m in report.modules:
        levels = [
            f"{d['median']:.1f} / {d['slow']:.1f} / {d['slow_trimmed']:.1f}" for _, d in sorted(m.durations.items())
        ]
        rows.append(
            [
                m.module_id,
                m.kind,
                ",".join(m.pathways),
                "yes" if m.slot else "",
                *levels,
                f"{m.soft_cap_s:g} / {m.hard_cap_s:g}",
                f"{m.planned_trials} / {m.min_trials}",
            ]
        )
    level_names = sorted(report.modules[0].durations) if report.modules else []
    out.append(
        _table(
            ["Module", "Kind", "Pathways", "Slot", *level_names, "Soft / hard cap", "Scored trials planned / min"],
            rows,
        )
    )
    flagged = [r for r in report.supply if r.verdict != "ok"]
    ok = len(report.supply) - len(flagged)
    out += ["", f"### Trial supply ({ok}/{len(report.supply)} indicators guaranteed their minimum)", ""]
    out.append(
        _table(
            ["Pathway", "Indicator", "Task", "Required", "Basis", "Guaranteed", "Worst form", "Verdict"],
            (
                [
                    r.pathway,
                    r.indicator,
                    r.task,
                    f"{r.required} {r.unit}",
                    r.basis,
                    "-" if r.supply is None else r.supply,
                    r.form or "-",
                    r.verdict,
                ]
                for r in sorted(report.supply, key=lambda r: (r.verdict == "ok", r.pathway, r.indicator))
            ),
        )
    )
    if report.findings:
        out += ["", "### Findings", ""]
        out += [f"- {f.render()}" for f in sorted(report.findings, key=lambda f: (f.severity != "error", f.code))]
    return "\n".join(out) + "\n"


def render_json(report: Report) -> str:
    payload = {
        "ok": not report.errors,
        "session_plan": report.session_plan,
        "plan_section_4_4": report.plan_targets,
        "forms": [
            {
                **asdict(f),
                "ceiling_total_s": f.ceiling_total_s,
                "slow_total_s": f.slow_total_s,
                "min_total_s": f.min_total_s,
            }
            for f in report.forms
        ],
        "modules": [asdict(m) for m in report.modules],
        "supply": [asdict(r) for r in report.supply],
        "findings": [asdict(f) for f in report.findings],
    }
    return json.dumps(payload, indent=2) + "\n"


def render_csv(report: Report) -> str:
    """One row per indicator: the spreadsheet form of the budget sheet."""
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(
        [
            *("pathway", "indicator", "construct", "task", "unit", "required"),
            *("basis", "status", "guaranteed", "form", "verdict"),
        ]
    )
    for r in report.supply:
        writer.writerow(
            [
                *(r.pathway, r.indicator, r.construct, r.task, r.unit, r.required),
                *(r.basis, r.status, r.supply, r.form, r.verdict),
            ]
        )
    return buf.getvalue()


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="trial-budget", description=__doc__.split("\n\n", 1)[0])
    parser.add_argument("--root", type=Path, default=REPO_ROOT, help="repository root (default: %(default)s)")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--format", choices=("markdown", "json", "csv"), default="markdown")
    parser.add_argument("--out", type=Path, help="also write the rendered output to this file")
    parser.add_argument("--strict", action="store_true", help="fail on warnings too")
    args = parser.parse_args(argv)
    try:
        report = build_report(args.root, args.config)
    except (OSError, KeyError, ValueError, yaml.YAMLError) as exc:
        sys.stderr.write(f"trial-budget: {exc}\n")
        return 2
    rendered = {"markdown": render_markdown, "json": render_json, "csv": render_csv}[args.format](report)
    sys.stdout.write(rendered)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(rendered, encoding="utf-8")
    if args.format != "markdown":
        for f in report.findings:
            sys.stderr.write(f.render() + "\n")
    failed = bool(report.errors) or (args.strict and bool(report.warnings))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
