"""Algorithm versions for layer 2 (indicators) and layer 3 (criterion scale scores).

Bump ``INDICATOR_ALGORITHM_VERSION`` whenever any formula's numeric output can change for the same
input; bump ``CRITERION_ALGORITHM_VERSION`` for any change to criterion scoring. Every output row
carries the relevant version (plan section 1 non-negotiable 9; SCR-13).
"""

from __future__ import annotations

from typing import Final

INDICATOR_ALGORITHM_VERSION: Final = "0.1.0"
CRITERION_ALGORITHM_VERSION: Final = "0.1.0"
BAND_ALGORITHM_VERSION: Final = "0.1.0"
