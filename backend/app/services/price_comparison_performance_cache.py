"""Bounded process-local caches for immutable price-comparison revisions.

The shared Graph inventory is deliberately not cached here.  A request must
still obtain a fresh snapshot and therefore a fresh revision before any value
from this module can be reused.
"""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass, fields, is_dataclass
from pathlib import Path
import sys
from threading import Event, Lock
from typing import Any, Callable, Hashable, TypeVar, cast

import pandas as pd

from app.services.price_comparison_timing import record_cache_hit, record_cache_miss


T = TypeVar("T")
_MISSING = object()
DEFAULT_MAX_ENTRIES = 64
DEFAULT_MAX_BYTES = 128 * 1024 * 1024


@dataclass
class _Entry:
    value: Any
    size: int


@dataclass
class _Flight:
    event: Event
    value: Any = _MISSING
    error: BaseException | None = None


@dataclass(frozen=True)
class CacheInfo:
    entries: int
    bytes: int
    inflight: int
    max_entries: int
    max_bytes: int


def estimate_value_bytes(value: Any) -> int:
    """Conservatively estimate retained memory without copying cached values."""

    seen: set[int] = set()

    def size(item: Any) -> int:
        item_id = id(item)
        if item_id in seen:
            return 0
        seen.add(item_id)
        if isinstance(item, pd.DataFrame):
            return int(item.memory_usage(index=True, deep=True).sum())
        if isinstance(item, pd.Series):
            return int(item.memory_usage(index=True, deep=True))
        if isinstance(item, dict):
            return sys.getsizeof(item) + sum(size(key) + size(entry) for key, entry in item.items())
        if isinstance(item, (list, tuple, set, frozenset, OrderedDict)):
            return sys.getsizeof(item) + sum(size(entry) for entry in item)
        if is_dataclass(item) and not isinstance(item, type):
            return sys.getsizeof(item) + sum(size(getattr(item, field.name)) for field in fields(item))
        return sys.getsizeof(item)

    return max(1, size(value))


class RevisionBoundCache:
    """LRU cache with per-key single-flight and a global memory ceiling."""

    def __init__(
        self,
        *,
        max_entries: int = DEFAULT_MAX_ENTRIES,
        max_bytes: int = DEFAULT_MAX_BYTES,
    ) -> None:
        if max_entries < 1 or max_bytes < 1:
            raise ValueError("cache bounds must be positive")
        self.max_entries = int(max_entries)
        self.max_bytes = int(max_bytes)
        self._entries: OrderedDict[Hashable, _Entry] = OrderedDict()
        self._inflight: dict[Hashable, _Flight] = {}
        self._bytes = 0
        self._lock = Lock()

    def get_or_compute(
        self,
        key: Hashable,
        factory: Callable[[], T],
        *,
        estimate: Callable[[T], int] = estimate_value_bytes,
    ) -> T:
        with self._lock:
            cached = self._entries.get(key)
            if cached is not None:
                record_cache_hit("derived", "memory")
                self._entries.move_to_end(key)
                return cast(T, cached.value)
            flight = self._inflight.get(key)
            owner = flight is None
            if owner:
                record_cache_miss("derived", "memory")
                flight = _Flight(Event())
                self._inflight[key] = flight

        assert flight is not None
        if not owner:
            flight.event.wait()
            if flight.error is not None:
                raise flight.error
            if flight.value is _MISSING:
                raise RuntimeError("price-comparison cache flight completed without a value")
            return cast(T, flight.value)

        try:
            value = factory()
            retained = max(1, int(estimate(value)))
        except BaseException as exc:
            with self._lock:
                flight.error = exc
                self._inflight.pop(key, None)
                flight.event.set()
            raise

        with self._lock:
            flight.value = value
            if retained <= self.max_bytes:
                previous = self._entries.pop(key, None)
                if previous is not None:
                    self._bytes -= previous.size
                self._entries[key] = _Entry(value, retained)
                self._bytes += retained
                while (
                    len(self._entries) > self.max_entries
                    or self._bytes > self.max_bytes
                ):
                    _, removed = self._entries.popitem(last=False)
                    self._bytes -= removed.size
            self._inflight.pop(key, None)
            flight.event.set()
        return value

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()
            self._bytes = 0

    def info(self) -> CacheInfo:
        with self._lock:
            return CacheInfo(
                entries=len(self._entries),
                bytes=self._bytes,
                inflight=len(self._inflight),
                max_entries=self.max_entries,
                max_bytes=self.max_bytes,
            )


def store_cache_scope(store: Any, cache_dir: Path) -> tuple[str, ...]:
    """Separate tenants, Graph clients, stores and local cache directories."""

    config = getattr(store, "config", None)
    return (
        f"{type(store).__module__}.{type(store).__qualname__}",
        str(getattr(store, "mode", "")),
        str(getattr(store, "identity", "")),
        str(getattr(config, "ms_graph_base_url", "")),
        str(getattr(config, "ms_tenant_id", "")),
        str(getattr(config, "ms_client_id", "")),
        str(Path(cache_dir).resolve()),
    )


def calendar_day_key() -> str:
    """Match the legacy calculations' local, normalized calendar-day boundary."""

    return pd.Timestamp.now(tz=None).normalize().isoformat()


price_comparison_cache = RevisionBoundCache()
