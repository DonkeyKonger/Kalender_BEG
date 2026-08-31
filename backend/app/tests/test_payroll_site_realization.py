from datetime import date, datetime, time, timezone
from decimal import Decimal

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models import Base
from app.models.assignment import Assignment
from app.models.enums import AssignmentType, PersonType, SiteStatus
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
    first = SiteMeasurementBatch(site_id=site.id, number=1, title="Juli", status="submitted", submitted_at=datetime(2026, 8, 1, 9, tzinfo=UTC), first_submitted_at=datetime(2026, 8, 1, 9, tzinfo=UTC))
    second = SiteMeasurementBatch(site_id=site.id, number=2, title="August", status="submitted", submitted_at=datetime(2026, 8, 15, 9, tzinfo=UTC), first_submitted_at=datetime(2026, 8, 15, 9, tzinfo=UTC))
    third = SiteMeasurementBatch(site_id=site.id, number=3, title="September", status="submitted", submitted_at=datetime(2026, 9, 1, 9, tzinfo=UTC), first_submitted_at=datetime(2026, 9, 1, 9, tzinfo=UTC))
    db.add_all([item, july, august, first, second, third])
    db.flush()
    db.add_all([
        SiteMeasurementEntry(measurement_batch_id=first.id, measurement_item_id=item.id, site_id=site.id, quantity=Decimal("10"), area_or_comment=""),
        SiteMeasurementEntry(measurement_batch_id=second.id, measurement_item_id=item.id, site_id=site.id, quantity=Decimal("4"), area_or_comment=""),
        SiteMeasurementEntry(measurement_batch_id=third.id, measurement_item_id=item.id, site_id=site.id, quantity=Decimal("0"), area_or_comment=""),
    ])
    ticket = ExtraWorkTicket(site_id=site.id, sequence_number=1, display_number="ZA-1", title="Nachtrag", status="submitted", submitted_at=datetime(2026, 8, 8, tzinfo=UTC), is_invoiced=True, invoiced_at=datetime(2026, 8, 8, tzinfo=UTC))
    pending_until_next_event = ExtraWorkTicket(site_id=site.id, sequence_number=2, display_number="ZA-2", title="Später Nachtrag", status="submitted", submitted_at=datetime(2026, 8, 20, tzinfo=UTC), is_invoiced=True, invoiced_at=datetime(2026, 8, 20, tzinfo=UTC))
    unbilled = ExtraWorkTicket(site_id=site.id, sequence_number=3, display_number="ZA-3", title="Offener Nachtrag", status="submitted", submitted_at=datetime(2026, 8, 9, tzinfo=UTC), is_invoiced=False, invoiced_at=datetime(2026, 8, 5, tzinfo=UTC))
    db.add_all([ticket, pending_until_next_event, unbilled])
    db.flush()
    db.add_all([
        ExtraWorkTicketEntry(ticket_id=ticket.id, site_id=site.id, component="x", floor="x", estimated_hours=Decimal("2"), worker_rows=[]),
        ExtraWorkTicketEntry(ticket_id=pending_until_next_event.id, site_id=site.id, component="x", floor="x", estimated_hours=Decimal("3"), worker_rows=[]),
        ExtraWorkTicketEntry(ticket_id=unbilled.id, site_id=site.id, component="x", floor="x", estimated_hours=Decimal("7"), worker_rows=[]),
    ])
    db.commit()
    service = PayrollSiteCockpitService(db)
    july_result = service.get_cockpit(date_from=date(2026, 7, 1), date_to=date(2026, 7, 31))
    august_result = service.get_cockpit(date_from=date(2026, 8, 1), date_to=date(2026, 8, 31))
    assert july_result.sites == []
    result = august_result.sites[0]
    assert result.measurement_minutes == 840
    assert result.supplementary_minutes == 300
    assert result.realized_actual_minutes == 600
    assert result.result_minutes == 540
    assert result.result_tone == "positive"
    september_result = service.get_cockpit(date_from=date(2026, 9, 1), date_to=date(2026, 9, 30))
    september = september_result.sites[0]
    assert september.measurement_minutes == 0
    assert september.supplementary_minutes == 0
    assert september.realized_actual_minutes == 0
    assert september.result_minutes == 0


def test_realization_counts_external_monteurs_once_in_their_submission_interval() -> None:
    db = Session(create_engine("sqlite+pysqlite:///:memory:"))
    Base.metadata.create_all(db.get_bind())
    internal = Person(
        first_name="Intern",
        last_name="Monteur",
        display_name="Intern Monteur",
        short_code="IM",
        person_type=PersonType.INTERNAL,
    )
    external = Person(
        first_name="Extern",
        last_name="Monteur",
        display_name="Extern Monteur",
        short_code="EM",
        person_type=PersonType.EXTERNAL,
    )
    site = Site(site_number="8021", name="Ostwache Kiel", status=SiteStatus.ACTIVE)
    item = SiteMeasurementItem(
        site=site,
        position="1",
        description="Leistung",
        minutes_per_unit=Decimal("1"),
        sort_order=1,
    )
    first_event = SiteMeasurementBatch(
        site=site,
        number=1,
        title="August",
        status="submitted",
        submitted_at=datetime(2026, 8, 15, 9, tzinfo=UTC),
        first_submitted_at=datetime(2026, 8, 15, 9, tzinfo=UTC),
    )
    second_event = SiteMeasurementBatch(
        site=site,
        number=2,
        title="September",
        status="submitted",
        submitted_at=datetime(2026, 9, 1, 9, tzinfo=UTC),
        first_submitted_at=datetime(2026, 9, 1, 9, tzinfo=UTC),
    )
    db.add_all([internal, external, site, item, first_event, second_event])
    db.flush()
    db.add_all(
        [
            SiteMeasurementEntry(
                measurement_batch_id=first_event.id,
                measurement_item_id=item.id,
                site_id=site.id,
                quantity=Decimal("2410"),
                area_or_comment="",
            ),
            SiteMeasurementEntry(
                measurement_batch_id=second_event.id,
                measurement_item_id=item.id,
                site_id=site.id,
                quantity=Decimal("0"),
                area_or_comment="",
            ),
            WorkTimeEntry(
                person_id=internal.id,
                site_id=site.id,
                work_date=date(2026, 8, 10),
                work_minutes=1830,
                break_minutes=0,
                travel_minutes=0,
            ),
            WorkTimeEntry(
                person_id=internal.id,
                site_id=site.id,
                work_date=date(2026, 8, 20),
                work_minutes=60,
                break_minutes=0,
                travel_minutes=0,
            ),
            Assignment(
                site_id=site.id,
                person_id=external.id,
                start_date=date(2026, 8, 10),
                end_date=date(2026, 8, 20),
                assignment_type=AssignmentType.REGULAR,
            ),
        ]
    )
    db.commit()

    service = PayrollSiteCockpitService(db)
    august = service.get_cockpit(
        date_from=date(2026, 8, 1),
        date_to=date(2026, 8, 31),
    ).sites[0]
    september = service.get_cockpit(
        date_from=date(2026, 9, 1),
        date_to=date(2026, 9, 30),
    ).sites[0]

    assert august.measurement_minutes == 2410
    assert august.realized_actual_minutes == 3660
    assert august.result_minutes == -1250
    assert august.result_tone == "negative"
    assert september.realized_actual_minutes == 120
    assert september.result_minutes == -120


def test_monthly_realization_reconciles_with_four_project_time_analysis_periods() -> None:
    db = Session(create_engine("sqlite+pysqlite:///:memory:"))
    Base.metadata.create_all(db.get_bind())
    worker = Person(
        first_name="Klinik",
        last_name="Monteur",
        display_name="Klinik Monteur",
        short_code="KM",
        person_type=PersonType.INTERNAL,
    )
    site = Site(site_number="8007", name="Schüchtermann Klinik", status=SiteStatus.ACTIVE)
    item = SiteMeasurementItem(
        site=site,
        position="1",
        description="Leistung",
        minutes_per_unit=Decimal("1"),
        sort_order=1,
    )
    db.add_all([worker, site, item])
    db.flush()

    batch_values = [
        (1, date(2026, 8, 5), Decimal("6365")),
        (2, date(2026, 8, 10), Decimal("2395")),
        (4, date(2026, 8, 15), Decimal("1483")),
        (6, date(2026, 8, 20), Decimal("2441")),
    ]
    batches = [
        SiteMeasurementBatch(
            site_id=site.id,
            number=number,
            title=f"Aufmaß {number}",
            status="submitted",
            submitted_at=datetime.combine(day, time(12), tzinfo=UTC),
            first_submitted_at=datetime.combine(day, time(12), tzinfo=UTC),
        )
        for number, day, _minutes in batch_values
    ]
    db.add_all(batches)
    db.flush()
    db.add_all(
        [
            SiteMeasurementEntry(
                measurement_batch_id=batch.id,
                measurement_item_id=item.id,
                site_id=site.id,
                quantity=minutes,
                area_or_comment="",
            )
            for batch, (_number, _day, minutes) in zip(batches, batch_values, strict=True)
        ]
    )
    db.add_all(
        [
            WorkTimeEntry(
                person_id=worker.id,
                site_id=site.id,
                work_date=day,
                work_minutes=minutes,
                break_minutes=0,
                travel_minutes=0,
            )
            for day, minutes in [
                (date(2026, 8, 4), 19160),
                (date(2026, 8, 9), 6348),
                (date(2026, 8, 14), 721),
                (date(2026, 8, 19), 5126),
            ]
        ]
    )
    db.add_all(
        [
            ExtraWorkTicket(
                site_id=site.id,
                sequence_number=1,
                display_number="8007.Z01",
                title="Zusatz 1",
                status="submitted",
                submitted_at=datetime(2026, 8, 4, 9, tzinfo=UTC),
                is_invoiced=True,
                invoiced_at=datetime(2026, 8, 4, 9, tzinfo=UTC),
                entries=[
                    ExtraWorkTicketEntry(
                        site_id=site.id,
                        component="A",
                        floor="EG",
                        worker_rows=[{"monday_hours": "45.5"}],
                    )
                ],
            ),
            ExtraWorkTicket(
                site_id=site.id,
                sequence_number=2,
                display_number="8007.Z02",
                title="Zusatz 2",
                status="submitted",
                submitted_at=datetime(2026, 8, 11, 9, tzinfo=UTC),
                is_invoiced=True,
                invoiced_at=datetime(2026, 8, 11, 9, tzinfo=UTC),
                entries=[
                    ExtraWorkTicketEntry(
                        site_id=site.id,
                        component="B",
                        floor="EG",
                        worker_rows=[{"monday_hours": "6"}],
                    )
                ],
            ),
        ]
    )
    db.commit()

    result = PayrollSiteCockpitService(db).get_cockpit(
        date_from=date(2026, 8, 1),
        date_to=date(2026, 8, 31),
    ).sites[0]

    assert result.measurement_minutes == 12684
    assert result.supplementary_minutes == 3090
    assert result.performance_minutes == 15774
    assert result.realized_actual_minutes == 31355
    assert result.result_minutes == -15581
