from datetime import date
from types import SimpleNamespace

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models import Base
from app.models.assignment import Assignment
from app.models.person import Person
from app.models.site import Site
from app.services.extra_work_service import ExtraWorkService


def db_session() -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    return Session(engine)


def test_mobile_extra_work_ticket_persists_per_assignment_site_and_can_be_submitted():
    db = db_session()
    person = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
    )
    site = Site(site_number="8007", name="Schüchtermann Klinik")
    other_site = Site(site_number="9001", name="Andere Baustelle")
    db.add_all([person, site, other_site])
    db.commit()
    assignment = Assignment(
        person_id=person.id,
        site_id=site.id,
        start_date=date(2026, 6, 11),
        end_date=date(2026, 6, 11),
    )
    other_assignment = Assignment(
        person_id=person.id,
        site_id=other_site.id,
        start_date=date(2026, 6, 11),
        end_date=date(2026, 6, 11),
    )
    db.add_all([assignment, other_assignment])
    db.commit()
    current_user = SimpleNamespace(id=7, person_id=person.id)

    created = ExtraWorkService(db).create_mobile_ticket(
        assignment_id=assignment.id,
        current_user=current_user,
    )
    submitted = ExtraWorkService(db).update_mobile_ticket_status(
        assignment_id=assignment.id,
        ticket_id=created.id,
        next_status="submitted",
        current_user=current_user,
    )
    tickets = ExtraWorkService(db).list_mobile_tickets(
        assignment_id=assignment.id,
        current_user=current_user,
    )
    other_tickets = ExtraWorkService(db).list_mobile_tickets(
        assignment_id=other_assignment.id,
        current_user=current_user,
    )

    assert created.site_id == site.id
    assert created.sequence_number == 1
    assert created.status == "draft"
    assert submitted.status == "submitted"
    assert submitted.submitted_at is not None
    assert [ticket.id for ticket in tickets] == [created.id]
    assert other_tickets == []
