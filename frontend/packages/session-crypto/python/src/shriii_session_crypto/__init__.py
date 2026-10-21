"""Reference decryptor for SHRIII kiosk session chunks (see frontend/packages/session-crypto/README.md)."""

from .hpke import DecryptionError, derive_key_pair, public_from_private
from .session import (
    CHUNK_ENCRYPTION,
    decrypt_chunk_with_dek,
    decrypt_session_chunk,
    open_dek,
    parse_sealed_dek,
    sealed_dek_kid,
)

__all__ = [
    "CHUNK_ENCRYPTION",
    "DecryptionError",
    "decrypt_chunk_with_dek",
    "decrypt_session_chunk",
    "derive_key_pair",
    "open_dek",
    "parse_sealed_dek",
    "public_from_private",
    "sealed_dek_kid",
]
