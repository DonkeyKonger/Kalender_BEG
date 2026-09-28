from datetime import datetime, timezone

import pytest

from app.models.audit_log import AuditLog
from app.services.customer_email_status import audit_email_recipients
from app.services.extra_work_service import ExtraWorkService
from app.services.measurement_service import MeasurementService
from app.tests.test_measurement_service import db_session


@pytest.mark.parametrize("payload,expected", [
    ({}, []), ({"recipients": None}, []), ({"recipients": "legacy"}, []),
    ({"recipients": [" Kunde@example.de ", "kunde@example.de", "", None, 12, "bauleitung@example.de"]}, ["Kunde@example.de", "bauleitung@example.de"]),
])
def test_recorded_recipient_normalization(payload, expected):
    assert audit_email_recipients(payload) == expected


@pytest.mark.parametrize("kind", ["measurement", "extra_work"])
def test_status_uses_latest_matching_send_event_and_preserves_missing_legacy_recipients(kind):
    db = db_session()
    entity = "measurement_batch" if kind == "measurement" else "extra_work_ticket"
    timestamp = datetime(2026, 9, 28, 8, tzinfo=timezone.utc)
    for entity_id, action, payload in [
        (7, f"{kind}.email_sent", {"recipients": ["old@example.de"]}),
        (7, f"{kind}.email_sent", {"recipients": ["actual@example.de", "second@example.de"], "customer_signature_present": True}),
        (7, f"{kind}.updated", {"recipients": ["unrelated@example.de"]}),
        (8, f"{kind}.email_sent", {"customer_signature_present": False}),
    ]:
        db.add(AuditLog(user_id=None, action=action, entity_type=entity, entity_id=entity_id,
                        old_value_json=None, new_value_json=payload, created_at=timestamp))
        db.flush()
    db.commit()
    if kind == "measurement":
        statuses = MeasurementService(db)._latest_customer_email_statuses(entity_type=entity, action=f"{kind}.email_sent", entity_ids=[7, 8, 9])
    else:
        statuses = ExtraWorkService(db)._latest_customer_email_statuses([7, 8, 9])
    assert statuses[7][1:] == (True, ["actual@example.de", "second@example.de"])
    assert statuses[8][1:] == (False, [])
    assert 9 not in statuses
    db.close()
