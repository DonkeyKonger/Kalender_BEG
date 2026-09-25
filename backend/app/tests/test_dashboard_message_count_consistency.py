from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from app.api.dependencies import get_current_app_user
from app.core.database import get_db
from app.main import create_app
from app.models.enums import UserRole
from app.models.dashboard_note import DashboardNote
from app.models.extra_work_ticket import ExtraWorkTicket
from app.models.person import Person
from app.models.site import Site
from app.models.site_measurement_item import SiteMeasurementBatch
from app.models.user import User
from app.services.dashboard_message_service import DashboardMessageService
from app.services.measurement_service import MeasurementService
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
    assert [message.batch_id for message in messages] == (
        [visible.id] if role == UserRole.PROJECT_MANAGER else []
    )
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


@pytest.mark.parametrize("total", [18, 27])
def test_default_summary_returns_all_unread_messages_not_just_six_or_twenty(data, total):
    db, user, site = data
    for number in range(1, total - 7):
        batch(db, site, number, signed=number % 2 == 0)
    for number in range(1, 7):
        db.add(ExtraWorkTicket(site=site, sequence_number=number, display_number=f"8007.Z{number:02d}",
                               status="submitted", submitted_at=NOW))
    for number in range(1, 3):
        db.add(DashboardNote(text=f"Geteilte Notiz {number}", created_by_user_id=user.id,
                             shared_with_user_id=user.id, shared_at=NOW, share_revision=1))
    db.commit()
    app = create_app()
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_app_user] = lambda: user
    client = TestClient(app)

    response = client.get("/api/dashboard/messages/summary")
    assert response.status_code == 200
    summary = response.json()
    assert summary["open_count"] == total
    assert len(summary["latest_messages"]) == total
    assert len({row["message_key"] for row in summary["latest_messages"]}) == total
    assert {row["message_type"] for row in summary["latest_messages"]} == {
        "measurement_submitted", "measurement_customer_signed", "extra_work_submitted", "dashboard_note_shared",
    }

    # Optional, explicit previews still work for other consumers.
    preview = client.get("/api/dashboard/messages/summary?limit=6").json()
    assert preview["open_count"] == total
    assert len(preview["latest_messages"]) == 6
    key = summary["latest_messages"][-1]["message_key"]
    DashboardMessageService(db).dismiss_message(message_key=key, current_user=user)
    remaining = client.get("/api/dashboard/messages/summary").json()
    assert remaining["open_count"] == len(remaining["latest_messages"]) == total - 1
    assert key not in {row["message_key"] for row in remaining["latest_messages"]}


@pytest.mark.parametrize("recipient", ["assigned", "other", "unlinked", "office", "admin"])
def test_only_assigned_manager_receives_document_messages_on_all_endpoints(data, recipient):
    db, user, site = data
    unassigned_site = Site(name="Ohne Projektleitung", site_number="8008")
    foreign_site = Site(name="Andere Projektleitung", site_number="8009", project_manager=Person(
        first_name="Andere", last_name="Leitung", display_name="Andere Leitung", short_code="AL"))
    db.add_all([unassigned_site, foreign_site])
    db.commit()
    own_keys = set()
    for target in (site, unassigned_site, foreign_site):
        submitted = batch(db, target, 1)
        signed = batch(db, target, 2, signed=True)
        ticket = ExtraWorkTicket(site=target, sequence_number=1, display_number=f"{target.site_number}.Z01",
                                 status="submitted", submitted_at=NOW)
        db.add(ticket)
        db.commit()
        if target == site:
            own_keys = {f"measurement_submitted:{submitted.id}", f"measurement_customer_signed:{signed.id}",
                        f"extra_work_submitted:{ticket.id}"}
    if recipient == "unlinked":
        user.person = None
    elif recipient == "other":
        user.person = Person(first_name="Ohne", last_name="Baustellen", display_name="Ohne Baustellen", short_code="OB")
    elif recipient in {"office", "admin"}:
        # Even sharing the assigned person's ID must not turn an office/admin
        # account into a recipient. Role and assignment must both match.
        user.role = UserRole.OFFICE if recipient == "office" else UserRole.ADMIN
        user.office_page_permissions = ["overview", "calendar", "sites"]
    note = DashboardNote(text="Andere Meldungen bleiben sichtbar", created_by_user_id=user.id,
                         shared_with_user_id=user.id, shared_at=NOW, share_revision=1)
    db.add(note)
    db.commit()
    app = create_app()
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_app_user] = lambda: user
    client = TestClient(app)
    expected = own_keys if recipient == "assigned" else set()
    response = client.get("/api/dashboard/measurement-submissions")
    assert response.status_code == 200
    assert {row["message_key"] for row in response.json()} == expected
    response = client.get("/api/dashboard/messages/summary")
    assert response.status_code == 200
    summary = response.json()
    assert {row["message_key"] for row in summary["latest_messages"]} == expected | {f"dashboard_note_shared:{note.id}:1"}
    assert summary["open_count"] == len(expected) + 1
    assert client.get("/api/dashboard/messages/unread-count").json() == {"count": len(expected) + 1}


def test_manager_reassignment_moves_existing_document_messages_without_office_fallback(data):
    db, user, site = data
    batch(db, site, 1)
    batch(db, site, 2, signed=True)
    db.add(ExtraWorkTicket(site=site, sequence_number=1, display_number="8007.Z01", status="submitted", submitted_at=NOW))
    other = User(username="new-manager", display_name="Neue Leitung", password_hash="x", role=UserRole.PROJECT_MANAGER,
                 person=Person(first_name="Neue", last_name="Leitung", display_name="Neue Leitung", short_code="NL"))
    db.add(other)
    db.commit()
    service = DashboardMessageService(db)
    assert service.get_summary(limit=None, current_user=user).open_count == 3
    site.project_manager = other.person
    db.commit()
    assert service.get_summary(limit=None, current_user=user).model_dump() == {"open_count": 0, "latest_messages": []}
    summary = service.get_summary(limit=None, current_user=other)
    assert summary.open_count == len(summary.latest_messages) == 3
    # No user context must not expose a global submission inbox either.
    assert MeasurementService(db).list_dashboard_submissions() == []
    assert MeasurementService(db).count_dashboard_submissions() == 0
