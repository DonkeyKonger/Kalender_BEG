from datetime import date

from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.models import Base
from app.models.extra_work_ticket import ExtraWorkTicket
from app.models.site import Site
from app.services.extra_work_archive_service import ExtraWorkArchiveService


def db_session() -> Session:
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return Session(engine)


class CurrentDataPdfService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.calls = []

    def build_site_ticket_pdf(self, *, site_id: int, ticket_id: int):
        self.calls.append((site_id, ticket_id))
        ticket = self.db.get(ExtraWorkTicket, ticket_id)
        content = (
            f"status={ticket.status};order_date={ticket.manual_order_date};"
            f"week={ticket.manual_execution_week}/{ticket.manual_execution_week_year}"
        ).encode()
        return content, "Zusatzauftrag_9999_9999.SZ03.pdf"


class RecordingStorageService:
    def __init__(self) -> None:
        self.calls = []

    def upload_extra_work_archive_pdf(self, **kwargs):
        self.calls.append(kwargs)
        return {"id": "archive-file-1", "name": kwargs["filename"]}


def test_signed_extra_work_ticket_is_not_archived():
    db = db_session()
    site = Site(
        site_number="9999",
        name="Testbaustelle",
        project_folder_id="project-root-1",
    )
    ticket = ExtraWorkTicket(
        site=site,
        sequence_number=3,
        display_number="9999.SZ03",
        status="signed",
    )
    db.add(ticket)
    db.commit()
    pdf_service = CurrentDataPdfService(db)
    storage_service = RecordingStorageService()

    result = ExtraWorkArchiveService(
        db,
        pdf_service=pdf_service,
        storage_service=storage_service,
    ).archive_completed_ticket(site_id=site.id, ticket_id=ticket.id)

    assert result is None
    assert pdf_service.calls == []
    assert storage_service.calls == []


def test_completed_extra_work_ticket_archives_pdf_with_latest_corrected_dates():
    db = db_session()
    site = Site(
        site_number="9999",
        name="Testbaustelle",
        project_folder_id="project-root-1",
    )
    ticket = ExtraWorkTicket(
        site=site,
        sequence_number=3,
        display_number="9999.SZ03",
        status="billed",
        manual_order_date=date(2026, 8, 4),
        manual_execution_week=33,
        manual_execution_week_year=2026,
    )
    db.add(ticket)
    db.commit()
    pdf_service = CurrentDataPdfService(db)
    storage_service = RecordingStorageService()
    service = ExtraWorkArchiveService(
        db,
        pdf_service=pdf_service,
        storage_service=storage_service,
    )

    service.archive_completed_ticket(site_id=site.id, ticket_id=ticket.id)

    assert pdf_service.calls == [(site.id, ticket.id)]
    assert storage_service.calls == [
        {
            "project_folder_item_id": "project-root-1",
            "filename": "Zusatzauftrag_9999_9999.SZ03.pdf",
            "content": b"status=billed;order_date=2026-08-04;week=33/2026",
        }
    ]
