#!/usr/bin/env python3
"""plan-lint (PLT-08): lint the feature dependency graph in ``docs/IMPLEMENTATION_PLAN.md``.

Every feature header in the plan reads::

    #### ID · Title — Priority · Milestone · deps: A, B · src: ...

The linter parses those headers (or a ``features.yaml`` mirror) and fails when

* a header that starts like a feature header cannot be parsed,
* a feature ID is declared twice,
* a dependency names an unknown feature ID,
* the dependency graph has a cycle (including a self-dependency),
* a dependency belongs to a milestone that starts later than the feature's milestone,
* a dependency has a lower priority than the feature (P0 < P1 < P2 < PG),
* the plan's "Appendix A: feature counts" table disagrees with the headers.

Milestone start months are read from the plan itself (the ``Milestones are defined in §8: M0 P5-P7, ...``
sentence; en dashes accepted), so the schedule is never duplicated here. On success the tool prints a
deterministic topological build order. Standard library only (PyYAML is imported lazily for ``--features-yaml``).
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

PRIORITY_RANK: dict[str, int] = {"P0": 0, "P1": 1, "P2": 2, "PG": 3}
"""Lower rank = more important. A feature may only depend on features of equal or higher importance."""

ID_RE = r"[A-Z]{2,4}-\d{2}[a-z]?"
HEADER_PREFIX_RE = re.compile(rf"^####\s+(?P<id>{ID_RE})\b")
HEADER_RE = re.compile(
    rf"^####\s+(?P<id>{ID_RE})\s+·\s+(?P<title>.+?)\s+—\s+(?P<priority>P0|P1|P2|PG)\s+·\s+"
    r"(?P<milestone>M\d+|PG)\s+·\s+deps:\s*(?P<deps>.*?)(?:\s+·\s+src:\s*(?P<src>.*))?\s*$"
)
MILESTONE_DEF_RE = re.compile(r"Milestones are defined in[^:]*:(?P<body>[^\n]+)")
MILESTONE_ITEM_RE = re.compile(r"\b(?P<m>M\d+)\s+P(?P<start>\d+)\s*[\u2013-]\s*P(?P<end>\d+)")
NO_DEPS = {"", "\u2014", "-", "\u2013", "none"}  # empty, em dash, hyphen, en dash
REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PLAN = REPO_ROOT / "docs" / "IMPLEMENTATION_PLAN.md"


@dataclass(frozen=True)
class Feature:
    """One plan feature parsed from a header line."""

    id: str
    title: str
    priority: str
    milestone: str
    deps: tuple[str, ...]
    line: int = 0

    @property
    def area(self) -> str:
        return self.id.split("-", 1)[0]


@dataclass
class Finding:
    """A lint error (``code`` is stable and machine-readable)."""

    code: str
    feature: str | None
    message: str
    line: int = 0

    def render(self) -> str:
        loc = f"line {self.line}: " if self.line else ""
        who = f"{self.feature}: " if self.feature else ""
        return f"[{self.code}] {loc}{who}{self.message}"


@dataclass
class Plan:
    """Parsed plan: features in document order plus milestone start months."""

    features: list[Feature]
    milestone_start: dict[str, float]
    parse_errors: list[Finding] = field(default_factory=list)
    appendix: Appendix | None = None

    def by_id(self) -> dict[str, Feature]:
        return {f.id: f for f in self.features}


@dataclass
class Appendix:
    """Counts claimed by the plan's Appendix A (area -> priority -> n, and per-milestone totals)."""

    by_area: dict[str, dict[str, int]]
    by_milestone: dict[str, int]
    line: int


# ----------------------------------------------------------------------------- parsing


def _split_deps(raw: str) -> tuple[str, ...]:
    raw = raw.strip()
    if raw.lower() in NO_DEPS:
        return ()
    return tuple(d.strip() for d in raw.split(",") if d.strip())


def parse_milestones(text: str) -> dict[str, float]:
    """Milestone -> start month (PG = +inf), from the plan's milestone definition sentence."""
    m = MILESTONE_DEF_RE.search(text)
    if not m:
        raise ValueError("cannot find the 'Milestones are defined in §8: M0 P5-P7, ...' sentence in the plan")
    starts: dict[str, float] = {
        item.group("m"): float(item.group("start")) for item in MILESTONE_ITEM_RE.finditer(m.group("body"))
    }
    if not starts:
        raise ValueError("the milestone definition sentence lists no 'Mn Pa-Pb' ranges")
    starts["PG"] = math.inf
    return starts


def parse_appendix(lines: Sequence[str]) -> Appendix | None:
    """Parse the 'Appendix A: feature counts' table and its 'By milestone:' sentence, if present."""
    start = next((i for i, ln in enumerate(lines) if re.match(r"^##\s+Appendix A\b", ln)), None)
    if start is None:
        return None
    header: list[str] | None = None
    by_area: dict[str, dict[str, int]] = {}
    by_milestone: dict[str, int] = {}
    for ln in lines[start + 1 :]:
        if ln.startswith("## "):
            break
        if ln.startswith("|") and not re.match(r"^\|\s*-", ln):
            cells = [c.strip().strip("*").strip() for c in ln.strip().strip("|").split("|")]
            if header is None:
                header = cells
                continue
            area = cells[0]
            if area.lower() == "total":
                continue
            by_area[area] = {h: int(v) for h, v in zip(header[1:], cells[1:], strict=False) if v.isdigit()}
        bm = re.match(r"^By milestone:\s*(?P<body>.+)$", ln)
        if bm:
            for item in re.finditer(r"\b(M\d+|PG)\s+(\d+)", bm.group("body")):
                by_milestone[item.group(1)] = int(item.group(2))
    return Appendix(by_area=by_area, by_milestone=by_milestone, line=start + 1)


def parse_plan_markdown(text: str) -> Plan:
    lines = text.splitlines()
    features: list[Feature] = []
    errors: list[Finding] = []
    in_fence = False
    for n, ln in enumerate(lines, start=1):
        if ln.lstrip().startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence or not HEADER_PREFIX_RE.match(ln):
            continue
        m = HEADER_RE.match(ln)
        if not m:
            fid = HEADER_PREFIX_RE.match(ln)
            errors.append(
                Finding(
                    "malformed-header",
                    fid.group("id") if fid else None,
                    "header does not match 'ID · Title — Priority · Milestone · deps: … · src: …'",
                    n,
                )
            )
            continue
        features.append(
            Feature(
                id=m.group("id"),
                title=m.group("title").strip(),
                priority=m.group("priority"),
                milestone=m.group("milestone"),
                deps=_split_deps(m.group("deps")),
                line=n,
            )
        )
    return Plan(
        features=features,
        milestone_start=parse_milestones(text),
        parse_errors=errors,
        appendix=parse_appendix(lines),
    )


def parse_features_yaml(path: Path, milestone_text: str) -> Plan:
    """Load the optional ``features.yaml`` mirror: a list of {id, title, priority, milestone, deps}."""
    import yaml  # noqa: PLC0415 - optional dependency, only for the mirror format

    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    items = data.get("features", data) if isinstance(data, dict) else data
    features = [
        Feature(
            id=str(it["id"]),
            title=str(it.get("title", "")),
            priority=str(it["priority"]),
            milestone=str(it["milestone"]),
            deps=tuple(str(d) for d in (it.get("deps") or [])),
        )
        for it in items
    ]
    return Plan(features=features, milestone_start=parse_milestones(milestone_text))


# ----------------------------------------------------------------------------- checks


def find_cycles(graph: Mapping[str, Iterable[str]]) -> list[list[str]]:
    """Strongly connected components with more than one node, or a self-loop (Tarjan, iterative)."""
    index: dict[str, int] = {}
    low: dict[str, int] = {}
    on_stack: set[str] = set()
    stack: list[str] = []
    cycles: list[list[str]] = []
    counter = 0
    adj = {k: sorted(set(v)) for k, v in graph.items()}
    for root in sorted(adj):
        if root in index:
            continue
        work: list[tuple[str, int]] = [(root, 0)]
        while work:
            node, i = work.pop()
            if i == 0:
                index[node] = low[node] = counter
                counter += 1
                stack.append(node)
                on_stack.add(node)
            succ = adj.get(node, [])
            if i < len(succ):
                work.append((node, i + 1))
                nxt = succ[i]
                if nxt not in adj:
                    continue
                if nxt not in index:
                    work.append((nxt, 0))
                elif nxt in on_stack:
                    low[node] = min(low[node], index[nxt])
                continue
            if low[node] == index[node]:
                comp: list[str] = []
                while True:
                    w = stack.pop()
                    on_stack.discard(w)
                    comp.append(w)
                    if w == node:
                        break
                if len(comp) > 1 or node in adj.get(node, []):
                    cycles.append(sorted(comp))
            if work:
                parent = work[-1][0]
                low[parent] = min(low[parent], low[node])
    return sorted(cycles)


def _cycle_path(graph: Mapping[str, Sequence[str]], members: list[str]) -> list[str]:
    """A concrete closed walk through one cycle component, for readable messages."""
    member_set = set(members)
    start = members[0]
    path = [start]
    seen = {start}
    node = start
    while True:
        nxt = next((d for d in sorted(graph.get(node, ())) if d in member_set and (d == start or d not in seen)), None)
        if nxt is None or nxt == start:
            path.append(start)
            return path
        path.append(nxt)
        seen.add(nxt)
        node = nxt


def lint(plan: Plan, *, check_appendix: bool = True) -> list[Finding]:
    findings: list[Finding] = list(plan.parse_errors)
    counts = Counter(f.id for f in plan.features)
    for fid, n in sorted(counts.items()):
        if n > 1:
            lines = [f.line for f in plan.features if f.id == fid]
            findings.append(Finding("duplicate-id", fid, f"declared {n} times (lines {lines})", lines[-1]))
    known = plan.by_id()
    for f in plan.features:
        if f.milestone not in plan.milestone_start:
            findings.append(Finding("unknown-milestone", f.id, f"milestone {f.milestone} is not defined", f.line))
        for d in f.deps:
            if d == f.id:
                continue  # reported as a cycle
            dep = known.get(d)
            if dep is None:
                findings.append(Finding("unknown-dep", f.id, f"depends on unknown feature {d}", f.line))
                continue
            f_start = plan.milestone_start.get(f.milestone)
            d_start = plan.milestone_start.get(dep.milestone)
            if f_start is not None and d_start is not None and d_start > f_start:
                findings.append(
                    Finding(
                        "later-milestone-dep",
                        f.id,
                        f"({f.milestone}) depends on {d} ({dep.milestone}), whose milestone starts later",
                        f.line,
                    )
                )
            if PRIORITY_RANK[dep.priority] > PRIORITY_RANK[f.priority]:
                findings.append(
                    Finding(
                        "lower-priority-dep",
                        f.id,
                        f"({f.priority}) depends on {d} ({dep.priority}), which has a lower priority",
                        f.line,
                    )
                )
    graph = {f.id: [d for d in f.deps if d in known] for f in plan.features}
    for comp in find_cycles(graph):
        path = _cycle_path(graph, comp)
        findings.append(
            Finding("cycle", comp[0], "dependency cycle: " + " -> ".join(path), known[comp[0]].line if comp else 0)
        )
    if check_appendix and plan.appendix is not None:
        findings.extend(check_appendix_counts(plan))
    return findings


def feature_counts(features: Sequence[Feature]) -> tuple[dict[str, dict[str, int]], dict[str, int]]:
    by_area: dict[str, dict[str, int]] = defaultdict(lambda: dict.fromkeys(PRIORITY_RANK, 0))
    by_milestone: Counter[str] = Counter()
    for f in features:
        by_area[f.area][f.priority] += 1
        by_milestone[f.milestone] += 1
    return {a: {**c, "Total": sum(c.values())} for a, c in by_area.items()}, dict(by_milestone)


def check_appendix_counts(plan: Plan) -> list[Finding]:
    appendix = plan.appendix
    if appendix is None:
        return []
    by_area, by_milestone = feature_counts(plan.features)
    out: list[Finding] = []
    for area in sorted(set(by_area) | set(appendix.by_area)):
        actual = by_area.get(area, {})
        claimed = appendix.by_area.get(area)
        if claimed is None:
            out.append(Finding("appendix-counts", None, f"area {area} missing from Appendix A", appendix.line))
            continue
        for col, n in claimed.items():
            if actual.get(col, 0) != n:
                out.append(
                    Finding(
                        "appendix-counts",
                        None,
                        f"Appendix A says {area} {col} = {n}, headers give {actual.get(col, 0)}",
                        appendix.line,
                    )
                )
    for ms, n in sorted(appendix.by_milestone.items()):
        if by_milestone.get(ms, 0) != n:
            out.append(
                Finding(
                    "appendix-counts",
                    None,
                    f"Appendix A says milestone {ms} = {n}, headers give {by_milestone.get(ms, 0)}",
                    appendix.line,
                )
            )
    return out


def topological_order(plan: Plan) -> list[Feature]:
    """Kahn's algorithm; ties broken by milestone start, priority, then document order (deterministic)."""
    known = plan.by_id()
    position = {f.id: i for i, f in enumerate(plan.features)}

    def key(fid: str) -> tuple[float, int, int]:
        f = known[fid]
        return (plan.milestone_start.get(f.milestone, math.inf), PRIORITY_RANK[f.priority], position[fid])

    indegree = dict.fromkeys(known, 0)
    dependents: dict[str, list[str]] = defaultdict(list)
    for f in known.values():
        for d in set(f.deps):
            if d in known and d != f.id:
                indegree[f.id] += 1
                dependents[d].append(f.id)
    ready = sorted((fid for fid, n in indegree.items() if n == 0), key=key)
    order: list[Feature] = []
    while ready:
        fid = ready.pop(0)
        order.append(known[fid])
        for nxt in dependents[fid]:
            indegree[nxt] -= 1
            if indegree[nxt] == 0:
                ready.append(nxt)
        ready.sort(key=key)
    if len(order) != len(known):
        raise ValueError("graph has a cycle; no topological order exists")
    return order


# ----------------------------------------------------------------------------- CLI


def load_plan(plan_path: Path, features_yaml: Path | None = None) -> Plan:
    text = plan_path.read_text(encoding="utf-8")
    if features_yaml is not None:
        return parse_features_yaml(features_yaml, text)
    return parse_plan_markdown(text)


def render_counts(features: Sequence[Feature]) -> str:
    by_area, by_ms = feature_counts(features)
    cols = [*PRIORITY_RANK, "Total"]
    rows = ["| Area | " + " | ".join(cols) + " |", "|---" * (len(cols) + 1) + "|"]
    areas = list(dict.fromkeys(f.area for f in features))
    for a in areas:
        rows.append(f"| {a} | " + " | ".join(str(by_area[a][c]) for c in cols) + " |")
    totals = [sum(by_area[a][c] for a in areas) for c in cols]
    rows.append("| **Total** | " + " | ".join(f"**{t}**" for t in totals) + " |")
    ms_order = sorted(by_ms, key=lambda m: (m == "PG", int(m[1:]) if m != "PG" else 0))
    rows.append("")
    rows.append("By milestone: " + ", ".join(f"{m} {by_ms[m]}" for m in ms_order) + ".")
    return "\n".join(rows)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="plan-lint", description=__doc__.split("\n\n", 1)[0])
    parser.add_argument("--plan", type=Path, default=DEFAULT_PLAN, help="plan markdown (default: %(default)s)")
    parser.add_argument("--features-yaml", type=Path, help="lint a features.yaml mirror instead of the headers")
    parser.add_argument("--order", action="store_true", help="print the topological build order")
    parser.add_argument("--counts", action="store_true", help="print the Appendix A counts table from the headers")
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    parser.add_argument("--no-appendix", action="store_true", help="skip the Appendix A count check")
    args = parser.parse_args(argv)

    try:
        plan = load_plan(args.plan, args.features_yaml)
    except (OSError, ValueError, KeyError) as exc:
        sys.stderr.write(f"plan-lint: {exc}\n")
        return 2
    findings = lint(plan, check_appendix=not args.no_appendix)
    order = [] if findings else topological_order(plan)

    if args.json:
        payload: dict[str, Any] = {
            "ok": not findings,
            "features": len(plan.features),
            "findings": [asdict(finding) for finding in findings],
            "order": [f.id for f in order],
        }
        sys.stdout.write(json.dumps(payload, indent=2) + "\n")
        return 1 if findings else 0

    for finding in findings:
        sys.stdout.write(finding.render() + "\n")
    if findings:
        sys.stdout.write(f"plan-lint: FAILED with {len(findings)} finding(s) over {len(plan.features)} features\n")
        return 1
    if args.counts:
        sys.stdout.write(render_counts(plan.features) + "\n\n")
    if args.order:
        current = None
        for f in order:
            if f.milestone != current:
                current = f.milestone
                sys.stdout.write(f"\n## {current}\n")
            deps = ", ".join(f.deps) if f.deps else "-"
            sys.stdout.write(f"{f.id:<8} {f.priority}  {f.title}  (deps: {deps})\n")
        sys.stdout.write("\n")
    edges = sum(len(f.deps) for f in plan.features)
    sys.stdout.write(
        f"plan-lint: OK - {len(plan.features)} features, {edges} dependency edges, no cycles, "
        "no later-milestone or lower-priority dependencies\n"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
