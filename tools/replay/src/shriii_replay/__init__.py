"""Session replay and reproducibility check (ING-07, SCR-13; spec definition-of-done #2).

Takes the raw events of one session (NDJSON, a JSON array or development ``UploadBatch`` documents),
validates them against the canonical contracts, checks the gapless ``seq``, rebuilds the trial timeline,
re-runs the indicator engine and compares the result with stored indicator values, then renders a
self-contained HTML timeline for QA. Contracts and the scoring engine are used read-only.
"""

from shriii_replay.replay import ReplayReport, replay_session

__all__ = ["ReplayReport", "__version__", "replay_session"]

__version__ = "0.1.0"
