"""Initial research schema: every table of the plan section 6.4 schemas (+ games, reporting, ops).

Generated with ``alembic revision --autogenerate`` from the ORM models, then reviewed. Guards
(append-only triggers), roles/grants and the first event partitions are added in 0002.

Revision ID: 0001
Revises:
Create Date: 2026-10-21 17:47:36.807858
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0001"
down_revision: str | Sequence[str] | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


SCHEMAS = (
    "kiosk_raw",
    "scored",
    "criterion",
    "linkage",
    "consent",
    "study",
    "games",
    "validation",
    "reporting",
    "governance",
    "ops",
)


def upgrade() -> None:
    for schema in SCHEMAS:
        op.execute(f"CREATE SCHEMA IF NOT EXISTS {schema}")
    op.create_table(
        "artefacts",
        sa.Column("consent_id", sa.Uuid(), nullable=False),
        sa.Column("participant_pid", sa.String(length=26), nullable=True),
        sa.Column("session_id", sa.Uuid(), nullable=True),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("granted", sa.Boolean(), nullable=False),
        sa.Column("consent_script_id", sa.String(length=128), nullable=False),
        sa.Column("script_audio_sha256", sa.String(length=64), nullable=False),
        sa.Column("language", sa.String(length=16), nullable=False),
        sa.Column("policy_version", sa.String(length=64), nullable=False),
        sa.Column("protocol_id", sa.String(length=128), nullable=True),
        sa.Column("input_mode", sa.String(length=8), nullable=False),
        sa.Column("presented_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("kiosk_id", sa.String(length=64), nullable=True),
        sa.Column("replay_counts", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("supersedes_id", sa.Uuid(), nullable=True),
        sa.Column("source_event_id", sa.Uuid(), nullable=True),
        sa.Column("recorded_by", sa.String(length=256), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["supersedes_id"], ["consent.artefacts.consent_id"], name=op.f("fk_artefacts_supersedes_id_artefacts")
        ),
        sa.PrimaryKeyConstraint("consent_id", name=op.f("pk_artefacts")),
        schema="consent",
    )
    op.create_index(
        op.f("ix_consent_artefacts_participant_pid"), "artefacts", ["participant_pid"], unique=False, schema="consent"
    )
    op.create_index(
        op.f("ix_consent_artefacts_session_id"), "artefacts", ["session_id"], unique=False, schema="consent"
    )
    op.create_table(
        "erasure_requests",
        sa.Column("request_id", sa.Uuid(), nullable=False),
        sa.Column("scope", sa.String(length=16), nullable=False),
        sa.Column("pid", sa.String(length=26), nullable=True),
        sa.Column("pid_hmac", sa.String(length=64), nullable=True),
        sa.Column("session_id", sa.Uuid(), nullable=True),
        sa.Column("channel", sa.String(length=32), nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("requested_by", sa.String(length=256), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("job_id", sa.Uuid(), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("request_id", name=op.f("pk_erasure_requests")),
        schema="consent",
    )
    op.create_index(
        op.f("ix_consent_erasure_requests_pid_hmac"), "erasure_requests", ["pid_hmac"], unique=False, schema="consent"
    )
    op.create_table(
        "session_keys",
        sa.Column("session_id", sa.Uuid(), nullable=False),
        sa.Column("nonce", sa.LargeBinary(), nullable=False),
        sa.Column("wrapped_dek", sa.LargeBinary(), nullable=False),
        sa.Column("kek_version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("session_id", name=op.f("pk_session_keys")),
        schema="consent",
    )
    op.create_table(
        "tombstones",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("session_id", sa.Uuid(), nullable=True),
        sa.Column("pid_hmac", sa.String(length=64), nullable=True),
        sa.Column("reason", sa.String(length=32), nullable=False),
        sa.Column("request_id", sa.Uuid(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_tombstones")),
        sa.UniqueConstraint("session_id", name=op.f("uq_tombstones_session_id")),
        schema="consent",
    )
    op.create_index(op.f("ix_consent_tombstones_pid_hmac"), "tombstones", ["pid_hmac"], unique=False, schema="consent")
    op.create_table(
        "imports",
        sa.Column("import_id", sa.Uuid(), nullable=False),
        sa.Column("study_id", sa.String(length=128), nullable=False),
        sa.Column("instrument_id", sa.String(length=128), nullable=False),
        sa.Column("instrument_version", sa.String(length=64), nullable=False),
        sa.Column("language", sa.String(length=16), nullable=False),
        sa.Column("occasion_id", sa.String(length=128), nullable=False),
        sa.Column("wave", sa.Integer(), nullable=False),
        sa.Column("block", sa.String(length=32), nullable=False),
        sa.Column("administration_mode", sa.String(length=32), nullable=False),
        sa.Column("filename", sa.String(length=512), nullable=False),
        sa.Column("file_format", sa.String(length=8), nullable=False),
        sa.Column("file_sha256", sa.String(length=64), nullable=False),
        sa.Column("column_mapping", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("counts", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("created_by", sa.String(length=256), nullable=False),
        sa.Column("committed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("committed_by", sa.String(length=256), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("import_id", name=op.f("pk_imports")),
        schema="criterion",
    )
    op.create_table(
        "instruments",
        sa.Column("instrument_id", sa.String(length=128), nullable=False),
        sa.Column("name", sa.String(length=256), nullable=False),
        sa.Column("short_name", sa.String(length=256), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("citation", sa.Text(), nullable=False),
        sa.Column("constructs_measured", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("current_version", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("instrument_id", name=op.f("pk_instruments")),
        schema="criterion",
    )
    op.create_table(
        "responses",
        sa.Column("response_id", sa.Uuid(), nullable=False),
        sa.Column("pid", sa.String(length=26), nullable=False),
        sa.Column("subject_pid", sa.String(length=26), nullable=False),
        sa.Column("study_id", sa.String(length=128), nullable=False),
        sa.Column("wave", sa.Integer(), nullable=False),
        sa.Column("occasion_id", sa.String(length=128), nullable=False),
        sa.Column("instrument_id", sa.String(length=128), nullable=False),
        sa.Column("instrument_version", sa.String(length=64), nullable=False),
        sa.Column("language_version", sa.String(length=64), nullable=False),
        sa.Column("block", sa.String(length=32), nullable=False),
        sa.Column("item_id", sa.String(length=128), nullable=False),
        sa.Column("raw_response", sa.Float(), nullable=True),
        sa.Column("response_latency_ms", sa.Float(), nullable=True),
        sa.Column("administration_mode", sa.String(length=32), nullable=False),
        sa.Column("administrator_id", sa.String(length=128), nullable=True),
        sa.Column("rater_role", sa.String(length=32), nullable=True),
        sa.Column("rated_pid", sa.String(length=26), nullable=True),
        sa.Column("device_id", sa.String(length=128), nullable=False),
        sa.Column("audio_version", sa.String(length=64), nullable=True),
        sa.Column("attention_check", sa.Boolean(), nullable=False),
        sa.Column("attention_check_failed", sa.Boolean(), nullable=True),
        sa.Column("source", sa.String(length=32), nullable=False),
        sa.Column("import_id", sa.Uuid(), nullable=True),
        sa.Column("recorded_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("supersedes_id", sa.Uuid(), nullable=True),
        sa.Column("correction_reason", sa.Text(), nullable=True),
        sa.Column("submitted_by", sa.String(length=256), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("response_id", name=op.f("pk_responses")),
        schema="criterion",
    )
    op.create_index(
        op.f("ix_criterion_responses_subject_pid"), "responses", ["subject_pid"], unique=False, schema="criterion"
    )
    op.create_index(
        op.f("ix_criterion_responses_supersedes_id"), "responses", ["supersedes_id"], unique=False, schema="criterion"
    )
    op.create_index(
        "ix_responses_subject_occasion",
        "responses",
        ["subject_pid", "study_id", "occasion_id", "instrument_id"],
        unique=False,
        schema="criterion",
    )
    op.create_table(
        "scale_scores",
        sa.Column("score_id", sa.Uuid(), nullable=False),
        sa.Column("pid", sa.String(length=26), nullable=False),
        sa.Column("study_id", sa.String(length=128), nullable=False),
        sa.Column("wave", sa.Integer(), nullable=False),
        sa.Column("occasion_id", sa.String(length=128), nullable=False),
        sa.Column("instrument_id", sa.String(length=128), nullable=False),
        sa.Column("instrument_version", sa.String(length=64), nullable=False),
        sa.Column("scale_id", sa.String(length=128), nullable=False),
        sa.Column("score", sa.Float(), nullable=True),
        sa.Column("raw_mean", sa.Float(), nullable=True),
        sa.Column("score_type", sa.String(length=32), nullable=False),
        sa.Column("n_answered", sa.Integer(), nullable=False),
        sa.Column("n_items", sa.Integer(), nullable=False),
        sa.Column("key_version", sa.String(length=64), nullable=False),
        sa.Column("prorated", sa.Boolean(), nullable=False),
        sa.Column("planned_missing", sa.Boolean(), nullable=False),
        sa.Column("na_reason", sa.String(length=64), nullable=True),
        sa.Column("flags", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("scoring_run_id", sa.Uuid(), nullable=False),
        sa.Column("is_current", sa.Boolean(), nullable=False),
        sa.Column("algorithm_version", sa.String(length=64), nullable=False),
        sa.Column("dictionary_version", sa.String(length=64), nullable=True),
        sa.Column("source_refs", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("data_snapshot_id", sa.Uuid(), nullable=True),
        sa.Column("job_id", sa.Uuid(), nullable=True),
        sa.Column("computed_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("score_id", name=op.f("pk_scale_scores")),
        schema="criterion",
    )
    op.create_index(
        "ix_scale_scores_current",
        "scale_scores",
        ["pid", "study_id", "occasion_id", "instrument_id"],
        unique=False,
        schema="criterion",
        postgresql_where=sa.text("is_current"),
    )
    op.create_table(
        "games",
        sa.Column("game_id", sa.String(length=128), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("pathways", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("constructs", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("slot", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("game_id", name=op.f("pk_games")),
        schema="games",
    )
    op.create_table(
        "audit_events",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("actor_sub", sa.String(length=256), nullable=True),
        sa.Column("actor_roles", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("actor_kind", sa.String(length=16), nullable=False),
        sa.Column("action", sa.String(length=128), nullable=False),
        sa.Column("method", sa.String(length=8), nullable=True),
        sa.Column("path", sa.String(length=1024), nullable=True),
        sa.Column("status_code", sa.Integer(), nullable=True),
        sa.Column("outcome", sa.String(length=16), nullable=False),
        sa.Column("resource_type", sa.String(length=64), nullable=True),
        sa.Column("resource_id", sa.String(length=256), nullable=True),
        sa.Column("study_id", sa.String(length=128), nullable=True),
        sa.Column("request_id", sa.String(length=64), nullable=True),
        sa.Column("ip", sa.String(length=64), nullable=True),
        sa.Column("details", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_audit_events")),
        schema="governance",
    )
    op.create_index("ix_audit_events_occurred_at", "audit_events", ["occurred_at"], unique=False, schema="governance")
    op.create_index(
        op.f("ix_governance_audit_events_action"), "audit_events", ["action"], unique=False, schema="governance"
    )
    op.create_index(
        op.f("ix_governance_audit_events_actor_sub"), "audit_events", ["actor_sub"], unique=False, schema="governance"
    )
    op.create_table(
        "content_versions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("version", sa.String(length=64), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.Column("manifest", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("approved_by", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("created_by", sa.String(length=256), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_content_versions")),
        sa.UniqueConstraint("kind", "version", "sha256", name=op.f("uq_content_versions_kind_version_sha256")),
        schema="governance",
    )
    op.create_table(
        "kiosks",
        sa.Column("kiosk_id", sa.String(length=64), nullable=False),
        sa.Column("site_id", sa.String(length=128), nullable=False),
        sa.Column("label", sa.String(length=256), nullable=True),
        sa.Column("token_digest", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("hardware_sku", sa.String(length=128), nullable=True),
        sa.Column("app_version", sa.String(length=64), nullable=True),
        sa.Column("last_heartbeat_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_heartbeat", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("health_status", sa.String(length=16), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("kiosk_id", name=op.f("pk_kiosks")),
        sa.UniqueConstraint("token_digest", name=op.f("uq_kiosks_token_digest")),
        schema="governance",
    )
    op.create_table(
        "legal_holds",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("scope_kind", sa.String(length=16), nullable=False),
        sa.Column("scope_value", sa.String(length=128), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("created_by", sa.String(length=256), nullable=False),
        sa.Column("released_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_legal_holds")),
        schema="governance",
    )
    op.create_table(
        "retention_runs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("dry_run", sa.Boolean(), nullable=False),
        sa.Column("policy_sha256", sa.String(length=64), nullable=False),
        sa.Column("report", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("triggered_by", sa.String(length=256), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_retention_runs")),
        schema="governance",
    )
    op.create_table(
        "settings",
        sa.Column("key", sa.String(length=128), nullable=False),
        sa.Column("value", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("updated_by", sa.String(length=256), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("key", name=op.f("pk_settings")),
        schema="governance",
    )
    op.create_table(
        "signoffs",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("subject_kind", sa.String(length=32), nullable=False),
        sa.Column("subject_id", sa.String(length=256), nullable=False),
        sa.Column("role", sa.String(length=64), nullable=False),
        sa.Column("signer", sa.String(length=256), nullable=False),
        sa.Column("document_sha256", sa.String(length=64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_signoffs")),
        schema="governance",
    )
    op.create_table(
        "system_events",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("kind", sa.String(length=64), nullable=False),
        sa.Column("severity", sa.String(length=16), nullable=False),
        sa.Column("kiosk_id", sa.String(length=64), nullable=True),
        sa.Column("details", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_system_events")),
        schema="governance",
    )
    op.create_index(
        op.f("ix_governance_system_events_occurred_at"),
        "system_events",
        ["occurred_at"],
        unique=False,
        schema="governance",
    )
    op.create_table(
        "batches",
        sa.Column("batch_id", sa.Uuid(), nullable=False),
        sa.Column("kiosk_id", sa.String(length=64), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.Column("event_count", sa.Integer(), nullable=False),
        sa.Column("kiosk_t_wall", sa.DateTime(timezone=True), nullable=False),
        sa.Column("received_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("clock_offset_estimate_ms", sa.Float(), nullable=True),
        sa.Column("result", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("final", sa.Boolean(), nullable=False),
        sa.PrimaryKeyConstraint("batch_id", name=op.f("pk_batches")),
        schema="kiosk_raw",
    )
    op.create_index(op.f("ix_kiosk_raw_batches_kiosk_id"), "batches", ["kiosk_id"], unique=False, schema="kiosk_raw")
    op.create_table(
        "consent_parking",
        sa.Column("event_id", sa.Uuid(), nullable=False),
        sa.Column("session_id", sa.Uuid(), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("batch_id", sa.Uuid(), nullable=False),
        sa.Column("server_received_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("clock_offset_estimate_ms", sa.Float(), nullable=True),
        sa.Column("envelope", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("parked_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("event_id", name=op.f("pk_consent_parking")),
        schema="kiosk_raw",
    )
    op.create_index(
        op.f("ix_kiosk_raw_consent_parking_expires_at"),
        "consent_parking",
        ["expires_at"],
        unique=False,
        schema="kiosk_raw",
    )
    op.create_index(
        op.f("ix_kiosk_raw_consent_parking_session_id"),
        "consent_parking",
        ["session_id"],
        unique=False,
        schema="kiosk_raw",
    )
    op.create_table(
        "dead_letter",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("event_id", sa.Uuid(), nullable=True),
        sa.Column("session_id", sa.Uuid(), nullable=True),
        sa.Column("seq", sa.Integer(), nullable=True),
        sa.Column("batch_id", sa.Uuid(), nullable=True),
        sa.Column("kiosk_id", sa.String(length=64), nullable=True),
        sa.Column("app_version", sa.String(length=64), nullable=True),
        sa.Column("reason_code", sa.String(length=128), nullable=False),
        sa.Column("schema_path", sa.String(length=512), nullable=True),
        sa.Column("message", sa.Text(), nullable=True),
        sa.Column("payload_nonce", sa.LargeBinary(), nullable=True),
        sa.Column("payload_ciphertext", sa.LargeBinary(), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("replayed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_dead_letter")),
        schema="kiosk_raw",
    )
    op.create_index(
        op.f("ix_kiosk_raw_dead_letter_event_id"), "dead_letter", ["event_id"], unique=False, schema="kiosk_raw"
    )
    op.create_index(
        op.f("ix_kiosk_raw_dead_letter_reason_code"), "dead_letter", ["reason_code"], unique=False, schema="kiosk_raw"
    )
    op.create_index(
        op.f("ix_kiosk_raw_dead_letter_session_id"), "dead_letter", ["session_id"], unique=False, schema="kiosk_raw"
    )
    op.create_table(
        "event_dedup",
        sa.Column("event_id", sa.Uuid(), nullable=False),
        sa.Column("session_id", sa.Uuid(), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("batch_id", sa.Uuid(), nullable=False),
        sa.Column("state", sa.String(length=16), nullable=False),
        sa.Column("server_received_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("event_id", name=op.f("pk_event_dedup")),
        sa.UniqueConstraint("session_id", "seq", name=op.f("uq_event_dedup_session_id_seq")),
        schema="kiosk_raw",
    )
    op.create_table(
        "events",
        sa.Column("event_id", sa.Uuid(), nullable=False),
        sa.Column("server_received_date", sa.Date(), nullable=False),
        sa.Column("server_received_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("session_id", sa.Uuid(), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("event_type", sa.String(length=64), nullable=False),
        sa.Column("schema_version", sa.String(length=16), nullable=False),
        sa.Column("participant_pid", sa.String(length=26), nullable=True),
        sa.Column("kiosk_id", sa.String(length=64), nullable=False),
        sa.Column("site_mode", sa.String(length=32), nullable=True),
        sa.Column("mode", sa.String(length=32), nullable=True),
        sa.Column("language", sa.String(length=16), nullable=True),
        sa.Column("episode_id", sa.String(length=128), nullable=True),
        sa.Column("module_id", sa.String(length=128), nullable=True),
        sa.Column("block_id", sa.String(length=128), nullable=True),
        sa.Column("trial_id", sa.String(length=128), nullable=True),
        sa.Column("trial_index", sa.Integer(), nullable=True),
        sa.Column("phase", sa.String(length=32), nullable=True),
        sa.Column("scorable", sa.Boolean(), nullable=False),
        sa.Column("timing_flag", sa.String(length=32), nullable=False),
        sa.Column("t_mono_ms", sa.Float(), nullable=False),
        sa.Column("kiosk_t_wall", sa.DateTime(timezone=True), nullable=False),
        sa.Column("batch_id", sa.Uuid(), nullable=False),
        sa.Column("clock_offset_estimate_ms", sa.Float(), nullable=True),
        sa.Column("synthetic", sa.Boolean(), nullable=False),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("payload_ext", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("envelope", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.PrimaryKeyConstraint("event_id", "server_received_date", name=op.f("pk_events")),
        schema="kiosk_raw",
        postgresql_partition_by="RANGE (server_received_date)",
    )
    op.create_index("ix_events_participant_pid", "events", ["participant_pid"], unique=False, schema="kiosk_raw")
    op.create_index("ix_events_session_id_seq", "events", ["session_id", "seq"], unique=False, schema="kiosk_raw")
    op.create_table(
        "sessions",
        sa.Column("session_id", sa.Uuid(), nullable=False),
        sa.Column("kiosk_id", sa.String(length=64), nullable=False),
        sa.Column("site_id", sa.String(length=128), nullable=True),
        sa.Column("site_mode", sa.String(length=32), nullable=True),
        sa.Column("mode", sa.String(length=32), nullable=True),
        sa.Column("language", sa.String(length=16), nullable=True),
        sa.Column("battery_arm", sa.String(length=32), nullable=True),
        sa.Column("pathway", sa.String(length=1), nullable=True),
        sa.Column("slot_form", sa.String(length=32), nullable=True),
        sa.Column("participant_pid", sa.String(length=26), nullable=True),
        sa.Column("study_id", sa.String(length=128), nullable=True),
        sa.Column("occasion_id", sa.String(length=128), nullable=True),
        sa.Column("versions", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("synthetic", sa.Boolean(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("end_reason", sa.String(length=64), nullable=True),
        sa.Column("last_seq_received", sa.Integer(), nullable=True),
        sa.Column("max_contiguous_seq", sa.Integer(), nullable=True),
        sa.Column("event_count", sa.Integer(), nullable=False),
        sa.Column("valid_for_report", sa.Boolean(), nullable=False),
        sa.Column("invalidated_reason", sa.Text(), nullable=True),
        sa.Column("invalidated_by", sa.String(length=256), nullable=True),
        sa.Column("created_by", sa.String(length=256), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("session_id", name=op.f("pk_sessions")),
        schema="kiosk_raw",
    )
    op.create_index(op.f("ix_kiosk_raw_sessions_kiosk_id"), "sessions", ["kiosk_id"], unique=False, schema="kiosk_raw")
    op.create_index(
        op.f("ix_kiosk_raw_sessions_participant_pid"), "sessions", ["participant_pid"], unique=False, schema="kiosk_raw"
    )
    op.create_index(op.f("ix_kiosk_raw_sessions_status"), "sessions", ["status"], unique=False, schema="kiosk_raw")
    op.create_index(op.f("ix_kiosk_raw_sessions_study_id"), "sessions", ["study_id"], unique=False, schema="kiosk_raw")
    op.create_table(
        "participants",
        sa.Column("pid", sa.String(length=26), nullable=False),
        sa.Column("pid_hmac", sa.String(length=64), nullable=False),
        sa.Column("pepper_version", sa.Integer(), nullable=False),
        sa.Column("study_id", sa.String(length=128), nullable=True),
        sa.Column("source", sa.String(length=16), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("withdrawn_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_by", sa.String(length=256), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("pid", name=op.f("pk_participants")),
        sa.UniqueConstraint("pid_hmac", name=op.f("uq_participants_pid_hmac")),
        schema="linkage",
    )
    op.create_index(
        op.f("ix_linkage_participants_study_id"), "participants", ["study_id"], unique=False, schema="linkage"
    )
    op.create_table(
        "withdrawals",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("pid_hmac", sa.String(length=64), nullable=False),
        sa.Column("scope", sa.String(length=32), nullable=False),
        sa.Column("reason_code", sa.String(length=64), nullable=True),
        sa.Column("erasure_request_id", sa.Uuid(), nullable=True),
        sa.Column("recorded_by", sa.String(length=256), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_withdrawals")),
        schema="linkage",
    )
    op.create_index(
        op.f("ix_linkage_withdrawals_pid_hmac"), "withdrawals", ["pid_hmac"], unique=False, schema="linkage"
    )
    op.create_table(
        "jobs",
        sa.Column("job_id", sa.Uuid(), nullable=False),
        sa.Column("job_type", sa.String(length=64), nullable=False),
        sa.Column("idempotency_key", sa.String(length=64), nullable=False),
        sa.Column("inputs", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("priority", sa.Integer(), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("max_attempts", sa.Integer(), nullable=False),
        sa.Column("run_after", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("locked_by", sa.String(length=128), nullable=True),
        sa.Column("locked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("progress", sa.Float(), nullable=False),
        sa.Column("progress_message", sa.Text(), nullable=True),
        sa.Column("result", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("error_history", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("parent_job_id", sa.Uuid(), nullable=True),
        sa.Column("trace_id", sa.String(length=64), nullable=True),
        sa.Column("created_by", sa.String(length=256), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("job_id", name=op.f("pk_jobs")),
        sa.UniqueConstraint("idempotency_key", name=op.f("uq_jobs_idempotency_key")),
        schema="ops",
    )
    op.create_index("ix_jobs_claim", "jobs", ["status", "priority", "run_after"], unique=False, schema="ops")
    op.create_index(op.f("ix_ops_jobs_job_type"), "jobs", ["job_type"], unique=False, schema="ops")
    op.create_table(
        "report_approvals",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("subject_kind", sa.String(length=16), nullable=False),
        sa.Column("subject_id", sa.String(length=128), nullable=False),
        sa.Column("decision", sa.String(length=16), nullable=False),
        sa.Column("approver", sa.String(length=256), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_report_approvals")),
        schema="reporting",
    )
    op.create_table(
        "report_templates",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("template_id", sa.String(length=128), nullable=False),
        sa.Column("version", sa.String(length=64), nullable=False),
        sa.Column("language", sa.String(length=16), nullable=False),
        sa.Column("report_mode", sa.String(length=32), nullable=False),
        sa.Column("layout", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("created_by", sa.String(length=256), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_report_templates")),
        sa.UniqueConstraint(
            "template_id", "version", "language", name=op.f("uq_report_templates_template_id_version_language")
        ),
        schema="reporting",
    )
    op.create_table(
        "reports",
        sa.Column("report_id", sa.Uuid(), nullable=False),
        sa.Column("token_digest", sa.String(length=64), nullable=False),
        sa.Column("session_id", sa.Uuid(), nullable=False),
        sa.Column("language", sa.String(length=16), nullable=False),
        sa.Column("report_mode", sa.String(length=32), nullable=False),
        sa.Column("requested_mode", sa.String(length=32), nullable=False),
        sa.Column("traits_shown", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("artefact", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("gate_evaluation", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("template_id", sa.String(length=128), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("withdrawn_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("withdrawn_reason", sa.Text(), nullable=True),
        sa.Column("created_by", sa.String(length=256), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("report_id", name=op.f("pk_reports")),
        sa.UniqueConstraint("token_digest", name=op.f("uq_reports_token_digest")),
        schema="reporting",
    )
    op.create_index(
        op.f("ix_reporting_reports_session_id"), "reports", ["session_id"], unique=False, schema="reporting"
    )
    op.create_table(
        "constructs",
        sa.Column("construct_id", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=256), nullable=False),
        sa.Column("kind", sa.String(length=64), nullable=True),
        sa.Column("dictionary_version", sa.String(length=64), nullable=False),
        sa.Column("definition", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("construct_id", name=op.f("pk_constructs")),
        schema="scored",
    )
    op.create_table(
        "feature_definitions",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("indicator_id", sa.String(length=128), nullable=False),
        sa.Column("pathway", sa.String(length=1), nullable=False),
        sa.Column("dictionary_version", sa.String(length=64), nullable=False),
        sa.Column("algorithm", sa.String(length=128), nullable=True),
        sa.Column("direction", sa.String(length=32), nullable=True),
        sa.Column("min_valid_trials", sa.Integer(), nullable=True),
        sa.Column("event_inputs", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("exclusions", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("definition", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_feature_definitions")),
        sa.UniqueConstraint(
            "indicator_id",
            "pathway",
            "dictionary_version",
            name=op.f("uq_feature_definitions_indicator_id_pathway_dictionary_version"),
        ),
        schema="scored",
    )
    op.create_table(
        "indicators",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("indicator_id", sa.String(length=128), nullable=False),
        sa.Column("pathway", sa.String(length=1), nullable=False),
        sa.Column("dictionary_version", sa.String(length=64), nullable=False),
        sa.Column("construct_id", sa.String(length=64), nullable=False),
        sa.Column("role", sa.String(length=32), nullable=True),
        sa.Column("tier", sa.Integer(), nullable=True),
        sa.Column("status", sa.String(length=32), nullable=True),
        sa.Column("kind", sa.String(length=64), nullable=True),
        sa.Column("module_id", sa.String(length=128), nullable=True),
        sa.Column("definition", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_indicators")),
        sa.UniqueConstraint(
            "indicator_id",
            "pathway",
            "dictionary_version",
            name=op.f("uq_indicators_indicator_id_pathway_dictionary_version"),
        ),
        schema="scored",
    )
    op.create_index(
        op.f("ix_scored_indicators_construct_id"), "indicators", ["construct_id"], unique=False, schema="scored"
    )
    op.create_index(
        op.f("ix_scored_indicators_indicator_id"), "indicators", ["indicator_id"], unique=False, schema="scored"
    )
    op.create_table(
        "scoring_runs",
        sa.Column("run_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(length=64), nullable=False),
        sa.Column("algorithm_version", sa.String(length=64), nullable=False),
        sa.Column("dictionary_versions", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("dictionary_sha256", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("engine", sa.String(length=128), nullable=False),
        sa.Column("inputs", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("manifest", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("job_id", sa.Uuid(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("run_id", name=op.f("pk_scoring_runs")),
        schema="scored",
    )
    op.create_table(
        "session_quality_flags",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("session_id", sa.Uuid(), nullable=False),
        sa.Column("flag_code", sa.String(length=64), nullable=False),
        sa.Column("severity", sa.String(length=16), nullable=False),
        sa.Column("details", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("algorithm_version", sa.String(length=64), nullable=False),
        sa.Column("detected_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_session_quality_flags")),
        schema="scored",
    )
    op.create_index(
        op.f("ix_scored_session_quality_flags_session_id"),
        "session_quality_flags",
        ["session_id"],
        unique=False,
        schema="scored",
    )
    op.create_index(
        "uq_session_quality_flags_open",
        "session_quality_flags",
        ["session_id", "flag_code"],
        unique=True,
        schema="scored",
        postgresql_where=sa.text("resolved_at IS NULL"),
    )
    op.create_table(
        "trait_estimates",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("session_id", sa.Uuid(), nullable=False),
        sa.Column("participant_pid", sa.String(length=26), nullable=True),
        sa.Column("trait", sa.String(length=64), nullable=False),
        sa.Column("pathway", sa.String(length=1), nullable=False),
        sa.Column("language", sa.String(length=16), nullable=False),
        sa.Column("composite", sa.Float(), nullable=True),
        sa.Column("sem", sa.Float(), nullable=True),
        sa.Column("band", sa.String(length=16), nullable=True),
        sa.Column("not_enough_to_say", sa.Boolean(), nullable=False),
        sa.Column("norm_table_version", sa.String(length=64), nullable=True),
        sa.Column("release_pack_version", sa.String(length=64), nullable=True),
        sa.Column("is_current", sa.Boolean(), nullable=False),
        sa.Column("algorithm_version", sa.String(length=64), nullable=False),
        sa.Column("dictionary_version", sa.String(length=64), nullable=True),
        sa.Column("source_refs", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("data_snapshot_id", sa.Uuid(), nullable=True),
        sa.Column("job_id", sa.Uuid(), nullable=True),
        sa.Column("computed_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_trait_estimates")),
        schema="scored",
    )
    op.create_index(
        op.f("ix_scored_trait_estimates_participant_pid"),
        "trait_estimates",
        ["participant_pid"],
        unique=False,
        schema="scored",
    )
    op.create_index(
        op.f("ix_scored_trait_estimates_session_id"), "trait_estimates", ["session_id"], unique=False, schema="scored"
    )
    op.create_table(
        "trait_mappings",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("construct_id", sa.String(length=64), nullable=False),
        sa.Column("pathway", sa.String(length=1), nullable=True),
        sa.Column("relation", sa.String(length=32), nullable=False),
        sa.Column("indicator_id", sa.String(length=128), nullable=True),
        sa.Column("criterion_ref", sa.String(length=256), nullable=True),
        sa.Column("expected_sign", sa.String(length=16), nullable=True),
        sa.Column("expected_r_low", sa.Float(), nullable=True),
        sa.Column("expected_r_high", sa.Float(), nullable=True),
        sa.Column("dictionary_version", sa.String(length=64), nullable=False),
        sa.Column("details", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_trait_mappings")),
        schema="scored",
    )
    op.create_index(
        op.f("ix_scored_trait_mappings_construct_id"), "trait_mappings", ["construct_id"], unique=False, schema="scored"
    )
    op.create_table(
        "trials_canonical",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("session_id", sa.Uuid(), nullable=False),
        sa.Column("participant_pid", sa.String(length=26), nullable=True),
        sa.Column("episode_id", sa.String(length=128), nullable=True),
        sa.Column("module_id", sa.String(length=128), nullable=True),
        sa.Column("block_id", sa.String(length=128), nullable=True),
        sa.Column("trial_id", sa.String(length=128), nullable=False),
        sa.Column("trial_index", sa.Integer(), nullable=False),
        sa.Column("phase", sa.String(length=32), nullable=True),
        sa.Column("condition_id", sa.String(length=128), nullable=True),
        sa.Column("scorable", sa.Boolean(), nullable=False),
        sa.Column("start_seq", sa.Integer(), nullable=True),
        sa.Column("end_seq", sa.Integer(), nullable=True),
        sa.Column("outcome", sa.String(length=32), nullable=True),
        sa.Column("correctness", sa.Boolean(), nullable=True),
        sa.Column("latency_ms", sa.Float(), nullable=True),
        sa.Column("input_mode", sa.String(length=32), nullable=True),
        sa.Column("timing_flag", sa.String(length=32), nullable=True),
        sa.Column("interrupted", sa.Boolean(), nullable=False),
        sa.Column("complete", sa.Boolean(), nullable=False),
        sa.Column("eligible", sa.Boolean(), nullable=False),
        sa.Column("exclusion_reasons", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("algorithm_version", sa.String(length=64), nullable=False),
        sa.Column("dictionary_version", sa.String(length=64), nullable=True),
        sa.Column("source_refs", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("data_snapshot_id", sa.Uuid(), nullable=True),
        sa.Column("job_id", sa.Uuid(), nullable=True),
        sa.Column("computed_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_trials_canonical")),
        sa.UniqueConstraint(
            "session_id",
            "module_id",
            "block_id",
            "trial_id",
            "trial_index",
            name=op.f("uq_trials_canonical_session_id_module_id_block_id_trial_id_trial_index"),
        ),
        schema="scored",
    )
    op.create_index(
        op.f("ix_scored_trials_canonical_participant_pid"),
        "trials_canonical",
        ["participant_pid"],
        unique=False,
        schema="scored",
    )
    op.create_index(
        op.f("ix_scored_trials_canonical_session_id"), "trials_canonical", ["session_id"], unique=False, schema="scored"
    )
    op.create_table(
        "studies",
        sa.Column("study_id", sa.String(length=128), nullable=False),
        sa.Column("code", sa.String(length=16), nullable=False),
        sa.Column("name", sa.String(length=256), nullable=False),
        sa.Column("stage", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("requires_prereg", sa.Boolean(), nullable=False),
        sa.Column("prereg_id", sa.String(length=256), nullable=True),
        sa.Column("current_protocol_version", sa.String(length=64), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("config", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("target_sample", sa.Integer(), nullable=True),
        sa.Column("power_record", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("frozen_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_by", sa.String(length=256), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("study_id", name=op.f("pk_studies")),
        schema="study",
    )
    op.create_table(
        "analysis_plans",
        sa.Column("plan_id", sa.Uuid(), nullable=False),
        sa.Column("study_id", sa.String(length=128), nullable=False),
        sa.Column("version", sa.String(length=64), nullable=False),
        sa.Column("prereg_id", sa.String(length=256), nullable=True),
        sa.Column("hypotheses_version", sa.String(length=64), nullable=False),
        sa.Column("hypotheses_sha256", sa.String(length=64), nullable=False),
        sa.Column("gates_version", sa.String(length=64), nullable=False),
        sa.Column("gates_sha256", sa.String(length=64), nullable=False),
        sa.Column("dictionary_sha256", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("document", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("registry_url", sa.String(length=512), nullable=True),
        sa.Column("registered_by", sa.String(length=256), nullable=False),
        sa.Column("registered_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("plan_id", name=op.f("pk_analysis_plans")),
        sa.UniqueConstraint("study_id", "version", name=op.f("uq_analysis_plans_study_id_version")),
        schema="validation",
    )
    op.create_index(
        op.f("ix_validation_analysis_plans_study_id"), "analysis_plans", ["study_id"], unique=False, schema="validation"
    )
    op.create_table(
        "battery_gates",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("language", sa.String(length=16), nullable=False),
        sa.Column("pathway", sa.String(length=1), nullable=False),
        sa.Column("site_mode", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("evidence_ids", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("approvers", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("effective_from", sa.DateTime(timezone=True), nullable=False),
        sa.Column("gates_version", sa.String(length=64), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("recorded_by", sa.String(length=256), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_battery_gates")),
        schema="validation",
    )
    op.create_table(
        "dataset_snapshots",
        sa.Column("snapshot_id", sa.Uuid(), nullable=False),
        sa.Column("study_id", sa.String(length=128), nullable=False),
        sa.Column("name", sa.String(length=256), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("spec", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("manifest", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("exclusions", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("parquet_path", sa.String(length=1024), nullable=True),
        sa.Column("sha256", sa.String(length=64), nullable=True),
        sa.Column("row_count", sa.Integer(), nullable=True),
        sa.Column("n_participants", sa.Integer(), nullable=True),
        sa.Column("job_id", sa.Uuid(), nullable=True),
        sa.Column("created_by", sa.String(length=256), nullable=False),
        sa.Column("frozen_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("frozen_by", sa.String(length=256), nullable=True),
        sa.Column("tombstoned_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("tombstone_reason", sa.Text(), nullable=True),
        sa.Column("supersedes_id", sa.Uuid(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("snapshot_id", name=op.f("pk_dataset_snapshots")),
        schema="validation",
    )
    op.create_index(
        op.f("ix_validation_dataset_snapshots_study_id"),
        "dataset_snapshots",
        ["study_id"],
        unique=False,
        schema="validation",
    )
    op.create_table(
        "indicator_decisions",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("indicator_id", sa.String(length=128), nullable=False),
        sa.Column("pathway", sa.String(length=1), nullable=False),
        sa.Column("decision", sa.String(length=32), nullable=False),
        sa.Column("provisional_flags", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("rationale", sa.Text(), nullable=False),
        sa.Column("evidence_ids", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("signers", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_indicator_decisions")),
        schema="validation",
    )
    op.create_index(
        op.f("ix_validation_indicator_decisions_indicator_id"),
        "indicator_decisions",
        ["indicator_id"],
        unique=False,
        schema="validation",
    )
    op.create_table(
        "matched_records",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("pid", sa.String(length=26), nullable=False),
        sa.Column("study_id", sa.String(length=128), nullable=False),
        sa.Column("occasion_id", sa.String(length=128), nullable=False),
        sa.Column("session_ids", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("instrument_versions", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("game_versions", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("has_game", sa.Boolean(), nullable=False),
        sa.Column("has_criterion", sa.Boolean(), nullable=False),
        sa.Column("issues", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("algorithm_version", sa.String(length=64), nullable=False),
        sa.Column("dictionary_version", sa.String(length=64), nullable=True),
        sa.Column("source_refs", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("data_snapshot_id", sa.Uuid(), nullable=True),
        sa.Column("job_id", sa.Uuid(), nullable=True),
        sa.Column("computed_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_matched_records")),
        sa.UniqueConstraint("pid", "study_id", "occasion_id", name=op.f("uq_matched_records_pid_study_id_occasion_id")),
        schema="validation",
    )
    op.create_index(
        op.f("ix_validation_matched_records_pid"), "matched_records", ["pid"], unique=False, schema="validation"
    )
    op.create_table(
        "reference_populations",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=256), nullable=False),
        sa.Column("language", sa.String(length=16), nullable=False),
        sa.Column("pathway", sa.String(length=1), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("snapshot_id", sa.Uuid(), nullable=True),
        sa.Column("weights_scheme", sa.String(length=128), nullable=True),
        sa.Column("effective_n", sa.Integer(), nullable=True),
        sa.Column("created_by", sa.String(length=256), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_reference_populations")),
        schema="validation",
    )
    op.create_table(
        "release_packs",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("release_pack_version", sa.String(length=64), nullable=False),
        sa.Column("issued_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("pack", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("key_id", sa.String(length=128), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_by", sa.String(length=256), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_release_packs")),
        sa.UniqueConstraint("release_pack_version", name=op.f("uq_release_packs_release_pack_version")),
        schema="validation",
    )
    op.create_table(
        "score_interpretations",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("trait", sa.String(length=64), nullable=False),
        sa.Column("band", sa.String(length=16), nullable=False),
        sa.Column("phrase_key", sa.String(length=128), nullable=False),
        sa.Column("version", sa.String(length=64), nullable=False),
        sa.Column("approved", sa.Boolean(), nullable=False),
        sa.Column("approved_by", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_score_interpretations")),
        sa.UniqueConstraint("trait", "band", "version", name=op.f("uq_score_interpretations_trait_band_version")),
        schema="validation",
    )
    op.create_table(
        "trait_gates",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("trait", sa.String(length=64), nullable=False),
        sa.Column("language", sa.String(length=16), nullable=False),
        sa.Column("pathway", sa.String(length=1), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("evidence_ids", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("approvers", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("effective_from", sa.DateTime(timezone=True), nullable=False),
        sa.Column("gates_version", sa.String(length=64), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("recorded_by", sa.String(length=256), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_trait_gates")),
        schema="validation",
    )
    op.create_table(
        "receipts",
        sa.Column("receipt_id", sa.Uuid(), nullable=False),
        sa.Column("request_id", sa.Uuid(), nullable=False),
        sa.Column("body", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("signature", sa.String(length=256), nullable=False),
        sa.Column("key_id", sa.String(length=128), nullable=False),
        sa.Column("issued_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["request_id"],
            ["consent.erasure_requests.request_id"],
            name=op.f("fk_receipts_request_id_erasure_requests"),
        ),
        sa.PrimaryKeyConstraint("receipt_id", name=op.f("pk_receipts")),
        schema="consent",
    )
    op.create_table(
        "import_rows",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("import_id", sa.Uuid(), nullable=False),
        sa.Column("row_number", sa.Integer(), nullable=False),
        sa.Column("pid", sa.String(length=26), nullable=True),
        sa.Column("values", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("issues", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("resolved_by", sa.String(length=256), nullable=True),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("resolution_note", sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(
            ["import_id"],
            ["criterion.imports.import_id"],
            name=op.f("fk_import_rows_import_id_imports"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_import_rows")),
        sa.UniqueConstraint("import_id", "row_number", name=op.f("uq_import_rows_import_id_row_number")),
        schema="criterion",
    )
    op.create_index(
        op.f("ix_criterion_import_rows_status"), "import_rows", ["status"], unique=False, schema="criterion"
    )
    op.create_table(
        "instrument_versions",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("instrument_id", sa.String(length=128), nullable=False),
        sa.Column("version", sa.String(length=64), nullable=False),
        sa.Column("key_version", sa.String(length=64), nullable=False),
        sa.Column("definition", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("source_path", sa.String(length=512), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["instrument_id"],
            ["criterion.instruments.instrument_id"],
            name=op.f("fk_instrument_versions_instrument_id_instruments"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_instrument_versions")),
        sa.UniqueConstraint("instrument_id", "version", name=op.f("uq_instrument_versions_instrument_id_version")),
        schema="criterion",
    )
    op.create_table(
        "permissions",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("instrument_id", sa.String(length=128), nullable=False),
        sa.Column("language", sa.String(length=16), nullable=True),
        sa.Column("holder", sa.String(length=256), nullable=False),
        sa.Column("licence", sa.String(length=256), nullable=False),
        sa.Column("permission_status", sa.String(length=32), nullable=False),
        sa.Column("permission_document", sa.String(length=256), nullable=True),
        sa.Column("allowed_use", sa.Text(), nullable=False),
        sa.Column("expiry", sa.Date(), nullable=True),
        sa.Column("commercial_use", sa.Boolean(), nullable=False),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("recorded_by", sa.String(length=256), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["instrument_id"],
            ["criterion.instruments.instrument_id"],
            name=op.f("fk_permissions_instrument_id_instruments"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_permissions")),
        schema="criterion",
    )
    op.create_index(
        op.f("ix_criterion_permissions_instrument_id"),
        "permissions",
        ["instrument_id"],
        unique=False,
        schema="criterion",
    )
    op.create_table(
        "game_versions",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("game_id", sa.String(length=128), nullable=False),
        sa.Column("version", sa.String(length=64), nullable=False),
        sa.Column("config_id", sa.String(length=128), nullable=False),
        sa.Column("config", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("approved_by", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("source_path", sa.String(length=512), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["game_id"], ["games.games.game_id"], name=op.f("fk_game_versions_game_id_games")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_game_versions")),
        sa.UniqueConstraint("game_id", "version", name=op.f("uq_game_versions_game_id_version")),
        schema="games",
    )
    op.create_table(
        "deployments",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("kiosk_id", sa.String(length=64), nullable=False),
        sa.Column("site_id", sa.String(length=128), nullable=False),
        sa.Column("site_mode", sa.String(length=32), nullable=False),
        sa.Column("study_id", sa.String(length=128), nullable=True),
        sa.Column("policy_version", sa.String(length=64), nullable=False),
        sa.Column("app_version", sa.String(length=64), nullable=False),
        sa.Column("content_version_id", sa.Uuid(), nullable=True),
        sa.Column("ring", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("effective_from", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("created_by", sa.String(length=256), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["kiosk_id"], ["governance.kiosks.kiosk_id"], name=op.f("fk_deployments_kiosk_id_kiosks")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_deployments")),
        schema="governance",
    )
    op.create_index(
        op.f("ix_governance_deployments_kiosk_id"), "deployments", ["kiosk_id"], unique=False, schema="governance"
    )
    op.create_table(
        "batch_chunks",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("batch_id", sa.Uuid(), nullable=False),
        sa.Column("session_id", sa.Uuid(), nullable=False),
        sa.Column("encryption", sa.String(length=32), nullable=False),
        sa.Column("first_seq", sa.Integer(), nullable=False),
        sa.Column("last_seq", sa.Integer(), nullable=False),
        sa.Column("event_count", sa.Integer(), nullable=False),
        sa.Column("body", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.ForeignKeyConstraint(
            ["batch_id"],
            ["kiosk_raw.batches.batch_id"],
            name=op.f("fk_batch_chunks_batch_id_batches"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_batch_chunks")),
        sa.UniqueConstraint("batch_id", "session_id", name=op.f("uq_batch_chunks_batch_id_session_id")),
        schema="kiosk_raw",
    )
    op.create_index(
        op.f("ix_kiosk_raw_batch_chunks_session_id"), "batch_chunks", ["session_id"], unique=False, schema="kiosk_raw"
    )
    op.create_table(
        "pairing_codes",
        sa.Column("code", sa.String(length=8), nullable=False),
        sa.Column("qr_token_digest", sa.String(length=64), nullable=False),
        sa.Column("pid", sa.String(length=26), nullable=False),
        sa.Column("study_id", sa.String(length=128), nullable=True),
        sa.Column("occasion_id", sa.String(length=128), nullable=True),
        sa.Column("visit_number", sa.Integer(), nullable=False),
        sa.Column("created_by", sa.String(length=256), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("used_session_id", sa.Uuid(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["pid"], ["linkage.participants.pid"], name=op.f("fk_pairing_codes_pid_participants"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("code", name=op.f("pk_pairing_codes")),
        sa.UniqueConstraint("qr_token_digest", name=op.f("uq_pairing_codes_qr_token_digest")),
        schema="linkage",
    )
    op.create_index(op.f("ix_linkage_pairing_codes_pid"), "pairing_codes", ["pid"], unique=False, schema="linkage")
    op.create_table(
        "participant_links",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("pid", sa.String(length=26), nullable=False),
        sa.Column("session_id", sa.Uuid(), nullable=False),
        sa.Column("study_id", sa.String(length=128), nullable=True),
        sa.Column("occasion_id", sa.String(length=128), nullable=True),
        sa.Column("visit_number", sa.Integer(), nullable=False),
        sa.Column("method", sa.String(length=32), nullable=False),
        sa.Column("linked_by", sa.String(length=256), nullable=False),
        sa.Column("second_linker", sa.String(length=256), nullable=True),
        sa.Column("confidence", sa.Float(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["pid"],
            ["linkage.participants.pid"],
            name=op.f("fk_participant_links_pid_participants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_participant_links")),
        sa.UniqueConstraint("session_id", name=op.f("uq_participant_links_session_id")),
        schema="linkage",
    )
    op.create_index(
        op.f("ix_linkage_participant_links_pid"), "participant_links", ["pid"], unique=False, schema="linkage"
    )
    op.create_table(
        "indicators_long",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("session_id", sa.Uuid(), nullable=False),
        sa.Column("participant_pid", sa.String(length=26), nullable=True),
        sa.Column("study_id", sa.String(length=128), nullable=True),
        sa.Column("occasion_id", sa.String(length=128), nullable=True),
        sa.Column("indicator_id", sa.String(length=128), nullable=False),
        sa.Column("construct_id", sa.String(length=64), nullable=True),
        sa.Column("pathway", sa.String(length=1), nullable=True),
        sa.Column("value", sa.Float(), nullable=True),
        sa.Column("n_valid_trials", sa.Integer(), nullable=True),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("quality_flags", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("scoring_run_id", sa.Uuid(), nullable=True),
        sa.Column("is_current", sa.Boolean(), nullable=False),
        sa.Column("algorithm_version", sa.String(length=64), nullable=False),
        sa.Column("dictionary_version", sa.String(length=64), nullable=True),
        sa.Column("source_refs", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("data_snapshot_id", sa.Uuid(), nullable=True),
        sa.Column("job_id", sa.Uuid(), nullable=True),
        sa.Column("computed_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["scoring_run_id"],
            ["scored.scoring_runs.run_id"],
            name=op.f("fk_indicators_long_scoring_run_id_scoring_runs"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_indicators_long")),
        schema="scored",
    )
    op.create_index(
        "ix_indicators_long_current",
        "indicators_long",
        ["session_id", "indicator_id"],
        unique=False,
        schema="scored",
        postgresql_where=sa.text("is_current"),
    )
    op.create_index(
        op.f("ix_scored_indicators_long_indicator_id"),
        "indicators_long",
        ["indicator_id"],
        unique=False,
        schema="scored",
    )
    op.create_index(
        op.f("ix_scored_indicators_long_participant_pid"),
        "indicators_long",
        ["participant_pid"],
        unique=False,
        schema="scored",
    )
    op.create_index(
        op.f("ix_scored_indicators_long_session_id"), "indicators_long", ["session_id"], unique=False, schema="scored"
    )
    op.create_table(
        "arms",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("study_id", sa.String(length=128), nullable=False),
        sa.Column("arm_id", sa.String(length=64), nullable=False),
        sa.Column("ratio", sa.Integer(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["study_id"], ["study.studies.study_id"], name=op.f("fk_arms_study_id_studies")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_arms")),
        sa.UniqueConstraint("study_id", "arm_id", name=op.f("uq_arms_study_id_arm_id")),
        schema="study",
    )
    op.create_table(
        "cohorts",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("study_id", sa.String(length=128), nullable=False),
        sa.Column("cohort_id", sa.String(length=128), nullable=False),
        sa.Column("name", sa.String(length=256), nullable=False),
        sa.Column("criteria", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("holdout", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["study_id"], ["study.studies.study_id"], name=op.f("fk_cohorts_study_id_studies")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_cohorts")),
        sa.UniqueConstraint("study_id", "cohort_id", name=op.f("uq_cohorts_study_id_cohort_id")),
        schema="study",
    )
    op.create_table(
        "dataset_freezes",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("study_id", sa.String(length=128), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("snapshot_ids", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("frozen_by", sa.String(length=256), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["study_id"], ["study.studies.study_id"], name=op.f("fk_dataset_freezes_study_id_studies")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_dataset_freezes")),
        schema="study",
    )
    op.create_table(
        "deviations",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("study_id", sa.String(length=128), nullable=False),
        sa.Column("pid", sa.String(length=26), nullable=True),
        sa.Column("session_id", sa.String(length=64), nullable=True),
        sa.Column("category", sa.String(length=64), nullable=False),
        sa.Column("severity", sa.String(length=16), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("reported_by", sa.String(length=256), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["study_id"], ["study.studies.study_id"], name=op.f("fk_deviations_study_id_studies")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_deviations")),
        schema="study",
    )
    op.create_table(
        "enrollments",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("study_id", sa.String(length=128), nullable=False),
        sa.Column("pid", sa.String(length=26), nullable=False),
        sa.Column("cohort_id", sa.String(length=128), nullable=True),
        sa.Column("cell_key", sa.String(length=256), nullable=True),
        sa.Column("cell", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("arm_id", sa.String(length=64), nullable=True),
        sa.Column("criterion_block", sa.String(length=8), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("eligibility", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("enrolled_by", sa.String(length=256), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["pid"], ["linkage.participants.pid"], name=op.f("fk_enrollments_pid_participants"), ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["study_id"], ["study.studies.study_id"], name=op.f("fk_enrollments_study_id_studies")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_enrollments")),
        sa.UniqueConstraint("study_id", "pid", name=op.f("uq_enrollments_study_id_pid")),
        schema="study",
    )
    op.create_index(op.f("ix_study_enrollments_pid"), "enrollments", ["pid"], unique=False, schema="study")
    op.create_table(
        "measurement_occasions",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("study_id", sa.String(length=128), nullable=False),
        sa.Column("occasion_id", sa.String(length=128), nullable=False),
        sa.Column("wave", sa.Integer(), nullable=False),
        sa.Column("label", sa.String(length=256), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("offset_days_min", sa.Integer(), nullable=True),
        sa.Column("offset_days_max", sa.Integer(), nullable=True),
        sa.Column("instruments", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("game_required", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["study_id"], ["study.studies.study_id"], name=op.f("fk_measurement_occasions_study_id_studies")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_measurement_occasions")),
        sa.UniqueConstraint("study_id", "occasion_id", name=op.f("uq_measurement_occasions_study_id_occasion_id")),
        schema="study",
    )
    op.create_table(
        "protocol_versions",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("study_id", sa.String(length=128), nullable=False),
        sa.Column("version", sa.String(length=64), nullable=False),
        sa.Column("document_sha256", sa.String(length=64), nullable=False),
        sa.Column("summary", sa.Text(), nullable=True),
        sa.Column("game_config", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("battery", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("effective_from", sa.DateTime(timezone=True), nullable=False),
        sa.Column("approved_by", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("created_by", sa.String(length=256), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["study_id"], ["study.studies.study_id"], name=op.f("fk_protocol_versions_study_id_studies")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_protocol_versions")),
        sa.UniqueConstraint("study_id", "version", name=op.f("uq_protocol_versions_study_id_version")),
        schema="study",
    )
    op.create_table(
        "quotas",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("study_id", sa.String(length=128), nullable=False),
        sa.Column("cell_key", sa.String(length=256), nullable=False),
        sa.Column("cell", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("target", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["study_id"], ["study.studies.study_id"], name=op.f("fk_quotas_study_id_studies")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_quotas")),
        sa.UniqueConstraint("study_id", "cell_key", name=op.f("uq_quotas_study_id_cell_key")),
        schema="study",
    )
    op.create_table(
        "randomisation_blocks",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("study_id", sa.String(length=128), nullable=False),
        sa.Column("cell_key", sa.String(length=256), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("block", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("blocks_used", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(
            ["study_id"], ["study.studies.study_id"], name=op.f("fk_randomisation_blocks_study_id_studies")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_randomisation_blocks")),
        sa.UniqueConstraint(
            "study_id", "cell_key", "kind", name=op.f("uq_randomisation_blocks_study_id_cell_key_kind")
        ),
        schema="study",
    )
    op.create_table(
        "retest_schedules",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("study_id", sa.String(length=128), nullable=False),
        sa.Column("pid", sa.String(length=26), nullable=False),
        sa.Column("occasion_id", sa.String(length=128), nullable=False),
        sa.Column("anchor_date", sa.Date(), nullable=False),
        sa.Column("window_start", sa.Date(), nullable=False),
        sa.Column("window_end", sa.Date(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("channel", sa.String(length=16), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["pid"], ["linkage.participants.pid"], name=op.f("fk_retest_schedules_pid_participants"), ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["study_id"], ["study.studies.study_id"], name=op.f("fk_retest_schedules_study_id_studies")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_retest_schedules")),
        sa.UniqueConstraint(
            "study_id", "pid", "occasion_id", name=op.f("uq_retest_schedules_study_id_pid_occasion_id")
        ),
        schema="study",
    )
    op.create_index(op.f("ix_study_retest_schedules_pid"), "retest_schedules", ["pid"], unique=False, schema="study")
    op.create_table(
        "model_versions",
        sa.Column("model_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("version", sa.String(length=64), nullable=False),
        sa.Column("comparison", sa.String(length=64), nullable=False),
        sa.Column("target", sa.String(length=256), nullable=False),
        sa.Column("features", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("algorithm", sa.String(length=64), nullable=False),
        sa.Column("params", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("snapshot_id", sa.Uuid(), nullable=False),
        sa.Column("holdout_cohort", sa.String(length=128), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("created_by", sa.String(length=256), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["snapshot_id"],
            ["validation.dataset_snapshots.snapshot_id"],
            name=op.f("fk_model_versions_snapshot_id_dataset_snapshots"),
        ),
        sa.PrimaryKeyConstraint("model_id", name=op.f("pk_model_versions")),
        sa.UniqueConstraint("name", "version", name=op.f("uq_model_versions_name_version")),
        schema="validation",
    )
    op.create_table(
        "norm_tables",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("norm_table_version", sa.String(length=64), nullable=False),
        sa.Column("trait", sa.String(length=64), nullable=False),
        sa.Column("pathway", sa.String(length=1), nullable=False),
        sa.Column("language", sa.String(length=16), nullable=False),
        sa.Column("reference_population_id", sa.Uuid(), nullable=True),
        sa.Column("cut_points", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("sem", sa.Float(), nullable=False),
        sa.Column("ci_level", sa.Float(), nullable=False),
        sa.Column("provisional", sa.Boolean(), nullable=False),
        sa.Column("effective_n", sa.Integer(), nullable=False),
        sa.Column("method", sa.String(length=64), nullable=False),
        sa.Column("coefficients", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("approved_by", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("created_by", sa.String(length=256), nullable=False),
        sa.Column("algorithm_version", sa.String(length=64), nullable=False),
        sa.Column("dictionary_version", sa.String(length=64), nullable=True),
        sa.Column("source_refs", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("data_snapshot_id", sa.Uuid(), nullable=True),
        sa.Column("job_id", sa.Uuid(), nullable=True),
        sa.Column("computed_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["reference_population_id"],
            ["validation.reference_populations.id"],
            name=op.f("fk_norm_tables_reference_population_id_reference_populations"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_norm_tables")),
        sa.UniqueConstraint(
            "norm_table_version",
            "trait",
            "pathway",
            "language",
            name=op.f("uq_norm_tables_norm_table_version_trait_pathway_language"),
        ),
        schema="validation",
    )
    op.create_table(
        "snapshot_members",
        sa.Column("snapshot_id", sa.Uuid(), nullable=False),
        sa.Column("pid", sa.String(length=26), nullable=False),
        sa.ForeignKeyConstraint(
            ["snapshot_id"],
            ["validation.dataset_snapshots.snapshot_id"],
            name=op.f("fk_snapshot_members_snapshot_id_dataset_snapshots"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("snapshot_id", "pid", name=op.f("pk_snapshot_members")),
        schema="validation",
    )
    op.create_index(
        op.f("ix_validation_snapshot_members_pid"), "snapshot_members", ["pid"], unique=False, schema="validation"
    )
    op.create_table(
        "validation_runs",
        sa.Column("run_id", sa.Uuid(), nullable=False),
        sa.Column("snapshot_id", sa.Uuid(), nullable=False),
        sa.Column("analysis", sa.String(length=64), nullable=False),
        sa.Column("params", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("hypothesis_ids", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("confirmatory", sa.Boolean(), nullable=False),
        sa.Column("analysis_plan_id", sa.Uuid(), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("job_id", sa.Uuid(), nullable=True),
        sa.Column("engine", sa.String(length=128), nullable=True),
        sa.Column("manifest", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("created_by", sa.String(length=256), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["snapshot_id"],
            ["validation.dataset_snapshots.snapshot_id"],
            name=op.f("fk_validation_runs_snapshot_id_dataset_snapshots"),
        ),
        sa.PrimaryKeyConstraint("run_id", name=op.f("pk_validation_runs")),
        schema="validation",
    )
    op.create_table(
        "items",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("instrument_version_id", sa.BigInteger(), nullable=False),
        sa.Column("item_id", sa.String(length=128), nullable=False),
        sa.Column("number", sa.Integer(), nullable=False),
        sa.Column("subscales", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("reverse_keyed", sa.Boolean(), nullable=False),
        sa.Column("attention_check", sa.Boolean(), nullable=False),
        sa.Column("block", sa.String(length=32), nullable=True),
        sa.Column("item_text_source", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.ForeignKeyConstraint(
            ["instrument_version_id"],
            ["criterion.instrument_versions.id"],
            name=op.f("fk_items_instrument_version_id_instrument_versions"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_items")),
        sa.UniqueConstraint("instrument_version_id", "item_id", name=op.f("uq_items_instrument_version_id_item_id")),
        schema="criterion",
    )
    op.create_table(
        "keys",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("instrument_version_id", sa.BigInteger(), nullable=False),
        sa.Column("key_version", sa.String(length=64), nullable=False),
        sa.Column("prorate_min_prop", sa.Float(), nullable=False),
        sa.Column("reverse_formula", sa.String(length=64), nullable=True),
        sa.Column("reverse_items", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("scales", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["instrument_version_id"],
            ["criterion.instrument_versions.id"],
            name=op.f("fk_keys_instrument_version_id_instrument_versions"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_keys")),
        sa.UniqueConstraint(
            "instrument_version_id", "key_version", name=op.f("uq_keys_instrument_version_id_key_version")
        ),
        schema="criterion",
    )
    op.create_table(
        "language_versions",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("instrument_version_id", sa.BigInteger(), nullable=False),
        sa.Column("language", sa.String(length=16), nullable=False),
        sa.Column("itc_state", sa.String(length=32), nullable=False),
        sa.Column("approved", sa.Boolean(), nullable=False),
        sa.Column("translation_permission", sa.String(length=32), nullable=False),
        sa.Column("approved_by", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["instrument_version_id"],
            ["criterion.instrument_versions.id"],
            name=op.f("fk_language_versions_instrument_version_id_instrument_versions"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_language_versions")),
        sa.UniqueConstraint(
            "instrument_version_id", "language", name=op.f("uq_language_versions_instrument_version_id_language")
        ),
        schema="criterion",
    )
    op.create_table(
        "conditions",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("game_version_id", sa.BigInteger(), nullable=False),
        sa.Column("condition_id", sa.String(length=128), nullable=False),
        sa.Column("phase", sa.String(length=32), nullable=True),
        sa.Column("details", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.ForeignKeyConstraint(
            ["game_version_id"],
            ["games.game_versions.id"],
            name=op.f("fk_conditions_game_version_id_game_versions"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_conditions")),
        sa.UniqueConstraint("game_version_id", "condition_id", name=op.f("uq_conditions_game_version_id_condition_id")),
        schema="games",
    )
    op.create_table(
        "episodes",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("game_version_id", sa.BigInteger(), nullable=False),
        sa.Column("episode_id", sa.String(length=128), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("details", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.ForeignKeyConstraint(
            ["game_version_id"],
            ["games.game_versions.id"],
            name=op.f("fk_episodes_game_version_id_game_versions"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_episodes")),
        sa.UniqueConstraint("game_version_id", "episode_id", name=op.f("uq_episodes_game_version_id_episode_id")),
        schema="games",
    )
    op.create_table(
        "stimuli",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("game_version_id", sa.BigInteger(), nullable=False),
        sa.Column("stimulus_id", sa.String(length=128), nullable=False),
        sa.Column("stimulus_version", sa.String(length=64), nullable=True),
        sa.Column("attributes", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.ForeignKeyConstraint(
            ["game_version_id"],
            ["games.game_versions.id"],
            name=op.f("fk_stimuli_game_version_id_game_versions"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_stimuli")),
        sa.UniqueConstraint("game_version_id", "stimulus_id", name=op.f("uq_stimuli_game_version_id_stimulus_id")),
        schema="games",
    )
    op.create_table(
        "trial_definitions",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("game_version_id", sa.BigInteger(), nullable=False),
        sa.Column("block_id", sa.String(length=128), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("phase", sa.String(length=32), nullable=False),
        sa.Column("condition_id", sa.String(length=128), nullable=True),
        sa.Column("planned_trials", sa.Integer(), nullable=False),
        sa.Column("min_trials", sa.Integer(), nullable=False),
        sa.Column("scorable", sa.Boolean(), nullable=False),
        sa.Column("details", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.ForeignKeyConstraint(
            ["game_version_id"],
            ["games.game_versions.id"],
            name=op.f("fk_trial_definitions_game_version_id_game_versions"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_trial_definitions")),
        sa.UniqueConstraint("game_version_id", "block_id", name=op.f("uq_trial_definitions_game_version_id_block_id")),
        schema="games",
    )
    op.create_table(
        "statistical_results",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("run_id", sa.Uuid(), nullable=False),
        sa.Column("subject", sa.String(length=256), nullable=False),
        sa.Column("subject_kind", sa.String(length=32), nullable=False),
        sa.Column("metric", sa.String(length=64), nullable=False),
        sa.Column("estimate", sa.Float(), nullable=True),
        sa.Column("ci_low", sa.Float(), nullable=True),
        sa.Column("ci_high", sa.Float(), nullable=True),
        sa.Column("ci_level", sa.Float(), nullable=True),
        sa.Column("n", sa.Integer(), nullable=True),
        sa.Column("threshold", sa.Float(), nullable=True),
        sa.Column("passed", sa.Boolean(), nullable=True),
        sa.Column("hypothesis_id", sa.String(length=128), nullable=True),
        sa.Column("exploratory", sa.Boolean(), nullable=False),
        sa.Column("method", sa.String(length=128), nullable=False),
        sa.Column("subgroup", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("details", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.ForeignKeyConstraint(
            ["run_id"],
            ["validation.validation_runs.run_id"],
            name=op.f("fk_statistical_results_run_id_validation_runs"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_statistical_results")),
        schema="validation",
    )
    op.create_index(
        op.f("ix_validation_statistical_results_run_id"),
        "statistical_results",
        ["run_id"],
        unique=False,
        schema="validation",
    )
    op.create_table(
        "training_runs",
        sa.Column("run_id", sa.Uuid(), nullable=False),
        sa.Column("model_id", sa.Uuid(), nullable=False),
        sa.Column("job_id", sa.Uuid(), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("cv_scheme", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("engine", sa.String(length=128), nullable=True),
        sa.Column("metrics", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["model_id"], ["validation.model_versions.model_id"], name=op.f("fk_training_runs_model_id_model_versions")
        ),
        sa.PrimaryKeyConstraint("run_id", name=op.f("pk_training_runs")),
        schema="validation",
    )
    op.create_index(
        op.f("ix_validation_training_runs_model_id"), "training_runs", ["model_id"], unique=False, schema="validation"
    )
    op.create_table(
        "model_evaluations",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("model_id", sa.Uuid(), nullable=False),
        sa.Column("training_run_id", sa.Uuid(), nullable=False),
        sa.Column("split", sa.String(length=16), nullable=False),
        sa.Column("metric", sa.String(length=32), nullable=False),
        sa.Column("value", sa.Float(), nullable=True),
        sa.Column("sd", sa.Float(), nullable=True),
        sa.Column("n", sa.Integer(), nullable=True),
        sa.Column("details", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["model_id"],
            ["validation.model_versions.model_id"],
            name=op.f("fk_model_evaluations_model_id_model_versions"),
        ),
        sa.ForeignKeyConstraint(
            ["training_run_id"],
            ["validation.training_runs.run_id"],
            name=op.f("fk_model_evaluations_training_run_id_training_runs"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_model_evaluations")),
        schema="validation",
    )
    op.create_index(
        op.f("ix_validation_model_evaluations_model_id"),
        "model_evaluations",
        ["model_id"],
        unique=False,
        schema="validation",
    )
    op.create_table(
        "predictions",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("model_id", sa.Uuid(), nullable=False),
        sa.Column("training_run_id", sa.Uuid(), nullable=False),
        sa.Column("research_id", sa.String(length=64), nullable=False),
        sa.Column("occasion_id", sa.String(length=128), nullable=True),
        sa.Column("fold", sa.Integer(), nullable=True),
        sa.Column("split", sa.String(length=16), nullable=False),
        sa.Column("predicted", sa.Float(), nullable=False),
        sa.Column("observed", sa.Float(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["model_id"], ["validation.model_versions.model_id"], name=op.f("fk_predictions_model_id_model_versions")
        ),
        sa.ForeignKeyConstraint(
            ["training_run_id"],
            ["validation.training_runs.run_id"],
            name=op.f("fk_predictions_training_run_id_training_runs"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_predictions")),
        schema="validation",
    )
    op.create_index(
        op.f("ix_validation_predictions_model_id"), "predictions", ["model_id"], unique=False, schema="validation"
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_validation_predictions_model_id"), table_name="predictions", schema="validation")
    op.drop_table("predictions", schema="validation")
    op.drop_index(op.f("ix_validation_model_evaluations_model_id"), table_name="model_evaluations", schema="validation")
    op.drop_table("model_evaluations", schema="validation")
    op.drop_index(op.f("ix_validation_training_runs_model_id"), table_name="training_runs", schema="validation")
    op.drop_table("training_runs", schema="validation")
    op.drop_index(
        op.f("ix_validation_statistical_results_run_id"), table_name="statistical_results", schema="validation"
    )
    op.drop_table("statistical_results", schema="validation")
    op.drop_table("trial_definitions", schema="games")
    op.drop_table("stimuli", schema="games")
    op.drop_table("episodes", schema="games")
    op.drop_table("conditions", schema="games")
    op.drop_table("language_versions", schema="criterion")
    op.drop_table("keys", schema="criterion")
    op.drop_table("items", schema="criterion")
    op.drop_table("validation_runs", schema="validation")
    op.drop_index(op.f("ix_validation_snapshot_members_pid"), table_name="snapshot_members", schema="validation")
    op.drop_table("snapshot_members", schema="validation")
    op.drop_table("norm_tables", schema="validation")
    op.drop_table("model_versions", schema="validation")
    op.drop_index(op.f("ix_study_retest_schedules_pid"), table_name="retest_schedules", schema="study")
    op.drop_table("retest_schedules", schema="study")
    op.drop_table("randomisation_blocks", schema="study")
    op.drop_table("quotas", schema="study")
    op.drop_table("protocol_versions", schema="study")
    op.drop_table("measurement_occasions", schema="study")
    op.drop_index(op.f("ix_study_enrollments_pid"), table_name="enrollments", schema="study")
    op.drop_table("enrollments", schema="study")
    op.drop_table("deviations", schema="study")
    op.drop_table("dataset_freezes", schema="study")
    op.drop_table("cohorts", schema="study")
    op.drop_table("arms", schema="study")
    op.drop_index(op.f("ix_scored_indicators_long_session_id"), table_name="indicators_long", schema="scored")
    op.drop_index(op.f("ix_scored_indicators_long_participant_pid"), table_name="indicators_long", schema="scored")
    op.drop_index(op.f("ix_scored_indicators_long_indicator_id"), table_name="indicators_long", schema="scored")
    op.drop_index(
        "ix_indicators_long_current",
        table_name="indicators_long",
        schema="scored",
        postgresql_where=sa.text("is_current"),
    )
    op.drop_table("indicators_long", schema="scored")
    op.drop_index(op.f("ix_linkage_participant_links_pid"), table_name="participant_links", schema="linkage")
    op.drop_table("participant_links", schema="linkage")
    op.drop_index(op.f("ix_linkage_pairing_codes_pid"), table_name="pairing_codes", schema="linkage")
    op.drop_table("pairing_codes", schema="linkage")
    op.drop_index(op.f("ix_kiosk_raw_batch_chunks_session_id"), table_name="batch_chunks", schema="kiosk_raw")
    op.drop_table("batch_chunks", schema="kiosk_raw")
    op.drop_index(op.f("ix_governance_deployments_kiosk_id"), table_name="deployments", schema="governance")
    op.drop_table("deployments", schema="governance")
    op.drop_table("game_versions", schema="games")
    op.drop_index(op.f("ix_criterion_permissions_instrument_id"), table_name="permissions", schema="criterion")
    op.drop_table("permissions", schema="criterion")
    op.drop_table("instrument_versions", schema="criterion")
    op.drop_index(op.f("ix_criterion_import_rows_status"), table_name="import_rows", schema="criterion")
    op.drop_table("import_rows", schema="criterion")
    op.drop_table("receipts", schema="consent")
    op.drop_table("trait_gates", schema="validation")
    op.drop_table("score_interpretations", schema="validation")
    op.drop_table("release_packs", schema="validation")
    op.drop_table("reference_populations", schema="validation")
    op.drop_index(op.f("ix_validation_matched_records_pid"), table_name="matched_records", schema="validation")
    op.drop_table("matched_records", schema="validation")
    op.drop_index(
        op.f("ix_validation_indicator_decisions_indicator_id"), table_name="indicator_decisions", schema="validation"
    )
    op.drop_table("indicator_decisions", schema="validation")
    op.drop_index(op.f("ix_validation_dataset_snapshots_study_id"), table_name="dataset_snapshots", schema="validation")
    op.drop_table("dataset_snapshots", schema="validation")
    op.drop_table("battery_gates", schema="validation")
    op.drop_index(op.f("ix_validation_analysis_plans_study_id"), table_name="analysis_plans", schema="validation")
    op.drop_table("analysis_plans", schema="validation")
    op.drop_table("studies", schema="study")
    op.drop_index(op.f("ix_scored_trials_canonical_session_id"), table_name="trials_canonical", schema="scored")
    op.drop_index(op.f("ix_scored_trials_canonical_participant_pid"), table_name="trials_canonical", schema="scored")
    op.drop_table("trials_canonical", schema="scored")
    op.drop_index(op.f("ix_scored_trait_mappings_construct_id"), table_name="trait_mappings", schema="scored")
    op.drop_table("trait_mappings", schema="scored")
    op.drop_index(op.f("ix_scored_trait_estimates_session_id"), table_name="trait_estimates", schema="scored")
    op.drop_index(op.f("ix_scored_trait_estimates_participant_pid"), table_name="trait_estimates", schema="scored")
    op.drop_table("trait_estimates", schema="scored")
    op.drop_index(
        "uq_session_quality_flags_open",
        table_name="session_quality_flags",
        schema="scored",
        postgresql_where=sa.text("resolved_at IS NULL"),
    )
    op.drop_index(
        op.f("ix_scored_session_quality_flags_session_id"), table_name="session_quality_flags", schema="scored"
    )
    op.drop_table("session_quality_flags", schema="scored")
    op.drop_table("scoring_runs", schema="scored")
    op.drop_index(op.f("ix_scored_indicators_indicator_id"), table_name="indicators", schema="scored")
    op.drop_index(op.f("ix_scored_indicators_construct_id"), table_name="indicators", schema="scored")
    op.drop_table("indicators", schema="scored")
    op.drop_table("feature_definitions", schema="scored")
    op.drop_table("constructs", schema="scored")
    op.drop_index(op.f("ix_reporting_reports_session_id"), table_name="reports", schema="reporting")
    op.drop_table("reports", schema="reporting")
    op.drop_table("report_templates", schema="reporting")
    op.drop_table("report_approvals", schema="reporting")
    op.drop_index(op.f("ix_ops_jobs_job_type"), table_name="jobs", schema="ops")
    op.drop_index("ix_jobs_claim", table_name="jobs", schema="ops")
    op.drop_table("jobs", schema="ops")
    op.drop_index(op.f("ix_linkage_withdrawals_pid_hmac"), table_name="withdrawals", schema="linkage")
    op.drop_table("withdrawals", schema="linkage")
    op.drop_index(op.f("ix_linkage_participants_study_id"), table_name="participants", schema="linkage")
    op.drop_table("participants", schema="linkage")
    op.drop_index(op.f("ix_kiosk_raw_sessions_study_id"), table_name="sessions", schema="kiosk_raw")
    op.drop_index(op.f("ix_kiosk_raw_sessions_status"), table_name="sessions", schema="kiosk_raw")
    op.drop_index(op.f("ix_kiosk_raw_sessions_participant_pid"), table_name="sessions", schema="kiosk_raw")
    op.drop_index(op.f("ix_kiosk_raw_sessions_kiosk_id"), table_name="sessions", schema="kiosk_raw")
    op.drop_table("sessions", schema="kiosk_raw")
    op.drop_index("ix_events_session_id_seq", table_name="events", schema="kiosk_raw")
    op.drop_index("ix_events_participant_pid", table_name="events", schema="kiosk_raw")
    op.drop_table("events", schema="kiosk_raw")
    op.drop_table("event_dedup", schema="kiosk_raw")
    op.drop_index(op.f("ix_kiosk_raw_dead_letter_session_id"), table_name="dead_letter", schema="kiosk_raw")
    op.drop_index(op.f("ix_kiosk_raw_dead_letter_reason_code"), table_name="dead_letter", schema="kiosk_raw")
    op.drop_index(op.f("ix_kiosk_raw_dead_letter_event_id"), table_name="dead_letter", schema="kiosk_raw")
    op.drop_table("dead_letter", schema="kiosk_raw")
    op.drop_index(op.f("ix_kiosk_raw_consent_parking_session_id"), table_name="consent_parking", schema="kiosk_raw")
    op.drop_index(op.f("ix_kiosk_raw_consent_parking_expires_at"), table_name="consent_parking", schema="kiosk_raw")
    op.drop_table("consent_parking", schema="kiosk_raw")
    op.drop_index(op.f("ix_kiosk_raw_batches_kiosk_id"), table_name="batches", schema="kiosk_raw")
    op.drop_table("batches", schema="kiosk_raw")
    op.drop_index(op.f("ix_governance_system_events_occurred_at"), table_name="system_events", schema="governance")
    op.drop_table("system_events", schema="governance")
    op.drop_table("signoffs", schema="governance")
    op.drop_table("settings", schema="governance")
    op.drop_table("retention_runs", schema="governance")
    op.drop_table("legal_holds", schema="governance")
    op.drop_table("kiosks", schema="governance")
    op.drop_table("content_versions", schema="governance")
    op.drop_index(op.f("ix_governance_audit_events_actor_sub"), table_name="audit_events", schema="governance")
    op.drop_index(op.f("ix_governance_audit_events_action"), table_name="audit_events", schema="governance")
    op.drop_index("ix_audit_events_occurred_at", table_name="audit_events", schema="governance")
    op.drop_table("audit_events", schema="governance")
    op.drop_table("games", schema="games")
    op.drop_index(
        "ix_scale_scores_current", table_name="scale_scores", schema="criterion", postgresql_where=sa.text("is_current")
    )
    op.drop_table("scale_scores", schema="criterion")
    op.drop_index("ix_responses_subject_occasion", table_name="responses", schema="criterion")
    op.drop_index(op.f("ix_criterion_responses_supersedes_id"), table_name="responses", schema="criterion")
    op.drop_index(op.f("ix_criterion_responses_subject_pid"), table_name="responses", schema="criterion")
    op.drop_table("responses", schema="criterion")
    op.drop_table("instruments", schema="criterion")
    op.drop_table("imports", schema="criterion")
    op.drop_index(op.f("ix_consent_tombstones_pid_hmac"), table_name="tombstones", schema="consent")
    op.drop_table("tombstones", schema="consent")
    op.drop_table("session_keys", schema="consent")
    op.drop_index(op.f("ix_consent_erasure_requests_pid_hmac"), table_name="erasure_requests", schema="consent")
    op.drop_table("erasure_requests", schema="consent")
    op.drop_index(op.f("ix_consent_artefacts_session_id"), table_name="artefacts", schema="consent")
    op.drop_index(op.f("ix_consent_artefacts_participant_pid"), table_name="artefacts", schema="consent")
    op.drop_table("artefacts", schema="consent")
    for schema in reversed(SCHEMAS):
        op.execute(f"DROP SCHEMA IF EXISTS {schema} CASCADE")
