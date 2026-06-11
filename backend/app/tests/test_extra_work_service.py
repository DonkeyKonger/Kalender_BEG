from datetime import date
from io import BytesIO
from types import SimpleNamespace

from fastapi.testclient import TestClient
from pypdf import PdfReader
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.api.dependencies import get_current_app_user
from app.core.database import get_db
from app.main import app
from app.models import Base
from app.models.assignment import Assignment
from app.models.person import Person
from app.models.site import Site
from app.schemas.extra_work import ExtraWorkTicketCreate, ExtraWorkTicketEntryPayload, ExtraWorkWorkerHours
from app.services.extra_work_pdf_service import ExtraWorkPdfService
from app.services.extra_work_service import ExtraWorkService


def db_session() -> Session:
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
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
    assert created.kind == "billing"
    assert created.approval_ticket_id is None
    assert created.status == "draft"
    assert submitted.status == "submitted"
    assert submitted.submitted_at is not None
    assert [ticket.id for ticket in tickets] == [created.id]
    assert other_tickets == []


def test_mobile_extra_work_ticket_uses_approval_kind_when_site_requires_approval():
    db = db_session()
    person = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
    )
    site = Site(
        site_number="8007",
        name="Schüchtermann Klinik",
        requires_extra_work_approval=True,
    )
    db.add_all([person, site])
    db.commit()
    assignment = Assignment(
        person_id=person.id,
        site_id=site.id,
        start_date=date(2026, 6, 11),
        end_date=date(2026, 6, 11),
    )
    db.add(assignment)
    db.commit()
    current_user = SimpleNamespace(id=7, person_id=person.id)

    approval = ExtraWorkService(db).create_mobile_ticket(
        assignment_id=assignment.id,
        current_user=current_user,
    )
    billing = ExtraWorkService(db).create_mobile_ticket(
        assignment_id=assignment.id,
        current_user=current_user,
        payload=ExtraWorkTicketCreate(kind="billing", approval_ticket_id=approval.id),
    )

    assert approval.kind == "approval"
    assert approval.approval_ticket_id is None
    assert billing.kind == "billing"
    assert billing.approval_ticket_id == approval.id


def test_mobile_extra_work_ticket_entry_persists_and_updates_ticket_summary():
    db = db_session()
    person = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
    )
    site = Site(site_number="8007", name="Schüchtermann Klinik")
    db.add_all([person, site])
    db.commit()
    assignment = Assignment(
        person_id=person.id,
        site_id=site.id,
        start_date=date(2026, 6, 11),
        end_date=date(2026, 6, 11),
    )
    db.add(assignment)
    db.commit()
    current_user = SimpleNamespace(id=7, person_id=person.id)
    service = ExtraWorkService(db)

    ticket = service.create_mobile_ticket(
        assignment_id=assignment.id,
        current_user=current_user,
    )
    entry = service.upsert_mobile_ticket_entry(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        current_user=current_user,
        payload=ExtraWorkTicketEntryPayload(
            component="BT A",
            floor="2. OG",
            room_number="203",
            axis="A-4",
            remarks="Kabeltrasse angepasst",
            material_text="Kabelrinne, Befestiger",
            worker_rows=[
                ExtraWorkWorkerHours(worker_name="Max Monteur", monday_hours=2.5, tuesday_hours=1.25),
                ExtraWorkWorkerHours(worker_name="Erika Elektro", wednesday_hours=3),
            ],
        ),
    )
    loaded_entry = service.get_mobile_ticket_entry(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        current_user=current_user,
    )
    reloaded_ticket = service.get_mobile_ticket(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        current_user=current_user,
    )

    assert entry.component == "BT A"
    assert loaded_entry is not None
    assert loaded_entry.material_text == "Kabelrinne, Befestiger"
    assert loaded_entry.total_hours == 6.75
    assert reloaded_ticket.entry_count == 1
    assert reloaded_ticket.total_hours == 6.75


def test_mobile_extra_work_approval_entry_accepts_estimated_hours():
    db = db_session()
    person = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
    )
    site = Site(
        site_number="8007",
        name="Schüchtermann Klinik",
        requires_extra_work_approval=True,
    )
    db.add_all([person, site])
    db.commit()
    assignment = Assignment(
        person_id=person.id,
        site_id=site.id,
        start_date=date(2026, 6, 11),
        end_date=date(2026, 6, 11),
    )
    db.add(assignment)
    db.commit()
    current_user = SimpleNamespace(id=7, person_id=person.id)
    service = ExtraWorkService(db)

    ticket = service.create_mobile_ticket(
        assignment_id=assignment.id,
        current_user=current_user,
    )
    service.upsert_mobile_ticket_entry(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        current_user=current_user,
        payload=ExtraWorkTicketEntryPayload(
            component="BT A",
            floor="2. OG",
            estimated_hours=12.5,
            worker_rows=[ExtraWorkWorkerHours(worker_name="Max Monteur", monday_hours=0)],
        ),
    )
    reloaded_ticket = service.get_mobile_ticket(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        current_user=current_user,
    )

    assert reloaded_ticket.kind == "approval"
    assert reloaded_ticket.estimated_hours == 12.5


def test_mobile_extra_work_pdf_builds_billing_template_pdf():
    db = db_session()
    person = Person(first_name="Max", last_name="Monteur", display_name="Max Monteur", short_code="MM")
    site = Site(site_number="8007", name="Schüchtermann Klinik", customer="Klinik GmbH")
    db.add_all([person, site])
    db.commit()
    assignment = Assignment(person_id=person.id, site_id=site.id, start_date=date(2026, 6, 11), end_date=date(2026, 6, 11))
    db.add(assignment)
    db.commit()
    current_user = SimpleNamespace(id=7, person_id=person.id)
    service = ExtraWorkService(db)
    ticket = service.create_mobile_ticket(assignment_id=assignment.id, current_user=current_user)
    service.upsert_mobile_ticket_entry(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        current_user=current_user,
        payload=ExtraWorkTicketEntryPayload(
            component="BT A",
            floor="2. OG",
            remarks="Kabeltrasse angepasst",
            material_text="Kabelrinne",
            worker_rows=[ExtraWorkWorkerHours(worker_name="Max Monteur", monday_hours=2.5)],
        ),
    )

    content, filename = ExtraWorkPdfService(db).build_mobile_ticket_pdf(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        current_user=current_user,
    )

    assert content.startswith(b"%PDF")
    assert filename == "Zusatzauftrag_8007_8007.SZ01.pdf"
    assert len(PdfReader(BytesIO(content)).pages) == 1


def test_mobile_extra_work_pdf_splits_four_workers_to_second_template_page():
    db = db_session()
    person = Person(first_name="Max", last_name="Monteur", display_name="Max Monteur", short_code="MM")
    site = Site(site_number="8007", name="Schüchtermann Klinik")
    db.add_all([person, site])
    db.commit()
    assignment = Assignment(person_id=person.id, site_id=site.id, start_date=date(2026, 6, 11), end_date=date(2026, 6, 11))
    db.add(assignment)
    db.commit()
    current_user = SimpleNamespace(id=7, person_id=person.id)
    service = ExtraWorkService(db)
    ticket = service.create_mobile_ticket(assignment_id=assignment.id, current_user=current_user)
    service.upsert_mobile_ticket_entry(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        current_user=current_user,
        payload=ExtraWorkTicketEntryPayload(
            component="BT A",
            floor="2. OG",
            worker_rows=[
                ExtraWorkWorkerHours(worker_name="Monteur 1", monday_hours=1),
                ExtraWorkWorkerHours(worker_name="Monteur 2", tuesday_hours=1),
                ExtraWorkWorkerHours(worker_name="Monteur 3", wednesday_hours=1),
                ExtraWorkWorkerHours(worker_name="Monteur 4", thursday_hours=1),
            ],
        ),
    )

    content, _filename = ExtraWorkPdfService(db).build_mobile_ticket_pdf(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        current_user=current_user,
    )

    assert len(PdfReader(BytesIO(content)).pages) == 2


def test_mobile_extra_work_pdf_builds_approval_template_pdf():
    db = db_session()
    person = Person(first_name="Max", last_name="Monteur", display_name="Max Monteur", short_code="MM")
    site = Site(site_number="8007", name="Schüchtermann Klinik", requires_extra_work_approval=True)
    db.add_all([person, site])
    db.commit()
    assignment = Assignment(person_id=person.id, site_id=site.id, start_date=date(2026, 6, 11), end_date=date(2026, 6, 11))
    db.add(assignment)
    db.commit()
    current_user = SimpleNamespace(id=7, person_id=person.id)
    service = ExtraWorkService(db)
    ticket = service.create_mobile_ticket(assignment_id=assignment.id, current_user=current_user)
    service.upsert_mobile_ticket_entry(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        current_user=current_user,
        payload=ExtraWorkTicketEntryPayload(
            component="BT A",
            floor="2. OG",
            estimated_hours=12.5,
            remarks="Vorabfreigabe Kabeltrasse",
            worker_rows=[ExtraWorkWorkerHours(worker_name="Max Monteur")],
        ),
    )

    content, filename = ExtraWorkPdfService(db).build_mobile_ticket_pdf(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        current_user=current_user,
    )

    assert content.startswith(b"%PDF")
    assert filename == "Zusatzauftrag_8007_8007.SZ01.pdf"
    assert len(PdfReader(BytesIO(content)).pages) == 1


def test_mobile_extra_work_pdf_endpoint_returns_pdf_response():
    db = db_session()
    person = Person(first_name="Max", last_name="Monteur", display_name="Max Monteur", short_code="MM")
    site = Site(site_number="8007", name="Schüchtermann Klinik")
    db.add_all([person, site])
    db.commit()
    assignment = Assignment(person_id=person.id, site_id=site.id, start_date=date(2026, 6, 11), end_date=date(2026, 6, 11))
    db.add(assignment)
    db.commit()
    current_user = SimpleNamespace(id=7, person_id=person.id, role="monteur", is_active=True, must_change_password=False)
    ticket = ExtraWorkService(db).create_mobile_ticket(
        assignment_id=assignment.id,
        current_user=current_user,
    )

    def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_app_user] = lambda: current_user
    try:
        response = TestClient(app).get(
            f"/api/me/assignments/{assignment.id}/extra-work-tickets/{ticket.id}/pdf"
        )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/pdf"
    assert response.content.startswith(b"%PDF")
    assert len(PdfReader(BytesIO(response.content)).pages) == 1
