"""/api/v1/events/batch: idempotent UploadBatch ingestion (ING-02)."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from shriii_contracts import UploadBatch, UploadBatchResult

from shriii_api.api.deps import DbSession, SettingsDep, require, set_audit
from shriii_api.auth.rbac import Perm, Principal
from shriii_api.services.ingestion import ingest_batch

router = APIRouter(prefix="/events", tags=["events"])

_BATCH_SCHEMA = UploadBatch.model_json_schema(ref_template="#/components/schemas/{model}")


@router.post(
    "/batch",
    summary="Upload an idempotent event batch",
    description=(
        "Accepts an ``UploadBatch`` (contracts upload-batch.v1). ``sha256`` must equal the "
        "SHA-256 of the RFC 8785 (JCS) serialisation of ``session_chunks``. Replays with the same "
        "``batch_id`` return the stored result (``duplicate_batch=true``). Each event gets "
        "``accepted | duplicate | parked | rejected_terminal | retryable``; scorable events wait in "
        "consent parking until core consent arrives; ``server_received_at`` is set by the server."
    ),
    response_model=UploadBatchResult,
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {"application/json": {"schema": {"$ref": "#/components/schemas/UploadBatch"}}},
        }
    },
    responses={
        400: {"description": "Malformed JSON or sha256 mismatch"},
        409: {"description": "batch_id reused for different content"},
        413: {"description": "Batch too large"},
        422: {"description": "Batch envelope invalid / chunk cannot be decrypted"},
    },
)
async def upload_batch(
    request: Request,
    db: DbSession,
    settings: SettingsDep,
    principal: Annotated[Principal, Depends(require(Perm.EVENTS_INGEST))],
) -> dict[str, Any]:
    body = await request.body()
    from starlette.concurrency import run_in_threadpool  # noqa: PLC0415

    result = await run_in_threadpool(ingest_batch, db, body, principal, settings)
    set_audit(
        request,
        action="events.batch",
        resource_type="batch",
        resource_id=result["batch_id"],
        summary=result["summary"],
        duplicate_batch=result["duplicate_batch"],
    )
    return result


def batch_schema() -> dict[str, Any]:
    return _BATCH_SCHEMA
