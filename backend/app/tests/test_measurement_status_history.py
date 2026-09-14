from decimal import Decimal
from types import SimpleNamespace
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException

from app.tests.test_measurement_service import db_session, create_site
from app.models.enums import UserRole
from app.models.user import User
from app.models.site_measurement_item import SiteMeasurementBatch, SiteMeasurementItem, SiteMeasurementEntry
from app.schemas.measurement import CustomerSignatureCreate
from app.services.measurement_service import MeasurementService
from app.services.measurement_status_history import rollback_target


@pytest.fixture
def setup(monkeypatch):
    db = db_session()
    site = create_site(db)
    actor = User(username="history-admin", display_name="Test", password_hash="x", role=UserRole.ADMIN)
    batch = SiteMeasurementBatch(site=site, number=1, title="History", status="submitted", origin="OFFICE", submitted_at=datetime.now(timezone.utc))
    item = SiteMeasurementItem(site=site, measurement_batch=batch, position="1.1", description="Test", unit="m", is_free_position=True, sort_order=1)
    entry = SiteMeasurementEntry(site=site, measurement_batch=batch, measurement_item=item, quantity=Decimal("12.55"), area_or_comment="2. OG", status="submitted")
    db.add_all([actor, batch, item, entry])
    db.commit()
    service = MeasurementService(db)
    monkeypatch.setattr(service, "_archive_billed_batch_pdf", lambda **kwargs: None)
    monkeypatch.setattr(service, "_get_user_assignment", lambda *args: SimpleNamespace(site_id=site.id))
    yield db, service, site, batch, actor, entry
    db.close()


def undo(service, site, batch, actor, revision=None):
    return service.rollback_site_batch_status(site_id=site.id, batch_id=batch.id,
        current_user=actor, expected_revision=len(batch.status_history) if revision is None else revision)


def test_actual_path_skips_unsigned_stage_and_each_request_undoes_only_one_transition(setup):
    db, service, site, batch, actor, entry = setup
    service.set_site_batch_reviewed(site_id=site.id, batch_id=batch.id)
    completed = service.set_site_batch_billing_status(site_id=site.id, batch_id=batch.id, billing_status="billed")
    assert completed.previous_status == "reviewed"
    assert completed.status_path == ["submitted", "reviewed", "billed"]
    revision = completed.status_revision
    assert undo(service, site, batch, actor).status == "reviewed"
    with pytest.raises(HTTPException) as stale:
        undo(service, site, batch, actor, revision)
    assert stale.value.status_code == 409
    assert batch.status == "reviewed"
    assert undo(service, site, batch, actor).status == "submitted"
    assert rollback_target(batch) is None
    with pytest.raises(HTTPException):
        undo(service, site, batch, actor)
    db.refresh(entry)
    assert entry.quantity == Decimal("12.55")
    assert entry.area_or_comment == "2. OG"
    assert entry.status == "submitted"
    assert batch.customer_signed_at is None


def test_real_signature_restored_as_previous_stage_then_revoked_but_retained_in_history(setup):
    db, service, site, batch, actor, entry = setup
    service.set_site_batch_reviewed(site_id=site.id, batch_id=batch.id)
    signed = service.sign_mobile_batch(assignment_id=1, batch_id=batch.id, current_user=actor,
        payload=CustomerSignatureCreate(customer_name="Testkunde", signature_strokes=[[{"x":0.1,"y":0.1},{"x":0.8,"y":0.7}]]))
    assert signed.previous_status == "reviewed"
    signature = batch.customer_signature_strokes
    service.set_site_batch_billing_status(site_id=site.id, batch_id=batch.id, billing_status="billed")
    assert undo(service, site, batch, actor).status == "customer_signed"
    assert batch.customer_signature_strokes == signature
    assert batch.customer_signed_at is not None
    assert undo(service, site, batch, actor).status == "reviewed"
    assert batch.customer_signed_at is None
    assert batch.customer_signature_name is None
    assert batch.customer_signed_snapshot is None
    assert batch.status_history[-1]["signatures"]["customer_signature_strokes"] == signature
    assert batch.status_history[-1]["signatures"]["customer_signed_snapshot"] is not None
    assert undo(service, site, batch, actor).status == "submitted"
    assert len(batch.entries) == 1


def test_invoice_completion_and_duplicate_forward_requests_do_not_duplicate_history(setup):
    db, service, site, batch, actor, entry = setup
    service.set_site_batch_reviewed(site_id=site.id, batch_id=batch.id)
    service.set_site_batch_reviewed(site_id=site.id, batch_id=batch.id)
    assert len(batch.status_history) == 1
    service.set_site_batch_invoiced(site_id=site.id, batch_id=batch.id, is_invoiced=True, current_user=actor)
    service.set_site_batch_invoiced(site_id=site.id, batch_id=batch.id, is_invoiced=True, current_user=actor)
    assert len(batch.status_history) == 2
    assert undo(service, site, batch, actor).status == "reviewed"
    assert batch.is_invoiced is True  # Independent billing fact, not erased by a status-only reset.
    service.set_site_batch_billing_status(site_id=site.id, batch_id=batch.id, billing_status="billed")
    assert undo(service, site, batch, actor).status == "reviewed"
    assert undo(service, site, batch, actor).status == "submitted"


@pytest.mark.parametrize("status", ["draft", "reviewed", "customer_signed", "signed", "billed", "approved", "closed", "completed"])
def test_legacy_records_fall_back_to_submitted_without_changing_content(setup, status):
    db, service, site, batch, actor, entry = setup
    batch.status = status
    batch.is_invoiced = True
    batch.worker_signed_at = datetime.now(timezone.utc)
    batch.worker_signature_name = "Monteur"
    batch.worker_signature_strokes = [[{"x": 0.1, "y": 0.2}]]
    entry.submitted_quantity = Decimal("10.25")
    entry.submitted_area_or_comment = "Originalort"
    db.commit()
    before = service._build_mobile_batch(batch)
    assert before.previous_status == "submitted"
    assert before.status_rollback_is_fallback is True
    after = undo(service, site, batch, actor)
    assert after.status == "submitted"
    assert after.status_path == ["submitted"]
    assert after.previous_status is None
    assert after.status_rollback_is_fallback is False
    assert after.status_revision == 1
    assert batch.status_history[-1]["kind"] == "fallback"
    assert batch.status_history[-1]["from"] == status
    assert batch.is_invoiced is True
    assert batch.worker_signature_name == "Monteur"
    assert batch.worker_signature_strokes == [[{"x": 0.1, "y": 0.2}]]
    db.refresh(entry)
    assert entry.status == "submitted"
    assert entry.quantity == Decimal("12.55")
    assert entry.area_or_comment == "2. OG"
    assert entry.submitted_quantity == Decimal("10.25")
    assert entry.submitted_area_or_comment == "Originalort"
    service._ensure_site_batch_can_be_edited_in_office(batch)
    with pytest.raises(HTTPException) as stale:
        undo(service, site, batch, actor, before.status_revision)
    assert stale.value.status_code == 409
    # New transitions build on the submitted baseline, never undo the fallback.
    service.set_site_batch_reviewed(site_id=site.id, batch_id=batch.id)
    assert undo(service, site, batch, actor).status == "submitted"
    assert rollback_target(batch) is None


def test_submitted_without_history_does_not_repeat_a_noop_reset(setup):
    db, service, site, batch, actor, entry = setup
    assert service._build_mobile_batch(batch).previous_status is None
    with pytest.raises(HTTPException) as error:
        undo(service, site, batch, actor)
    assert error.value.status_code == 409
    assert batch.status_history == []


@pytest.mark.parametrize("snapshot", [None, {"items": [{"description": "Unterschriebener Stand"}]}])
def test_fallback_revokes_customer_approval_but_keeps_evidence_and_unblocks_editing(setup, snapshot):
    db, service, site, batch, actor, entry = setup
    batch.status = "billed"
    batch.customer_signed_at = datetime.now(timezone.utc)
    batch.customer_signature_name = "Testkunde"
    batch.customer_signature_strokes = [[{"x": 0.1, "y": 0.2}]]
    batch.customer_signed_snapshot = snapshot
    db.commit()
    undo(service, site, batch, actor)
    assert batch.customer_signed_at is None
    assert batch.customer_signature_name is None
    assert batch.customer_signature_strokes is None
    assert batch.customer_signed_snapshot is None
    evidence = batch.status_history[-1]["signatures"]
    assert evidence["customer_signature_name"] == "Testkunde"
    assert evidence["customer_signature_strokes"] == [[{"x": 0.1, "y": 0.2}]]
    assert evidence["customer_signed_snapshot"] == snapshot
    service._ensure_site_batch_can_be_edited_in_office(batch)


@pytest.mark.parametrize("history", [
    [None], ["broken"], [{}], [{"kind": "advance"}],
    [{"kind": "advance", "from": "reviewed", "to": "billed", "signature_groups": ["invalid"], "signatures": {}}],
    [{"kind": "advance", "from": "reviewed", "to": "billed", "signature_groups": ["customer"], "signatures": {}}],
    [{"kind": "advance", "from": "submitted", "to": "reviewed", "signature_groups": [], "signatures": {}}],
])
def test_incomplete_or_inconsistent_history_falls_back_instead_of_crashing(setup, history):
    db, service, site, batch, actor, entry = setup
    batch.status = "billed"
    batch.status_history = history
    db.commit()
    assert service._build_mobile_batch(batch).status_rollback_is_fallback is True
    assert undo(service, site, batch, actor).status == "submitted"
    assert batch.status_history[:-1] == history


def test_manual_status_change_is_recorded_and_rollback_preserves_snapshot_data(setup):
    db, service, site, batch, actor, entry = setup
    service.promote_site_batch_status(site_id=site.id, batch_id=batch.id, target_status="reviewed", current_user=actor)
    service.promote_site_batch_status(site_id=site.id, batch_id=batch.id, target_status="draft", current_user=actor)
    assert undo(service, site, batch, actor).status == "reviewed"
    assert undo(service, site, batch, actor).status == "submitted"


def test_missing_signature_cannot_be_recreated_from_a_status_name(setup):
    db, service, site, batch, actor, entry = setup
    batch.status = "customer_signed"
    db.commit()
    service.set_site_batch_billing_status(site_id=site.id, batch_id=batch.id, billing_status="billed")
    assert rollback_target(batch) == "submitted"
    assert undo(service, site, batch, actor).status == "submitted"
    assert batch.customer_signed_at is None


def test_migration_adds_empty_history_without_guessing_or_changing_existing_status():
    import importlib.util
    from pathlib import Path
    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    from sqlalchemy import create_engine, text
    path = Path(__file__).parents[2] / "alembic" / "versions" / "20260913_0117_measurement_status_history.py"
    spec = importlib.util.spec_from_file_location("history_migration", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    with create_engine("sqlite://").begin() as connection:
        connection.execute(text("CREATE TABLE site_measurement_batches (id INTEGER PRIMARY KEY, status TEXT)"))
        connection.execute(text("INSERT INTO site_measurement_batches VALUES (1, 'billed')"))
        with Operations.context(MigrationContext.configure(connection)):
            migration.upgrade()
        row = connection.execute(text("SELECT status, status_history FROM site_measurement_batches")).one()
        assert tuple(row) == ("billed", "[]")
