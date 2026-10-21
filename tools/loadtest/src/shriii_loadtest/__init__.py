"""Load, soak and correctness harness for the SHRIII ingestion and research APIs (QA-05, ING-02).

The harness acts like a fleet of kiosks. It replays realistic sessions from ``shriii_simulator`` through
the real ``POST /api/v1/events/batch`` contract (JCS checksum, optional sealed-box encryption, gapless
``seq``) and checks both latency and correctness: zero duplicates, every event stored once, and parked
events released once consent arrives.
"""

__version__ = "0.1.0"
