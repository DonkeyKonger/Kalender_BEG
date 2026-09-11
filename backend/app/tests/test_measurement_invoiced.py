from datetime import datetime, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.models.audit_log import AuditLog
from app.models.enums import UserRole
from app.models.site_measurement_item import SiteMeasurementBatch
from app.models.user import User
from app.services.measurement_service import MeasurementService
from app.tests.test_measurement_service import create_site, db_session
from app.tests.test_office_measurement_routes import api_client, current_user, created_batch, FakeMeasurementService


@pytest.mark.parametrize("status", ["draft", "submitted", "reviewed", "customer_signed", "billed"])
def test_invoiced_marker_persists_independently_and_records_only_real_changes(status):
    with db_session() as db:
        site = create_site(db)
        actor = User(username="billing-office", display_name="Büro", password_hash="x", role=UserRole.OFFICE)
        signed_at = datetime(2026, 9, 1, tzinfo=timezone.utc)
        batch = SiteMeasurementBatch(site=site, number=1, title="Aufmaß 1", status=status,
                                     customer_signed_at=signed_at, customer_signature_name="Kunde")
        db.add_all([actor, batch])
        db.commit()
        service = MeasurementService(db)
        assert service._build_mobile_batch(batch).is_invoiced is False
        for value in [True, True, False]:
            result = service.set_site_batch_invoiced(site_id=site.id, batch_id=batch.id,
                                                   is_invoiced=value, current_user=actor)
            db.expire_all()
            reloaded = service._get_batch_for_site(batch.id, site.id)
            assert result.is_invoiced is value
            assert reloaded.is_invoiced is value
            assert reloaded.status == status
            assert reloaded.customer_signature_name == "Kunde"
            assert reloaded.customer_signed_at.date() == signed_at.date()
        audits = db.scalars(select(AuditLog).where(AuditLog.action == "measurement.invoiced_updated").order_by(AuditLog.id)).all()
        assert len(audits) == 2
        assert [row.new_value_json for row in audits] == [{"is_invoiced": True}, {"is_invoiced": False}]
        assert all(row.user_id == actor.id and row.created_at is not None for row in audits)


def test_invoiced_marker_rejects_wrong_site_and_archived_batches():
    with db_session() as db:
        site = create_site(db)
        other = create_site(db)
        actor = User(username="billing-office", display_name="Büro", password_hash="x", role=UserRole.OFFICE)
        batch = SiteMeasurementBatch(site=site, number=1, title="Aufmaß 1", status="billed")
        db.add_all([actor, batch])
        db.commit()
        service = MeasurementService(db)
        with pytest.raises(HTTPException) as wrong_site:
            service.set_site_batch_invoiced(site_id=other.id, batch_id=batch.id, is_invoiced=True, current_user=actor)
        assert wrong_site.value.status_code == 404
        batch.deleted_at = datetime.now(timezone.utc)
        db.commit()
        with pytest.raises(HTTPException) as archived:
            service.set_site_batch_invoiced(site_id=site.id, batch_id=batch.id, is_invoiced=True, current_user=actor)
        assert archived.value.status_code == 404
        assert batch.is_invoiced is False


def test_completion_does_not_infer_invoicing_and_write_failure_rolls_back(monkeypatch):
    with db_session() as db:
        site = create_site(db)
        actor = User(username="billing-office", display_name="Büro", password_hash="x", role=UserRole.OFFICE)
        batch = SiteMeasurementBatch(site=site, number=1, title="Aufmaß 1", status="draft")
        db.add_all([actor, batch])
        db.commit()
        service = MeasurementService(db)
        result = service.set_site_batch_billing_status(site_id=site.id, batch_id=batch.id, billing_status="billed")
        assert result.status == "billed"
        assert result.is_invoiced is False
        def fail_commit():
            raise RuntimeError("Test write failure")
        monkeypatch.setattr(db, "commit", fail_commit)
        with pytest.raises(RuntimeError, match="Test write failure"):
            service.set_site_batch_invoiced(site_id=site.id, batch_id=batch.id, is_invoiced=True, current_user=actor)
        db.expire_all()
        assert batch.is_invoiced is False
        assert db.scalars(select(AuditLog).where(AuditLog.action == "measurement.invoiced_updated")).all() == []


@pytest.mark.parametrize("role, permissions, expected", [
    (UserRole.ADMIN, [], 200),
    (UserRole.OFFICE, ["sites"], 200),
    (UserRole.OFFICE, ["calendar"], 403),
    (UserRole.MONTEUR, [], 403),
])
def test_invoiced_route_requires_site_write_permission(monkeypatch, role, permissions, expected):
    calls = []
    def update(self, **kwargs):
        calls.append(kwargs)
        return created_batch().model_copy(update={"is_invoiced": kwargs["is_invoiced"]})
    monkeypatch.setattr(FakeMeasurementService, "set_site_batch_invoiced", update, raising=False)
    with api_client(monkeypatch, current_user(role, *permissions)) as client:
        response = client.patch("/api/sites/8/measurement-batches/12/invoiced", json={"is_invoiced": True})
    assert response.status_code == expected
    assert len(calls) == (1 if expected == 200 else 0)
    if expected == 200:
        assert response.json()["is_invoiced"] is True
        assert response.json()["status"] == "draft"
