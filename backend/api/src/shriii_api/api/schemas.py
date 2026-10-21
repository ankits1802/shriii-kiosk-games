"""Shared API schema helpers."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import Query
from pydantic import BaseModel, ConfigDict, Field

Limit = Annotated[int, Query(ge=1, le=1000, description="Page size")]
Offset = Annotated[int, Query(ge=0, description="Rows to skip")]


class ApiModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class Page[T](ApiModel):
    items: list[T]
    total: int
    limit: int
    offset: int


class ErrorDetail(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    detail: ErrorDetail | list[Any] | str


class JobRef(ApiModel):
    job_id: Any = Field(description="Job id (UUID)")
    job_type: str
    status: str


ERROR_RESPONSES: dict[int | str, dict[str, Any]] = {
    401: {"model": ErrorResponse, "description": "Unauthenticated"},
    403: {"model": ErrorResponse, "description": "Forbidden"},
}
