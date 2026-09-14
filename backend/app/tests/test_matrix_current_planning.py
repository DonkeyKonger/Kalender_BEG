from datetime import date

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models import Base
from app.models.assignment import Assignment
from app.models.person import Person
from app.models.site import Site
from app.services import matrix_service
from app.services.matrix_service import MatrixService, current_planning_range


@pytest.mark.parametrize("today,start,end", [
    ("2026-09-14", "2026-09-14", "2026-09-27"),
    ("2026-09-20", "2026-09-14", "2026-09-27"),
    ("2026-09-21", "2026-09-21", "2026-10-04"),
    ("2026-12-31", "2026-12-28", "2027-01-10"),
    ("2027-01-01", "2026-12-28", "2027-01-10"),
    ("2026-03-29", "2026-03-23", "2026-04-05"),
    ("2026-10-25", "2026-10-19", "2026-11-01"),
])
def test_current_planning_calendar_week_boundaries(today, start, end):
    assert current_planning_range(date.fromisoformat(today)) == (date.fromisoformat(start), date.fromisoformat(end))


@pytest.fixture
def planning_db():
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        yield db
    engine.dispose()


def add_plan(db, number, start, end, person_type="internal"):
    site = Site(site_number=str(number), name=f"Baustelle {number}", status="active")
    person = Person(first_name="Person", last_name=str(number), display_name=f"Person {number}", short_code=f"P{number}", person_type=person_type)
    db.add_all([site, person])
    db.flush()
    assignment = Assignment(site_id=site.id, person_id=person.id, start_date=date.fromisoformat(start), end_date=date.fromisoformat(end), assignment_type="regular")
    db.add(assignment)
    db.commit()
    return site, assignment


def test_current_planning_metadata_counts_people_and_overlap_without_filtering_or_mutating_matrix(planning_db, monkeypatch):
    monkeypatch.setattr(matrix_service, "current_planning_range", lambda: (date(2026,9,14),date(2026,9,27)))
    cases = [
        ("2026-09-01", "2026-09-13", "internal", False),
        ("2026-09-14", "2026-09-14", "internal", True),
        ("2026-09-20", "2026-09-20", "external", True),
        ("2026-09-27", "2026-09-27", "external_temp", True),
        ("2026-09-28", "2026-10-02", "internal", False),
        ("2026-09-01", "2026-10-31", "internal", True),
    ]
    expected = {}
    for number, (start, end, person_type, matches) in enumerate(cases, 1):
        site, _ = add_plan(planning_db, number, start, end, person_type)
        expected[site.id] = matches
    empty = Site(site_number="7", name="Ohne Planung", status="paused", info="Nur Information")
    planning_db.add(empty)
    planning_db.commit()
    expected[empty.id] = False
    result = MatrixService(planning_db).get_matrix(start=date(2026,9,1),end=date(2026,10,31),include_weekends=True)
    assert {r.site.id:r.has_current_planning for r in result.rows} == expected
    assert len(result.days) == 61
    assert all(len(r.cells) == 61 for r in result.rows)
    assert not planning_db.dirty and not planning_db.new and not planning_db.deleted


def test_year_boundary_plan_outside_visible_year_is_counted_and_version_tracks_changes(planning_db, monkeypatch):
    monkeypatch.setattr(matrix_service, "current_planning_range", lambda: (date(2026,12,28),date(2027,1,10)))
    site, assignment = add_plan(planning_db, 1, "2027-01-10", "2027-01-10", "external")
    service = MatrixService(planning_db)
    params = dict(start=date(2026,1,1),end=date(2026,12,31),year_view=True)
    result = service.get_matrix(**params, include_weekends=True)
    assert result.rows[0].has_current_planning
    assert len(result.days) == 365
    assert all(not c.assignments for c in result.rows[0].cells)
    before = service.get_version(**params).version
    planning_db.delete(assignment)
    planning_db.commit()
    assert service.get_version(**params).version != before
    assert not service.get_matrix(**params).rows[0].has_current_planning
    before_week_change = service.get_version(**params).version
    monkeypatch.setattr(matrix_service, "current_planning_range", lambda: (date(2027,1,4),date(2027,1,17)))
    assert service.get_version(**params).version != before_week_change
