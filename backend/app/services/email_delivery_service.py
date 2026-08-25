from __future__ import annotations

from dataclasses import dataclass
from email.message import EmailMessage
from email.utils import formataddr
import smtplib

from fastapi import HTTPException, status

from app.core.config import settings


@dataclass(frozen=True)
class EmailAttachment:
    filename: str
    content: bytes
    content_type: str


class EmailDeliveryService:
    def send_document_email(
        self,
        *,
        recipients: list[str],
        subject: str,
        body: str,
        attachment: EmailAttachment | None = None,
        attachments: list[EmailAttachment] | None = None,
    ) -> None:
        if not recipients:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Keine E-Mail-Empfänger hinterlegt.")
        if not settings.smtp_host or not settings.smtp_from_email:
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "E-Mail-Versand ist noch nicht konfiguriert.")

        message = EmailMessage()
        message["From"] = formataddr((settings.smtp_from_name, settings.smtp_from_email))
        message["To"] = ", ".join(recipients)
        message["Subject"] = subject
        message.set_content(body)
        document_attachments = [*([attachment] if attachment else []), *(attachments or [])]
        if not document_attachments:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Mindestens ein Anhang ist erforderlich.")
        for document_attachment in document_attachments:
            maintype, subtype = document_attachment.content_type.split("/", 1)
            message.add_attachment(
                document_attachment.content,
                maintype=maintype,
                subtype=subtype,
                filename=document_attachment.filename,
            )

        try:
            with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=20) as smtp:
                if settings.smtp_use_starttls:
                    smtp.starttls()
                if settings.smtp_username and settings.smtp_password:
                    smtp.login(settings.smtp_username, settings.smtp_password)
                smtp.send_message(message)
        except (OSError, smtplib.SMTPException) as exc:
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY,
                "E-Mail konnte nicht gesendet werden. Bitte Mailserver-Konfiguration prüfen.",
            ) from exc
