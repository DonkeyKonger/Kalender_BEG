"""Short-lived, read-only snapshots for the price-comparison UI.

The original storage ``snapshot()`` and every mutation path remain untouched.
Only ordinary Graph reads use this process-local cache. A marker file in the
existing local cache directory invalidates all application workers without
turning that marker into a source of truth for cloud data.
"""

from __future__ import annotations

import atexit
from collections import OrderedDict
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import dataclass
import fcntl
import hashlib
import json
import os
from pathlib import Path
from threading import Event, Lock, Thread, current_thread
import time
from typing import Any, Callable, Protocol
from uuid import uuid4

from app.services.price_comparison_performance_cache import store_cache_scope
from app.services.price_comparison_storage import GraphPriceStorage, Snapshot, snapshot


REFRESH_SECONDS = 15.0
MAX_REFRESH_SECONDS = 15.0
IDLE_SECONDS = 60.0
MAX_ENTRIES = 32


class _Scheduler(Protocol):
    def wake(self) -> None: ...

    def close(self) -> None: ...


class _ThreadScheduler:
    """One bounded daemon thread for every cache, never one per entry."""

    def __init__(self, callback: Callable[[], float | None]) -> None:
        self._callback = callback
        self._wake = Event()
        self._closed = Event()
        self._thread = Thread(
            target=self._run,
            name="price-snapshot-refresh",
            daemon=True,
        )
        self._thread.start()

    def _run(self) -> None:
        while not self._closed.is_set():
            self._wake.clear()
            try:
                delay = self._callback()
            except Exception:
                # Per-entry refresh failures are recorded by the cache. This
                # guard only prevents an unexpected scheduler fault from
                # creating a tight loop or replacement threads.
                delay = 1.0
            if self._closed.is_set():
                break
            self._wake.wait(timeout=60.0 if delay is None else max(0.01, delay))

    def wake(self) -> None:
        self._wake.set()

    def close(self) -> None:
        self._closed.set()
        self._wake.set()
        if self._thread is not current_thread():
            # Graph requests already have a configured timeout. Waiting here
            # guarantees the shared HTTP runtime is not closed under an active
            # refresh during application shutdown.
            self._thread.join()


@dataclass
class _Flight:
    event: Event
    started_at: float
    error: BaseException | None = None
    retry: bool = False


@dataclass
class _Entry:
    key: tuple[str, ...]
    store_template: Any
    marker_path: Path
    lock_path: Path
    marker: str = ""
    canonical: Snapshot | None = None
    loaded_at: float = 0.0
    last_access: float = 0.0
    generation: int = 0
    flight: _Flight | None = None
    refresh_error: BaseException | None = None


def _new_graph_store(store: Any) -> Any:
    """Use fresh folder caches while retaining the shared Graph runtime."""

    if isinstance(store, GraphPriceStorage):
        return GraphPriceStorage(
            store.config,
            project_storage=store.project_storage,
        )
    return store


def _is_graph_store(store: Any) -> bool:
    return isinstance(store, GraphPriceStorage)


class ReadSnapshotCache:
    """Bounded revision discovery cache with fail-closed refresh semantics."""

    def __init__(
        self,
        *,
        refresh_seconds: float = REFRESH_SECONDS,
        max_refresh_seconds: float = MAX_REFRESH_SECONDS,
        idle_seconds: float = IDLE_SECONDS,
        max_entries: int = MAX_ENTRIES,
        clock: Callable[[], float] = time.monotonic,
        scheduler_factory: Callable[[Callable[[], float | None]], _Scheduler]
        | None = _ThreadScheduler,
        snapshot_loader: Callable[[Any], Snapshot] = snapshot,
        store_factory: Callable[[Any], Any] = _new_graph_store,
        is_cacheable: Callable[[Any], bool] = _is_graph_store,
    ) -> None:
        if refresh_seconds <= 0 or max_refresh_seconds <= 0 or idle_seconds <= 0 or max_entries < 1:
            raise ValueError("snapshot cache bounds must be positive")
        self.refresh_seconds = float(refresh_seconds)
        self.max_refresh_seconds = float(max_refresh_seconds)
        self.idle_seconds = float(idle_seconds)
        self.max_entries = int(max_entries)
        self._clock = clock
        self._scheduler_factory = scheduler_factory
        self._snapshot_loader = snapshot_loader
        self._store_factory = store_factory
        self._is_cacheable = is_cacheable
        self._entries: OrderedDict[tuple[str, ...], _Entry] = OrderedDict()
        self._lock = Lock()
        self._scheduler: _Scheduler | None = None
        self._closed = False

    def read(self, store: Any, cache_dir: str | Path) -> Snapshot:
        """Return a defensive snapshot copy, refreshing Graph data as needed."""

        if not self._is_cacheable(store):
            return deepcopy(self._snapshot_loader(store))
        self._ensure_open()
        self._ensure_scheduler()
        key = store_cache_scope(store, Path(cache_dir))
        marker_path, lock_path = self._marker_paths(key, Path(cache_dir))

        while True:
            owner: tuple[_Entry, _Flight, int, str] | None = None
            waiter: _Flight | None = None
            with self._marker_guard(lock_path, exclusive=False):
                marker = self._read_marker(marker_path)
                now = self._clock()
                with self._lock:
                    self._ensure_open_locked()
                    entry = self._entry(
                        key,
                        store,
                        marker_path,
                        lock_path,
                        marker,
                        now,
                    )
                    entry.store_template = store
                    entry.last_access = now
                    if (
                        entry.canonical is not None
                        and entry.refresh_error is None
                        and now - entry.loaded_at < self.refresh_seconds
                    ):
                        result = deepcopy(entry.canonical)
                        self._wake_scheduler_locked()
                        return result
                    if (
                        entry.canonical is not None
                        and entry.refresh_error is None
                        and entry.flight is not None
                        and now - entry.loaded_at < self.refresh_seconds + self.max_refresh_seconds
                        and now - entry.flight.started_at < self.max_refresh_seconds
                    ):
                        # A marker change resets ``canonical`` before this
                        # branch.  The previous value may therefore bridge
                        # only one already-running refresh, never a mutation,
                        # a known refresh failure, or an unbounded hang.
                        result = deepcopy(entry.canonical)
                        self._wake_scheduler_locked()
                        return result
                    if entry.flight is None:
                        flight = _Flight(Event(), started_at=now)
                        entry.flight = flight
                        owner = (entry, flight, entry.generation, marker)
                    else:
                        waiter = entry.flight

            if waiter is not None:
                remaining = self.max_refresh_seconds - (self._clock() - waiter.started_at)
                if remaining <= 0 or not waiter.event.wait(timeout=remaining):
                    raise TimeoutError("price snapshot refresh timed out")
                if waiter.retry:
                    continue
                if waiter.error is not None:
                    raise waiter.error
                continue

            assert owner is not None
            entry, flight, generation, marker = owner
            try:
                loaded = self._snapshot_loader(self._store_factory(entry.store_template))
            except BaseException as exc:
                if self._complete_error(entry, flight, generation, marker, exc):
                    raise
                continue
            published = self._complete_success(
                entry,
                flight,
                generation,
                marker,
                loaded,
                copy_result=True,
            )
            if published is not None:
                return published

    def invalidate(self, store: Any, cache_dir: str | Path) -> None:
        """Invalidate this scope in every worker before or after a mutation."""

        if not self._is_cacheable(store):
            return
        self._ensure_open()
        key = store_cache_scope(store, Path(cache_dir))
        marker_path, lock_path = self._marker_paths(key, Path(cache_dir))
        with self._marker_guard(lock_path, exclusive=True):
            marker = self._write_marker(marker_path)
            with self._lock:
                entry = self._entries.get(key)
                if entry is not None:
                    self._reset_entry(entry, marker)
                    self._entries.move_to_end(key)
                self._wake_scheduler_locked()

    def run_due(self) -> float | None:
        """Run due background work; also serves deterministic test schedulers."""

        with self._lock:
            if self._closed:
                return None
            now = self._clock()
            due = [
                key
                for key, entry in self._entries.items()
                if entry.canonical is not None
                and entry.refresh_error is None
                and entry.flight is None
                and now - entry.last_access < self.idle_seconds
                and now - entry.loaded_at >= self.refresh_seconds
            ]
        for key in due:
            self._background_refresh(key)
        return self._next_delay()

    def close(self) -> None:
        scheduler: _Scheduler | None
        with self._lock:
            if self._closed:
                return
            self._closed = True
            scheduler = self._scheduler
            self._scheduler = None
            entries = list(self._entries.values())
            self._entries.clear()
            for entry in entries:
                entry.generation += 1
                if entry.flight is not None:
                    entry.flight.retry = True
                    entry.flight.event.set()
        if scheduler is not None:
            scheduler.close()

    def entry_count(self) -> int:
        """Expose only a bounded count for diagnostics and tests."""

        with self._lock:
            return len(self._entries)

    def _background_refresh(self, key: tuple[str, ...]) -> None:
        owner: tuple[_Entry, _Flight, int, str] | None = None
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                return
            marker_path, lock_path = entry.marker_path, entry.lock_path
        with self._marker_guard(lock_path, exclusive=False):
            marker = self._read_marker(marker_path)
            now = self._clock()
            with self._lock:
                entry = self._entries.get(key)
                if entry is None or self._closed:
                    return
                if entry.marker != marker:
                    self._reset_entry(entry, marker)
                if now - entry.last_access >= self.idle_seconds or entry.flight is not None:
                    return
                if (
                    entry.canonical is not None
                    and entry.refresh_error is None
                    and now - entry.loaded_at < self.refresh_seconds
                ):
                    return
                flight = _Flight(Event(), started_at=now)
                entry.flight = flight
                owner = (entry, flight, entry.generation, marker)
        assert owner is not None
        entry, flight, generation, marker = owner
        try:
            loaded = self._snapshot_loader(self._store_factory(entry.store_template))
        except BaseException as exc:
            self._complete_error(entry, flight, generation, marker, exc)
            return
        self._complete_success(
            entry,
            flight,
            generation,
            marker,
            loaded,
            copy_result=False,
        )

    def _complete_success(
        self,
        entry: _Entry,
        flight: _Flight,
        generation: int,
        marker: str,
        loaded: Snapshot,
        *,
        copy_result: bool,
    ) -> Snapshot | None:
        try:
            with self._marker_guard(entry.lock_path, exclusive=False):
                current_marker = self._read_marker(entry.marker_path)
                with self._lock:
                    current = self._entries.get(entry.key)
                    if (
                        self._closed
                        or current is not entry
                        or entry.flight is not flight
                        or entry.generation != generation
                        or current_marker != marker
                    ):
                        if current is entry and current_marker != entry.marker:
                            self._reset_entry(entry, current_marker)
                        flight.retry = True
                        flight.event.set()
                        return None
                    entry.canonical = loaded
                    entry.loaded_at = self._clock()
                    entry.refresh_error = None
                    entry.flight = None
                    self._entries.move_to_end(entry.key)
                    flight.event.set()
                    result = deepcopy(loaded) if copy_result else None
                    self._wake_scheduler_locked()
                    return result
        except BaseException as error:
            self._abort_completion(entry, flight, error)
            raise

    def _complete_error(
        self,
        entry: _Entry,
        flight: _Flight,
        generation: int,
        marker: str,
        error: BaseException,
    ) -> bool:
        try:
            with self._marker_guard(entry.lock_path, exclusive=False):
                current_marker = self._read_marker(entry.marker_path)
                with self._lock:
                    current = self._entries.get(entry.key)
                    if (
                        self._closed
                        or current is not entry
                        or entry.flight is not flight
                        or entry.generation != generation
                        or current_marker != marker
                    ):
                        if current is entry and current_marker != entry.marker:
                            self._reset_entry(entry, current_marker)
                        flight.retry = True
                        flight.event.set()
                        return False
                    entry.refresh_error = error
                    entry.flight = None
                    flight.error = error
                    flight.event.set()
                    # Never retry failed background refreshes in a loop. The
                    # next read refreshes synchronously or fails; it cannot
                    # receive the old value indefinitely.
                    return True
        except BaseException as completion_error:
            self._abort_completion(entry, flight, completion_error)
            raise

    def _abort_completion(
        self,
        entry: _Entry,
        flight: _Flight,
        error: BaseException,
    ) -> None:
        """Wake every waiter when local marker validation itself fails."""

        with self._lock:
            current = self._entries.get(entry.key)
            if current is entry and entry.flight is flight:
                entry.refresh_error = error
                entry.flight = None
                flight.error = error
            else:
                flight.retry = True
            flight.event.set()

    def _entry(
        self,
        key: tuple[str, ...],
        store: Any,
        marker_path: Path,
        lock_path: Path,
        marker: str,
        now: float,
    ) -> _Entry:
        entry = self._entries.get(key)
        if entry is None:
            entry = _Entry(
                key,
                store,
                marker_path,
                lock_path,
                marker=marker,
                last_access=now,
            )
            self._entries[key] = entry
            self._trim_locked()
        elif entry.marker != marker:
            self._reset_entry(entry, marker)
        self._entries.move_to_end(key)
        return entry

    def _reset_entry(self, entry: _Entry, marker: str) -> None:
        entry.generation += 1
        entry.marker = marker
        entry.canonical = None
        entry.loaded_at = 0.0
        entry.refresh_error = None
        old_flight = entry.flight
        entry.flight = None
        if old_flight is not None:
            old_flight.retry = True
            old_flight.event.set()

    def _trim_locked(self) -> None:
        while len(self._entries) > self.max_entries:
            _, removed = self._entries.popitem(last=False)
            removed.generation += 1

    def _next_delay(self) -> float | None:
        with self._lock:
            if self._closed:
                return None
            now = self._clock()
            delays = [
                max(0.0, entry.loaded_at + self.refresh_seconds - now)
                for entry in self._entries.values()
                if entry.canonical is not None
                and entry.refresh_error is None
                and entry.flight is None
                and now - entry.last_access < self.idle_seconds
            ]
            return min(delays) if delays else None

    def _ensure_scheduler(self) -> None:
        if self._scheduler_factory is None:
            return
        with self._lock:
            self._ensure_open_locked()
            if self._scheduler is None:
                self._scheduler = self._scheduler_factory(self.run_due)

    def _wake_scheduler_locked(self) -> None:
        if self._scheduler is not None:
            self._scheduler.wake()

    def _ensure_open(self) -> None:
        with self._lock:
            self._ensure_open_locked()

    def _ensure_open_locked(self) -> None:
        if self._closed:
            raise RuntimeError("price snapshot cache is closed")

    @staticmethod
    def _marker_paths(key: tuple[str, ...], cache_dir: Path) -> tuple[Path, Path]:
        cache_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        digest = hashlib.sha256(
            json.dumps(key, ensure_ascii=False, separators=(",", ":")).encode()
        ).hexdigest()
        stem = cache_dir / f".price-read-snapshot-{digest}"
        return stem.with_suffix(".marker"), stem.with_suffix(".lock")

    @staticmethod
    @contextmanager
    def _marker_guard(lock_path: Path, *, exclusive: bool):
        if lock_path.is_symlink():
            raise RuntimeError("invalid price snapshot cache lock")
        with lock_path.open("a+b") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)
            try:
                yield
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)

    @staticmethod
    def _read_marker(marker_path: Path) -> str:
        if not marker_path.exists():
            return ""
        if marker_path.is_symlink():
            raise RuntimeError("invalid price snapshot cache marker")
        raw = marker_path.read_bytes()
        if len(raw) > 256:
            raise RuntimeError("invalid price snapshot cache marker")
        return hashlib.sha256(raw).hexdigest()

    @staticmethod
    def _write_marker(marker_path: Path) -> str:
        raw = uuid4().hex.encode("ascii")
        temporary = marker_path.with_name(f".{marker_path.name}.{os.getpid()}.{uuid4().hex}.tmp")
        try:
            with temporary.open("xb") as handle:
                handle.write(raw)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, marker_path)
        finally:
            temporary.unlink(missing_ok=True)
        return hashlib.sha256(raw).hexdigest()


_global_cache_lock = Lock()
_read_snapshot_cache: ReadSnapshotCache | None = None


def _global_cache() -> ReadSnapshotCache:
    global _read_snapshot_cache
    with _global_cache_lock:
        if _read_snapshot_cache is None:
            _read_snapshot_cache = ReadSnapshotCache()
        return _read_snapshot_cache


def read_snapshot(store: Any, cache_dir: str | Path) -> Snapshot:
    return _global_cache().read(store, cache_dir)


def invalidate_read_snapshots(store: Any, cache_dir: str | Path) -> None:
    _global_cache().invalidate(store, cache_dir)


def close_read_snapshot_cache() -> None:
    global _read_snapshot_cache
    with _global_cache_lock:
        cache = _read_snapshot_cache
        _read_snapshot_cache = None
    if cache is not None:
        cache.close()


atexit.register(close_read_snapshot_cache)
