from datetime import date
from io import BytesIO
from types import SimpleNamespace

import pytest
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
from app.models.enums import UserRole
from app.models.person import Person
from app.models.project_folder import ProjectFolder
from app.models.site import Site
from app.schemas.extra_work import (
    ExtraWorkCustomerSignatureCreate,
    ExtraWorkSignaturePoint,
    ExtraWorkTicketCreate,
    ExtraWorkTicketEntryPayload,
    ExtraWorkWorkerHours,
)
from app.services.extra_work_pdf_service import ExtraWorkPdfService
from app.services import extra_work_service as extra_work_module
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


def test_mobile_extra_work_ticket_photos_persist_and_use_project_photo_folder(monkeypatch):
    db = db_session()
    person = Person(first_name="Max", last_name="Monteur", display_name="Max Monteur", short_code="MM")
    site = Site(site_number="8007", name="Schüchtermann Klinik")
    db.add_all([person, site])
    db.commit()
    assignment = Assignment(person_id=person.id, site_id=site.id, start_date=date(2026, 6, 11), end_date=date(2026, 6, 11))
    photo_folder = ProjectFolder(
        site_id=site.id,
        sort_order=14,
        name="Fotos",
        folder_key="fotos",
        is_active=True,
        external_drive_id="drive-1",
        external_item_id="folder-1",
    )
    db.add_all([assignment, photo_folder])
    db.commit()
    current_user = SimpleNamespace(
        id=7,
        person_id=person.id,
        role=UserRole.MONTEUR,
        person=person,
        display_name="Max Monteur",
        username="max",
    )

    class FakeProjectStorageService:
        deleted_items: list[str] = []

        def upload_file_to_folder(self, *, drive_id, folder_item_id, filename, content, content_type):
            assert drive_id == "drive-1"
            assert folder_item_id == "folder-1"
            assert filename.startswith("Stundenzettel-8007-SZ01_")
            assert content == b"image-content"
            assert content_type == "image/jpeg"
            return {
                "id": "photo-1",
                "name": filename,
                "web_url": "https://example.invalid/photo-1",
                "size": len(content),
            }

        def download_file_from_folder(self, *, drive_id, folder_item_id, item_id):
            assert drive_id == "drive-1"
            assert folder_item_id == "folder-1"
            assert item_id == "photo-1"
            return {
                "content": b"downloaded-image",
                "content_type": "image/jpeg",
                "filename": "download.jpg",
            }

        def delete_file_from_folder(self, *, drive_id, folder_item_id, item_id):
            assert drive_id == "drive-1"
            assert folder_item_id == "folder-1"
            self.deleted_items.append(item_id)

    monkeypatch.setattr(extra_work_module, "ProjectStorageService", FakeProjectStorageService)
    service = ExtraWorkService(db)
    ticket = service.create_mobile_ticket(assignment_id=assignment.id, current_user=current_user)

    photo = service.upload_mobile_ticket_photo(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        current_user=current_user,
        filename="baustelle.jpeg",
        content=b"image-content",
        content_type="image/jpeg",
    )
    photos = service.list_mobile_ticket_photos(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        current_user=current_user,
    )
    content, content_type, filename = service.get_mobile_ticket_photo_content(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        photo_id=photo.id,
        current_user=current_user,
    )
    service.delete_mobile_ticket_photo(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        photo_id=photo.id,
        current_user=current_user,
    )

    assert photo.extra_work_ticket_id == ticket.id
    assert photo.file_size_bytes == len(b"image-content")
    assert photo.external_web_url == "https://example.invalid/photo-1"
    assert [item.id for item in photos] == [photo.id]
    assert content == b"downloaded-image"
    assert content_type == "image/jpeg"
    assert filename == "download.jpg"
    assert service.list_mobile_ticket_photos(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        current_user=current_user,
    ) == []


def test_mobile_extra_work_billing_customer_signature_persists_and_signs_ticket():
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

    signed = service.sign_mobile_ticket_customer(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        current_user=current_user,
        payload=ExtraWorkCustomerSignatureCreate(
            customer_name="Kunde Beispiel",
            customer_place="Bad Herrenalb",
            signature_strokes=[[
                ExtraWorkSignaturePoint(x=0.1, y=0.4),
                ExtraWorkSignaturePoint(x=0.6, y=0.45),
            ]],
        ),
    )
    reloaded = service.get_mobile_ticket(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        current_user=current_user,
    )

    assert signed.status == "signed"
    assert signed.customer_signature_type == "billing_customer"
    assert signed.customer_signature_name == "Kunde Beispiel"
    assert signed.customer_signature_place == "Bad Herrenalb"
    assert signed.customer_signed_at is not None
    assert reloaded.status == "signed"
    assert reloaded.customer_signed_at == signed.customer_signed_at


def test_mobile_extra_work_approval_customer_signature_uses_approval_signature_type():
    db = db_session()
    person = Person(first_name="Max", last_name="Monteur", display_name="Max Monteur", short_code="MM")
    site = Site(
        site_number="8007",
        name="Schüchtermann Klinik",
        requires_extra_work_approval=True,
    )
    db.add_all([person, site])
    db.commit()
    assignment = Assignment(person_id=person.id, site_id=site.id, start_date=date(2026, 6, 11), end_date=date(2026, 6, 11))
    db.add(assignment)
    db.commit()
    current_user = SimpleNamespace(id=7, person_id=person.id)
    service = ExtraWorkService(db)
    ticket = service.create_mobile_ticket(assignment_id=assignment.id, current_user=current_user)

    signed = service.sign_mobile_ticket_customer(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        current_user=current_user,
        payload=ExtraWorkCustomerSignatureCreate(
            customer_name="Kunde Freigabe",
            signature_strokes=[[
                ExtraWorkSignaturePoint(x=0.2, y=0.3),
                ExtraWorkSignaturePoint(x=0.7, y=0.5),
            ]],
        ),
    )

    assert signed.kind == "approval"
    assert signed.status == "signed"
    assert signed.customer_signature_type == "approval_customer"


def test_mobile_extra_work_customer_signature_rejects_empty_signature():
    with pytest.raises(ValueError):
        ExtraWorkCustomerSignatureCreate(
            customer_name="Kunde",
            signature_strokes=[[ExtraWorkSignaturePoint(x=0.2, y=0.3)]],
        )


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
