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
from app.services.dashboard_service import DashboardService, staffing_dates


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


def test_exactly_eight_weekdays_including_today_across_year_boundary(db):
    person = worker(db)
    days = DashboardService(db)._staffing_days([], date(2026, 12, 28))
    assert [day["date"] for day in days] == ["2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31", "2027-01-01", "2027-01-04", "2027-01-05", "2027-01-06"]
    assert ids(days[0]) == {person.id}
    assert days[4]["nonWorkdayLabel"] == "Feiertag"
    assert not days[4]["freeWorkers"]
    assert ids(days[5]) == {person.id}
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
    for person in [external, temp]:
        db.add(Absence(person_id=person.id, absence_type=AbsenceType.OTHER,
                       start_date=date(2026, 9, 25), end_date=date(2026, 9, 25)))
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
    assert days[0]["needs"][0]["siteId"] == site.id
    assert days[0]["needs"][0]["projectManagerPersonId"] == site.project_manager_person_id
    assert all(not day["needs"] for day in days[1:])
    assert len(days[0]["freeWorkers"]) == 12  # Presentation, not the API, limits the preview.
    assert len(days[3]["freeWorkers"]) == 11
    assert days[-1]["date"] == "2026-10-07"


@pytest.mark.parametrize("offset", range(7))
def test_weekday_forecast_skips_weekends_for_every_start_day(offset):
    today = date(2026, 9, 28) + timedelta(days=offset)
    days = staffing_dates(today)
    assert len(days) == 8
    assert all(day.weekday() < 5 for day in days)
    assert days[0] == today + timedelta(days=max(0, 7 - today.weekday()) if today.weekday() >= 5 else 0)
    assert all((right - left).days == (3 if left.weekday() == 4 else 1) for left, right in zip(days, days[1:]))


def test_weekend_start_loads_marks_and_assignments_beyond_next_week_end(db):
    person = worker(db)
    site = Site(name="Future need", site_number="9000")
    db.add(site)
    db.flush()
    last = date(2026, 10, 14)
    db.add(PlanningCellMark(site_id=site.id, mark_date=last, mark=MatrixCellMark.ORANGE))
    db.add(Assignment(person_id=person.id, site_id=site.id, start_date=last-timedelta(days=1), end_date=last-timedelta(days=1)))
    db.flush()
    days = DashboardService(db).get_overview(history_start=date(2026, 9, 1), today=date(2026, 10, 3),
        tomorrow=date(2026, 10, 4), week_end=date(2026, 10, 4), next_week_start=date(2026, 10, 5),
        next_week_end=date(2026, 10, 11))["staffingDays"]
    assert days[0]["date"] == "2026-10-05"
    assert days[-1]["date"] == last.isoformat()
    assert days[-1]["needs"][0]["siteName"] == "Future need"
    assert not ids(days[-2])
    assert ids(days[-1]) == {person.id}


@pytest.mark.parametrize("person_type", [PersonType.EXTERNAL, PersonType.EXTERNAL_TEMP])
@pytest.mark.parametrize("activity", ["assignment", *list(AbsenceType)])
@pytest.mark.parametrize("offset, expected", [(-7, False), (-6, True), (-1, True), (0, True), (1, False)])
def test_external_recent_activity_window_is_fixed_for_entire_forecast(db, person_type, activity, offset, expected):
    today = date(2026, 9, 28)
    person = worker(db, person_type=person_type)
    activity_date = today + timedelta(days=offset)
    if activity == "assignment":
        site = Site(name="Previous site", status=SiteStatus.COMPLETED)
        db.add(site)
        db.flush()
        db.add(Assignment(person_id=person.id, site_id=site.id,
                          start_date=activity_date, end_date=activity_date))
    else:
        db.add(Absence(person_id=person.id, absence_type=activity,
                       start_date=activity_date, end_date=activity_date))
    db.flush()
    days = DashboardService(db)._staffing_days([], today)
    # None of the activity dates overlaps the final day, and tomorrow-only
    # entries must not qualify external staff as recently present today.
    assert (person.id in ids(days[-1])) is expected
    assert (person.id in ids(days[0])) is (expected and offset != 0)


def test_external_without_activity_or_with_cancelled_absence_is_not_available(db):
    internal = worker(db, "Internal without planning")
    worker(db, "External without planning", person_type=PersonType.EXTERNAL)
    cancelled = worker(db, "Cancelled only", person_type=PersonType.EXTERNAL_TEMP)
    db.add(Absence(person_id=cancelled.id, absence_type=AbsenceType.VACATION,
                   status=AbsenceStatus.CANCELLED, start_date=date(2026, 9, 22), end_date=date(2026, 9, 27)))
    db.flush()
    days = DashboardService(db)._staffing_days([], date(2026, 9, 28))
    assert all(ids(day) == ({internal.id} if day["isWorkday"] else set()) for day in days)
    assert cancelled.is_active is True  # Display eligibility never changes employee records.


def test_long_external_absence_overlapping_recent_window_qualifies_but_still_blocks_absent_days(db):
    person = worker(db, person_type=PersonType.EXTERNAL)
    db.add(Absence(person_id=person.id, absence_type=AbsenceType.SICK,
                   start_date=date(2026, 8, 1), end_date=date(2026, 9, 29)))
    db.flush()
    days = DashboardService(db)._staffing_days([], date(2026, 9, 28))
    assert not ids(days[0]) and not ids(days[1])
    assert ids(days[2]) == {person.id}


@pytest.mark.parametrize("internal_count", [0, 2, 6])
def test_internal_workers_precede_all_external_types_in_preview_and_full_list(db, internal_count):
    today = date(2026, 9, 28)
    internals = [worker(db, f"Z Internal {i}") for i in reversed(range(internal_count))]
    externals = [
        worker(db, "B External", person_type=PersonType.EXTERNAL),
        worker(db, "A Temporary", person_type=PersonType.EXTERNAL_TEMP),
    ]
    for person in externals:
        db.add(Absence(person_id=person.id, absence_type=AbsenceType.OTHER,
                       start_date=today-timedelta(days=1), end_date=today-timedelta(days=1)))
    site = Site(name="Assignment")
    db.add(site)
    db.flush()
    if internals:
        db.add(Assignment(person_id=internals[0].id, site_id=site.id, start_date=today, end_date=today))
    db.flush()
    days = DashboardService(db)._staffing_days([], today)
    for day in days:
        available_internals = sorted(
            [person for person in internals if day["date"] != today.isoformat() or person != internals[0]],
            key=lambda person: person.display_name,
        )
        expected = [person.id for person in available_internals] + [externals[1].id, externals[0].id]
        actual = [person["id"] for person in day["freeWorkers"]]
        assert actual == expected  # Same order supplies the popup and the first four bubbles.
        assert actual[:4] == expected[:4]
