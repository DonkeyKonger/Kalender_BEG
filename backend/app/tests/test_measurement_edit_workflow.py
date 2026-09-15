from copy import deepcopy
from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from app.tests.test_measurement_service import db_session, create_site, create_measurement_base
from app.models.site_measurement_item import SiteMeasurementBatch, SiteMeasurementItem, SiteMeasurementEntry, SiteMeasurementAreaRow
from app.models.user import User
from app.models.enums import UserRole
from app.schemas.measurement import MeasurementItemUpdate, MeasurementEntryCreate, MobileMeasurementFreeItemCreate, CustomerSignatureCreate
from app.services.measurement_service import MeasurementService
from app.services.measurement_pdf_service import MeasurementPdfService


@pytest.fixture
def case(monkeypatch):
    db = db_session()
    site = create_site(db)
    base = create_measurement_base(db, site)
    user = User(username="edit-project-manager", display_name="Projektleitung", password_hash="x", role=UserRole.PROJECT_MANAGER)
    batch = SiteMeasurementBatch(site=site, measurement_base=base, number=1, title="Aufmaß 8007.01", status="submitted", origin="MONTEUR")
    other = SiteMeasurementBatch(site=site, measurement_base=base, number=2, title="Unverändert", status="submitted", origin="MONTEUR")
    item = SiteMeasurementItem(site=site, measurement_base=base, position="1.01.05.140", description="Kabelrinne liefern und montieren", unit="m", minutes_per_unit=Decimal("6"), sort_order=1)
    entry = SiteMeasurementEntry(site=site, measurement_batch=batch, measurement_item=item, quantity=Decimal("34"), area_or_comment="EG BTB", status="submitted")
    other_entry = SiteMeasurementEntry(site=site, measurement_batch=other, measurement_item=item, quantity=Decimal("12"), area_or_comment="1. OG", status="submitted")
    area = SiteMeasurementAreaRow(site_id=site.id, measurement_batch=batch, area_or_comment="EG BTB", sort_order=1)
    db.add_all([user, batch, other, item, entry, other_entry, area])
    db.commit()
    service = MeasurementService(db)
    monkeypatch.setattr(service, "_archive_billed_batch_pdf", lambda **kwargs: None)
    monkeypatch.setattr(service, "_get_user_assignment", lambda *args: SimpleNamespace(site_id=site.id))
    yield SimpleNamespace(db=db, site=site, base=base, user=user, batch=batch, other=other, item=item, entry=entry, service=service)
    db.close()


def sign(c):
    c.service.set_site_batch_reviewed(site_id=c.site.id, batch_id=c.batch.id)
    return c.service.sign_mobile_batch(assignment_id=1, batch_id=c.batch.id, current_user=c.user,
        payload=CustomerSignatureCreate(customer_name="Kunde", signature_strokes=[[{"x": 0.1, "y": 0.1}, {"x": 0.8, "y": 0.7}]]))


def edit(c, **payload):
    return c.service.update_site_free_item(site_id=c.site.id, batch_id=c.batch.id, measurement_item_id=c.item.id, payload=MeasurementItemUpdate(**payload))


def test_suggested_office_column_stays_right_after_first_and_subsequent_quantities(case):
    c = case
    c.item.sort_order = 50
    target = SiteMeasurementItem(site=c.site, measurement_base=c.base, position="0.1",
        description="Frühe Katalogposition", unit="m", sort_order=1, minutes_per_unit=Decimal("5"))
    c.db.add(target)
    c.db.commit()
    created = c.service.create_site_free_item(site_id=c.site.id, batch_id=c.batch.id, current_user=c.user,
        payload=MobileMeasurementFreeItemCreate(position=target.position, description=target.description,
            unit=target.unit, linked_measurement_item_id=target.id, quantity=Decimal("2"), area_or_comment="EG BTB"))
    assert created.id != target.id
    assert created.linked_measurement_item_id == target.id
    assert created.sort_order > c.item.sort_order
    c.service.create_site_entry(site_id=c.site.id, batch_id=c.batch.id, measurement_item_id=created.id,
        current_user=c.user, payload=MeasurementEntryCreate(quantity=Decimal("3"), area_or_comment="OG"))
    c.service.update_site_entry(site_id=c.site.id, batch_id=c.batch.id, entry_id=created.entries[0].id,
        payload=MeasurementEntryCreate(quantity=Decimal("4"), area_or_comment="EG BTB"))
    c.db.expire_all()
    rows = c.service.list_site_batch_items(site_id=c.site.id, batch_id=c.batch.id)
    assert [item.id for item in rows if item.entries] == [c.item.id, created.id]
    appended = next(item for item in rows if item.id == created.id)
    assert appended.reported_quantity == Decimal("7")
    assert next(item for item in rows if item.id == target.id).entries == []


@pytest.mark.parametrize("workflow", ["draft", "submitted", "reviewed", "customer_signed"])
@pytest.mark.parametrize("origin,mode", [("MONTEUR", "OFFER_BASED"), ("OFFICE", "OFFER_BASED"), ("MONTEUR", "BLANK"), ("OFFICE", "BLANK")])
def test_every_field_editable_before_completion_without_changing_other_batches(case, workflow, origin, mode):
    c = case
    c.batch.origin, c.batch.position_mode = origin, mode
    if mode == "BLANK":
        c.item.measurement_batch = c.batch
        c.item.is_free_position = True
        # The independent batch must still use a shared offer item, not this free item.
        c.other.entries.clear()
    c.db.commit()
    if workflow == "customer_signed":
        sign(c)
    else:
        c.batch.status = workflow
        c.db.commit()
    snapshot = deepcopy(c.batch.customer_signed_snapshot)
    result = edit(c, position="9.99", description="Korrigierte Kabelrinne", unit="St")
    assert (result.position, result.description, result.unit) == ("9.99", "Korrigierte Kabelrinne", "St")
    c.service.update_site_entry(site_id=c.site.id, batch_id=c.batch.id, entry_id=c.entry.id,
        payload=MeasurementEntryCreate(area_or_comment="EG BTB", quantity=Decimal("40.55")))
    c.service.rename_site_batch_area(site_id=c.site.id, batch_id=c.batch.id, previous="EG BTB", replacement="1. OG BTB")
    c.db.expire_all()
    reloaded = next(item for item in c.service.list_site_batch_items(site_id=c.site.id, batch_id=c.batch.id) if item.id == c.item.id)
    assert (reloaded.position, reloaded.description, reloaded.unit) == ("9.99", "Korrigierte Kabelrinne", "St")
    assert reloaded.entries[0].quantity == Decimal("40.55")
    assert reloaded.entries[0].area_or_comment == "1. OG BTB"
    assert c.batch.area_rows[0].area_or_comment == "1. OG BTB"
    assert c.batch.customer_signed_snapshot == snapshot
    if mode == "OFFER_BASED":
        untouched = next(item for item in c.service.list_site_batch_items(site_id=c.site.id, batch_id=c.other.id) if item.id == c.item.id)
        assert untouched.position == "1.01.05.140"
        assert untouched.description == "Kabelrinne liefern und montieren"
        assert untouched.unit == "m"
        assert untouched.entries[0].quantity == Decimal("12")


@pytest.mark.parametrize("workflow", ["billed", "approved", "closed", "completed", "finalized", "abgeschlossen", "archived"])
def test_completed_content_locked_through_every_office_write_route(case, workflow):
    c = case
    c.batch.status = workflow
    c.db.commit()
    actions = [
        lambda: edit(c, description="Verboten"),
        lambda: c.service.update_site_entry(site_id=c.site.id, batch_id=c.batch.id, entry_id=c.entry.id, payload=MeasurementEntryCreate(area_or_comment="UG", quantity=1)),
        lambda: c.service.create_site_entry(site_id=c.site.id, batch_id=c.batch.id, measurement_item_id=c.item.id, current_user=c.user, payload=MeasurementEntryCreate(area_or_comment="UG", quantity=1)),
        lambda: c.service.create_site_free_item(site_id=c.site.id, batch_id=c.batch.id, current_user=c.user, payload=MobileMeasurementFreeItemCreate(description="Verboten", unit="m")),
        lambda: c.service.delete_site_free_item(site_id=c.site.id, batch_id=c.batch.id, measurement_item_id=c.item.id),
        lambda: c.service.rename_site_batch_area(site_id=c.site.id, batch_id=c.batch.id, previous="EG BTB", replacement="UG"),
        lambda: c.service.reset_site_batch_to_submitted(site_id=c.site.id, batch_id=c.batch.id),
        lambda: c.service.upload_site_batch_photo(site_id=c.site.id, batch_id=c.batch.id, current_user=c.user, filename="x.jpg", content=b"x", content_type="image/jpeg"),
    ]
    for action in actions:
        with pytest.raises(HTTPException) as error:
            action()
        assert error.value.status_code == 409
        c.db.rollback()
    assert c.entry.quantity == Decimal("34")
    assert c.item.description == "Kabelrinne liefern und montieren"


def test_signed_edits_keep_real_original_for_pdf_only(case):
    c = case
    sign(c)
    signed = deepcopy(c.batch.customer_signed_snapshot)
    edit(c, position="9.99", description="Geänderte Kabelrinne", unit="St")
    c.service.update_site_entry(site_id=c.site.id, batch_id=c.batch.id, entry_id=c.entry.id,
        payload=MeasurementEntryCreate(area_or_comment="EG BTB", quantity=Decimal("40.55")))
    positions, areas, cells, totals = MeasurementPdfService(c.db)._build_matrix(c.batch, mode="checked")
    assert (positions[0].original_position, positions[0].original_description, positions[0].original_unit) == ("1.01.05.140", "Kabelrinne liefern und montieren", "m")
    assert cells[("eg btb", c.item.id)].is_corrected
    assert totals[c.item.id] == Decimal("40.55")
    read_model = c.service._build_mobile_batch(c.batch)
    assert read_model.has_signed_snapshot is True
    assert "customer_signed_snapshot" not in read_model.model_dump()
    c.service.rename_site_batch_area(site_id=c.site.id, batch_id=c.batch.id, previous="EG BTB", replacement="1. OG BTB")
    positions, areas, cells, totals = MeasurementPdfService(c.db)._build_matrix(c.batch, mode="checked")
    assert next(a for a in areas if a.label == "EG BTB").is_removed
    assert next(a for a in areas if a.label == "1. OG BTB").is_added
    assert cells[("eg btb", c.item.id)].is_removed
    assert cells[("1. og btb", c.item.id)].is_added
    assert c.batch.customer_signed_snapshot == signed
    original = c.service._build_measurement_snapshot(batch=c.batch, version_label="current", event_at=datetime.now(timezone.utc))
    assert original["entries"][0]["position"] == "9.99"


def test_rollback_from_completed_restores_editability_but_not_a_fake_signature(case):
    c = case
    c.service.set_site_batch_reviewed(site_id=c.site.id, batch_id=c.batch.id)
    c.service.set_site_batch_billing_status(site_id=c.site.id, batch_id=c.batch.id, billing_status="billed")
    with pytest.raises(HTTPException):
        edit(c, description="Gesperrt")
    c.service.rollback_site_batch_status(site_id=c.site.id, batch_id=c.batch.id, current_user=c.user, expected_revision=len(c.batch.status_history))
    assert c.batch.status == "reviewed" and c.batch.customer_signed_at is None
    assert edit(c, description="Wieder bearbeitbar").description == "Wieder bearbeitbar"


def test_corrected_catalog_position_uses_new_hours_consistently_and_only_in_this_batch(case):
    c = case
    target = SiteMeasurementItem(site=c.site, measurement_base=c.base, position="2.01",
        description="Andere Leistung", unit="m", minutes_per_unit=Decimal("12"), sort_order=2)
    c.db.add(target)
    c.db.commit()
    # Text/unit corrections do not discard the original calculation rate.
    assert edit(c, description="Eigener Kurztext", unit="St").reported_hours == Decimal("3.4")
    corrected = edit(c, position="2.01")
    assert corrected.reported_hours == Decimal("6.8")
    assert c.service._sum_reported_minutes(list(c.batch.entries)) == Decimal("408")
    untouched = c.service._build_mobile_item(c.item, c.other.id)
    assert untouched.reported_hours == Decimal("1.2")
    assert c.item.position == "1.01.05.140"
    # A custom position without a calculation must never retain the old rate.
    assert edit(c, position="9.99").reported_hours is None
    assert c.service._sum_reported_minutes(list(c.batch.entries)) is None


def test_legacy_signature_without_snapshot_is_never_overwritten(case):
    c = case
    c.batch.customer_signed_at = datetime.now(timezone.utc)
    c.db.commit()
    with pytest.raises(HTTPException) as error:
        edit(c, description="Nicht nachvollziehbar")
    assert error.value.status_code == 409
    assert c.item.description == "Kabelrinne liefern und montieren"


def test_rename_collision_and_foreign_item_leave_batch_unchanged(case):
    c = case
    c.service.create_site_entry(site_id=c.site.id, batch_id=c.batch.id, measurement_item_id=c.item.id, current_user=c.user, payload=MeasurementEntryCreate(area_or_comment="UG", quantity=2))
    with pytest.raises(HTTPException):
        c.service.rename_site_batch_area(site_id=c.site.id, batch_id=c.batch.id, previous="EG BTB", replacement="UG")
    assert c.entry.area_or_comment == "EG BTB"
    foreign = SiteMeasurementItem(site=create_site(c.db), position="1", description="Fremd", unit="m", sort_order=1)
    c.db.add(foreign)
    c.db.commit()
    with pytest.raises(HTTPException) as error:
        c.service.update_site_free_item(site_id=c.site.id, batch_id=c.batch.id, measurement_item_id=foreign.id, payload=MeasurementItemUpdate(description="Fremdänderung"))
    assert error.value.status_code == 404


def test_header_only_signed_position_survives_deletion_in_pdf_and_long_text_is_complete(case):
    from app.services.measurement_pdf_service import _build_logical_measurement_blocks, _header_correction_pages, MatrixPosition, SimplePdf
    from pypdf import PdfReader
    from io import BytesIO
    c = case
    c.batch.position_mode = "BLANK"
    c.item.measurement_batch, c.item.is_free_position = c.batch, True
    c.db.commit()
    extra = c.service.create_site_free_item(site_id=c.site.id, batch_id=c.batch.id, current_user=c.user,
        payload=MobileMeasurementFreeItemCreate(position="9.01", description="Leere unterschriebene Spalte", unit="m"))
    sign(c)
    c.service.delete_site_free_item(site_id=c.site.id, batch_id=c.batch.id, measurement_item_id=extra.id)
    c.db.expire_all()
    positions, areas, cells, _ = MeasurementPdfService(c.db)._build_matrix(c.batch, mode="checked")
    assert next(position for position in positions if position.item_id == extra.id).is_removed
    blocks = _build_logical_measurement_blocks(positions=positions, areas=areas, cells=cells)
    assert any(position.item_id == extra.id for block in blocks for position in block.positions)
    original = "Alter ausführlicher Beschreibungstext " * 80
    current = "Neuer ausführlicher Beschreibungstext " * 80
    pages = _header_correction_pages([MatrixPosition(item_id=1, position="9.99", description=current, unit="m", sort_order=1, original_description=original)])
    assert len(pages) > 1
    pdf = SimplePdf()
    for page in pages:
        pdf.add_page(page)
    text = " ".join(page.extract_text() for page in PdfReader(BytesIO(pdf.build())).pages)
    assert text.count("Alter") == 80 and text.count("Neuer") == 80


def test_overrides_migration_preserves_existing_data():
    import importlib.util
    from pathlib import Path
    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    from sqlalchemy import create_engine, text
    path = Path(__file__).parents[2] / "alembic" / "versions" / "20260914_0118_measurement_item_overrides.py"
    spec = importlib.util.spec_from_file_location("override_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with create_engine("sqlite://").begin() as connection:
        connection.execute(text("CREATE TABLE site_measurement_batches (id INTEGER PRIMARY KEY, status TEXT)"))
        connection.execute(text("INSERT INTO site_measurement_batches VALUES (1, 'customer_signed')"))
        with Operations.context(MigrationContext.configure(connection)):
            module.upgrade()
        assert tuple(connection.execute(text("SELECT status, item_overrides FROM site_measurement_batches")).one()) == ("customer_signed", "{}")
