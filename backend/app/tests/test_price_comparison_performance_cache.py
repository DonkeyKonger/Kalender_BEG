from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from pathlib import Path
from threading import Barrier, Lock
from time import sleep
from types import SimpleNamespace

import pandas as pd
import pytest

from app.services import price_comparison_service as service_module
from app.services.price_comparison_performance_cache import (
    RevisionBoundCache,
    price_comparison_cache,
    store_cache_scope,
)
from app.services.price_comparison_service import (
    OfferSource,
    PriceComparisonService,
    PriceData,
)
from app.services.price_comparison_storage import Snapshot, StoredFile


class DummyStore:
    mode = "onedrive"
    configured = True

    def __init__(
        self,
        *,
        identity: str = "drive:root",
        base_url: str = "https://graph.microsoft.com/v1.0",
        tenant_id: str = "tenant-a",
        client_id: str = "client-a",
    ) -> None:
        self.identity = identity
        self.config = SimpleNamespace(
            ms_graph_base_url=base_url,
            ms_tenant_id=tenant_id,
            ms_client_id=client_id,
        )


@pytest.fixture(autouse=True)
def clear_process_cache():
    price_comparison_cache.clear()
    yield
    price_comparison_cache.clear()


def make_snapshot(revision: str, marker: str = "original") -> Snapshot:
    return Snapshot([], {"marker": marker}, None, revision, [])


def fake_price_data(
    snap: Snapshot,
    *,
    cacheable: bool,
    raw_prices: pd.DataFrame | None = None,
    prices: pd.DataFrame | None = None,
    datanorm: pd.DataFrame | None = None,
    offer_sources: list[OfferSource] | None = None,
) -> PriceData:
    return PriceData(
        snap=snap,
        datanorm=pd.DataFrame() if datanorm is None else datanorm,
        raw_prices=pd.DataFrame() if raw_prices is None else raw_prices,
        prices=pd.DataFrame() if prices is None else prices,
        warnings=[str(snap.state.get("marker", ""))],
        offer_sources=[] if offer_sources is None else offer_sources,
        unavailable_sources=[],
        cacheable=cacheable,
    )


def test_revision_cache_singleflights_concurrent_callers():
    cache = RevisionBoundCache(max_entries=8, max_bytes=1024)
    workers = 8
    barrier = Barrier(workers)
    counter = 0
    counter_lock = Lock()

    def factory():
        nonlocal counter
        with counter_lock:
            counter += 1
        sleep(0.05)
        return {"frame": 42}

    def read():
        barrier.wait()
        return cache.get_or_compute("same-revision", factory, estimate=lambda _: 1)

    with ThreadPoolExecutor(max_workers=workers) as executor:
        values = list(executor.map(lambda _: read(), range(workers)))

    assert counter == 1
    assert all(value is values[0] for value in values)
    assert cache.info().inflight == 0
    assert cache.info().entries == 1


def test_revision_cache_propagates_failed_flight_and_allows_retry():
    cache = RevisionBoundCache(max_entries=8, max_bytes=1024)
    workers = 6
    barrier = Barrier(workers)
    counter = 0
    counter_lock = Lock()

    class ExpectedError(RuntimeError):
        pass

    def factory():
        nonlocal counter
        with counter_lock:
            counter += 1
        sleep(0.05)
        raise ExpectedError("failed once")

    def read():
        barrier.wait()
        with pytest.raises(ExpectedError, match="failed once"):
            cache.get_or_compute("same-revision", factory)

    with ThreadPoolExecutor(max_workers=workers) as executor:
        list(executor.map(lambda _: read(), range(workers)))

    assert counter == 1
    assert cache.info().entries == 0
    assert cache.info().inflight == 0
    assert cache.get_or_compute("same-revision", lambda: "recovered") == "recovered"


def test_revision_cache_is_bounded_by_lru_bytes_and_oversized_values():
    cache = RevisionBoundCache(max_entries=8, max_bytes=5)
    calls: Counter[str] = Counter()

    def read(key: str, retained: int):
        return cache.get_or_compute(
            key,
            lambda: (calls.update([key]), key)[1],
            estimate=lambda _: retained,
        )

    assert read("a", 3) == "a"
    assert read("b", 3) == "b"
    assert cache.info().bytes == 3
    assert read("b", 3) == "b"
    assert read("a", 3) == "a"
    assert calls == Counter({"a": 2, "b": 1})

    assert read("oversized", 6) == "oversized"
    assert read("oversized", 6) == "oversized"
    assert calls["oversized"] == 2
    assert cache.info().bytes <= 5


@pytest.mark.parametrize(
    ("field", "replacement"),
    [
        ("identity", "other-drive:root"),
        ("base_url", "https://graph.example.test/v1.0"),
        ("tenant_id", "tenant-b"),
        ("client_id", "client-b"),
    ],
)
def test_store_cache_scope_separates_graph_configuration_and_identity(
    tmp_path: Path,
    field: str,
    replacement: str,
):
    original = {
        "identity": "drive:root",
        "base_url": "https://graph.microsoft.com/v1.0",
        "tenant_id": "tenant-a",
        "client_id": "client-a",
    }
    changed = deepcopy(original)
    changed[field] = replacement

    assert store_cache_scope(DummyStore(**original), tmp_path / "cache") != store_cache_scope(
        DummyStore(**changed),
        tmp_path / "cache",
    )
    assert store_cache_scope(DummyStore(**original), tmp_path / "cache") != store_cache_scope(
        DummyStore(**original),
        tmp_path / "other-cache",
    )


def test_service_reuses_price_data_across_instances_and_recomputes_new_revision(
    monkeypatch,
    tmp_path: Path,
):
    snapshots = iter(
        [
            make_snapshot("revision-a"),
            make_snapshot("revision-a"),
            make_snapshot("revision-b"),
        ]
    )
    calls = 0
    monkeypatch.setattr(service_module, "snapshot", lambda _store: next(snapshots))

    def load_snapshot(self, snap, *, force, cacheable):
        nonlocal calls
        calls += 1
        assert force is False
        return fake_price_data(snap, cacheable=cacheable)

    monkeypatch.setattr(PriceComparisonService, "_load_snapshot", load_snapshot)
    first = PriceComparisonService(DummyStore(), cache_dir=tmp_path).load()
    second = PriceComparisonService(DummyStore(), cache_dir=tmp_path).load()
    third = PriceComparisonService(DummyStore(), cache_dir=tmp_path).load()

    assert first is not second
    assert first.snap.revision == second.snap.revision == "revision-a"
    assert third.snap.revision == "revision-b"
    assert first.cacheable is second.cacheable is third.cacheable is True
    assert calls == 2


def test_cached_price_data_is_defensively_copied(monkeypatch, tmp_path: Path):
    snapshots = iter([make_snapshot("revision-a"), make_snapshot("revision-a")])
    monkeypatch.setattr(service_module, "snapshot", lambda _store: next(snapshots))

    def load_snapshot(self, snap, *, force, cacheable):
        return fake_price_data(
            snap,
            cacheable=cacheable,
            raw_prices=pd.DataFrame([{"Quelle": "Offer.pdf", "Preis": 12.5}]),
        )

    monkeypatch.setattr(PriceComparisonService, "_load_snapshot", load_snapshot)
    service = PriceComparisonService(DummyStore(), cache_dir=tmp_path)
    first = service.load()
    first.snap.state["marker"] = "poisoned"
    first.raw_prices.loc[0, "Preis"] = 999.0

    second = service.load()
    assert second.snap.state["marker"] == "original"
    assert second.raw_prices.loc[0, "Preis"] == pytest.approx(12.5)


def test_explicit_snapshot_and_force_bypass_without_replacing_warm_value(
    monkeypatch,
    tmp_path: Path,
):
    original = make_snapshot("same-revision", "original")
    changed = make_snapshot("same-revision", "changed-in-memory")
    snapshots = iter([original, changed, changed])
    calls: list[tuple[str, bool, bool]] = []
    monkeypatch.setattr(service_module, "snapshot", lambda _store: next(snapshots))

    def load_snapshot(self, snap, *, force, cacheable):
        calls.append((snap.state["marker"], force, cacheable))
        return fake_price_data(snap, cacheable=cacheable)

    monkeypatch.setattr(PriceComparisonService, "_load_snapshot", load_snapshot)
    service = PriceComparisonService(DummyStore(), cache_dir=tmp_path)

    warm = service.load()
    explicit = service.load(changed)
    forced = service.load(force=True)
    warm_again = service.load()

    assert warm_again.warnings == warm.warnings == ["original"]
    assert explicit.warnings == forced.warnings == ["changed-in-memory"]
    assert explicit.cacheable is forced.cacheable is False
    assert calls == [
        ("original", False, True),
        ("changed-in-memory", False, False),
        ("changed-in-memory", True, False),
    ]


def test_daily_derived_cache_rolls_at_day_boundary_and_bypasses_mutation_data(
    monkeypatch,
    tmp_path: Path,
):
    service = PriceComparisonService(DummyStore(), cache_dir=tmp_path)
    data = fake_price_data(make_snapshot("revision-a"), cacheable=True)
    day = "2026-11-23T00:00:00"
    monkeypatch.setattr(service_module, "calendar_day_key", lambda: day)
    calls = 0

    def factory():
        nonlocal calls
        calls += 1
        return {"count": calls}

    first = service._derived(data, "rolling", factory, daily=True)
    first["count"] = 999
    assert service._derived(data, "rolling", factory, daily=True) == {"count": 1}
    day = "2026-11-24T00:00:00"
    assert service._derived(data, "rolling", factory, daily=True) == {"count": 2}

    mutation_data = fake_price_data(data.snap, cacheable=False)
    assert service._derived(mutation_data, "rolling", factory, daily=True) == {"count": 3}
    assert service._derived(mutation_data, "rolling", factory, daily=True) == {"count": 4}


def test_cached_offer_meta_and_article_statistics_are_defensively_copied(
    monkeypatch,
    tmp_path: Path,
):
    state = {
        "marker": "response-copy",
        "frozen_metrics": {
            "Offer.pdf": {"PV_avg_pct_pos": 1.0, "PV_avg_pct_wert": 2.0}
        },
        "online_import": None,
        "offer_types": {},
        "discounts": {},
        "align_netto": {},
    }
    snap = Snapshot([], state, None, "revision-response", [])
    raw = pd.DataFrame(
        [
            {
                "Quelle": "Offer.pdf",
                "Artikelnummer": "100",
                "Projekt": "Project",
                "Angebot": "A-1",
                "Datum": pd.Timestamp("2026-11-01"),
                "Gesamt (netto)": 25.0,
            }
        ]
    )
    datanorm = pd.DataFrame(
        [{"Artikelnummer": "100", "Bezeichnung": "Article", "Nettopreis": 10.0}]
    )
    data = fake_price_data(
        snap,
        cacheable=True,
        raw_prices=raw,
        prices=raw.assign(Preis=10.0),
        datanorm=datanorm,
        offer_sources=[
            OfferSource(
                "Offer.pdf",
                StoredFile(
                    "offers",
                    "Offer.pdf",
                    1,
                    "2026-11-01T00:00:00Z",
                    "version-a",
                ),
                True,
                False,
            )
        ],
    )
    service = PriceComparisonService(DummyStore(), cache_dir=tmp_path)
    monkeypatch.setattr(service, "load", lambda: data)

    first_offers = service.offers()
    first_offers["offers"][0]["project"] = "poisoned"
    assert service.offers()["offers"][0]["project"] == "Project"

    monkeypatch.setattr(
        service_module.core,
        "suggestions",
        lambda *_args: (pd.DataFrame([{"Artikelnummer": "100"}]), {"nested": {"ok": True}}),
    )
    first_suggestions = service.suggestions([])
    first_suggestions["meta"]["nested"]["ok"] = False
    assert service.suggestions([])["meta"]["nested"]["ok"] is True

    history = raw.assign(Preis=10.0)
    monkeypatch.setattr(service_module.core, "article_history", lambda *_args: history.copy())
    monkeypatch.setattr(
        service_module.core,
        "article_statistics",
        lambda *_args: {"nested": {"ok": True}},
    )
    first_article = service.article("100")
    first_article["statistics"]["nested"]["ok"] = False
    assert service.article("100")["statistics"]["nested"]["ok"] is True

