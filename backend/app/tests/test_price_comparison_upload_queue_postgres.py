from concurrent.futures import ThreadPoolExecutor
import os
from threading import Barrier, Event
from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, delete, select
from sqlalchemy.orm import sessionmaker

from app.models.enums import UserRole
from app.models.price_comparison_upload import (
    PriceComparisonUploadFile,
    PriceComparisonUploadJob,
)
from app.models.user import User
from app.services.price_comparison_upload_queue import (
    PriceComparisonUploadQueue,
    PriceComparisonUploadWorker,
)


POSTGRES_URL = os.environ.get("TEST_POSTGRES_URL")
pytestmark = pytest.mark.skipif(not POSTGRES_URL, reason="requires isolated PostgreSQL")


class Service:
    store = SimpleNamespace(configured=True, identity="postgres-queue-test")


@pytest.fixture
def postgres_queue():
    bind = create_engine(POSTGRES_URL, pool_pre_ping=True)
    factory = sessionmaker(bind=bind, expire_on_commit=False)
    with factory() as db:
        user = User(
            username=f"queue-pg-{uuid4()}",
            display_name="Queue PostgreSQL",
            password_hash="x",
            role=UserRole.PROJECT_MANAGER,
            is_active=True,
            office_page_permissions=[],
        )
        db.add(user)
        db.commit()
        user_id = user.id
    queue = PriceComparisonUploadQueue(factory, service_factory=Service)
    yield queue, factory, user_id
    with factory() as db:
        ids = list(
            db.scalars(
                select(PriceComparisonUploadJob.id).where(
                    PriceComparisonUploadJob.created_by_user_id == user_id
                )
            )
        )
        if ids:
            db.execute(
                delete(PriceComparisonUploadFile).where(PriceComparisonUploadFile.job_id.in_(ids))
            )
            db.execute(delete(PriceComparisonUploadJob).where(PriceComparisonUploadJob.id.in_(ids)))
        db.execute(delete(User).where(User.id == user_id))
        db.commit()
    bind.dispose()


def test_postgres_claim_is_singleflight_across_independent_sessions(postgres_queue):
    queue, factory, user_id = postgres_queue
    for name in ("One.pdf", "Two.pdf"):
        with factory() as db:
            queue.enqueue(
                db,
                user_id=user_id,
                kind="offers",
                uploads=[(name, b"%PDF-1.4\nqueue")],
                client_request_id=str(uuid4()),
                service=Service(),
            )

    barrier = Barrier(2)

    def claim(worker_id):
        independent = PriceComparisonUploadQueue(factory, service_factory=Service)
        barrier.wait()
        return independent._claim_next(worker_id)

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(claim, ("worker-a", "worker-b")))

    assert sum(result is not None for result in results) == 1
    with factory() as db:
        statuses = list(
            db.scalars(
                select(PriceComparisonUploadJob.status).where(
                    PriceComparisonUploadJob.created_by_user_id == user_id
                )
            )
        )
    assert sorted(statuses) == ["processing", "queued"]


def test_postgres_advisory_leader_lock_has_one_holder(postgres_queue):
    queue, _factory, _user_id = postgres_queue
    first = PriceComparisonUploadWorker(queue)
    second = PriceComparisonUploadWorker(queue)
    entered = Event()
    release = Event()

    def hold_first():
        with first._leader() as acquired:
            assert acquired is True
            entered.set()
            release.wait(5)

    with ThreadPoolExecutor(max_workers=2) as executor:
        future = executor.submit(hold_first)
        assert entered.wait(5)
        with second._leader() as acquired:
            assert acquired is False
        release.set()
        future.result(timeout=5)

    with second._leader() as acquired_after_release:
        assert acquired_after_release is True
