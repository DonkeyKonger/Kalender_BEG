import smtplib

import pytest
from fastapi import HTTPException

from app.services import email_delivery_service as email_module
from app.services.email_delivery_service import EmailAttachment, EmailDeliveryService


def test_email_delivery_requires_smtp_configuration(monkeypatch):
    monkeypatch.setattr(email_module.settings, "smtp_host", None)
    monkeypatch.setattr(email_module.settings, "smtp_from_email", None)

    with pytest.raises(HTTPException) as error:
        EmailDeliveryService().send_document_email(
            recipients=["kunde@example.de"],
            subject="Test",
            body="Text",
            attachment=EmailAttachment(
                filename="test.pdf",
                content=b"%PDF-test",
                content_type="application/pdf",
            ),
        )

    assert error.value.status_code == 503
    assert error.value.detail == "E-Mail-Versand ist noch nicht konfiguriert."


def test_email_delivery_sends_pdf_attachment(monkeypatch):
    sent_messages = []
    smtp_events = []

    class FakeSmtp:
        def __init__(self, host, port, timeout):
            smtp_events.append(("connect", host, port, timeout))

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def starttls(self):
            smtp_events.append(("starttls",))

        def login(self, username, password):
            smtp_events.append(("login", username, password))

        def send_message(self, message):
            sent_messages.append(message)

    monkeypatch.setattr(email_module.settings, "smtp_host", "smtp.example.de")
    monkeypatch.setattr(email_module.settings, "smtp_port", 587)
    monkeypatch.setattr(email_module.settings, "smtp_username", "user")
    monkeypatch.setattr(email_module.settings, "smtp_password", "secret")
    monkeypatch.setattr(email_module.settings, "smtp_from_email", "baustellenplaner@beg-achim.de")
    monkeypatch.setattr(email_module.settings, "smtp_from_name", "BEG Baustellenkalender")
    monkeypatch.setattr(email_module.settings, "smtp_use_starttls", True)
    monkeypatch.setattr(email_module.smtplib, "SMTP", FakeSmtp)

    EmailDeliveryService().send_document_email(
        recipients=["kunde@example.de"],
        subject="Stundenzettel 3",
        body="Anbei der Stundenzettel.",
        attachment=EmailAttachment(
            filename="Stundenzettel_3.pdf",
            content=b"%PDF-test",
            content_type="application/pdf",
        ),
    )

    assert smtp_events == [
        ("connect", "smtp.example.de", 587, 20),
        ("starttls",),
        ("login", "user", "secret"),
    ]
    assert len(sent_messages) == 1
    assert sent_messages[0]["To"] == "kunde@example.de"
    assert sent_messages[0]["From"] == "BEG Baustellenkalender <baustellenplaner@beg-achim.de>"
    assert sent_messages[0]["Subject"] == "Stundenzettel 3"


def test_email_delivery_wraps_smtp_errors(monkeypatch):
    class BrokenSmtp:
        def __init__(self, host, port, timeout):
            pass

        def __enter__(self):
            raise smtplib.SMTPException("connection failed")

        def __exit__(self, exc_type, exc, traceback):
            return False

    monkeypatch.setattr(email_module.settings, "smtp_host", "smtp.example.de")
    monkeypatch.setattr(email_module.settings, "smtp_from_email", "baustellenplaner@beg-achim.de")
    monkeypatch.setattr(email_module.smtplib, "SMTP", BrokenSmtp)

    with pytest.raises(HTTPException) as error:
        EmailDeliveryService().send_document_email(
            recipients=["kunde@example.de"],
            subject="Test",
            body="Text",
            attachment=EmailAttachment(
                filename="test.pdf",
                content=b"%PDF-test",
                content_type="application/pdf",
            ),
        )

    assert error.value.status_code == 502
    assert error.value.detail == "E-Mail konnte nicht gesendet werden. Bitte Mailserver-Konfiguration prüfen."
