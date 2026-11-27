from contextlib import contextmanager

import pytest
from fastapi import HTTPException

from app.services import price_comparison_service as module
from app.services.price_comparison_performance_cache import price_comparison_cache
from app.services.price_comparison_service import PriceComparisonService
from app.services.price_comparison_storage import save_state, snapshot
from app.tests.test_price_comparison_routes import context as route_context, offer_pdf, seed

context = route_context


@pytest.fixture(autouse=True)
def clear_memory():
    price_comparison_cache.clear()
    yield
    price_comparison_cache.clear()


def test_new_worker_reads_overview_without_loading_dataframes(context, monkeypatch):
    client, service, _ = context
    seed(client)
    first = service.offers()
    assert first["total"] == 1
    assert list((service.cache_dir / "offer-overviews-v1").glob("*.json"))
    price_comparison_cache.clear()
    other = PriceComparisonService(service.store, cache_dir=service.cache_dir)
    monkeypatch.setattr(other, "_load_read_snapshot", lambda *_: pytest.fail("unexpected dataframe rebuild"))
    assert other.offers() == first
    # Defensive copies protect both the memory and disk result.
    changed = other.offers()
    changed["offers"][0]["project"] = "modified"
    changed["warnings"].append("modified")
    assert other.offers() == first


def test_disk_hit_still_requires_successful_current_snapshot(context, monkeypatch):
    client, service, _ = context
    seed(client)
    service.offers()
    price_comparison_cache.clear()
    def unavailable():
        raise HTTPException(503, "source unavailable")
    monkeypatch.setattr(service, "_read_snapshot", unavailable)
    with pytest.raises(HTTPException) as error:
        service.offers()
    assert error.value.status_code == 503


def test_overview_rebuilds_for_day_algorithm_and_source_revision(context, monkeypatch):
    client, service, _ = context
    seed(client)
    day = "2026-11-26"
    monkeypatch.setattr(service, "_metrics_day", lambda: day)
    calls = []
    original = service._offers_list_uncached
    def calculate(*args, **kwargs):
        calls.append(kwargs["as_of"])
        return original(*args, **kwargs)
    monkeypatch.setattr(service, "_offers_list_uncached", calculate)
    initial = service.offers()
    service.offers()
    assert len(calls) == 1
    day = "2026-11-27"
    service.offers()
    assert calls == ["2026-11-26", "2026-11-27"]
    monkeypatch.setattr(module.metrics, "METRICS_VERSION", "changed")
    service.offers()
    assert len(calls) == 3
    current = snapshot(service.store)
    current.state["offer_types"]["Angebot.pdf"] = "Folgeangebot"
    save_state(service.store, current)
    updated = service.offers()
    assert len(calls) == 4
    assert updated["revision"] != initial["revision"]
    assert updated["offers"][0]["offer_type"] == "Folgeangebot"
    service.store.write("offers", "Extra.pdf", offer_pdf(number="EXTRA"), None)
    assert service.offers()["total"] == 2
    assert len(calls) == 5


def test_mutation_data_cannot_reuse_or_poison_shared_overview(context):
    client, service, _ = context
    seed(client)
    before = service.offers()
    current = snapshot(service.store)
    current.state["offer_types"]["Angebot.pdf"] = "Verhandeltes Angebot"
    # Unsaved mutable state deliberately retains the old revision identifier.
    private = service.load(current)
    assert private.cacheable is False
    assert service.offers_list(private)[0]["offer_type"] == "Verhandeltes Angebot"
    assert service.offers() == before


def test_failed_overview_calculation_is_not_persisted(context, monkeypatch):
    client, service, _ = context
    seed(client)
    original = service._offers_list_uncached
    def failed(*args, **kwargs):
        raise RuntimeError("calculation failed")
    monkeypatch.setattr(service, "_offers_list_uncached", failed)
    with pytest.raises(RuntimeError, match="calculation failed"):
        service.offers()
    assert not list((service.cache_dir / "offer-overviews-v1").glob("*.json"))
    monkeypatch.setattr(service, "_offers_list_uncached", original)
    assert service.offers()["total"] == 1


@pytest.mark.parametrize("failure", [False, True])
def test_mutation_schedules_only_after_releasing_store_lock(context, monkeypatch, failure):
    from app.services import price_comparison_prewarm as prewarm

    _, service, _ = context
    events = []
    @contextmanager
    def lock(_db):
        events.append("locked")
        try:
            yield
        finally:
            events.append("released")
    monkeypatch.setattr(service.store, "lock", lock)
    monkeypatch.setattr(module, "invalidate_read_snapshots", lambda *_: events.append("invalidated"))
    monkeypatch.setattr(prewarm, "schedule_overview_prewarm", lambda *_: events.append("scheduled"))
    def mutate():
        with service._mutation_lock(None):
            events.append("mutated")
            if failure:
                raise RuntimeError("write failed")
    if failure:
        with pytest.raises(RuntimeError, match="write failed"):
            mutate()
    else:
        mutate()
    assert events == ["locked", "invalidated", "mutated", "invalidated", "released", "scheduled"]
