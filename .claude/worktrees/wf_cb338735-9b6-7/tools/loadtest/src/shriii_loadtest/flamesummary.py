"""Summarise py-spy collapsed stacks (``py-spy record --format raw``) into self/inclusive time tables.

    python -m shriii_loadtest.flamesummary profile.collapsed.txt --top 25 [--filter shriii_api]

Each input line is ``frame;frame;...;leaf count``. "Self" counts samples where the function is the leaf;
"inclusive" counts samples where it appears anywhere in the stack (once per sample).
"""

from __future__ import annotations

import argparse
import re
from collections import Counter
from pathlib import Path

_FRAME = re.compile(r"^(?P<func>.+?) \((?P<file>.+?)(?::\d+)?\)$")


def _short(frame: str) -> str:
    m = _FRAME.match(frame.strip())
    if not m:
        return frame.strip()
    file = m.group("file").replace("\\", "/")
    parts = file.split("/")
    for anchor in ("site-packages", "src", "Lib"):
        if anchor in parts:
            parts = parts[parts.index(anchor) + 1 :]
            break
    return f"{m.group('func')} ({'/'.join(parts[-3:])})"


def summarise(lines: list[str]) -> tuple[int, Counter[str], Counter[str]]:
    total = 0
    self_c: Counter[str] = Counter()
    incl: Counter[str] = Counter()
    for line in lines:
        line = line.rstrip()
        if not line:
            continue
        stack, _, count_s = line.rpartition(" ")
        try:
            count = int(count_s)
        except ValueError:
            continue
        frames = [_short(f) for f in stack.split(";") if f]
        if not frames:
            continue
        total += count
        self_c[frames[-1]] += count
        for f in set(frames):
            incl[f] += count
    return total, self_c, incl


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("path", type=Path)
    parser.add_argument("--top", type=int, default=25)
    parser.add_argument("--filter", default=None, help="only show inclusive rows containing this text")
    args = parser.parse_args(argv)
    total, self_c, incl = summarise(args.path.read_text(encoding="utf-8", errors="replace").splitlines())
    print(f"samples: {total}")
    print("\n## self (leaf) time")
    for name, n in self_c.most_common(args.top):
        print(f"{100 * n / total:5.1f}%  {name}")
    print("\n## inclusive time")
    rows = [(k, v) for k, v in incl.most_common() if not args.filter or args.filter in k]
    for name, n in rows[: args.top]:
        print(f"{100 * n / total:5.1f}%  {name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
