from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.core.database import SessionLocal
from app.models.extra_work_ticket import ExtraWorkTicket
from app.services.extra_work_pdf_service import ExtraWorkPdfService
from app.services.project_storage_service import ProjectStorageService


LOGGER = logging.getLogger(__name__)

EXTRA_WORK_COMPLETED_STATUSES = {
    "billed",
    "approved",
    "closed",
    "completed",
    "finalized",
    "abgeschlossen",
}


def is_extra_work_completed_status(value: str | None) -> bool:
    return (value or "").strip().lower() in EXTRA_WORK_COMPLETED_STATUSES


class ExtraWorkArchiveService:
    """Build and persist the current PDF for a completed extra-work ticket."""

    def __init__(
        self,
        db: Session,
        *,
        pdf_service: ExtraWorkPdfService | None = None,
        storage_service: ProjectStorageService | None = None,
    ) -> None:
        self.db = db
        self.pdf_service = pdf_service or ExtraWorkPdfService(db)
        self.storage_service = storage_service or ProjectStorageService()

    def archive_completed_ticket(
        self,
        *,
        site_id: int,
        ticket_id: int,
    ) -> dict[str, Any] | None:
        ticket = self.db.scalar(
            select(ExtraWorkTicket)
            .options(selectinload(ExtraWorkTicket.site))
            .where(
                ExtraWorkTicket.id == ticket_id,
                ExtraWorkTicket.site_id == site_id,
                ExtraWorkTicket.deleted_at.is_(None),
            )
        )
        if ticket is None:
            raise LookupError(f"Extra-work ticket {ticket_id} for site {site_id} was not found.")
        if not is_extra_work_completed_status(ticket.status):
            return None

        project_folder_id = ticket.site.project_folder_id if ticket.site else None
        if not project_folder_id:
            LOGGER.warning(
                "Extra-work PDF archive skipped: site_id=%s ticket_id=%s has no project folder.",
                site_id,
                ticket_id,
            )
            return None

        content, filename = self.pdf_service.build_site_ticket_pdf(
            site_id=site_id,
            ticket_id=ticket_id,
        )
        document = self.storage_service.upload_extra_work_archive_pdf(
            project_folder_item_id=project_folder_id,
            filename=filename,
            content=content,
        )
        LOGGER.info(
            "Extra-work PDF archived: site_id=%s ticket_id=%s filename=%s item_id=%s.",
            site_id,
            ticket_id,
            filename,
            document.get("id"),
        )
        return document


def archive_completed_extra_work_ticket_after_response(
    *,
    site_id: int,
    ticket_id: int,
) -> None:
    """Run the best-effort archive copy outside the completed HTTP response."""
    with SessionLocal() as db:
        try:
            ExtraWorkArchiveService(db).archive_completed_ticket(
                site_id=site_id,
                ticket_id=ticket_id,
            )
        except Exception:
            LOGGER.exception(
                "Extra-work PDF background archive failed after status persistence: "
                "site_id=%s ticket_id=%s.",
                site_id,
                ticket_id,
            )
