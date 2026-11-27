"""Calendar orchestration around the original priceviewer calculation functions."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from contextvars import copy_context
from copy import deepcopy
from dataclasses import dataclass
from datetime import UTC, datetime
from zoneinfo import ZoneInfo
import fcntl
import hashlib
import json
import logging
import math
import os
from pathlib import Path
import pickle
import re
import tempfile

from fastapi import HTTPException
import pandas as pd

from app.core.config import settings
from app.services import price_comparison_core as core
from app.services import price_comparison_metrics as metrics
from app.services.price_comparison_online_import import (
    OnlineImportFrames,
    load_online_import,
)
from app.services.price_comparison_disk_cache import PriceOverviewDiskCache
from app.services.price_comparison_timing import price_timing, record_cache_hit, record_cache_miss
from app.services.price_comparison_performance_cache import (
    calendar_day_key,
    price_comparison_cache,
    store_cache_scope,
)
from app.services.price_comparison_search import (
    build_article_search_index, search_article_index, unicode_casefold_items,
)
from app.services.price_comparison_snapshot_cache import read_snapshot, invalidate_read_snapshots
from app.services.price_comparison_storage import (
    GraphPriceStorage,
    MAX_FILE_BYTES,
    Snapshot,
    StoredFile,
    require_revision,
    safe_name,
    save_state,
    snapshot,
)

SOURCE_VERSION = "4ed988f"
OFFER_TYPES = ("Erstangebot", "Folgeangebot", "Verhandeltes Angebot")
CACHE_VERSION = "4ed988f-validated-pdf-v4"
MAX_PARSE_WORKERS = 4
OVERVIEW_VERSION = "offers-overview-v1"
ARTICLE_INDEX_VERSION = "datanorm-search-v1"
logger = logging.getLogger(__name__)


class RollbackRecoveryError(RuntimeError):
    """A source restore succeeded, but shared state needs manual recovery."""


@contextmanager
def _cache_fill_lock(path: Path):
    """Serialize one derived cache fill across threads and worker processes."""

    lock_path = path.with_suffix(".lock")
    if lock_path.is_symlink():
        raise HTTPException(500, "Ungültiger interner Preisdatei-Cache.")
    with lock_path.open("a+b") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def records(frame: pd.DataFrame) -> list[dict]:
    return json.loads(frame.to_json(orient="records", date_format="iso", double_precision=15))


def json_value(value):
    return json.loads(json.dumps(value, default=str, allow_nan=False))


def filter_frame(frame, search="", cluster=""):
    result = frame.copy()
    if search.strip() and not result.empty:
        needle = search.strip().casefold()
        mask = (
            result.astype(str)
            .apply(lambda col: col.str.casefold().str.contains(needle, regex=False))
            .any(axis=1)
        )
        result = result[mask]
    if cluster and cluster != "Alle Cluster" and "Artikelcluster" in result.columns:
        result = result[result["Artikelcluster"] == cluster]
    return result


def table(frame, snap, *, search="", cluster="", offset=0, limit=100, **extra):
    filtered = filter_frame(frame, search, cluster)
    return {
        "columns": [str(c) for c in filtered.columns],
        "rows": records(filtered.iloc[offset : offset + limit]),
        "total": len(filtered),
        "revision": snap.revision,
        **extra,
    }


def references_to_core(rows):
    return core.normalize_reference_rows(
        [
            {
                "Artikelnummer": row.get("article_number", row.get("Artikelnummer", "")),
                "Gewichtung": row.get("weight", row.get("Gewichtung", 1)),
            }
            for row in rows
        ]
    )


def references_to_api(rows):
    return [
        {"article_number": row["Artikelnummer"], "weight": row["Gewichtung"]}
        for row in core.normalize_reference_rows(rows)
    ]


@dataclass
class OfferSource:
    name: str
    item: StoredFile | None
    original_available: bool
    imported: bool


@dataclass
class PriceData:
    snap: Snapshot
    datanorm: pd.DataFrame
    raw_prices: pd.DataFrame
    prices: pd.DataFrame
    warnings: list[str]
    offer_sources: list[OfferSource]
    unavailable_sources: list[str]
    cacheable: bool = False


class PriceComparisonService:
    def __init__(self, store, *, cache_dir=None):
        self.store = store
        self.cache_dir = Path(cache_dir or settings.price_comparison_cache_dir)
        self._cache_scope = store_cache_scope(store, self.cache_dir)

    def _read_snapshot(self):
        with price_timing("snapshot"):
            if isinstance(self.store, GraphPriceStorage):
                return read_snapshot(self.store, self.cache_dir)
            return snapshot(self.store)

    @contextmanager
    def _mutation_lock(self, db):
        try:
            with self.store.lock(db):
                invalidate_read_snapshots(self.store, self.cache_dir)
                try:
                    yield
                finally:
                    invalidate_read_snapshots(self.store, self.cache_dir)
        finally:
            # Preparation runs after the shared write lock is released. It must
            # never extend the mutation or replace its result/exception.
            from app.services.price_comparison_prewarm import schedule_overview_prewarm
            try:
                schedule_overview_prewarm(self.store, self.cache_dir)
            except Exception:
                logger.warning("Price overview preparation could not be scheduled")

    def _derived(
        self,
        data: PriceData,
        operation: str,
        factory,
        *parts,
        daily: bool = False,
    ):
        """Reuse derived values only after this request obtained a fresh revision."""

        if not data.cacheable:
            return factory()
        day = (calendar_day_key(),) if daily else ()
        key = (*self._cache_scope, operation, data.snap.revision, *day, *parts)
        canonical = price_comparison_cache.get_or_compute(key, factory)
        # Cache entries are process-global across request-scoped services.
        # Never expose their mutable frames, mappings or lists to a caller.
        return deepcopy(canonical)

    def import_frames(self, snap: Snapshot) -> OnlineImportFrames | None:
        return load_online_import(self.store, snap, self.cache_dir)

    @staticmethod
    def _binding_matches(item: StoredFile, binding: object) -> bool:
        return (
            isinstance(binding, dict)
            and item.version == binding.get("version")
        )

    def file_included(self, snap: Snapshot, item: StoredFile) -> bool:
        config = snap.state.get("online_import")
        if not config or not config["physical_frames_active"] or item.kind != "offers":
            return True
        binding = config["offer_bindings"].get(item.name)
        return not (
            self._binding_matches(item, binding)
            and binding.get("mode") == "excluded"
        )

    def _offer_sources(
        self,
        snap: Snapshot,
        imported: OnlineImportFrames | None,
    ) -> list[OfferSource]:
        physical = {item.name: item for item in snap.files if item.kind == "offers"}
        config = snap.state.get("online_import")
        if config is None or imported is None:
            return [
                OfferSource(item.name, item, True, False)
                for item in snap.files
                if item.kind == "offers"
            ]

        sources: dict[str, OfferSource] = {}
        live: list[StoredFile] = []
        if config["physical_frames_active"]:
            for item in physical.values():
                binding = config["offer_bindings"].get(item.name)
                if self._binding_matches(item, binding):
                    if binding["mode"] == "excluded":
                        continue
                    if item.name not in imported.authoritative_offer_sources:
                        raise HTTPException(422, "Importierter Online-Preisvergleich ist ungültig.")
                    sources[item.name] = OfferSource(item.name, item, True, True)
                else:
                    live.append(item)
        else:
            live.extend(physical.values())

        for name in config["virtual_sources"]:
            if name not in physical:
                if name not in imported.authoritative_offer_sources:
                    raise HTTPException(422, "Importierter Online-Preisvergleich ist ungültig.")
                sources[name] = OfferSource(name, None, False, True)

        result = [
            OfferSource(item.name, item, True, False)
            for item in sorted(
                live,
                key=lambda candidate: (candidate.modified, candidate.name),
                reverse=True,
            )
        ]
        result.extend(
            sources[name]
            for name in imported.offer_source_order
            if name in sources
        )
        return result

    def status(self):
        if not self.store.configured:
            return {
                "configured": False,
                "mode": self.store.mode,
                "folder_name": "Preisvergleich",
                "source_version": SOURCE_VERSION,
                "offer_count": 0,
                "datanorm_count": 0,
                "active_datanorm": None,
                "revision": "",
            }
        snap = self._read_snapshot()
        physical_names = {item.name for item in snap.files if item.kind == "offers"}
        virtual = set()
        config = snap.state.get("online_import")
        if config is not None:
            virtual = set(config["virtual_sources"]) - physical_names
        return {
            "configured": True,
            "mode": self.store.mode,
            "folder_name": "Preisvergleich",
            "source_version": SOURCE_VERSION,
            "offer_count": sum(
                f.kind == "offers" and self.file_included(snap, f) for f in snap.files
            ) + len(virtual),
            "datanorm_count": sum(f.kind == "datanorm" for f in snap.files),
            "active_datanorm": snap.state["active_datanorm"],
            "revision": snap.revision,
        }

    def _parsed_cache_location(self, item: StoredFile):
        key = hashlib.sha256(
            json.dumps(
                [CACHE_VERSION, self.store.identity, item.kind, item.name, item.version],
                ensure_ascii=False,
            ).encode()
        ).hexdigest()
        self.cache_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        path = self.cache_dir / (key + ".pkl")
        if path.is_symlink():
            raise HTTPException(500, "Ungültiger interner Preisdatei-Cache.")
        return key, path

    def _write_parsed_cache(self, path: Path, frame: pd.DataFrame):
        # Caller owns the per-key fill lock. Only trusted parser output is saved.
        with tempfile.NamedTemporaryFile(
            dir=self.cache_dir, prefix=".parse-", delete=False,
        ) as handle:
            temporary = Path(handle.name)
            try:
                frame.to_pickle(handle)
                handle.flush()
                os.replace(temporary, path)
            finally:
                temporary.unlink(missing_ok=True)

    def _promote_upload_cache(self, item: StoredFile, frame: pd.DataFrame):
        """Bind already validated upload rows to the exact stored file version."""
        _, path = self._parsed_cache_location(item)
        if item.kind == "offers":
            frame = frame.copy()
            frame["Quelle"] = item.name
        with _cache_fill_lock(path):
            self._write_parsed_cache(path, frame)

    def parsed(self, item: StoredFile, *, raw=None, force=False):
        key, path = self._parsed_cache_location(item)

        def cached_frame():
            try:
                # Only this service creates these hashed, local cache files.
                # No uploaded/shared Pickle is ever read.
                cached = pd.read_pickle(path)
            except (ValueError, EOFError, OSError, pickle.PickleError, AttributeError):
                return None
            if not isinstance(cached, pd.DataFrame):
                return None
            if cached.empty:
                # Empty parse results are cached deliberately.  Existing empty
                # PDFs stay a warning without being reparsed on every view;
                # uploads still fail before their source file is written.
                raise HTTPException(
                    422,
                    f"Datei {item.name} enthält keine lesbaren Preispositionen.",
                )
            return cached

        if path.exists() and not force:
            cached = cached_frame()
            if cached is not None:
                record_cache_hit("parsed", "disk")
                return cached

        # Fast reads stay lock-free.  On the first fill the second check keeps
        # simultaneous API requests and worker processes from downloading and
        # parsing the same PDF more than once.
        with _cache_fill_lock(path):
            if path.exists() and not force:
                cached = cached_frame()
                if cached is not None:
                    record_cache_hit("parsed", "disk")
                    return cached

            record_cache_miss("parsed", "disk")
            content = raw if raw is not None else self.store.read(item)
            try:
                with price_timing("parsing"):
                    if item.kind == "offers":
                        frame = core.extract_prices_from_pdf(
                            content,
                            source_name=item.name,
                            cache_sig=key,
                        )
                    else:
                        frame = core.parse_datanorm_bytes(content)
            except Exception as exc:
                raise HTTPException(
                    422,
                    f"Datei {item.name} konnte nicht eingelesen werden.",
                ) from exc
            if not isinstance(frame, pd.DataFrame):
                raise HTTPException(
                    422,
                    f"Datei {item.name} enthält keine lesbaren Preispositionen.",
                )
            self._write_parsed_cache(path, frame)

            if frame.empty:
                raise HTTPException(
                    422,
                    f"Datei {item.name} enthält keine lesbaren Preispositionen.",
                )
        return frame

    def load(self, snap=None, *, force=False) -> PriceData:
        # Explicit snapshots are used by mutations.  Their state can change in
        # memory while their persisted revision remains unchanged, so neither
        # explicit snapshots nor forced parses may read or populate this cache.
        if snap is not None or force:
            current = snap if snap is not None else snapshot(self.store)
            return self._load_snapshot(current, force=force, cacheable=False)

        return self._load_read_snapshot(self._read_snapshot())

    def _load_read_snapshot(self, current: Snapshot):
        """Reuse exactly the already verified revision, without a second Graph read."""
        key = (*self._cache_scope, "price-data", current.revision)
        canonical = price_comparison_cache.get_or_compute(
            key,
            lambda: self._load_snapshot(current, force=False, cacheable=True),
        )
        return deepcopy(canonical)

    def _datanorm_frame(self, snap, imported, *, force=False):
        datanorm = pd.DataFrame()
        if snap.state["active_datanorm"]:
            active = snap.find("datanorm", snap.state["active_datanorm"])
            config = snap.state.get("online_import")
            binding = config.get("datanorm_binding") if config else None
            use_import = bool(
                imported is not None
                and config["datanorm_frame_active"]
                and isinstance(binding, dict)
                and binding.get("name") == active.name
                and binding.get("version") == active.version
                and imported.active_datanorm == active.name
            )
            datanorm = imported.datanorm.copy() if use_import else self.parsed(active, force=force)
        return datanorm

    @staticmethod
    def _validated_raw_prices(raw):
        """Suppress the proven merged-cell parser corruption in legacy frames.

        Imported snapshots remain immutable. Only the calculation copy changes;
        manual corrections are still applied afterwards by prepare_prices.
        """
        if raw.empty or not {"Artikelnummer", "Preis"}.issubset(raw.columns):
            return raw
        result = raw.copy()
        column = "Preis_raw" if "Preis_raw" in result else "Preis"
        values = pd.to_numeric(result[column], errors="coerce")
        articles = result["Artikelnummer"].astype(str).map(core.clean_artnr)
        corrupt = pd.Series([
            bool(article and pd.notna(value) and math.isfinite(value)
                 and value > 1_000_000 and str(int(value)).startswith(article))
            for article, value in zip(articles, values)
        ], index=result.index)
        if corrupt.any():
            for price_column in ("Preis", "Preis_raw"):
                if price_column in result:
                    result.loc[corrupt, price_column] = float("nan")
            if "Preis_validiert" not in result:
                result["Preis_validiert"] = pd.Series(pd.NA, index=result.index, dtype=object)
            result.loc[corrupt, "Preis_validiert"] = False
        return result

    def _load_snapshot(self, snap: Snapshot, *, force: bool, cacheable: bool) -> PriceData:
        imported = self.import_frames(snap)
        datanorm = self._datanorm_frame(snap, imported, force=force)
        frames, warnings = [], []
        offer_sources = self._offer_sources(snap, imported)
        imported_names = {
            source.name for source in offer_sources if source.imported
        }
        if imported_names:
            imported_frame = imported.offers[
                imported.offers["Quelle"].astype(str).isin(imported_names)
            ].copy()
            for source in imported_names:
                deleted = snap.state["deleted_articles"].get(source, [])
                if deleted:
                    imported_frame = imported_frame[
                        ~(
                            imported_frame["Quelle"].astype(str).eq(source)
                            & imported_frame["Artikelnummer"]
                            .astype(str)
                            .map(core.clean_artnr)
                            .isin(deleted)
                        )
                    ]
            frames.append(imported_frame)
        live_sources = [source for source in offer_sources if not source.imported]

        def parse_offer(source):
            try:
                frame = self.parsed(source.item, force=force).copy()
            except HTTPException as exc:
                if exc.status_code != 422:
                    raise
                return None, str(exc.detail)
            deleted = snap.state["deleted_articles"].get(source.name, [])
            if deleted:
                frame = frame[
                    ~frame["Artikelnummer"].astype(str).map(core.clean_artnr).isin(deleted)
                ]
            return frame, None

        if len(live_sources) > 1:
            with ThreadPoolExecutor(
                max_workers=min(MAX_PARSE_WORKERS, len(live_sources)),
                thread_name_prefix="price-parse",
            ) as executor:
                futures = [executor.submit(copy_context().run, parse_offer, source)
                           for source in live_sources]
                parsed_offers = [future.result() for future in futures]
        else:
            parsed_offers = [parse_offer(source) for source in live_sources]

        # Consume futures in snapshot order, matching the former
        # sequential concatenation while allowing bounded first-load parsing.
        for frame, warning in parsed_offers:
            if warning is not None:
                warnings.append(warning)
            elif frame is not None:
                frames.append(
                    frame.sort_values("Datum", ascending=False, kind="stable")
                    if imported_names
                    else frame
                )
        raw = (
            pd.concat(frames, ignore_index=not bool(imported_names))
            if frames
            else pd.DataFrame()
        )
        if not raw.empty and not imported_names:
            # Preserve the original viewer/calendar algorithm, including its
            # default pandas sorting implementation, for non-imported data.
            raw = raw.sort_values("Datum", ascending=False)
        raw = self._validated_raw_prices(raw)
        with price_timing("prepare"):
            prices = core.prepare_prices(
                raw,
                datanorm,
                snap.state["discounts"],
                snap.state["align_netto"],
                snap.state["manual_prices"],
                snap.state["offer_types"],
            )
        unavailable = [source.name for source in offer_sources if not source.original_available]
        return PriceData(
            snap,
            datanorm,
            raw,
            prices,
            warnings,
            offer_sources,
            unavailable,
            cacheable,
        )

    def clusters(self, data):
        if "Artikelcluster" not in data.datanorm.columns:
            return []
        return sorted(data.datanorm["Artikelcluster"].dropna().astype(str).unique().tolist())

    def datanorm(self, **query):
        data = self.load()
        frame = self._derived(
            data,
            "datanorm-comparison",
            lambda: core.datanorm_comparison(
                data.datanorm,
                data.prices,
                data.snap.state["discounts"],
                data.snap.state["align_netto"],
            ),
        )
        return table(
            frame,
            data.snap,
            **query,
            clusters=self.clusters(data),
            active_file=data.snap.state["active_datanorm"],
            warnings=data.warnings,
            unavailable_sources=data.unavailable_sources,
        )

    def suggestions(self, references, **query):
        data = self.load()
        normalized = references_to_core(references)
        reference_key = json.dumps(
            normalized,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
        frame, meta = self._derived(
            data,
            "suggestions",
            lambda: core.suggestions(data.datanorm, data.prices, normalized),
            reference_key,
            daily=True,
        )
        return table(
            frame,
            data.snap,
            **query,
            meta=meta,
            clusters=self.clusters(data),
            warnings=data.warnings,
            unavailable_sources=data.unavailable_sources,
        )

    def _offers_list_uncached(self, data, *, as_of=None):
        raw = data.raw_prices
        if raw.empty:
            return []
        # Frozen legacy percentages used a different formula and cannot be
        # trusted after reference edits or a new calendar day. Reads derive the
        # current result without changing source files or shared state.
        calculated_metrics = self.offer_metrics(data, as_of=as_of)
        result = []
        offer_sources = data.offer_sources
        if data.snap.state.get("online_import") is None:
            offer_sources = sorted(
                offer_sources,
                key=lambda source: (source.item.modified, source.name),
                reverse=True,
            )
        frames_by_source = {
            str(name): frame
            for name, frame in raw.groupby(raw["Quelle"].astype(str), sort=False)
        }
        for source in offer_sources:
            frame = frames_by_source.get(source.name)
            if frame is None or frame.empty:
                continue
            row = frame.iloc[0]
            date = pd.to_datetime(frame["Datum"], errors="coerce").max()
            totals = pd.to_numeric(frame.get("Gesamt (netto)"), errors="coerce")
            net = totals.max() if isinstance(totals, pd.Series) else None
            calculated = calculated_metrics.get(source.name, {})
            uploaded_at = None
            recorded_upload = data.snap.state.get("offer_uploaded_at", {}).get(
                source.name
            )
            if (
                source.item is not None
                and isinstance(recorded_upload, dict)
                and recorded_upload.get("version") == source.item.version
            ):
                uploaded_at = self._normalized_offer_timestamp(
                    recorded_upload.get("uploaded_at")
                )
            if uploaded_at is None and source.item is not None:
                uploaded_at = self._normalized_offer_timestamp(source.item.modified)
            result.append(
                {
                    "source": source.name,
                    "project": str(row.get("Projekt") or "—"),
                    "offer_number": str(row.get("Angebot") or ""),
                    "date": date.date().isoformat() if pd.notna(date) else None,
                    "uploaded_at": uploaded_at,
                    "offer_type": data.snap.state["offer_types"].get(source.name, "Erstangebot"),
                    "discount": data.snap.state["discounts"].get(source.name, 0),
                    "align_netto": bool(data.snap.state["align_netto"].get(source.name, False)),
                    "position_count": int(frame["Artikelnummer"].nunique()),
                    "total_net": float(net) if pd.notna(net) else None,
                    "price_change": calculated.get("PV_avg_pct_wert"),
                    "price_change_positions": calculated.get("PV_avg_pct_pos"),
                    "comparison_quality": calculated.get("comparison_quality"),
                    "original_available": source.original_available,
                }
            )
        return result

    @staticmethod
    def _metrics_day():
        return datetime.now(ZoneInfo("Europe/Berlin")).date().isoformat()

    def offer_metrics(self, data, *, as_of=None):
        day = as_of or self._metrics_day()

        def calculate():
            with price_timing("metrics"):
                return metrics.offer_price_metrics(data.prices, data.datanorm, as_of=day)

        return self._derived(
            data,
            "offer-metrics",
            calculate,
            metrics.METRICS_VERSION,
            day,
        )

    def offers_list(self, data):
        if not data.cacheable:
            return self._offers_list_uncached(data, as_of=self._metrics_day())
        return self._offer_overview(data.snap, data=data)["offers"]

    @staticmethod
    def _valid_overview(value):
        return (
            isinstance(value, dict)
            and set(value) == {"offers", "warnings"}
            and isinstance(value["offers"], list)
            and all(isinstance(row, dict) and isinstance(row.get("source"), str)
                    and isinstance(row.get("project"), str)
                    and isinstance(row.get("position_count"), int)
                    and "comparison_quality" in row for row in value["offers"])
            and isinstance(value["warnings"], list)
            and all(isinstance(warning, str) for warning in value["warnings"])
        )

    def _offer_overview(self, snap: Snapshot, *, data=None):
        day = self._metrics_day()
        key = (*self._cache_scope, OVERVIEW_VERSION, CACHE_VERSION,
               metrics.METRICS_VERSION, snap.revision, day)

        def build():
            current = data if data is not None else self._load_read_snapshot(snap)
            return {"offers": self._offers_list_uncached(current, as_of=day),
                    "warnings": current.warnings}

        with price_timing("overview"):
            canonical = price_comparison_cache.get_or_compute(
                key, lambda: PriceOverviewDiskCache(self.cache_dir).get_or_compute(
                    key, build, validate=self._valid_overview,
                ),
            )
        return deepcopy(canonical)

    def prewarm_overview(self):
        """Prepare only the summary; all source freshness checks still apply."""
        self._offer_overview(self._read_snapshot())

    @staticmethod
    def _finite_offer_value(value):
        try:
            value = float(value)
        except (TypeError, ValueError):
            return None
        return value if math.isfinite(value) else None

    @staticmethod
    def _offer_date_sort_key(offer):
        value = pd.to_datetime(offer.get("date"), errors="coerce")
        timestamp = None if pd.isna(value) else int(value.value)
        source = str(offer.get("source") or "")
        return (
            timestamp is None,
            -timestamp if timestamp is not None else 0,
            source.casefold(),
            source,
        )

    @staticmethod
    def _normalized_offer_timestamp(value):
        if not isinstance(value, str) or not value.strip():
            return None
        timestamp = pd.to_datetime(value, errors="coerce", utc=True)
        return None if pd.isna(timestamp) else timestamp.isoformat()

    @staticmethod
    def _offer_upload_sort_key(offer):
        value = pd.to_datetime(offer.get("uploaded_at"), errors="coerce", utc=True)
        timestamp = None if pd.isna(value) else int(value.value)
        source = str(offer.get("source") or "")
        return (
            timestamp is None,
            -timestamp if timestamp is not None else 0,
            source.casefold(),
            source,
        )

    def offers(
        self, *, search="", offer_type="", price_level="all", sort="uploaded",
        offset=0, limit=20,
    ):
        snap = self._read_snapshot()
        overview = self._offer_overview(snap)
        offers = overview["offers"]
        if offer_type:
            offers = [o for o in offers if o["offer_type"] == offer_type]
        if search.strip():
            needle = search.strip().casefold()
            offers = [
                o for o in offers if needle in " ".join(
                    str(o.get(key) or "")
                    for key in ("source", "project", "offer_number", "offer_type")
                ).casefold()
            ]

        price_levels = {"all": len(offers), "below": 0, "above": 0, "none": 0}
        classified = []
        for offer in offers:
            value = self._finite_offer_value(offer.get("price_change"))
            level = (
                "none" if value is None
                else "below" if value < 0
                else "above" if value > 0
                else None
            )
            if level is not None:
                price_levels[level] += 1
            classified.append((offer, value, level))

        if price_level != "all":
            classified = [item for item in classified if item[2] == price_level]

        if sort == "uploaded":
            classified = sorted(
                classified, key=lambda item: self._offer_upload_sort_key(item[0])
            )
        elif sort == "date":
            classified = sorted(
                classified, key=lambda item: self._offer_date_sort_key(item[0])
            )
        elif sort == "price_asc":
            classified = sorted(
                classified,
                key=lambda item: (
                    item[1] is None,
                    item[1] if item[1] is not None else 0.0,
                    *self._offer_date_sort_key(item[0]),
                ),
            )
        else:
            classified = sorted(
                classified,
                key=lambda item: (
                    item[1] is None,
                    -item[1] if item[1] is not None else 0.0,
                    *self._offer_date_sort_key(item[0]),
                ),
            )

        # Fresh dictionaries prevent response normalization from mutating the
        # revision-bound cached offer list.
        result = []
        for offer, value, _level in classified[offset : offset + limit]:
            item = dict(offer)
            item["price_change"] = value
            item["price_change_positions"] = self._finite_offer_value(
                item.get("price_change_positions")
            )
            result.append(item)
        return {
            "offers": result,
            "total": len(classified),
            "price_level_counts": price_levels,
            "revision": snap.revision,
            "warnings": overview["warnings"],
        }

    def positions(self, source):
        data = self.load()
        if source not in {candidate.name for candidate in data.offer_sources}:
            raise HTTPException(404, "Angebot im Preisvergleich nicht gefunden.")
        offer = next((o for o in self.offers_list(data) if o["source"] == source), None)
        if offer is None:
            raise HTTPException(422, "Das Angebot enthält keine lesbaren Positionen.")
        frame = self._derived(
            data,
            "offer-positions",
            lambda: core.offer_positions(
                source,
                data.datanorm,
                data.raw_prices,
                data.snap.state,
            ),
            source,
            daily=True,
        )
        return table(
            frame,
            data.snap,
            limit=len(frame),
            offer=offer,
            warnings=data.warnings,
            unavailable_sources=data.unavailable_sources,
        )

    def articles(self, *, search="", limit=50):
        snap = self._read_snapshot()
        index = self._article_index(snap)
        return {"articles": search_article_index(index, search, limit), "revision": snap.revision}

    def _article_index_revision(self, snap):
        active_name = snap.state["active_datanorm"]
        active = snap.find("datanorm", active_name) if active_name else None
        config = snap.state.get("online_import") if active is not None else None
        imported = None
        if config is not None:
            payload = snap.find_cache(config["payload_name"])
            imported = (payload.version, config["payload_sha256"],
                        config["datanorm_frame_active"], config.get("datanorm_binding"))
        identity = (*self._cache_scope, ARTICLE_INDEX_VERSION, CACHE_VERSION,
                    (active.name, active.version) if active is not None else None, imported)
        return hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()

    def _article_index(self, snap, *, revision=None):
        def build():
            imported = self.import_frames(snap) if snap.state["active_datanorm"] else None
            return build_article_search_index(self._datanorm_frame(snap, imported))
        # Every retained element is immutable; no large PriceData deepcopy or
        # offer parsing is necessary for a DATANORM-only article search.
        return price_comparison_cache.get_or_compute(
            (*self._cache_scope, "article-search", revision or self._article_index_revision(snap)),
            build,
        )

    def article_search_index(self, known_revision=""):
        snap = self._read_snapshot()
        revision = self._article_index_revision(snap)
        if known_revision == revision:
            return {"revision": revision, "unchanged": True}
        return {"revision": revision,
                "rows": [row.browser_row() for row in self._article_index(snap, revision=revision)],
                "casefold": dict(unicode_casefold_items())}

    def article(self, article_number, *, offer_types=None):
        data = self.load()
        art = core.clean_artnr(article_number)
        selected_types = None if offer_types is None else tuple(str(value) for value in offer_types)

        def build_article():
            frame = data.datanorm
            matching = (
                frame[frame["Artikelnummer"].astype(str).eq(art)]
                if not frame.empty
                else frame
            )
            history = core.article_history(art, data.prices, selected_types)
            article = records(matching)[0] if not matching.empty else {"Artikelnummer": art}
            stats = core.article_statistics(
                art,
                data.datanorm,
                data.prices,
                selected_types,
            )
            values = (
                pd.to_numeric(history["Preis"], errors="coerce").dropna()
                if "Preis" in history.columns
                else pd.Series(dtype=float)
            )
            # Retain the original detailed keys (median_24m, datanorm_price, ...)
            # and provide the generic aliases consumed by the calendar client.
            stats.update(
                {
                    "minimum": float(values.min()) if not values.empty else None,
                    "maximum": float(values.max()) if not values.empty else None,
                    "median": float(values.median()) if not values.empty else None,
                }
            )
            return matching.empty and history.empty, history, article, stats

        missing, history, article, stats = self._derived(
            data,
            "article",
            build_article,
            art,
            selected_types,
            daily=True,
        )
        if missing:
            raise HTTPException(404, "Artikel nicht gefunden.")
        return table(
            history,
            data.snap,
            limit=len(history),
            article=article,
            statistics=stats,
            unavailable_sources=data.unavailable_sources,
        )

    def files(self):
        snap = self._read_snapshot()
        physical_names = {file.name for file in snap.files if file.kind == "offers"}
        config = snap.state.get("online_import")
        virtual_files = []
        if config is not None:
            virtual_files = [
                {
                    "kind": "offers",
                    "name": name,
                    "size": 0,
                    "modified": "",
                    "active": False,
                    "original_available": False,
                    "included_in_comparison": True,
                }
                for name in config["virtual_sources"]
                if name not in physical_names
            ]
        return {
            "files": [
                {
                    "kind": f.kind,
                    "name": f.name,
                    "size": f.size,
                    "modified": f.modified,
                    "active": f.kind == "datanorm" and f.name == snap.state["active_datanorm"],
                    "original_available": True,
                    "included_in_comparison": self.file_included(snap, f),
                }
                for f in snap.files
            ] + virtual_files,
            "revision": snap.revision,
        }

    def presets(self):
        snap = self._read_snapshot()
        defaults = core.default_reference_rows()
        presets = snap.state["reference_presets"] or {"Standard": defaults}
        return {
            "defaults": references_to_api(defaults),
            "presets": {name: references_to_api(rows) for name, rows in presets.items()},
            "revision": snap.revision,
        }

    def mutate(self, expected_revision, callback, db=None):
        with self._mutation_lock(db):
            snap = snapshot(self.store)
            require_revision(snap, expected_revision)
            callback(snap)
            save_state(self.store, snap)
            return {"revision": snapshot(self.store).revision}

    def update_offer(self, source, patch, expected_revision, db=None):
        safe_name(source)

        def apply(snap):
            current = self.load(snap)
            if source not in {candidate.name for candidate in current.offer_sources}:
                raise HTTPException(404, "Angebot im Preisvergleich nicht gefunden.")
            state = snap.state
            if "offer_type" in patch:
                if patch["offer_type"] not in OFFER_TYPES:
                    raise HTTPException(422, "Ungültige Angebotsart.")
                state["offer_types"][source] = patch["offer_type"]
            if "discount" in patch:
                value = patch["discount"]
                if (
                    not isinstance(value, (int, float))
                    or not math.isfinite(value)
                    or not 0 <= value <= 100
                ):
                    raise HTTPException(422, "Rabatt muss zwischen 0 und 100 Prozent liegen.")
                state["discounts"][source] = value
            if "align_netto" in patch:
                state["align_netto"][source] = bool(patch["align_netto"])
            if patch.get("reset_manual_prices"):
                state["manual_prices"] = {
                    k: v
                    for k, v in state["manual_prices"].items()
                    if not k.startswith(source + "||")
                }
            manual = patch.get("manual_prices") or {}
            deleted = patch.get("delete_articles") or []
            if manual or deleted:
                source_frame = current.raw_prices[
                    current.raw_prices["Quelle"].astype(str).eq(source)
                ]
                articles = set(source_frame["Artikelnummer"].astype(str).map(core.clean_artnr))
                if any(core.clean_artnr(a) not in articles for a in list(manual) + deleted):
                    raise HTTPException(422, "Artikel gehört nicht zu diesem Angebot.")
            for article, value in manual.items():
                key = core.manual_price_key(source, article)
                if value is None:
                    state["manual_prices"].pop(key, None)
                elif not math.isfinite(value) or value < 0:
                    raise HTTPException(
                        422, "Manuelle Preise müssen endlich und nicht negativ sein."
                    )
                else:
                    state["manual_prices"][key] = value
            if deleted:
                state["deleted_articles"][source] = sorted(
                    set(state["deleted_articles"].get(source, []))
                    | {core.clean_artnr(a) for a in deleted}
                )
                for article in deleted:
                    state["manual_prices"].pop(core.manual_price_key(source, article), None)

            if any(key in patch for key in (
                "offer_type", "discount", "align_netto", "manual_prices",
                "reset_manual_prices", "delete_articles",
            )):
                # Every changed reference can affect later offers as well.
                self.refresh_metrics(snap)

        return self.mutate(expected_revision, apply, db)

    def update_preset(self, name, references, expected_revision, db=None):
        name = safe_name(name)

        def apply(snap):
            if references is None:
                snap.state["reference_presets"].pop(name, None)
            else:
                normalized = references_to_core(references)
                if not normalized:
                    raise HTTPException(
                        422, "Mindestens ein gültiger Referenzartikel ist erforderlich."
                    )
                snap.state["reference_presets"][name] = normalized

        return self.mutate(expected_revision, apply, db)

    def refresh_metrics(self, snap, *, sources=None):
        # Percentages are now derived once for the next revision/day on read.
        # Remove obsolete frozen results instead of calculating the complete
        # history here and a second time immediately after saving the revision.
        # Keeping the existing state key preserves the storage schema.
        snap.state["frozen_metrics"] = {}

    @staticmethod
    def _offer_number(frame: pd.DataFrame) -> str | None:
        numbers = frame.get("Angebot", pd.Series(dtype=object)).dropna().astype(str)
        unique = {number.strip() for number in numbers if number.strip()}
        if len(unique) != 1:
            return None
        number = next(iter(unique))
        # Legacy imports can still contain bad metadata such as "BEG". Neither
        # words nor mixed identifiers justify replacing another source file.
        if not re.fullmatch(r"[0-9A-Za-z][0-9A-Za-z\-/]*", number) or not re.search(r"[0-9]", number):
            return None
        return number

    @staticmethod
    def _remove_offer_settings(state: dict, source: str) -> None:
        for key in (
            "discounts",
            "offer_types",
            "align_netto",
            "deleted_articles",
            "frozen_metrics",
            "offer_uploaded_at",
        ):
            state[key].pop(source, None)
        state["manual_prices"] = {
            key: value
            for key, value in state["manual_prices"].items()
            if not key.startswith(source + "||")
        }

    @staticmethod
    def _upload_timestamp() -> str:
        return datetime.now(UTC).isoformat()

    @staticmethod
    def _same_stored_file(left: StoredFile | None, right: StoredFile | None) -> bool:
        if left is None or right is None:
            return left is right
        return (
            left.name == right.name
            and left.version == right.version
            and left.item_id == right.item_id
        )

    def _restore_import_bindings(
        self,
        *,
        original_state_file: StoredFile | None,
        original_state: dict,
        attempted_state: dict,
        restored_versions: list[tuple[StoredFile, StoredFile]],
    ) -> None:
        try:
            current = snapshot(self.store)
        except Exception as exc:
            raise RollbackRecoveryError(
                "Preisdateien wurden wiederhergestellt, aber der aktuelle "
                "Preisvergleich-Zustand konnte nicht sicher geprüft werden. "
                "Bitte den Preisvergleich vor weiteren Änderungen manuell prüfen."
            ) from exc
        state_file_unchanged = self._same_stored_file(
            original_state_file, current.state_file
        )
        state_unchanged = state_file_unchanged and current.state == original_state
        state_is_our_attempt = (
            not state_file_unchanged and current.state == attempted_state
        )
        if not state_unchanged and not state_is_our_attempt:
            raise RollbackRecoveryError(
                "Preisdateien wurden wiederhergestellt, aber calendar_state.json "
                "wurde zwischenzeitlich anderweitig geändert. Der fremde Zustand "
                "wurde nicht überschrieben; bitte den Preisvergleich manuell prüfen."
            )
        if state_unchanged and not restored_versions:
            # The failed state write did not become visible and a newly
            # created source was removed again.  Nothing shared needs repair.
            return

        current.state = deepcopy(original_state)
        config = current.state.get("online_import")
        for previous, restored in restored_versions:
            binding = (
                config["offer_bindings"].get(previous.name)
                if config is not None
                else None
            )
            if (
                previous.kind == "offers"
                and isinstance(binding, dict)
                and binding.get("version") == previous.version
            ):
                binding["version"] = restored.version
                binding["modified"] = restored.modified
            datanorm_binding = config.get("datanorm_binding") if config else None
            if (
                previous.kind == "datanorm"
                and isinstance(datanorm_binding, dict)
                and datanorm_binding.get("name") == previous.name
                and datanorm_binding.get("version") == previous.version
            ):
                datanorm_binding["version"] = restored.version
            if previous.kind == "offers":
                recorded_upload = current.state["offer_uploaded_at"].get(previous.name)
                uploaded_at = (
                    recorded_upload.get("uploaded_at")
                    if isinstance(recorded_upload, dict)
                    and recorded_upload.get("version") == previous.version
                    else previous.modified
                )
                current.state["offer_uploaded_at"][previous.name] = {
                    "version": restored.version,
                    "uploaded_at": uploaded_at,
                }
        try:
            save_state(self.store, current)
        except Exception as exc:
            raise RollbackRecoveryError(
                "Preisdateien wurden wiederhergestellt, aber ihre neuen Versionen "
                "konnten nicht sicher in calendar_state.json gebunden werden. "
                "Bitte den Preisvergleich vor weiteren Änderungen manuell prüfen."
            ) from exc

    def upload(self, kind, uploads, expected_revision, db=None, *, confirmed_duplicates=None):
        if expected_revision is None:
            raise HTTPException(422, "Eine aktuelle Dateirevision ist erforderlich.")
        return self._upload(
            kind, uploads, expected_revision, db,
            confirmed_duplicates=confirmed_duplicates,
        )

    def upload_queued(
        self, kind, uploads, db=None, *, confirmed_revision=None, confirmed_duplicates=None,
    ):
        # A queued append uses the current snapshot inside the mutation lock.
        # Any replacement still pauses for explicit, revision-bound confirmation.
        if confirmed_duplicates and confirmed_revision is None:
            raise HTTPException(422, "Eine aktuelle Dateibestätigung ist erforderlich.")
        return self._upload(
            kind, uploads, confirmed_revision, db,
            confirmed_duplicates=confirmed_duplicates,
        )

    def _existing_offer_numbers(self, snap):
        """Duplicate safety needs source/offer numbers, not the full price comparison."""
        imported = self.import_frames(snap)
        sources = self._offer_sources(snap, imported)
        included = {source.name for source in sources}
        # Previously excluded physical PDFs still participate in duplicate checks.
        sources.extend(
            OfferSource(item.name, item, True, False)
            for item in snap.files if item.kind == "offers" and item.name not in included
        )
        imported_frames = (
            {str(name): frame for name, frame in imported.offers.groupby("Quelle", sort=False)}
            if imported is not None else {}
        )

        def offer_number(source):
            try:
                frame = imported_frames.get(source.name, pd.DataFrame()) if source.imported else self.parsed(source.item)
            except HTTPException as exc:
                if exc.status_code != 422:
                    raise
                return source.name, None
            deleted = snap.state["deleted_articles"].get(source.name, []) if source.name in included else []
            if deleted and not frame.empty:
                frame = frame[~frame["Artikelnummer"].astype(str).map(core.clean_artnr).isin(deleted)]
            return source.name, self._offer_number(frame)

        if len(sources) > 1:
            with ThreadPoolExecutor(max_workers=min(MAX_PARSE_WORKERS, len(sources))) as executor:
                return list(executor.map(offer_number, sources))
        return [offer_number(source) for source in sources]

    def _upload(self, kind, uploads, expected_revision, db=None, *, confirmed_duplicates=None):
        if kind not in ("offers", "datanorm"):
            raise HTTPException(422, "Unbekannte Dateiart.")
        parsed_uploads = {}
        for name, raw in uploads:
            safe_name(name)
            suffixes = (".pdf",) if kind == "offers" else (".txt", ".dat")
            if not name.lower().endswith(suffixes) or not raw:
                raise HTTPException(422, "Bitte PDF-Angebote bzw. DATANORM-TXT/DAT hochladen.")
            if len(raw) > MAX_FILE_BYTES:
                raise HTTPException(413, "Datei ist größer als 40 MB.")
            if kind == "offers" and b"%PDF-" not in raw[:1024]:
                raise HTTPException(422, "Ungültige PDF-Datei.")
            # Validate every input before the first source file is written.
            temporary_item = StoredFile(kind, name, len(raw), "", hashlib.sha256(raw).hexdigest())
            parsed_uploads[name] = self.parsed(temporary_item, raw=raw)
        if len({name.casefold() for name, _ in uploads}) != len(uploads):
            raise HTTPException(422, "Ein Upload darf jeden Dateinamen nur einmal enthalten.")
        with self._mutation_lock(db):
            snap = snapshot(self.store)
            if expected_revision is not None:
                require_revision(snap, expected_revision)
            original_state = deepcopy(snap.state)
            existing_groups: dict[str, list[StoredFile]] = {}
            for item in snap.files:
                if item.kind == kind:
                    existing_groups.setdefault(item.name.casefold(), []).append(item)
            uploaded_by_casefold = {name.casefold(): name for name, _ in uploads}
            config = snap.state.get("online_import")
            virtual_by_casefold = {
                name.casefold(): name
                for name in (config["virtual_sources"] if config else [])
            }
            for folded_name in uploaded_by_casefold:
                if len(existing_groups.get(folded_name, [])) > 1:
                    raise HTTPException(
                        409,
                        "Ein vorhandener Dateiname ist in OneDrive nicht eindeutig.",
                    )
            canonical_names = {
                name: (
                    existing_groups[name.casefold()][0].name
                    if existing_groups.get(name.casefold())
                    else virtual_by_casefold.get(name.casefold(), name)
                )
                for name, _ in uploads
            }
            duplicates, excluded = [], set()
            if kind == "offers":
                winners = {}
                for name, _ in uploads:
                    number = self._offer_number(parsed_uploads[name])
                    if number:
                        if number in winners:
                            excluded.add(winners[number])
                        winners[number] = name
                for source_name, number in self._existing_offer_numbers(snap):
                    matching_upload = uploaded_by_casefold.get(source_name.casefold())
                    if number in winners or matching_upload is not None:
                        winner_upload = winners.get(number, matching_upload)
                        keep = canonical_names[winner_upload]
                        duplicates.append(
                            {
                                "offer_number": number or "—",
                                "keep": keep,
                                "remove": source_name,
                            }
                        )
                for number, keep in winners.items():
                    for name in excluded:
                        if self._offer_number(parsed_uploads[name]) == number:
                            duplicates.append(
                                {
                                    "offer_number": number,
                                    "keep": canonical_names[keep],
                                    "remove": canonical_names[name],
                                }
                            )
            else:
                for name, _ in uploads:
                    existing = existing_groups.get(name.casefold(), [])
                    if existing:
                        duplicates.append(
                            {
                                "offer_number": "DATANORM",
                                "keep": existing[0].name,
                                "remove": existing[0].name,
                            }
                        )
            duplicates = list({entry["remove"]: entry for entry in duplicates}.values())
            wanted = {entry["remove"] for entry in duplicates}
            if wanted != set(confirmed_duplicates or []):
                raise HTTPException(
                    409,
                    {
                        "code": "duplicate_offers",
                        "message": "Der Upload ersetzt vorhandene Dateien oder Angebote. Bitte die Dateiliste bestätigen.",
                        "duplicates": duplicates,
                        "revision": snap.revision,
                    },
                )
            kept_names = {canonical_names[name] for name, _ in uploads if name not in excluded}
            virtual_removals = (
                wanted & set(config["virtual_sources"])
                if kind == "offers" and config is not None
                else set()
            )
            remove_items = [
                f
                for f in snap.files
                if f.kind == kind and f.name in wanted and f.name not in kept_names
            ]
            backups = {f.name: self.store.read(f) for f in remove_items}
            changed, removed = [], []
            try:
                for name, raw in uploads:
                    if name in excluded:
                        continue
                    previous_items = existing_groups.get(name.casefold(), [])
                    previous = previous_items[0] if previous_items else None
                    target_name = canonical_names[name]
                    backup = self.store.read(previous) if previous else None
                    updated = self.store.write(kind, target_name, raw, previous)
                    changed.append((updated, backup, previous))
                    self._promote_upload_cache(updated, parsed_uploads[name])
                    if kind == "datanorm":
                        snap.state["active_datanorm"] = target_name
                    else:
                        snap.state["deleted_articles"].pop(target_name, None)
                if kind == "offers" and changed:
                    uploaded_at = self._upload_timestamp()
                    for updated, _backup, _previous in changed:
                        snap.state["offer_uploaded_at"][updated.name] = {
                            "version": updated.version,
                            "uploaded_at": uploaded_at,
                        }
                for item in remove_items:
                    self.store.delete(item)
                    removed.append(item)
                    self._remove_offer_settings(snap.state, item.name)
                if virtual_removals:
                    config["virtual_sources"] = [
                        source
                        for source in config["virtual_sources"]
                        if source not in virtual_removals
                    ]
                    for source in virtual_removals - kept_names:
                        self._remove_offer_settings(snap.state, source)
                refreshed = snapshot(self.store)
                snap.files = refreshed.files
                # The original incremental upload recalculates every offer
                # header because the new history can change later offers.
                self.refresh_metrics(snap)
                save_state(self.store, snap)
            except Exception as original_error:
                # Compensate only our writes, using their exact versions.  A
                # restored Graph/local item gets a fresh version, so an active
                # import binding must follow that version or the rollback would
                # silently switch the source to the current parser.
                try:
                    restored_versions = []
                    for item in reversed(removed):
                        restored = self.store.write(
                            item.kind, item.name, backups[item.name], None
                        )
                        restored_versions.append((item, restored))
                    for updated, backup, previous in reversed(changed):
                        if backup is None:
                            self.store.delete(updated)
                        else:
                            restored = self.store.write(
                                updated.kind, updated.name, backup, updated
                            )
                            restored_versions.append((previous, restored))
                    self._restore_import_bindings(
                        original_state_file=snap.state_file,
                        original_state=original_state,
                        attempted_state=deepcopy(snap.state),
                        restored_versions=restored_versions,
                    )
                except RollbackRecoveryError as rollback_error:
                    raise rollback_error from original_error
                except Exception as rollback_error:
                    raise RuntimeError(
                        "Preisdatei-Upload konnte nicht sicher zurückgerollt werden."
                    ) from rollback_error
                raise original_error
            return {"revision": snapshot(self.store).revision}

    def delete_file(self, kind, name, expected_revision, db=None):
        with self._mutation_lock(db):
            snap = snapshot(self.store)
            require_revision(snap, expected_revision)
            original_state = deepcopy(snap.state)
            config = snap.state.get("online_import")
            is_virtual = bool(
                kind == "offers"
                and config is not None
                and name in config["virtual_sources"]
                and not any(
                    item.kind == "offers" and item.name == name for item in snap.files
                )
            )
            if is_virtual:
                config["virtual_sources"] = [
                    source for source in config["virtual_sources"] if source != name
                ]
                for key in (
                    "discounts",
                    "offer_types",
                    "align_netto",
                    "deleted_articles",
                    "frozen_metrics",
                    "offer_uploaded_at",
                ):
                    snap.state[key].pop(name, None)
                snap.state["manual_prices"] = {
                    key: value
                    for key, value in snap.state["manual_prices"].items()
                    if not key.startswith(name + "||")
                }
                save_state(self.store, snap)
                return {"revision": snapshot(self.store).revision}
            item = snap.find(kind, name)
            backup = self.store.read(item)
            self.store.delete(item)
            try:
                if kind == "datanorm" and snap.state["active_datanorm"] == name:
                    snap.state["active_datanorm"] = None
                if kind == "offers":
                    self._remove_offer_settings(snap.state, name)
                save_state(self.store, snap)
            except Exception as original_error:
                try:
                    restored = self.store.write(kind, name, backup, None)
                    self._restore_import_bindings(
                        original_state_file=snap.state_file,
                        original_state=original_state,
                        attempted_state=deepcopy(snap.state),
                        restored_versions=[(item, restored)],
                    )
                except RollbackRecoveryError as rollback_error:
                    raise rollback_error from original_error
                except Exception as rollback_error:
                    raise RuntimeError(
                        "Preisdatei-Löschung konnte nicht sicher zurückgerollt werden."
                    ) from rollback_error
                raise original_error
            return {"revision": snapshot(self.store).revision}

    def rebuild_preview(self, expected_revision):
        snap = snapshot(self.store)
        require_revision(snap, expected_revision)
        duplicates, warnings = self._duplicates(snap)
        return {"duplicates": duplicates, "warnings": warnings, "revision": snap.revision}

    def _duplicates(self, snap):
        seen, duplicates, warnings = {}, [], []
        files = sorted(
            (f for f in snap.files if f.kind == "offers"),
            key=lambda f: (f.modified, f.name),
            reverse=True,
        )
        for item in files:
            try:
                frame = self.parsed(item)
            except HTTPException as exc:
                if exc.status_code != 422:
                    raise
                warnings.append(str(exc.detail))
                continue
            number = self._offer_number(frame)
            if number is None:
                continue
            if number in seen:
                duplicates.append(
                    {"offer_number": number, "keep": seen[number], "remove": item.name}
                )
            else:
                seen[number] = item.name
        return duplicates, warnings

    def rebuild(self, expected_revision, confirmed_duplicates, db=None):
        with self._mutation_lock(db):
            snap = snapshot(self.store)
            require_revision(snap, expected_revision)
            duplicates, _ = self._duplicates(snap)
            wanted = {entry["remove"] for entry in duplicates}
            if wanted != set(confirmed_duplicates):
                raise HTTPException(
                    409, "Bitte die aktuelle Liste der doppelten Angebote bestätigen."
                )
            original_state = deepcopy(snap.state)
            state = deepcopy(snap.state)
            state["deleted_articles"] = {}
            if state.get("online_import") is not None:
                # A confirmed rebuild deliberately switches every physical
                # offer back to the current parser.  The one source whose PDF
                # was already missing online remains available from the
                # immutable import frame until it is explicitly deleted.
                state["online_import"]["physical_frames_active"] = False
            removed = []
            try:
                # Original rebuild restores positions from the unchanged PDFs.
                for name in sorted(wanted):
                    item = snap.find("offers", name)
                    content = self.store.read(item)
                    self.store.delete(item)
                    removed.append((item, content))
                    for key in (
                        "discounts", "offer_types", "align_netto", "frozen_metrics",
                        "offer_uploaded_at",
                    ):
                        state[key].pop(name, None)
                    state["manual_prices"] = {
                        k: v
                        for k, v in state["manual_prices"].items()
                        if not k.startswith(name + "||")
                    }
                snap.files = [f for f in snap.files if f.kind != "offers" or f.name not in wanted]
                snap.state = state
                self.load(snap, force=True)
                self.refresh_metrics(snap)
                save_state(self.store, snap)
            except Exception as original_error:
                try:
                    restored_versions = []
                    for item, content in reversed(removed):
                        restored = self.store.write(
                            item.kind, item.name, content, None
                        )
                        restored_versions.append((item, restored))
                    self._restore_import_bindings(
                        original_state_file=snap.state_file,
                        original_state=original_state,
                        attempted_state=deepcopy(snap.state),
                        restored_versions=restored_versions,
                    )
                except RollbackRecoveryError as rollback_error:
                    raise rollback_error from original_error
                except Exception as rollback_error:
                    raise RuntimeError(
                        "Angebots-Neuaufbau konnte nicht sicher zurückgerollt werden."
                    ) from rollback_error
                raise original_error
            return {"revision": snapshot(self.store).revision, "removed_count": len(removed)}
