"""SHRIII per-SKU timing calibration (ENG-01, ENG-02).

The calibration page (``web/``) writes a host-side capture: flash patches, pointer events, scheduled
audio clicks (with optional in-page loopback detection), rAF timestamps and optional host<->rig clock
sync pairs. External sensors (photodiode, solenoid tapper contact switch, high-speed camera, audio rig
microphone) are imported as CSV. :func:`shriii_timing.profile.build_profile` matches them, estimates the
constant offsets and their jitter, applies the acceptance thresholds in ``config/thresholds.yaml`` and
returns a versioned ``timing_profile`` document.
"""

from shriii_timing.profile import build_profile, compare_profiles

__all__ = ["__version__", "build_profile", "compare_profiles"]

__version__ = "0.1.0"
