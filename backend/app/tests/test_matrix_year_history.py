from datetime import date

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models import Base
from app.models.assignment import Assignment
from app.models.person import Person
from app.models.planning_cell_mark import PlanningCellMark
from app.models.site import Site
from app.services.matrix_service import MatrixService


@pytest.fixture
def history_db():
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        yield db
    engine.dispose()


def add_site(db, name, status="completed", start=None, end=None, manager=None, person_type="internal"):
    site = Site(name=name, status=status, project_manager_person_id=manager)
    db.add(site)
    db.flush()
    assignment = None
    if start:
        person = Person(first_name=name, last_name="Test", display_name=name, short_code=name[:12], person_type=person_type)
        db.add(person)
        db.flush()
        assignment = Assignment(site_id=site.id, person_id=person.id, start_date=date.fromisoformat(start),
                                end_date=date.fromisoformat(end or start), assignment_type="regular")
        db.add(assignment)
    db.commit()
    return site, assignment


def year_params(year=2026):
    return dict(start=date(year, 1, 1), end=date(year, 12, 31), year_view=True, include_weekends=True)


def test_year_history_includes_only_completed_sites_with_overlapping_assignments(history_db):
    cases = [
        ("Aktiv ohne Planung", "active", None, None, True),
        ("Pausiert", "paused", None, None, True),
        ("Geplant", "planned", None, None, True),
        ("Ohne Planung", "completed", None, None, False),
        ("Vorjahr", "completed", "2025-12-31", None, False),
        ("Folgejahr", "completed", "2027-01-01", None, False),
        ("Jahresanfang", "completed", "2026-01-01", None, True),
        ("Jahresende", "completed", "2026-12-31", None, True),
        ("Uebertrag", "completed", "2025-12-30", "2026-01-02", True),
        ("Ueberhang", "completed", "2026-12-30", "2027-01-02", True),
        ("Geloescht", "deleted", "2026-06-01", None, False),
    ]
    expected = set()
    for name, status, start, end, visible in cases:
        site, _ = add_site(history_db, name, status, start, end)
        if visible:
            expected.add(site.id)
    result = MatrixService(history_db).get_matrix(**year_params())
    assert {row.site.id for row in result.rows} == expected
    assert len(result.days) == 365
    assert any(row.site.status == "completed" and any(cell.assignments for cell in row.cells) for row in result.rows)
    assert not history_db.dirty and not history_db.deleted and not history_db.new


def test_history_respects_manager_filter_external_workers_and_standard_mode(history_db):
    manager = Person(first_name="Projekt", last_name="Leiter", display_name="PL", short_code="PL", person_type="internal")
    history_db.add(manager)
    history_db.commit()
    site, _ = add_site(history_db, "Extern", start="2026-06-01", manager=manager.id, person_type="external_temp")
    add_site(history_db, "Anderer PL", start="2026-06-01")
    service = MatrixService(history_db)
    year = service.get_matrix(**year_params(), project_manager_person_id=manager.id)
    assert [row.site.id for row in year.rows] == [site.id]
    assert any(pm.id == manager.id for pm in year.project_managers)
    assert service.get_matrix(start=date(2026, 6, 1), end=date(2026, 6, 30)).rows == []
    assert service.get_matrix(**year_params(2027)).rows == []


def test_history_version_tracks_first_and_last_assignment_and_completion(history_db):
    site, assignment = add_site(history_db, "Historie", "active", "2026-06-01")
    service = MatrixService(history_db)
    params = dict(start=date(2026, 1, 1), end=date(2026, 12, 31), year_view=True)
    before = service.get_version(**params).version
    site.status = "completed"
    history_db.commit()
    assert service.get_version(**params).version != before
    assert [row.site.id for row in service.get_matrix(**params).rows] == [site.id]
    before = service.get_version(**params).version
    history_db.delete(assignment)
    history_db.commit()
    assert service.get_version(**params).version != before
    assert service.get_matrix(**params).rows == []
    before = service.get_version(**params).version
    person = history_db.query(Person).filter(Person.display_name == "Historie").one()
    history_db.add(Assignment(site_id=site.id, person_id=person.id, start_date=date(2026, 7, 1),
                              end_date=date(2026, 7, 1), assignment_type="regular"))
    history_db.commit()
    assert service.get_version(**params).version != before
    assert [row.site.id for row in service.get_matrix(**params).rows] == [site.id]


def test_marking_alone_is_not_historical_staffing_and_leap_day_counts(history_db):
    empty, _ = add_site(history_db, "Nur Bedarf")
    planned, _ = add_site(history_db, "Schalttag", start="2024-02-29", person_type="external")
    history_db.add(PlanningCellMark(site_id=empty.id, mark_date=date(2024, 2, 29), mark="orange"))
    history_db.commit()
    result = MatrixService(history_db).get_matrix(**year_params(2024))
    assert len(result.days) == 366
    assert [row.site.id for row in result.rows] == [planned.id]
