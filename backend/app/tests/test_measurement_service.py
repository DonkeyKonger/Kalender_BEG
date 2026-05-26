from decimal import Decimal

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.models import Base
from app.models.enums import SiteLocationStatus, SiteStatus
from app.models.site import Site
from app.models.site_measurement_item import SiteMeasurementItem
from app.services.measurement_service import MeasurementService
from app.services.measurement_timesheet_parser import (
    ParsedMeasurementItem,
    MeasurementTimesheetParseResult,
)


def db_session() -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    return Session(engine)


def create_site(db: Session) -> Site:
    site = Site(
        name="Testbaustelle",
        status=SiteStatus.ACTIVE,
        location_status=SiteLocationStatus.UNCHECKED,
    )
    db.add(site)
    db.flush()
    return site


def parsed_timesheet() -> MeasurementTimesheetParseResult:
    return MeasurementTimesheetParseResult(
        source_project_number="8007 / P250092",
        source_invoice_number="1260197",
        source_customer_name="ebm elektro-bau-montage GmbH",
        items=[
            ParsedMeasurementItem(
                position="1.01.05.160",
                description="90°Rinnenbogen 500/60 mm FT liefern und montieren",
                list_quantity=Decimal("0.00"),
                unit="Stck",
                minutes_per_unit=Decimal("17.10"),
                list_minutes_total=None,
                is_nep=True,
                sort_order=1,
            )
        ],
    )


def test_import_timesheet_stores_zero_quantity_and_blocks_same_invoice(monkeypatch):
    db = db_session()
    site = create_site(db)
    monkeypatch.setattr(
        "app.services.measurement_service.parse_measurement_timesheet_pdf",
        lambda _content: parsed_timesheet(),
    )

    summary, items = MeasurementService(db).import_timesheet(
        site.id, file_name="Zeitvorgabe.pdf", pdf_content=b"pdf"
    )

    stored = db.scalar(select(SiteMeasurementItem).where(SiteMeasurementItem.site_id == site.id))
    assert summary["imported_count"] == 1
    assert len(items) == 1
    assert stored is not None
    assert stored.list_quantity == Decimal("0.00")
    assert stored.is_nep is True
    assert stored.list_minutes_total is None

    with pytest.raises(HTTPException) as error:
        MeasurementService(db).import_timesheet(site.id, file_name="Zeitvorgabe.pdf", pdf_content=b"pdf")

    assert error.value.status_code == 409


def test_mobile_measurement_entry_keeps_imported_item_and_summarizes_quantity():
    from datetime import date

    from app.models.assignment import Assignment
    from app.models.enums import AssignmentType, PersonType, UserRole
    from app.models.person import Person
    from app.models.site_measurement_item import SiteMeasurementEntry
    from app.models.user import User
    from app.schemas.measurement import MeasurementEntryCreate

    db = db_session()
    site = create_site(db)
    person = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
        person_type=PersonType.INTERNAL,
    )
    user = User(
        username="max",
        display_name="Max Monteur",
        password_hash="x",
        role=UserRole.MONTEUR,
        person=person,
    )
    assignment = Assignment(
        site=site,
        person=person,
        start_date=date(2026, 5, 26),
        end_date=date(2026, 5, 26),
        assignment_type=AssignmentType.REGULAR,
    )
    item = SiteMeasurementItem(
        site=site,
        position="1.01.05.10",
        description="Kabelrinne liefern und montieren",
        list_quantity=Decimal("0.00"),
        unit="m",
        minutes_per_unit=Decimal("19.80"),
        list_minutes_total=Decimal("0.00"),
        is_nep=False,
        sort_order=1,
    )
    db.add_all([user, assignment, item])
    db.commit()

    entry = MeasurementService(db).create_mobile_entry(
        assignment_id=assignment.id,
        measurement_item_id=item.id,
        current_user=user,
        payload=MeasurementEntryCreate(area_or_comment="1. OG Flur", quantity=Decimal("10.00")),
    )
    mobile_items = MeasurementService(db).list_mobile_items(
        assignment_id=assignment.id,
        current_user=user,
    )

    stored_item = db.get(SiteMeasurementItem, item.id)
    stored_entry = db.get(SiteMeasurementEntry, entry.id)
    assert stored_item is not None
    assert stored_item.list_quantity == Decimal("0.00")
    assert stored_entry is not None
    assert stored_entry.area_or_comment == "1. OG Flur"
    assert mobile_items[0].reported_quantity == Decimal("10.00")
    assert mobile_items[0].reported_minutes == Decimal("198.0000")
    assert mobile_items[0].mobile_status == "edited"
