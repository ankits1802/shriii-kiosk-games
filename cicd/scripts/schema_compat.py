#!/usr/bin/env python3
"""Contract compatibility check (PLT-02 policy, PLT-04 AC) between two copies of ``contracts/schemas``.

Usage::

    python cicd/scripts/schema_compat.py --base <dir with base schemas> --head <dir with head schemas>

Each schema node is compared structurally (local ``$defs`` by name, discriminated ``oneOf`` branches by their
``const`` discriminator value, other arrays by position). Every difference is classified:

``breaking``  the new schema rejects data the old one accepted (new readers cannot read old data): a new
              required field, a narrowed type, a removed enum value or union branch, tighter bounds, a changed
              pattern / format / ``$ref``, ``additionalProperties`` closed, a removed ``$defs`` entry.
``forward``   the new schema accepts data an old *strict* reader rejects (old backends / kiosks cannot read
              new data): enum values or union branches added, a type widened, bounds relaxed. Allowed in a
              minor release when the backend deploys first; the kiosk-release deploy-order gate fails on it.
``minor``     an optional property or ``$defs`` entry added, a property removed where extra properties are
              still allowed. Always allowed (minor versions add optional fields only).

Policy (PLT-02): a breaking change inside an existing ``*.vN.schema.json`` always fails; it needs a new major
file ``*.vN+1.schema.json`` plus migration notes at ``<migrations-dir>/<name>.vN+1.md``. Removing a schema file
is breaking unless a newer major of it exists with migration notes. Annotations (title, description, examples,
default, ``$comment``, ``deprecated``, ``x-*``) are ignored. Standard library only.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

SEVERITY_ORDER = {"minor": 0, "forward": 1, "breaking": 2}
FILE_RE = re.compile(r"^(?P<stem>.+)\.v(?P<major>\d+)\.schema\.json$")
ANNOTATIONS = {"title", "description", "examples", "default", "$comment", "deprecated", "readOnly", "writeOnly"}
IDENTITY = {"$schema", "$id", "$anchor"}
LOWER_BOUNDS = ("minimum", "exclusiveMinimum", "minLength", "minItems", "minProperties", "minContains")
UPPER_BOUNDS = ("maximum", "exclusiveMaximum", "maxLength", "maxItems", "maxProperties", "maxContains")
HANDLED = (
    ANNOTATIONS
    | IDENTITY
    | set(LOWER_BOUNDS)
    | set(UPPER_BOUNDS)
    | {
        "type",
        "enum",
        "const",
        "required",
        "properties",
        "additionalProperties",
        "patternProperties",
        "propertyNames",
        "items",
        "prefixItems",
        "contains",
        "$defs",
        "definitions",
        "$ref",
        "allOf",
        "anyOf",
        "oneOf",
        "not",
        "discriminator",
        "pattern",
        "format",
        "uniqueItems",
        "multipleOf",
        "dependentRequired",
    }
)


@dataclass(frozen=True)
class Change:
    severity: str
    schema: str
    pointer: str
    message: str

    def render(self) -> str:
        return f"{self.severity:8} {self.schema}{self.pointer}: {self.message}"


class Comparer:
    def __init__(self, schema: str) -> None:
        self.schema = schema
        self.changes: list[Change] = []

    def add(self, severity: str, pointer: str, message: str) -> None:
        self.changes.append(Change(severity, self.schema, pointer or "#", message))

    # ------------------------------------------------------------------ dispatch

    def compare(self, old: Any, new: Any, ptr: str = "#") -> None:
        if isinstance(old, bool) or isinstance(new, bool):
            self._compare_bool(old, new, ptr)
            return
        if not isinstance(old, dict) or not isinstance(new, dict):
            if old != new:
                self.add("breaking", ptr, "schema node changed shape")
            return
        self._compare_type(old, new, ptr)
        self._compare_values(old, new, ptr)
        self._compare_required(old, new, ptr)
        self._compare_properties(old, new, ptr)
        self._compare_bounds(old, new, ptr)
        self._compare_simple(old, new, ptr)
        self._compare_defs(old, new, ptr)
        self._compare_items(old, new, ptr)
        self._compare_composition(old, new, ptr)
        for key in sorted((set(old) | set(new)) - HANDLED):
            if key.startswith("x-"):
                continue
            if old.get(key) != new.get(key):
                self.add("breaking", f"{ptr}/{key}", f"unrecognised keyword {key!r} changed (review manually)")

    def _compare_bool(self, old: Any, new: Any, ptr: str) -> None:
        old_open = old is True or old == {}
        new_open = new is True or new == {}
        if old == new or (old_open and new_open):
            return
        if old is False:
            self.add("forward", ptr, "schema opened from false")
        elif new is False:
            self.add("breaking", ptr, "schema closed to false")
        elif old_open:
            self.add("breaking", ptr, "unconstrained schema gained constraints")
        elif new_open:
            self.add("forward", ptr, "constraints removed")

    # ------------------------------------------------------------------ keywords

    @staticmethod
    def _types(node: Mapping[str, Any]) -> set[str] | None:
        t = node.get("type")
        if t is None:
            return None
        return {t} if isinstance(t, str) else set(t)

    def _compare_type(self, old: Mapping[str, Any], new: Mapping[str, Any], ptr: str) -> None:
        ot, nt = self._types(old), self._types(new)
        if ot == nt:
            return
        if nt is None:
            self.add("forward", f"{ptr}/type", f"type constraint {sorted(ot or [])} removed")
            return
        if ot is None:
            self.add("breaking", f"{ptr}/type", f"type constraint {sorted(nt)} added")
            return

        def covered(t: str, by: set[str]) -> bool:
            return t in by or (t == "integer" and "number" in by)

        lost = sorted(t for t in ot if not covered(t, nt))
        gained = sorted(t for t in nt if not covered(t, ot))
        if lost:
            self.add("breaking", f"{ptr}/type", f"type narrowed: {lost} no longer accepted")
        if gained:
            self.add("forward", f"{ptr}/type", f"type widened: {gained} now accepted")

    def _compare_values(self, old: Mapping[str, Any], new: Mapping[str, Any], ptr: str) -> None:
        if "enum" in old or "enum" in new:
            if "enum" not in new:
                self.add("forward", f"{ptr}/enum", "enum constraint removed")
            elif "enum" not in old:
                self.add("breaking", f"{ptr}/enum", "enum constraint added")
            else:
                ov = [json.dumps(v, sort_keys=True) for v in old["enum"]]
                nv = [json.dumps(v, sort_keys=True) for v in new["enum"]]
                removed = [v for v in ov if v not in nv]
                added = [v for v in nv if v not in ov]
                if removed:
                    self.add("breaking", f"{ptr}/enum", f"enum values removed: {', '.join(removed)}")
                if added:
                    self.add("forward", f"{ptr}/enum", f"enum values added: {', '.join(added)}")
        if "const" in old or "const" in new:
            if "const" not in new:
                self.add("forward", f"{ptr}/const", "const constraint removed")
            elif "const" not in old:
                self.add("breaking", f"{ptr}/const", f"const {new['const']!r} added")
            elif old["const"] != new["const"]:
                self.add("breaking", f"{ptr}/const", f"const changed {old['const']!r} -> {new['const']!r}")

    def _compare_required(self, old: Mapping[str, Any], new: Mapping[str, Any], ptr: str) -> None:
        o, n = set(old.get("required", [])), set(new.get("required", []))
        for name in sorted(n - o):
            self.add("breaking", f"{ptr}/required", f"property {name!r} became required")
        for name in sorted(o - n):
            self.add("forward", f"{ptr}/required", f"property {name!r} is no longer required")
        od, nd = old.get("dependentRequired", {}), new.get("dependentRequired", {})
        for key in sorted(set(od) | set(nd)):
            added = set(nd.get(key, [])) - set(od.get(key, []))
            removed = set(od.get(key, [])) - set(nd.get(key, []))
            if added:
                self.add("breaking", f"{ptr}/dependentRequired/{key}", f"now also requires {sorted(added)}")
            if removed:
                self.add("forward", f"{ptr}/dependentRequired/{key}", f"no longer requires {sorted(removed)}")

    @staticmethod
    def _closed(node: Mapping[str, Any]) -> bool:
        return node.get("additionalProperties") is False

    def _compare_properties(self, old: Mapping[str, Any], new: Mapping[str, Any], ptr: str) -> None:
        op, np_ = old.get("properties", {}), new.get("properties", {})
        for name in sorted(set(op) & set(np_)):
            self.compare(op[name], np_[name], f"{ptr}/properties/{name}")
        for name in sorted(set(np_) - set(op)):
            if name in set(new.get("required", [])):
                continue  # reported by the required check
            if self._closed(old):
                self.add("minor", f"{ptr}/properties/{name}", "optional property added")
            else:
                self.compare(old.get("additionalProperties", True), np_[name], f"{ptr}/properties/{name}")
        for name in sorted(set(op) - set(np_)):
            if self._closed(new):
                self.add("breaking", f"{ptr}/properties/{name}", "property removed and extra properties are rejected")
            else:
                self.add("minor", f"{ptr}/properties/{name}", "property removed (extra properties still allowed)")
        oa, na = old.get("additionalProperties", True), new.get("additionalProperties", True)
        if oa is not False and na is False:
            self.add("breaking", f"{ptr}/additionalProperties", "additionalProperties closed")
        elif oa is False and na is not False:
            self.add("minor", f"{ptr}/additionalProperties", "additionalProperties opened")
        elif isinstance(oa, dict) or isinstance(na, dict):
            self.compare(oa, na, f"{ptr}/additionalProperties")
        opp, npp = old.get("patternProperties", {}), new.get("patternProperties", {})
        for pat in sorted(set(opp) | set(npp)):
            if pat not in npp:
                self.add("forward", f"{ptr}/patternProperties", f"pattern property {pat!r} removed")
            elif pat not in opp:
                self.add("breaking", f"{ptr}/patternProperties", f"pattern property {pat!r} added")
            else:
                self.compare(opp[pat], npp[pat], f"{ptr}/patternProperties/{pat}")
        if "propertyNames" in old or "propertyNames" in new:
            self.compare(old.get("propertyNames", True), new.get("propertyNames", True), f"{ptr}/propertyNames")

    def _compare_bounds(self, old: Mapping[str, Any], new: Mapping[str, Any], ptr: str) -> None:
        for key in LOWER_BOUNDS:
            o, n = old.get(key), new.get(key)
            if o == n:
                continue
            if n is not None and (o is None or n > o):
                self.add("breaking", f"{ptr}/{key}", f"{key} tightened {o} -> {n}")
            else:
                self.add("forward", f"{ptr}/{key}", f"{key} relaxed {o} -> {n}")
        for key in UPPER_BOUNDS:
            o, n = old.get(key), new.get(key)
            if o == n:
                continue
            if n is not None and (o is None or n < o):
                self.add("breaking", f"{ptr}/{key}", f"{key} tightened {o} -> {n}")
            else:
                self.add("forward", f"{ptr}/{key}", f"{key} relaxed {o} -> {n}")

    def _compare_simple(self, old: Mapping[str, Any], new: Mapping[str, Any], ptr: str) -> None:
        for key in ("pattern", "format", "multipleOf", "$ref"):
            o, n = old.get(key), new.get(key)
            if o == n:
                continue
            if n is None:
                self.add("forward", f"{ptr}/{key}", f"{key} {o!r} removed")
            elif o is None:
                self.add("breaking", f"{ptr}/{key}", f"{key} {n!r} added")
            else:
                self.add("breaking", f"{ptr}/{key}", f"{key} changed {o!r} -> {n!r}")
        ou, nu = bool(old.get("uniqueItems")), bool(new.get("uniqueItems"))
        if not ou and nu:
            self.add("breaking", f"{ptr}/uniqueItems", "uniqueItems required")
        elif ou and not nu:
            self.add("forward", f"{ptr}/uniqueItems", "uniqueItems dropped")
        if ("not" in old or "not" in new) and old.get("not") != new.get("not"):
            self.add("breaking", f"{ptr}/not", "'not' subschema changed (review manually)")

    def _compare_defs(self, old: Mapping[str, Any], new: Mapping[str, Any], ptr: str) -> None:
        for key in ("$defs", "definitions"):
            od, nd = old.get(key, {}), new.get(key, {})
            for name in sorted(set(od) & set(nd)):
                self.compare(od[name], nd[name], f"{ptr}/{key}/{name}")
            for name in sorted(set(od) - set(nd)):
                self.add("breaking", f"{ptr}/{key}/{name}", "definition removed (other schemas may $ref it)")
            for name in sorted(set(nd) - set(od)):
                self.add("minor", f"{ptr}/{key}/{name}", "definition added")

    def _compare_items(self, old: Mapping[str, Any], new: Mapping[str, Any], ptr: str) -> None:
        if "items" in old or "items" in new:
            self.compare(old.get("items", True), new.get("items", True), f"{ptr}/items")
        if "contains" in old or "contains" in new:
            self.compare(old.get("contains", True), new.get("contains", True), f"{ptr}/contains")
        op, np_ = old.get("prefixItems", []), new.get("prefixItems", [])
        for i in range(max(len(op), len(np_))):
            if i >= len(np_):
                self.add("forward", f"{ptr}/prefixItems/{i}", "positional item removed")
            elif i >= len(op):
                self.add("breaking", f"{ptr}/prefixItems/{i}", "positional item added")
            else:
                self.compare(op[i], np_[i], f"{ptr}/prefixItems/{i}")

    @staticmethod
    def _branch_key(branch: Any, prop: str | None) -> str | None:
        if not isinstance(branch, dict) or prop is None:
            return None
        const = branch.get("properties", {}).get(prop, {})
        if isinstance(const, dict) and "const" in const:
            return str(const["const"])
        return None

    def _discriminator(self, node: Mapping[str, Any]) -> str | None:
        disc = node.get("discriminator")
        if isinstance(disc, dict) and isinstance(disc.get("propertyName"), str):
            return str(disc["propertyName"])
        branches = node.get("oneOf", [])
        if not branches:
            return None
        common: set[str] | None = None
        for b in branches:
            props = {k for k, v in (b.get("properties", {}) if isinstance(b, dict) else {}).items() if "const" in v}
            common = props if common is None else common & props
        return sorted(common)[0] if common else None

    def _compare_composition(self, old: Mapping[str, Any], new: Mapping[str, Any], ptr: str) -> None:
        # allOf: more members = narrower; anyOf: more members = wider.
        for key, grow, shrink in (("allOf", "breaking", "forward"), ("anyOf", "forward", "breaking")):
            ol, nl = old.get(key, []), new.get(key, [])
            for i in range(max(len(ol), len(nl))):
                if i >= len(nl):
                    self.add(shrink, f"{ptr}/{key}/{i}", f"{key} member removed")
                elif i >= len(ol):
                    self.add(grow, f"{ptr}/{key}/{i}", f"{key} member added")
                else:
                    self.compare(ol[i], nl[i], f"{ptr}/{key}/{i}")
        ol, nl = old.get("oneOf", []), new.get("oneOf", [])
        if not ol and not nl:
            return
        prop = self._discriminator(new) or self._discriminator(old)
        okeys = [self._branch_key(b, prop) for b in ol]
        nkeys = [self._branch_key(b, prop) for b in nl]
        if prop and None not in okeys and None not in nkeys:
            om = {str(k): b for k, b in zip(okeys, ol, strict=True)}
            nm = {str(k): b for k, b in zip(nkeys, nl, strict=True)}
            for k in sorted(set(om) - set(nm)):
                self.add("breaking", f"{ptr}/oneOf[{prop}={k}]", "union branch removed")
            for k in sorted(set(nm) - set(om)):
                self.add("forward", f"{ptr}/oneOf[{prop}={k}]", "union branch added")
            for k in sorted(set(om) & set(nm)):
                self.compare(om[k], nm[k], f"{ptr}/oneOf[{prop}={k}]")
            return
        for i in range(max(len(ol), len(nl))):
            if i >= len(nl):
                self.add("breaking", f"{ptr}/oneOf/{i}", "oneOf member removed")
            elif i >= len(ol):
                self.add("forward", f"{ptr}/oneOf/{i}", "oneOf member added")
            else:
                self.compare(ol[i], nl[i], f"{ptr}/oneOf/{i}")


# ----------------------------------------------------------------------------- files


def load_dir(path: Path) -> dict[str, Any]:
    if not path.is_dir():
        return {}
    return {p.name: json.loads(p.read_text(encoding="utf-8")) for p in sorted(path.glob("*.schema.json"))}


def compare_dirs(base: Path, head: Path, migrations: Path) -> list[Change]:
    old, new = load_dir(base), load_dir(head)
    changes: list[Change] = []
    parsed_new = {name: FILE_RE.match(name) for name in new}
    for name in sorted(set(old) & set(new)):
        c = Comparer(name)
        c.compare(old[name], new[name])
        changes.extend(c.changes)
    for name in sorted(set(old) - set(new)):
        m = FILE_RE.match(name)
        successor = None
        if m:
            successor = next(
                (
                    n
                    for n, pm in parsed_new.items()
                    if pm and pm.group("stem") == m.group("stem") and int(pm.group("major")) > int(m.group("major"))
                ),
                None,
            )
        if successor and (migrations / f"{Path(successor).name.removesuffix('.schema.json')}.md").is_file():
            changes.append(Change("minor", name, "#", f"retired in favour of {successor} (migration notes present)"))
        else:
            changes.append(Change("breaking", name, "#", "schema file removed without a newer major + migration notes"))
    old_stems = {m.group("stem") for m in (FILE_RE.match(o) for o in old) if m}
    for name in sorted(set(new) - set(old)):
        m = parsed_new[name]
        if m is None:
            changes.append(Change("breaking", name, "#", "file name does not follow <name>.v<major>.schema.json"))
            continue
        stem, major = m.group("stem"), int(m.group("major"))
        if major == 1 and stem not in old_stems:
            changes.append(Change("minor", name, "#", "new contract added"))
            continue
        note = migrations / f"{stem}.v{major}.md"
        if note.is_file() and note.read_text(encoding="utf-8").strip():
            changes.append(Change("minor", name, "#", f"new major version with migration notes ({note.name})"))
        else:
            changes.append(
                Change("breaking", name, "#", f"new major version needs migration notes at {note.as_posix()}")
            )
    return changes


def render_markdown(changes: Sequence[Change], fail_on: str) -> str:
    worst = max((SEVERITY_ORDER[c.severity] for c in changes), default=-1)
    failed = worst >= SEVERITY_ORDER[fail_on]
    counts = {s: sum(1 for c in changes if c.severity == s) for s in SEVERITY_ORDER}
    lines = [
        "## Contract compatibility",
        "",
        f"**{'FAIL' if failed else 'PASS'}** (fail on: {fail_on}) - "
        + ", ".join(f"{n} {s}" for s, n in sorted(counts.items(), key=lambda kv: -SEVERITY_ORDER[kv[0]])),
        "",
    ]
    if changes:
        lines += ["| Severity | Schema | Pointer | Change |", "|---|---|---|---|"]
        for c in sorted(changes, key=lambda c: (-SEVERITY_ORDER[c.severity], c.schema, c.pointer)):
            lines.append(f"| {c.severity} | {c.schema} | `{c.pointer}` | {c.message} |")
    else:
        lines.append("No contract changes.")
    if counts["breaking"]:
        lines += [
            "",
            "Breaking changes need a new major schema file (`<name>.v<N+1>.schema.json`), a backend upcaster and "
            "migration notes (`contracts/migrations/<name>.v<N+1>.md`).",
        ]
    if counts["forward"]:
        lines += [
            "",
            "Forward changes are allowed in a minor release, but the backend must deploy first: old strict readers "
            "reject the new values.",
        ]
    return "\n".join(lines) + "\n"


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="schema-compat", description=__doc__.split("\n\n", 1)[0])
    parser.add_argument("--base", type=Path, required=True, help="schema directory of the base revision")
    parser.add_argument("--head", type=Path, required=True, help="schema directory of the head revision")
    parser.add_argument(
        "--migrations", type=Path, help="migration notes directory (default: <head>/../migrations)", default=None
    )
    parser.add_argument("--fail-on", choices=tuple(SEVERITY_ORDER), default="breaking")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--out", type=Path, help="also write the Markdown report here")
    args = parser.parse_args(list(argv) if argv is not None else None)
    if not args.head.is_dir():
        sys.stderr.write(f"schema-compat: head directory {args.head} does not exist\n")
        return 2
    migrations = args.migrations or args.head.parent / "migrations"
    changes = compare_dirs(args.base, args.head, migrations)
    failed = any(SEVERITY_ORDER[c.severity] >= SEVERITY_ORDER[args.fail_on] for c in changes)
    report = render_markdown(changes, args.fail_on)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(report, encoding="utf-8")
    if args.json:
        sys.stdout.write(json.dumps({"ok": not failed, "changes": [asdict(c) for c in changes]}, indent=2) + "\n")
    else:
        sys.stdout.write(report)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
