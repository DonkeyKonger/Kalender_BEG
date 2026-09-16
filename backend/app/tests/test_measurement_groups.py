from datetime import datetime, timezone
from decimal import Decimal
from io import BytesIO

import pytest
from fastapi import HTTPException
from pypdf import PdfReader
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.models.enums import UserRole
from app.models.measurement_group import MeasurementGroup, MeasurementGroupMember
from app.models.site_measurement_item import SiteMeasurementAreaRow, SiteMeasurementBatch, SiteMeasurementBatchPhoto, SiteMeasurementEntry, SiteMeasurementItem
from app.models.user import User
from app.services.measurement_group_service import MeasurementGroupService, groups_for_overview
from app.services.measurement_service import MeasurementService
from app.tests.test_measurement_service import create_site, db_session


INK = [[{"x": .1, "y": .2}, {"x": .8, "y": .7}, {"x": .4, "y": .3}]]


def setup_group(db, count=2):
    site = create_site(db)
    site.site_number = "8007"
    user = User(username="group-office", display_name="Büro", password_hash="x", role=UserRole.OFFICE)
    batches = []
    for number in range(11, 11 + count):
        batch = SiteMeasurementBatch(site=site, number=number, title=f"Aufmaß {number}", status="billed",
            is_invoiced=number == 11, worker_signed_at=datetime(2026, 9, number, tzinfo=timezone.utc),
            worker_signature_name=f"Monteur {number}", worker_signature_strokes=INK,
            customer_signed_at=datetime(2026, 9, number, tzinfo=timezone.utc),
            customer_signature_name=f"Kunde {number}", customer_signature_strokes=INK,
            customer_signature_place="Bremen")
        item = SiteMeasurementItem(site=site, measurement_batch=batch, position="1.01.05.300",
            description="Kabelrinne 500 mm", unit="m", sort_order=1, is_free_position=True)
        entry = SiteMeasurementEntry(site=site, measurement_batch=batch, measurement_item=item,
            quantity=Decimal("1.25"), area_or_comment="EG", status="billed")
        db.add_all([batch, item, entry])
        batches.append(batch)
    db.add(user)
    db.commit()
    return site, user, batches


def create_group(db, site, user, batches):
    result = MeasurementGroupService(db).create(site.id, [batch.id for batch in batches], user)
    return db.get(MeasurementGroup, result.id)


def test_aggregate_sums_same_service_without_adding_quantities_to_ledger():
    with db_session() as db:
        site, user, batches = setup_group(db)
        group = create_group(db, site, user, batches[::-1])
        assert group.number_label == "8007.12G"
        assert group.snapshot["cells"] == [{"area": "eg", "item_id": 1, "quantity": "2.50"}]
        assert len(group.snapshot["positions"]) == 1
        assert len(group.snapshot["workers"]) == 2
        assert group.snapshot["customer"]["name"] == "Kunde 12"
        assert db.scalar(select(func.count()).select_from(SiteMeasurementBatch)) == 2
        assert db.scalar(select(func.sum(SiteMeasurementEntry.quantity))) == Decimal("2.50")
        assert batches[0].is_invoiced and not batches[1].is_invoiced
        overview = MeasurementService(db).list_site_batches(site.id)
        assert {row.combined_measurement.id for row in overview} == {group.id}
        assert "snapshot" not in overview[0].combined_measurement.model_dump()
        assert "version" not in overview[0].combined_measurement.model_dump()["sources"][0]
        assert create_group(db, site, user, batches).id == group.id  # Retry is idempotent.


@pytest.mark.parametrize("changed", ["description", "unit", "position"])
def test_same_number_is_not_enough_to_merge_different_services(changed):
    with db_session() as db:
        site, user, batches = setup_group(db)
        setattr(batches[1].free_items[0], changed, "Anderer Wert")
        batches[1].entries[0].quantity = Decimal("-0.75")
        db.commit()
        snapshot = create_group(db, site, user, batches).snapshot
        assert len(snapshot["positions"]) == 2
        assert sum(Decimal(cell["quantity"]) for cell in snapshot["cells"]) == Decimal("0.50")


def test_merge_preserves_area_quantities_and_ignores_superseded_cell_entries():
    with db_session() as db:
        site, user, batches = setup_group(db)
        batches[0].entries[0].area_or_comment = " EG "
        db.add(SiteMeasurementEntry(site=site, measurement_batch=batches[1], measurement_item=batches[1].free_items[0],
                                   quantity=Decimal("-0.25"), area_or_comment="eg", status="billed"))
        db.add(SiteMeasurementEntry(site=site, measurement_batch=batches[1], measurement_item=batches[1].free_items[0],
                                   quantity=Decimal("3.10"), area_or_comment="OG", status="billed"))
        db.commit()
        snapshot = create_group(db, site, user, batches).snapshot
        cells = {cell["area"]: Decimal(cell["quantity"]) for cell in snapshot["cells"]}
        assert cells == {"eg": Decimal("1.00"), "og": Decimal("3.10")}


@pytest.mark.parametrize("missing_role", ["worker", "customer"])
def test_missing_signature_does_not_fabricate_consent(missing_role):
    with db_session() as db:
        site, user, batches = setup_group(db)
        setattr(batches[0], f"{missing_role}_signature_strokes", [])
        db.commit()
        group = create_group(db, site, user, batches)
        assert group.has_customer_signature is (missing_role != "customer")
        assert group.worker_signature_count == (1 if missing_role == "worker" else 2)
        assert (group.snapshot["customer"] is not None) is group.has_customer_signature


@pytest.mark.parametrize("status", ["draft", "submitted", "reviewed", "customer_signed", "rejected"])
def test_only_completed_originals_are_eligible(status):
    with db_session() as db:
        site, user, batches = setup_group(db)
        batches[0].status = status
        db.commit()
        with pytest.raises(HTTPException, match="abgeschlossene"):
            create_group(db, site, user, batches)
        assert db.scalar(select(func.count()).select_from(MeasurementGroup)) == 0


@pytest.mark.parametrize("kind", ["single", "duplicate", "wrong_site", "archived", "overlap"])
def test_invalid_selection_is_rejected_without_partial_group(kind):
    with db_session() as db:
        site, user, batches = setup_group(db, 3)
        selected = batches[:2]
        if kind == "single":
            selected = batches[:1]
        if kind == "duplicate":
            selected = [batches[0], batches[0]]
        if kind == "wrong_site":
            batches[0].site = create_site(db)
        if kind == "archived":
            batches[0].deleted_at = datetime.now(timezone.utc)
        if kind == "overlap":
            create_group(db, site, user, batches[1:])
        db.commit()
        with pytest.raises(HTTPException):
            create_group(db, site, user, selected)
        assert db.scalar(select(func.count()).select_from(MeasurementGroup)) == (1 if kind == "overlap" else 0)


@pytest.mark.parametrize("change", ["quantity", "area", "new_entry", "new_entry_relationship", "delete_entry", "item", "override", "status", "invoice", "archive", "signature", "area_row", "photo"])
def test_any_source_change_atomically_dissolves_group_without_deleting_originals(change):
    with db_session() as db:
        site, user, batches = setup_group(db)
        group = create_group(db, site, user, batches)
        before = group.snapshot
        batch = batches[0]
        if change == "quantity":
            batch.entries[0].quantity = Decimal("2.75")
        if change == "area":
            batch.entries[0].area_or_comment = "OG"
        if change == "new_entry":
            db.add(SiteMeasurementEntry(site=site, measurement_batch_id=batch.id, measurement_item=batch.free_items[0], quantity=3, area_or_comment="OG", status="billed"))
        if change == "new_entry_relationship":
            db.add(SiteMeasurementEntry(site=site, measurement_batch=batch, measurement_item=batch.free_items[0], quantity=3, area_or_comment="OG", status="billed"))
        if change == "delete_entry":
            db.delete(batch.entries[0])
        if change == "item":
            batch.free_items[0].description = "Neu"
        if change == "override":
            batch.item_overrides = {str(batch.free_items[0].id): {"description": "Neu"}}
        if change == "status":
            batch.status = "customer_signed"
        if change == "invoice":
            batch.is_invoiced = False
        if change == "archive":
            batch.deleted_at = datetime.now(timezone.utc)
        if change == "signature":
            batch.customer_signature_strokes = []
        if change == "area_row":
            db.add(SiteMeasurementAreaRow(site=site, measurement_batch_id=batch.id, area_or_comment="Dach", sort_order=1))
        if change == "photo":
            db.add(SiteMeasurementBatchPhoto(site=site, measurement_batch=batch, external_drive_id="test", external_item_id="test-photo", filename="test.jpg", content_type="image/jpeg"))
        db.commit()
        db.expire_all()
        assert group.invalidated_at is not None
        assert group.snapshot == before
        assert db.scalar(select(func.count()).select_from(SiteMeasurementBatch)) == 2
        assert not db.scalar(select(MeasurementGroupMember.batch_id).where(MeasurementGroupMember.active.is_(True)))
        with pytest.raises(HTTPException, match="geändert"):
            MeasurementGroupService(db).pdf(site.id, group.id)
        assert all(row.combined_measurement is None for row in MeasurementService(db).list_site_batches(site.id))


def test_a_loaded_catalog_item_edit_invalidates_referencing_batches_not_unrelated_groups():
    with db_session() as db:
        site, user, batches = setup_group(db, 4)
        shared = SiteMeasurementItem(site=site, position="1.01.05.300", description="Kabelrinne 500 mm",
                                     unit="m", sort_order=1, is_free_position=False)
        db.add(shared)
        batches[0].entries[0].measurement_item = shared
        db.commit()
        group = create_group(db, site, user, batches[:2])
        other = create_group(db, site, user, batches[2:])
        shared.description = "Geänderte Katalogposition"
        db.commit()
        assert group.invalidated_at is not None
        assert other.invalidated_at is None


def test_empty_completed_measurements_can_be_combined_and_exported():
    with db_session() as db:
        site, user, batches = setup_group(db)
        for batch in batches:
            for entry in list(batch.entries):
                db.delete(entry)
            for item in list(batch.free_items):
                db.delete(item)
        db.commit()
        group = create_group(db, site, user, batches)
        assert group.position_count == 0
        content, _ = MeasurementGroupService(db).pdf(site.id, group.id)
        assert PdfReader(BytesIO(content)).pages


def test_opposite_corrections_keep_the_service_visible_even_when_the_total_is_zero():
    with db_session() as db:
        site, user, batches = setup_group(db)
        batches[1].entries[0].quantity = Decimal("-1.25")
        db.commit()
        group = create_group(db, site, user, batches)
        assert group.snapshot["cells"][0]["quantity"] == "0.00"
        content, _ = MeasurementGroupService(db).pdf(site.id, group.id)
        assert "1.01.05.300" in PdfReader(BytesIO(content)).pages[0].extract_text()


def test_rollback_preserves_group_and_unrelated_edits_do_not_invalidate_it():
    with db_session() as db:
        site, user, batches = setup_group(db, 3)
        group = create_group(db, site, user, batches[:2])
        batches[0].entries[0].quantity = 900
        db.flush()
        db.rollback()
        assert group.invalidated_at is None
        batches[2].entries[0].quantity = 8
        db.commit()
        assert group.invalidated_at is None
        assert len(groups_for_overview(db, site.id, batches)) == 2


def test_bulk_change_is_detected_and_recombining_uses_new_snapshot():
    with db_session() as db:
        site, user, batches = setup_group(db)
        group = create_group(db, site, user, batches)
        db.execute(update(SiteMeasurementEntry).where(SiteMeasurementEntry.id == batches[0].entries[0].id).values(quantity=10))
        db.commit()
        with Session(db.get_bind()) as fresh:
            assert all(row.combined_measurement is None for row in MeasurementService(fresh).list_site_batches(site.id))
            with pytest.raises(HTTPException, match="geändert"):
                MeasurementGroupService(fresh).pdf(site.id, group.id)
        new_group = create_group(db, site, user, batches)
        assert new_group.id != group.id
        assert new_group.number_label == group.number_label
        assert new_group.snapshot["cells"][0]["quantity"] == "11.25"
        db.refresh(group)
        assert group.invalidated_at is not None


def test_pdf_is_one_merged_matrix_and_every_page_lists_sources():
    with db_session() as db:
        site, user, batches = setup_group(db, 8)
        group = create_group(db, site, user, batches)
        content, filename = MeasurementGroupService(db).pdf(site.id, group.id)
        assert filename == "Gesamtaufmass_8007.18G.pdf"
        pages = PdfReader(BytesIO(content)).pages
        assert len(pages) == 3  # ONE matrix plus two signature continuation pages.
        for page in pages:
            text = page.extract_text()
            assert "Zusammengesetzt aus Aufmaßen:" in text
            assert all(f"8007.{number}" in text for number in range(11, 19))
            assert "8007.18G" in text
        text = pages[0].extract_text()
        assert "10,00" in text
        assert text.count("1.01.05.300") == 1
        assert "Kunde 18" in text and "Kunde 11" not in text
        signatures = "".join(page.extract_text() for page in pages[1:])
        assert all(f"Monteur {number}" in signatures for number in range(11, 19))


def test_pdf_access_is_site_scoped():
    with db_session() as db:
        site, user, batches = setup_group(db)
        group = create_group(db, site, user, batches)
        with pytest.raises(HTTPException) as result:
            MeasurementGroupService(db).pdf(site.id + 99, group.id)
        assert result.value.status_code == 404


@pytest.mark.parametrize("role,permissions,expected", [
    (UserRole.ADMIN, [], 201), (UserRole.PROJECT_MANAGER, [], 201),
    (UserRole.OFFICE, ["sites"], 201), (UserRole.OFFICE, [], 403), (UserRole.MONTEUR, [], 403),
])
def test_group_routes_use_existing_office_permissions(monkeypatch, role, permissions, expected):
    from app.api.routes import sites
    from app.tests.test_office_measurement_routes import api_client, current_user
    class FakeGroups:
        def __init__(self, db): pass
        def create(self, site_id, batch_ids, user):
            assert site_id == 8 and batch_ids == [11, 12]
            return {"id": 1, "number_label": "8007.12G", "created_at": datetime.now(timezone.utc),
                    "sources": [{"id": 11, "number_label": "8007.11"}, {"id": 12, "number_label": "8007.12"}],
                    "position_count": 1, "worker_signature_count": 0, "has_customer_signature": False}
        def pdf(self, site_id, group_id): return b"%PDF-test", "Gesamtaufmass_8007.12G.pdf"
    monkeypatch.setattr(sites, "MeasurementGroupService", FakeGroups)
    client = api_client(monkeypatch, current_user(role, *permissions))
    response = client.post("/api/sites/8/measurement-groups", json={"batch_ids": [11, 12]})
    assert response.status_code == expected
    response = client.get("/api/sites/8/measurement-groups/1/pdf")
    assert response.status_code == (200 if expected == 201 else 403)
    if response.status_code == 200:
        assert response.headers["cache-control"] == "no-store"
        assert "Gesamtaufmass_8007.12G.pdf" in response.headers["content-disposition"]
