"""Static consistency checks for infra/kiosk-image and infra/pki (no snapcraft / step-ca needed)."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from shriii_provision import device_config as dc


def _render(text: str, values: dict[str, str]) -> str:
    return re.sub(r"\$\{([A-Z_]+)\}", lambda m: values.get(m.group(1), m.group(0)), text)


@pytest.fixture
def image(repo_root: Path) -> Path:
    return repo_root / "infra/kiosk-image"


@pytest.fixture
def pki(repo_root: Path) -> Path:
    return repo_root / "infra/pki"


def test_ca_json_template_renders_to_valid_policy(pki: Path) -> None:
    text = (pki / "step-ca/ca.json.tmpl").read_text()
    rendered = _render(
        text,
        {
            "CA_DIR": "/ca",
            "INTERMEDIATE_KEY": "awskms:key-id=abc",
            "CA_ADDRESS": ":9000",
            "CA_DNS": "ca.shriii.internal",
            "DEVICE_DOMAIN": "shriii.internal",
            "PROVISIONER_ENCRYPTED_KEY": "eyJ.x.y.z.w",
        },
    )
    assert "${" not in rendered
    ca = json.loads(rendered)
    [prov] = ca["authority"]["provisioners"]
    assert prov["type"] == "JWK"
    assert prov["name"] == "kiosk-enrolment"
    assert prov["claims"]["maxTLSCertDuration"] == "24h"
    assert prov["claims"]["allowRenewalAfterExpiry"] is True  # offline-first kiosks
    assert ca["authority"]["claims"]["allowRenewalAfterExpiry"] is False
    assert ca["authority"]["enableAdmin"] is False
    assert ca["crl"]["enabled"] and ca["crl"]["generateOnRevoke"]
    assert ca["tls"]["minVersion"] >= 1.2


def test_device_leaf_template_is_client_auth_only(pki: Path) -> None:
    tpl = (pki / "step-ca/templates/device-leaf.tpl").read_text()
    assert '"extKeyUsage": ["clientAuth"]' in tpl
    assert '"isCA": false' in tpl
    assert "serverAuth" not in tpl
    # The template enforces the same kiosk id rule as the API and the CLI.
    assert dc.KIOSK_ID_RE.pattern in tpl
    assert "spiffe://${DEVICE_DOMAIN}/kiosk/%s" in tpl


def test_intermediate_is_name_constrained(pki: Path) -> None:
    tpl = (pki / "step-ca/templates/intermediate-ca.tpl").read_text()
    assert '"maxPathLen": 0' in tpl
    assert '"critical": true' in tpl
    assert ".kiosk.${DEVICE_DOMAIN}" in tpl


def test_snapcraft_declares_every_plug_the_gadget_connects(image: Path) -> None:
    snapcraft = (image / "app/snap/snapcraft.yaml").read_text()
    gadget = (image / "gadget/gadget.yaml.in").read_text()
    connected = set(re.findall(r"plug: \$\{KIOSK_SNAP_ID\}:([a-z0-9-]+)", gadget))
    assert connected >= {"wayland", "audio-playback", "escpos-printer", "firewall-control", "snapd-control"}
    for plug in connected:
        assert re.search(rf"^\s+- {plug}$|^  {plug}:$", snapcraft, re.M), f"snapcraft.yaml does not plug {plug}"


def test_snapcraft_is_strict_core24_daemon(image: Path) -> None:
    snapcraft = (image / "app/snap/snapcraft.yaml").read_text()
    assert re.search(r"^confinement: strict$", snapcraft, re.M)
    assert re.search(r"^base: core24$", snapcraft, re.M)
    assert re.search(r"^name: shriii-kiosk$", snapcraft, re.M)
    assert "daemon: simple" in snapcraft
    assert "camera" not in snapcraft  # no camera interface, ever (PRV, §1.4)
    assert "audio-record" not in snapcraft  # microphone arrives with VOX-04 only
    assert "home\n" not in snapcraft.split("step:")[0]  # the kiosk app has no home access


def test_gadget_lockdown_defaults(image: Path) -> None:
    gadget = (image / "gadget/gadget.yaml.in").read_text()
    assert re.search(r"console-conf:\n\s+disable: true", gadget)
    assert "runtime-timeout:" in gadget
    assert "power-key-action: ignore" in gadget
    assert "modprobe.blacklist=usb_storage,uas" in gadget
    cmdline = (image / "gadget/cmdline/cmdline.extra").read_text()
    assert "systemd.getty_auto=0" in cmdline


def test_snap_scripts_use_the_cli_device_layout(image: Path) -> None:
    lib = (image / "app/src/share/lib.sh").read_text()
    for name, rel in {
        "CONFIG_FILE": dc.CONFIG_FILE,
        "RECIPIENT_KEYS_FILE": dc.RECIPIENT_KEYS_FILE,
        "DEVICE_RECORD_FILE": dc.DEVICE_RECORD_FILE,
        "TOKEN_FILE": dc.TOKEN_FILE,
    }.items():
        assert f'{name}="$SHRIII_ROOT/{rel}"' in lib
    for name, rel in {"KEY_FILE": dc.KEY_FILE, "CERT_FILE": dc.CERT_FILE, "ROOT_FILE": dc.ROOT_FILE}.items():
        assert f'{name}="$TLS_DIR/{Path(rel).name}"' in lib
    enrol = (image / "app/src/bin/kiosk-enrol").read_text()
    assert 'SCHEMA="shriii.enrolment-bundle/v1"' in enrol


def test_scripts_are_lf_and_have_shebangs(image: Path, pki: Path) -> None:
    scripts = [
        *sorted((image / "app/src/bin").iterdir()),
        *sorted((image / "app/snap/hooks").iterdir()),
        *sorted((image / "gadget/snap/hooks").iterdir()),
        *sorted((image / "scripts").glob("*.sh")),
        *sorted((pki / "scripts").glob("*.sh")),
    ]
    assert scripts
    for script in scripts:
        data = script.read_bytes()
        assert data.startswith(b"#!/bin/sh"), script
        assert b"\r\n" not in data, f"{script} has CRLF line endings"
