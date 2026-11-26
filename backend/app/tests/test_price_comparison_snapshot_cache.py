from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from threading import Event, Lock, Thread
from types import SimpleNamespace

import pytest

from app.services.price_comparison_snapshot_cache import ReadSnapshotCache
from app.services.price_comparison_storage import GraphPriceStorage, Snapshot


class Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class ManualScheduler:
    def __init__(self, callback) -> None:
        self.callback = callback
        self.wakes = 0
        self.closed = False

    def wake(self) -> None:
        self.wakes += 1

    def run(self):
        return self.callback()

    def close(self) -> None:
        self.closed = True


class SchedulerFactory:
    def __init__(self) -> None:
        self.instances: list[ManualScheduler] = []

    def __call__(self, callback) -> ManualScheduler:
        scheduler = ManualScheduler(callback)
        self.instances.append(scheduler)
        return scheduler


class Source:
    def __init__(self, value: str = "first") -> None:
        self.value = value
        self.fail = False
        self.calls = 0
        self.lock = Lock()
        self.started: Event | None = None
        self.release: Event | None = None

    def load(self, _store) -> Snapshot:
        with self.lock:
            self.calls += 1
            value = self.value
            fail = self.fail
            started = self.started
            release = self.release
        if started is not None:
            started.set()
        if release is not None:
            assert release.wait(timeout=2)
        if fail:
            raise RuntimeError("Graph refresh failed")
        return Snapshot([], {"value": [value]}, None, value, [])


class Store:
    mode = "onedrive"
    configured = True

    def __init__(self, source: Source, identity: str = "drive:root") -> None:
        self.source = source
        self.identity = identity
        self.config = SimpleNamespace(
            ms_graph_base_url="https://graph.microsoft.com/v1.0",
            ms_tenant_id="tenant",
            ms_client_id="client",
        )


def make_cache(
    clock: Clock,
    schedulers: SchedulerFactory | None = None,
    *,
    max_entries: int = 32,
    max_refresh_seconds: float = 15,
    store_factory=None,
) -> ReadSnapshotCache:
    return ReadSnapshotCache(
        clock=clock,
        scheduler_factory=schedulers,
        snapshot_loader=lambda store: store.source.load(store),
        store_factory=store_factory or (lambda store: Store(store.source, store.identity)),
        is_cacheable=lambda _store: True,
        max_entries=max_entries,
        max_refresh_seconds=max_refresh_seconds,
    )


def test_first_read_is_fresh_and_cached_snapshots_are_defensive(tmp_path):
    clock = Clock()
    source = Source()
    cache = make_cache(clock)
    store = Store(source)

    first = cache.read(store, tmp_path)
    first.state["value"].append("poison")
    second = cache.read(store, tmp_path)

    assert first is not second
    assert second.state == {"value": ["first"]}
    assert source.calls == 1


def test_active_entry_refreshes_every_fifteen_seconds(tmp_path):
    clock = Clock()
    schedulers = SchedulerFactory()
    source = Source()
    cache = make_cache(clock, schedulers)
    store = Store(source)

    assert cache.read(store, tmp_path).revision == "first"
    assert len(schedulers.instances) == 1
    source.value = "second"
    clock.advance(14.9)
    schedulers.instances[0].run()
    assert source.calls == 1

    clock.advance(0.1)
    schedulers.instances[0].run()
    assert source.calls == 2
    assert cache.read(store, tmp_path).revision == "second"


def test_background_refresh_stops_after_idle_and_next_read_is_fresh(tmp_path):
    clock = Clock()
    schedulers = SchedulerFactory()
    source = Source()
    cache = make_cache(clock, schedulers)
    store = Store(source)

    cache.read(store, tmp_path)
    scheduler = schedulers.instances[0]
    for _ in range(3):
        clock.advance(15)
        scheduler.run()
    assert source.calls == 4

    clock.advance(15)
    scheduler.run()
    assert source.calls == 4
    source.value = "after-idle"
    clock.advance(40)
    assert cache.read(store, tmp_path).revision == "after-idle"
    assert source.calls == 5


def test_failed_background_refresh_blocks_stale_reads_until_retry(tmp_path):
    clock = Clock()
    schedulers = SchedulerFactory()
    source = Source()
    cache = make_cache(clock, schedulers)
    store = Store(source)

    cache.read(store, tmp_path)
    source.fail = True
    clock.advance(15)
    schedulers.instances[0].run()
    assert source.calls == 2

    with pytest.raises(RuntimeError, match="Graph refresh failed"):
        cache.read(store, tmp_path)
    assert source.calls == 3

    source.fail = False
    source.value = "recovered"
    assert cache.read(store, tmp_path).revision == "recovered"
    assert source.calls == 4


def test_inflight_background_refresh_serves_stale_only_for_bounded_window(tmp_path):
    clock = Clock()
    schedulers = SchedulerFactory()
    source = Source()
    cache = make_cache(clock, schedulers, max_refresh_seconds=5)
    store = Store(source)

    assert cache.read(store, tmp_path).revision == "first"
    source.value = "refreshed"
    source.started = Event()
    source.release = Event()
    clock.advance(15)
    refresh = Thread(target=schedulers.instances[0].run)
    refresh.start()
    assert source.started.wait(timeout=2)

    with ThreadPoolExecutor(max_workers=1) as executor:
        stale = executor.submit(cache.read, store, tmp_path)
        assert stale.result(timeout=0.5).revision == "first"

    clock.advance(5.1)
    with pytest.raises(TimeoutError, match="refresh timed out"):
        cache.read(store, tmp_path)

    source.release.set()
    refresh.join(timeout=2)
    assert not refresh.is_alive()
    source.started = None
    source.release = None
    assert cache.read(store, tmp_path).revision == "refreshed"


def test_invalidation_never_serves_stale_from_an_inflight_refresh(tmp_path):
    clock = Clock()
    schedulers = SchedulerFactory()
    source = Source()
    cache = make_cache(clock, schedulers)
    store = Store(source)
    cache.read(store, tmp_path)

    old_started = Event()
    old_release = Event()
    source.value = "old-generation"
    source.started = old_started
    source.release = old_release
    clock.advance(15)
    old_refresh = Thread(target=schedulers.instances[0].run)
    old_refresh.start()
    assert old_started.wait(timeout=2)

    cache.invalidate(store, tmp_path)
    new_started = Event()
    new_release = Event()
    source.value = "new-generation"
    source.started = new_started
    source.release = new_release
    with ThreadPoolExecutor(max_workers=1) as executor:
        fresh = executor.submit(cache.read, store, tmp_path)
        assert new_started.wait(timeout=2)
        assert not fresh.done()
        new_release.set()
        assert fresh.result(timeout=2).revision == "new-generation"

    old_release.set()
    old_refresh.join(timeout=2)
    assert not old_refresh.is_alive()
    source.started = None
    source.release = None
    assert cache.read(store, tmp_path).revision == "new-generation"


def test_concurrent_first_reads_are_singleflight(tmp_path):
    clock = Clock()
    source = Source()
    source.started = Event()
    source.release = Event()
    cache = make_cache(clock)
    store = Store(source)

    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(cache.read, store, tmp_path)
        assert source.started.wait(timeout=2)
        second = executor.submit(cache.read, store, tmp_path)
        source.release.set()
        results = [first.result(timeout=2), second.result(timeout=2)]

    assert [result.revision for result in results] == ["first", "first"]
    assert source.calls == 1
    assert results[0] is not results[1]


def test_invalidation_discards_an_inflight_old_generation(tmp_path):
    clock = Clock()
    schedulers = SchedulerFactory()
    source = Source()
    cache = make_cache(clock, schedulers)
    store = Store(source)
    cache.read(store, tmp_path)

    source.started = Event()
    source.release = Event()
    clock.advance(15)
    refresh = Thread(target=schedulers.instances[0].run)
    refresh.start()
    assert source.started.wait(timeout=2)

    cache.invalidate(store, tmp_path)
    source.value = "new-generation"
    source.release.set()
    refresh.join(timeout=2)
    assert not refresh.is_alive()

    source.started = None
    source.release = None
    assert cache.read(store, tmp_path).revision == "new-generation"
    assert source.calls == 3


def test_marker_invalidation_is_observed_by_another_cache_instance(tmp_path):
    clock = Clock()
    source = Source()
    first_cache = make_cache(clock)
    second_cache = make_cache(clock)
    store = Store(source)

    assert first_cache.read(store, tmp_path).revision == "first"
    assert second_cache.read(store, tmp_path).revision == "first"
    source.value = "cross-worker"
    first_cache.invalidate(store, tmp_path)

    assert second_cache.read(store, tmp_path).revision == "cross-worker"
    assert source.calls == 3


def test_cross_worker_marker_prevents_old_inflight_publish(tmp_path):
    clock = Clock()
    schedulers = SchedulerFactory()
    source = Source()
    invalidator = make_cache(clock)
    reader = make_cache(clock, schedulers)
    store = Store(source)
    reader.read(store, tmp_path)

    source.started = Event()
    source.release = Event()
    clock.advance(15)
    refresh = Thread(target=schedulers.instances[0].run)
    refresh.start()
    assert source.started.wait(timeout=2)

    invalidator.invalidate(store, tmp_path)
    source.value = "after-cross-worker-invalidation"
    source.release.set()
    refresh.join(timeout=2)
    assert not refresh.is_alive()

    source.started = None
    source.release = None
    assert reader.read(store, tmp_path).revision == "after-cross-worker-invalidation"
    assert source.calls == 3


def test_cache_is_bounded_and_uses_one_scheduler(tmp_path):
    clock = Clock()
    schedulers = SchedulerFactory()
    source = Source()
    cache = make_cache(clock, schedulers, max_entries=2)

    for index in range(3):
        cache.read(Store(source, f"drive:root:{index}"), tmp_path)

    assert cache.entry_count() == 2
    assert len(schedulers.instances) == 1
    cache.close()
    assert schedulers.instances[0].closed is True


def test_every_refresh_uses_a_new_store_instance(tmp_path):
    clock = Clock()
    schedulers = SchedulerFactory()
    source = Source()
    original = Store(source)
    created: list[Store] = []

    def factory(store):
        fresh = Store(store.source, store.identity)
        created.append(fresh)
        return fresh

    cache = make_cache(clock, schedulers, store_factory=factory)
    cache.read(original, tmp_path)
    clock.advance(15)
    schedulers.instances[0].run()

    assert len(created) == 2
    assert all(store is not original for store in created)


def test_graph_refresh_reuses_project_runtime_but_not_folder_caches(tmp_path):
    config = SimpleNamespace(
        ms_graph_enabled=True,
        ms_project_drive_id="drive",
        ms_project_root_folder_id="root",
        ms_tenant_id="tenant",
        ms_client_id="client",
        ms_client_secret="secret",
        ms_graph_base_url="https://graph.microsoft.com/v1.0",
    )
    project_storage = SimpleNamespace(graph_client=object())
    original = GraphPriceStorage(config, project_storage=project_storage)
    original._folder_cache["offers"] = ("price-root", "offers")
    refreshed: list[GraphPriceStorage] = []

    def load(store):
        refreshed.append(store)
        return Snapshot([], {"value": ["fresh"]}, None, "fresh", [])

    cache = ReadSnapshotCache(scheduler_factory=None, snapshot_loader=load)
    assert cache.read(original, tmp_path).revision == "fresh"

    assert len(refreshed) == 1
    assert refreshed[0] is not original
    assert refreshed[0].project_storage is project_storage
    assert refreshed[0]._folder_cache == {}


def test_non_cacheable_storage_always_reads_fresh_without_scheduler(tmp_path):
    source = Source()
    schedulers = SchedulerFactory()
    cache = ReadSnapshotCache(
        scheduler_factory=schedulers,
        snapshot_loader=lambda store: store.source.load(store),
        is_cacheable=lambda _store: False,
    )
    store = Store(source)

    assert cache.read(store, tmp_path).revision == "first"
    source.value = "second"
    assert cache.read(store, tmp_path).revision == "second"
    assert source.calls == 2
    assert schedulers.instances == []


def test_marker_write_failure_aborts_invalidation(tmp_path, monkeypatch):
    clock = Clock()
    source = Source()
    cache = make_cache(clock)
    store = Store(source)
    cache.read(store, tmp_path)

    def fail(_path):
        raise OSError("disk full")

    monkeypatch.setattr(cache, "_write_marker", fail)
    with pytest.raises(OSError, match="disk full"):
        cache.invalidate(store, tmp_path)
    assert cache.read(store, tmp_path).revision == "first"


@pytest.mark.parametrize("loader_fails", [False, True])
def test_completion_marker_failure_wakes_waiters_and_recovers(
    tmp_path,
    monkeypatch,
    loader_fails,
):
    clock = Clock()
    source = Source()
    source.fail = loader_fails
    source.started = Event()
    source.release = Event()
    cache = make_cache(clock)
    store = Store(source)
    original_read_marker = cache._read_marker
    marker_reads = 0
    marker_reads_lock = Lock()
    waiter_checked_marker = Event()

    def fail_owner_completion(path):
        nonlocal marker_reads
        with marker_reads_lock:
            marker_reads += 1
            current = marker_reads
        if current == 2:
            waiter_checked_marker.set()
        if current == 3:
            raise OSError("marker unavailable during completion")
        return original_read_marker(path)

    monkeypatch.setattr(cache, "_read_marker", fail_owner_completion)
    with ThreadPoolExecutor(max_workers=2) as executor:
        owner = executor.submit(cache.read, store, tmp_path)
        assert source.started.wait(timeout=2)
        entry = next(iter(cache._entries.values()))
        assert entry.flight is not None
        flight = entry.flight
        original_wait = flight.event.wait
        waiter_joined_flight = Event()

        def observe_wait(*args, **kwargs):
            waiter_joined_flight.set()
            return original_wait(*args, **kwargs)

        monkeypatch.setattr(flight.event, "wait", observe_wait)
        waiter = executor.submit(cache.read, store, tmp_path)
        assert waiter_checked_marker.wait(timeout=2)
        assert waiter_joined_flight.wait(timeout=2)
        source.release.set()
        with pytest.raises(OSError, match="marker unavailable"):
            owner.result(timeout=2)
        with pytest.raises(OSError, match="marker unavailable"):
            waiter.result(timeout=2)

    entry = next(iter(cache._entries.values()))
    assert entry.flight is None
    assert isinstance(entry.refresh_error, OSError)
    monkeypatch.setattr(cache, "_read_marker", original_read_marker)
    source.fail = False
    source.started = None
    source.release = None
    source.value = "recovered"
    assert cache.read(store, tmp_path).revision == "recovered"


def test_background_completion_marker_failure_does_not_wedge_scope(
    tmp_path,
    monkeypatch,
):
    clock = Clock()
    schedulers = SchedulerFactory()
    source = Source()
    cache = make_cache(clock, schedulers)
    store = Store(source)
    cache.read(store, tmp_path)
    source.value = "background"
    clock.advance(15)
    original_read_marker = cache._read_marker
    marker_reads = 0

    def fail_completion(path):
        nonlocal marker_reads
        marker_reads += 1
        if marker_reads == 2:
            raise OSError("background completion marker unavailable")
        return original_read_marker(path)

    monkeypatch.setattr(cache, "_read_marker", fail_completion)
    with pytest.raises(OSError, match="background completion marker"):
        schedulers.instances[0].run()
    entry = next(iter(cache._entries.values()))
    assert entry.flight is None
    assert isinstance(entry.refresh_error, OSError)

    monkeypatch.setattr(cache, "_read_marker", original_read_marker)
    source.value = "recovered"
    assert cache.read(store, tmp_path).revision == "recovered"
