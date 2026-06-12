from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
import hashlib
import json
import logging
from pathlib import Path
from time import perf_counter
from typing import Any, Callable

from app.core.config import settings


LOGGER = logging.getLogger(__name__)


def build_pdf_version_hash(parts: Any) -> str:
    payload = json.dumps(parts, default=_json_default, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:24]


class DocumentPdfCache:
    def __init__(self, cache_dir: str | None = None) -> None:
        self.cache_dir = Path(cache_dir or settings.document_pdf_cache_dir)

    def get_or_build(
        self,
        *,
        cache_key: str,
        version_hash: str,
        build: Callable[[], bytes],
    ) -> tuple[bytes, bool]:
        started_at = perf_counter()
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        safe_key = _safe_cache_key(cache_key)
        path = self.cache_dir / f"{safe_key}-{version_hash}.pdf"
        if path.exists():
            content = path.read_bytes()
            LOGGER.info(
                "PDF cache hit: key=%s version=%s bytes=%s duration_ms=%.1f",
                safe_key,
                version_hash,
                len(content),
                (perf_counter() - started_at) * 1000,
            )
            return content, True

        content = build()
        temporary_path = path.with_suffix(".tmp")
        temporary_path.write_bytes(content)
        temporary_path.replace(path)
        self._remove_stale_versions(safe_key, path)
        LOGGER.info(
            "PDF cache stored: key=%s version=%s bytes=%s duration_ms=%.1f",
            safe_key,
            version_hash,
            len(content),
            (perf_counter() - started_at) * 1000,
        )
        return content, False

    def _remove_stale_versions(self, safe_key: str, active_path: Path) -> None:
        for stale_path in self.cache_dir.glob(f"{safe_key}-*.pdf"):
            if stale_path == active_path:
                continue
            try:
                stale_path.unlink()
            except OSError:
                LOGGER.debug("Could not remove stale PDF cache file %s.", stale_path)


def _safe_cache_key(value: str) -> str:
    cleaned = "".join(char if char.isalnum() or char in {"-", "_"} else "-" for char in value)
    while "--" in cleaned:
        cleaned = cleaned.replace("--", "-")
    return cleaned.strip("-") or "document"


def _json_default(value: Any) -> str | int | float | None:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    return str(value)
