from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import httpx
import jwt
import pytest
from fakes import ADMIN_TOKEN, FakeApi, FakeCa

from shriii_provision import cli, flows
from shriii_provision import device_config as dc


@pytest.fixture
def wire(monkeypatch: pytest.MonkeyPatch, fake_api: FakeApi, fake_ca: FakeCa) -> None:
    """Route every httpx.Client the CLI creates to the fakes (by host)."""
    real_init = httpx.Client.__init__

    def init(self: httpx.Client, *args: Any, **kwargs: Any) -> None:
        base = str(kwargs.get("base_url", ""))
        kwargs.pop("verify", None)
        kwargs["transport"] = fake_ca.transport() if "ca.test" in base else fake_api.transport()
        real_init(self, *args, **kwargs)

    monkeypatch.setattr(httpx.Client, "__init__", init)


def _register_args(tmp_path: Path, fake_ca: FakeCa, *extra: str) -> list[str]:
    (tmp_path / "admin.token").write_text(ADMIN_TOKEN + "\n")
    (tmp_path / "prov.pem").write_bytes(fake_ca.provisioner_pem())
    (tmp_path / "root.crt").write_bytes(fake_ca.root_pem)
    return [
        "register",
        "--api", "https://api.test",
        "--admin-token-file", str(tmp_path / "admin.token"),
        "--kiosk-id", "kiosk-cli-001",
        "--site", "site-1",
        "--site-mode", "open_public",
        "--policy-version", "2026.10.1",
        "--app-version", "0.1.0",
        "--ca-url", fake_ca.url,
        "--provisioner-key", str(tmp_path / "prov.pem"),
        "--root-ca", str(tmp_path / "root.crt"),
        "--printer", "tcp://10.0.0.5:9100",
        "--update-ring", "canary",
        "--out", str(tmp_path / "bundle.json"),
        *extra,
    ]  # fmt: skip


@pytest.mark.usefixtures("wire")
def test_cli_register_enrol_verify(
    tmp_path: Path, fake_api: FakeApi, fake_ca: FakeCa, capsys: pytest.CaptureFixture[str]
) -> None:
    assert cli.main(_register_args(tmp_path, fake_ca)) == 0
    out = capsys.readouterr().out
    assert "registered kiosk-cli-001 at site-1 (open_public)" in out
    assert "kdt_" not in out  # the device token is never printed
    assert fake_api.deployments[0]["site_mode"] == "open_public"

    root = tmp_path / "device"
    assert cli.main(["enrol", "--bundle", str(tmp_path / "bundle.json"), "--root", str(root), "--delete-bundle"]) == 0
    assert not (tmp_path / "bundle.json").exists()
    config = json.loads((root / dc.CONFIG_FILE).read_text())
    assert config["printer"] == {"kind": "network", "host": "10.0.0.5", "port": 9100}
    assert config["update"] == {"ring": "canary"}

    assert cli.main(["verify", "--root", str(root), "--no-mtls", "--json"]) == 0
    checks = json.loads(capsys.readouterr().out.split("\n", 1)[1])
    assert {c["name"]: c["ok"] for c in checks} == {
        "config": True,
        "certificate": True,
        "api_health": True,
        "heartbeat": True,
    }


@pytest.mark.usefixtures("wire")
def test_cli_verify_fails_with_exit_1(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert cli.main(["verify", "--root", str(tmp_path), "--no-mtls"]) == 1
    assert "[FAIL] config" in capsys.readouterr().out


@pytest.mark.usefixtures("wire")
def test_cli_register_open_public_with_study_is_accepted(tmp_path: Path, fake_api: FakeApi, fake_ca: FakeCa) -> None:
    assert cli.main(_register_args(tmp_path, fake_ca, "--study", "s1")) == 0
    assert fake_api.deployments[0]["study_id"] == "s1"


def test_cli_register_rejects_http_api(tmp_path: Path, fake_ca: FakeCa, capsys: pytest.CaptureFixture[str]) -> None:
    args = _register_args(tmp_path, fake_ca)
    args[args.index("https://api.test")] = "http://api.test"
    assert cli.main(args) == 1
    assert "must use https" in capsys.readouterr().err


def test_cli_usage_error_exit_2() -> None:
    with pytest.raises(SystemExit) as exc:
        cli.main(["register", "--site-mode", "everywhere"])
    assert exc.value.code == 2


@pytest.mark.usefixtures("wire")
def test_cli_push_streams_bundle_over_ssh(
    tmp_path: Path, fake_ca: FakeCa, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    assert cli.main(_register_args(tmp_path, fake_ca)) == 0
    seen: dict[str, Any] = {}

    def fake_run(cmd: list[str], stdin: Any, check: bool) -> subprocess.CompletedProcess[bytes]:
        seen["cmd"] = cmd
        seen["stdin"] = stdin.read()
        return subprocess.CompletedProcess(cmd, 0)

    monkeypatch.setattr(subprocess, "run", fake_run)
    bundle = tmp_path / "bundle.json"
    assert cli.main(["push", "--bundle", str(bundle), "--host", "10.1.1.9", "--user", "tech"]) == 0
    assert seen["cmd"][:5] == ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes"]
    assert seen["cmd"][5] == "tech@10.1.1.9"
    remote = seen["cmd"][6]
    assert "/var/snap/shriii-kiosk/common/provision/bundle.json" in remote
    assert "snap restart shriii-kiosk.enrol" in remote
    assert "kdt_" not in " ".join(seen["cmd"])  # secrets travel on stdin, never argv
    assert seen["stdin"] == bundle.read_bytes()


@pytest.mark.usefixtures("wire")
def test_cli_push_refuses_expired_bundle(tmp_path: Path, fake_ca: FakeCa, capsys: pytest.CaptureFixture[str]) -> None:
    assert cli.main(_register_args(tmp_path, fake_ca)) == 0
    bundle = tmp_path / "bundle.json"
    data = json.loads(bundle.read_text())
    data["expires_at"] = "2020-01-01T00:00:00Z"
    flows.write_bundle(bundle, data)
    assert cli.main(["push", "--bundle", str(bundle), "--host", "h", "--dry-run"]) == 1
    assert "expired" in capsys.readouterr().err


def test_cli_token(tmp_path: Path, fake_ca: FakeCa, capsys: pytest.CaptureFixture[str]) -> None:
    (tmp_path / "prov.pem").write_bytes(fake_ca.provisioner_pem())
    args = ["token", "--ca-url", fake_ca.url, "--provisioner-key", str(tmp_path / "prov.pem"), "--subject", "k-1"]
    assert cli.main(args) == 0
    claims = jwt.decode(capsys.readouterr().out.strip(), options={"verify_signature": False})
    assert claims["sans"] == ["k-1.kiosk.shriii.internal", "spiffe://shriii.internal/kiosk/k-1"]
    assert cli.main([*args, "--revoke"]) == 0
    claims = jwt.decode(capsys.readouterr().out.strip(), options={"verify_signature": False})
    assert claims["aud"].endswith("/1.0/revoke")


@pytest.mark.usefixtures("wire")
def test_cli_revoke_certificate_and_kiosk(
    tmp_path: Path, fake_api: FakeApi, fake_ca: FakeCa, capsys: pytest.CaptureFixture[str]
) -> None:
    assert cli.main(_register_args(tmp_path, fake_ca)) == 0
    bundle = flows.load_bundle(tmp_path / "bundle.json")
    root = tmp_path / "device"
    result = flows.enrol(bundle, root, ca_transport=fake_ca.transport())
    capsys.readouterr()
    common = [
        "revoke", "--ca-url", fake_ca.url, "--provisioner-key", str(tmp_path / "prov.pem"),
        "--root-ca", str(tmp_path / "root.crt"), "--serial", result.certificate_serial,
    ]  # fmt: skip
    assert cli.main([*common, "--kiosk-id", "kiosk-cli-001"]) == 1
    assert "--api is required" in capsys.readouterr().err
    assert fake_api.kiosks["kiosk-cli-001"]["status"] == "active"
    args = [*common, "--kiosk-id", "kiosk-cli-001", "--api", "https://api.test"]
    args += ["--admin-token-file", str(tmp_path / "admin.token")]
    assert cli.main(args) == 0
    out = capsys.readouterr().out
    assert "revoked kiosk kiosk-cli-001 in the API (status revoked)" in out
    assert fake_api.kiosks["kiosk-cli-001"]["status"] == "revoked"
    assert result.certificate_serial in fake_ca.revoked
    # the device token no longer authenticates
    token = (root / dc.TOKEN_FILE).read_text().strip()
    resp = fake_api.transport().handle_request(
        httpx.Request(
            "POST",
            "https://api.test/api/v1/admin/kiosks/heartbeat",
            headers={"authorization": f"Bearer {token}"},
            json={},
        )
    )
    assert resp.status_code == 401


def test_cli_model_render_and_validate(repo_root: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    template = repo_root / "infra/kiosk-image/model/shriii-kiosk-pc-24.json"
    out = tmp_path / "model.json"
    vars_file = tmp_path / "vars.json"
    vars_file.write_text(json.dumps({"BRAND_ACCOUNT_ID": "b" * 32, "BRAND_STORE_ID": "store1"}))
    args = [
        "model", "render", "--template", str(template), "--vars-file", str(vars_file),
        "--var", f"GADGET_SNAP_ID={'G' * 32}", "--var", f"KIOSK_SNAP_ID={'K' * 32}",
        "--var", "MODEL_TIMESTAMP=2026-10-22T00:00:00Z", "--out", str(out),
    ]  # fmt: skip
    assert cli.main(args) == 0
    assert cli.main(["model", "validate", "--production", str(out)]) == 0
    assert "ok (model shriii-kiosk-pc-24, grade signed" in capsys.readouterr().out
    assert cli.main(["model", "validate", str(template)]) == 1
    assert cli.main(["model", "validate", "--allow-placeholders", str(template)]) == 0


def test_cli_wave_freeze(tmp_path: Path) -> None:
    out = tmp_path / "vs.json"
    args = [
        "wave-freeze", "--account-id", "a" * 32, "--sequence", "2",
        "--snap", f"shriii-kiosk={'K' * 32}@12", "--snap", f"ubuntu-frame={'F' * 32}@20083", "--out", str(out),
    ]  # fmt: skip
    assert cli.main(args) == 0
    assert json.loads(out.read_text())["snaps"][0] == {
        "name": "shriii-kiosk",
        "id": "K" * 32,
        "presence": "required",
        "revision": "12",
    }
