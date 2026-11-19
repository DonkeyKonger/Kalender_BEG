from concurrent.futures import ThreadPoolExecutor
import io
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
    STATE_NAME,
    LocalPriceStorage,
    Snapshot,
    StoredFile,
    save_state,
    snapshot,
)


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


def test_anonymous_and_password_change_cannot_bypass_access(context):
    client, _, user = context
    user.must_change_password = True
    assert client.get("/api/price-comparison/status").status_code == 403
    client.app.dependency_overrides.pop(get_current_user)
    assert client.get("/api/price-comparison/status").status_code == 401


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
