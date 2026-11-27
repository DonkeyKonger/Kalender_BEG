from __future__ import annotations

import asyncio
from contextlib import contextmanager
import logging
from threading import Event, Thread

import pytest

from app.services import price_comparison_performance_cache as performance_cache
from app.services import price_comparison_prewarm as prewarm
from app.services import price_comparison_service as service_module
from app.services import price_comparison_storage as storage_module


@pytest.fixture(autouse=True)
def clean_global_worker():
    asyncio.run(prewarm.stop_price_comparison_prewarm())
    yield
    asyncio.run(prewarm.stop_price_comparison_prewarm())


def test_worker_coalesces_pending_work_for_the_same_scope() -> None:
    worker = prewarm.OverviewPrewarmer()
    running = Event()
    release = Event()
    latest_done = Event()
    called: list[str] = []

    def active() -> None:
        running.set()
        assert release.wait(2)

    def stale() -> None:
        called.append("stale")

    def latest() -> None:
        called.append("latest")
        latest_done.set()

    worker.submit(("active",), active)
    assert running.wait(2)
    worker.submit(("same-scope",), stale)
    worker.submit(("same-scope",), latest)
    release.set()

    assert latest_done.wait(2)
    worker.close()
    assert called == ["latest"]


def test_worker_recovers_after_a_failed_preparation_without_logging_details(caplog) -> None:
    worker = prewarm.OverviewPrewarmer()
    recovered = Event()
    caplog.set_level(logging.WARNING, logger="app.services.price_comparison_prewarm")

    def fail() -> None:
        raise RuntimeError("private-offer-name.pdf")

    worker.submit(("first",), fail)
    worker.submit(("second",), recovered.set)

    assert recovered.wait(2)
    worker.close()
    assert "Price overview background preparation failed" in caplog.text
    assert "private-offer-name.pdf" not in caplog.text


class _FakeWorker:
    def __init__(self) -> None:
        self.submissions: list[tuple[tuple[str, ...], object]] = []
        self.closed = False

    def submit(self, key, callback) -> None:
        self.submissions.append((key, callback))

    def close(self) -> None:
        self.closed = True


def _install_graph_fakes(monkeypatch):
    instances = []

    class FakeGraphPriceStorage:
        def __init__(self, config, project_storage, *, configured=True) -> None:
            self.config = config
            self.project_storage = project_storage
            self.configured = configured
            instances.append(self)

    class FakePriceComparisonService:
        calls = []

        def __init__(self, store, *, cache_dir) -> None:
            self.store = store
            self.cache_dir = cache_dir

        def prewarm_overview(self) -> None:
            self.calls.append((self.store, self.cache_dir))

    @contextmanager
    def unlocked(_cache_dir):
        yield

    monkeypatch.setattr(storage_module, "GraphPriceStorage", FakeGraphPriceStorage)
    monkeypatch.setattr(service_module, "PriceComparisonService", FakePriceComparisonService)
    monkeypatch.setattr(performance_cache, "store_cache_scope", lambda *_args: ("scope",))
    monkeypatch.setattr(prewarm, "OverviewPrewarmer", _FakeWorker)
    monkeypatch.setattr(prewarm, "_worker_lock", unlocked)
    return FakeGraphPriceStorage, FakePriceComparisonService, instances


def test_schedule_is_graph_only_and_requires_configuration(monkeypatch, tmp_path) -> None:
    FakeGraphPriceStorage, _FakeService, _instances = _install_graph_fakes(monkeypatch)

    prewarm.schedule_overview_prewarm(object(), tmp_path)
    assert prewarm._worker is None

    disabled = FakeGraphPriceStorage(object(), object(), configured=False)
    prewarm.schedule_overview_prewarm(disabled, tmp_path)
    assert prewarm._worker is None


def test_schedule_uses_a_fresh_graph_store_with_shared_http_runtime(monkeypatch, tmp_path) -> None:
    FakeGraphPriceStorage, FakeService, instances = _install_graph_fakes(monkeypatch)
    config = object()
    project_storage = object()
    original = FakeGraphPriceStorage(config, project_storage)

    prewarm.schedule_overview_prewarm(original, tmp_path)

    worker = prewarm._worker
    assert isinstance(worker, _FakeWorker)
    assert worker.submissions[0][0] == ("scope",)
    callback = worker.submissions[0][1]
    assert callable(callback)
    callback()

    assert len(instances) == 2
    fresh = instances[1]
    assert fresh is not original
    assert fresh.config is config
    assert fresh.project_storage is project_storage
    assert FakeService.calls == [(fresh, tmp_path)]


def test_shutdown_detaches_and_closes_the_worker() -> None:
    worker = _FakeWorker()
    prewarm._worker = worker

    asyncio.run(prewarm.stop_price_comparison_prewarm())

    assert worker.closed is True
    assert prewarm._worker is None


def test_worker_shutdown_discards_pending_work_and_waits_for_active_callback() -> None:
    worker = prewarm.OverviewPrewarmer()
    active = Event()
    release = Event()
    pending_ran = Event()
    close_done = Event()

    def current() -> None:
        active.set()
        assert release.wait(2)

    worker.submit(("current",), current)
    assert active.wait(2)
    worker.submit(("pending",), pending_ran.set)

    def close() -> None:
        worker.close()
        close_done.set()

    closer = Thread(target=close)
    closer.start()
    with worker._condition:
        assert worker._condition.wait_for(lambda: worker._closed, timeout=2)
    assert close_done.is_set() is False
    release.set()
    assert close_done.wait(2)
    closer.join()
    assert pending_ran.is_set() is False


def test_application_startup_and_shutdown_order(monkeypatch) -> None:
    from app import main

    calls: list[str] = []

    monkeypatch.setattr(main.settings, "admin_username", None)
    monkeypatch.setattr(main.settings, "admin_password", None)
    monkeypatch.setattr(
        main,
        "ensure_price_comparison_cache_dir",
        lambda path: calls.append(f"cache:{path}"),
    )
    monkeypatch.setattr(main, "ensure_site_status_enum_values", lambda: calls.append("site"))
    monkeypatch.setattr(main, "start_ctrack_sync_scheduler", lambda: calls.append("ctrack-start"))
    monkeypatch.setattr(main, "start_push_plan_scheduler", lambda: calls.append("push-start"))
    monkeypatch.setattr(
        main,
        "start_price_comparison_upload_worker",
        lambda: calls.append("upload-start"),
    )
    monkeypatch.setattr(
        main,
        "start_price_comparison_prewarm",
        lambda: calls.append("prewarm-start"),
    )

    async def stopped(name: str) -> None:
        calls.append(name)

    monkeypatch.setattr(
        main,
        "stop_price_comparison_upload_worker",
        lambda: stopped("upload-stop"),
    )
    monkeypatch.setattr(
        main,
        "stop_price_comparison_prewarm",
        lambda: stopped("prewarm-stop"),
    )
    monkeypatch.setattr(main, "stop_ctrack_sync_scheduler", lambda: stopped("ctrack-stop"))
    monkeypatch.setattr(main, "stop_push_plan_scheduler", lambda: stopped("push-stop"))
    monkeypatch.setattr(main, "close_read_snapshot_cache", lambda: calls.append("snapshot-close"))
    monkeypatch.setattr(
        main,
        "close_material_order_graph_runtime",
        lambda: calls.append("graph-close"),
    )

    application = main.create_app()
    asyncio.run(application.router.on_startup[0]())
    asyncio.run(application.router.on_shutdown[0]())

    assert calls == [
        f"cache:{main.settings.price_comparison_cache_dir}",
        "site",
        "ctrack-start",
        "push-start",
        "upload-start",
        "prewarm-start",
        "upload-stop",
        "prewarm-stop",
        "ctrack-stop",
        "push-stop",
        "snapshot-close",
        "graph-close",
    ]


def test_application_startup_continues_when_cache_directory_is_unavailable(
    monkeypatch,
    caplog,
) -> None:
    from app import main

    calls: list[str] = []

    monkeypatch.setattr(main.settings, "admin_username", None)
    monkeypatch.setattr(main.settings, "admin_password", None)

    def unavailable(_path) -> None:
        raise OSError("/home/private-customer-cache: permission denied")

    monkeypatch.setattr(main, "ensure_price_comparison_cache_dir", unavailable)
    monkeypatch.setattr(main, "ensure_site_status_enum_values", lambda: calls.append("site"))
    monkeypatch.setattr(main, "start_ctrack_sync_scheduler", lambda: calls.append("ctrack"))
    monkeypatch.setattr(main, "start_push_plan_scheduler", lambda: calls.append("push"))
    monkeypatch.setattr(
        main,
        "start_price_comparison_upload_worker",
        lambda: calls.append("upload"),
    )
    monkeypatch.setattr(
        main,
        "start_price_comparison_prewarm",
        lambda: calls.append("prewarm"),
    )
    caplog.set_level(logging.WARNING, logger="app.main")

    application = main.create_app()
    asyncio.run(application.router.on_startup[0]())

    assert calls == ["site", "ctrack", "push", "upload", "prewarm"]
    startup_log = "\n".join(
        record.getMessage() for record in caplog.records if record.name == "app.main"
    )
    assert startup_log == (
        "Price comparison cache directory could not be prepared; startup continues"
    )
    assert "private-customer-cache" not in startup_log
    assert "permission denied" not in startup_log
