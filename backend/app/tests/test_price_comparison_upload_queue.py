from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import uuid4

from fastapi import HTTPException
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.models import Base
from app.models.enums import UserRole
from app.models.price_comparison_upload import (
    PriceComparisonUploadFile,
    PriceComparisonUploadJob,
)
from app.models.user import User
from app.api.dependencies import get_current_app_user
from app.api.routes.price_comparison import price_service, price_upload_queue
from app.core.database import get_db
from app.main import create_app
from app.services import price_comparison_upload_queue as queue_module
from app.services.price_comparison_upload_queue import PriceComparisonUploadQueue


PDF = b"%PDF-1.4\nsynthetic queue test\n%%EOF"


class FakeService:
    def __init__(self, responses: list[object] | None = None, identity: str = "store-a"):
        self.store = SimpleNamespace(configured=True, identity=identity)
        self.responses = list(responses or [{"revision": "a" * 64}])
        self.calls: list[dict] = []

    def upload_queued(
        self,
        kind,
        uploads,
        db,
        *,
        confirmed_revision=None,
        confirmed_duplicates=None,
    ):
        self.calls.append(
            {
                "kind": kind,
                "uploads": uploads,
                "confirmed_revision": confirmed_revision,
                "confirmed_duplicates": confirmed_duplicates,
            }
        )
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


@pytest.fixture
def queue_db():
    bind = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(bind)
    factory = sessionmaker(bind=bind, expire_on_commit=False)
    with factory() as db:
        user = User(
            username="queue-user",
            display_name="Queue User",
            password_hash="x",
            role=UserRole.PROJECT_MANAGER,
            is_active=True,
            office_page_permissions=[],
        )
        db.add(user)
        db.commit()
        user_id = user.id
    yield factory, user_id
    bind.dispose()


def _enqueue(queue, factory, user_id, service, *, request_id=None, name="Offer.pdf"):
    with factory() as db:
        return queue.enqueue(
            db,
            user_id=user_id,
            kind="offers",
            uploads=[(name, PDF)],
            client_request_id=request_id or str(uuid4()),
            service=service,
        )


def _job(factory, job_id):
    with factory() as db:
        return db.get(PriceComparisonUploadJob, job_id)


def _payload(factory, job_id):
    with factory() as db:
        return db.scalar(
            select(PriceComparisonUploadFile.payload).where(
                PriceComparisonUploadFile.job_id == job_id
            )
        )


def test_enqueue_is_idempotent_scoped_and_rejects_changed_payload(queue_db):
    factory, user_id = queue_db
    service = FakeService()
    queue = PriceComparisonUploadQueue(factory, service_factory=lambda: service)
    request_id = str(uuid4())

    first = _enqueue(queue, factory, user_id, service, request_id=request_id)
    repeated = _enqueue(queue, factory, user_id, service, request_id=request_id)

    assert repeated.id == first.id
    assert _payload(factory, first.id) == PDF
    with factory() as db:
        assert [job.id for job in queue.list_for_user(db, user_id, service=service)] == [first.id]
        assert queue.list_for_user(db, user_id, service=FakeService(identity="another-store")) == []

    with pytest.raises(HTTPException) as conflict:
        _enqueue(
            queue,
            factory,
            user_id,
            service,
            request_id=request_id,
            name="Different.pdf",
        )
    assert conflict.value.status_code == 409

    with pytest.raises(HTTPException) as scope_conflict:
        _enqueue(
            queue,
            factory,
            user_id,
            FakeService(identity="another-store"),
            request_id=request_id,
        )
    assert scope_conflict.value.status_code == 409


def test_duplicate_confirmation_then_completion_scrubs_payload(queue_db):
    factory, user_id = queue_db
    duplicate = HTTPException(
        409,
        {
            "code": "duplicate_offers",
            "message": "Bestätigen",
            "duplicates": [{"offer_number": "1", "keep": "New.pdf", "remove": "Old.pdf"}],
            "revision": "b" * 64,
        },
    )
    service = FakeService([duplicate, {"revision": "c" * 64}])
    queue = PriceComparisonUploadQueue(factory, service_factory=lambda: service)
    job = _enqueue(queue, factory, user_id, service, name="New.pdf")

    assert queue.process_next("worker-1") is True
    waiting = _job(factory, job.id)
    assert waiting.status == "awaiting_confirmation"
    assert waiting.confirmation_revision == "b" * 64
    assert _payload(factory, job.id) == PDF

    with factory() as db:
        confirmed = queue.confirm(
            db,
            job_id=job.id,
            user_id=user_id,
            role=UserRole.PROJECT_MANAGER,
            expected_revision="b" * 64,
            confirmed_duplicates=["Old.pdf"],
        )
        assert confirmed.status == "queued"

    assert queue.process_next("worker-1") is True
    completed = _job(factory, job.id)
    assert completed.status == "completed"
    assert completed.result_revision == "c" * 64
    assert _payload(factory, job.id) is None
    assert service.calls[1]["confirmed_revision"] == "b" * 64
    assert service.calls[1]["confirmed_duplicates"] == ["Old.pdf"]


def test_stale_confirmation_is_rechecked_without_old_approval(queue_db):
    factory, user_id = queue_db
    first_preview = HTTPException(
        409,
        {
            "code": "duplicate_offers",
            "duplicates": [{"keep": "New.pdf", "remove": "Old.pdf"}],
            "revision": "1" * 64,
        },
    )
    current_preview = HTTPException(
        409,
        {
            "code": "duplicate_offers",
            "duplicates": [{"keep": "New.pdf", "remove": "Current.pdf"}],
            "revision": "2" * 64,
        },
    )
    service = FakeService(
        [
            first_preview,
            HTTPException(
                409,
                "Der Preisvergleich wurde zwischenzeitlich geändert. Bitte neu laden.",
            ),
            current_preview,
        ]
    )
    queue = PriceComparisonUploadQueue(factory, service_factory=lambda: service)
    job = _enqueue(queue, factory, user_id, service, name="New.pdf")
    queue.process_next("worker-1")
    with factory() as db:
        queue.confirm(
            db,
            job_id=job.id,
            user_id=user_id,
            role=UserRole.PROJECT_MANAGER,
            expected_revision="1" * 64,
            confirmed_duplicates=["Old.pdf"],
        )

    queue.process_next("worker-1")
    requeued = _job(factory, job.id)
    assert requeued.status == "queued"
    assert requeued.confirmed_duplicates is None
    assert _payload(factory, job.id) == PDF

    queue.process_next("worker-1")
    refreshed = _job(factory, job.id)
    assert refreshed.status == "awaiting_confirmation"
    assert refreshed.confirmation_revision == "2" * 64
    assert service.calls[2]["confirmed_revision"] is None
    assert service.calls[2]["confirmed_duplicates"] is None


def test_worker_rechecks_user_and_store_before_processing(queue_db):
    factory, user_id = queue_db
    service = FakeService()
    queue = PriceComparisonUploadQueue(factory, service_factory=lambda: service)
    job = _enqueue(queue, factory, user_id, service)
    with factory() as db:
        db.get(User, user_id).is_active = False
        db.commit()

    queue.process_next("worker-1")

    failed = _job(factory, job.id)
    assert failed.status == "failed"
    assert "nicht mehr freigegeben" in failed.error
    assert service.calls == []
    assert _payload(factory, job.id) is None


def test_other_project_manager_cannot_confirm_or_cancel_jobs(queue_db):
    factory, user_id = queue_db
    duplicate = HTTPException(
        409,
        {
            "code": "duplicate_offers",
            "duplicates": [{"keep": "New.pdf", "remove": "Old.pdf"}],
            "revision": "b" * 64,
        },
    )
    service = FakeService([duplicate])
    queue = PriceComparisonUploadQueue(factory, service_factory=lambda: service)
    waiting = _enqueue(queue, factory, user_id, service, name="Waiting.pdf")
    queue.process_next("worker-1")
    cancellable = _enqueue(queue, factory, user_id, service, name="Queued.pdf")
    with factory() as db:
        other = User(
            username="other-queue-user",
            display_name="Other Queue User",
            password_hash="x",
            role=UserRole.PROJECT_MANAGER,
            is_active=True,
            office_page_permissions=[],
        )
        db.add(other)
        db.commit()
        other_id = other.id

    with factory() as db, pytest.raises(HTTPException) as confirm_error:
        queue.confirm(
            db,
            job_id=waiting.id,
            user_id=other_id,
            role=UserRole.PROJECT_MANAGER,
            expected_revision="b" * 64,
            confirmed_duplicates=["Old.pdf"],
        )
    assert confirm_error.value.status_code == 404
    with factory() as db, pytest.raises(HTTPException) as cancel_error:
        queue.cancel(
            db,
            job_id=cancellable.id,
            user_id=other_id,
            role=UserRole.PROJECT_MANAGER,
        )
    assert cancel_error.value.status_code == 404
    assert _job(factory, waiting.id).status == "awaiting_confirmation"
    assert _job(factory, cancellable.id).status == "queued"


def test_store_change_before_processing_fails_closed_and_scrubs(queue_db):
    factory, user_id = queue_db
    original = FakeService(identity="store-a")
    changed = FakeService(identity="store-b")
    queue = PriceComparisonUploadQueue(factory, service_factory=lambda: changed)
    job = _enqueue(queue, factory, user_id, original)

    assert queue.process_next("worker-1") is True

    failed = _job(factory, job.id)
    assert failed.status == "failed"
    assert "nicht mehr freigegeben" in failed.error
    assert changed.calls == []
    assert _payload(factory, job.id) is None


@pytest.mark.parametrize(
    ("limit_name", "limit_value", "expected_status"),
    [
        ("MAX_ACTIVE_JOBS_PER_USER", 1, 429),
        ("MAX_ACTIVE_BYTES_PER_USER", len(PDF), 429),
        ("MAX_ACTIVE_BYTES_GLOBAL", len(PDF), 503),
    ],
)
def test_quota_boundary_releases_capacity_after_completion(
    queue_db, monkeypatch, limit_name, limit_value, expected_status
):
    factory, user_id = queue_db
    service = FakeService()
    queue = PriceComparisonUploadQueue(factory, service_factory=lambda: service)
    monkeypatch.setattr(queue_module, limit_name, limit_value)
    first = _enqueue(queue, factory, user_id, service, name="First.pdf")

    with pytest.raises(HTTPException) as full:
        _enqueue(queue, factory, user_id, service, name="Blocked.pdf")
    assert full.value.status_code == expected_status

    queue.process_next("worker-1")
    assert _job(factory, first.id).status == "completed"
    accepted = _enqueue(queue, factory, user_id, service, name="Accepted.pdf")
    assert accepted.status == "queued"


def test_failed_job_does_not_block_next_queued_job(queue_db):
    factory, user_id = queue_db
    service = FakeService([RuntimeError("synthetic parser failure"), {"revision": "c" * 64}])
    queue = PriceComparisonUploadQueue(factory, service_factory=lambda: service)
    first = _enqueue(queue, factory, user_id, service, name="First.pdf")
    second = _enqueue(queue, factory, user_id, service, name="Second.pdf")
    with factory() as db:
        db.get(PriceComparisonUploadJob, first.id).created_at = datetime(
            2026, 11, 26, 10, tzinfo=UTC
        )
        db.get(PriceComparisonUploadJob, second.id).created_at = datetime(
            2026, 11, 26, 11, tzinfo=UTC
        )
        db.commit()

    assert queue.process_next("worker-1") is True
    assert _job(factory, first.id).status == "failed"
    assert queue.process_next("worker-1") is True
    assert _job(factory, second.id).status == "completed"
    assert _payload(factory, first.id) is None
    assert _payload(factory, second.id) is None


def test_queued_job_persists_across_queue_instances(queue_db):
    factory, user_id = queue_db
    service = FakeService()
    first_queue = PriceComparisonUploadQueue(factory, service_factory=lambda: service)
    job = _enqueue(first_queue, factory, user_id, service)

    restarted_queue = PriceComparisonUploadQueue(factory, service_factory=lambda: service)
    assert restarted_queue.process_next("worker-after-restart") is True

    assert _job(factory, job.id).status == "completed"
    assert service.calls[0]["uploads"] == [("Offer.pdf", PDF)]


def test_cancel_and_interrupted_recovery_are_terminal_and_scrub(queue_db):
    factory, user_id = queue_db
    service = FakeService()
    now = datetime(2026, 11, 26, 12, tzinfo=UTC)
    queue = PriceComparisonUploadQueue(factory, service_factory=lambda: service, now=lambda: now)
    cancelled = _enqueue(queue, factory, user_id, service, name="Cancel.pdf")
    with factory() as db:
        queue.cancel(
            db,
            job_id=cancelled.id,
            user_id=user_id,
            role=UserRole.PROJECT_MANAGER,
        )
    assert _job(factory, cancelled.id).status == "cancelled"
    assert _payload(factory, cancelled.id) is None

    interrupted = _enqueue(queue, factory, user_id, service, name="Interrupted.pdf")
    with factory() as db:
        row = db.get(PriceComparisonUploadJob, interrupted.id)
        row.status = "processing"
        row.heartbeat_at = None
        row.started_at = now - timedelta(minutes=5)
        db.commit()
    assert queue.recover_interrupted() == 1
    assert _job(factory, interrupted.id).status == "failed"
    assert _payload(factory, interrupted.id) is None


def test_upload_job_routes_return_recoverable_client_request_id(queue_db):
    factory, user_id = queue_db
    service = FakeService()
    queue = PriceComparisonUploadQueue(factory, service_factory=lambda: service)
    app = create_app()
    db = factory()
    user = db.get(User, user_id)
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_app_user] = lambda: user
    app.dependency_overrides[price_service] = lambda: service
    app.dependency_overrides[price_upload_queue] = lambda: queue
    client = TestClient(app)
    request_id = str(uuid4())

    created = client.post(
        "/api/price-comparison/upload-jobs",
        data={"kind": "offers", "client_request_id": request_id},
        files={"files": ("Route.pdf", PDF, "application/pdf")},
    )
    repeated = client.post(
        "/api/price-comparison/upload-jobs",
        data={"kind": "offers", "client_request_id": request_id},
        files={"files": ("Route.pdf", PDF, "application/pdf")},
    )
    listed = client.get("/api/price-comparison/upload-jobs")

    assert created.status_code == 202
    assert repeated.status_code == 202
    assert repeated.json()["job"]["id"] == created.json()["job"]["id"]
    assert listed.status_code == 200
    assert listed.json()["jobs"][0]["client_request_id"] == request_id

    cancelled = client.delete(f"/api/price-comparison/upload-jobs/{created.json()['job']['id']}")
    assert cancelled.status_code == 200
    assert cancelled.json()["job"]["status"] == "cancelled"
    db.close()


def test_upload_jobs_get_keeps_awaiting_job_visible_beyond_history_limit(queue_db):
    factory, user_id = queue_db
    service = FakeService()
    queue = PriceComparisonUploadQueue(factory, service_factory=lambda: service)
    awaiting = _enqueue(queue, factory, user_id, service, name="Awaiting.pdf")
    with factory() as db:
        waiting_row = db.get(PriceComparisonUploadJob, awaiting.id)
        waiting_row.status = "awaiting_confirmation"
        waiting_row.confirmation_revision = "b" * 64
        waiting_row.duplicates = [
            {"offer_number": "1", "keep": "Awaiting.pdf", "remove": "Old.pdf"}
        ]
        for index in range(101):
            db.add(
                PriceComparisonUploadJob(
                    id=str(uuid4()),
                    created_by_user_id=user_id,
                    client_request_id=str(uuid4()),
                    request_digest=f"{index:064x}",
                    store_identity=waiting_row.store_identity,
                    kind="offers",
                    status="completed",
                    file_names=[f"History-{index}.pdf"],
                    file_count=1,
                    total_bytes=1,
                    message="Upload abgeschlossen.",
                    finished_at=datetime(2026, 11, 26, 12, tzinfo=UTC),
                )
            )
        db.commit()

    app = create_app()
    db = factory()
    user = db.get(User, user_id)
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_app_user] = lambda: user
    app.dependency_overrides[price_service] = lambda: service
    app.dependency_overrides[price_upload_queue] = lambda: queue
    response = TestClient(app).get("/api/price-comparison/upload-jobs")

    assert response.status_code == 200
    jobs = response.json()["jobs"]
    assert len(jobs) == 100
    assert any(job["id"] == awaiting.id for job in jobs)
    assert next(job for job in jobs if job["id"] == awaiting.id)["status"] == (
        "awaiting_confirmation"
    )
    db.close()
