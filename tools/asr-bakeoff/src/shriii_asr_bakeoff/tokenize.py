"""Phrase -> model token strings for keyword grammars.

* BPE models (sherpa KWS gigaspeech, most zipformer KWS): SentencePiece, upper-cased like the training text.
* Token-list models without a BPE file (e.g. an IndicConformer CTC export): greedy longest-match over the
  ``tokens.txt`` vocabulary with ``▁`` word-boundary markers.
"""

from __future__ import annotations

import unicodedata
from pathlib import Path

WORD_BOUNDARY = "▁"


def normalize_text(text: str) -> str:
    return " ".join(unicodedata.normalize("NFC", text).strip().split())


class BpeTokenizer:
    def __init__(self, model: Path, upper: bool = True) -> None:
        import sentencepiece as spm  # noqa: PLC0415

        self.sp = spm.SentencePieceProcessor(model_file=str(model))
        self.upper = upper

    def encode(self, phrase: str) -> list[str]:
        text = normalize_text(phrase)
        pieces: list[str] = self.sp.encode(text.upper() if self.upper else text, out_type=str)
        return pieces


def read_token_list(path: Path) -> dict[str, int]:
    """sherpa/NeMo ``tokens.txt``: ``<token> <id>`` per line (or one token per line, id = line number)."""
    table: dict[str, int] = {}
    for i, line in enumerate(path.read_text(encoding="utf-8").splitlines()):
        if not line.strip():
            continue
        parts = line.rsplit(" ", 1)
        if len(parts) == 2 and parts[1].isdigit():
            table[parts[0]] = int(parts[1])
        else:
            table[line.strip()] = i
    return table


class GreedyTokenizer:
    """Longest-match segmentation of each word (prefixed with ``▁``) over a token vocabulary."""

    def __init__(self, vocab: dict[str, int]) -> None:
        self.vocab = vocab
        self.max_len = max((len(t) for t in vocab), default=1)

    def encode(self, phrase: str) -> list[str]:
        out: list[str] = []
        for word in normalize_text(phrase).split():
            s = WORD_BOUNDARY + word
            i = 0
            while i < len(s):
                for j in range(min(len(s), i + self.max_len), i, -1):
                    if s[i:j] in self.vocab:
                        out.append(s[i:j])
                        i = j
                        break
                else:
                    if s[i] == WORD_BOUNDARY:
                        i += 1  # vocab without a bare boundary token: drop it
                        continue
                    raise ValueError(f"cannot tokenize {word!r}: {s[i]!r} is not in the vocabulary")
        return out

    def ids(self, phrase: str) -> list[int]:
        return [self.vocab[t] for t in self.encode(phrase)]
