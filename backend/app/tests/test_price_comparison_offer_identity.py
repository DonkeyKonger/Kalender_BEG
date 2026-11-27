from __future__ import annotations

import io
import hashlib
import json
from uuid import uuid4

import pandas as pd
import pytest
from reportlab.pdfgen import canvas

from app.services.price_comparison_pdf_parser import _detect_pdf_meta
from app.services.price_comparison_service import PriceComparisonService
from app.services.price_comparison_storage import snapshot
from app.tests.test_price_comparison_routes import context as route_context, upload
from app.tests.test_price_comparison_upload_queue import queue_db as upload_queue_db
from app.services.price_comparison_upload_queue import PriceComparisonUploadQueue

context = route_context
queue_db = upload_queue_db


def annual_offer_pdf(number: str) -> bytes:
    output = io.BytesIO()
    pdf = canvas.Canvas(output)
    for index, line in enumerate([
        "26.11.2026",
        f"Projekt-Name: Jahresangebot BEG 2027, Achim bei Bremen Angebot {number}",
        f"OBO Bettermann Angebot : {number}",
        "Jahresangebot BEG 2027, Achim",
        "Unser nachfolgendes Angebot bezieht sich auf die angefragten Produkte.",
        "6047611 RKSM 620 FS 100,00 Meter 12,34 1 EUR",
        "Gesamt netto 1.234,00 EUR",
    ]):
        pdf.drawString(35, 800 - index * 20, line)
    pdf.save()
    return output.getvalue()


@pytest.mark.parametrize("index", range(1, 11))
def test_annual_offer_name_cannot_override_complete_offer_number(index):
    number = f"47172428-{index:03}"
    text = (
        "26.11.2026\n"
        f"Projekt-Name: Jahresangebot BEG 2027, Achim bei Bremen Angebot {number}\n"
        f"OBO Bettermann Angebot : {number}\n"
    )
    date, actual, supplier, project = _detect_pdf_meta(text)
    assert actual == number
    assert date == pd.Timestamp("2026-11-26")
    assert supplier == "OBO Bettermann"
    assert project == "Jahresangebot BEG 2027, Achim bei Bremen"


@pytest.mark.parametrize(("text", "expected"), [
    ("Jahresangebot BEG 2027", None),
    ("Folgeangebot 47172428-001", None),
    ("Angebotssumme 1234", None),
    ("Unser Angebot bezieht sich auf Produkte.\nAngebot: TEST-1", "TEST-1"),
    ("Angebot BEG\nAngebot 47172428-010", "47172428-010"),
    ("Angebot: 47172428-001", "47172428-001"),
    ("Angebot - 47172428-010", "47172428-010"),
    ("ANGEBOT\n47172428-002", "47172428-002"),
    ("Angebot: AB/2027-001", "AB/2027-001"),
    ("Angebot: BEG", None),
])
def test_offer_number_requires_a_standalone_field_and_numeric_identifier(text, expected):
    assert _detect_pdf_meta(text)[1] == expected


@pytest.mark.parametrize(("values", "expected"), [
    (["BEG", "BEG"], None),
    (["Angebot", None], None),
    (["47172428-001", "47172428-002"], None),
    (["47172428-001", "BEG"], None),
    ([" 47172428-001 ", "47172428-001", None], "47172428-001"),
    (["AB/2027-001"], "AB/2027-001"),
    (["47172428 001"], None),
    ([], None),
])
def test_only_one_reliable_identifier_may_trigger_duplicate_replacement(values, expected):
    assert PriceComparisonService._offer_number(pd.DataFrame({"Angebot": values})) == expected
    assert PriceComparisonService._offer_number(pd.DataFrame()) is None


@pytest.mark.parametrize("one_batch", [False, True])
def test_ten_annual_offers_coexist_with_unchanged_files_and_distinct_numbers(context, one_batch):
    _, service, _ = context
    files = [(f"47172428-{index:03} - Jahresangebot.pdf", annual_offer_pdf(f"47172428-{index:03}"))
             for index in range(1, 11)]
    batches = [files] if one_batch else [[file] for file in files]
    for batch in batches:
        if one_batch:
            service.upload("offers", batch, snapshot(service.store).revision)
        else:
            service.upload_queued("offers", batch)
    current = snapshot(service.store)
    assert len([file for file in current.files if file.kind == "offers"]) == 10
    result = service.offers()
    assert result["total"] == 10
    assert {offer["offer_number"] for offer in result["offers"]} == {
        f"47172428-{index:03}" for index in range(1, 11)
    }
    for name, raw in files:
        assert service.store.read(current.find("offers", name)) == raw
    assert service.rebuild_preview(current.revision)["duplicates"] == []


def test_same_complete_number_still_requires_confirmation_even_with_another_filename(context):
    client, service, _ = context
    raw = annual_offer_pdf("47172428-001")
    assert upload(client, "original.pdf", raw, "offers").status_code == 200
    response = upload(client, "renamed.pdf", raw, "offers")
    assert response.status_code == 409
    assert response.json()["detail"]["duplicates"] == [{
        "offer_number": "47172428-001", "keep": "renamed.pdf", "remove": "original.pdf",
    }]
    assert service.store.read(snapshot(service.store).find("offers", "original.pdf")) == raw
    assert service.offers()["total"] == 1


def test_same_filename_still_requires_confirmation_without_reliable_number(context):
    client, _, _ = context
    raw = annual_offer_pdf("BEG")
    assert upload(client, "unknown.pdf", raw, "offers").status_code == 200
    response = upload(client, "unknown.pdf", raw, "offers")
    assert response.status_code == 409
    assert response.json()["detail"]["duplicates"][0]["remove"] == "unknown.pdf"


def test_legacy_word_metadata_never_schedules_source_deletion(context, monkeypatch):
    _, service, _ = context
    for name in ["one.pdf", "two.pdf"]:
        service.store.write("offers", name, annual_offer_pdf("BEG"), None)
    legacy = pd.DataFrame({"Angebot": ["BEG"], "Artikelnummer": ["6047611"]})
    monkeypatch.setattr(service, "parsed", lambda *args, **kwargs: legacy.copy())
    current = snapshot(service.store)
    assert service.rebuild_preview(current.revision)["duplicates"] == []
    assert set(service._existing_offer_numbers(current)) == {("one.pdf", None), ("two.pdf", None)}


def test_existing_bad_parse_cache_is_not_reused_after_identity_fix(context):
    _, service, _ = context
    item = service.store.write("offers", "annual.pdf", annual_offer_pdf("47172428-001"), None)
    old_key = hashlib.sha256(json.dumps([
        "4ed988f-validated-pdf-v3", service.store.identity, item.kind, item.name, item.version,
    ], ensure_ascii=False).encode()).hexdigest()
    service.cache_dir.mkdir(parents=True, exist_ok=True)
    pd.DataFrame({"Angebot": ["BEG"]}).to_pickle(service.cache_dir / (old_key + ".pkl"))
    assert service.parsed(item)["Angebot"].unique().tolist() == ["47172428-001"]


def test_ten_waiting_upload_jobs_finish_without_replacing_each_other(context, queue_db):
    _, service, _ = context
    factory, user_id = queue_db
    queue = PriceComparisonUploadQueue(factory, service_factory=lambda: service)
    jobs = []
    for index in range(1, 11):
        number = f"47172428-{index:03}"
        with factory() as db:
            job = queue.enqueue(
                db, user_id=user_id, kind="offers",
                uploads=[(number + ".pdf", annual_offer_pdf(number))],
                client_request_id=str(uuid4()), service=service,
            )
            jobs.append(job)
    for _ in jobs:
        assert queue.process_next("annual-offer-worker") is True
    assert queue.process_next("annual-offer-worker") is False
    with factory() as db:
        for job in jobs:
            assert db.get(type(job), job.id).status == "completed"
    assert service.offers()["total"] == 10
    assert len(service.store.list("offers")) == 10
