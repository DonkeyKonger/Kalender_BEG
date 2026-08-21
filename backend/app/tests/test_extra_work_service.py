from datetime import UTC, date, datetime
from io import BytesIO
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from PIL import Image
from pypdf import PdfReader
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.api.dependencies import get_current_app_user
from app.core.database import get_db
from app.main import app
from app.models import Base
from app.models.audit_log import AuditLog
from app.models.assignment import Assignment
from app.models.customer import Customer, CustomerContact
from app.models.enums import UserRole
from app.models.extra_work_ticket import ExtraWorkTicket, ExtraWorkTicketEntry, ExtraWorkTicketPhoto
from app.models.person import Person
from app.models.project_folder import ProjectFolder
from app.models.site import Site
from app.models.site_email_recipient import SiteEmailRecipient
from app.models.site_measurement_item import SiteMeasurementBase, SiteMeasurementBatch
from app.models.user import User
from app.schemas.extra_work import (
    ExtraWorkCustomerSignatureCreate,
    ExtraWorkSignaturePoint,
    ExtraWorkTicketCreate,
    ExtraWorkTicketDetailsUpdate,
    ExtraWorkTicketEntryPayload,
    ExtraWorkTicketTitleUpdate,
    ExtraWorkWorkerSignatureCreate,
    ExtraWorkWorkerHours,
)
from app.schemas.site_email_recipient import SiteEmailRecipientPayload, SiteEmailRecipientsUpdate
from app.services.extra_work_pdf_service import ExtraWorkPdfService
from app.services.extra_work_email_service import ExtraWorkEmailService
from app.services import extra_work_email_service as extra_work_email_module
from app.services import extra_work_pdf_service as extra_work_pdf_module
from app.services import extra_work_service as extra_work_module
from app.services.extra_work_service import ExtraWorkService
from app.services.photo_filename import PHOTO_FILENAME_TIMEZONE
from app.services.site_email_recipient_service import SiteEmailRecipientService


def db_session() -> Session:
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return Session(engine)


def sample_photo_bytes() -> bytes:
    buffer = BytesIO()
    Image.new("RGB", (48, 32), color=(36, 76, 128)).save(buffer, format="PNG")
    return buffer.getvalue()


def test_mobile_assignment_email_recipients_use_customer_suggestions_and_persist_selection():
    db = db_session()
    person = Person(first_name="Max", last_name="Monteur", display_name="Max Monteur", short_code="MM")
    site = Site(site_number="8007", name="Schüchtermann Klinik", customer="Klinik GmbH")
    customer = Customer(
        company_name="Klinik GmbH",
        project_lead_name="Kunde Leitung",
        project_lead_email=" Leitung@Klinik.example ",
        is_active=True,
    )
    customer.contacts = [
        CustomerContact(contact_type="bauherr", name="Kunde Kontakt", email="kontakt@klinik.example"),
        CustomerContact(contact_type="intern", name="Ohne Mail", email=None),
    ]
    db.add_all([person, site, customer])
    db.commit()
    assignment = Assignment(person_id=person.id, site_id=site.id, start_date=date(2026, 6, 11), end_date=date(2026, 6, 11))
    db.add(assignment)
    db.commit()
    current_user = SimpleNamespace(id=7, person_id=person.id)
    service = SiteEmailRecipientService(db)

    initial = service.get_for_assignment(assignment_id=assignment.id, current_user=current_user)
    suggestion_emails = {recipient.email for recipient in initial.suggestions}
    updated = service.update_for_assignment(
        assignment_id=assignment.id,
        current_user=current_user,
        payload=SiteEmailRecipientsUpdate(
            recipients=[
                SiteEmailRecipientPayload(email="leitung@klinik.example", label="Kunde Leitung"),
                SiteEmailRecipientPayload(email="neu@kunde.example", label="Neue Adresse"),
            ]
        ),
    )
    reloaded = service.get_for_assignment(assignment_id=assignment.id, current_user=current_user)
    customer_contacts = db.scalars(
        select(CustomerContact).where(CustomerContact.customer_id == customer.id)
    ).all()

    assert suggestion_emails == {"leitung@klinik.example", "kontakt@klinik.example"}
    assert {recipient.email for recipient in updated.recipients} == {"leitung@klinik.example", "neu@kunde.example"}
    assert {recipient.email for recipient in reloaded.recipients} == {"leitung@klinik.example", "neu@kunde.example"}
    assert "neu@kunde.example" in {recipient.email for recipient in reloaded.suggestions}
    assert sum(contact.email == "neu@kunde.example" for contact in customer_contacts) == 1

    service.update_for_assignment(
        assignment_id=assignment.id,
        current_user=current_user,
        payload=SiteEmailRecipientsUpdate(
            recipients=[
                SiteEmailRecipientPayload(email="NEU@kunde.example", label="Neue Adresse doppelt"),
            ]
        ),
    )
    customer_contacts = db.scalars(
        select(CustomerContact).where(CustomerContact.customer_id == customer.id)
    ).all()
    assert sum(contact.email == "neu@kunde.example" for contact in customer_contacts) == 1


def test_mobile_assignment_email_recipients_replace_selection_without_duplicates():
    db = db_session()
    person = Person(first_name="Max", last_name="Monteur", display_name="Max Monteur", short_code="MM")
    site = Site(site_number="8007", name="Schüchtermann Klinik", customer="Klinik GmbH")
    db.add_all([person, site])
    db.commit()
    assignment = Assignment(person_id=person.id, site_id=site.id, start_date=date(2026, 6, 11), end_date=date(2026, 6, 11))
    db.add(assignment)
    db.commit()
    current_user = SimpleNamespace(id=7, person_id=person.id)
    service = SiteEmailRecipientService(db)

    service.update_for_assignment(
        assignment_id=assignment.id,
        current_user=current_user,
        payload=SiteEmailRecipientsUpdate(
            recipients=[
                SiteEmailRecipientPayload(email="kunde@example.de", label="Kunde"),
                SiteEmailRecipientPayload(email="KUNDE@example.de", label="Kunde doppelt"),
            ]
        ),
    )
    replaced = service.update_for_assignment(
        assignment_id=assignment.id,
        current_user=current_user,
        payload=SiteEmailRecipientsUpdate(recipients=[]),
    )

    assert replaced.recipients == []
    assert [recipient.email for recipient in replaced.suggestions] == ["kunde@example.de"]
    assert replaced.suggestions[0].is_selected is False


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


def test_site_extra_work_ticket_delete_moves_ticket_to_archive():
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
    current_user = SimpleNamespace(id=7, person_id=person.id)
    service = ExtraWorkService(db)
    ticket = service.create_site_ticket(
        site_id=site.id,
        current_user=current_user,
        payload=ExtraWorkTicketCreate(),
    )

    service.delete_site_ticket(site_id=site.id, ticket_id=ticket.id, current_user=current_user)

    persisted = db.get(extra_work_module.ExtraWorkTicket, ticket.id)
    assert persisted is not None
    assert persisted.deleted_at is not None
    assert persisted.deleted_by_user_id == current_user.id
    assert service.list_site_tickets(site.id) == []
    assert [entry.id for entry in service.list_site_tickets(site.id, archived_only=True)] == [ticket.id]


def test_manual_extra_work_status_promotion_only_moves_up_and_preserves_signatures():
    class RecordingArchiveService:
        def __init__(self):
            self.calls = []

        def archive_completed_ticket(self, *, site_id, ticket_id):
            self.calls.append((site_id, ticket_id))
            return {"id": "archived-pdf"}

    db = db_session()
    site = Site(site_number="8007", name="Schüchtermann Klinik")
    actor = User(
        username="status-office",
        display_name="Status Büro",
        password_hash="x",
        role=UserRole.OFFICE,
        office_page_permissions=["sites"],
    )
    db.add_all([site, actor])
    db.commit()
    archive_service = RecordingArchiveService()
    service = ExtraWorkService(db, archive_service=archive_service)
    created = service.create_site_ticket(
        site_id=site.id,
        current_user=actor,
        payload=ExtraWorkTicketCreate(),
    )

    submitted = service.promote_site_ticket_status(
        site_id=site.id,
        ticket_id=created.id,
        target_status="submitted",
        current_user=actor,
    )
    assert submitted.status == "submitted"
    assert submitted.customer_signed_at is None

    with pytest.raises(HTTPException) as downgrade:
        service.promote_site_ticket_status(
            site_id=site.id,
            ticket_id=created.id,
            target_status="draft",
            current_user=actor,
        )
    assert downgrade.value.status_code == 400

    with pytest.raises(HTTPException) as signed:
        service.promote_site_ticket_status(
            site_id=site.id,
            ticket_id=created.id,
            target_status="signed",
            current_user=actor,
        )
    assert signed.value.status_code == 400

    stored = db.get(ExtraWorkTicket, created.id)
    stored.status = "signed"
    stored.customer_signature_name = "Kunde Beispiel"
    stored.customer_signed_at = datetime.now(UTC)
    db.commit()
    completed = service.promote_site_ticket_status(
        site_id=site.id,
        ticket_id=created.id,
        target_status="billed",
        current_user=actor,
    )
    assert completed.status == "billed"
    assert completed.customer_signature_name == "Kunde Beispiel"
    assert completed.customer_signed_at is not None
    assert archive_service.calls == [(site.id, created.id)]

    repeated = service.promote_site_ticket_status(
        site_id=site.id,
        ticket_id=created.id,
        target_status="billed",
        current_user=actor,
    )
    assert repeated.status == "billed"
    assert archive_service.calls == [(site.id, created.id), (site.id, created.id)]
    assert db.query(AuditLog).filter_by(action="extra_work.status_promoted").count() == 2


def test_extra_work_archive_failure_does_not_revert_completed_status(caplog):
    class FailingArchiveService:
        def archive_completed_ticket(self, *, site_id, ticket_id):
            raise RuntimeError("Graph temporarily unavailable")

    db = db_session()
    site = Site(site_number="8007", name="Schüchtermann Klinik")
    actor = User(
        username="archive-office",
        display_name="Archiv Büro",
        password_hash="x",
        role=UserRole.OFFICE,
        office_page_permissions=["sites"],
    )
    db.add_all([site, actor])
    db.commit()
    service = ExtraWorkService(db, archive_service=FailingArchiveService())
    ticket = service.create_site_ticket(
        site_id=site.id,
        current_user=actor,
        payload=ExtraWorkTicketCreate(),
    )
    stored = db.get(ExtraWorkTicket, ticket.id)
    stored.status = "signed"
    db.commit()

    with caplog.at_level("ERROR", logger="app.services.extra_work_service"):
        completed = service.promote_site_ticket_status(
            site_id=site.id,
            ticket_id=ticket.id,
            target_status="billed",
            current_user=actor,
        )

    assert completed.status == "billed"
    assert db.get(ExtraWorkTicket, ticket.id).status == "billed"
    assert "Extra-work PDF archive failed after status persistence" in caplog.text
    assert "Graph temporarily unavailable" in caplog.text


def test_manual_submitted_to_completed_status_archives_pdf():
    class RecordingArchiveService:
        def __init__(self):
            self.calls = []

        def archive_completed_ticket(self, *, site_id, ticket_id):
            self.calls.append((site_id, ticket_id))
            return {"id": "archived-pdf"}

    db = db_session()
    site = Site(site_number="9999", name="Testbaustelle Finienweg")
    actor = User(
        username="manual-status-office",
        display_name="Status Büro",
        password_hash="x",
        role=UserRole.OFFICE,
        office_page_permissions=["sites"],
    )
    db.add_all([site, actor])
    db.commit()
    archive_service = RecordingArchiveService()
    service = ExtraWorkService(db, archive_service=archive_service)
    ticket = service.create_site_ticket(
        site_id=site.id,
        current_user=actor,
        payload=ExtraWorkTicketCreate(),
    )
    service.promote_site_ticket_status(
        site_id=site.id,
        ticket_id=ticket.id,
        target_status="submitted",
        current_user=actor,
    )

    completed = service.promote_site_ticket_status(
        site_id=site.id,
        ticket_id=ticket.id,
        target_status="billed",
        current_user=actor,
    )

    assert completed.status == "billed"
    assert archive_service.calls == [(site.id, ticket.id)]


def test_customer_signature_status_alone_does_not_archive_pdf():
    class RecordingArchiveService:
        def __init__(self):
            self.calls = []

        def archive_completed_ticket(self, *, site_id, ticket_id):
            self.calls.append((site_id, ticket_id))

    db = db_session()
    person = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
    )
    site = Site(site_number="9999", name="Testbaustelle Finienweg")
    db.add_all([person, site])
    db.commit()
    assignment = Assignment(
        person_id=person.id,
        site_id=site.id,
        start_date=date(2026, 8, 12),
        end_date=date(2026, 8, 12),
    )
    db.add(assignment)
    db.commit()
    current_user = SimpleNamespace(id=7, person_id=person.id)
    archive_service = RecordingArchiveService()
    service = ExtraWorkService(db, archive_service=archive_service)
    ticket = service.create_mobile_ticket(
        assignment_id=assignment.id,
        current_user=current_user,
    )

    signed = service.sign_mobile_ticket_customer(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        current_user=current_user,
        payload=ExtraWorkCustomerSignatureCreate(
            customer_name="Kunde Beispiel",
            signature_strokes=[[
                ExtraWorkSignaturePoint(x=0.2, y=0.3),
                ExtraWorkSignaturePoint(x=0.7, y=0.5),
            ]],
        ),
    )

    assert signed.status == "signed"
    assert archive_service.calls == []


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
            date_prefix = datetime.now(PHOTO_FILENAME_TIMEZONE).strftime("%y%m%d")
            assert filename == (
                f"{date_prefix}_Schüchtermann_Klinik_"
                "ZusatzauftragSZ01_Max_Monteur_02.jpg"
            )
            assert content.startswith(b"\xff\xd8")
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
    date_prefix = datetime.now(PHOTO_FILENAME_TIMEZONE).strftime("%y%m%d")
    existing_photo = ExtraWorkTicketPhoto(
        site_id=site.id,
        extra_work_ticket_id=ticket.id,
        uploaded_by_user_id=current_user.id,
        project_folder_key="fotos",
        external_drive_id="drive-1",
        external_item_id="existing-photo",
        filename=(
            f"{date_prefix}_Schüchtermann_Klinik_"
            "ZusatzauftragSZ01_Max_Monteur.jpg"
        ),
        content_type="image/jpeg",
        file_size_bytes=100,
    )
    db.add(existing_photo)
    db.commit()

    photo = service.upload_mobile_ticket_photo(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        current_user=current_user,
        filename="baustelle.jpeg",
        content=sample_photo_bytes(),
        content_type="image/jpeg",
    )
    updated_photo = service.update_mobile_ticket_photo_caption(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        photo_id=photo.id,
        caption="Zusätzliche Kabelrinne montiert",
        current_user=current_user,
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
    assert photo.file_size_bytes is not None and photo.file_size_bytes > 0
    assert photo.external_web_url == "https://example.invalid/photo-1"
    assert updated_photo.caption == "Zusätzliche Kabelrinne montiert"
    assert photos[-1].caption == "Zusätzliche Kabelrinne montiert"
    assert [item.id for item in photos] == [existing_photo.id, photo.id]
    assert content == b"downloaded-image"
    assert content_type == "image/jpeg"
    assert filename == "download.jpg"
    assert [item.id for item in service.list_mobile_ticket_photos(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        current_user=current_user,
    )] == [existing_photo.id]


def test_mobile_extra_work_photo_upload_blocks_after_five_photos():
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
    for index in range(5):
        db.add(
            ExtraWorkTicketPhoto(
                site_id=site.id,
                extra_work_ticket_id=ticket.id,
                uploaded_by_user_id=current_user.id,
                project_folder_key="fotos",
                external_drive_id="drive-1",
                external_item_id=f"photo-{index}",
                filename=f"photo-{index}.jpg",
                content_type="image/jpeg",
                file_size_bytes=100,
            )
        )
    db.commit()

    with pytest.raises(HTTPException) as error:
        service.upload_mobile_ticket_photo(
            assignment_id=assignment.id,
            ticket_id=ticket.id,
            current_user=current_user,
            filename="extra.jpg",
            content=b"image-content",
            content_type="image/jpeg",
        )

    assert error.value.status_code == 400
    assert error.value.detail == "Maximal 5 Fotos erlaubt."


def test_site_photo_upload_and_delete_share_mobile_attachment_rows(monkeypatch):
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
    office_user = SimpleNamespace(
        id=7,
        person_id=None,
        role=UserRole.OFFICE,
        person=None,
        display_name="Büro Test",
        username="office",
    )
    mobile_user = SimpleNamespace(
        id=8,
        person_id=person.id,
        role=UserRole.MONTEUR,
        person=person,
        display_name="Max Monteur",
        username="max",
    )

    class FakeProjectStorageService:
        deleted_items: list[str] = []

        def upload_file_to_folder(self, **kwargs):
            return {
                "id": "desktop-photo",
                "name": kwargs["filename"],
                "web_url": "https://example.invalid/desktop-photo",
                "size": len(kwargs["content"]),
            }

        def delete_file_from_folder(self, **kwargs):
            self.deleted_items.append(kwargs["item_id"])

    monkeypatch.setattr(extra_work_module, "ProjectStorageService", FakeProjectStorageService)
    service = ExtraWorkService(db)
    ticket = service.create_site_ticket(
        site_id=site.id,
        current_user=office_user,
        payload=ExtraWorkTicketCreate(),
    )

    uploaded = service.upload_site_ticket_photo(
        site_id=site.id,
        ticket_id=ticket.id,
        current_user=office_user,
        filename="desktop.png",
        content=sample_photo_bytes(),
        content_type="image/png",
    )
    mobile_photos = service.list_mobile_ticket_photos(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        current_user=mobile_user,
    )
    service.delete_site_ticket_photo(
        site_id=site.id,
        ticket_id=ticket.id,
        photo_id=uploaded.id,
        current_user=office_user,
    )

    assert [photo.id for photo in mobile_photos] == [uploaded.id]
    assert mobile_photos[0].content_type == "image/jpeg"
    assert FakeProjectStorageService.deleted_items == ["desktop-photo"]
    assert service.list_mobile_ticket_photos(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        current_user=mobile_user,
    ) == []


def test_signed_ticket_blocks_site_and_mobile_photo_mutations(monkeypatch):
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
    office_user = SimpleNamespace(id=7, person_id=None)
    mobile_user = SimpleNamespace(id=8, person_id=person.id)
    service = ExtraWorkService(db)
    ticket = service.create_site_ticket(
        site_id=site.id,
        current_user=office_user,
        payload=ExtraWorkTicketCreate(),
    )
    photo = ExtraWorkTicketPhoto(
        site_id=site.id,
        extra_work_ticket_id=ticket.id,
        uploaded_by_user_id=office_user.id,
        project_folder_key="fotos",
        external_drive_id="drive-1",
        external_item_id="photo-1",
        filename="photo.jpg",
        content_type="image/jpeg",
        file_size_bytes=100,
    )
    db.add(photo)
    loaded_ticket = db.get(ExtraWorkTicket, ticket.id)
    assert loaded_ticket is not None
    loaded_ticket.customer_signed_at = datetime.now(UTC)
    db.commit()

    class FailingProjectStorageService:
        def __getattr__(self, name):
            raise AssertionError(f"Storage must not be called: {name}")

    monkeypatch.setattr(extra_work_module, "ProjectStorageService", FailingProjectStorageService)

    with pytest.raises(HTTPException) as site_upload_error:
        service.upload_site_ticket_photo(
            site_id=site.id,
            ticket_id=ticket.id,
            current_user=office_user,
            filename="blocked.jpg",
            content=sample_photo_bytes(),
            content_type="image/jpeg",
        )
    with pytest.raises(HTTPException) as mobile_upload_error:
        service.upload_mobile_ticket_photo(
            assignment_id=assignment.id,
            ticket_id=ticket.id,
            current_user=mobile_user,
            filename="blocked.jpg",
            content=sample_photo_bytes(),
            content_type="image/jpeg",
        )
    with pytest.raises(HTTPException) as site_delete_error:
        service.delete_site_ticket_photo(
            site_id=site.id,
            ticket_id=ticket.id,
            photo_id=photo.id,
            current_user=office_user,
        )
    with pytest.raises(HTTPException) as mobile_delete_error:
        service.delete_mobile_ticket_photo(
            assignment_id=assignment.id,
            ticket_id=ticket.id,
            photo_id=photo.id,
            current_user=mobile_user,
        )
    with pytest.raises(HTTPException) as site_caption_error:
        service.update_site_ticket_photo_caption(
            site_id=site.id,
            ticket_id=ticket.id,
            photo_id=photo.id,
            caption="Nicht erlaubt",
        )
    with pytest.raises(HTTPException) as mobile_caption_error:
        service.update_mobile_ticket_photo_caption(
            assignment_id=assignment.id,
            ticket_id=ticket.id,
            photo_id=photo.id,
            caption="Nicht erlaubt",
            current_user=mobile_user,
        )

    assert site_upload_error.value.status_code == 409
    assert mobile_upload_error.value.status_code == 409
    assert site_delete_error.value.status_code == 409
    assert mobile_delete_error.value.status_code == 409
    assert site_caption_error.value.status_code == 409
    assert mobile_caption_error.value.status_code == 409


def test_mobile_extra_work_email_send_requires_selected_recipients():
    db = db_session()
    person = Person(first_name="Max", last_name="Monteur", display_name="Max Monteur", short_code="MM")
    site = Site(site_number="8007", name="Schüchtermann Klinik")
    db.add_all([person, site])
    db.commit()
    assignment = Assignment(person_id=person.id, site_id=site.id, start_date=date(2026, 6, 11), end_date=date(2026, 6, 11))
    db.add(assignment)
    db.commit()
    current_user = SimpleNamespace(id=7, person_id=person.id)
    ticket = ExtraWorkService(db).create_mobile_ticket(assignment_id=assignment.id, current_user=current_user)
    stored_ticket = db.get(extra_work_module.ExtraWorkTicket, ticket.id)
    assert stored_ticket is not None
    stored_ticket.customer_signature_name = "Kunde"
    stored_ticket.customer_signature_strokes = [[{"x": 0.1, "y": 0.1}, {"x": 0.2, "y": 0.2}]]
    stored_ticket.customer_signed_at = datetime(2026, 6, 11, tzinfo=UTC)
    stored_ticket.worker_signature_name = "Max Monteur"
    stored_ticket.worker_signature_strokes = [[{"x": 0.1, "y": 0.1}, {"x": 0.2, "y": 0.2}]]
    stored_ticket.worker_signed_at = datetime(2026, 6, 11, tzinfo=UTC)
    db.commit()

    with pytest.raises(HTTPException) as error:
        ExtraWorkEmailService(db).send_mobile_ticket_email(
            assignment_id=assignment.id,
            ticket_id=ticket.id,
            current_user=current_user,
        )

    assert error.value.status_code == 400
    assert error.value.detail == "Keine E-Mail-Empfänger hinterlegt."


def test_mobile_extra_work_email_send_requires_worker_signature():
    db = db_session()
    person = Person(first_name="Max", last_name="Monteur", display_name="Max Monteur", short_code="MM")
    site = Site(site_number="8007", name="Schüchtermann Klinik")
    db.add_all([person, site])
    db.commit()
    assignment = Assignment(person_id=person.id, site_id=site.id, start_date=date(2026, 6, 11), end_date=date(2026, 6, 11))
    db.add(
        SiteEmailRecipient(
            site_id=site.id,
            email="kunde@example.de",
            label="Kunde",
            source="manual",
            is_selected=True,
        )
    )
    db.add(assignment)
    db.commit()
    current_user = SimpleNamespace(id=7, person_id=person.id)
    ticket = ExtraWorkService(db).create_mobile_ticket(assignment_id=assignment.id, current_user=current_user)

    with pytest.raises(HTTPException) as error:
        ExtraWorkEmailService(db).send_mobile_ticket_email(
            assignment_id=assignment.id,
            ticket_id=ticket.id,
            current_user=current_user,
        )

    assert error.value.status_code == 400
    assert error.value.detail == "Monteursunterschrift fehlt."


def test_mobile_extra_work_email_send_allows_missing_customer_signature(monkeypatch):
    db = db_session()
    person = Person(first_name="Max", last_name="Monteur", display_name="Max Monteur", short_code="MM")
    site = Site(site_number="8007", name="Schüchtermann Klinik")
    db.add_all([person, site])
    db.commit()
    assignment = Assignment(person_id=person.id, site_id=site.id, start_date=date(2026, 6, 11), end_date=date(2026, 6, 11))
    db.add_all([
        assignment,
        SiteEmailRecipient(
            site_id=site.id,
            email="kunde@example.de",
            label="Kunde",
            source="manual",
            is_selected=True,
        ),
    ])
    db.commit()
    current_user = SimpleNamespace(id=7, person_id=person.id)
    ticket = ExtraWorkService(db).create_mobile_ticket(assignment_id=assignment.id, current_user=current_user)
    stored_ticket = db.get(extra_work_module.ExtraWorkTicket, ticket.id)
    assert stored_ticket is not None
    stored_ticket.worker_signature_name = "Max Monteur"
    stored_ticket.worker_signature_strokes = [[{"x": 0.1, "y": 0.1}, {"x": 0.2, "y": 0.2}]]
    stored_ticket.worker_signed_at = datetime(2026, 6, 11, tzinfo=UTC)
    db.commit()
    deliveries = []

    class FakePdfService:
        def __init__(self, db):
            self.db = db

        def build_mobile_ticket_pdf(self, *, assignment_id, ticket_id, current_user):
            return b"%PDF-test", "Stundenzettel_3_Hauptauftrag.pdf"

    class FakeEmailDeliveryService:
        def send_document_email(self, *, recipients, subject, body, attachment):
            deliveries.append({
                "recipients": recipients,
                "subject": subject,
                "body": body,
                "filename": attachment.filename,
                "content": attachment.content,
                "content_type": attachment.content_type,
            })

    monkeypatch.setattr(extra_work_email_module, "ExtraWorkPdfService", FakePdfService)
    monkeypatch.setattr(extra_work_email_module, "EmailDeliveryService", FakeEmailDeliveryService)

    result = ExtraWorkEmailService(db).send_mobile_ticket_email(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        current_user=current_user,
    )

    audit_log = db.query(AuditLog).filter_by(action="extra_work.email_sent").one()
    db.refresh(stored_ticket)
    assert stored_ticket.customer_signed_at is None
    assert result.recipients == ["kunde@example.de"]
    assert result.filename == "Stundenzettel_3_Hauptauftrag.pdf"
    assert deliveries == [
        {
            "recipients": ["kunde@example.de"],
            "subject": "Anliegend erhalten Sie Zusatzauftrag 8007.SZ01 - Schüchtermann Klinik - Hauptauftrag",
            "body": (
                "Sehr geehrte Damen und Herren,\n\n"
                "anliegend erhalten Sie Zusatzauftrag 8007.SZ01 - Schüchtermann Klinik - Hauptauftrag.\n\n"
                "Mit freundlichen Grüßen\n\n"
                "Max Monteur\n\n"
                "BEG Badener Elektro GmbH\n"
                "Firmenweg 16 · 28832 Achim\n"
                "Tel.: +49 4202 97520  |  E-Mail: info@BEG-Achim.de\n"
                "Eingetragen: Amtsgericht Walsrode – HRB 120028\n"
                "Geschäftsführer: Axel Biesewig · Kerstin Erichsen"
            ),
            "filename": "Stundenzettel_3_Hauptauftrag.pdf",
            "content": b"%PDF-test",
            "content_type": "application/pdf",
        }
    ]
    assert audit_log.entity_type == "extra_work_ticket"
    assert audit_log.entity_id == ticket.id
    assert audit_log.new_value_json["recipients"] == ["kunde@example.de"]
    assert audit_log.new_value_json["customer_signature_present"] is False


def test_mobile_extra_work_email_send_delivers_signed_pdf_and_records_audit(monkeypatch):
    db = db_session()
    person = Person(first_name="Max", last_name="Monteur", display_name="Max Monteur", short_code="MM")
    site = Site(site_number="8007", name="Schüchtermann Klinik")
    db.add_all([person, site])
    db.commit()
    assignment = Assignment(person_id=person.id, site_id=site.id, start_date=date(2026, 6, 11), end_date=date(2026, 6, 11))
    db.add_all([
        assignment,
        SiteEmailRecipient(
            site_id=site.id,
            email="kunde@example.de",
            label="Kunde",
            source="manual",
            is_selected=True,
        ),
    ])
    db.commit()
    current_user = SimpleNamespace(id=7, person_id=person.id)
    ticket = ExtraWorkService(db).create_mobile_ticket(assignment_id=assignment.id, current_user=current_user)
    stored_ticket = db.get(extra_work_module.ExtraWorkTicket, ticket.id)
    assert stored_ticket is not None
    stored_ticket.customer_signature_name = "Kunde"
    stored_ticket.customer_signature_strokes = [[{"x": 0.1, "y": 0.1}, {"x": 0.2, "y": 0.2}]]
    stored_ticket.customer_signed_at = datetime(2026, 6, 11, tzinfo=UTC)
    stored_ticket.worker_signature_name = "Max Monteur"
    stored_ticket.worker_signature_strokes = [[{"x": 0.1, "y": 0.1}, {"x": 0.2, "y": 0.2}]]
    stored_ticket.worker_signed_at = datetime(2026, 6, 11, tzinfo=UTC)
    db.commit()
    deliveries = []

    class FakePdfService:
        def __init__(self, db):
            self.db = db

        def build_mobile_ticket_pdf(self, *, assignment_id, ticket_id, current_user):
            return b"%PDF-test", "Stundenzettel_3_Hauptauftrag.pdf"

    class FakeEmailDeliveryService:
        def send_document_email(self, *, recipients, subject, body, attachment):
            deliveries.append({
                "recipients": recipients,
                "subject": subject,
                "filename": attachment.filename,
                "content": attachment.content,
                "content_type": attachment.content_type,
            })

    monkeypatch.setattr(extra_work_email_module, "ExtraWorkPdfService", FakePdfService)
    monkeypatch.setattr(extra_work_email_module, "EmailDeliveryService", FakeEmailDeliveryService)

    result = ExtraWorkEmailService(db).send_mobile_ticket_email(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        current_user=current_user,
    )

    audit_log = db.query(AuditLog).filter_by(action="extra_work.email_sent").one()
    assert result.recipients == ["kunde@example.de"]
    assert result.filename == "Stundenzettel_3_Hauptauftrag.pdf"
    assert deliveries[0]["recipients"] == ["kunde@example.de"]
    assert deliveries[0]["content"] == b"%PDF-test"
    assert deliveries[0]["content_type"] == "application/pdf"
    assert audit_log.entity_type == "extra_work_ticket"
    assert audit_log.entity_id == ticket.id
    assert audit_log.new_value_json["customer_signature_present"] is True


def test_mobile_measurement_email_send_allows_submitted_batch_without_customer_signature(monkeypatch):
    db = db_session()
    person = Person(first_name="Max", last_name="Monteur", display_name="Max Monteur", short_code="MM")
    site = Site(site_number="8007", name="Schüchtermann Klinik")
    db.add_all([person, site])
    db.commit()
    measurement_base = SiteMeasurementBase(site_id=site.id, name="Aufmaßblatt Bestand")
    assignment = Assignment(person_id=person.id, site_id=site.id, start_date=date(2026, 6, 11), end_date=date(2026, 6, 11))
    batch = SiteMeasurementBatch(
        site_id=site.id,
        measurement_base=measurement_base,
        number=1,
        title="Aufmaß 8007.01",
        status="submitted",
        submitted_at=datetime(2026, 6, 11, tzinfo=UTC),
    )
    db.add_all([
        measurement_base,
        assignment,
        batch,
        SiteEmailRecipient(
            site_id=site.id,
            email="kunde@example.de",
            label="Kunde",
            source="manual",
            is_selected=True,
        ),
    ])
    db.commit()
    current_user = SimpleNamespace(id=7, person_id=person.id)
    deliveries = []

    class FakePdfService:
        def __init__(self, db):
            self.db = db

        def build_batch_pdf(self, *, site_id, batch_id, mode):
            return b"%PDF-measurement", "Aufmass_geprueft_8007.01.pdf"

    class FakeEmailDeliveryService:
        def send_document_email(self, *, recipients, subject, body, attachment):
            deliveries.append({
                "recipients": recipients,
                "subject": subject,
                "filename": attachment.filename,
                "content": attachment.content,
                "content_type": attachment.content_type,
            })

    monkeypatch.setattr(extra_work_email_module, "MeasurementPdfService", FakePdfService)
    monkeypatch.setattr(extra_work_email_module, "EmailDeliveryService", FakeEmailDeliveryService)

    result = ExtraWorkEmailService(db).send_mobile_measurement_batch_email(
        assignment_id=assignment.id,
        batch_id=batch.id,
        current_user=current_user,
    )

    db.refresh(batch)
    audit_log = db.query(AuditLog).filter_by(action="measurement.email_sent").one()
    assert batch.status == "submitted"
    assert batch.worker_signed_at is None
    assert batch.customer_signed_at is None
    assert result.recipients == ["kunde@example.de"]
    assert result.filename == "Aufmass_geprueft_8007.01.pdf"
    assert deliveries[0]["recipients"] == ["kunde@example.de"]
    assert deliveries[0]["content"] == b"%PDF-measurement"
    assert deliveries[0]["content_type"] == "application/pdf"
    assert audit_log.new_value_json["customer_signature_present"] is False


def test_site_extra_work_tickets_include_customer_email_status():
    db = db_session()
    site = Site(site_number="8007", name="Schüchtermann Klinik")
    db.add(site)
    db.commit()
    ticket = ExtraWorkTicket(
        site_id=site.id,
        sequence_number=1,
        display_number="8007.SZ01",
        title="Hauptauftrag",
        kind="billing",
        status="submitted",
    )
    db.add(ticket)
    db.commit()
    db.add(
        AuditLog(
            user_id=None,
            action="extra_work.email_sent",
            entity_type="extra_work_ticket",
            entity_id=ticket.id,
            old_value_json=None,
            new_value_json={
                "recipients": ["kunde@example.de"],
                "customer_signature_present": True,
            },
        )
    )
    db.commit()

    [read_ticket] = ExtraWorkService(db).list_site_tickets(site.id)

    assert read_ticket.customer_email_sent_at is not None
    assert read_ticket.customer_email_signature_present is True


def test_extra_work_ticket_archive_preserves_data_filters_mobile_and_restores_idempotently():
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
    deleting_user = User(
        username="archive-admin",
        display_name="Archiv Admin",
        password_hash="test",
        role=UserRole.ADMIN,
        person_id=person.id,
    )
    second_user = User(
        username="project-manager",
        display_name="Projekt Leitung",
        password_hash="test",
        role=UserRole.PROJECT_MANAGER,
    )
    db.add_all([deleting_user, second_user])
    db.commit()
    assignment = Assignment(
        person_id=person.id,
        site_id=site.id,
        start_date=date(2026, 8, 18),
        end_date=date(2026, 8, 18),
    )
    ticket = ExtraWorkTicket(
        site_id=site.id,
        sequence_number=3,
        display_number="8007.SZ03",
        title="Brandschott nacharbeiten",
        kind="billing",
        status="signed",
        created_by_user_id=deleting_user.id,
        submitted_by_user_id=deleting_user.id,
        submitted_at=datetime(2026, 8, 18, 8, 30, tzinfo=UTC),
        notes="Abstimmung mit Bauleitung erfolgt.",
        customer_signature_type="billing_customer",
        customer_signature_name="Kunde Beispiel",
        customer_signature_place="Bretten",
        customer_signature_strokes=[[{"x": 0.1, "y": 0.2}]],
        customer_signed_at=datetime(2026, 8, 18, 12, 0, tzinfo=UTC),
        worker_signature_name="Max Monteur",
        worker_signature_strokes=[[{"x": 0.2, "y": 0.3}]],
        worker_signed_at=datetime(2026, 8, 18, 11, 50, tzinfo=UTC),
    )
    ticket.entries = [
        ExtraWorkTicketEntry(
            site_id=site.id,
            component="Brandschott",
            floor="2. OG",
            room_number="204",
            remarks="Nacharbeit",
            material_text="Mörtel",
            estimated_hours=2,
            worker_rows=[{"worker_name": "Max Monteur", "monday_hours": 2.5}],
            created_by_user_id=deleting_user.id,
        )
    ]
    ticket.photos = [
        ExtraWorkTicketPhoto(
            site_id=site.id,
            uploaded_by_user_id=deleting_user.id,
            project_folder_key="fotos",
            external_drive_id="drive-1",
            external_item_id="photo-1",
            external_web_url="https://example.test/photo-1",
            filename="nacharbeit.jpg",
            content_type="image/jpeg",
            file_size_bytes=1234,
        )
    ]
    db.add_all([assignment, ticket])
    db.commit()
    db.add(
        AuditLog(
            user_id=deleting_user.id,
            action="extra_work.email_sent",
            entity_type="extra_work_ticket",
            entity_id=ticket.id,
            old_value_json=None,
            new_value_json={
                "recipients": ["kunde@example.de"],
                "customer_signature_present": True,
            },
        )
    )
    db.commit()

    service = ExtraWorkService(db)
    service.delete_site_ticket(
        site_id=site.id,
        ticket_id=ticket.id,
        current_user=deleting_user,
    )

    persisted = db.get(ExtraWorkTicket, ticket.id)
    assert persisted is not None
    assert persisted.deleted_at is not None
    assert persisted.deleted_by_user_id == deleting_user.id
    assert service.list_site_tickets(site.id) == []
    assert service.list_mobile_tickets(
        assignment_id=assignment.id,
        current_user=deleting_user,
    ) == []
    [archived] = service.list_site_tickets(site.id, archived_only=True)
    assert archived.id == ticket.id
    assert archived.display_number == "8007.SZ03"
    assert archived.status == "signed"
    assert archived.entry_count == 1
    assert archived.photo_count == 1
    assert archived.total_hours == 2.5
    assert archived.deleted_by_name == "Max Monteur"
    assert archived.customer_email_sent_at is not None
    assert archived.customer_email_signature_present is True

    restored = service.restore_site_ticket(site_id=site.id, ticket_id=ticket.id)
    restored_again = service.restore_site_ticket(site_id=site.id, ticket_id=ticket.id)

    assert restored.id == ticket.id
    assert restored_again.id == ticket.id
    assert restored.display_number == "8007.SZ03"
    assert restored.status == "signed"
    assert restored.deleted_at is None
    assert restored.deleted_by_user_id is None
    assert restored.entry_count == 1
    assert restored.photo_count == 1
    assert restored.total_hours == 2.5
    assert db.query(ExtraWorkTicket).filter_by(id=ticket.id).count() == 1
    assert db.query(ExtraWorkTicketEntry).filter_by(ticket_id=ticket.id).count() == 1
    assert db.query(ExtraWorkTicketPhoto).filter_by(extra_work_ticket_id=ticket.id).count() == 1
    restored_model = db.get(ExtraWorkTicket, ticket.id)
    assert restored_model is not None
    assert restored_model.notes == "Abstimmung mit Bauleitung erfolgt."
    assert restored_model.customer_signature_name == "Kunde Beispiel"
    assert restored_model.worker_signature_name == "Max Monteur"

    service.delete_site_ticket(
        site_id=site.id,
        ticket_id=ticket.id,
        current_user=second_user,
    )
    [archived_again] = service.list_site_tickets(site.id, archived_only=True)
    assert archived_again.deleted_by_user_id == second_user.id
    assert archived_again.deleted_by_name == "Projekt Leitung"
    with pytest.raises(HTTPException) as exc_info:
        service.delete_site_ticket(
            site_id=site.id,
            ticket_id=ticket.id,
            current_user=second_user,
        )
    assert exc_info.value.status_code == 404


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
        street="Klinikweg",
        house_number="8",
        postal_code="77815",
        city="Bühl",
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
    assert signed.customer_signature_place == "Klinikweg 8, 77815 Bühl"


def test_mobile_extra_work_worker_signature_persists_without_status_change():
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

    signed = service.sign_mobile_ticket_worker(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        current_user=current_user,
        payload=ExtraWorkWorkerSignatureCreate(
            worker_name="Max",
            signature_strokes=[[
                ExtraWorkSignaturePoint(x=0.1, y=0.4),
                ExtraWorkSignaturePoint(x=0.7, y=0.45),
            ]],
        ),
    )
    reloaded = service.get_mobile_ticket(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        current_user=current_user,
    )

    assert signed.status == "draft"
    assert signed.worker_signature_name == "Max Monteur"
    assert signed.worker_signature_date is not None
    assert signed.worker_signed_at is not None
    assert reloaded.worker_signature_name == "Max Monteur"
    assert reloaded.worker_signature_date == signed.worker_signature_date
    assert reloaded.worker_signed_at == signed.worker_signed_at


def test_mobile_extra_work_ticket_title_can_be_updated_and_cleared_while_draft():
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

    renamed = service.update_mobile_ticket_title(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        current_user=current_user,
        payload=ExtraWorkTicketTitleUpdate(title=" Nachtrag Kabeltrasse 2. OG "),
    )
    cleared = service.update_mobile_ticket_title(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        current_user=current_user,
        payload=ExtraWorkTicketTitleUpdate(title=" "),
    )

    assert renamed.title == "Nachtrag Kabeltrasse 2. OG"
    assert cleared.title is None


def test_mobile_extra_work_ticket_title_is_locked_after_customer_signature():
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
    service.sign_mobile_ticket_customer(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        current_user=current_user,
        payload=ExtraWorkCustomerSignatureCreate(
            customer_name="Kunde Beispiel",
            signature_strokes=[[
                ExtraWorkSignaturePoint(x=0.2, y=0.3),
                ExtraWorkSignaturePoint(x=0.7, y=0.5),
            ]],
        ),
    )

    with pytest.raises(Exception) as blocked_update:
        service.update_mobile_ticket_title(
            assignment_id=assignment.id,
            ticket_id=ticket.id,
            current_user=current_user,
            payload=ExtraWorkTicketTitleUpdate(title="Nachtrag"),
        )

    assert getattr(blocked_update.value, "status_code", None) == 409


def test_mobile_extra_work_details_persist_after_worker_signature_and_submission_without_touching_signatures():
    db = db_session()
    person = Person(first_name="Max", last_name="Monteur", display_name="Max Monteur", short_code="MM")
    site = Site(site_number="8007", name="Schüchtermann Klinik")
    db.add_all([person, site])
    db.commit()
    assignment = Assignment(
        person_id=person.id,
        site_id=site.id,
        start_date=date(2026, 8, 11),
        end_date=date(2026, 8, 11),
    )
    db.add(assignment)
    db.commit()
    current_user = SimpleNamespace(id=7, person_id=person.id)
    service = ExtraWorkService(db)
    ticket = service.create_mobile_ticket(assignment_id=assignment.id, current_user=current_user)
    worker_signed = service.sign_mobile_ticket_worker(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        current_user=current_user,
        payload=ExtraWorkWorkerSignatureCreate(
            worker_name="Max Monteur",
            signature_strokes=[[
                ExtraWorkSignaturePoint(x=0.1, y=0.4),
                ExtraWorkSignaturePoint(x=0.7, y=0.45),
            ]],
        ),
    )
    submitted = service.submit_mobile_ticket(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        current_user=current_user,
    )

    updated = service.update_mobile_ticket_details(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        current_user=current_user,
        payload=ExtraWorkTicketDetailsUpdate(
            manual_order_date=date(2026, 8, 4),
            manual_execution_week=1,
            manual_execution_week_year=2027,
        ),
    )
    reloaded = service.get_mobile_ticket(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        current_user=current_user,
    )

    assert updated.status == submitted.status == "submitted"
    assert updated.worker_signature_name == "Max Monteur"
    assert updated.worker_signed_at == worker_signed.worker_signed_at
    assert updated.manual_order_date == date(2026, 8, 4)
    assert updated.manual_execution_week == 1
    assert updated.manual_execution_week_year == 2027
    assert reloaded.manual_order_date == date(2026, 8, 4)


def test_mobile_extra_work_details_are_locked_after_customer_signature():
    db = db_session()
    person = Person(first_name="Max", last_name="Monteur", display_name="Max Monteur", short_code="MM")
    site = Site(site_number="8007", name="Schüchtermann Klinik")
    db.add_all([person, site])
    db.commit()
    assignment = Assignment(
        person_id=person.id,
        site_id=site.id,
        start_date=date(2026, 8, 11),
        end_date=date(2026, 8, 11),
    )
    db.add(assignment)
    db.commit()
    current_user = SimpleNamespace(id=7, person_id=person.id)
    service = ExtraWorkService(db)
    ticket = service.create_mobile_ticket(assignment_id=assignment.id, current_user=current_user)
    service.sign_mobile_ticket_customer(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        current_user=current_user,
        payload=ExtraWorkCustomerSignatureCreate(
            customer_name="Kunde Beispiel",
            signature_strokes=[[
                ExtraWorkSignaturePoint(x=0.2, y=0.3),
                ExtraWorkSignaturePoint(x=0.7, y=0.5),
            ]],
        ),
    )

    with pytest.raises(HTTPException) as blocked_update:
        service.update_mobile_ticket_details(
            assignment_id=assignment.id,
            ticket_id=ticket.id,
            current_user=current_user,
            payload=ExtraWorkTicketDetailsUpdate(manual_order_date=date(2026, 8, 4)),
        )

    assert blocked_update.value.status_code == 409


def test_mobile_extra_work_details_endpoint_rejects_invalid_weeks_and_customer_signed_updates():
    db = db_session()
    person = Person(first_name="Max", last_name="Monteur", display_name="Max Monteur", short_code="MM")
    site = Site(site_number="8007", name="Schüchtermann Klinik")
    db.add_all([person, site])
    db.commit()
    assignment = Assignment(
        person_id=person.id,
        site_id=site.id,
        start_date=date(2026, 8, 11),
        end_date=date(2026, 8, 11),
    )
    db.add(assignment)
    db.commit()
    current_user = SimpleNamespace(
        id=7,
        person_id=person.id,
        role="monteur",
        is_active=True,
        must_change_password=False,
    )
    service = ExtraWorkService(db)
    ticket = service.create_mobile_ticket(assignment_id=assignment.id, current_user=current_user)

    def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_app_user] = lambda: current_user
    endpoint = f"/api/me/assignments/{assignment.id}/extra-work-tickets/{ticket.id}/details"
    try:
        invalid_response = TestClient(app).patch(
            endpoint,
            json={"manual_execution_week": 53, "manual_execution_week_year": 2025},
        )
        assert invalid_response.status_code == 422

        service.sign_mobile_ticket_customer(
            assignment_id=assignment.id,
            ticket_id=ticket.id,
            current_user=current_user,
            payload=ExtraWorkCustomerSignatureCreate(
                customer_name="Kunde Beispiel",
                signature_strokes=[[
                    ExtraWorkSignaturePoint(x=0.2, y=0.3),
                    ExtraWorkSignaturePoint(x=0.7, y=0.5),
                ]],
            ),
        )
        locked_response = TestClient(app).patch(
            endpoint,
            json={"manual_order_date": "2026-08-04"},
        )
        assert locked_response.status_code == 409
        assert "Kundenunterschrift" in locked_response.json()["detail"]
    finally:
        app.dependency_overrides.clear()


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
    service.update_mobile_ticket_title(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        current_user=current_user,
        payload=ExtraWorkTicketTitleUpdate(title="Nachtrag Kabeltrasse 2. OG"),
    )
    service.sign_mobile_ticket_worker(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        current_user=current_user,
        payload=ExtraWorkWorkerSignatureCreate(
            worker_name="Max Monteur",
            signature_strokes=[[
                ExtraWorkSignaturePoint(x=0.1, y=0.4),
                ExtraWorkSignaturePoint(x=0.7, y=0.45),
            ]],
        ),
    )
    service.sign_mobile_ticket_customer(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        current_user=current_user,
        payload=ExtraWorkCustomerSignatureCreate(
            customer_name="Kunde Beispiel",
            customer_place="Klinikweg 8, 77815 Bühl",
            signature_strokes=[[
                ExtraWorkSignaturePoint(x=0.2, y=0.3),
                ExtraWorkSignaturePoint(x=0.8, y=0.5),
            ]],
        ),
    )

    content, filename = ExtraWorkPdfService(db).build_mobile_ticket_pdf(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        current_user=current_user,
    )

    assert content.startswith(b"%PDF")
    assert filename == "Zusatzauftrag_8007_8007.SZ01.pdf"
    pdf_reader = PdfReader(BytesIO(content))
    pdf_text = "\n".join(page.extract_text() or "" for page in pdf_reader.pages)
    assert len(pdf_reader.pages) == 1
    assert b"Unterschrift Kunde" not in content
    assert "Nachtrag Kabeltrasse 2. OG" in pdf_text
    assert "Kunde Beispiel" in pdf_text
    assert "Name: Max Monteur" not in pdf_text
    assert "Name: Kunde Beispiel" not in pdf_text
    assert "Unterschrift Kunde" not in pdf_text


def test_mobile_extra_work_pdf_uses_manual_order_date_and_iso_week_period():
    db = db_session()
    person = Person(first_name="Max", last_name="Monteur", display_name="Max Monteur", short_code="MM")
    site = Site(site_number="9999", name="Testbaustelle Finienweg", customer="Kunde GmbH")
    db.add_all([person, site])
    db.commit()
    assignment = Assignment(
        person_id=person.id,
        site_id=site.id,
        start_date=date(2026, 8, 11),
        end_date=date(2026, 8, 11),
    )
    db.add(assignment)
    db.commit()
    current_user = SimpleNamespace(id=7, person_id=person.id)
    service = ExtraWorkService(db)
    ticket = service.create_mobile_ticket(assignment_id=assignment.id, current_user=current_user)
    updated = service.update_mobile_ticket_details(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        current_user=current_user,
        payload=ExtraWorkTicketDetailsUpdate(
            manual_order_date=date(2026, 8, 4),
            manual_execution_week=1,
            manual_execution_week_year=2027,
        ),
    )

    content, _filename = ExtraWorkPdfService(db).build_mobile_ticket_pdf(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        current_user=current_user,
    )
    pdf_text = "\n".join(page.extract_text() or "" for page in PdfReader(BytesIO(content)).pages)

    assert updated.manual_order_date == date(2026, 8, 4)
    assert "04.08.2026" in pdf_text
    assert "04.01.2027" in pdf_text
    assert "10.01.2027" in pdf_text


def test_extra_work_pdf_is_available_again_after_restore():
    db = db_session()
    person = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
    )
    site = Site(site_number="8007", name="Schüchtermann Klinik", customer="Klinik GmbH")
    db.add_all([person, site])
    db.commit()
    assignment = Assignment(
        person_id=person.id,
        site_id=site.id,
        start_date=date(2026, 8, 18),
        end_date=date(2026, 8, 18),
    )
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
            component="Brandschott",
            floor="EG",
            remarks="Nacharbeit",
            worker_rows=[ExtraWorkWorkerHours(worker_name="Max Monteur", monday_hours=2.5)],
        ),
    )
    submitted = service.update_mobile_ticket_status(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        next_status="submitted",
        current_user=current_user,
    )
    service.delete_site_ticket(
        site_id=site.id,
        ticket_id=ticket.id,
        current_user=current_user,
    )

    with pytest.raises(HTTPException) as archived_pdf_error:
        ExtraWorkPdfService(db).build_site_ticket_pdf(site_id=site.id, ticket_id=ticket.id)
    assert archived_pdf_error.value.status_code == 404

    restored = service.restore_site_ticket(site_id=site.id, ticket_id=ticket.id)
    content, filename = ExtraWorkPdfService(db).build_site_ticket_pdf(
        site_id=site.id,
        ticket_id=ticket.id,
    )

    assert restored.id == submitted.id
    assert restored.display_number == submitted.display_number
    assert restored.status == submitted.status
    assert restored.total_hours == 2.5
    assert content.startswith(b"%PDF")
    assert filename == "Zusatzauftrag_8007_8007.SZ01.pdf"


def test_mobile_extra_work_pdf_appends_uploaded_photos(monkeypatch):
    db = db_session()
    person = Person(first_name="Max", last_name="Monteur", display_name="Max Monteur", short_code="MM")
    site = Site(site_number="8007", name="Schüchtermann Klinik", customer="Klinik GmbH")
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
    db.add(
        ExtraWorkTicketPhoto(
            site_id=site.id,
            extra_work_ticket_id=ticket.id,
            project_folder_key="fotos",
            external_drive_id="drive-1",
            external_item_id="photo-1",
            filename="baustelle.png",
            content_type="image/png",
            file_size_bytes=128,
            caption="Kabeltrasse im 2. OG dokumentiert",
        )
    )
    db.commit()
    photo_bytes = sample_photo_bytes()

    class FakeProjectStorageService:
        def download_file_from_folder(self, *, drive_id, folder_item_id, item_id):
            assert drive_id == "drive-1"
            assert folder_item_id == "folder-1"
            assert item_id == "photo-1"
            return {
                "content": photo_bytes,
                "content_type": "image/png",
                "filename": "baustelle.png",
            }

    monkeypatch.setattr(extra_work_pdf_module, "ProjectStorageService", FakeProjectStorageService)

    content, filename = ExtraWorkPdfService(db).build_mobile_ticket_pdf(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        current_user=current_user,
    )

    assert filename == "Zusatzauftrag_8007_8007.SZ01.pdf"
    pdf_reader = PdfReader(BytesIO(content))
    pdf_text = "\n".join(page.extract_text() or "" for page in pdf_reader.pages)
    assert len(pdf_reader.pages) == 2
    assert "Fotoanlage" in pdf_text
    assert "Zusatzauftrag Nr.:" in pdf_text
    assert "Kabeltrasse im 2. OG dokumentiert" in pdf_text
    assert "baustelle.png" in pdf_text
    assert "Zusatzarbeiten" in pdf_text
    assert "Schüchtermann Klinik" in pdf_text


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
