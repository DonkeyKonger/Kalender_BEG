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
from app.services.measurement_group_service import source_version
from app.services.measurement_pdf_service import MeasurementPdfService
from app.services.measurement_service import MeasurementService
from app.tests.test_measurement_groups import setup_group, create_group
from app.tests.test_measurement_service import create_site, db_session
from app.tests.test_office_measurement_routes import api_client, current_user, FakeMeasurementService


def test_labels_are_persistent_metadata_and_preserve_signed_content_groups_and_pdf_versions():
    with db_session() as db:
        site, actor, batches = setup_group(db)
        batch = batches[0]
        batch.customer_signed_snapshot = {"preserve": "signed content"}
        db.commit()
        group = create_group(db, site, actor, batches)
        batch = MeasurementService(db)._get_batch_for_site(batch.id, site.id)
        version = source_version(batch)
        pdf = MeasurementPdfService(db)
        pdf_version = pdf._build_batch_pdf_version_hash(batch, mode="checked")
        timestamp, title, number = batch.updated_at, batch.title, batch.number
        service = MeasurementService(db)
        for label, expected in [("  Aufmaß  Nachunternehmer  ", "Aufmaß Nachunternehmer"),
                                ("Aufmaß Nachunternehmer", "Aufmaß Nachunternehmer"),
                                ("Neue Beschriftung", "Neue Beschriftung"), ("   ", None)]:
            result = service.set_site_batch_internal_label(site_id=site.id, batch_id=batch.id,
                internal_label=label, current_user=actor)
            assert result == {"id": batch.id, "internal_label": expected}
            db.expire_all()
            assert batch.internal_label == expected
            assert (batch.title, batch.number, batch.updated_at) == (title, number, timestamp)
            assert batch.customer_signed_snapshot == {"preserve": "signed content"}
            assert batch.status == "billed" and batch.is_invoiced
            assert source_version(batch) == version
            assert pdf._build_batch_pdf_version_hash(batch, mode="checked") == pdf_version
            assert group.invalidated_at is None
            overview = service.list_site_batches(site.id)
            assert next(row for row in overview if row.id == batch.id).internal_label == expected
            assert {row.combined_measurement.id for row in overview} == {group.id}
        audits = db.scalars(select(AuditLog).where(AuditLog.action == "measurement.internal_label_updated")).all()
        assert len(audits) == 3  # No duplicate write/audit for unchanged text.
        assert all(audit.user_id == actor.id for audit in audits)


def test_label_is_site_scoped_and_archived_measurements_can_be_labeled():
    with db_session() as db:
        site, actor, batches = setup_group(db)
        other = create_site(db)
        service = MeasurementService(db)
        with pytest.raises(HTTPException) as error:
            service.set_site_batch_internal_label(site_id=other.id, batch_id=batches[0].id,
                internal_label="Wrong site", current_user=actor)
        assert error.value.status_code == 404
        batches[0].deleted_at = datetime.now(timezone.utc)
        db.commit()
        service.set_site_batch_internal_label(site_id=site.id, batch_id=batches[0].id,
            internal_label="Archivnotiz", current_user=actor)
        assert batches[0].deleted_at is not None
        assert batches[0].internal_label == "Archivnotiz"


@pytest.mark.parametrize("role,permissions,expected", [
    (UserRole.ADMIN, [], 200), (UserRole.PROJECT_MANAGER, [], 200),
    (UserRole.OFFICE, ["sites"], 200), (UserRole.OFFICE, [], 403),
    (UserRole.OFFICE, ["calendar"], 403), (UserRole.MONTEUR, [], 403),
])
def test_label_route_requires_site_write_permission(monkeypatch, role, permissions, expected):
    calls = []
    def save(self, **kwargs):
        calls.append(kwargs)
        return {"id": kwargs["batch_id"], "internal_label": kwargs["internal_label"]}
    monkeypatch.setattr(FakeMeasurementService, "set_site_batch_internal_label", save, raising=False)
    with api_client(monkeypatch, current_user(role, *permissions)) as client:
        response = client.patch("/api/sites/8/measurement-batches/12/internal-label", json={"internal_label": "Nachunternehmer"})
    assert response.status_code == expected
    assert len(calls) == (1 if expected == 200 else 0)


@pytest.mark.parametrize("payload", [{}, {"internal_label": None}, {"internal_label": "x" * 121}])
def test_label_route_validates_input(monkeypatch, payload):
    with api_client(monkeypatch, current_user(UserRole.ADMIN)) as client:
        assert client.patch("/api/sites/8/measurement-batches/12/internal-label", json=payload).status_code == 422


def test_label_migration_preserves_existing_records():
    path = Path(__file__).parents[2] / "alembic/versions/20260925_0121_measurement_internal_label.py"
    spec = spec_from_file_location("label_migration", path)
    migration = module_from_spec(spec)
    spec.loader.exec_module(migration)
    with create_engine("sqlite://").begin() as conn:
        conn.execute(text("CREATE TABLE site_measurement_batches (id INTEGER PRIMARY KEY, title VARCHAR(120))"))
        conn.execute(text("INSERT INTO site_measurement_batches VALUES (1, 'Aufmaß 1')"))
        with Operations.context(MigrationContext.configure(conn)):
            migration.upgrade()
            assert conn.execute(text("SELECT title, internal_label FROM site_measurement_batches")).one() == ("Aufmaß 1", None)
            migration.downgrade()
        assert "internal_label" not in {column["name"] for column in inspect(conn).get_columns("site_measurement_batches")}
        assert conn.execute(text("SELECT title FROM site_measurement_batches")).scalar() == "Aufmaß 1"
