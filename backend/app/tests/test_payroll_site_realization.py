from datetime import date, datetime, timezone
from decimal import Decimal

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models import Base
from app.models.audit_log import AuditLog
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
    unbilled = ExtraWorkTicket(site_id=site.id, sequence_number=3, display_number="ZA-3", title="Offener Nachtrag", is_invoiced=False, invoiced_at=datetime(2026, 8, 5, tzinfo=UTC))
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


def test_realization_uses_documented_worker_hours_for_billed_supplements() -> None:
    db = Session(create_engine("sqlite+pysqlite:///:memory:"))
    Base.metadata.create_all(db.get_bind())
    site = Site(site_number="8007", name="Schüchtermann Klinik", status=SiteStatus.ACTIVE)
    item = SiteMeasurementItem(
        site=site,
        position="1",
        description="Leistung",
        minutes_per_unit=Decimal("1"),
        sort_order=1,
    )
    batch = SiteMeasurementBatch(
        site=site,
        number=1,
        title="August",
        status="submitted",
        first_submitted_at=datetime(2026, 8, 15, 9, tzinfo=UTC),
    )
    ticket = ExtraWorkTicket(
        site=site,
        sequence_number=1,
        display_number="8007.SZ01",
        title="Nachtrag",
        status="billed",
        is_invoiced=True,
        invoiced_at=datetime(2026, 8, 10, 9, tzinfo=UTC),
        entries=[
            ExtraWorkTicketEntry(
                site=site,
                component="A",
                floor="EG",
                estimated_hours=None,
                worker_rows=[
                    {
                        "monday_hours": "45.5",
                        "tuesday_hours": "6",
                    }
                ],
            )
        ],
    )
    db.add_all([site, item, batch, ticket])
    db.flush()
    db.add(
        SiteMeasurementEntry(
            measurement_batch_id=batch.id,
            measurement_item_id=item.id,
            site_id=site.id,
            quantity=Decimal("0"),
            area_or_comment="",
        )
    )
    db.commit()

    august = PayrollSiteCockpitService(db).get_cockpit(
        date_from=date(2026, 8, 1),
        date_to=date(2026, 8, 31),
    ).sites[0]

    assert august.supplementary_minutes == 3090
    assert august.performance_minutes == 3090


def test_realization_includes_only_audit_proven_legacy_invoiced_markers() -> None:
    db = Session(create_engine("sqlite+pysqlite:///:memory:"))
    Base.metadata.create_all(db.get_bind())
    site = Site(site_number="8007", name="Schüchtermann Klinik", status=SiteStatus.ACTIVE)
    item = SiteMeasurementItem(
        site=site,
        position="1",
        description="Leistung",
        minutes_per_unit=Decimal("1"),
        sort_order=1,
    )
    batch = SiteMeasurementBatch(
        site=site,
        number=1,
        title="August",
        status="submitted",
        first_submitted_at=datetime(2026, 8, 15, 9, tzinfo=UTC),
    )
    db.add_all([site, item, batch])
    db.flush()
    db.add(
        SiteMeasurementEntry(
            measurement_batch_id=batch.id,
            measurement_item_id=item.id,
            site_id=site.id,
            quantity=Decimal("0"),
            area_or_comment="",
        )
    )
    invoiced_tickets = [
        ExtraWorkTicket(
            site_id=site.id,
            sequence_number=sequence_number,
            display_number=display_number,
            title=display_number,
            status="billed",
            is_invoiced=True,
        )
        for sequence_number, display_number in [(5, "8007.SZ05"), (6, "8007.SZ06"), (7, "8007.SZ07")]
    ]
    unbilled_ticket = ExtraWorkTicket(
        site_id=site.id,
        sequence_number=8,
        display_number="8007.SZ08",
        title="8007.SZ08",
        status="signed",
        is_invoiced=False,
    )
    db.add_all([*invoiced_tickets, unbilled_ticket])
    db.flush()
    db.add_all(
        [
            ExtraWorkTicketEntry(
                ticket_id=ticket.id,
                site_id=site.id,
                component="x",
                floor="x",
                estimated_hours=hours,
                worker_rows=[],
            )
            for ticket, hours in [
                (invoiced_tickets[0], Decimal("2")),
                (invoiced_tickets[1], Decimal("5")),
                (invoiced_tickets[2], Decimal("0.5")),
                (unbilled_ticket, Decimal("6")),
            ]
        ]
    )
    db.add_all(
        [
            AuditLog(
                action="extra_work.invoiced_updated",
                entity_type="extra_work_ticket",
                entity_id=ticket.id,
                new_value_json={"is_invoiced": True},
                created_at=datetime(2026, 8, day, 9, tzinfo=UTC),
            )
            for ticket, day in zip(invoiced_tickets, [5, 5, 6], strict=True)
        ]
    )
    db.commit()

    august = PayrollSiteCockpitService(db).get_cockpit(
        date_from=date(2026, 8, 1),
        date_to=date(2026, 8, 31),
    ).sites[0]

    assert august.supplementary_minutes == 450
    assert august.performance_minutes == 450


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
        first_submitted_at=datetime(2026, 8, 15, 9, tzinfo=UTC),
    )
    second_event = SiteMeasurementBatch(
        site=site,
        number=2,
        title="September",
        status="submitted",
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
