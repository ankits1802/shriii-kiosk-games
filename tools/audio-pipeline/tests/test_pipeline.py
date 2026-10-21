"""End-to-end: synthetic recordings -> QC -> loudnorm -> Opus -> signed manifests, report and status."""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path

import pytest
import yaml
from synth import RATE, recording, write_pcm16

from shriii_audio import ffmpeg, manifest
from shriii_audio.catalogue import load_catalogue
from shriii_audio.cli import main
from shriii_audio.config import QcConfig
from shriii_audio.contracts import validate
from shriii_audio.process import BatchResult, process_directory
from shriii_audio.report import write_report
from shriii_audio.signing import SigningError, SigningKey, generate_key, load_public_key, sha256_file
from shriii_audio.status import write_status

pytestmark = pytest.mark.ffmpeg


@pytest.fixture
def recordings(tmp_path: Path) -> Path:
    d = tmp_path / "in"
    d.mkdir()
    write_pcm16(d / "guide.hello.en-IN.wav", recording(2.6, level_dbfs=-24, seed=1))
    write_pcm16(d / "guide.hello.hi-IN.wav", recording(2.9, level_dbfs=-30, seed=2), channels=2)
    write_pcm16(d / "guide.bye.hi-IN.wav", recording(2.8, level_dbfs=-18, seed=3), rate=44100)
    write_pcm16(d / "guide.clipped.hi-IN.wav", recording(2.5, level_dbfs=-14, clip_gain=6.0, seed=4))
    write_pcm16(d / "guide.noisy.hi-IN.wav", recording(2.5, level_dbfs=-30, floor_dbfs=-42, seed=5))
    write_pcm16(d / "guide.takes.hi-IN.take1.wav", recording(2.7, level_dbfs=-26, seed=6))
    write_pcm16(d / "guide.takes.hi-IN.take2.wav", recording(2.7, level_dbfs=-14, clip_gain=6.0, seed=7))
    write_pcm16(d / "guide.long.en-IN.wav", recording(2.0, level_dbfs=-24, seed=8))
    write_pcm16(d / "guide.long.hi-IN.wav", recording(4.6, level_dbfs=-24, seed=9))
    write_pcm16(d / "guide.unknown.hi-IN.wav", recording(1.0, seed=10))
    write_pcm16(d / "guide.hello.fr-FR.wav", recording(1.0, seed=11))
    write_pcm16(d / "lowrate.hello.wav", recording(1.0, seed=12), rate=16000)
    (d / "guide.hello.hi-IN.mp3").write_bytes(b"ID3")
    return d


@pytest.fixture
def batch(recordings: Path, catalogue_file: Path, qc: QcConfig, tmp_path: Path) -> BatchResult:
    return process_directory(recordings, load_catalogue(catalogue_file), qc, tmp_path / "out")


def by_line(batch: BatchResult, line_id: str, lang: str = "hi-IN") -> list:
    return [c for c in batch.clips if c.line_id == line_id and c.language == lang]


def test_good_clips_meet_loudness_and_format(batch: BatchResult, qc: QcConfig, tmp_path: Path) -> None:
    for line_id, lang in [("guide.hello", "en-IN"), ("guide.hello", "hi-IN"), ("guide.bye", "hi-IN")]:
        (c,) = by_line(batch, line_id, lang)
        assert c.selected and c.deliverable, c.issues
        path = tmp_path / "out" / "packs" / c.output_file
        # Independent re-measure of the delivered file (VOX-02 AC).
        m = ffmpeg.measure_loudness(path)
        assert abs(m.integrated_lufs - qc.loudness.target_lufs) <= qc.loudness.tolerance_lu
        assert m.true_peak_dbtp <= qc.loudness.true_peak_ceiling_dbtp
        assert path.read_bytes()[:4] == b"OggS"
        assert b"OpusHead" in path.read_bytes()[:200]
        head = path.read_bytes()[28 + 8 : 28 + 19]  # OpusHead: version, channels, pre-skip, input rate
        assert head[1] == 1  # mono
        decoded = ffmpeg.decode_f32(path)
        assert decoded.shape[1] == 1
        assert c.duration_ms == pytest.approx(decoded.shape[0] / 48000 * 1000, abs=1)
        assert c.output_sha256 == sha256_file(path)
        # trimmed: shorter than the raw file, longer than the speech
        assert c.duration_ms < c.input_duration_ms
        assert c.lead_trim_ms is not None and c.lead_trim_ms > 400


def test_qc_failures_and_warnings(batch: BatchResult) -> None:
    (clipped,) = by_line(batch, "guide.clipped")
    assert clipped.status == "fail"
    assert "clipping" in {i.code for i in clipped.issues}
    assert not clipped.deliverable
    (noisy,) = by_line(batch, "guide.noisy")
    assert noisy.status == "fail"
    assert "low_snr" in {i.code for i in noisy.issues}
    (stereo,) = by_line(batch, "guide.hello")
    assert "stereo_input" in {i.code for i in stereo.issues}
    (long,) = by_line(batch, "guide.long")
    codes = {i.code for i in long.issues}
    assert "long_clip" in codes
    assert long.ratio_to_source is not None and long.ratio_to_source > 1.5
    assert long.source_duration_ms == by_line(batch, "guide.long", "en-IN")[0].duration_ms


def test_take_selection_skips_failing_take(batch: BatchResult, tmp_path: Path) -> None:
    takes = sorted(by_line(batch, "guide.takes"), key=lambda c: c.take)
    assert [t.take for t in takes] == [1, 2]
    assert takes[1].status == "fail" and takes[1].superseded and not takes[1].selected
    assert takes[0].selected and takes[0].deliverable
    assert (tmp_path / "out" / "packs" / "hi-IN" / "guide.takes.opus").stat().st_size > 0


def test_rejected_files(batch: BatchResult) -> None:
    reasons = dict(batch.rejected_files)
    assert "not in the catalogue" in reasons["guide.unknown.hi-IN.wav"]
    assert "fr-FR" in reasons["guide.hello.fr-FR.wav"]
    assert "lowrate.hello.wav" in reasons
    assert "only .wav" in reasons["guide.hello.hi-IN.mp3"]


def test_signed_manifests(batch: BatchResult, signing_key: tuple[SigningKey, Path], tmp_path: Path) -> None:
    key, pub = signing_key
    out = tmp_path / "out"
    written = manifest.build_manifests(batch, out, key, pack_version="0.2.0", speakers={"hi-IN": "spk-hi-01"})
    assert {w.language for w in written} == {"en-IN", "hi-IN"}
    packs = out / "packs"
    hi = json.loads((packs / "manifest.hi-IN.json").read_text(encoding="utf-8"))
    validate(hi, "content-manifest.v1.schema.json")
    keys = {e["key"] for e in hi["audio_clips"]}
    assert keys == {"guide.hello", "guide.bye", "guide.takes", "guide.long"}
    bye = next(e for e in hi["audio_clips"] if e["key"] == "guide.bye")
    assert bye["voice_forbidden"] is True
    assert bye["file"] == "hi-IN/guide.bye.opus"
    assert bye["review_state"] == "audio_qc"
    assert bye["speaker_id"] == "spk-hi-01"
    assert bye["script_version"] == "0.3.0"
    takes = next(e for e in hi["audio_clips"] if e["key"] == "guide.takes")
    assert takes["take"] == 1
    assert hi["manifest_id"] == "voice.hi-in"
    assert hi["bundle_hash"] == manifest.bundle_hash(hi["audio_clips"])
    key_id, public = load_public_key(pub)
    assert manifest.verify_pack(packs, "hi-IN", public, key_id) == 4
    # tamper with a clip -> hash mismatch
    clip = packs / "hi-IN" / "guide.bye.opus"
    original = clip.read_bytes()
    clip.write_bytes(original[:-1] + bytes([original[-1] ^ 1]))
    with pytest.raises(manifest.ManifestError, match="sha256 mismatch"):
        manifest.verify_pack(packs, "hi-IN", public, key_id)
    clip.write_bytes(original)
    # tamper with the manifest -> signature invalid
    mpath = packs / "manifest.hi-IN.json"
    text = mpath.read_bytes()
    mpath.write_bytes(text.replace(b'"0.2.0"', b'"0.2.1"'))
    with pytest.raises(manifest.ManifestError):
        manifest.verify_pack(packs, "hi-IN", public, key_id)
    mpath.write_bytes(text)
    assert manifest.verify_pack(packs, "hi-IN", public, key_id) == 4


def test_kiosk_manifest_shape_matches_voice_service(
    batch: BatchResult, signing_key: tuple[SigningKey, Path], tmp_path: Path
) -> None:
    """The fields buildVoiceManifest() reads (frontend/packages/kiosk-game/src/voice/manifest.ts) are all present."""
    key, _ = signing_key
    manifest.build_manifests(batch, tmp_path / "out", key, pack_version="0.2.0")
    data = json.loads((tmp_path / "out" / "packs" / "manifest.en-IN.json").read_text(encoding="utf-8"))
    for field in ("content_pack_version", "bundle_hash", "languages", "audio_clips"):
        assert field in data
    for e in data["audio_clips"]:
        for field in (
            "key",
            "language",
            "file",
            "sha256",
            "duration_ms",
            "voice_forbidden",
            "loudness_lufs",
            "review_state",
        ):
            assert field in e
        assert abs(e["loudness_lufs"] + 16) <= 0.5  # gain correction in the kiosk stays ~1


def test_promote_and_carry_over(
    batch: BatchResult,
    signing_key: tuple[SigningKey, Path],
    tmp_path: Path,
    recordings: Path,
    catalogue_file: Path,
    qc: QcConfig,
) -> None:
    key, pub = signing_key
    out = tmp_path / "out"
    manifest.build_manifests(batch, out, key, pack_version="0.2.0")
    packs = out / "packs"
    hi = json.loads((packs / "manifest.hi-IN.json").read_text(encoding="utf-8"))
    hello = next(e for e in hi["audio_clips"] if e["key"] == "guide.hello")
    approvals = tmp_path / "approvals.yaml"

    def write(state: str, sha: str) -> None:
        approvals.write_text(
            yaml.safe_dump(
                {
                    "approvals": [
                        {"line_id": "guide.hello", "language": "hi-IN", "sha256": sha, "state": state, "by": "lead-hi"}
                    ]
                }
            ),
            encoding="utf-8",
        )

    write("approved", hello["sha256"])
    with pytest.raises(manifest.ManifestError, match="think_aloud_tested before approved"):
        manifest.promote(packs, approvals, key)
    write("think_aloud_tested", "0" * 64)
    with pytest.raises(manifest.ManifestError, match="sha256 mismatch"):
        manifest.promote(packs, approvals, key)
    write("think_aloud_tested", hello["sha256"])
    manifest.promote(packs, approvals, key)
    write("approved", hello["sha256"])
    manifest.promote(packs, approvals, key)
    key_id, public = load_public_key(pub)
    assert manifest.verify_pack(packs, "hi-IN", public, key_id) == 4
    hi = json.loads((packs / "manifest.hi-IN.json").read_text(encoding="utf-8"))
    assert next(e for e in hi["audio_clips"] if e["key"] == "guide.hello")["review_state"] == "approved"

    # Re-processing identical audio keeps the approval (bitexact encode -> same sha256); a new take resets it.
    batch2 = process_directory(recordings, load_catalogue(catalogue_file), qc, out, ["hi-IN"])
    manifest.build_manifests(batch2, out, key, pack_version="0.2.1")
    hi = json.loads((packs / "manifest.hi-IN.json").read_text(encoding="utf-8"))
    entry = next(e for e in hi["audio_clips"] if e["key"] == "guide.hello")
    assert entry["sha256"] == hello["sha256"], "Opus encoding must be deterministic"
    assert entry["review_state"] == "approved"

    fresh = tmp_path / "in2"
    fresh.mkdir()
    write_pcm16(fresh / "guide.hello.hi-IN.wav", recording(2.9, level_dbfs=-28, seed=42))
    batch3 = process_directory(fresh, load_catalogue(catalogue_file), qc, out, ["hi-IN"])
    manifest.build_manifests(batch3, out, key, pack_version="0.2.2")
    hi = json.loads((packs / "manifest.hi-IN.json").read_text(encoding="utf-8"))
    entry = next(e for e in hi["audio_clips"] if e["key"] == "guide.hello")
    assert entry["review_state"] == "audio_qc"
    # clips not in this batch were merged from the previous manifest
    assert {e["key"] for e in hi["audio_clips"]} == {"guide.hello", "guide.bye", "guide.takes", "guide.long"}


def test_review_states_only_come_from_a_verified_manifest(
    batch: BatchResult,
    signing_key: tuple[SigningKey, Path],
    tmp_path: Path,
) -> None:
    key, _ = signing_key
    out = tmp_path / "out"
    manifest.build_manifests(batch, out, key, pack_version="0.2.0")
    packs = out / "packs"
    mpath = packs / "manifest.hi-IN.json"
    original = mpath.read_bytes()

    # Hand-editing review_state to "approved" must not be carried over or re-signed.
    forged = json.loads(original)
    for e in forged["audio_clips"]:
        e["review_state"] = "approved"
    mpath.write_text(json.dumps(forged), encoding="utf-8")
    with pytest.raises(manifest.ManifestError, match="does not verify"):
        manifest.build_manifests(batch, out, key, pack_version="0.2.1")
    approvals = tmp_path / "approvals.yaml"
    hello = next(e for e in forged["audio_clips"] if e["key"] == "guide.hello")
    approvals.write_text(
        yaml.safe_dump(
            {
                "approvals": [
                    {
                        "line_id": "guide.hello",
                        "language": "hi-IN",
                        "sha256": hello["sha256"],
                        "state": "flagged_for_revision",
                        "by": "lead-hi",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    with pytest.raises(manifest.ManifestError, match="does not verify"):
        manifest.promote(packs, approvals, key)
    # --no-merge rebuilds from the batch and ignores the untrusted states.
    manifest.build_manifests(batch, out, key, pack_version="0.2.1", merge_previous=False)
    hi = json.loads(mpath.read_text(encoding="utf-8"))
    assert {e["review_state"] for e in hi["audio_clips"]} == {"audio_qc"}

    # A missing signature file is refused too.
    sig = packs / "manifest.hi-IN.sig.json"
    sig_bytes = sig.read_bytes()
    sig.unlink()
    with pytest.raises(manifest.ManifestError, match="no signature"):
        manifest.promote(packs, approvals, key)
    sig.write_bytes(sig_bytes)

    # A flag sticks to the exact bytes it was raised on when the same audio is re-processed.
    manifest.promote(packs, approvals, key)
    manifest.build_manifests(batch, out, key, pack_version="0.2.2")
    hi = json.loads(mpath.read_text(encoding="utf-8"))
    assert next(e for e in hi["audio_clips"] if e["key"] == "guide.hello")["review_state"] == "flagged_for_revision"


def test_private_key_is_owner_only_and_never_overwritten(tmp_path: Path) -> None:
    pem = tmp_path / "k.pem"
    generate_key("audio-test-2", pem, tmp_path / "k.pub.json")
    if os.name == "posix":
        assert stat.S_IMODE(pem.stat().st_mode) == 0o600
    with pytest.raises(SigningError, match="refusing to overwrite"):
        generate_key("audio-test-2", pem, tmp_path / "k2.pub.json")


def test_status_and_report(batch: BatchResult, qc: QcConfig, tmp_path: Path, catalogue_file: Path) -> None:
    before = catalogue_file.read_bytes()
    out = tmp_path / "out"
    status_path = write_status(batch, out)
    report_path = write_report(batch, qc, out)
    assert catalogue_file.read_bytes() == before, "the catalogue must never be modified"
    status = yaml.safe_load(status_path.read_text(encoding="utf-8"))
    hi = status["languages"]["hi-IN"]
    assert hi["updates"]["guide.hello"]["proposed"]["status"] == "audio_qc"
    assert hi["updates"]["guide.hello"]["proposed"]["itc_state"] == "audio_qc"
    assert hi["updates"]["guide.hello"]["current"] == {"status": "not_scripted", "itc_state": "draft"}
    assert hi["updates"]["guide.clipped"]["proposed"]["itc_state"] == "flagged_for_revision"
    assert hi["updates"]["guide.clipped"]["proposed"]["clip_sha256"] is None
    assert set(hi["missing_lines"]) == {"guide.clipped", "guide.noisy"}
    assert hi["summary"]["failed"] == 2
    assert {r["file"] for r in status["rejected_files"]} >= {"guide.unknown.hi-IN.wav"}
    html = report_path.read_text(encoding="utf-8")
    assert "<title>Voice QC Report</title>" in html
    assert "guide.clipped" in html and "clipping" in html
    assert "<svg" in html
    assert "prefers-color-scheme: dark" in html


def test_cli_end_to_end(
    recordings: Path, catalogue_file: Path, tmp_path: Path, signing_key: tuple[SigningKey, Path]
) -> None:
    _, pub = signing_key
    out = tmp_path / "cli-out"
    priv = tmp_path / "keys" / "test-key.pem"
    common = ["--catalogue", str(catalogue_file)]
    assert main(["check", str(recordings), *common]) == 1  # rejected names present
    rc = main(
        [
            "process",
            str(recordings),
            *common,
            "--out",
            str(out),
            "--key",
            str(priv),
            "--key-id",
            "audio-test-1",
            "--strict",
        ]
    )
    assert rc == 1  # failures present under --strict
    assert main(["verify", "--packs", str(out / "packs"), "--public", str(pub)]) == 0
    assert (out / "qc-report.html").is_file()
    assert (out / "recording-status.yaml").is_file()


def test_rejects_input_below_min_rate(tmp_path: Path, catalogue_file: Path, qc: QcConfig) -> None:
    d = tmp_path / "in"
    d.mkdir()
    write_pcm16(d / "guide.hello.hi-IN.wav", recording(2.0), rate=22050)
    b = process_directory(d, load_catalogue(catalogue_file), qc, tmp_path / "out")
    (c,) = b.clips
    assert "sample_rate_too_low" in {i.code for i in c.issues}
    assert RATE == 48000
