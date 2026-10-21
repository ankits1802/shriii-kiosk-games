"""Minimal RIFF/WAVE header reader (format, rate, channels, bit depth) without decoding samples."""

from __future__ import annotations

import struct
from dataclasses import dataclass
from pathlib import Path

FORMAT_NAMES = {1: "pcm", 3: "float", 6: "alaw", 7: "mulaw", 0xFFFE: "extensible"}


class WavError(ValueError):
    """Not a readable RIFF/WAVE file."""


@dataclass(frozen=True, slots=True)
class WavInfo:
    format_tag: int
    format_name: str
    channels: int
    sample_rate_hz: int
    bits_per_sample: int
    data_bytes: int

    @property
    def frames(self) -> int:
        block = self.channels * max(1, self.bits_per_sample // 8)
        return self.data_bytes // block if block else 0

    @property
    def duration_ms(self) -> float:
        return 1000.0 * self.frames / self.sample_rate_hz if self.sample_rate_hz else 0.0


def read_wav_info(path: Path) -> WavInfo:
    with path.open("rb") as fh:
        head = fh.read(12)
        if len(head) < 12 or head[:4] not in (b"RIFF", b"RF64") or head[8:12] != b"WAVE":
            raise WavError(f"{path.name}: not a RIFF/WAVE file")
        fmt: tuple[int, int, int, int] | None = None
        data_bytes: int | None = None
        while True:
            chunk = fh.read(8)
            if len(chunk) < 8:
                break
            cid, size = chunk[:4], struct.unpack("<I", chunk[4:])[0]
            if cid == b"fmt ":
                body = fh.read(size)
                if len(body) < 16:
                    raise WavError(f"{path.name}: truncated fmt chunk")
                tag, ch, rate, _brate, _align, bits = struct.unpack("<HHIIHH", body[:16])
                if tag == 0xFFFE and len(body) >= 26:
                    tag = struct.unpack("<H", body[24:26])[0]  # sub-format GUID's first two bytes
                fmt = (tag, ch, rate, bits)
            elif cid == b"data":
                data_bytes = size
                break
            else:
                fh.seek(size + (size & 1), 1)
            if cid == b"fmt " and size & 1:
                fh.seek(1, 1)
    if fmt is None or data_bytes is None:
        raise WavError(f"{path.name}: missing fmt or data chunk")
    tag, ch, rate, bits = fmt
    return WavInfo(
        format_tag=tag,
        format_name=FORMAT_NAMES.get(tag, f"0x{tag:04x}"),
        channels=ch,
        sample_rate_hz=rate,
        bits_per_sample=bits,
        data_bytes=data_bytes,
    )
