"""MFCC + DTW template matching: a model-free floor that any candidate engine must beat."""

from __future__ import annotations

import numpy as np

from shriii_asr_bakeoff.audio import Audio
from shriii_asr_bakeoff.engines.base import Engine, Enrollment, Recognition
from shriii_asr_bakeoff.features import F64, dtw_distance, mfcc, trim_energy


class DtwEngine(Engine):
    templates: dict[str, list[F64]]
    reject_distance: float

    def unavailable_reason(self, language: str) -> str | None:
        return None

    def version(self) -> str | None:
        return "dtw-mfcc-1"

    def prepare(self, language: str, phrases: dict[str, tuple[str, ...]], enrollment: list[Enrollment]) -> None:
        per_code = int(self.spec.params.get("templates_per_code", 8))
        self.templates = {}
        for e in enrollment:
            bucket = self.templates.setdefault(e.code, [])
            if len(bucket) < per_code:
                bucket.append(mfcc(trim_energy(e.audio)))
        missing = [c for c in phrases if c not in self.templates]
        if missing:
            raise ValueError(f"no enrolment templates for {missing}")
        # Reject distance: high percentile of within-code template distances (leave-one-out), with headroom.
        within = []
        for feats in self.templates.values():
            for i, a in enumerate(feats):
                ds = [dtw_distance(a, b) for j, b in enumerate(feats) if j != i]
                if ds:
                    within.append(min(ds))
        self.reject_distance = float(np.percentile(within, 95)) * 1.6 if within else float("inf")

    def recognize(self, audio: Audio, codes: list[str]) -> Recognition:
        feats = mfcc(trim_energy(audio))
        dists = sorted((min(dtw_distance(feats, t) for t in self.templates[c]), c) for c in codes)
        d1, best = dists[0]
        if d1 > self.reject_distance:
            return Recognition(None, None)
        absolute = float(np.clip((self.reject_distance - d1) / self.reject_distance, 0.0, 1.0))
        if len(dists) > 1:
            d2 = dists[1][0]
            margin = float(np.clip((d2 - d1) / max(d2, 1e-9), 0.0, 1.0))
            score = float(np.sqrt(absolute * min(1.0, 3 * margin)))
        else:
            score = absolute
        return Recognition(best, score)
