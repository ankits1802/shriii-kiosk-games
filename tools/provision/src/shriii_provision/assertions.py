"""Ubuntu Core model and validation-set assertions (KSK-09, KSK-11).

Templates live in ``infra/kiosk-image/model``. They contain ``${NAME}`` placeholders for values that are
account-specific or secret-adjacent (brand account id, snap ids from the brand store). CI renders them from
repository variables and validates them; signing (``snap sign -k <key>``) happens only in the release job
with the signing key from secrets.

Wave freeze: the model lists the ``shriii-wave-freeze`` validation set with ``mode: enforce`` and no pinned
sequence, so each new sequence published by the brand pins the exact revisions every kiosk may run. The
app, Frame and the base cannot drift inside a frozen wave (KSK-11, T1/T2 retest inside one wave).
"""

from __future__ import annotations

import re
from collections import Counter
from datetime import UTC, datetime
from typing import Any

from shriii_provision import ProvisionError

PLACEHOLDER_RE = re.compile(r"\$\{([A-Z][A-Z0-9_]*)\}")
SNAP_ID_RE = re.compile(r"^[A-Za-z0-9]{32}$")
NAME_RE = re.compile(r"^[a-z0-9](?:-?[a-z0-9])*$")
MODEL_RE = re.compile(r"^[a-zA-Z0-9](?:-?[a-zA-Z0-9])*$")
ACCOUNT_RE = re.compile(r"^(?:[a-z0-9-]{2,28}|[A-Za-z0-9]{32})$")
CHANNEL_RE = re.compile(r"^(?:[0-9a-z.-]+/)?(?:stable|candidate|beta|edge)(?:/[a-z0-9-]+)?$")

REQUIRED_APP_SNAPS = ("ubuntu-frame", "shriii-kiosk", "pipewire", "mesa-2404")
# Anything that would bring a desktop, a shell or a second display server onto the kiosk.
FORBIDDEN_SNAPS = ("ubuntu-desktop-session", "gnome-shell", "ubuntu-desktop-installer", "lxd", "docker", "x11-kiosk")
SNAP_TYPES = ("gadget", "kernel", "base", "snapd", "app", "core")
WAVE_FREEZE_SET = "shriii-wave-freeze"


def render(template: Any, variables: dict[str, str]) -> Any:
    """Substitute ``${NAME}`` in every string of a JSON value; unknown placeholders are left in place."""
    if isinstance(template, str):
        return PLACEHOLDER_RE.sub(lambda m: variables.get(m.group(1), m.group(0)), template)
    if isinstance(template, list):
        return [render(v, variables) for v in template]
    if isinstance(template, dict):
        return {render(k, variables): render(v, variables) for k, v in template.items()}
    return template


def placeholders(value: Any) -> set[str]:
    found: set[str] = set()
    if isinstance(value, str):
        found.update(PLACEHOLDER_RE.findall(value))
    elif isinstance(value, list):
        for v in value:
            found |= placeholders(v)
    elif isinstance(value, dict):
        for k, v in value.items():
            found |= placeholders(k) | placeholders(v)
    return found


def _is_rfc3339(text: Any) -> bool:
    if not isinstance(text, str):
        return False
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return False
    return parsed.tzinfo is not None


def validate_model(model: Any, *, allow_placeholders: bool = False, require_production: bool = False) -> list[str]:
    """Return a list of problems (empty = valid). ``allow_placeholders`` skips id/account format checks."""
    problems: list[str] = []
    if not isinstance(model, dict):
        return ["model must be a JSON object"]
    left = placeholders(model)
    if left and not allow_placeholders:
        problems.append(f"unresolved placeholders: {', '.join(sorted(left))}")

    def templated(value: Any) -> bool:
        return allow_placeholders and isinstance(value, str) and bool(PLACEHOLDER_RE.search(value))

    for key in ("type", "series", "authority-id", "brand-id", "model", "architecture", "base", "grade", "snaps"):
        if key not in model:
            problems.append(f"missing {key!r}")
    if problems and any(p.startswith("missing") for p in problems):
        return problems
    if model["type"] != "model":
        problems.append("type must be 'model'")
    if model["series"] != "16":
        problems.append("series must be the string '16'")
    for key in ("authority-id", "brand-id"):
        if not templated(model[key]) and not ACCOUNT_RE.fullmatch(str(model[key])):
            problems.append(f"{key} is not a valid account id")
    if model["authority-id"] != model["brand-id"]:
        problems.append("authority-id must equal brand-id (brand-signed model)")
    if not MODEL_RE.fullmatch(str(model["model"])):
        problems.append("model name is invalid")
    if model["architecture"] not in ("amd64", "arm64"):
        problems.append("architecture must be amd64 or arm64 (single reference SKU)")
    if model["base"] != "core24":
        problems.append("base must be core24 (Ubuntu Core 24)")
    grade = model["grade"]
    if grade not in ("dangerous", "signed", "secured"):
        problems.append("grade must be dangerous, signed or secured")
    if require_production and grade == "dangerous":
        problems.append("production models must not be grade dangerous")
    if model.get("storage-safety") != "encrypted":
        problems.append("storage-safety must be 'encrypted' (TPM-backed full-disk encryption, KSK-09)")
    if "timestamp" in model and not templated(model["timestamp"]) and not _is_rfc3339(model["timestamp"]):
        problems.append("timestamp must be RFC 3339 with a timezone")
    if "system-user-authority" in model:
        sua = model["system-user-authority"]
        if sua == "*":
            problems.append("system-user-authority '*' would accept any account's system-user assertions")

    snaps = model["snaps"]
    if not isinstance(snaps, list) or not snaps:
        problems.append("snaps must be a non-empty list")
        return problems
    names: list[str] = []
    types: Counter[str] = Counter()
    for i, snap in enumerate(snaps):
        where = f"snaps[{i}]"
        if not isinstance(snap, dict):
            problems.append(f"{where} must be an object")
            continue
        name = str(snap.get("name", ""))
        where = f"snaps[{i}] ({name or '?'})"
        if not NAME_RE.fullmatch(name):
            problems.append(f"{where}: invalid name")
        names.append(name)
        stype = snap.get("type", "app")
        if stype not in SNAP_TYPES:
            problems.append(f"{where}: unknown type {stype!r}")
        types[stype] += 1
        snap_id = snap.get("id")
        if grade != "dangerous" or snap_id is not None:
            if snap_id is None:
                problems.append(f"{where}: id is required for grade {grade}")
            elif not templated(snap_id) and not SNAP_ID_RE.fullmatch(str(snap_id)):
                problems.append(f"{where}: id must be 32 alphanumeric characters")
        channel = snap.get("default-channel")
        if channel is not None and not CHANNEL_RE.fullmatch(str(channel)):
            problems.append(f"{where}: default-channel {channel!r} is invalid")
        if snap.get("presence", "required") not in ("required", "optional"):
            problems.append(f"{where}: presence must be required or optional")
        if stype == "app" and name in REQUIRED_APP_SNAPS and snap.get("presence", "required") != "required":
            problems.append(f"{where}: must be required")
        if stype == "base" and name != model["base"] and name not in ("core22", "core24"):
            problems.append(f"{where}: unexpected base snap")
    for dup, count in Counter(names).items():
        if count > 1:
            problems.append(f"snap {dup!r} listed {count} times")
    for stype in ("gadget", "kernel", "snapd"):
        if types[stype] != 1:
            problems.append(f"exactly one {stype} snap is required (found {types[stype]})")
    if model["base"] not in names:
        problems.append(f"the base snap {model['base']!r} must be listed")
    for required in REQUIRED_APP_SNAPS:
        if required not in names:
            problems.append(f"required snap {required!r} is missing")
    for forbidden in FORBIDDEN_SNAPS:
        if forbidden in names:
            problems.append(f"snap {forbidden!r} is not allowed on a locked kiosk")

    sets = model.get("validation-sets", [])
    if not isinstance(sets, list):
        problems.append("validation-sets must be a list")
    else:
        freeze = [s for s in sets if isinstance(s, dict) and s.get("name") == WAVE_FREEZE_SET]
        if not freeze:
            problems.append(f"validation set {WAVE_FREEZE_SET!r} must be listed (wave freeze, KSK-11)")
        for s in sets:
            if not isinstance(s, dict) or s.get("mode") not in (
                "enforce",
                "prefer-enforce",
                "monitor",
                "prefer-monitor",
            ):
                problems.append(f"validation set {s!r}: invalid mode")
        for s in freeze:
            if s.get("mode") != "enforce":
                problems.append(f"{WAVE_FREEZE_SET} must be mode 'enforce'")
            if "sequence" in s:
                problems.append(f"{WAVE_FREEZE_SET} must not pin a sequence (each new sequence is a new wave)")
    return problems


def wave_freeze_assertion(
    *,
    account_id: str,
    sequence: int,
    snaps: list[dict[str, str]],
    timestamp: datetime | None = None,
    name: str = WAVE_FREEZE_SET,
) -> dict[str, Any]:
    """Build the validation-set assertion (unsigned JSON for ``snap sign``) that pins a wave's revisions.

    ``snaps`` items: ``{"name", "id", "revision"}``; each becomes ``presence: required`` at that revision.
    """
    if sequence < 1:
        raise ProvisionError("sequence must be >= 1")
    entries: list[dict[str, str]] = []
    for snap in snaps:
        name_ = snap.get("name", "")
        if not NAME_RE.fullmatch(name_):
            raise ProvisionError(f"invalid snap name {name_!r}")
        if not SNAP_ID_RE.fullmatch(snap.get("id", "")):
            raise ProvisionError(f"snap {name_}: id must be 32 alphanumeric characters")
        revision = str(snap.get("revision", ""))
        if not revision.isdigit() or int(revision) < 1:
            raise ProvisionError(f"snap {name_}: revision must be a positive integer")
        entries.append({"name": name_, "id": snap["id"], "presence": "required", "revision": revision})
    names = [e["name"] for e in entries]
    for required in ("shriii-kiosk", "ubuntu-frame"):
        if required not in names:
            raise ProvisionError(f"a wave freeze must pin {required}")
    if len(set(names)) != len(names):
        raise ProvisionError("a snap is pinned twice")
    stamp = (timestamp or datetime.now(UTC)).astimezone(UTC).replace(microsecond=0)
    return {
        "type": "validation-set",
        "authority-id": account_id,
        "account-id": account_id,
        "series": "16",
        "name": name,
        "sequence": str(sequence),
        "snaps": entries,
        "timestamp": stamp.isoformat().replace("+00:00", "Z"),
    }
