from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import hashlib
import io
import json
import math
from threading import Lock
from time import sleep
from types import SimpleNamespace

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pandas as pd
import pytest
from openpyxl import load_workbook
from reportlab.pdfgen import canvas

from app.api.dependencies import get_current_user
from app.api.routes.price_comparison import price_service, router
from app.core.database import get_db
from app.models.enums import UserRole
from app.services import price_comparison_core as core
from app.services.price_comparison_service import PriceComparisonService
from app.services.price_comparison_storage import (
    ONLINE_IMPORT_NAME,
    STATE_NAME,
    LocalPriceStorage,
    Snapshot,
    StoredFile,
    save_state,
    snapshot,
)


def typed_frame(frame, source_name):
    split = json.loads(
        frame.to_json(
            orient="split",
            date_format="iso",
            date_unit="us",
            double_precision=15,
        )
    )
    expected_dtypes = {
        "offers_combined.pkl": [
            "str", "float64", "str", "int64", "object", "float64", "object",
            "datetime64[us]", "str", "object", "str", "float64", "object",
        ],
        "offers_meta.pkl": [
            "str", "datetime64[us]", "str", "object", "str", "int64", "float64",
            "float64", "str", "float64", "datetime64[s]", "object", "object",
        ],
        "datanorm_active.pkl": [
            "str", "str", "str", "str", "str", "str", "str", "str", "float64",
            "str", "float64", "str",
        ],
    }
    expected_index = (
        "pandas.Index" if source_name == "offers_combined.pkl" else "pandas.RangeIndex"
    )
    return {
        "source_name": source_name,
        "source_sha256": "0" * 64,
        "source_size": 1,
        "object_type": "DataFrame",
        "shape": list(frame.shape),
        "columns": [str(column) for column in frame.columns],
        "dtypes": expected_dtypes[source_name],
        "index": {
            "name": frame.index.name,
            "type": expected_index,
            "unique": bool(frame.index.is_unique),
        },
        "rows": [
            {"index": index, "values": values}
            for index, values in zip(split["index"], split["data"], strict=True)
        ],
    }


def install_online_import(
    service,
    *,
    physical_name="Angebot.pdf",
    excluded_name="Extra.pdf",
    virtual_name="Virtual.pdf",
):
    snap = snapshot(service.store)
    physical = snap.find("offers", physical_name)
    excluded = snap.find("offers", excluded_name)
    datanorm_item = snap.find("datanorm", "preise.dat")
    physical_frame = service.parsed(physical).copy()
    physical_frame["Preis"] = 7.25
    virtual_frame = physical_frame.copy()
    virtual_frame["Quelle"] = virtual_name
    virtual_frame["Angebot"] = "VIRTUAL-1"
    offers = pd.concat([physical_frame, virtual_frame], ignore_index=True)
    metadata = pd.DataFrame(
        [
            {
                "Quelle": physical_name,
                "Datum": pd.Timestamp("2026-05-01"),
                "Projekt": "Testprojekt",
                "Anbieter": None,
                "Angebot": "TEST-1",
                "Pos_Anzahl": 1,
                "Gesamt_netto": 1234.0,
                "Gesamt_brutto": 0.0,
                "Angebotsart": "Erstangebot",
                "Upload_ts": 2.0,
                "Upload": pd.Timestamp("2026-05-01"),
                "PV_avg_pct_pos": None,
                "PV_avg_pct_wert": None,
            },
            {
                "Quelle": virtual_name,
                "Datum": pd.Timestamp("2026-05-01"),
                "Projekt": "Testprojekt",
                "Anbieter": None,
                "Angebot": "VIRTUAL-1",
                "Pos_Anzahl": 1,
                "Gesamt_netto": 1234.0,
                "Gesamt_brutto": 0.0,
                "Angebotsart": "Erstangebot",
                "Upload_ts": 1.0,
                "Upload": pd.Timestamp("2026-05-01"),
                "PV_avg_pct_pos": None,
                "PV_avg_pct_wert": None,
            },
        ]
    )
    datanorm = service.parsed(datanorm_item).copy()
    datanorm["Artikelcluster"] = "Legacy-Cluster"
    payload = {
        "format": "BEG priceviewer exact online frame transfer v1",
        "migration_mode": "exact_legacy_online_display",
        "source_audit": [
            {"name": name, "size": 1, "sha256": "0" * 64}
            for name in [
                "offers_combined.pkl",
                "offers_meta.pkl",
                "datanorm_active.pkl",
                "align_netto.json",
                "datanorm_active.json",
                "offer_types.json",
                "offers_combined.json",
                "offers_meta.json",
                "manual_prices.json",
                "rabatte.json",
                "tab1_net_price_reference_presets.json",
            ]
        ],
        "frames": {
            "offers_combined": typed_frame(offers, "offers_combined.pkl"),
            "offers_meta": typed_frame(metadata, "offers_meta.pkl"),
            "datanorm_active": typed_frame(datanorm, "datanorm_active.pkl"),
        },
        "expected_target": {
            "offer_source_order": [physical_name, virtual_name],
            "authoritative_offer_source_order": [physical_name, virtual_name],
            "virtual_sources": [virtual_name],
            "active_datanorm": "preise.dat",
            "offer_combined_row_count": len(offers),
            "offer_meta_row_count": len(metadata),
            "datanorm_row_count": len(datanorm),
            "offer_source_count": 2,
        },
    }
    def order_hash(values):
        return hashlib.sha256(
            json.dumps(
                list(values),
                ensure_ascii=False,
                separators=(",", ":"),
                allow_nan=False,
            ).encode()
        ).hexdigest()

    meta_frame = payload["frames"]["offers_meta"]
    meta_columns = meta_frame["columns"]
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
        for row in meta_frame["rows"]
    ]
    payload["expected_target"]["order_hashes"] = {
        "offers_combined_rows": order_hash(payload["frames"]["offers_combined"]["rows"]),
        "offers_meta_rows": order_hash(meta_frame["rows"]),
        "datanorm_active_rows": order_hash(payload["frames"]["datanorm_active"]["rows"]),
        "offer_source_order": order_hash(payload["expected_target"]["offer_source_order"]),
        "authoritative_offer_sources": order_hash(
            payload["expected_target"]["authoritative_offer_source_order"]
        ),
        "frozen_metrics": order_hash(frozen_rows),
    }
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, allow_nan=False).encode()
    service.store.write("cache", ONLINE_IMPORT_NAME, raw, None)
    snap = snapshot(service.store)
    snap.state["online_import"] = {
        "version": 1,
        "payload_name": ONLINE_IMPORT_NAME,
        "payload_sha256": hashlib.sha256(raw).hexdigest(),
        "offer_bindings": {
            physical_name: {
                "version": physical.version,
                "mode": "snapshot",
                "modified": physical.modified,
            },
            excluded_name: {
                "version": excluded.version,
                "mode": "excluded",
                "modified": excluded.modified,
            },
        },
        "datanorm_binding": {
            "name": datanorm_item.name,
            "version": datanorm_item.version,
        },
        "virtual_sources": [virtual_name],
        "physical_frames_active": True,
        "datanorm_frame_active": True,
    }
    save_state(service.store, snap)
    return payload


def offer_pdf(number="TEST-1", price="12,34"):
    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer)
    for i, line in enumerate(
        [
            "01.05.2026",
            f"Angebot: {number}",
            f"Projektname: Testprojekt Angebot: {number}",
            "OBO Bettermann",
            f"6047611 RKSM 620 FS 100,00 Stück {price} 1",
            "Gesamt netto 1.234,00 EUR",
        ]
    ):
        pdf.drawString(35, 800 - i * 20, line)
    pdf.save()
    return buffer.getvalue()


def empty_offer_pdf():
    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer)
    pdf.showPage()
    pdf.save()
    return buffer.getvalue()


@pytest.fixture
def context(tmp_path):
    store = LocalPriceStorage(tmp_path / "files")
    service = PriceComparisonService(store, cache_dir=tmp_path / "parse-cache")
    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.dependency_overrides[price_service] = lambda: service
    app.dependency_overrides[get_db] = lambda: None
    user = SimpleNamespace(
        id=1,
        role=UserRole.ADMIN,
        is_active=True,
        must_change_password=False,
        office_page_permissions=[],
    )
    app.dependency_overrides[get_current_user] = lambda: user
    return TestClient(app), service, user


def upload(client, name, raw, kind):
    revision = client.get("/api/price-comparison/status").json()["revision"]
    return client.post(
        "/api/price-comparison/files",
        data={"kind": kind, "expected_revision": revision},
        files=[("files", (name, raw, "application/octet-stream"))],
    )


def seed(client):
    datanorm = b"A;N;6047611;;Kabelrinne;;2;0;M;1000;0410\nB;N;6047611;RKSM 620 FS\nC;\n"
    result = upload(client, "preise.dat", datanorm, "datanorm")
    assert result.status_code == 200, result.text
    raw = offer_pdf()
    result = upload(client, "Angebot.pdf", raw, "offers")
    assert result.status_code == 200, result.text
    return raw


@pytest.mark.parametrize(
    "role,expected",
    [
        (UserRole.ADMIN, 200),
        (UserRole.PROJECT_MANAGER, 200),
        (UserRole.OFFICE, 403),
        (UserRole.MONTEUR, 403),
        (UserRole.WAREHOUSE, 403),
    ],
)
def test_page_and_file_endpoints_enforce_roles(context, role, expected):
    client, _, user = context
    user.role = role
    assert client.get("/api/price-comparison/status").status_code == expected
    assert client.get("/api/price-comparison/files").status_code == expected
    assert client.get("/api/price-comparison/article-search-index").status_code == expected


def test_anonymous_and_password_change_cannot_bypass_access(context):
    client, _, user = context
    user.must_change_password = True
    assert client.get("/api/price-comparison/status").status_code == 403
    assert client.get("/api/price-comparison/article-search-index").status_code == 403
    client.app.dependency_overrides.pop(get_current_user)
    assert client.get("/api/price-comparison/status").status_code == 401
    assert client.get("/api/price-comparison/article-search-index").status_code == 401


def test_real_parsers_upload_views_and_original_download(context):
    client, service, _ = context
    original = seed(client)
    status = client.get("/api/price-comparison/status").json()
    assert status["offer_count"] == status["datanorm_count"] == 1
    assert status["active_datanorm"] == "preise.dat"
    result = client.get("/api/price-comparison/datanorm")
    assert result.status_code == 200, result.text
    row = result.json()["rows"][0]
    assert row["Artikelnummer"] == "6047611"
    assert row["Nettopreis"] == 10.0
    assert row["Angebotspreis 1"] == pytest.approx(12.34)
    offers = client.get("/api/price-comparison/offers").json()
    assert offers["offers"][0]["offer_number"] == "TEST-1"
    assert offers["offers"][0]["position_count"] == 1
    positions = client.get("/api/price-comparison/offers/Angebot.pdf/positions")
    assert positions.status_code == 200, positions.text
    article = client.get("/api/price-comparison/articles/6047611")
    assert article.status_code == 200, article.text
    assert article.json()["rows"][0]["Preis"] == pytest.approx(12.34)
    assert article.json()["statistics"]["minimum"] == pytest.approx(12.34)
    assert article.json()["statistics"]["maximum"] == pytest.approx(12.34)
    assert article.json()["statistics"]["median"] == pytest.approx(12.34)
    assert "median_24m" in article.json()["statistics"]
    downloaded = client.get("/api/price-comparison/files/offers/Angebot.pdf/download")
    assert downloaded.content == original
    assert "attachment" in downloaded.headers["content-disposition"]
    assert snapshot(service.store).state["manual_prices"] == {}


def test_offer_overview_filters_counts_sorts_before_pagination_without_mutation(
    context,
    monkeypatch,
):
    client, service, _ = context

    def offer(source, price_change, date, *, project="Alpha", offer_type="Erstangebot"):
        return {
            "source": source,
            "project": project,
            "offer_number": source,
            "date": date,
            "offer_type": offer_type,
            "discount": 0,
            "align_netto": False,
            "position_count": 1,
            "total_net": 100.0,
            "price_change": price_change,
            "price_change_positions": price_change,
            "original_available": True,
        }

    cached_offers = [
        offer("alpha-negative-old", -5.0, "2026-01-01"),
        offer("alpha-positive-new", 8.0, "2026-05-01"),
        offer("alpha-zero", 0.0, "2026-04-01"),
        offer("alpha-none", None, "2026-03-01"),
        offer("alpha-negative-new", -2.0, "2026-02-01"),
        offer("alpha-positive-tie-b", 3.0, "2026-02-15"),
        offer("alpha-positive-tie-a", 3.0, "2026-02-15"),
        offer(
            "beta-infinity", float("inf"), "2026-06-03", project="Beta", offer_type="Folgeangebot"
        ),
        offer(
            "beta-negative-infinity",
            float("-inf"),
            "2026-06-02",
            project="Beta",
            offer_type="Folgeangebot",
        ),
        offer("beta-nan", float("nan"), "2026-06-01", project="Beta", offer_type="Folgeangebot"),
    ]
    data = SimpleNamespace(
        snap=SimpleNamespace(revision="r" * 64),
        warnings=["keine Neuberechnung"],
    )
    calls = []
    monkeypatch.setattr(service, "load", lambda: data)

    def offers_list(received):
        calls.append(received)
        return cached_offers

    monkeypatch.setattr(service, "offers_list", offers_list)
    original_order = [item["source"] for item in cached_offers]

    base_params = {"search": "alpha", "offer_type": "Erstangebot", "limit": 20}
    by_date = client.get("/api/price-comparison/offers", params=base_params)
    assert by_date.status_code == 200, by_date.text
    assert [item["source"] for item in by_date.json()["offers"]] == [
        "alpha-positive-new",
        "alpha-zero",
        "alpha-none",
        "alpha-positive-tie-a",
        "alpha-positive-tie-b",
        "alpha-negative-new",
        "alpha-negative-old",
    ]
    assert by_date.json()["price_level_counts"] == {
        "all": 7,
        "below": 2,
        "above": 3,
        "none": 1,
    }

    second_below = client.get(
        "/api/price-comparison/offers",
        params={
            **base_params,
            "price_level": "below",
            "sort": "price_asc",
            "offset": 1,
            "limit": 1,
        },
    )
    assert second_below.status_code == 200, second_below.text
    assert second_below.json()["total"] == 2
    assert second_below.json()["offers"][0]["source"] == "alpha-negative-new"
    assert second_below.json()["price_level_counts"] == by_date.json()["price_level_counts"]

    price_ascending = client.get(
        "/api/price-comparison/offers",
        params={**base_params, "sort": "price_asc"},
    ).json()
    assert [item["source"] for item in price_ascending["offers"]] == [
        "alpha-negative-old",
        "alpha-negative-new",
        "alpha-zero",
        "alpha-positive-tie-a",
        "alpha-positive-tie-b",
        "alpha-positive-new",
        "alpha-none",
    ]
    price_descending = client.get(
        "/api/price-comparison/offers",
        params={**base_params, "sort": "price_desc"},
    ).json()
    assert [item["source"] for item in price_descending["offers"]] == [
        "alpha-positive-new",
        "alpha-positive-tie-a",
        "alpha-positive-tie-b",
        "alpha-zero",
        "alpha-negative-new",
        "alpha-negative-old",
        "alpha-none",
    ]

    nonfinite = client.get(
        "/api/price-comparison/offers",
        params={
            "search": "beta",
            "offer_type": "Folgeangebot",
            "price_level": "none",
            "sort": "date",
        },
    )
    assert nonfinite.status_code == 200, nonfinite.text
    assert nonfinite.json()["price_level_counts"] == {
        "all": 3,
        "below": 0,
        "above": 0,
        "none": 3,
    }
    assert [item["price_change"] for item in nonfinite.json()["offers"]] == [None] * 3
    assert [item["price_change_positions"] for item in nonfinite.json()["offers"]] == [None] * 3

    assert calls == [data] * 5
    assert [item["source"] for item in cached_offers] == original_order
    assert math.isinf(cached_offers[-3]["price_change"])
    assert math.isinf(cached_offers[-2]["price_change"])
    assert math.isnan(cached_offers[-1]["price_change"])


@pytest.mark.parametrize(
    "params",
    [
        {"price_level": "cheap"},
        {"sort": "project"},
    ],
)
def test_offer_overview_rejects_unknown_literal_parameters(context, params):
    client, _, _ = context
    response = client.get("/api/price-comparison/offers", params=params)
    assert response.status_code == 422


def test_exact_online_import_preserves_frames_virtual_source_and_file_visibility(context):
    client, service, _ = context
    seed(client)
    service.store.write("offers", "Extra.pdf", offer_pdf(number="EXTRA-1", price="99,00"), None)
    install_online_import(service)

    status = client.get("/api/price-comparison/status").json()
    assert status["offer_count"] == 2
    files = client.get("/api/price-comparison/files").json()["files"]
    by_name = {item["name"]: item for item in files}
    assert by_name["Angebot.pdf"]["included_in_comparison"] is True
    assert by_name["Extra.pdf"]["included_in_comparison"] is False
    assert by_name["Virtual.pdf"] == {
        "kind": "offers",
        "name": "Virtual.pdf",
        "size": 0,
        "modified": "",
        "active": False,
        "original_available": False,
        "included_in_comparison": True,
    }

    offers = client.get("/api/price-comparison/offers").json()
    assert [offer["source"] for offer in offers["offers"]] == [
        "Angebot.pdf",
        "Virtual.pdf",
    ]
    assert [offer["original_available"] for offer in offers["offers"]] == [True, False]
    assert all(offer["total_net"] == pytest.approx(1234.0) for offer in offers["offers"])
    datanorm = client.get("/api/price-comparison/datanorm").json()
    assert datanorm["rows"][0]["Artikelcluster"] == "Legacy-Cluster"
    assert datanorm["unavailable_sources"] == ["Virtual.pdf"]

    missing = client.get("/api/price-comparison/files/offers/Virtual.pdf/download")
    assert missing.status_code == 422
    assert "nicht mehr vorhanden" in missing.json()["detail"]


def test_virtual_offer_can_be_edited_exported_and_explicitly_deleted(context):
    client, service, _ = context
    seed(client)
    service.store.write("offers", "Extra.pdf", offer_pdf(number="EXTRA-1"), None)
    install_online_import(service)
    before = snapshot(service.store)

    changed = client.patch(
        "/api/price-comparison/offers/Virtual.pdf",
        json={
            "expected_revision": before.revision,
            "manual_prices": {"6047611": 6.5},
            "discount": 5,
        },
    )
    assert changed.status_code == 200, changed.text
    detail = client.get("/api/price-comparison/offers/Virtual.pdf/positions").json()
    assert detail["offer"]["original_available"] is False
    assert detail["rows"][0]["Preis"] == pytest.approx(6.5)
    exported = client.post(
        "/api/price-comparison/exports",
        json={"kind": "offer", "source": "Virtual.pdf"},
    )
    assert exported.status_code == 200, exported.text

    current = snapshot(service.store)
    deleted = client.delete(
        "/api/price-comparison/files/offers/Virtual.pdf",
        params={"expected_revision": current.revision},
    )
    assert deleted.status_code == 200, deleted.text
    assert "Virtual.pdf" not in {
        offer["source"] for offer in client.get("/api/price-comparison/offers").json()["offers"]
    }
    state = snapshot(service.store).state
    assert state["online_import"]["virtual_sources"] == []
    assert "Virtual.pdf" not in state["discounts"]


def test_changed_excluded_file_becomes_live_instead_of_staying_hidden(context):
    client, service, _ = context
    seed(client)
    excluded = service.store.write(
        "offers", "Extra.pdf", offer_pdf(number="EXTRA-1", price="99,00"), None
    )
    install_online_import(service)
    assert "Extra.pdf" not in {
        offer["source"] for offer in client.get("/api/price-comparison/offers").json()["offers"]
    }

    service.store.write(
        "offers",
        "Extra.pdf",
        offer_pdf(number="EXTRA-2", price="88,00"),
        excluded,
    )
    offers = client.get("/api/price-comparison/offers").json()["offers"]
    extra = next(offer for offer in offers if offer["source"] == "Extra.pdf")
    assert extra["offer_number"] == "EXTRA-2"
    file_entry = next(
        item
        for item in client.get("/api/price-comparison/files").json()["files"]
        if item["name"] == "Extra.pdf"
    )
    assert file_entry["included_in_comparison"] is True


def test_rebuild_reparses_physical_offers_but_retains_virtual_import(context):
    client, service, _ = context
    seed(client)
    service.store.write("offers", "Extra.pdf", offer_pdf(number="EXTRA-1", price="99,00"), None)
    install_online_import(service)
    before = snapshot(service.store)
    before.state["deleted_articles"] = {"Angebot.pdf": ["6047611"]}
    save_state(service.store, before)
    revision = snapshot(service.store).revision

    rebuilt = service.rebuild(revision, [])
    assert rebuilt["removed_count"] == 0
    state = snapshot(service.store).state
    assert state["online_import"]["physical_frames_active"] is False
    assert state["online_import"]["virtual_sources"] == ["Virtual.pdf"]
    assert state["deleted_articles"] == {}
    offers = client.get("/api/price-comparison/offers").json()["offers"]
    assert {offer["source"] for offer in offers} == {
        "Angebot.pdf",
        "Extra.pdf",
        "Virtual.pdf",
    }
    positions = client.get("/api/price-comparison/offers/Angebot.pdf/positions").json()
    assert positions["rows"][0]["Preis"] == pytest.approx(12.34)


def test_reparse_datanorm_disables_only_legacy_datanorm_frame(context):
    client, service, _ = context
    seed(client)
    service.store.write("offers", "Extra.pdf", offer_pdf(number="EXTRA-1"), None)
    install_online_import(service)
    revision = snapshot(service.store).revision

    reparsed = client.post(
        "/api/price-comparison/maintenance",
        json={"action": "reparse_datanorm", "expected_revision": revision},
    )
    assert reparsed.status_code == 200, reparsed.text
    state = snapshot(service.store).state
    assert state["online_import"]["datanorm_frame_active"] is False
    assert state["online_import"]["physical_frames_active"] is True
    row = client.get("/api/price-comparison/datanorm").json()["rows"][0]
    assert row["Artikelcluster"] != "Legacy-Cluster"


@pytest.mark.parametrize(
    ("upload_name", "stored_name"),
    [
        ("Virtual.pdf", "Virtual.pdf"),
        ("virtual.PDF", "Virtual.pdf"),
        ("Replacement.pdf", "Replacement.pdf"),
    ],
)
def test_upload_replaces_virtual_offer_only_after_confirmation_and_never_resurrects_it(
    context,
    upload_name,
    stored_name,
):
    client, service, _ = context
    seed(client)
    service.store.write("offers", "Extra.pdf", offer_pdf(number="EXTRA-1"), None)
    install_online_import(service)
    revision = snapshot(service.store).revision
    replacement = offer_pdf(number="VIRTUAL-1", price="8,00")

    preview = client.post(
        "/api/price-comparison/files",
        data={"kind": "offers", "expected_revision": revision},
        files=[("files", (upload_name, replacement))],
    )
    assert preview.status_code == 409, preview.text
    assert preview.json()["detail"]["duplicates"] == [
        {
            "offer_number": "VIRTUAL-1",
            "keep": stored_name,
            "remove": "Virtual.pdf",
        }
    ]

    confirmed = client.post(
        "/api/price-comparison/files",
        data={
            "kind": "offers",
            "expected_revision": revision,
            "confirmed_duplicates": '["Virtual.pdf"]',
        },
        files=[("files", (upload_name, replacement))],
    )
    assert confirmed.status_code == 200, confirmed.text
    state = snapshot(service.store).state
    assert state["online_import"]["virtual_sources"] == []
    replacement_offer = next(
        offer
        for offer in client.get("/api/price-comparison/offers").json()["offers"]
        if offer["source"] == stored_name
    )
    assert replacement_offer["original_available"] is True

    current = snapshot(service.store)
    deleted = client.delete(
        f"/api/price-comparison/files/offers/{stored_name}",
        params={"expected_revision": current.revision},
    )
    assert deleted.status_code == 200, deleted.text
    assert "Virtual.pdf" not in {
        offer["source"]
        for offer in client.get("/api/price-comparison/offers").json()["offers"]
    }


def test_exact_import_upload_does_not_parse_bound_snapshot_sources(context, monkeypatch):
    client, service, _ = context
    seed(client)
    service.store.write("offers", "Extra.pdf", offer_pdf(number="EXTRA-1"), None)
    install_online_import(service)
    parsed_names = []
    original_parsed = service.parsed

    def counted(item, **kwargs):
        parsed_names.append(item.name)
        return original_parsed(item, **kwargs)

    monkeypatch.setattr(service, "parsed", counted)
    result = upload(client, "Added.pdf", offer_pdf(number="ADDED-1"), "offers")

    assert result.status_code == 200, result.text
    assert "Angebot.pdf" not in parsed_names
    assert "Virtual.pdf" not in parsed_names
    assert "Extra.pdf" in parsed_names
    assert set(parsed_names) <= {"Added.pdf", "Extra.pdf"}


def test_failed_imported_offer_replacement_rebinds_restored_file_version(
    context,
    monkeypatch,
):
    _, service, _ = context
    original = seed(context[0])
    service.store.write("offers", "Extra.pdf", offer_pdf(number="EXTRA-1"), None)
    install_online_import(service)
    before = snapshot(service.store)
    old_version = before.find("offers", "Angebot.pdf").version
    original_write = service.store.write
    failed = False

    def fail_first_state_write(kind, name, raw, previous):
        nonlocal failed
        if kind == "cache" and name == STATE_NAME and not failed:
            failed = True
            raise RuntimeError("injected state failure")
        return original_write(kind, name, raw, previous)

    monkeypatch.setattr(service.store, "write", fail_first_state_write)
    with pytest.raises(RuntimeError, match="injected state failure"):
        service.upload(
            "offers",
            [("Angebot.pdf", offer_pdf(number="TEST-1", price="99,00"))],
            before.revision,
            confirmed_duplicates=["Angebot.pdf"],
        )

    restored = snapshot(service.store)
    restored_item = restored.find("offers", "Angebot.pdf")
    assert restored_item.version != old_version
    assert service.store.read(restored_item) == original
    assert (
        restored.state["online_import"]["offer_bindings"]["Angebot.pdf"]["version"]
        == restored_item.version
    )
    positions = service.positions("Angebot.pdf")
    assert positions["rows"][0]["Preis"] == pytest.approx(7.25)


def test_imported_offer_rollback_failure_is_reported_fail_closed(context, monkeypatch):
    client, service, _ = context
    seed(client)
    service.store.write("offers", "Extra.pdf", offer_pdf(number="EXTRA-1"), None)
    install_online_import(service)
    before = snapshot(service.store)
    original_write = service.store.write

    def fail_state_writes(kind, name, raw, previous):
        if kind == "cache" and name == STATE_NAME:
            raise RuntimeError("persistent state failure")
        return original_write(kind, name, raw, previous)

    monkeypatch.setattr(service.store, "write", fail_state_writes)
    with pytest.raises(RuntimeError, match="manuell prüfen"):
        service.upload(
            "offers",
            [("Angebot.pdf", offer_pdf(number="TEST-1", price="99,00"))],
            before.revision,
            confirmed_duplicates=["Angebot.pdf"],
        )


def test_upload_rollback_never_overwrites_concurrent_calendar_state(context, monkeypatch):
    client, service, _ = context
    original = seed(client)
    service.store.write("offers", "Extra.pdf", offer_pdf(number="EXTRA-1"), None)
    install_online_import(service)
    before = snapshot(service.store)
    original_write = service.store.write
    injected = False

    def replace_state_then_fail(kind, name, raw, previous):
        nonlocal injected
        if kind == "cache" and name == STATE_NAME and not injected:
            injected = True
            foreign = json.loads(service.store.read(previous))
            foreign["discounts"]["FOREIGN.pdf"] = 12.5
            original_write(
                kind,
                name,
                json.dumps(foreign, ensure_ascii=False, allow_nan=False).encode(),
                previous,
            )
            raise RuntimeError("simulated concurrent state write")
        return original_write(kind, name, raw, previous)

    monkeypatch.setattr(service.store, "write", replace_state_then_fail)
    with pytest.raises(RuntimeError, match="anderweitig geändert"):
        service.upload(
            "offers",
            [("Angebot.pdf", offer_pdf(number="TEST-1", price="99,00"))],
            before.revision,
            confirmed_duplicates=["Angebot.pdf"],
        )

    current = snapshot(service.store)
    assert current.state["discounts"]["FOREIGN.pdf"] == 12.5
    assert service.store.read(current.find("offers", "Angebot.pdf")) == original


def test_failed_delete_rebinds_restored_imported_offer(context, monkeypatch):
    client, service, _ = context
    original = seed(client)
    service.store.write("offers", "Extra.pdf", offer_pdf(number="EXTRA-1"), None)
    install_online_import(service)
    before = snapshot(service.store)
    old_item = before.find("offers", "Angebot.pdf")
    original_write = service.store.write
    failed = False

    def fail_first_state_write(kind, name, raw, previous):
        nonlocal failed
        if kind == "cache" and name == STATE_NAME and not failed:
            failed = True
            raise RuntimeError("injected delete state failure")
        return original_write(kind, name, raw, previous)

    monkeypatch.setattr(service.store, "write", fail_first_state_write)
    with pytest.raises(RuntimeError, match="injected delete state failure"):
        service.delete_file("offers", "Angebot.pdf", before.revision)

    current = snapshot(service.store)
    restored = current.find("offers", "Angebot.pdf")
    assert restored.version != old_item.version
    assert service.store.read(restored) == original
    assert (
        current.state["online_import"]["offer_bindings"]["Angebot.pdf"]["version"]
        == restored.version
    )
    assert service.positions("Angebot.pdf")["rows"][0]["Preis"] == pytest.approx(7.25)


def test_failed_rebuild_rebinds_restored_imported_duplicate(context, monkeypatch):
    client, service, _ = context
    seed(client)
    service.store.write("offers", "Extra.pdf", offer_pdf(number="EXTRA-1"), None)
    install_online_import(service)
    service.store.write("offers", "Newer.pdf", offer_pdf(number="TEST-1", price="99,00"), None)
    before = snapshot(service.store)
    old_item = before.find("offers", "Angebot.pdf")
    preview = service.rebuild_preview(before.revision)
    assert preview["duplicates"] == [
        {"offer_number": "TEST-1", "keep": "Newer.pdf", "remove": "Angebot.pdf"}
    ]
    original_write = service.store.write
    failed = False

    def fail_first_state_write(kind, name, raw, previous):
        nonlocal failed
        if kind == "cache" and name == STATE_NAME and not failed:
            failed = True
            raise RuntimeError("injected rebuild state failure")
        return original_write(kind, name, raw, previous)

    monkeypatch.setattr(service.store, "write", fail_first_state_write)
    with pytest.raises(RuntimeError, match="injected rebuild state failure"):
        service.rebuild(before.revision, ["Angebot.pdf"])

    current = snapshot(service.store)
    restored = current.find("offers", "Angebot.pdf")
    assert restored.version != old_item.version
    assert current.state["online_import"]["physical_frames_active"] is True
    assert (
        current.state["online_import"]["offer_bindings"]["Angebot.pdf"]["version"]
        == restored.version
    )
    assert service.positions("Angebot.pdf")["rows"][0]["Preis"] == pytest.approx(7.25)


def test_upload_physical_restore_failure_is_reported_fail_closed(context, monkeypatch):
    client, service, _ = context
    seed(client)
    service.store.write("offers", "Extra.pdf", offer_pdf(number="EXTRA-1"), None)
    install_online_import(service)
    before = snapshot(service.store)
    original_write = service.store.write
    offer_writes = 0

    def fail_restore(kind, name, raw, previous):
        nonlocal offer_writes
        if kind == "offers" and name == "Angebot.pdf":
            offer_writes += 1
            if offer_writes == 2:
                raise RuntimeError("injected physical restore failure")
        if kind == "cache" and name == STATE_NAME:
            raise RuntimeError("injected state failure")
        return original_write(kind, name, raw, previous)

    monkeypatch.setattr(service.store, "write", fail_restore)
    with pytest.raises(RuntimeError, match="Upload konnte nicht sicher"):
        service.upload(
            "offers",
            [("Angebot.pdf", offer_pdf(number="TEST-1", price="99,00"))],
            before.revision,
            confirmed_duplicates=["Angebot.pdf"],
        )


def test_new_upload_rollback_restores_state_after_persisted_write_loses_response(
    context,
    monkeypatch,
):
    client, service, _ = context
    seed(client)
    service.store.write("offers", "Extra.pdf", offer_pdf(number="EXTRA-1"), None)
    install_online_import(service)
    before = snapshot(service.store)
    original_state = deepcopy(before.state)
    original_write = service.store.write
    failed = False

    def persist_state_then_fail(kind, name, raw, previous):
        nonlocal failed
        result = original_write(kind, name, raw, previous)
        if kind == "cache" and name == STATE_NAME and not failed:
            failed = True
            raise RuntimeError("simulated lost state-write response")
        return result

    monkeypatch.setattr(service.store, "write", persist_state_then_fail)
    with pytest.raises(RuntimeError, match="lost state-write response"):
        service.upload(
            "offers",
            [("Added.pdf", offer_pdf(number="ADDED-1"))],
            before.revision,
            confirmed_duplicates=[],
        )

    current = snapshot(service.store)
    assert "Added.pdf" not in {
        item.name for item in current.files if item.kind == "offers"
    }
    assert current.state == original_state


def test_datanorm_export_uses_original_tab1_schema_and_filename(context):
    client, _, _ = context
    seed(client)

    response = client.post("/api/price-comparison/exports", json={"kind": "datanorm"})

    assert response.status_code == 200, response.text
    assert "baupreis_tab1_datanorm_vs_angebote.xlsx" in response.headers["content-disposition"]
    workbook = load_workbook(io.BytesIO(response.content), data_only=True)
    sheet = workbook["Datanorm"]
    assert [sheet.cell(1, column).value for column in range(1, 11)] == [
        "Artikelnummer",
        "Bezeichnung",
        "Einheit",
        "Preis-Typ",
        "Nettopreis",
        "Angebotspreis 1",
        "Angebotspreis 2",
        "Angebotspreis 3",
        "Angebotspreis 4",
        "Angebotspreis 5",
    ]


def test_legacy_missing_offer_metrics_are_calculated_without_shared_write(context, monkeypatch):
    client, service, _ = context
    seed(client)
    legacy = snapshot(service.store)
    legacy.state["frozen_metrics"] = {}
    save_state(service.store, legacy)
    before = snapshot(service.store)
    calls = []

    def calculated_metrics(_prices, window_days=365, sources=None):
        calls.append(sources)
        return pd.DataFrame(
            [
                {
                    "Quelle": "Angebot.pdf",
                    "PV_avg_pct_pos": 4.5,
                    "PV_avg_pct_wert": 6.25,
                }
            ]
        )

    monkeypatch.setattr(core, "offer_percent_metrics", calculated_metrics)
    response = client.get("/api/price-comparison/offers")

    assert response.status_code == 200, response.text
    assert calls == [["Angebot.pdf"]]
    assert response.json()["offers"][0]["price_change"] == 6.25
    after = snapshot(service.store)
    assert after.revision == before.revision
    assert after.state["frozen_metrics"] == {}

    # Explicitly persisted NA is a completed calculation, not missing legacy
    # metadata, and therefore must not trigger the fallback again.
    after.state["frozen_metrics"] = {
        "Angebot.pdf": {
            "Quelle": "Angebot.pdf",
            "PV_avg_pct_pos": None,
            "PV_avg_pct_wert": None,
        }
    }
    save_state(service.store, after)
    calls.clear()
    explicit_na = client.get("/api/price-comparison/offers")
    assert explicit_na.status_code == 200, explicit_na.text
    assert calls == []
    assert explicit_na.json()["offers"][0]["price_change"] is None


@pytest.mark.parametrize(
    "patch",
    [
        {"discount": 10},
        {"align_netto": True},
        {"manual_prices": {"6047611": 7.5}},
        {"reset_manual_prices": True},
    ],
)
def test_price_affecting_offer_updates_refresh_only_edited_source(context, monkeypatch, patch):
    client, service, _ = context
    seed(client)
    calls = []

    def calculated_metrics(_prices, window_days=365, sources=None):
        calls.append(sources)
        return pd.DataFrame(
            [
                {
                    "Quelle": "Angebot.pdf",
                    "PV_avg_pct_pos": 2.0,
                    "PV_avg_pct_wert": 3.0,
                }
            ]
        )

    monkeypatch.setattr(core, "offer_percent_metrics", calculated_metrics)
    revision = snapshot(service.store).revision
    response = client.patch(
        "/api/price-comparison/offers/Angebot.pdf",
        json={"expected_revision": revision, **patch},
    )

    assert response.status_code == 200, response.text
    assert calls == [["Angebot.pdf"]]
    assert snapshot(service.store).state["frozen_metrics"]["Angebot.pdf"]["PV_avg_pct_wert"] == 3.0


def test_offer_type_change_and_upload_refresh_all_offer_metrics(context, monkeypatch):
    client, service, _ = context
    seed(client)
    calls = []

    def calculated_metrics(prices, window_days=365, sources=None):
        calls.append(sources)
        names = prices["Quelle"].dropna().astype(str).unique().tolist()
        return pd.DataFrame(
            [
                {
                    "Quelle": name,
                    "PV_avg_pct_pos": 1.0,
                    "PV_avg_pct_wert": 1.5,
                }
                for name in names
            ]
        )

    monkeypatch.setattr(core, "offer_percent_metrics", calculated_metrics)
    revision = snapshot(service.store).revision
    changed_type = client.patch(
        "/api/price-comparison/offers/Angebot.pdf",
        json={"expected_revision": revision, "offer_type": "Folgeangebot"},
    )
    assert changed_type.status_code == 200, changed_type.text
    assert calls == [None]

    calls.clear()
    added = upload(client, "Angebot-2.pdf", offer_pdf(number="TEST-2"), "offers")
    assert added.status_code == 200, added.text
    assert calls == [None]
    assert set(snapshot(service.store).state["frozen_metrics"]) == {
        "Angebot.pdf",
        "Angebot-2.pdf",
    }


def test_manual_prices_roundtrip_and_stale_revision_conflict(context):
    client, service, _ = context
    seed(client)
    revision = snapshot(service.store).revision
    response = client.patch(
        "/api/price-comparison/offers/Angebot.pdf",
        json={"expected_revision": revision, "manual_prices": {"6047611": 7.5}},
    )
    assert response.status_code == 200, response.text
    assert response.json()["revision"] != revision
    stale = client.patch(
        "/api/price-comparison/offers/Angebot.pdf",
        json={"expected_revision": revision, "discount": 90},
    )
    assert stale.status_code == 409
    result = client.get("/api/price-comparison/articles/6047611").json()
    assert result["rows"][0]["Preis"] == 7.5
    current = snapshot(service.store)
    assert current.state["discounts"] == {}
    cleared = client.patch(
        "/api/price-comparison/offers/Angebot.pdf",
        json={"expected_revision": current.revision, "manual_prices": {"6047611": None}},
    )
    assert cleared.status_code == 200, cleared.text
    assert snapshot(service.store).state["manual_prices"] == {}


def test_failed_batch_has_no_partial_files(context):
    client, service, _ = context
    revision = snapshot(service.store).revision
    result = client.post(
        "/api/price-comparison/files",
        data={"kind": "offers", "expected_revision": revision},
        files=[("files", ("valid.pdf", offer_pdf())), ("files", ("broken.pdf", b"not a PDF"))],
    )
    assert result.status_code == 422
    assert snapshot(service.store).files == []


def test_empty_existing_offer_is_cached_as_warning_and_does_not_block_upload(
    context,
    monkeypatch,
):
    client, service, _ = context
    empty_source = empty_offer_pdf()
    item = service.store.write("offers", "empty.pdf", empty_source, None)
    original_extract = core.extract_prices_from_pdf
    empty_parse_calls = 0

    def counted_extract(raw, *, source_name=None, cache_sig=None):
        nonlocal empty_parse_calls
        if source_name == "empty.pdf":
            empty_parse_calls += 1
        return original_extract(raw, source_name=source_name, cache_sig=cache_sig)

    monkeypatch.setattr(core, "extract_prices_from_pdf", counted_extract)
    for _ in range(2):
        with pytest.raises(HTTPException) as error:
            service.parsed(item)
        assert error.value.status_code == 422
    assert empty_parse_calls == 1

    revision = snapshot(service.store).revision
    response = client.post(
        "/api/price-comparison/files",
        data={"kind": "offers", "expected_revision": revision},
        files=[("files", ("valid.pdf", offer_pdf(number="TEST-2")))],
    )
    assert response.status_code == 200, response.text
    assert empty_parse_calls == 1
    assert service.store.read(snapshot(service.store).find("offers", "empty.pdf")) == empty_source


def test_same_filename_with_different_case_uses_confirmed_canonical_target(context):
    client, service, _ = context
    original = seed(client)
    revision = snapshot(service.store).revision
    replacement = offer_pdf(price="10,00")

    preview = client.post(
        "/api/price-comparison/files",
        data={"kind": "offers", "expected_revision": revision},
        files=[("files", ("angebot.pdf", replacement))],
    )
    assert preview.status_code == 409, preview.text
    assert preview.json()["detail"]["duplicates"] == [
        {
            "offer_number": "TEST-1",
            "keep": "Angebot.pdf",
            "remove": "Angebot.pdf",
        }
    ]

    confirmed = client.post(
        "/api/price-comparison/files",
        data={
            "kind": "offers",
            "expected_revision": revision,
            "confirmed_duplicates": '["Angebot.pdf"]',
        },
        files=[("files", ("angebot.pdf", replacement))],
    )
    assert confirmed.status_code == 200, confirmed.text
    current = snapshot(service.store)
    assert [item.name for item in current.files if item.kind == "offers"] == ["Angebot.pdf"]
    assert service.store.read(current.find("offers", "Angebot.pdf")) == replacement
    assert replacement != original


def test_upload_rolls_back_replacements_and_duplicate_removal_when_state_save_fails(
    context,
    monkeypatch,
):
    client, service, _ = context
    original = seed(client)
    before = snapshot(service.store)
    original_write = service.store.write

    def failing_write(kind, name, raw, previous):
        if kind == "cache" and name == STATE_NAME:
            raise RuntimeError("injected state failure")
        return original_write(kind, name, raw, previous)

    monkeypatch.setattr(service.store, "write", failing_write)
    with pytest.raises(RuntimeError, match="injected state failure"):
        service.upload(
            "offers",
            [("replacement.pdf", offer_pdf(price="10,00"))],
            before.revision,
            confirmed_duplicates=["Angebot.pdf"],
        )

    after = snapshot(service.store)
    # Restoring the bytes creates a new storage version/inode.  The changed
    # revision correctly keeps clients holding the failed mutation's old
    # snapshot from writing through stale state.
    assert after.revision != before.revision
    assert [item.name for item in after.files if item.kind == "offers"] == ["Angebot.pdf"]
    assert service.store.read(after.find("offers", "Angebot.pdf")) == original


def test_delete_rolls_back_source_when_state_save_fails(context, monkeypatch):
    client, service, _ = context
    original = seed(client)
    before = snapshot(service.store)
    original_write = service.store.write

    def failing_write(kind, name, raw, previous):
        if kind == "cache" and name == STATE_NAME:
            raise RuntimeError("injected state failure")
        return original_write(kind, name, raw, previous)

    monkeypatch.setattr(service.store, "write", failing_write)
    with pytest.raises(RuntimeError, match="injected state failure"):
        service.delete_file("offers", "Angebot.pdf", before.revision)

    after = snapshot(service.store)
    assert after.revision != before.revision
    assert service.store.read(after.find("offers", "Angebot.pdf")) == original


def test_parse_cache_fill_is_serialized_across_service_instances(tmp_path, monkeypatch):
    store = LocalPriceStorage(tmp_path / "files")
    cache_dir = tmp_path / "parse-cache"
    services = [
        PriceComparisonService(store, cache_dir=cache_dir),
        PriceComparisonService(store, cache_dir=cache_dir),
    ]
    raw = offer_pdf()
    item = StoredFile("offers", "same.pdf", len(raw), "", "same-version")
    extract_calls = 0
    call_lock = Lock()

    def slow_extract(_raw, *, source_name=None, cache_sig=None):
        nonlocal extract_calls
        with call_lock:
            extract_calls += 1
        sleep(0.05)
        return pd.DataFrame([{"Artikelnummer": "6047611", "Preis": 12.34, "Quelle": source_name}])

    monkeypatch.setattr(core, "extract_prices_from_pdf", slow_extract)
    with ThreadPoolExecutor(max_workers=2) as executor:
        frames = list(
            executor.map(
                lambda service: service.parsed(item, raw=raw),
                services,
            )
        )

    assert extract_calls == 1
    assert [frame.iloc[0]["Quelle"] for frame in frames] == ["same.pdf", "same.pdf"]


def test_initial_offer_load_uses_at_most_four_parallel_parsers(tmp_path, monkeypatch):
    service = PriceComparisonService(
        SimpleNamespace(identity="parallel-test"),
        cache_dir=tmp_path / "parse-cache",
    )
    items = [StoredFile("offers", f"{index}.pdf", 1, "", str(index)) for index in range(8)]
    snap = Snapshot(
        files=items,
        state={
            "active_datanorm": None,
            "deleted_articles": {},
            "discounts": {},
            "align_netto": {},
            "manual_prices": {},
            "offer_types": {},
        },
        state_file=None,
        revision="revision",
    )
    active = 0
    peak = 0
    active_lock = Lock()

    def slow_parsed(item, *, raw=None, force=False):
        nonlocal active, peak
        with active_lock:
            active += 1
            peak = max(peak, active)
        sleep(0.05)
        with active_lock:
            active -= 1
        return pd.DataFrame(
            [
                {
                    "Artikelnummer": str(item.version),
                    "Preis": float(item.version),
                    "Quelle": item.name,
                    "Datum": pd.Timestamp("2026-01-01") + pd.Timedelta(days=int(item.version)),
                }
            ]
        )

    monkeypatch.setattr(service, "parsed", slow_parsed)
    monkeypatch.setattr(core, "prepare_prices", lambda raw, *_args: raw)
    data = service.load(snap)

    assert peak == 4
    assert peak <= 4
    assert len(data.raw_prices) == 8


def test_non_import_load_preserves_snapshot_order_for_equal_dates(tmp_path, monkeypatch):
    service = PriceComparisonService(
        SimpleNamespace(identity="order-test"),
        cache_dir=tmp_path / "parse-cache",
    )
    items = [
        StoredFile("offers", name, 1, modified, name)
        for name, modified in (
            ("second.pdf", "2026-01-02"),
            ("first.pdf", "2026-01-01"),
        )
    ]
    snap = Snapshot(
        files=items,
        state={
            "active_datanorm": None,
            "deleted_articles": {},
            "discounts": {},
            "align_netto": {},
            "manual_prices": {},
            "offer_types": {},
        },
        state_file=None,
        revision="revision",
    )

    monkeypatch.setattr(
        service,
        "parsed",
        lambda item, **_kwargs: pd.DataFrame(
            [{"Quelle": item.name, "Artikelnummer": "1", "Datum": pd.Timestamp("2026-01-01")}]
        ),
    )
    monkeypatch.setattr(core, "prepare_prices", lambda raw, *_args: raw)

    data = service.load(snap)

    assert data.raw_prices["Quelle"].tolist() == ["second.pdf", "first.pdf"]


def test_duplicate_rebuild_requires_confirmed_fresh_file_list(context):
    client, service, user = context
    seed(client)
    # An externally added duplicate is visible to the explicit rebuild flow.
    service.store.write("offers", "newer.pdf", offer_pdf(), None)
    revision = snapshot(service.store).revision
    preview = client.post(
        "/api/price-comparison/maintenance/preview",
        json={"action": "rebuild_offers", "expected_revision": revision},
    )
    assert preview.status_code == 200, preview.text
    assert preview.json()["duplicates"] == [
        {"offer_number": "TEST-1", "keep": "newer.pdf", "remove": "Angebot.pdf"}
    ]
    blocked = client.post(
        "/api/price-comparison/maintenance",
        json={"action": "rebuild_offers", "expected_revision": revision},
    )
    assert blocked.status_code == 409
    assert len([f for f in snapshot(service.store).files if f.kind == "offers"]) == 2
    user.role = UserRole.PROJECT_MANAGER
    assert (
        client.post(
            "/api/price-comparison/maintenance",
            json={
                "action": "rebuild_offers",
                "expected_revision": revision,
                "confirmed_duplicates": ["Angebot.pdf"],
            },
        ).status_code
        == 403
    )
    user.role = UserRole.ADMIN
    response = client.post(
        "/api/price-comparison/maintenance",
        json={
            "action": "rebuild_offers",
            "expected_revision": revision,
            "confirmed_duplicates": ["Angebot.pdf"],
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["removed_count"] == 1
    assert [f.name for f in snapshot(service.store).files if f.kind == "offers"] == ["newer.pdf"]


def test_upload_duplicate_requires_confirmation_before_replacing_any_file(context):
    client, service, _ = context
    original = seed(client)
    revision = snapshot(service.store).revision
    response = upload(client, "updated.pdf", offer_pdf(price="10,00"), "offers")
    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "duplicate_offers"
    assert detail["duplicates"] == [
        {"offer_number": "TEST-1", "keep": "updated.pdf", "remove": "Angebot.pdf"}
    ]
    assert snapshot(service.store).revision == revision
    assert client.get("/api/price-comparison/files/offers/Angebot.pdf/download").content == original
    confirmed = client.post(
        "/api/price-comparison/files",
        data={
            "kind": "offers",
            "expected_revision": revision,
            "confirmed_duplicates": '["Angebot.pdf"]',
        },
        files=[("files", ("updated.pdf", offer_pdf(price="10,00")))],
    )
    assert confirmed.status_code == 200, confirmed.text
    assert [f.name for f in snapshot(service.store).files if f.kind == "offers"] == ["updated.pdf"]


def test_active_datanorm_deletion_does_not_silently_activate_old_file(context):
    client, service, _ = context
    seed(client)
    revision = snapshot(service.store).revision
    response = client.delete(
        "/api/price-comparison/files/datanorm/preise.dat", params={"expected_revision": revision}
    )
    assert response.status_code == 200, response.text
    assert snapshot(service.store).state["active_datanorm"] is None
    assert client.get("/api/price-comparison/offers").status_code == 200


def test_presets_use_original_weighted_reference_schema(context):
    client, service, _ = context
    revision = snapshot(service.store).revision
    response = client.put(
        "/api/price-comparison/reference-presets/Test",
        json={
            "expected_revision": revision,
            "references": [{"article_number": "6047611", "weight": 2.5}],
        },
    )
    assert response.status_code == 200, response.text
    assert snapshot(service.store).state["reference_presets"]["Test"] == [
        {"Artikelnummer": "6047611", "Gewichtung": 2.5}
    ]
    assert (
        client.get("/api/price-comparison/reference-presets").json()["presets"]["Test"][0]["weight"]
        == 2.5
    )
