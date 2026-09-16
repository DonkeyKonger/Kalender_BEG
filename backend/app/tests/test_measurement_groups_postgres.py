"""Optional real-lock regression test, restricted to an ephemeral local QA DB."""
from concurrent.futures import ThreadPoolExecutor
import os
from threading import Barrier, Event

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from app.models import Base
from app.models.measurement_group import MeasurementGroup, MeasurementGroupMember
from app.models.site_measurement_item import SiteMeasurementEntry
from app.services import measurement_group_service as groups
from app.tests.test_measurement_groups import setup_group


URL = os.getenv("TEST_MEASUREMENT_GROUP_DATABASE_URL")


@pytest.mark.skipif(not URL, reason="Requires an isolated local PostgreSQL QA database")
def test_parallel_creation_is_idempotent_and_a_racing_edit_invalidates_the_snapshot(monkeypatch):
    url = make_url(URL)
    assert url.host == "127.0.0.1" and url.database == "measurement_group_qa"
    engine = create_engine(url, connect_args={"options": "-c lock_timeout=5000 -c statement_timeout=10000"})
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        site, user, batches = setup_group(db, 4)
        site_id, user_id = site.id, user.id
        ids = [batch.id for batch in batches]
        entry_id = batches[2].entries[0].id
    barrier = Barrier(2)
    def create_pair():
        from app.models.user import User
        with Session(engine) as db:
            actor = db.get(User, user_id)
            barrier.wait(timeout=10)
            return groups.MeasurementGroupService(db).create(site_id, ids[:2], actor).id
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(create_pair)
        second = pool.submit(create_pair)
        assert first.result(timeout=15) == second.result(timeout=15)

    locked, editing = Event(), Event()
    original = groups.build_group_snapshot
    def snapshot(*args):
        locked.set()
        assert editing.wait(timeout=10)
        return original(*args)
    monkeypatch.setattr(groups, "build_group_snapshot", snapshot)
    def create_while_editing():
        from app.models.user import User
        with Session(engine) as db:
            return groups.MeasurementGroupService(db).create(site_id, ids[2:], db.get(User, user_id)).id
    def edit():
        assert locked.wait(timeout=10)
        with Session(engine) as db:
            entry = db.get(SiteMeasurementEntry, entry_id)
            entry.quantity = 999
            editing.set()
            db.commit()
    with ThreadPoolExecutor(max_workers=2) as pool:
        creating = pool.submit(create_while_editing)
        updating = pool.submit(edit)
        group_id = creating.result(timeout=15)
        updating.result(timeout=15)
    with Session(engine) as db:
        group = db.get(MeasurementGroup, group_id)
        assert group.invalidated_at is not None
        assert group.snapshot["cells"][0]["quantity"] == "2.50"
        assert not db.scalar(select(MeasurementGroupMember.batch_id).where(
            MeasurementGroupMember.group_id == group_id, MeasurementGroupMember.active.is_(True)))
        assert db.get(SiteMeasurementEntry, entry_id).quantity == 999
    engine.dispose()
