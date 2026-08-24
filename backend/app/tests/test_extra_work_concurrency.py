from concurrent.futures import ThreadPoolExecutor
import os
from threading import Barrier
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from app.models import Base
from app.models.enums import UserRole
from app.models.extra_work_ticket import ExtraWorkTicket
from app.models.site import Site
from app.models.user import User
from app.schemas.extra_work import ExtraWorkTicketCreate
from app.services.extra_work_service import ExtraWorkService


CONCURRENCY_DATABASE_URL = os.getenv("EXTRA_WORK_CONCURRENCY_DATABASE_URL")


@pytest.mark.skipif(
    not CONCURRENCY_DATABASE_URL,
    reason="EXTRA_WORK_CONCURRENCY_DATABASE_URL is required for the PostgreSQL lock test.",
)
def test_nearly_simultaneous_creations_receive_unique_consecutive_numbers():
    database_url = make_url(CONCURRENCY_DATABASE_URL)
    if database_url.get_backend_name() != "postgresql":
        pytest.fail("The concurrency regression must run against PostgreSQL.")
    if "test" not in (database_url.database or "").lower():
        pytest.fail("The concurrency regression refuses to use a database without 'test' in its name.")

    engine = create_engine(database_url, pool_pre_ping=True)
    schema = f"extra_work_concurrency_{uuid4().hex}"
    with engine.begin() as connection:
        connection.exec_driver_sql(f'CREATE SCHEMA "{schema}"')
    isolated_engine = engine.execution_options(schema_translate_map={None: schema})

    try:
        Base.metadata.create_all(isolated_engine)
        with Session(isolated_engine) as db:
            site = Site(site_number="9999", name="Paralleltest")
            actor = User(
                username="parallel-test",
                display_name="Paralleltest",
                password_hash="x",
                role=UserRole.OFFICE,
                office_page_permissions=["sites"],
            )
            db.add_all([site, actor])
            db.commit()
            site_id = site.id
            actor_id = actor.id

        start_barrier = Barrier(2)

        def create_ticket() -> tuple[int, str]:
            with Session(isolated_engine) as db:
                actor = db.get(User, actor_id)
                assert actor is not None
                start_barrier.wait(timeout=5)
                created = ExtraWorkService(db).create_site_ticket(
                    site_id=site_id,
                    current_user=actor,
                    payload=ExtraWorkTicketCreate(),
                )
                return created.sequence_number, created.display_number

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(lambda _index: create_ticket(), range(2)))

        assert sorted(results) == [(1, "9999.Z01"), (2, "9999.Z02")]
        with Session(isolated_engine) as db:
            stored = db.execute(
                select(
                    ExtraWorkTicket.sequence_number,
                    ExtraWorkTicket.display_number,
                ).order_by(ExtraWorkTicket.sequence_number)
            ).all()
        assert stored == [(1, "9999.Z01"), (2, "9999.Z02")]
    finally:
        Base.metadata.drop_all(isolated_engine)
        with engine.begin() as connection:
            connection.exec_driver_sql(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE')
        engine.dispose()
