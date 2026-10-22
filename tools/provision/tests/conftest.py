from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fakes import ADMIN_TOKEN, FakeApi, FakeCa

from shriii_provision import stepca
from shriii_provision.api import ApiClient
from shriii_provision.flows import RegisterRequest

API = "https://api.test"


@pytest.fixture
def fake_api() -> FakeApi:
    return FakeApi()


@pytest.fixture
def fake_ca() -> FakeCa:
    return FakeCa()


@pytest.fixture
def provisioner(fake_ca: FakeCa, tmp_path: Path) -> stepca.ProvisionerKey:
    path = tmp_path / "provisioner.pem"
    path.write_bytes(fake_ca.provisioner_pem())
    return stepca.load_provisioner_key(path)


@pytest.fixture
def api(fake_api: FakeApi) -> Iterator[ApiClient]:
    with ApiClient(API, admin_token=ADMIN_TOKEN, transport=fake_api.transport()) as client:
        yield client


@pytest.fixture
def register_request(fake_ca: FakeCa, provisioner: stepca.ProvisionerKey) -> RegisterRequest:
    return RegisterRequest(
        kiosk_id="kiosk-pune-001",
        site_id="site-pune-library",
        site_mode="supervised",
        policy_version="2026.10.1",
        app_version="0.1.0",
        ca_url=fake_ca.url,
        root_ca_pem=fake_ca.root_pem,
        provisioner=provisioner,
        label="Pune library, entrance",
    )


@pytest.fixture
def repo_root() -> Path:
    return Path(__file__).resolve().parents[3]
