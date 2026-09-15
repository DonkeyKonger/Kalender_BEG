"""Overview responses must stay complete without fetching immutable PDF payloads."""
from datetime import datetime, timezone

import pytest
from sqlalchemy import event, inspect, null
from sqlalchemy.orm import Session

from app.models.site_measurement_item import SiteMeasurementBatch
from app.services.measurement_service import MeasurementService
from app.tests.test_measurement_service import db_session, create_site, create_measurement_base


HEAVY_FIELDS = {
    "original_submitted_snapshot", "customer_signed_snapshot",
    "customer_signature_strokes", "worker_signature_strokes",
}


@pytest.mark.parametrize("snapshot", [None, {}, {"items": [{"description": "x" * 100_000}]}])
def test_overview_preserves_snapshot_flags_and_response_without_loading_payloads(snapshot):
    db = db_session()
    site = create_site(db)
    base = create_measurement_base(db, site)
    batch = SiteMeasurementBatch(
        site=site, measurement_base=base, number=1, title="Aufmaß 1",
        status="customer_signed", origin="MONTEUR",
        submitted_at=datetime.now(timezone.utc), customer_signed_at=datetime.now(timezone.utc),
        original_submitted_snapshot=snapshot, customer_signed_snapshot=snapshot,
        customer_signature_strokes=[[{"x": 1, "y": 2}]], worker_signature_strokes=[],
    )
    db.add(batch)
    db.commit()
    site_id, batch_id = site.id, batch.id
    # Fresh sessions, as in real HTTP requests; an identity-map hit must not hide a load.
    with Session(db.get_bind()) as full_db:
        full = full_db.get(SiteMeasurementBatch, batch_id)
        expected = MeasurementService(full_db)._build_mobile_batch(full).model_dump()
    with Session(db.get_bind()) as list_db:
        captured = []
        service = MeasurementService(list_db)
        build = service._build_mobile_batch
        def verify_deferred(batch, **kwargs):
            captured.append(batch)
            assert HEAVY_FIELDS <= inspect(batch).unloaded
            return build(batch, **kwargs)
        service._build_mobile_batch = verify_deferred
        [actual] = service.list_site_batches(site_id)
        assert actual.model_dump() == expected
        assert actual.has_signed_snapshot is (snapshot is not None)
        assert actual.has_original_worker_submission is (snapshot is not None)
        assert len(captured) == 1
    # The optimization must never remove or modify the signed originals.
    with Session(db.get_bind()) as check_db:
        assert check_db.get(SiteMeasurementBatch, batch_id).customer_signed_snapshot == snapshot


def test_overview_handles_sql_null_and_archive_filter_without_per_batch_queries():
    db = db_session()
    site = create_site(db)
    base = create_measurement_base(db, site)
    site_id = site.id
    for number in range(1, 102):
        db.add(SiteMeasurementBatch(
            site=site, measurement_base=base, number=number, title=f"Aufmaß {number}",
            status="submitted", submitted_at=datetime.now(timezone.utc),
            original_submitted_snapshot=null(), customer_signed_snapshot=null(),
            deleted_at=datetime.now(timezone.utc) if number == 101 else None,
        ))
    db.commit()
    counts = []
    for archived, expected_count in [(False, 100), (True, 1)]:
        queries = []
        def track(conn, cursor, statement, parameters, context, many):
            queries.append(statement)
        engine = db.get_bind()
        event.listen(engine, "before_cursor_execute", track)
        try:
            with Session(engine) as fresh:
                result = MeasurementService(fresh).list_site_batches(site_id, archived_only=archived)
                assert len(result) == expected_count
                assert all(not row.has_signed_snapshot and not row.has_original_worker_submission for row in result)
        finally:
            event.remove(engine, "before_cursor_execute", track)
        counts.append(len(queries))
    assert counts[0] == counts[1], "Overview must not add a query per measurement"
    assert counts[0] <= 15
