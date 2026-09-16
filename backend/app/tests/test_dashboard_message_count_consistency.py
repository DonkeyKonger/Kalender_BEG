from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from app.api.dependencies import get_current_app_user
from app.core.database import get_db
from app.main import create_app
from app.models.enums import UserRole
from app.models.extra_work_ticket import ExtraWorkTicket
from app.models.person import Person
from app.models.site import Site
from app.models.site_measurement_item import SiteMeasurementBatch
from app.models.user import User
from app.services.dashboard_message_service import DashboardMessageService
from app.tests.test_dashboard_note_service import db_session


NOW = datetime(2026, 9, 16, 12, tzinfo=timezone.utc)


@pytest.fixture
def data():
    with db_session() as db:
        person = Person(first_name="Projekt", last_name="Leitung", display_name="Projekt Leitung", short_code="PL")
        user = User(username="counter", display_name="Projektleitung", password_hash="x", role=UserRole.PROJECT_MANAGER, person=person)
        site = Site(name="Testbaustelle", site_number="8007", project_manager=person)
        db.add_all([site, user])
        db.commit()
        yield db, user, site


def batch(db, site, number, *, signed=False, archived=False, status=None):
    result = SiteMeasurementBatch(
        site=site, number=number, title=f"Aufmaß {number}",
        status=status or ("customer_signed" if signed else "submitted"),
        submitted_at=NOW, customer_signed_at=NOW if signed else None,
        deleted_at=NOW if archived else None,
    )
    db.add(result)
    db.commit()
    return result


@pytest.mark.parametrize("role", [UserRole.ADMIN, UserRole.PROJECT_MANAGER, UserRole.OFFICE])
@pytest.mark.parametrize("signed", [False, True])
def test_counter_reaches_zero_after_visible_messages_read_despite_archived_measurement(data, role, signed):
    db, user, site = data
    user.role = role
    batch(db, site, 1, signed=signed, archived=True)
    visible = batch(db, site, 2, signed=signed)
    service = DashboardMessageService(db)
    messages = service.list_messages(limit=6, current_user=user)
    assert [message.batch_id for message in messages] == [visible.id]
    for message in messages:
        service.dismiss_message(message_key=message.message_key, current_user=user)
    summary = service.get_summary(limit=6, current_user=user)
    assert summary.latest_messages == []
    assert summary.open_count == 0
    assert service.count_open_messages(current_user=user) == 0


@pytest.mark.parametrize("signed", [False, True])
def test_archiving_and_restoring_keep_list_count_and_per_user_read_state_in_sync(data, signed):
    db, user, site = data
    record = batch(db, site, 1, signed=signed)
    other = User(username="other-counter", display_name="Andere Leitung", password_hash="x", role=UserRole.PROJECT_MANAGER, person_id=user.person_id)
    db.add(other)
    db.commit()
    service = DashboardMessageService(db)
    message = service.list_messages(limit=6, current_user=user)[0]
    service.dismiss_message(message_key=message.message_key, current_user=user)
    assert service.count_open_messages(current_user=user) == 0
    assert service.count_open_messages(current_user=other) == 1
    record.deleted_at = NOW
    db.commit()
    assert service.get_summary(limit=6, current_user=other).latest_messages == []
    assert service.count_open_messages(current_user=other) == 0
    record.deleted_at = None
    db.commit()
    assert service.count_open_messages(current_user=user) == 0
    restored = service.get_summary(limit=6, current_user=other)
    assert restored.open_count == len(restored.latest_messages) == 1


def test_reading_all_preview_pages_preserves_real_unread_count_and_ignores_archived_records(data):
    db, user, site = data
    for number in range(1, 15):
        batch(db, site, number, signed=number % 2 == 0, archived=number > 12)
    ticket = ExtraWorkTicket(site=site, sequence_number=1, display_number="8007.Z01", status="submitted", submitted_at=NOW)
    archived_ticket = ExtraWorkTicket(site=site, sequence_number=2, display_number="8007.Z02", status="submitted", submitted_at=NOW, deleted_at=NOW)
    db.add_all([ticket, archived_ticket])
    db.commit()
    service = DashboardMessageService(db)
    expected = 13
    while expected:
        summary = service.get_summary(limit=6, current_user=user)
        assert summary.open_count == expected
        assert len(summary.latest_messages) == min(6, expected)
        for message in summary.latest_messages:
            service.dismiss_message(message_key=message.message_key, current_user=user)
            expected -= 1
    assert service.get_summary(limit=6, current_user=user).model_dump() == {"open_count": 0, "latest_messages": []}


def test_count_and_list_keep_project_manager_scope_and_new_signature_notifications(data):
    db, user, site = data
    foreign = Site(name="Fremde Baustelle", site_number="8008")
    db.add(foreign)
    db.commit()
    batch(db, foreign, 1)
    record = batch(db, site, 1)
    batch(db, site, 2, signed=True, status="billed")
    service = DashboardMessageService(db)
    summary = service.get_summary(limit=6, current_user=user)
    assert summary.open_count == len(summary.latest_messages) == 1
    service.dismiss_message(message_key=summary.latest_messages[0].message_key, current_user=user)
    assert service.count_open_messages(current_user=user) == 0
    record.status = "customer_signed"
    record.customer_signed_at = NOW
    db.commit()
    summary = service.get_summary(limit=6, current_user=user)
    assert summary.open_count == len(summary.latest_messages) == 1
    assert summary.latest_messages[0].message_key == f"measurement_customer_signed:{record.id}"


def test_summary_and_live_count_endpoints_both_exclude_archived_measurements(data):
    db, user, site = data
    batch(db, site, 1, archived=True)
    batch(db, site, 2, archived=True, signed=True)
    app = create_app()
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_app_user] = lambda: user
    client = TestClient(app)
    assert client.get("/api/dashboard/messages/summary").json() == {"open_count": 0, "latest_messages": []}
    assert client.get("/api/dashboard/messages/unread-count").json() == {"count": 0}
