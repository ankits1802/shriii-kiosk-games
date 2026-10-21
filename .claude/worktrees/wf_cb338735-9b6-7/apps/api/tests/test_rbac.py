"""RBAC: permission matrix, denials (audited), study scoping, device restrictions, dev-login guard."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from shriii_api.auth.rbac import ROLE_PERMISSIONS, Perm, Role
from shriii_api.testing import make_batch, session_events


def test_permission_matrix_invariants() -> None:
    analyst = ROLE_PERMISSIONS[Role.ANALYST]
    administrator = ROLE_PERMISSIONS[Role.ADMINISTRATOR]
    device = ROLE_PERMISSIONS[Role.KIOSK_DEVICE]
    # Analysts are de-identified only (CRT-01): no linkage, consent, raw events, scores keyed by pid.
    assert not analyst & {
        Perm.PARTICIPANTS_READ,
        Perm.CONSENT_READ,
        Perm.EVENTS_READ_RAW,
        Perm.SCORES_READ,
        Perm.RESPONSES_READ,
    }
    # Field administrators never read scores (PRV-08).
    assert Perm.SCORES_READ not in administrator and Perm.FEATURES_READ not in administrator
    # Devices can only upload, run sessions, read games/gates, generate reports, heartbeat, link and request erasure.
    assert device <= {
        Perm.EVENTS_INGEST,
        Perm.SESSIONS_WRITE,
        Perm.GAMES_READ,
        Perm.GATES_READ,
        Perm.REPORTS_GENERATE,
        Perm.KIOSK_HEARTBEAT,
        Perm.ERASURE_REQUEST,
        Perm.PARTICIPANTS_LINK,
    }
    assert ROLE_PERMISSIONS[Role.ADMIN] == frozenset(Perm)
    assert Perm.GATES_WRITE not in ROLE_PERMISSIONS[Role.RESEARCHER]


@pytest.mark.parametrize(
    ("roles", "method", "path", "expected"),
    [
        (("analyst",), "GET", "/api/v1/participants", 403),
        (("analyst",), "GET", "/api/v1/assessment-responses/scores?study_id=s1", 403),
        (("analyst",), "GET", "/api/v1/validation/datasets?study_id=s1", 200),
        (("administrator",), "GET", "/api/v1/assessment-responses/scores?study_id=s1", 403),
        (("administrator",), "GET", "/api/v1/features?study_id=s1", 403),
        (("researcher",), "POST", "/api/v1/admin/gates/release-pack", 403),
        (("researcher",), "GET", "/api/v1/admin/audit", 403),
        (("analyst",), "POST", "/api/v1/admin/kiosks", 403),
        (("administrator",), "GET", "/api/v1/participants", 200),
    ],
)
def test_role_denials(
    client: TestClient, auth: Any, roles: tuple[str, ...], method: str, path: str, expected: int
) -> None:
    body = {"kiosk_id": "kiosk-x9", "site_id": "s"} if path.endswith("/kiosks") else None
    r = client.request(method, path, headers=auth(*roles), json=body)
    assert r.status_code == expected, r.text


def test_unauthenticated_and_bad_tokens(client: TestClient) -> None:
    assert client.get("/api/v1/sessions").status_code == 401
    assert client.get("/api/v1/sessions", headers={"Authorization": "Bearer not-a-jwt"}).status_code == 401
    assert client.get("/api/v1/sessions", headers={"Authorization": "Bearer kdt_unknown"}).status_code == 401
    assert client.get("/healthz").status_code == 200


def test_denials_are_audited(client: TestClient, auth: Any, admin: dict[str, str]) -> None:
    client.get("/api/v1/participants", headers=auth("analyst", sub="analyst-9"))
    client.get("/api/v1/sessions", headers={"Authorization": "Bearer nope"})
    denied = client.get("/api/v1/admin/audit", headers=admin, params={"outcome": "denied"}).json()["items"]
    subs = {d["actor_sub"] for d in denied}
    assert "analyst-9" in subs
    assert any(d["actor_kind"] == "anonymous" and d["details"].get("auth_failure") for d in denied)


def test_study_scoping(client: TestClient, auth: Any, kiosk: dict[str, Any], admin: dict[str, str]) -> None:
    lead = auth("researcher", sub="lead")
    for sid in ("study-a", "study-b"):
        client.post(
            "/api/v1/studies", headers=lead, json={"study_id": sid, "code": "S1", "name": sid, "stage": "pilot"}
        )
    events = session_events(pid=None)
    client.post("/api/v1/events/batch", json=make_batch(events), headers=kiosk["headers"])
    pid = client.post("/api/v1/participants", headers=lead, json={"study_id": "study-b"}).json()["pid"]
    pairing = client.post(
        f"/api/v1/participants/{pid}/pairing-codes", headers=lead, json={"study_id": "study-b", "occasion_id": "T1"}
    ).json()
    assert (
        client.post(
            "/api/v1/participants/link",
            headers=kiosk["headers"],
            json={"session_id": events[0]["session_id"], "pairing_code": pairing["code"]},
        ).status_code
        == 201
    )
    scoped_a = auth("researcher", sub="scoped-a", studies=["study-a"])
    scoped_b = auth("researcher", sub="scoped-b", studies=["study-b"])
    sid = events[0]["session_id"]
    assert client.get(f"/api/v1/sessions/{sid}", headers=scoped_a).status_code == 403
    assert client.get(f"/api/v1/sessions/{sid}", headers=scoped_b).status_code == 200
    assert client.get(f"/api/v1/participants/{pid}", headers=scoped_a).status_code == 403
    assert client.get("/api/v1/participants", headers=scoped_a, params={"study_id": "study-b"}).status_code == 403
    listed = client.get("/api/v1/sessions", headers=scoped_a).json()
    assert listed["total"] == 0
    assert [s["study_id"] for s in client.get("/api/v1/studies", headers=scoped_a).json()] == ["study-a"]


def test_device_restrictions(client: TestClient, kiosk: dict[str, Any], admin: dict[str, str]) -> None:
    other = client.post("/api/v1/admin/kiosks", json={"kiosk_id": "kiosk-002", "site_id": "s2"}, headers=admin)
    events = session_events(kiosk_id="kiosk-002")
    client.post(
        "/api/v1/events/batch",
        json=make_batch(events, kiosk_id="kiosk-002"),
        headers={"Authorization": f"Bearer {other.json()['device_token']}"},
    )
    sid = events[0]["session_id"]
    # kiosk-001 cannot touch kiosk-002's session, list sessions or read raw data.
    assert client.post(f"/api/v1/sessions/{sid}/resume", headers=kiosk["headers"]).status_code == 403
    assert client.get("/api/v1/sessions", headers=kiosk["headers"]).status_code == 403
    assert (
        client.post(
            "/api/v1/participants/link",
            headers=kiosk["headers"],
            json={"session_id": sid, "pid": "ABCDEFGH", "second_linker": "x"},
        ).status_code
        == 403
    )
    # A revoked kiosk is locked out immediately.
    client.post("/api/v1/admin/kiosks/kiosk-001/revoke", headers=admin)
    assert client.post("/api/v1/admin/kiosks/heartbeat", headers=kiosk["headers"], json={}).status_code == 401


def test_dev_login_rejects_device_role(client: TestClient) -> None:
    r = client.post("/api/v1/auth/dev-login", json={"sub": "x", "roles": ["kiosk_device"]})
    assert r.status_code == 422


def test_dev_login_refused_outside_dev() -> None:
    from shriii_api.auth.tokens import AuthError, issue_dev_token  # noqa: PLC0415
    from shriii_api.settings import Settings  # noqa: PLC0415

    with pytest.raises(ValueError, match="AUTH_MODE=dev"):
        Settings(
            ENV="prod",
            auth_mode="dev",
            pid_hmac_pepper="a" * 44,
            session_key_kek="a" * 44,
            backend_x25519_private_key="a" * 44,
            release_pack_signing_key="a" * 44,
            identity_vault_key="a" * 44,
        )
    oidc = Settings(
        ENV="prod",
        auth_mode="oidc",
        oidc_jwks_url="https://idp.example/jwks",
        pid_hmac_pepper="a" * 44,
        session_key_kek="a" * 44,
        backend_x25519_private_key="a" * 44,
        release_pack_signing_key="a" * 44,
        identity_vault_key="a" * 44,
    )
    with pytest.raises(AuthError):
        issue_dev_token(oidc, "x", ["admin"])
