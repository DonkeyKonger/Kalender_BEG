"""Validated compatibility import for the last authoritative online price view."""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import pickle
import tempfile

from fastapi import HTTPException
import pandas as pd

from app.services.price_comparison_storage import Snapshot, safe_name


FORMAT = "BEG priceviewer exact online frame transfer v1"
MIGRATION_MODE = "exact_legacy_online_display"
LOCAL_CACHE_VERSION = "online-import-v1"
MAX_FRAME_ROWS = 1_000_000
MAX_FRAME_COLUMNS = 200
FRAME_COLUMNS = {
    "offers_combined": [
        "Artikelnummer", "Preis", "Quelle", "PDF_Order", "Bezeichnung (PDF)",
        "Menge", "Einheit (PDF)", "Datum", "Angebot", "Anbieter", "Projekt",
        "Gesamt (netto)", "Gesamt (brutto)",
    ],
    "offers_meta": [
        "Quelle", "Datum", "Projekt", "Anbieter", "Angebot", "Pos_Anzahl",
        "Gesamt_netto", "Gesamt_brutto", "Angebotsart", "Upload_ts", "Upload",
        "PV_avg_pct_pos", "PV_avg_pct_wert",
    ],
    "datanorm_active": [
        "Artikelnummer", "Bezeichnung", "Kurzbezeichnung", "DatanormWarengruppe",
        "DatanormMaterial", "Artikelcluster", "Cluster-Sicherheit", "Einheit",
        "Nettopreis", "Preiseinheit", "Preis (Roh € pro Preiseinheit)", "Preis-Typ",
    ],
}
FRAME_DTYPES = {
    "offers_combined": [
        "str", "float64", "str", "int64", "object", "float64", "object",
        "datetime64[us]", "str", "object", "str", "float64", "object",
    ],
    "offers_meta": [
        "str", "datetime64[us]", "str", "object", "str", "int64", "float64",
        "float64", "str", "float64", "datetime64[s]", "object", "object",
    ],
    "datanorm_active": [
        "str", "str", "str", "str", "str", "str", "str", "str", "float64",
        "str", "float64", "str",
    ],
}
FRAME_INDEX_TYPES = {
    "offers_combined": "pandas.Index",
    "offers_meta": "pandas.RangeIndex",
    "datanorm_active": "pandas.RangeIndex",
}


@dataclass(frozen=True)
class OnlineImportFrames:
    offers: pd.DataFrame
    offer_meta: pd.DataFrame
    datanorm: pd.DataFrame
    offer_source_order: tuple[str, ...]
    authoritative_offer_sources: frozenset[str]
    virtual_sources: frozenset[str]
    active_datanorm: str


def _invalid() -> HTTPException:
    return HTTPException(422, "Importierter Online-Preisvergleich ist ungültig.")


def _string_list(value: object, *, unique: bool = False) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise ValueError("expected string list")
    if unique and len(set(value)) != len(value):
        raise ValueError("expected unique string list")
    return value


def _order_sha256(values: list) -> str:
    return hashlib.sha256(
        json.dumps(
            list(values),
            ensure_ascii=False,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    ).hexdigest()


def _frame(value: object, frame_name: str) -> pd.DataFrame:
    if not isinstance(value, dict) or value.get("object_type") != "DataFrame":
        raise ValueError("invalid frame")
    shape = value.get("shape")
    columns = _string_list(value.get("columns"), unique=True)
    dtypes = _string_list(value.get("dtypes"))
    rows = value.get("rows")
    if (
        not isinstance(shape, list)
        or len(shape) != 2
        or any(not isinstance(size, int) or size < 0 for size in shape)
        or shape != [len(rows) if isinstance(rows, list) else -1, len(columns)]
        or shape[0] > MAX_FRAME_ROWS
        or shape[1] > MAX_FRAME_COLUMNS
        or len(dtypes) != len(columns)
        or columns != FRAME_COLUMNS[frame_name]
        or dtypes != FRAME_DTYPES[frame_name]
    ):
        raise ValueError("invalid frame shape")
    values, indices = [], []
    for row in rows:
        if not isinstance(row, dict) or set(row) != {"index", "values"}:
            raise ValueError("invalid frame row")
        row_values = row["values"]
        if not isinstance(row_values, list) or len(row_values) != len(columns):
            raise ValueError("invalid frame row values")
        row_index = row["index"]
        if row_index is not None and not isinstance(row_index, (str, int, float, bool)):
            raise ValueError("invalid frame index value")
        if isinstance(row_index, float) and not math.isfinite(row_index):
            raise ValueError("invalid frame index value")
        for cell in row_values:
            if cell is not None and not isinstance(cell, (str, int, float, bool)):
                raise ValueError("invalid frame cell")
            if isinstance(cell, float) and not math.isfinite(cell):
                raise ValueError("invalid frame number")
        values.append(row_values)
        indices.append(row_index)
    frame = pd.DataFrame(values, columns=columns)
    for column, dtype in zip(columns, dtypes, strict=True):
        if dtype in {"datetime64[us]", "datetime64[s]"}:
            if any(value is not None and not isinstance(value, str) for value in frame[column]):
                raise ValueError("invalid datetime frame value")
            frame[column] = pd.to_datetime(frame[column], errors="raise").astype(dtype)
        elif dtype == "float64":
            if any(isinstance(value, bool) for value in frame[column] if value is not None):
                raise ValueError("invalid float frame value")
            frame[column] = pd.to_numeric(frame[column], errors="raise").astype(dtype)
            if not all(pd.isna(value) or math.isfinite(float(value)) for value in frame[column]):
                raise ValueError("invalid frame number")
        elif dtype == "int64":
            if any(isinstance(value, bool) for value in frame[column] if value is not None):
                raise ValueError("invalid integer frame value")
            numeric = pd.to_numeric(frame[column], errors="raise")
            if numeric.isna().any() or not all(
                math.isfinite(float(value)) and float(value).is_integer()
                and -(2**63) <= int(value) < 2**63
                for value in numeric
            ):
                raise ValueError("invalid integer frame value")
            frame[column] = numeric.astype(dtype)
        elif dtype in {"str", "string"}:
            # Preserve nulls as Python None exactly as the legacy object/string
            # frames did; astype(str) would turn them into the literal "None".
            if any(value is not None and not isinstance(value, str) for value in frame[column]):
                raise ValueError("invalid string frame value")
            frame[column] = frame[column].map(
                lambda cell: None if cell is None else str(cell)
            )
        elif dtype == "object":
            frame[column] = frame[column].astype(object)
    index = value.get("index")
    if (
        not isinstance(index, dict)
        or set(index) != {"name", "type", "unique"}
        or index["name"] is not None
        or index["type"] != FRAME_INDEX_TYPES[frame_name]
        or index["unique"] is not True
        or (
            index["type"] == "pandas.RangeIndex"
            and indices != list(range(len(indices)))
        )
    ):
        raise ValueError("invalid frame index")
    if index["type"] == "pandas.RangeIndex":
        frame.index = pd.RangeIndex(len(indices), name=index["name"])
    else:
        frame.index = pd.Index(indices, name=index["name"])
    if bool(frame.index.is_unique) != index["unique"]:
        raise ValueError("invalid frame index uniqueness")
    return frame


def parse_online_import(raw: bytes) -> OnlineImportFrames:
    try:
        def reject_constant(_value):
            raise ValueError("non-finite JSON number")

        payload = json.loads(raw, parse_constant=reject_constant)
        if (
            not isinstance(payload, dict)
            or payload.get("format") != FORMAT
            or payload.get("migration_mode") != MIGRATION_MODE
        ):
            raise ValueError("invalid import header")
        frames = payload.get("frames")
        expected = payload.get("expected_target")
        audit = payload.get("source_audit")
        if (
            not isinstance(frames, dict)
            or set(frames) != set(FRAME_COLUMNS)
            or not isinstance(expected, dict)
            or not isinstance(audit, list)
            or len(audit) != 11
        ):
            raise ValueError("missing import sections")
        audited = {}
        for entry in audit:
            if not isinstance(entry, dict):
                raise ValueError("invalid source audit")
            name, size, digest = entry.get("name"), entry.get("size"), entry.get("sha256")
            if (
                not isinstance(name, str)
                or name in audited
                or not isinstance(size, int)
                or size < 0
                or not isinstance(digest, str)
                or len(digest) != 64
                or any(character not in "0123456789abcdef" for character in digest)
            ):
                raise ValueError("invalid source audit")
            audited[name] = (size, digest)
        for frame_name, frame_payload in frames.items():
            if not isinstance(frame_payload, dict):
                raise ValueError("invalid frame")
            if audited.get(frame_payload.get("source_name")) != (
                frame_payload.get("source_size"),
                frame_payload.get("source_sha256"),
            ):
                raise ValueError("frame source audit mismatch")
            if frame_payload.get("source_name") != f"{frame_name}.pkl":
                raise ValueError("unexpected frame source")
        hashes = expected.get("order_hashes")
        if not isinstance(hashes, dict):
            raise ValueError("missing order hashes")
        meta_columns = frames["offers_meta"]["columns"]
        frozen_indices = [
            meta_columns.index(column)
            for column in ("Quelle", "PV_avg_pct_pos", "PV_avg_pct_wert")
        ]
        frozen_rows = [
            {
                "Quelle": row["values"][frozen_indices[0]],
                "PV_avg_pct_pos": row["values"][frozen_indices[1]],
                "PV_avg_pct_wert": row["values"][frozen_indices[2]],
            }
            for row in frames["offers_meta"]["rows"]
        ]
        expected_hashes = {
            "offers_combined_rows": _order_sha256(frames["offers_combined"]["rows"]),
            "offers_meta_rows": _order_sha256(frames["offers_meta"]["rows"]),
            "datanorm_active_rows": _order_sha256(frames["datanorm_active"]["rows"]),
            "offer_source_order": _order_sha256(expected.get("offer_source_order", [])),
            "authoritative_offer_sources": _order_sha256(
                expected.get("authoritative_offer_source_order", [])
            ),
            "frozen_metrics": _order_sha256(frozen_rows),
        }
        if any(hashes.get(name) != digest for name, digest in expected_hashes.items()):
            raise ValueError("import order hash mismatch")
        offers = _frame(frames.get("offers_combined"), "offers_combined")
        offer_meta = _frame(frames.get("offers_meta"), "offers_meta")
        datanorm = _frame(frames.get("datanorm_active"), "datanorm_active")
        source_order = _string_list(expected.get("offer_source_order"), unique=True)
        authoritative = _string_list(
            expected.get("authoritative_offer_source_order"), unique=True
        )
        virtual = _string_list(expected.get("virtual_sources"), unique=True)
        active_datanorm = expected.get("active_datanorm")
        if not isinstance(active_datanorm, str) or not active_datanorm:
            raise ValueError("invalid active datanorm")
        safe_name(active_datanorm)
        if "Quelle" not in offers.columns:
            raise ValueError("missing offer source")
        frame_sources = set(offers["Quelle"].dropna().astype(str))
        for source in frame_sources:
            safe_name(source)
        metadata_sources = offer_meta["Quelle"].dropna().astype(str).tolist()
        if (
            set(source_order) != frame_sources
            or set(authoritative) != frame_sources
            or not set(virtual).issubset(frame_sources)
            or metadata_sources != source_order
            or expected.get("offer_combined_row_count") != len(offers)
            or expected.get("offer_meta_row_count") != len(offer_meta)
            or expected.get("datanorm_row_count") != len(datanorm)
            or expected.get("offer_source_count") != len(source_order)
        ):
            raise ValueError("offer source mismatch")
        return OnlineImportFrames(
            offers=offers,
            offer_meta=offer_meta,
            datanorm=datanorm,
            offer_source_order=tuple(source_order),
            authoritative_offer_sources=frozenset(authoritative),
            virtual_sources=frozenset(virtual),
            active_datanorm=active_datanorm,
        )
    except (
        KeyError,
        TypeError,
        ValueError,
        UnicodeError,
        json.JSONDecodeError,
        HTTPException,
    ) as exc:
        raise _invalid() from exc


def _valid_cached(value: object) -> OnlineImportFrames | None:
    if not isinstance(value, OnlineImportFrames):
        return None
    if not all(
        isinstance(frame, pd.DataFrame)
        for frame in (value.offers, value.offer_meta, value.datanorm)
    ):
        return None
    return value


@contextmanager
def _fill_lock(path: Path):
    lock_path = path.with_suffix(".lock")
    if lock_path.is_symlink():
        raise HTTPException(500, "Ungültiger interner Preisdatei-Cache.")
    with lock_path.open("a+b") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def load_online_import(store, snap: Snapshot, cache_dir: Path) -> OnlineImportFrames | None:
    config = snap.state.get("online_import")
    if config is None:
        return None
    item = snap.find_cache(config["payload_name"])
    key = hashlib.sha256(
        json.dumps(
            [LOCAL_CACHE_VERSION, store.identity, item.version, config["payload_sha256"]],
            ensure_ascii=False,
        ).encode()
    ).hexdigest()
    cache_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = cache_dir / f"online-{key}.pkl"
    if path.is_symlink():
        raise HTTPException(500, "Ungültiger interner Preisdatei-Cache.")

    def cached():
        try:
            with path.open("rb") as handle:
                return _valid_cached(pickle.load(handle))
        except (ValueError, EOFError, OSError, pickle.PickleError, AttributeError):
            return None

    def validated(value: OnlineImportFrames) -> OnlineImportFrames:
        if not set(config["virtual_sources"]).issubset(value.virtual_sources):
            raise _invalid()
        return value

    if path.exists():
        value = cached()
        if value is not None:
            return validated(value)
    with _fill_lock(path):
        if path.exists():
            value = cached()
            if value is not None:
                return validated(value)
        raw = store.read(item)
        if hashlib.sha256(raw).hexdigest() != config["payload_sha256"]:
            raise _invalid()
        value = parse_online_import(raw)
        validated(value)
        with tempfile.NamedTemporaryFile(dir=cache_dir, prefix=".online-", delete=False) as handle:
            temporary = Path(handle.name)
            try:
                pickle.dump(value, handle, protocol=pickle.HIGHEST_PROTOCOL)
                handle.flush()
                os.replace(temporary, path)
            finally:
                temporary.unlink(missing_ok=True)
        return value
