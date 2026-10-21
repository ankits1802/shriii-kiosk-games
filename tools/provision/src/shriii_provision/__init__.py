"""SHRIII kiosk provisioning (KSK-09, KSK-10, PRV-07)."""

__version__ = "0.1.0"


class ProvisionError(Exception):
    """A provisioning step failed; the message is safe to show to the technician (no secrets)."""
