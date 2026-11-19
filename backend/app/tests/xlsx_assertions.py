from __future__ import annotations

from hashlib import sha256

import pytest


def assert_xlsx_bytes_equal(actual: bytes, expected: bytes, *, context: str = "XLSX") -> None:
    """Assert exact bytes without asking pytest to diff an entire ZIP payload."""
    if actual == expected:
        return
    pytest.fail(
        f"{context} unterscheidet sich: "
        f"ist Länge={len(actual)}, SHA-256={sha256(actual).hexdigest()}; "
        f"erwartet Länge={len(expected)}, SHA-256={sha256(expected).hexdigest()}"
    )
