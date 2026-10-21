"""SHRIII voice-over pipeline (VOX-02, VOX-07).

Ingests native-speaker recordings named ``<line_id>.<lang>.wav``, validates them against the voice-line
catalogue (``content/i18n/lines.yaml``, read-only), runs QC (clipping, noise floor, SNR, duration),
trims silence, normalises to EBU R128 -16 LUFS / -1 dBTP with a two-pass loudnorm, encodes Opus 48 kHz
mono and emits per-language ed25519-signed audio manifests in the ``ContentManifest`` format consumed by
``packages/kiosk-game/src/voice``. It also writes a QC HTML report, a recording-status YAML and
per-language recording scripts (XLSX + printable HTML) for voice actors.
"""

__version__ = "0.1.0"
