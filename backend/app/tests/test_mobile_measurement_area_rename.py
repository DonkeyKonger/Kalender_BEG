from datetime import date, datetime, timezone
from decimal import Decimal
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.models.assignment import Assignment
from app.models.enums import PersonType, UserRole
from app.models.person import Person
from app.models.site_measurement_item import SiteMeasurementBatch, SiteMeasurementItem, SiteMeasurementEntry, SiteMeasurementAreaRow
from app.models.user import User
from app.services.measurement_service import MeasurementService
from app.tests.test_measurement_service import db_session, create_site, create_measurement_base


@pytest.fixture
def case():
    with db_session() as db:
        site = create_site(db)
        base = create_measurement_base(db, site)
        person = Person(first_name="Test", last_name="Monteur", display_name="Test Monteur", short_code="TM", person_type=PersonType.INTERNAL)
        actor = User(username="tablet-worker", display_name="Test Monteur", password_hash="x", role=UserRole.MONTEUR, person=person)
        assignment = Assignment(site=site, person=person, start_date=date(2026, 9, 29), end_date=date(2026, 9, 30))
        batch = SiteMeasurementBatch(site=site, measurement_base=base, number=1, title="Test", status="draft")
        other = SiteMeasurementBatch(site=site, measurement_base=base, number=2, title="Other", status="draft")
        item = SiteMeasurementItem(site=site, measurement_base=base, position="1.1", description="Testposition", unit="m", sort_order=1)
        entries = [SiteMeasurementEntry(site=site, measurement_batch=target, measurement_item=item,
            quantity=Decimal("12.50"), area_or_comment="EG", status="saved", created_by=actor) for target in [batch, other]]
        row = SiteMeasurementAreaRow(site_id=site.id, measurement_batch=batch, area_or_comment="EG", sort_order=1)
        db.add_all([actor, assignment, batch, other, item, *entries, row])
        db.commit()
        service = MeasurementService(db)
        def rename(previous="EG", replacement="OG", **overrides):
            return service.rename_mobile_batch_area(**{
                "assignment_id": assignment.id, "batch_id": batch.id, "current_user": actor,
                "previous": previous, "replacement": replacement, **overrides,
            })
        yield SimpleNamespace(db=db, site=site, batch=batch, other=other, entries=entries, row=row,
            actor=actor, assignment=assignment, item=item, service=service, rename=rename)


def test_rename_is_repeatable_persistent_and_preserves_quantities(case):
    c = case
    result = c.rename(replacement="  OG   Flur ")
    assert result.batch.area_rows[0].area_or_comment == "OG Flur"
    assert result.items[0].entries[0].area_or_comment == "OG Flur"
    c.rename(previous="og flur", replacement="KG")
    c.db.expire_all()
    assert c.row.area_or_comment == "KG"
    assert c.entries[0].area_or_comment == "KG"
    assert c.entries[0].quantity == Decimal("12.50")
    assert c.entries[1].area_or_comment == "EG"


def test_empty_and_legacy_entry_only_rows_can_be_renamed(case):
    c = case
    c.db.delete(c.row)
    c.db.commit()
    assert c.rename().items[0].entries[0].area_or_comment == "OG"
    row = SiteMeasurementAreaRow(site_id=c.site.id, measurement_batch=c.batch, area_or_comment="LEER", sort_order=2)
    c.db.add(row)
    c.db.commit()
    assert c.rename(previous="LEER", replacement="RAUM 1").batch.area_rows[0].area_or_comment == "RAUM 1"


@pytest.mark.parametrize("state", ["submitted", "reviewed", "approved", "billed", "signed"])
def test_workflow_locks_remain_enforced(case, state):
    c = case
    if state == "signed": c.batch.customer_signed_at = datetime.now(timezone.utc)
    else: c.batch.status = state
    c.db.commit()
    with pytest.raises(HTTPException) as error: c.rename()
    assert error.value.status_code == 409
    assert c.row.area_or_comment == c.entries[0].area_or_comment == "EG"


@pytest.mark.parametrize("previous,replacement,code", [("EG", " ", 400), ("EG", "x" * 1001, 400), ("missing", "OG", 409), ("EG", "Raum 2", 409)])
def test_invalid_or_conflicting_labels_do_not_change_any_entries(case, previous, replacement, code):
    c = case
    c.db.add(SiteMeasurementAreaRow(site_id=c.site.id, measurement_batch=c.batch, area_or_comment="RAUM 2", sort_order=2))
    c.db.commit()
    with pytest.raises(HTTPException) as error: c.rename(previous, replacement)
    assert error.value.status_code == code
    assert c.entries[0].area_or_comment == c.row.area_or_comment == "EG"


def test_assignment_and_batch_scope_are_enforced(case):
    c = case
    with pytest.raises(HTTPException) as error: c.rename(assignment_id=99999)
    assert error.value.status_code == 404
    foreign = create_site(c.db)
    batch = SiteMeasurementBatch(site=foreign, number=1, title="Foreign", status="draft")
    c.db.add(batch)
    c.db.commit()
    with pytest.raises(HTTPException) as error: c.rename(batch_id=batch.id)
    assert error.value.status_code == 404
    stranger = User(username="stranger", display_name="Stranger", password_hash="x", role=UserRole.MONTEUR)
    with pytest.raises(HTTPException) as error: c.rename(current_user=stranger)
    assert error.value.status_code == 403
