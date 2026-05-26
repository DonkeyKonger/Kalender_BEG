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
