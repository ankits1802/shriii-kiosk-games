"""Make ``trial_budget`` importable from the tool directory (the tool is a standalone script)."""

from __future__ import annotations

import sys
from pathlib import Path

TOOL_DIR = Path(__file__).resolve().parents[1]
if str(TOOL_DIR) not in sys.path:
    sys.path.insert(0, str(TOOL_DIR))
