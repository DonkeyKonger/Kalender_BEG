from datetime import datetime, timezone
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from fastapi import HTTPException
from sqlalchemy import create_engine, inspect, select, text

from app.models.audit_log import AuditLog
from app.models.enums import UserRole
from app.models.extra_work_ticket import ExtraWorkTicket
from app.models.site import Site
from app.services.extra_work_service import ExtraWorkService
from app.services.extra_work_pdf_service import ExtraWorkPdfService
from app.tests.test_extra_work_archive_routes import api_client, current_user, FakeExtraWorkService
from app.tests.test_extra_work_service import db_session


def test_labels_preserve_signed_content_and_work_for_archived_tickets():
    with db_session() as db:
        site = Site(site_number="8007", name="Testbaustelle")
        other = Site(site_number="8008", name="Andere Baustelle")
        db.add_all([site, other])
        db.flush()
        ticket = ExtraWorkTicket(site_id=site.id, sequence_number=1,
            display_number="8007.Z01", title="Dokumenttitel", kind="billing", status="signed",
            is_invoiced=True, customer_signed_at=datetime.now(timezone.utc))
        db.add(ticket)
        ticket.signed_pdf_content = b"unchanged signed document"
        ticket.signed_pdf_sha256 = "preserved-hash"
        db.commit()
        db.refresh(ticket)
        original = (ticket.title, ticket.display_number, ticket.updated_at, ticket.customer_signed_at)
        service = ExtraWorkService(db)
        pdf_version = ExtraWorkPdfService(db)._build_ticket_pdf_version_hash(ticket, None)
        actor = current_user(UserRole.ADMIN)
        for label, expected in [("  Nachunternehmer  EG ", "Nachunternehmer EG"),
                                ("Nachunternehmer EG", "Nachunternehmer EG"),
                                ("Neue Beschriftung", "Neue Beschriftung"), ("   ", None)]:
            assert service.set_site_ticket_internal_label(site_id=site.id, ticket_id=ticket.id,
                internal_label=label, current_user=actor) == {"id": ticket.id, "internal_label": expected}
            db.expire_all()
            assert ticket.internal_label == expected
            assert (ticket.title, ticket.display_number, ticket.updated_at, ticket.customer_signed_at) == original
            assert ticket.status == "signed" and ticket.is_invoiced
            assert ticket.signed_pdf_content == b"unchanged signed document"
            assert ticket.signed_pdf_sha256 == "preserved-hash"
            assert ExtraWorkPdfService(db)._build_ticket_pdf_version_hash(ticket, None) == pdf_version
            assert service.list_site_tickets(site.id)[0].internal_label == expected
        audits = db.scalars(select(AuditLog).where(AuditLog.action == "extra_work.internal_label_updated")).all()
        assert len(audits) == 3
        with pytest.raises(HTTPException) as error:
            service.set_site_ticket_internal_label(site_id=other.id, ticket_id=ticket.id,
                internal_label="Wrong site", current_user=actor)
        assert error.value.status_code == 404
        ticket.deleted_at = datetime.now(timezone.utc)
        db.commit()
        service.set_site_ticket_internal_label(site_id=site.id, ticket_id=ticket.id,
            internal_label="Archivnotiz", current_user=actor)
        assert service.list_site_tickets(site.id, archived_only=True)[0].internal_label == "Archivnotiz"


@pytest.mark.parametrize("role,permissions,expected", [
    (UserRole.ADMIN, [], 200), (UserRole.PROJECT_MANAGER, [], 200),
    (UserRole.OFFICE, ["sites"], 200), (UserRole.OFFICE, [], 403),
    (UserRole.OFFICE, ["calendar"], 403), (UserRole.MONTEUR, [], 403),
])
def test_label_route_permissions(monkeypatch, role, permissions, expected):
    calls = []
    def save(self, **kwargs):
        calls.append(kwargs)
        return {"id": kwargs["ticket_id"], "internal_label": kwargs["internal_label"]}
    monkeypatch.setattr(FakeExtraWorkService, "set_site_ticket_internal_label", save, raising=False)
    with api_client(monkeypatch, current_user(role, *permissions)) as client:
        response = client.patch("/api/sites/8/extra-work-tickets/12/internal-label", json={"internal_label": "Nachunternehmer"})
    assert response.status_code == expected
    assert len(calls) == (1 if expected == 200 else 0)


@pytest.mark.parametrize("payload", [{}, {"internal_label": None}, {"internal_label": "x" * 121}])
def test_label_route_validates_input(monkeypatch, payload):
    with api_client(monkeypatch, current_user(UserRole.ADMIN)) as client:
        assert client.patch("/api/sites/8/extra-work-tickets/12/internal-label", json=payload).status_code == 422


def test_label_migration_preserves_records():
    path = Path(__file__).parents[2] / "alembic/versions/20260925_0122_extra_work_internal_label.py"
    spec = spec_from_file_location("extra_label_migration", path)
    migration = module_from_spec(spec)
    spec.loader.exec_module(migration)
    with create_engine("sqlite://").begin() as conn:
        conn.execute(text("CREATE TABLE extra_work_tickets (id INTEGER PRIMARY KEY, title VARCHAR(120))"))
        conn.execute(text("INSERT INTO extra_work_tickets VALUES (1, 'Zusatzauftrag 1')"))
        with Operations.context(MigrationContext.configure(conn)):
            migration.upgrade()
            assert conn.execute(text("SELECT title, internal_label FROM extra_work_tickets")).one() == ("Zusatzauftrag 1", None)
            migration.downgrade()
        assert "internal_label" not in {column["name"] for column in inspect(conn).get_columns("extra_work_tickets")}
        assert conn.execute(text("SELECT title FROM extra_work_tickets")).scalar() == "Zusatzauftrag 1"
