from datetime import date, datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models import Base
from app.models.absence import Absence
from app.models.assignment import Assignment
from app.models.enums import AbsenceStatus, AbsenceType, MatrixCellMark, PersonType, SiteStatus, UserRole
from app.models.person import Person
from app.models.planning_cell_mark import PlanningCellMark
from app.models.site import Site
from app.models.user import User
from app.services.dashboard_service import DashboardService


@pytest.fixture
def db():
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session
    engine.dispose()


def worker(db, name="Worker", **kwargs):
    person = Person(first_name=name, last_name="Test", display_name=name, short_code=name, **kwargs)
    db.add(person)
    db.flush()
    return person


def ids(day):
    return {person["id"] for person in day["freeWorkers"]}


def test_exactly_eight_calendar_days_including_today_across_year_boundary(db):
    person = worker(db)
    days = DashboardService(db)._staffing_days([], date(2026, 12, 28))
    assert [day["date"] for day in days] == [(date(2026, 12, 28) + timedelta(days=i)).isoformat() for i in range(8)]
    assert ids(days[0]) == {person.id}
    assert days[4]["nonWorkdayLabel"] == "Feiertag"
    assert days[5]["nonWorkdayLabel"] == "Wochenende"
    assert all(not days[i]["freeWorkers"] for i in [4, 5, 6])
    assert ids(days[7]) == {person.id}


@pytest.mark.parametrize("absence_type", list(AbsenceType))
def test_every_active_absence_blocks_even_without_matrix_rows_or_recent_assignment(db, absence_type):
    person = worker(db)
    db.add(Absence(person_id=person.id, absence_type=absence_type,
                   start_date=date(2026, 9, 28), end_date=date(2026, 9, 29)))
    db.flush()
    days = DashboardService(db)._staffing_days([], date(2026, 9, 28))
    assert not ids(days[0]) and not ids(days[1])
    assert ids(days[2]) == {person.id}


def test_cancelled_absence_does_not_block_and_assignments_on_hidden_sites_do(db):
    person = worker(db)
    site = Site(name="Closed", status=SiteStatus.COMPLETED)
    db.add(site)
    db.flush()
    db.add_all([
        Absence(person_id=person.id, absence_type=AbsenceType.VACATION,
                status=AbsenceStatus.CANCELLED, start_date=date(2026, 9, 28), end_date=date(2026, 10, 5)),
        Assignment(person_id=person.id, site_id=site.id, start_date=date(2026, 9, 29), end_date=date(2026, 10, 1)),
    ])
    db.flush()
    days = DashboardService(db)._staffing_days([], date(2026, 9, 28))
    assert ids(days[0]) == {person.id}
    assert all(not ids(days[i]) for i in [1, 2, 3])
    assert ids(days[4]) == {person.id}


def test_only_active_installers_including_external_are_available(db):
    internal = worker(db, "Internal")
    external = worker(db, "External", person_type=PersonType.EXTERNAL)
    temp = worker(db, "Temp", person_type=PersonType.EXTERNAL_TEMP)
    worker(db, "Inactive", is_active=False)
    worker(db, "Paused", employment_status="paused")
    worker(db, "Departed", employment_status="departed")
    worker(db, "Deleted", deleted_at=datetime.now(timezone.utc))
    for role in [UserRole.OFFICE, UserRole.ADMIN, UserRole.PROJECT_MANAGER]:
        person = worker(db, role.value)
        db.add(User(person_id=person.id, username=role.value, display_name=role.value, password_hash="x", role=role))
    manager = worker(db, "Manager without account")
    db.add(Site(name="Legacy", project_manager_person_id=manager.id))
    db.flush()
    day = DashboardService(db)._staffing_days([], date(2026, 9, 28))[0]
    assert ids(day) == {internal.id, external.id, temp.id}
    assert {p["id"] for p in day["freeWorkers"] if p["isExternal"]} == {external.id, temp.id}


def test_overview_returns_only_orange_unstaffed_needs_and_all_free_people(db):
    people = [worker(db, f"Installer {i:02}") for i in range(12)]
    site = Site(name="Needs people", site_number="8001")
    db.add(site)
    db.flush()
    start = date(2026, 9, 28)
    for i, mark in enumerate([MatrixCellMark.ORANGE, MatrixCellMark.RED, MatrixCellMark.BLUE, MatrixCellMark.ORANGE]):
        db.add(PlanningCellMark(site_id=site.id, mark_date=start + timedelta(days=i), mark=mark))
    db.add(Assignment(person_id=people[0].id, site_id=site.id, start_date=start + timedelta(days=3), end_date=start + timedelta(days=3)))
    db.flush()
    overview = DashboardService(db).get_overview(
        history_start=start - timedelta(days=35), today=start, tomorrow=start + timedelta(days=1),
        week_end=date(2026, 10, 4), next_week_start=date(2026, 10, 5), next_week_end=date(2026, 10, 11),
    )
    days = overview["staffingDays"]
    assert len(days) == 8
    assert [need["siteName"] for need in days[0]["needs"]] == ["Needs people"]
    assert all(not day["needs"] for day in days[1:])
    assert len(days[0]["freeWorkers"]) == 12  # Presentation, not the API, limits the preview.
    assert len(days[3]["freeWorkers"]) == 11
    assert days[-1]["date"] == "2026-10-05"
