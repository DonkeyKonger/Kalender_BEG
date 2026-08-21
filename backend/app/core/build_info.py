from __future__ import annotations

import os
import re
from pathlib import Path


BUILD_REVISION_PATH = Path(__file__).resolve().parents[1] / "build_sha.txt"
REVISION_PATTERN = re.compile(r"^[0-9a-f]{7,64}$", re.IGNORECASE)


def get_build_revision() -> str:
    revision = os.getenv("APP_BUILD_SHA", "").strip()
    if not revision and BUILD_REVISION_PATH.exists():
        revision = BUILD_REVISION_PATH.read_text(encoding="utf-8").strip()
    return revision if REVISION_PATTERN.fullmatch(revision) else "development"
