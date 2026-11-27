from concurrent.futures import ProcessPoolExecutor
import json
import multiprocessing
from pathlib import Path

import pytest

from app.services import price_comparison_disk_cache as module
from app.services.price_comparison_disk_cache import PriceOverviewDiskCache


def valid(value):
    return isinstance(value, dict) and isinstance(value.get("count"), int)


def process_read(root):
    root = Path(root)
    def calculate():
        # This append happens only inside the inter-process fill lock.
        with (root / "calculations").open("a") as handle:
            handle.write("called\n")
        return {"count": 17}
    return PriceOverviewDiskCache(root).get_or_compute(("revision",), calculate, validate=valid)


def test_shared_cache_singleflights_processes_and_survives_new_process(tmp_path):
    with ProcessPoolExecutor(4, mp_context=multiprocessing.get_context("spawn")) as executor:
        assert list(executor.map(process_read, [str(tmp_path)] * 8)) == [{"count": 17}] * 8
    assert (tmp_path / "calculations").read_text().splitlines() == ["called"]
    assert process_read(str(tmp_path)) == {"count": 17}
    assert (tmp_path / "calculations").read_text().splitlines() == ["called"]


def test_keys_isolate_revision_day_version_and_source_and_results_are_independent(tmp_path):
    cache = PriceOverviewDiskCache(tmp_path)
    key = ("store-a", "revision-a", "day-a", "algorithm-a")
    calls = []
    def calculate():
        calls.append(1)
        return {"count": len(calls)}
    first = cache.get_or_compute(key, calculate, validate=valid)
    first["count"] = 999
    assert PriceOverviewDiskCache(tmp_path).get_or_compute(key, calculate, validate=valid) == {"count": 1}
    for index in range(len(key)):
        changed = tuple("changed" if i == index else item for i, item in enumerate(key))
        cache.get_or_compute(changed, calculate, validate=valid)
    assert len(calls) == 5


@pytest.mark.parametrize("damage", ["json", "checksum", "key", "format", "schema", "oversized"])
def test_corrupt_or_obsolete_cache_recalculates(tmp_path, monkeypatch, damage):
    cache = PriceOverviewDiskCache(tmp_path)
    key = ("test",)
    cache.get_or_compute(key, lambda: {"count": 1}, validate=valid)
    path = next(cache.directory.glob("*.json"))
    envelope = json.loads(path.read_text())
    if damage == "json":
        path.write_text("not-json")
    elif damage == "oversized":
        monkeypatch.setattr(module, "MAX_ENTRY_BYTES", 10)
    else:
        if damage == "checksum":
            envelope["value"]["count"] = 999
        elif damage == "schema":
            envelope["value"] = []
        else:
            envelope[damage] = "wrong"
        path.write_text(json.dumps(envelope))
    assert cache.get_or_compute(key, lambda: {"count": 2}, validate=valid) == {"count": 2}


def test_cache_io_failure_does_not_hide_results_or_retry_factory_errors(tmp_path, monkeypatch):
    cache = PriceOverviewDiskCache(tmp_path)
    def fail(*args):
        raise OSError("disk full")
    monkeypatch.setattr(cache, "_write", fail)
    assert cache.get_or_compute(("a",), lambda: {"count": 1}, validate=valid) == {"count": 1}
    calls = []
    def broken_factory():
        calls.append(1)
        raise OSError("source unavailable")
    with pytest.raises(OSError, match="source unavailable"):
        cache.get_or_compute(("b",), broken_factory, validate=valid)
    assert calls == [1]
    # A non-directory cache root must also fall back to the source calculation.
    blocked = tmp_path / "blocked"
    blocked.write_text("keep")
    assert PriceOverviewDiskCache(blocked).get_or_compute(("c",), lambda: {"count": 3}, validate=valid) == {"count": 3}
    assert blocked.read_text() == "keep"


def test_pruning_is_bounded_and_never_touches_source_files_or_symlink_targets(tmp_path, monkeypatch):
    monkeypatch.setattr(module, "MAX_CACHE_ENTRIES", 2)
    cache = PriceOverviewDiskCache(tmp_path)
    cache.directory.mkdir()
    source = cache.directory / "customer.json"
    source.write_text("preserve")
    link = cache.directory / ("f" * 64 + ".json")
    link.symlink_to(source)
    for i in range(5):
        cache.get_or_compute((str(i),), lambda: {"count": i}, validate=valid)
    derived = [p for p in cache.directory.glob("*.json") if len(p.stem) == 64 and not p.is_symlink()]
    assert len(derived) == 2
    assert source.read_text() == "preserve"
    assert link.is_symlink()


def test_symlink_cache_directory_is_not_read_or_written(tmp_path):
    other = tmp_path / "other"
    cache = PriceOverviewDiskCache(other)
    cache.get_or_compute(("x",), lambda: {"count": 999}, validate=valid)
    linked = PriceOverviewDiskCache(tmp_path)
    linked.directory.symlink_to(cache.directory, target_is_directory=True)
    assert linked.get_or_compute(("x",), lambda: {"count": 1}, validate=valid) == {"count": 1}
    assert cache.get_or_compute(("x",), lambda: pytest.fail("unexpected miss"), validate=valid) == {"count": 999}


def test_pruning_also_enforces_total_byte_limit(tmp_path, monkeypatch):
    monkeypatch.setattr(module, "MAX_CACHE_BYTES", 650)
    cache = PriceOverviewDiskCache(tmp_path)
    for index in range(5):
        cache.get_or_compute((str(index),), lambda: {"count": index, "extra": "x" * 100}, validate=valid)
    entries = list(cache.directory.glob("*.json"))
    assert sum(path.stat().st_size for path in entries) <= 650
    assert cache.get_or_compute(("4",), lambda: pytest.fail("current entry evicted"), validate=valid)["count"] == 4
