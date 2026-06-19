from datetime import UTC, date, datetime
from io import BytesIO
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from PIL import Image
from pypdf import PdfReader
from sqlalchemy import create_engine
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
from app.models.extra_work_ticket import ExtraWorkTicketPhoto
from app.models.person import Person
from app.models.project_folder import ProjectFolder
from app.models.site import Site
from app.models.site_email_recipient import SiteEmailRecipient
from app.schemas.extra_work import (
    ExtraWorkCustomerSignatureCreate,
    ExtraWorkSignaturePoint,
    ExtraWorkTicketCreate,
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

    assert suggestion_emails == {"leitung@klinik.example", "kontakt@klinik.example"}
    assert {recipient.email for recipient in updated.recipients} == {"leitung@klinik.example", "neu@kunde.example"}
    assert {recipient.email for recipient in reloaded.recipients} == {"leitung@klinik.example", "neu@kunde.example"}
    assert "neu@kunde.example" in {recipient.email for recipient in reloaded.suggestions}


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


def test_site_extra_work_ticket_can_be_deleted():
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

    assert db.get(extra_work_module.ExtraWorkTicket, ticket.id) is None
    assert service.list_site_tickets(site.id) == []


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


def test_mobile_extra_work_email_send_requires_signatures():
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
    assert error.value.detail == "Kundenunterschrift fehlt."


def test_mobile_extra_work_email_send_delivers_pdf_and_records_audit(monkeypatch):
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
    assert signed.worker_signed_at is not None
    assert reloaded.worker_signature_name == "Max Monteur"
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
    assert b"Fotoanlagen" in content
    assert b"baustelle.png" in content
    assert "Zusatzauftrag 8007.SZ01 - Zusatzarbeiten · Schüchtermann Klinik" in pdf_text


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
