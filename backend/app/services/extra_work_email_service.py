from __future__ import annotations

from datetime import UTC, datetime

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models.assignment import Assignment
from app.models.extra_work_ticket import ExtraWorkTicket
from app.models.site_email_recipient import SiteEmailRecipient
from app.models.user import User
from app.schemas.extra_work import ExtraWorkTicketEmailSendRead
from app.services.audit_service import AuditService
from app.services.email_delivery_service import EmailAttachment, EmailDeliveryService
from app.services.extra_work_pdf_service import ExtraWorkPdfService


class ExtraWorkEmailService:
    def __init__(self, db: Session) -> None:
        self.db = db

    def send_mobile_ticket_email(
        self,
        *,
        assignment_id: int,
        ticket_id: int,
        current_user: User,
    ) -> ExtraWorkTicketEmailSendRead:
        assignment = self._get_user_assignment(assignment_id, current_user)
        ticket = self._get_ticket(ticket_id, assignment.site_id)
        if ticket.customer_signed_at is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Kundenunterschrift fehlt.")
        if ticket.worker_signed_at is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Monteursunterschrift fehlt.")

        recipients = self._selected_recipients(assignment.site_id)
        if not recipients:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Keine E-Mail-Empfänger hinterlegt.")

        content, filename = ExtraWorkPdfService(self.db).build_mobile_ticket_pdf(
            assignment_id=assignment_id,
            ticket_id=ticket_id,
            current_user=current_user,
        )
        subject = f"{filename.replace('.pdf', '')}"
        body = (
            "Guten Tag,\n\n"
            "anbei erhalten Sie den aktuellen Stundenzettel als PDF.\n\n"
            "Mit freundlichen Grüßen\n"
            "BEG Baustellenkalender"
        )
        EmailDeliveryService().send_document_email(
            recipients=recipients,
            subject=subject,
            body=body,
            attachment=EmailAttachment(
                filename=filename,
                content=content,
                content_type="application/pdf",
            ),
        )

        sent_at = datetime.now(UTC)
        AuditService(self.db).record(
            user_id=current_user.id,
            action="extra_work.email_sent",
            entity_type="extra_work_ticket",
            entity_id=ticket.id,
            old_value=None,
            new_value={
                "assignment_id": assignment.id,
                "site_id": assignment.site_id,
                "recipients": recipients,
                "filename": filename,
                "sent_at": sent_at.isoformat(),
            },
        )
        self.db.commit()
        return ExtraWorkTicketEmailSendRead(
            sent_at=sent_at,
            recipients=recipients,
            filename=filename,
        )

    def _get_user_assignment(self, assignment_id: int, current_user: User) -> Assignment:
        if current_user.person_id is None:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Dieser Benutzer ist keiner Person zugeordnet.")
        assignment = self.db.scalar(
            select(Assignment).where(
                Assignment.id == assignment_id,
                Assignment.person_id == current_user.person_id,
            )
        )
        if assignment is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Einsatz nicht gefunden.")
        return assignment

    def _get_ticket(self, ticket_id: int, site_id: int) -> ExtraWorkTicket:
        ticket = self.db.scalar(
            select(ExtraWorkTicket)
            .options(
                selectinload(ExtraWorkTicket.site),
                selectinload(ExtraWorkTicket.entries),
                selectinload(ExtraWorkTicket.photos),
            )
            .where(ExtraWorkTicket.id == ticket_id, ExtraWorkTicket.site_id == site_id)
        )
        if ticket is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Stundenzettel nicht gefunden.")
        return ticket

    def _selected_recipients(self, site_id: int) -> list[str]:
        return list(
            self.db.scalars(
                select(SiteEmailRecipient.email)
                .where(
                    SiteEmailRecipient.site_id == site_id,
                    SiteEmailRecipient.is_selected.is_(True),
                )
                .order_by(SiteEmailRecipient.email)
            )
        )
