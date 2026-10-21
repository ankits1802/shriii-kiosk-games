"""Per-language audio manifests in the ``ContentManifest`` contract format (VOX-02), signed with ed25519.

Layout under ``<out>/packs``::

    <lang>/<line_id>.opus
    manifest.<lang>.json        ContentManifest (audio_clips only; stimuli/layouts empty)
    manifest.<lang>.sig.json    detached ed25519 signature over the exact manifest bytes

``audio_clips[].file`` is relative to the pack root (``hi-IN/dont_tap.intro.opus``), which is the
``baseUrl`` the kiosk's ``buildVoiceManifest`` joins against.

Review states (VOX-07): a newly processed clip that passed QC is ``audio_qc``. Later states
(``think_aloud_tested``, ``approved``) are bound to the clip's sha256: they are carried over from a
previous manifest only when the bytes are identical, and set through :func:`promote` from an approvals
file. Re-recording a line therefore always drops it back to ``audio_qc``.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml

from shriii_audio.catalogue import ITC_ORDER, Catalogue
from shriii_audio.contracts import validate
from shriii_audio.process import BatchResult, ClipResult
from shriii_audio.signing import (
    SigningError,
    SigningKey,
    canonical_json_bytes,
    sha256_file,
    sha256_hex,
    sign_file,
    verify_file,
)

SCHEMA_FILE = "content-manifest.v1.schema.json"
# A review decision (including a flag) stays with the exact bytes it was made on.
CARRY_OVER_STATES = {"audio_qc", "think_aloud_tested", "approved", "flagged_for_revision"}
PROMOTABLE_STATES = {"think_aloud_tested", "approved", "flagged_for_revision"}


class ManifestError(ValueError):
    """Manifest build, promotion or verification failed."""


def manifest_name(language: str) -> str:
    return f"manifest.{language}.json"


def signature_name(language: str) -> str:
    return f"manifest.{language}.sig.json"


def bundle_hash(clips: list[dict[str, Any]]) -> str:
    """sha256 over the canonical list of (key, language, file, sha256) — independent of metadata order."""
    entries = sorted([c["key"], c["language"], c["file"], c["sha256"]] for c in clips)
    return sha256_hex(json.dumps(entries, separators=(",", ":")).encode("utf-8"))


def load_manifest(pack_dir: Path, language: str) -> dict[str, Any] | None:
    path = pack_dir / manifest_name(language)
    if not path.is_file():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    validate(data, SCHEMA_FILE)
    if not isinstance(data, dict):
        raise ManifestError(f"{path}: not an object")
    return data


def load_trusted_manifest(pack_dir: Path, language: str, key: SigningKey) -> dict[str, Any] | None:
    """Load an existing manifest only if its detached signature verifies with ``key``.

    Review states are carried over and promoted from the manifest on disk, so an unsigned or edited
    manifest must never feed them: otherwise anyone with write access to ``out/packs`` could mark a clip
    ``approved`` and have the next run re-sign it.
    """
    path = pack_dir / manifest_name(language)
    if not path.is_file():
        return None
    sig_path = pack_dir / signature_name(language)
    if not sig_path.is_file():
        raise ManifestError(f"{path.name} has no signature file; refusing to trust its review states")
    try:
        signature = json.loads(sig_path.read_text(encoding="utf-8"))
        verify_file(path, signature, key.private.public_key(), key.key_id)
    except (SigningError, ValueError, KeyError) as exc:
        raise ManifestError(f"{path.name} does not verify with key {key.key_id!r}: {exc}") from exc
    return load_manifest(pack_dir, language)


def _clip_entry(
    c: ClipResult, catalogue: Catalogue, speaker_id: str | None, previous: dict[str, Any] | None
) -> dict[str, Any]:
    line = catalogue.get(c.line_id)
    assert line is not None and c.output_file and c.output_sha256 and c.duration_ms is not None
    state = "audio_qc"
    if previous is not None:
        prev = next(
            (e for e in previous["audio_clips"] if e["key"] == c.line_id and e["language"] == c.language),
            None,
        )
        if prev is not None and prev["sha256"] == c.output_sha256 and prev["review_state"] in CARRY_OVER_STATES:
            state = prev["review_state"]
    return {
        "key": c.line_id,
        "language": c.language,
        "file": c.output_file,
        "sha256": c.output_sha256,
        "duration_ms": c.duration_ms,
        "speaker_id": speaker_id,
        "take": c.take,
        "script_version": catalogue.catalogue_version,
        "review_state": state,
        "loudness_lufs": round(c.output_lufs, 2) if c.output_lufs is not None else None,
        "true_peak_dbtp": round(c.output_true_peak_dbtp, 2) if c.output_true_peak_dbtp is not None else None,
        "voice_forbidden": line.voice_forbidden,
    }


@dataclass(frozen=True, slots=True)
class WrittenManifest:
    language: str
    manifest_path: Path
    signature_path: Path
    clip_count: int
    bundle_hash: str


def _write_signed(pack_dir: Path, language: str, manifest: dict[str, Any], key: SigningKey) -> WrittenManifest:
    validate(manifest, SCHEMA_FILE)
    path = pack_dir / manifest_name(language)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(canonical_json_bytes(manifest))
    sig = sign_file(path, key)
    sig_path = pack_dir / signature_name(language)
    sig_path.write_bytes(canonical_json_bytes(sig))
    return WrittenManifest(language, path, sig_path, len(manifest["audio_clips"]), manifest["bundle_hash"])


def build_manifests(
    batch: BatchResult,
    out_dir: Path,
    key: SigningKey,
    *,
    pack_version: str,
    speakers: dict[str, str] | None = None,
    merge_previous: bool = True,
    now: datetime | None = None,
) -> list[WrittenManifest]:
    """Write one signed manifest per language.

    With ``merge_previous`` the clips of an existing manifest in ``out/packs`` that were not re-processed
    in this batch are kept (their files must still exist and hash-match), so recordings can arrive in
    several sessions. ``speakers`` maps language -> speaker id.
    """
    pack_dir = out_dir / "packs"
    created = (now or datetime.now(UTC)).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    written: list[WrittenManifest] = []
    for lang in batch.languages:
        try:
            previous = load_trusted_manifest(pack_dir, lang, key)
        except ManifestError as exc:
            if merge_previous:
                raise ManifestError(f"{exc} (re-run with --no-merge to rebuild the pack from this batch)") from exc
            previous = None  # fresh rebuild: nothing is carried over from an untrusted manifest
        speaker = (speakers or {}).get(lang)
        entries: dict[str, dict[str, Any]] = {}
        if merge_previous and previous is not None:
            for e in previous["audio_clips"]:
                f = pack_dir / e["file"]
                if f.is_file() and sha256_file(f) == e["sha256"] and batch.catalogue.get(e["key"]) is not None:
                    entries[e["key"]] = e
        for c in batch.selected(lang):
            if c.deliverable:
                entries[c.line_id] = _clip_entry(c, batch.catalogue, speaker, previous)
            else:
                entries.pop(c.line_id, None)
        clips = [entries[k] for k in sorted(entries)]
        manifest = {
            "schema_version": "1.0",
            "manifest_id": f"voice.{lang.lower()}",
            "content_pack_version": pack_version,
            "bundle_hash": bundle_hash(clips),
            "created_at": created,
            "languages": [lang],
            "stimuli": [],
            "audio_clips": clips,
            "layouts": [],
        }
        written.append(_write_signed(pack_dir, lang, manifest, key))
    return written


def promote(pack_dir: Path, approvals_file: Path, key: SigningKey) -> list[WrittenManifest]:
    """Apply an approvals YAML and re-sign the touched manifests.

    Approvals file::

        approvals:
          - line_id: attract.greeting
            language: hi-IN
            sha256: <64 hex>            # must match the clip in the manifest
            state: think_aloud_tested   # think_aloud_tested | approved | flagged_for_revision
            by: language-lead-hi        # reviewer id (required)

    The ITC order is enforced: a clip moves at most forward along the order (``flagged_for_revision`` is
    always allowed) and ``approved`` requires ``think_aloud_tested`` first.
    """
    raw = yaml.safe_load(approvals_file.read_text(encoding="utf-8")) or {}
    approvals = raw.get("approvals")
    if not isinstance(approvals, list):
        raise ManifestError(f"{approvals_file}: expected an 'approvals' list")
    by_lang: dict[str, list[dict[str, Any]]] = {}
    for a in approvals:
        for k in ("line_id", "language", "sha256", "state", "by"):
            if not a.get(k):
                raise ManifestError(f"approval {a!r} is missing '{k}'")
        if a["state"] not in PROMOTABLE_STATES:
            raise ManifestError(f"approval state {a['state']!r} is not one of {sorted(PROMOTABLE_STATES)}")
        by_lang.setdefault(a["language"], []).append(a)
    written = []
    for lang, items in sorted(by_lang.items()):
        manifest = load_trusted_manifest(pack_dir, lang, key)
        if manifest is None:
            raise ManifestError(f"no manifest for {lang} in {pack_dir}")
        index = {e["key"]: e for e in manifest["audio_clips"]}
        for a in items:
            entry = index.get(a["line_id"])
            if entry is None:
                raise ManifestError(f"{lang}: {a['line_id']} is not in the manifest")
            if entry["sha256"] != a["sha256"]:
                raise ManifestError(f"{lang}: {a['line_id']} sha256 mismatch (approval is for different audio)")
            cur, new = entry["review_state"], a["state"]
            if new != "flagged_for_revision":
                if cur in ITC_ORDER and ITC_ORDER.index(new) < ITC_ORDER.index(cur):
                    raise ManifestError(f"{lang}: {a['line_id']} cannot move back from {cur} to {new}")
                if new == "approved" and cur not in {"think_aloud_tested", "approved"}:
                    raise ManifestError(f"{lang}: {a['line_id']} must be think_aloud_tested before approved")
            entry["review_state"] = new
        written.append(_write_signed(pack_dir, lang, manifest, key))
    return written


def verify_pack(pack_dir: Path, language: str, public: Any, key_id: str) -> int:
    """Verify signature, schema and every clip hash of one language pack; returns the clip count."""
    path = pack_dir / manifest_name(language)
    sig_path = pack_dir / signature_name(language)
    if not path.is_file() or not sig_path.is_file():
        raise ManifestError(f"missing manifest or signature for {language}")
    signature = json.loads(sig_path.read_text(encoding="utf-8"))
    try:
        verify_file(path, signature, public, key_id)
    except SigningError as exc:
        raise ManifestError(str(exc)) from exc
    manifest = load_manifest(pack_dir, language)
    assert manifest is not None
    if bundle_hash(manifest["audio_clips"]) != manifest["bundle_hash"]:
        raise ManifestError(f"{language}: bundle_hash does not match the clip list")
    for e in manifest["audio_clips"]:
        f = pack_dir / e["file"]
        if not f.is_file():
            raise ManifestError(f"{language}: missing clip file {e['file']}")
        if sha256_file(f) != e["sha256"]:
            raise ManifestError(f"{language}: sha256 mismatch for {e['file']}")
    return len(manifest["audio_clips"])
