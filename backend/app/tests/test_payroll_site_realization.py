from datetime import date, datetime, timezone
from decimal import Decimal

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models import Base
from app.models.enums import PersonType, SiteStatus
from app.models.extra_work_ticket import ExtraWorkTicket, ExtraWorkTicketEntry
from app.models.person import Person
from app.models.site import Site
from app.models.site_measurement_item import SiteMeasurementBatch, SiteMeasurementEntry, SiteMeasurementItem
from app.models.work_time_entry import WorkTimeEntry
from app.services.payroll_site_cockpit_service import PayrollSiteCockpitService


UTC = timezone.utc


def test_realization_partitions_hours_and_billed_supplements_into_measurement_events() -> None:
    db = Session(create_engine("sqlite+pysqlite:///:memory:"))
    Base.metadata.create_all(db.get_bind())
    person = Person(first_name="M", last_name="Test", display_name="M Test", short_code="MT", person_type=PersonType.INTERNAL)
    site = Site(site_number="100", name="Realisierung", status=SiteStatus.ACTIVE)
    db.add_all([person, site])
    db.flush()
    item = SiteMeasurementItem(site_id=site.id, position="1", description="Leistung", minutes_per_unit=Decimal("60"), sort_order=1)
    july = WorkTimeEntry(person_id=person.id, site_id=site.id, work_date=date(2026, 7, 20), work_minutes=480, break_minutes=0, travel_minutes=0)
    august = WorkTimeEntry(person_id=person.id, site_id=site.id, work_date=date(2026, 8, 10), work_minutes=120, break_minutes=0, travel_minutes=0)
    first = SiteMeasurementBatch(site_id=site.id, number=1, title="Juli", status="draft", first_submitted_at=datetime(2026, 8, 1, 9, tzinfo=UTC))
    second = SiteMeasurementBatch(site_id=site.id, number=2, title="August", status="submitted", first_submitted_at=datetime(2026, 8, 15, 9, tzinfo=UTC))
    third = SiteMeasurementBatch(site_id=site.id, number=3, title="September", status="submitted", first_submitted_at=datetime(2026, 9, 1, 9, tzinfo=UTC))
    db.add_all([item, july, august, first, second, third])
    db.flush()
    db.add_all([
        SiteMeasurementEntry(measurement_batch_id=first.id, measurement_item_id=item.id, site_id=site.id, quantity=Decimal("10"), area_or_comment=""),
        SiteMeasurementEntry(measurement_batch_id=second.id, measurement_item_id=item.id, site_id=site.id, quantity=Decimal("4"), area_or_comment=""),
        SiteMeasurementEntry(measurement_batch_id=third.id, measurement_item_id=item.id, site_id=site.id, quantity=Decimal("0"), area_or_comment=""),
    ])
    ticket = ExtraWorkTicket(site_id=site.id, sequence_number=1, display_number="ZA-1", title="Nachtrag", is_invoiced=True, invoiced_at=datetime(2026, 8, 8, tzinfo=UTC))
    pending_until_next_event = ExtraWorkTicket(site_id=site.id, sequence_number=2, display_number="ZA-2", title="Später Nachtrag", is_invoiced=True, invoiced_at=datetime(2026, 8, 20, tzinfo=UTC))
    db.add_all([ticket, pending_until_next_event])
    db.flush()
    db.add_all([
        ExtraWorkTicketEntry(ticket_id=ticket.id, site_id=site.id, component="x", floor="x", estimated_hours=Decimal("2"), worker_rows=[]),
        ExtraWorkTicketEntry(ticket_id=pending_until_next_event.id, site_id=site.id, component="x", floor="x", estimated_hours=Decimal("3"), worker_rows=[]),
    ])
    db.commit()
    service = PayrollSiteCockpitService(db)
    july_result = service.get_cockpit(date_from=date(2026, 7, 1), date_to=date(2026, 7, 31))
    august_result = service.get_cockpit(date_from=date(2026, 8, 1), date_to=date(2026, 8, 31))
    assert july_result.sites == []
    result = august_result.sites[0]
    assert result.measurement_minutes == 840
    assert result.supplementary_minutes == 120
    assert result.realized_actual_minutes == 600
    assert result.result_minutes == 360
    assert result.result_tone == "positive"
    september_result = service.get_cockpit(date_from=date(2026, 9, 1), date_to=date(2026, 9, 30))
    september = september_result.sites[0]
    assert september.measurement_minutes == 0
    assert september.supplementary_minutes == 180
    assert september.realized_actual_minutes == 0
    assert september.result_minutes == 180
