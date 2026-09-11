from datetime import datetime, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.models.audit_log import AuditLog
from app.models.enums import UserRole
from app.models.site_measurement_item import SiteMeasurementBatch, SiteMeasurementEntry, SiteMeasurementItem
from app.models.user import User
from app.services.measurement_service import MeasurementService
from app.tests.test_measurement_service import create_site, db_session
from app.tests.test_office_measurement_routes import api_client, current_user, created_batch, FakeMeasurementService


@pytest.mark.parametrize("status", ["draft", "submitted", "reviewed", "customer_signed", "billed", "approved", "closed"])
def test_invoiced_marker_completes_once_and_removing_it_keeps_completion(status):
    with db_session() as db:
        site = create_site(db)
        actor = User(username="billing-office", display_name="Büro", password_hash="x", role=UserRole.OFFICE)
        signed_at = datetime(2026, 9, 1, tzinfo=timezone.utc)
        batch = SiteMeasurementBatch(site=site, number=1, title="Aufmaß 1", status=status,
                                     customer_signed_at=signed_at, customer_signature_name="Kunde")
        db.add_all([actor, batch])
        db.commit()
        service = MeasurementService(db)
        archives = []
        completed_status = status if status in {"billed", "approved", "closed"} else "billed"
        assert service._build_mobile_batch(batch).is_invoiced is False
        for value in [True, True, False]:
            result = service.set_site_batch_invoiced(site_id=site.id, batch_id=batch.id,
                                                   is_invoiced=value, current_user=actor,
                                                   schedule_completed_archive=lambda *args: archives.append(args))
            db.expire_all()
            reloaded = service._get_batch_for_site(batch.id, site.id)
            assert result.is_invoiced is value
            assert reloaded.is_invoiced is value
            assert result.status == completed_status
            assert reloaded.status == completed_status
            assert reloaded.customer_signature_name == "Kunde"
            assert reloaded.customer_signed_at.date() == signed_at.date()
        audits = db.scalars(select(AuditLog).where(AuditLog.action == "measurement.invoiced_updated").order_by(AuditLog.id)).all()
        assert len(audits) == 2
        assert [row.new_value_json for row in audits] == [{"is_invoiced": True, "status": completed_status}, {"is_invoiced": False, "status": completed_status}]
        assert audits[0].old_value_json == {"is_invoiced": False, "status": status}
        assert len(archives) == (0 if status in {"billed", "approved", "closed"} else 1)
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


def test_marking_completes_entries_and_cannot_be_undone_by_storage_failure():
    with db_session() as db:
        site = create_site(db)
        actor = User(username="billing-office", display_name="Büro", password_hash="x", role=UserRole.OFFICE)
        batch = SiteMeasurementBatch(site=site, number=1, title="Aufmaß 1", status="reviewed", is_invoiced=True)
        item = SiteMeasurementItem(site=site, measurement_batch=batch, position="1", description="Leistung", unit="Stck", is_free_position=True, sort_order=1)
        entry = SiteMeasurementEntry(site=site, measurement_batch=batch, measurement_item=item, quantity=2, area_or_comment="EG", status="reviewed")
        db.add_all([actor, batch, item, entry])
        db.commit()
        def storage_unavailable(*args):
            raise RuntimeError("Test storage unavailable")
        result = MeasurementService(db).set_site_batch_invoiced(
            site_id=site.id, batch_id=batch.id, is_invoiced=True, current_user=actor,
            schedule_completed_archive=storage_unavailable,
        )
        db.expire_all()
        assert result.status == "billed"
        assert batch.status == "billed"
        assert batch.is_invoiced is True
        assert entry.status == "billed"
        assert entry.quantity == 2


def test_background_archive_uses_existing_export_and_skips_reopened_batches(monkeypatch, caplog):
    from contextlib import nullcontext
    from app.services import measurement_archive_service as archive
    with db_session() as db:
        site = create_site(db)
        actor = User(username="billing-office", display_name="Büro", password_hash="x", role=UserRole.OFFICE)
        batch = SiteMeasurementBatch(site=site, number=1, title="Aufmaß 1", status="billed")
        db.add_all([actor, batch])
        db.commit()
        exports = []
        monkeypatch.setattr(archive, "SessionLocal", lambda: nullcontext(db))
        monkeypatch.setattr(MeasurementService, "_archive_billed_batch_pdf", lambda self, **kwargs: exports.append(kwargs["batch"].id))
        archive.archive_completed_measurement_after_response(site.id, batch.id, actor.id)
        assert exports == [batch.id]
        batch.status = "submitted"
        db.commit()
        archive.archive_completed_measurement_after_response(site.id, batch.id, actor.id)
        assert exports == [batch.id]
        batch.status = "billed"
        db.commit()
        def fail_archive(self, **kwargs):
            raise RuntimeError("Test storage offline")
        monkeypatch.setattr(MeasurementService, "_archive_billed_batch_pdf", fail_archive)
        archive.archive_completed_measurement_after_response(site.id, batch.id, actor.id)
        assert "Measurement PDF background archive failed" in caplog.text


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
        batch.status = "reviewed"
        db.commit()
        def fail_commit():
            raise RuntimeError("Test write failure")
        monkeypatch.setattr(db, "commit", fail_commit)
        with pytest.raises(RuntimeError, match="Test write failure"):
            service.set_site_batch_invoiced(site_id=site.id, batch_id=batch.id, is_invoiced=True, current_user=actor)
        db.expire_all()
        assert batch.is_invoiced is False
        assert batch.status == "reviewed"
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
        kwargs["schedule_completed_archive"](8, 12, 7)
        return created_batch().model_copy(update={"is_invoiced": kwargs["is_invoiced"], "status": "billed"})
    from app.api.routes import sites
    archives = []
    monkeypatch.setattr(sites, "archive_completed_measurement_after_response", lambda *args: archives.append(args))
    monkeypatch.setattr(FakeMeasurementService, "set_site_batch_invoiced", update, raising=False)
    with api_client(monkeypatch, current_user(role, *permissions)) as client:
        response = client.patch("/api/sites/8/measurement-batches/12/invoiced", json={"is_invoiced": True})
    assert response.status_code == expected
    assert len(calls) == (1 if expected == 200 else 0)
    if expected == 200:
        assert response.json()["is_invoiced"] is True
        assert response.json()["status"] == "billed"
        assert archives == [(8, 12, 7)]
