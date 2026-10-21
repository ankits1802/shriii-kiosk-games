"""Player-report policy (``config/report_policy.yaml``): constructs withheld from every player report.

The policy only ever withholds. It is enforced twice (defence in depth): the server-side report gate
suppresses withheld traits, and release packs leave their phrases out of the allowlist so a kiosk cannot
render them either.
"""

from __future__ import annotations

from functools import lru_cache
from importlib import resources
from typing import Any

import yaml

from shriii_api.canonical import sha256_hex

POLICY_FILE = "report_policy.yaml"


@lru_cache(maxsize=1)
def report_policy() -> tuple[dict[str, Any], str]:
    """The parsed policy and its SHA-256."""
    raw = resources.files("shriii_api.config").joinpath(POLICY_FILE).read_bytes()
    data = yaml.safe_load(raw.decode("utf-8"))
    if not isinstance(data, dict) or data.get("schema") != "shriii-report-policy":
        raise ValueError(f"{POLICY_FILE} is not a shriii-report-policy document")
    for entry in data.get("withhold_from_player_report", []):
        if not entry.get("construct") or not entry.get("reason"):
            raise ValueError(f"{POLICY_FILE}: every withhold entry needs a construct and a reason")
    return data, sha256_hex(raw)


def withheld_reason(trait: str, pathway: str | None) -> str | None:
    """Why ``trait`` is withheld from player reports for ``pathway`` (None when it is not withheld)."""
    data, _ = report_policy()
    for entry in data.get("withhold_from_player_report", []):
        if entry["construct"] == trait and str(entry.get("pathway", "*")) in ("*", str(pathway)):
            return str(entry["reason"])
    return None


def withheld_constructs() -> list[str]:
    data, _ = report_policy()
    return sorted({str(e["construct"]) for e in data.get("withhold_from_player_report", [])})
