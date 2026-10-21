"""Domain errors carrying an HTTP status and a stable machine-readable code."""

from __future__ import annotations

from typing import Any


class DomainError(Exception):
    """Raised by services; the API maps it to ``{"detail": {"code", "message", ...}}``."""

    def __init__(self, status_code: int, code: str, message: str, **extra: Any) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.extra = extra
