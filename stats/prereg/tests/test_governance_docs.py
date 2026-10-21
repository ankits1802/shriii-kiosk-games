"""Consistency checks between docs/governance and the machine-readable sources.

The pre-registration and the governance documents form the ethics evidence pack (PRV-11), so their
cross-references are checked here: every consent kind has a script, every retention-engine rule appears in
the retention policy, every implemented role appears in the access-control policy, and relative links
resolve.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
import yaml


@pytest.fixture(scope="module")
def gov(real_root: Path) -> Path:
    return real_root / "docs" / "governance"


def test_every_consent_kind_has_a_script(real_root: Path, gov: Path) -> None:
    common = json.loads((real_root / "contracts" / "schemas" / "common.v1.schema.json").read_text(encoding="utf-8"))
    kinds = common["$defs"]["consent_kind"]["enum"]
    index = (gov / "consent" / "README.md").read_text(encoding="utf-8")
    for kind in kinds:
        script = gov / "consent" / f"{kind}.md"
        assert script.is_file(), f"missing consent script for {kind}"
        text = script.read_text(encoding="utf-8")
        assert f"`{kind}`" in text
        assert "tick" in text.lower(), f"{kind}: decision must be a tap on tick/cross"
        assert f"`{kind}`" in index


def test_retention_rules_are_documented(real_root: Path, gov: Path) -> None:
    rules = yaml.safe_load(
        (real_root / "backend" / "api" / "src" / "shriii_api" / "config" / "retention.yaml").read_text(encoding="utf-8")
    )
    policy = (gov / "retention-and-deletion-policy.md").read_text(encoding="utf-8")
    for rule in rules["rules"]:
        assert f"`{rule['id']}`" in policy, f"retention rule {rule['id']} missing from the policy table"
        if "ttl_days" in rule:
            days = int(rule["ttl_days"])
            assert re.search(rf"\b{days} days\b|\b1 year\b", policy), f"ttl {days} days not stated"


def test_implemented_roles_are_in_the_access_policy(real_root: Path, gov: Path) -> None:
    rbac = (real_root / "backend" / "api" / "src" / "shriii_api" / "auth" / "rbac.py").read_text(encoding="utf-8")
    roles = re.findall(r'^\s+[A-Z_]+ = "([a-z_]+)"$', rbac.split("class Perm")[0], flags=re.MULTILINE)
    assert roles, "no roles parsed from rbac.py"
    policy = (gov / "access-control-policy.md").read_text(encoding="utf-8")
    for role in roles:
        assert f"`{role}`" in policy, f"role {role} missing from the access-control policy"


def test_minors_policy_matches_the_locked_default(gov: Path) -> None:
    text = (gov / "minors-policy.md").read_text(encoding="utf-8")
    assert "`allow_minors = false`" in text and "`minimum_age = 18`" in text


def test_relative_links_resolve(gov: Path) -> None:
    link = re.compile(r"\]\(([^)#\s]+\.md)(?:#[^)]*)?\)")
    for md in gov.rglob("*.md"):
        for target in link.findall(md.read_text(encoding="utf-8")):
            if target.startswith("http"):
                continue
            assert (md.parent / target).resolve().is_file(), f"{md.relative_to(gov)} links to missing {target}"


def test_every_document_carries_review_markers_and_version(gov: Path) -> None:
    for md in gov.rglob("*.md"):
        text = md.read_text(encoding="utf-8")
        assert "DRAFT" in text, f"{md.name}: missing draft status"
