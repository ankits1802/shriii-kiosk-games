# @shriii/session-crypto

Per-session envelope encryption for kiosk event data (KSK-07, PRV-01). Node / Electron main
process only (`node:crypto`, `node:zlib`); a Python reference decryptor for the API lives in
[`python/`](python/).

## Scheme

| Piece | Construction |
| --- | --- |
| Session DEK | 32 random bytes per session |
| DEK → backend | RFC 9180 HPKE base mode, DHKEM(X25519, HKDF-SHA256) + HKDF-SHA256 + AES-256-GCM; `info = "shriii/session-dek/v1"`, `aad = header ‖ session_id` |
| Sealed DEK wire format | `u8 version=1 ‖ u16 kem ‖ u16 kdf ‖ u16 aead ‖ u8 kid_len ‖ kid ‖ enc(32) ‖ ct(32+16)`, base64 in `UploadBatch.session_chunks[].sealed_dek` |
| Upload chunk | `AES-256-GCM(DEK, nonce, gzip(NDJSON events))`, `aad = "shriii/chunk/v1|sid|first_seq|last_seq|event_count"`; base64 `nonce` and `ciphertext‖tag` |
| At rest (SQLite) | each event `AES-256-GCM(DEK)` bound to `"shriii/event/v1|sid|seq"` |
| DEK at rest | wrapped with the device KEK (Electron `safeStorage` / TPM), bound to the session id; deleting it crypto-shreds the session |
| Key rotation | `RecipientKeyRing` with `kid`, `notBefore`, `notAfter`; new sessions seal to the newest valid key; DEKs sealed to a retired key are re-sealed before upload (no data re-encryption); KEK rotation re-wraps all DEKs |

Every header field the server routes on is authenticated (AAD), and decryption also checks the
events' own `session_id` and contiguous `seq` against the header. Decompression is bounded
(16 MiB) against gzip bombs.

## Verification

- `test-vectors/hpke-rfc9180.json`: RFC 9180 / CFRG known-answer vectors (AES-128-GCM and
  AES-256-GCM suites) checked by both implementations, including key derivation, key schedule and
  sequential encryptions.
- `test-vectors/session-chunk-fixture.json`: a chunk sealed by the TypeScript code and opened by the
  Python reference (regenerate with `pnpm fixtures`).
- Tamper tests: every byte of a sealed DEK, header-field edits, ciphertext/tag/nonce flips, wrong
  keys, wrong session, low-order points.

```bash
pnpm --filter @shriii/session-crypto test          # TypeScript (vitest)
pnpm --filter @shriii/session-crypto test:python   # Python reference (pytest via uv)
```

## API use (backend)

```python
from shriii_session_crypto import decrypt_session_chunk
events = decrypt_session_chunk(chunk_dict, private_keys_by_kid.get)
```
