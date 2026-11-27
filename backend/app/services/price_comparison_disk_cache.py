"""Disposable JSON results shared by price-comparison application workers.

Keys include the verified source revision, calculation version and calendar day.
The cache never replaces a source inventory check, and failed cache I/O must not
prevent reading the original data. No uploaded or externally supplied pickle is
read here.
"""

from __future__ import annotations

from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import tempfile
from typing import Callable, TypeVar

from app.services.price_comparison_timing import record_cache_hit, record_cache_miss


T = TypeVar("T")
FORMAT_VERSION = 1
MAX_ENTRY_BYTES = 16 * 1024 * 1024
MAX_CACHE_BYTES = 64 * 1024 * 1024
MAX_CACHE_ENTRIES = 32
_MISSING = object()


class PriceOverviewDiskCache:
    def __init__(self, cache_dir: Path):
        self.directory = Path(cache_dir) / "offer-overviews-v1"

    @staticmethod
    def _digest(key: tuple[str, ...]) -> str:
        return hashlib.sha256(json.dumps(key, ensure_ascii=False).encode()).hexdigest()

    def _read(self, path: Path, digest: str, validate: Callable[[object], bool]):
        try:
            if self.directory.is_symlink() or path.is_symlink() or path.stat().st_size > MAX_ENTRY_BYTES:
                return _MISSING
            envelope = json.loads(path.read_bytes())
            if (
                not isinstance(envelope, dict)
                or envelope.get("format") != FORMAT_VERSION
                or envelope.get("key") != digest
                or not validate(envelope.get("value"))
            ):
                return _MISSING
            value = envelope["value"]
            payload = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
            if hashlib.sha256(payload.encode()).hexdigest() != envelope.get("sha256"):
                return _MISSING
            return value
        except (OSError, ValueError, TypeError, RecursionError):
            return _MISSING

    @contextmanager
    def _fill_lock(self):
        # A stable lock file is never unlinked while another worker can hold it.
        if self.directory.is_symlink():
            raise OSError("Invalid derived-cache directory")
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        path = self.directory / ".fill.lock"
        descriptor = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "a+b") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)

    def _write(self, path: Path, digest: str, value: T) -> None:
        payload = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        encoded = json.dumps({
            "format": FORMAT_VERSION,
            "key": digest,
            "sha256": hashlib.sha256(payload.encode()).hexdigest(),
            "value": value,
        }, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode()
        if len(encoded) > MAX_ENTRY_BYTES:
            return
        with tempfile.NamedTemporaryFile(dir=self.directory, prefix=".overview-", delete=False) as handle:
            temporary = Path(handle.name)
            try:
                handle.write(encoded)
                handle.flush()
                os.replace(temporary, path)
            finally:
                temporary.unlink(missing_ok=True)
        self._prune(path)

    def _prune(self, current: Path) -> None:
        candidates = []
        for path in self.directory.glob("*.json"):
            if len(path.stem) != 64 or any(c not in "0123456789abcdef" for c in path.stem):
                continue
            if path.is_symlink():
                continue
            stat = path.stat()
            candidates.append((path, stat.st_mtime_ns, stat.st_size))
        candidates.sort(key=lambda entry: (entry[0] == current, entry[1]), reverse=True)
        total = 0
        for index, (path, _mtime, size) in enumerate(candidates):
            total += size
            if index >= MAX_CACHE_ENTRIES or total > MAX_CACHE_BYTES:
                path.unlink(missing_ok=True)

    def get_or_compute(
        self, key: tuple[str, ...], factory: Callable[[], T],
        *, validate: Callable[[object], bool],
    ) -> T:
        digest = self._digest(key)
        path = self.directory / f"{digest}.json"
        cached = self._read(path, digest, validate)
        if cached is not _MISSING:
            record_cache_hit("overview", "disk")
            return cached
        # Entering the lock may fail on read-only/full storage. Keep exceptions
        # from the actual calculation separate, so a failed factory runs once.
        lock = self._fill_lock()
        try:
            lock.__enter__()
        except OSError:
            return factory()
        try:
            cached = self._read(path, digest, validate)
            if cached is not _MISSING:
                record_cache_hit("overview", "disk")
                return cached
            record_cache_miss("overview", "disk")
            result = factory()
            try:
                if validate(result):
                    self._write(path, digest, result)
            except (OSError, ValueError, TypeError, RecursionError):
                pass  # The cache is an optimization; the result remains valid.
            return result
        finally:
            lock.__exit__(None, None, None)
