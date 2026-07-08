from __future__ import annotations

from datetime import UTC, datetime

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models.assignment import Assignment
from app.models.extra_work_ticket import ExtraWorkTicket
from app.models.person import Person
from app.models.site_measurement_item import SiteMeasurementBatch
from app.models.site_email_recipient import SiteEmailRecipient
from app.models.user import User
from app.schemas.extra_work import ExtraWorkTicketEmailSendRead
from app.services.audit_service import AuditService
from app.services.email_delivery_service import EmailAttachment, EmailDeliveryService
from app.services.extra_work_pdf_service import ExtraWorkPdfService
from app.services.measurement_pdf_service import MeasurementPdfService


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
        site_name = _clean_text(ticket.site.name if ticket.site else None) or "Baustelle"
        document_title = _email_document_title(ticket, site_name, filename)
        worker_name = _worker_name(assignment, current_user)
        subject = f"Anliegend erhalten Sie {document_title}"
        body = (
            "Sehr geehrte Damen und Herren,\n\n"
            f"anliegend erhalten Sie {document_title}.\n\n"
            "Mit freundlichen Grüßen\n\n"
            f"{worker_name}\n\n"
            "BEG Badener Elektro GmbH\n"
            "Firmenweg 16 · 28832 Achim\n"
            "Tel.: +49 4202 97520  |  E-Mail: info@BEG-Achim.de\n"
            "Eingetragen: Amtsgericht Walsrode – HRB 120028\n"
            "Geschäftsführer: Axel Biesewig · Kerstin Erichsen"
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
                "customer_signature_present": ticket.customer_signed_at is not None,
            },
        )
        self.db.commit()
        return ExtraWorkTicketEmailSendRead(
            sent_at=sent_at,
            recipients=recipients,
            filename=filename,
        )

    def send_mobile_measurement_batch_email(
        self,
        *,
        assignment_id: int,
        batch_id: int,
        current_user: User,
    ) -> ExtraWorkTicketEmailSendRead:
        assignment = self._get_user_assignment(assignment_id, current_user)
        batch = self._get_measurement_batch(batch_id, assignment.site_id)

        recipients = self._selected_recipients(assignment.site_id)
        if not recipients:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Keine E-Mail-Empfänger hinterlegt.")

        content, filename = MeasurementPdfService(self.db).build_batch_pdf(
            site_id=assignment.site_id,
            batch_id=batch.id,
            mode="checked",
        )
        site_name = _clean_text(batch.site.name if batch.site else None) or "Baustelle"
        document_title = _measurement_email_document_title(batch, site_name)
        worker_name = _worker_name(assignment, current_user)
        subject = f"Anliegend erhalten Sie {document_title}"
        body = (
            "Sehr geehrte Damen und Herren,\n\n"
            f"anliegend erhalten Sie {document_title}.\n\n"
            "Mit freundlichen Grüßen\n\n"
            f"{worker_name}\n\n"
            "BEG Badener Elektro GmbH\n"
            "Firmenweg 16 · 28832 Achim\n"
            "Tel.: +49 4202 97520  |  E-Mail: info@BEG-Achim.de\n"
            "Eingetragen: Amtsgericht Walsrode – HRB 120028\n"
            "Geschäftsführer: Axel Biesewig · Kerstin Erichsen"
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
            action="measurement.email_sent",
            entity_type="measurement_batch",
            entity_id=batch.id,
            old_value=None,
            new_value={
                "assignment_id": assignment.id,
                "site_id": assignment.site_id,
                "recipients": recipients,
                "filename": filename,
                "sent_at": sent_at.isoformat(),
                "customer_signature_present": batch.customer_signed_at is not None,
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
            select(Assignment).options(selectinload(Assignment.person)).where(
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

    def _get_measurement_batch(self, batch_id: int, site_id: int) -> SiteMeasurementBatch:
        batch = self.db.scalar(
            select(SiteMeasurementBatch)
            .options(selectinload(SiteMeasurementBatch.site))
            .where(
                SiteMeasurementBatch.id == batch_id,
                SiteMeasurementBatch.site_id == site_id,
                SiteMeasurementBatch.deleted_at.is_(None),
            )
        )
        if batch is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Aufmaß nicht gefunden.")
        return batch

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


def _email_document_title(ticket: ExtraWorkTicket, site_name: str, filename: str) -> str:
    ticket_number = _clean_text(ticket.display_number) or str(ticket.sequence_number or "").strip()
    if not ticket_number:
        ticket_number = _clean_text(filename.removesuffix(".pdf")) or "ohne Nummer"
    description = _clean_text(ticket.title) or "Hauptauftrag"
    return f"Zusatzauftrag {ticket_number} - {site_name} - {description}"


def _measurement_email_document_title(batch: SiteMeasurementBatch, site_name: str) -> str:
    title = _clean_text(batch.title) or f"Aufmaß {batch.number}"
    return f"{title} - {site_name}"


def _worker_name(assignment: Assignment, current_user: User) -> str:
    assignment_person = getattr(assignment, "person", None)
    return (
        _person_full_name(assignment_person)
        or _person_full_name(getattr(current_user, "person", None))
        or _clean_text(getattr(current_user, "display_name", None))
        or _clean_text(getattr(current_user, "username", None))
        or "BEG"
    )


def _person_full_name(person: Person | None) -> str:
    if person is None:
        return ""
    first_name = _clean_text(person.first_name)
    last_name = _clean_text(person.last_name)
    full_name = " ".join(part for part in [first_name, last_name] if part)
    return full_name or _clean_text(person.display_name)


def _clean_text(value: str | None) -> str:
    if value is None:
        return ""
    return " ".join(str(value).replace("\r", " ").split())
