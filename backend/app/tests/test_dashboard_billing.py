from datetime import date, datetime, timezone

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import event

from app.api.dependencies import get_current_app_user
from app.core.database import get_db
from app.main import create_app
from app.models.enums import MeasurementBatchOrigin, SiteStatus, UserRole
from app.models.extra_work_ticket import ExtraWorkTicket
from app.models.person import Person
from app.models.site import Site
from app.models.site_measurement_item import SiteMeasurementBatch
from app.models.user import User
from app.services.dashboard_billing_service import DashboardBillingService
from app.tests.test_dashboard_note_service import db_session


@pytest.fixture
def data():
    with db_session() as db:
        manager = Person(first_name="Projekt", last_name="Leiter", display_name="Projekt Leiter", short_code="PL")
        user = User(username="billing-pm", display_name="Projektleiter", password_hash="x", role=UserRole.PROJECT_MANAGER, person=manager)
        site = Site(site_number="8007", name="Klinik", project_manager=manager)
        db.add_all([user, site])
        db.commit()
        yield db, user, site


def add_record(db, site, kind, status="submitted", number=1, **kwargs):
    if kind == "measurement":
        record = SiteMeasurementBatch(site=site, number=number, title=f"Aufmaß {number}", status=status, **kwargs)
    else:
        record = ExtraWorkTicket(site=site, sequence_number=number, display_number=f"{site.site_number}.Z{number:02d}", status=status, **kwargs)
    db.add(record)
    db.commit()
    return record


@pytest.mark.parametrize("kind", ["measurement", "extra_work"])
@pytest.mark.parametrize("status,label", [
    ("submitted", "Eingereicht"), ("in_review", "Eingereicht"),
    ("reviewed", "Geprüft"), ("checked", "Geprüft"),
    ("signed", "Unterschrieben"), ("customer_signed", "Unterschrieben"),
    *[(value, "Abgeschlossen") for value in ("billed", "approved", "closed", "completed", "finalized", "abgeschlossen")],
    (" REVIEWED ", "Geprüft"),
])
def test_includes_submitted_and_higher_without_confusing_completed_with_invoiced(data, kind, status, label):
    db, user, site = data
    record = add_record(db, site, kind, status)
    result = DashboardBillingService(db).get_overview(current_user=user)
    assert result.open_count == 1
    assert result.sites[0].items[0].id == record.id
    assert result.sites[0].items[0].kind == kind
    assert result.sites[0].items[0].status_label == label


@pytest.mark.parametrize("kind", ["measurement", "extra_work"])
@pytest.mark.parametrize("status", ["draft", "rejected", "unknown"])
def test_excludes_non_eligible_status_even_with_old_submission_timestamp(data, kind, status):
    db, user, site = data
    add_record(db, site, kind, status, submitted_at=datetime.now(timezone.utc))
    assert DashboardBillingService(db).get_overview(current_user=user).open_count == 0


@pytest.mark.parametrize("kind", ["measurement", "extra_work"])
def test_invoice_archive_restore_and_status_changes_are_read_live(data, kind):
    db, user, site = data
    record = add_record(db, site, kind, "billed")
    service = DashboardBillingService(db)
    assert service.get_overview(current_user=user).open_count == 1
    record.is_invoiced = True
    db.commit()
    assert service.get_overview(current_user=user).sites == []
    record.is_invoiced = False
    db.commit()
    assert service.get_overview(current_user=user).open_count == 1
    record.deleted_at = datetime.now(timezone.utc)
    db.commit()
    assert service.get_overview(current_user=user).sites == []
    record.deleted_at = None
    record.status = "draft"
    db.commit()
    assert service.get_overview(current_user=user).sites == []


def test_grouping_titles_sorting_and_closed_site_with_outstanding_billing(data):
    db, user, site = data
    site.status = SiteStatus.COMPLETED
    add_record(db, site, "measurement", number=2, origin=MeasurementBatchOrigin.OFFICE,
               area_location="  EG   links ", measurement_date=date(2026, 9, 15))
    add_record(db, site, "measurement", number=1)
    add_record(db, site, "extra_work", number=3)
    result = DashboardBillingService(db).get_overview(current_user=user)
    assert result.open_count == 3
    assert len(result.sites) == 1
    assert result.sites[0].project_manager_name == "Projekt Leiter"
    assert [item.title for item in result.sites[0].items] == ["Aufmaß 8007.02 - EG links", "Aufmaß 8007.01", "Zusatzauftrag 8007.Z03"]
    assert result.sites[0].items[0].date == date(2026, 9, 15)


def test_manager_only_sees_currently_assigned_sites_and_no_unassigned_sites(data):
    db, user, site = data
    other = Person(first_name="Andere", last_name="Leitung", display_name="Andere Leitung", short_code="AL")
    foreign = Site(site_number="8008", name="Andere Baustelle", project_manager=other)
    unassigned = Site(site_number="8009", name="Ohne Zuordnung")
    db.add_all([foreign, unassigned])
    db.commit()
    for target in (site, foreign, unassigned):
        for kind in ("measurement", "extra_work"):
            add_record(db, target, kind)
    service = DashboardBillingService(db)
    assert [row.site_id for row in service.get_overview(current_user=user).sites] == [site.id]
    site.project_manager = other
    db.commit()
    assert service.get_overview(current_user=user).sites == []
    user.person_id = None
    db.commit()
    assert service.get_overview(current_user=user).sites == []


@pytest.mark.parametrize("role", [UserRole.ADMIN, UserRole.OFFICE, UserRole.MONTEUR])
def test_billing_is_not_available_to_other_roles_even_if_linked_to_manager(data, role):
    db, user, site = data
    add_record(db, site, "measurement")
    user.role = role
    with pytest.raises(HTTPException) as error:
        DashboardBillingService(db).get_overview(current_user=user)
    assert error.value.status_code == 403


def test_constant_two_lightweight_queries_for_many_records(data):
    db, user, site = data
    for number in range(1, 21):
        add_record(db, site, "measurement", number=number)
        add_record(db, site, "extra_work", number=number)
    # Load the caller before counting; this normally comes from authentication.
    assert user.role == UserRole.PROJECT_MANAGER
    queries = []
    def track(_conn, _cursor, statement, *_args):
        queries.append(statement.lower())
    event.listen(db.bind, "before_cursor_execute", track)
    try:
        result = DashboardBillingService(db).get_overview(current_user=user)
    finally:
        event.remove(db.bind, "before_cursor_execute", track)
    assert result.open_count == 40
    assert len(queries) == 2
    assert all("signature_strokes" not in query and "snapshot" not in query and "entries" not in query for query in queries)


def test_deleted_sites_are_excluded(data):
    db, user, site = data
    add_record(db, site, "measurement")
    add_record(db, site, "extra_work")
    site.status = SiteStatus.DELETED
    db.commit()
    assert DashboardBillingService(db).get_overview(current_user=user).sites == []


def test_api_is_read_only_and_enforces_project_manager_scope(data):
    db, user, site = data
    add_record(db, site, "measurement")
    app = create_app()
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_app_user] = lambda: user
    client = TestClient(app)
    response = client.get("/api/dashboard/billing")
    assert response.status_code == 200
    assert response.json()["open_count"] == 1
    assert client.post("/api/dashboard/billing", json={"is_invoiced": True}).status_code == 405
    user.role = UserRole.OFFICE
    user.office_page_permissions = ["overview", "sites"]
    assert client.get("/api/dashboard/billing").status_code == 403
    user.role = UserRole.ADMIN
    assert client.get("/api/dashboard/billing").status_code == 403
