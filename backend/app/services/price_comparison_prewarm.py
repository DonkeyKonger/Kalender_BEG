"""Coalesced background preparation of the current price overview.

One daemon per process, one active preparation across application workers. The
original read path remains usable if preparation fails or has not finished.
"""

from __future__ import annotations

import asyncio
from collections import OrderedDict
from contextlib import contextmanager
import fcntl
import logging
import os
from pathlib import Path
from threading import Condition, Lock, Thread, current_thread
from typing import Callable


logger = logging.getLogger(__name__)
MAX_PENDING = 8


class OverviewPrewarmer:
    def __init__(self):
        self._condition = Condition()
        self._pending: OrderedDict[tuple[str, ...], Callable[[], None]] = OrderedDict()
        self._closed = False
        self._thread = Thread(target=self._run, name="price-overview-prewarm", daemon=True)
        self._thread.start()

    def submit(self, key: tuple[str, ...], callback: Callable[[], None]) -> None:
        with self._condition:
            if self._closed:
                return
            self._pending[key] = callback
            self._pending.move_to_end(key)
            while len(self._pending) > MAX_PENDING:
                self._pending.popitem(last=False)
            self._condition.notify()

    def _run(self):
        while True:
            with self._condition:
                self._condition.wait_for(lambda: self._closed or self._pending)
                if self._closed:
                    return
                _key, callback = self._pending.popitem(last=False)
            try:
                callback()
            except Exception:
                # Avoid source names, URLs or credentials from exception text.
                logger.warning("Price overview background preparation failed")

    def close(self):
        with self._condition:
            self._closed = True
            self._pending.clear()
            self._condition.notify_all()
        if self._thread is not current_thread():
            self._thread.join()


@contextmanager
def _worker_lock(cache_dir: Path):
    cache_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor = os.open(cache_dir / ".overview-prewarm.lock",
                         os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "a+b") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


_worker: OverviewPrewarmer | None = None
_guard = Lock()


def schedule_overview_prewarm(store, cache_dir: Path):
    from app.services.price_comparison_performance_cache import store_cache_scope
    from app.services.price_comparison_service import PriceComparisonService
    from app.services.price_comparison_storage import GraphPriceStorage

    # Local development and tests keep their explicit, on-demand read behavior.
    if not isinstance(store, GraphPriceStorage) or not store.configured:
        return
    key = store_cache_scope(store, cache_dir)

    def prepare():
        with _worker_lock(cache_dir):
            # Fresh store and snapshot: no request-scoped mutable folder state.
            fresh = GraphPriceStorage(store.config, project_storage=store.project_storage)
            PriceComparisonService(fresh, cache_dir=cache_dir).prewarm_overview()

    global _worker
    with _guard:
        if _worker is None:
            _worker = OverviewPrewarmer()
        _worker.submit(key, prepare)


def start_price_comparison_prewarm():
    from app.core.config import settings
    from app.services.price_comparison_storage import get_price_storage

    schedule_overview_prewarm(get_price_storage(), Path(settings.price_comparison_cache_dir))


async def stop_price_comparison_prewarm():
    global _worker
    with _guard:
        worker, _worker = _worker, None
    if worker is not None:
        await asyncio.to_thread(worker.close)
