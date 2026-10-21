"""Deterministic JSON Schema (restricted 2020-12 profile) -> Pydantic v2 code generator.

The canonical contracts live in ``packages/contracts/schemas``. This module turns them into
``shriii_contracts/_generated.py``. It supports exactly the keyword subset allowed by the
profile linter (PLT-02): ``type`` (incl. ``[T, "null"]``), ``enum``, ``const``, ``pattern``,
``minLength``/``maxLength``, ``minimum``/``maximum``, ``format`` (``date-time``, ``date``,
``uuid``), ``items``/``minItems``/``maxItems``/``uniqueItems``, ``properties``/``required``/
``additionalProperties``, local and cross-file ``$ref``, ``anyOf`` with ``null``, a single-``$ref``
``allOf`` and ``oneOf`` with a ``discriminator``.

Run ``python python/shriii_contracts/src/shriii_contracts/codegen.py`` (or ``-m shriii_contracts.codegen``)
to regenerate; ``--check`` fails on drift.
"""

from __future__ import annotations

import json
import keyword
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


def schemas_dir() -> Path:
    """Canonical schema directory (standalone: codegen must not import the package it generates)."""
    env = os.environ.get("SHRIII_SCHEMAS_DIR")
    if env:
        return Path(env).resolve()
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "packages" / "contracts" / "schemas"
        if candidate.is_dir():
            return candidate
    raise FileNotFoundError("cannot locate packages/contracts/schemas; set SHRIII_SCHEMAS_DIR")


JsonObj = dict[str, Any]
BASE = "https://shriii.local/contracts/"

_BASEMODEL_ATTRS = frozenset(dir(__import__("pydantic").BaseModel))


def _pascal(s: str) -> str:
    return "".join(p[:1].upper() + p[1:] for p in re.split(r"[^A-Za-z0-9]+", s) if p)


def _file_key(file: str) -> str:
    return file.removesuffix(".v1.schema.json")


@dataclass
class _ClassDef:
    name: str
    doc: str
    fields: list[tuple[str, str, bool]]  # (name, type expr, required)
    base: str = "ContractModel"
    deps: set[str] = field(default_factory=set)


@dataclass
class _Gen:
    schemas: dict[str, JsonObj]
    aliases: dict[str, str] = field(default_factory=dict)  # name -> type expr
    alias_order: list[str] = field(default_factory=list)
    classes: dict[str, _ClassDef] = field(default_factory=dict)
    class_signatures: dict[str, str] = field(default_factory=dict)
    class_order: list[str] = field(default_factory=list)
    unions: dict[str, str] = field(default_factory=dict)
    union_order: list[str] = field(default_factory=list)
    ref_names: dict[tuple[str, str], str] = field(default_factory=dict)
    in_progress: set[tuple[str, str]] = field(default_factory=set)

    # ------------------------------------------------------------------ refs
    def _resolve_ref(self, ref: str, file: str) -> tuple[str, str]:
        target, _, pointer = ref.partition("#")
        target_file = target or file
        if target_file not in self.schemas:
            raise ValueError(f"{file}: unresolved $ref {ref}")
        return target_file, pointer

    def _node(self, file: str, pointer: str) -> JsonObj:
        node: Any = self.schemas[file]
        for part in [p for p in pointer.split("/") if p]:
            node = node[part]
        if not isinstance(node, dict):
            raise ValueError(f"{file}#{pointer} is not an object")
        return node

    def name_for(self, file: str, pointer: str) -> str:
        key = (file, pointer)
        if key in self.ref_names:
            return self.ref_names[key]
        node = self._node(file, pointer)
        if pointer == "":
            name = str(node.get("title") or _pascal(_file_key(file)))
        else:
            last = pointer.rsplit("/", maxsplit=1)[-1]
            name = str(node.get("title") or _pascal(last))
        if name in self.ref_names.values():
            name = _pascal(_file_key(file)) + name
        self.ref_names[key] = name
        if key in self.in_progress:
            return name
        self.in_progress.add(key)
        self._define(name, node, file)
        self.in_progress.discard(key)
        return name

    # ------------------------------------------------------------------ definitions
    def _define(self, name: str, node: JsonObj, file: str) -> None:
        if "oneOf" in node:
            self._define_union(name, node, file)
        elif node.get("type") == "object" and "properties" in node:
            self._define_class(name, node, file)
        else:
            expr = self.type_expr(node, file, name)
            if name in self.classes:
                raise ValueError(f"{file}: name collision between alias and model {name!r}")
            if name not in self.aliases:
                self.aliases[name] = expr
                self.alias_order.append(name)

    def _define_class(
        self, name: str, node: JsonObj, file: str, base: str = "ContractModel", overrides: JsonObj | None = None
    ) -> None:
        signature = json.dumps([node, overrides, base], sort_keys=True)
        if name in self.aliases:
            raise ValueError(f"{file}: name collision between alias and model {name!r}")
        if name in self.classes:
            if self.class_signatures.get(name) != signature:
                raise ValueError(f"{file}: two different object schemas are both titled {name!r}")
            return
        self.class_signatures[name] = signature
        cls = _ClassDef(name=name, doc=str(node.get("description") or node.get("title") or name), fields=[], base=base)
        self.classes[name] = cls  # reserve (recursion guard)
        props: JsonObj = dict(node.get("properties", {}))
        if overrides:
            props = overrides
        required = set(node.get("required", []))
        for pname, pschema in props.items():
            expr = self.type_expr(pschema, file, name + _pascal(pname))
            cls.fields.append((pname, expr, pname in required))
            cls.deps |= self._names_in(expr)
        self.class_order.append(name)

    def _define_union(self, name: str, node: JsonObj, file: str) -> None:
        disc = node.get("discriminator", {}).get("propertyName")
        if not isinstance(disc, str):
            raise ValueError(f"{file}: oneOf without discriminator at {name}")
        members: list[str] = []
        base_name: str | None = None
        all_of = node.get("allOf", [])
        if all_of:
            if len(all_of) != 1 or "$ref" not in all_of[0]:
                raise ValueError(f"{file}: unsupported allOf at {name}")
            bfile, bptr = self._resolve_ref(all_of[0]["$ref"], file)
            base_name = self.name_for(bfile, bptr)
        for branch in node["oneOf"]:
            if "$ref" in branch:
                bfile, bptr = self._resolve_ref(branch["$ref"], file)
                members.append(self.name_for(bfile, bptr))
                continue
            bname = str(branch.get("title") or f"{name}Variant{len(members)}")
            if base_name is None:
                self._define_class(bname, branch, file)
            else:
                base_cls = self.classes[base_name]
                base_props = {f: None for f, _, _ in base_cls.fields}
                overrides = {k: v for k, v in branch.get("properties", {}).items() if k in base_props}
                self._define_class(bname, {"required": list(overrides)}, file, base=base_name, overrides=overrides)
                self.classes[bname].deps.add(base_name)
            members.append(bname)
        expr = f"Annotated[{' | '.join(members)}, Field(discriminator={disc!r})]"
        self.unions[name] = expr
        self.union_order.append(name)

    @staticmethod
    def _names_in(expr: str) -> set[str]:
        return set(re.findall(r"\b([A-Z][A-Za-z0-9]+)\b", expr))

    # ------------------------------------------------------------------ type expressions
    def type_expr(self, s: JsonObj | bool, file: str, ctx: str) -> str:
        if s is True or s == {} or (isinstance(s, dict) and set(s) <= {"description", "title"}):
            return "Any"
        if s is False:
            raise ValueError("false schema not supported")
        assert isinstance(s, dict)
        if "$ref" in s:
            rfile, ptr = self._resolve_ref(s["$ref"], file)
            return self.name_for(rfile, ptr)
        if "allOf" in s and "oneOf" not in s:
            parts = s["allOf"]
            if len(parts) != 1:
                raise ValueError(f"{file}: allOf with {len(parts)} parts at {ctx}")
            return self.type_expr(parts[0], file, ctx)
        if "oneOf" in s:
            name = str(s.get("title") or ctx)
            self._define_union(name, s, file)
            return name
        if "anyOf" in s:
            opts = [o for o in s["anyOf"] if o != {"type": "null"}]
            has_null = len(opts) != len(s["anyOf"])
            inner = " | ".join(self.type_expr(o, file, ctx) for o in opts)
            return f"{inner} | None" if has_null else inner
        if "const" in s:
            return f"Literal[{s['const']!r}]"
        t = s.get("type")
        if isinstance(t, list):
            non_null = [x for x in t if x != "null"]
            nullable = "null" in t
            if len(non_null) == 1:
                sub = dict(s)
                sub["type"] = non_null[0]
                if "enum" in sub:
                    sub["enum"] = [v for v in sub["enum"] if v is not None]
                inner = self.type_expr(sub, file, ctx)
            else:
                inner = " | ".join(self._bare(x) for x in non_null)
            return f"{inner} | None" if nullable else inner
        if "enum" in s:
            return "Literal[" + ", ".join(repr(v) for v in s["enum"]) + "]"
        if t == "string":
            return self._string(s)
        if t == "integer":
            return self._numeric("int", s)
        if t == "number":
            return self._numeric("float", s)
        if t == "boolean":
            return "bool"
        if t == "null":
            return "None"
        if t == "array":
            item = self.type_expr(s.get("items", True), file, ctx + "Item")
            cons = []
            if "minItems" in s:
                cons.append(f"min_length={s['minItems']}")
            if "maxItems" in s:
                cons.append(f"max_length={s['maxItems']}")
            meta = []
            if cons:
                meta.append(f"Field({', '.join(cons)})")
            if s.get("uniqueItems"):
                meta.append("AfterValidator(_unique)")
            return f"Annotated[list[{item}], {', '.join(meta)}]" if meta else f"list[{item}]"
        if t == "object":
            if "properties" in s:
                name = str(s.get("title") or ctx)
                self._define_class(name, s, file)
                return name
            ap = s.get("additionalProperties", True)
            if isinstance(ap, dict):
                return f"dict[str, {self.type_expr(ap, file, ctx + 'Value')}]"
            return "dict[str, Any]"
        raise ValueError(f"{file}: unsupported schema at {ctx}: {sorted(s)}")

    @staticmethod
    def _bare(t: str) -> str:
        return {
            "string": "str",
            "integer": "int",
            "number": "float",
            "boolean": "bool",
            "array": "list[Any]",
            "object": "dict[str, Any]",
        }[t]

    @staticmethod
    def _string(s: JsonObj) -> str:
        cons = []
        if "pattern" in s:
            cons.append(f"pattern={s['pattern']!r}")
        if "minLength" in s:
            cons.append(f"min_length={s['minLength']}")
        if "maxLength" in s:
            cons.append(f"max_length={s['maxLength']}")
        meta = []
        if cons:
            meta.append(f"StringConstraints({', '.join(cons)})")
        fmt = s.get("format")
        if fmt == "date-time":
            meta.append("AfterValidator(_check_date_time)")
        elif fmt == "date":
            meta.append("AfterValidator(_check_date)")
        elif fmt == "uuid":
            meta.append("AfterValidator(_check_uuid)")
        elif fmt is not None:
            raise ValueError(f"unsupported format {fmt}")
        return f"Annotated[str, {', '.join(meta)}]" if meta else "str"

    @staticmethod
    def _numeric(py: str, s: JsonObj) -> str:
        cons = []
        if "minimum" in s:
            cons.append(f"ge={s['minimum']!r}")
        if "maximum" in s:
            cons.append(f"le={s['maximum']!r}")
        if py == "float":
            cons.append("allow_inf_nan=False")
            base = "StrictFloatOrInt"
        else:
            base = "int"
        return f"Annotated[{base}, Field({', '.join(cons)})]" if cons else base

    # ------------------------------------------------------------------ rendering
    def render(self) -> str:
        out: list[str] = [HEADER]
        out.append("# ---------------------------------------------------------------- scalar aliases\n")
        for name in self.alias_order:
            out.append(f"{name} = {self.aliases[name]}\n")
        out.append("\n# ---------------------------------------------------------------- models\n")
        emitted: set[str] = set()
        order: list[str] = []

        def visit(n: str, stack: tuple[str, ...] = ()) -> None:
            if n in emitted or n in stack or n not in self.classes:
                return
            cls = self.classes[n]
            deps = sorted(cls.deps | {cls.base})
            for d in deps:
                visit(d, (*stack, n))
            emitted.add(n)
            order.append(n)

        for n in self.class_order:
            visit(n)
        for n in order:
            cls = self.classes[n]
            out.append(f"\nclass {n}({cls.base}):")
            doc = cls.doc.replace('"""', "'''").replace("\\", "\\\\")
            out.append(f'    """{doc}"""\n')
            if not cls.fields:
                out.append("    pass\n")
            for fname, expr, required in cls.fields:
                if keyword.iskeyword(fname) or fname in _BASEMODEL_ATTRS:
                    # Shadows a BaseModel attribute (e.g. ``construct``): use an aliased attribute name.
                    if required:
                        out.append(f"    {fname}_: {expr} = Field(alias={fname!r})")
                    else:
                        out.append(f"    {fname}_: {expr} | None = Field(default=None, alias={fname!r})")
                elif required:
                    out.append(f"    {fname}: {expr}")
                else:
                    out.append(f"    {fname}: {expr} | None = None")
            out.append("")
            # unions whose members are now all defined are emitted right after
        out.append("\n# ---------------------------------------------------------------- discriminated unions\n")
        for name in self.union_order:
            out.append(f"{name} = {self.unions[name]}\n")
        names = sorted({*self.alias_order, *order, *self.union_order})
        out.append("\n__all__ = [")
        out.extend(f"    {n!r}," for n in names)
        out.append("]\n")
        out.append("\n# ---------------------------------------------------------------- rebuild forward refs\n")
        out.append("for _model in list(globals().values()):")
        out.append(
            "    if isinstance(_model, type) and issubclass(_model, ContractModel) and _model is not ContractModel:"
        )
        out.append("        _model.model_rebuild(_types_namespace=globals())\n")
        return "\n".join(out).rstrip() + "\n"


HEADER = '''# ruff: noqa: E501, UP040, N815, RUF001
# mypy: disable-error-code="valid-type,assignment,misc"
"""GENERATED by shriii_contracts.codegen from packages/contracts/schemas. Do not edit by hand.

Regenerate with ``uv run python -m shriii_contracts.codegen``.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import AfterValidator, Field, StringConstraints

from shriii_contracts._base import (
    ContractModel,
    StrictFloatOrInt,
    _check_date,
    _check_date_time,
    _check_uuid,
    _unique,
)

'''


def generate() -> str:
    directory = schemas_dir()
    schemas = {p.name: json.loads(p.read_text(encoding="utf-8")) for p in sorted(directory.glob("*.schema.json"))}
    gen = _Gen(schemas=schemas)
    # Common defs first so aliases keep stable names, then every other file's root and defs.
    files = sorted(schemas, key=lambda f: (f != "common.v1.schema.json", f))
    for file in files:
        for def_name in sorted(schemas[file].get("$defs", {})):
            gen.name_for(file, f"/$defs/{def_name}")
        if file != "common.v1.schema.json":
            gen.name_for(file, "")
    return gen.render()


def target_path() -> Path:
    return Path(__file__).with_name("_generated.py")


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    code = generate()
    path = target_path()
    if "--check" in args:
        current = path.read_text(encoding="utf-8") if path.exists() else ""
        if current != code:
            print(
                "shriii_contracts/_generated.py is out of date; run python -m shriii_contracts.codegen", file=sys.stderr
            )
            return 1
        print("shriii_contracts: generated models are up to date")
        return 0
    path.write_text(code, encoding="utf-8", newline="\n")
    print(f"wrote {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
