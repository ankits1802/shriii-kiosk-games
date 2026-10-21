"""All ORM models; importing this package registers every table on the metadata."""

from shriii_api.db.models import (
    criterion,
    games,
    identity,
    kiosk_raw,
    ops,
    participants,
    scored,
    study,
    validation,
)

__all__ = ["criterion", "games", "identity", "kiosk_raw", "ops", "participants", "scored", "study", "validation"]
