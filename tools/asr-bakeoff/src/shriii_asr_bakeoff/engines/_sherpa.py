"""Import sherpa-onnx with the right ONNX Runtime on Windows.

The sherpa-onnx wheel links ``onnxruntime.dll`` by name and does not ship it. Windows 11 has its own
(older) ``onnxruntime.dll`` in System32, which the loader finds first and which lacks the ORT API level
sherpa needs (the process then crashes with an access violation). Registering the pip ``onnxruntime``
package's DLL directory before the import makes the loader pick the matching runtime.
"""

from __future__ import annotations

import os
import sys
from functools import cache
from pathlib import Path
from typing import Any


@cache
def import_sherpa() -> Any:
    if sys.platform == "win32":
        import onnxruntime  # noqa: PLC0415

        capi = Path(onnxruntime.__file__).parent / "capi"
        if (capi / "onnxruntime.dll").is_file():
            os.add_dll_directory(str(capi))
    import sherpa_onnx  # noqa: PLC0415

    return sherpa_onnx
