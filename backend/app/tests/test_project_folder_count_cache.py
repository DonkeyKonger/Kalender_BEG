import asyncio
from types import SimpleNamespace

import pytest
from fastapi import BackgroundTasks
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.models.project_folder_count import ProjectFolderCount
from app.services import project_folder_count_cache as cache


@pytest.fixture
def setup_cache(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    ProjectFolderCount.__table__.create(engine)
    factory = sessionmaker(bind=engine)
    monkeypatch.setattr(cache, "SessionLocal", factory)
    clock = [1000.0]
    monkeypatch.setattr(cache, "time", lambda: clock[0])
    result = [25]
    calls = []

    class Storage:
        def count_folder_files(self, **kwargs):
            calls.append(kwargs)
            if isinstance(result[0], Exception):
                raise result[0]
            return result[0]

    monkeypatch.setattr(cache, "ProjectStorageService", Storage)
    yield factory, clock, result, calls
    engine.dispose()


def folder(root="root"):
    return SimpleNamespace(folder_key="fotos", external_drive_id="drive", external_item_id=root)


def read(factory, root="root"):
    tasks = BackgroundTasks()
    with factory() as db:
        response = cache.read_and_refresh(db, 1, folder(root), tasks)
    return response, tasks


def test_cold_response_is_immediate_and_single_flight_then_durable(setup_cache):
    factory, clock, result, calls = setup_cache
    response, tasks = read(factory)
    assert response == {"file_count": None, "refreshing": True}
    assert calls == []
    assert read(factory)[1].tasks == []
    asyncio.run(tasks())
    assert len(calls) == 1
    assert read(factory)[0] == {"file_count": 25, "refreshing": False}
    with factory() as db:
        assert cache.cached_counts(db, 1, [folder()]) == {cache.cache_key(1, folder()): 25}
    assert read(factory, "new-binding")[0]["file_count"] is None


def test_stale_values_survive_failures_and_retry_without_zero(setup_cache):
    factory, clock, result, calls = setup_cache
    asyncio.run(read(factory)[1]())
    clock[0] += 301
    response, tasks = read(factory)
    assert response == {"file_count": 25, "refreshing": True}
    result[0] = RuntimeError("SharePoint unavailable")
    asyncio.run(tasks())
    assert read(factory)[0] == {"file_count": 25, "refreshing": False}
    assert read(factory)[1].tasks == []
    clock[0] += 61
    result[0] = 0
    asyncio.run(read(factory)[1]())
    assert read(factory)[0]["file_count"] == 0


def test_upload_invalidation_fences_older_refresh_and_preserves_other_sites(setup_cache):
    factory, clock, result, calls = setup_cache
    asyncio.run(read(factory)[1]())
    clock[0] += 301
    _, old_task = read(factory)
    with factory() as db:
        db.add(ProjectFolderCount(key="other", site_id=2, file_count=7, retry_after=9999))
        cache.invalidate_site_counts(db, 1)
        db.commit()
    result[0] = 123
    asyncio.run(old_task())
    response, new_task = read(factory)
    assert response["file_count"] == 25
    result[0] = 26
    asyncio.run(new_task())
    assert read(factory)[0]["file_count"] == 26
    with factory() as db:
        assert db.get(ProjectFolderCount, "other").retry_after == 9999


def test_abandoned_lease_can_be_reclaimed_and_late_task_cannot_overwrite(setup_cache):
    factory, clock, result, calls = setup_cache
    _, abandoned = read(factory)
    clock[0] += cache.LEASE_SECONDS + 1
    _, current = read(factory)
    asyncio.run(current())
    result[0] = 999
    asyncio.run(abandoned())
    assert read(factory)[0]["file_count"] == 25


def test_cache_lookup_only_includes_requested_site_and_binding(setup_cache):
    factory, clock, result, calls = setup_cache
    asyncio.run(read(factory)[1]())
    with factory() as db:
        assert cache.cached_counts(db, 2, [folder()]) == {}
        assert cache.cached_counts(db, 1, [folder("other")]) == {}
        assert cache.cached_counts(db, 1, []) == {}
    missing = folder()
    missing.external_drive_id = None
    with factory() as db:
        tasks = BackgroundTasks()
        assert cache.read_and_refresh(db, 1, missing, tasks) == {"file_count": None, "refreshing": False}
        assert tasks.tasks == []


def test_migration_preserves_existing_data_and_can_be_reversed(monkeypatch):
    import importlib.util
    from pathlib import Path
    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    from sqlalchemy import inspect, text

    path = Path(__file__).parents[2] / "alembic/versions/20260924_0120_project_folder_counts.py"
    spec = importlib.util.spec_from_file_location("count_cache_migration", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE existing_data (value INTEGER)"))
        connection.execute(text("INSERT INTO existing_data VALUES (42)"))
        monkeypatch.setattr(migration, "op", Operations(MigrationContext.configure(connection)))
        migration.upgrade()
        assert "project_folder_counts" in inspect(connection).get_table_names()
        migration.downgrade()
        assert connection.scalar(text("SELECT value FROM existing_data")) == 42
        assert "project_folder_counts" not in inspect(connection).get_table_names()
    engine.dispose()
