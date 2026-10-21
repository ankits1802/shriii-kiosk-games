"""Service configuration (pydantic-settings). Values come from the environment or ``.env``.

Scientific thresholds never live here: they are read from ``scoring/*.yaml``. This module only holds
operational settings (connections, keys, timeouts, feature switches).
"""

from __future__ import annotations

import base64
import hashlib
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

Environment = Literal["dev", "test", "staging", "prod"]


def _derive_dev_key(secret: str, label: str) -> str:
    """Deterministic 32-byte key (base64) derived from the dev secret; dev/test only."""
    return base64.b64encode(hashlib.sha256(f"{label}:{secret}".encode()).digest()).decode()


class Settings(BaseSettings):
    """All runtime settings. In ``prod``/``staging`` every key must be supplied explicitly."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    env: Environment = Field(default="dev", validation_alias="ENV")
    service_name: str = "shriii-api"
    log_level: str = "INFO"
    log_json: bool = True

    # --- Databases (research DB and a separate identity vault connection; PRV-04) ---
    database_url: str = "postgresql+psycopg://dev:dev@localhost:5432/shriii"
    identity_database_url: str | None = None
    db_pool_size: int = 10
    db_echo: bool = False

    # --- Auth (OIDC-ready JWT + dev login) ---
    auth_mode: Literal["dev", "oidc"] = "dev"
    dev_jwt_secret: SecretStr = SecretStr("change-me-dev-only")
    dev_jwt_ttl_minutes: int = 480
    jwt_issuer: str = "shriii-dev"
    jwt_audience: str = "shriii-api"
    oidc_jwks_url: str | None = None
    oidc_algorithms: Annotated[list[str], NoDecode] = Field(default_factory=lambda: ["RS256"])
    oidc_roles_claim: str = "roles"
    oidc_studies_claim: str = "studies"

    # --- CORS (apps/web and apps/kiosk) ---
    api_cors_origins: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: ["http://localhost:5173", "http://localhost:3000"]
    )
    public_base_url: str = "http://localhost:3000"

    # --- Keys (KMS-held in production; dev values are derived from the dev secret) ---
    pid_hmac_pepper: SecretStr | None = None
    pid_pepper_version: int = 1
    session_key_kek: SecretStr | None = None
    """Base64 32-byte key-encryption key used to re-wrap session DEKs (consent.session_keys)."""
    backend_x25519_private_key: SecretStr | None = None
    """Base64 32-byte X25519 private key used to unseal per-session DEKs from encrypted chunks."""
    release_pack_signing_key: SecretStr | None = None
    """Base64 32-byte Ed25519 seed used to sign release packs and erasure receipts."""
    release_pack_key_id: str = "dev-release-key"
    identity_vault_key: SecretStr | None = None
    """Base64 32-byte AES key for column envelope encryption of vault contact details."""

    # --- Ingestion ---
    accept_plaintext_chunks: bool | None = None
    """``none_dev`` chunks; defaults to True only in dev/test."""
    max_batch_bytes: int = 1_048_576
    consent_parking_ttl_hours: int = 72
    clock_offset_anomaly_ms: float = 300_000.0
    """Absolute kiosk clock offset beyond which a session gets a ``clock_offset_anomaly`` flag."""

    # --- Storage ---
    data_dir: Path = Field(default_factory=lambda: Path(".data"))
    """Local object-storage root (Parquet snapshots); S3-compatible storage later."""

    # --- Reports ---
    report_token_ttl_hours: int = 72
    report_token_max_ttl_hours: int = 168

    # --- Jobs ---
    job_max_attempts: int = 5
    job_backoff_base_s: float = 2.0
    job_backoff_max_s: float = 600.0
    job_lease_s: int = 900
    worker_poll_interval_s: float = 1.0
    kiosk_heartbeat_stale_minutes: int = 30

    # --- Observability ---
    otel_enabled: bool = False
    otel_exporter_otlp_endpoint: str | None = None

    # --- Paths ---
    repo_root: Path | None = Field(default=None, validation_alias="SHRIII_REPO_ROOT")

    # --- Provenance ---
    git_sha: str | None = None
    """Source revision recorded on every validation result (``GIT_SHA``; read from git in dev checkouts)."""

    @field_validator("api_cors_origins", "oidc_algorithms", mode="before")
    @classmethod
    def _split_csv(cls, value: object) -> object:
        if isinstance(value, str):
            return [v.strip() for v in value.split(",") if v.strip()]
        return value

    @model_validator(mode="after")
    def _fill_dev_defaults(self) -> Settings:
        dev_like = self.env in ("dev", "test")
        secret = self.dev_jwt_secret.get_secret_value()
        derived: dict[str, str] = {
            "pid_hmac_pepper": "pid-pepper",
            "session_key_kek": "session-kek",
            "backend_x25519_private_key": "x25519",
            "release_pack_signing_key": "ed25519",
            "identity_vault_key": "vault",
        }
        for attr, label in derived.items():
            if getattr(self, attr) is None:
                if not dev_like:
                    raise ValueError(f"{attr.upper()} must be set when ENV={self.env}")
                setattr(self, attr, SecretStr(_derive_dev_key(secret, label)))
        if self.accept_plaintext_chunks is None:
            self.accept_plaintext_chunks = dev_like
        if not dev_like:
            if self.auth_mode == "dev":
                raise ValueError("AUTH_MODE=dev is only allowed when ENV is dev or test")
            if secret == "change-me-dev-only":
                # The dev secret is unused in oidc mode, but refuse the default value outright.
                self.dev_jwt_secret = SecretStr(hashlib.sha256(secret.encode()).hexdigest() + "-disabled")
        if self.auth_mode == "oidc" and not self.oidc_jwks_url:
            raise ValueError("OIDC_JWKS_URL is required when AUTH_MODE=oidc")
        return self

    @property
    def is_dev(self) -> bool:
        return self.env in ("dev", "test")

    @property
    def effective_identity_database_url(self) -> str:
        return self.identity_database_url or self.database_url

    def key_bytes(
        self,
        name: Literal[
            "pid_hmac_pepper",
            "session_key_kek",
            "backend_x25519_private_key",
            "release_pack_signing_key",
            "identity_vault_key",
        ],
    ) -> bytes:
        """Decode a base64 key setting; raises if it is not exactly 32 bytes."""
        secret = getattr(self, name)
        if secret is None:  # pragma: no cover - filled by the validator
            raise RuntimeError(f"{name} is not configured")
        raw = base64.b64decode(secret.get_secret_value())
        if len(raw) != 32:
            raise ValueError(f"{name} must decode to 32 bytes")
        return raw


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Process-wide settings singleton (tests clear the cache to override)."""
    return Settings()
