from datetime import date

import pytest
from pydantic import ValidationError
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.models import Base
from app.models.enums import MatrixCellMark, UserRole
from app.models.planning_cell_mark import PlanningCellMark
from app.models.site import Site
from app.models.user import User
from app.models.assignment import Assignment
from app.models.person import Person
from app.models.audit_log import AuditLog
from fastapi import HTTPException
from app.schemas.matrix import MatrixCellMarkPatch
from app.services.matrix_mutation_service import MatrixMutationService
from app.services.matrix_service import MatrixService


@pytest.mark.parametrize('mark', ['red', 'blue', 'invalid'])
def test_retired_mark_colors_are_rejected(mark):
    with pytest.raises(ValidationError):
        MatrixCellMarkPatch(site_id=1, date=date(2026, 9, 28), mark=mark)


def test_legacy_colors_are_hidden_preserved_and_can_be_replaced_then_removed():
    engine = create_engine('sqlite+pysqlite:///:memory:')
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        user = User(username='planner', display_name='Planner', password_hash='x',
                    role=UserRole.ADMIN, is_active=True)
        site = Site(site_number='9999', name='Testbaustelle', status='active')
        db.add_all([user, site])
        db.flush()
        for day, mark in [(28, MatrixCellMark.RED), (29, MatrixCellMark.BLUE), (30, MatrixCellMark.ORANGE)]:
            db.add(PlanningCellMark(site_id=site.id, mark_date=date(2026, 9, day), mark=mark))
        db.commit()
        cells = MatrixService(db).get_site_cells(site_id=site.id, start=date(2026, 9, 28), end=date(2026, 9, 30))
        assert [cell.mark for cell in cells] == [None, None, MatrixCellMark.ORANGE]
        assert len(list(db.scalars(select(PlanningCellMark)))) == 3

        service = MatrixMutationService(db)
        for day in [28, 29, 30, 31]:
            target = date(2026, 10, 1) if day == 31 else date(2026, 9, day)
            for mark in ['orange', None, 'orange', None]:
                payload = MatrixCellMarkPatch(site_id=site.id, date=target, mark=mark)
                result = service.patch_cell_mark(payload, user.id)
                assert result['updated_cells'][0].mark == mark
                stored = db.scalar(select(PlanningCellMark).where(PlanningCellMark.mark_date == target))
                assert (stored.mark if stored else None) == mark
    engine.dispose()


@pytest.fixture
def marking_db():
    engine = create_engine('sqlite+pysqlite:///:memory:')
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        user = User(username='planner', display_name='Planner', password_hash='x',
                    role=UserRole.ADMIN, is_active=True)
        site = Site(site_number='9999', name='Testbaustelle', status='active')
        other = Site(site_number='9998', name='Andere Baustelle', status='active')
        person = Person(first_name='Test', last_name='Monteur', display_name='Test Monteur', short_code='TM')
        db.add_all([user, site, other, person])
        db.flush()
        assignment = Assignment(site_id=site.id, person_id=person.id,
                                start_date=date(2026, 10, 1), end_date=date(2026, 10, 7), note='Unverändert')
        db.add(assignment)
        for target, day in [(site, 1), (site, 3), (site, 7), (other, 3)]:
            db.add(PlanningCellMark(site_id=target.id, mark_date=date(2026, 10, day), mark=MatrixCellMark.ORANGE))
        db.commit()
        yield db, user, site, other, assignment
    engine.dispose()


def test_range_marking_sets_and_removes_all_days_including_weekend_without_changing_assignments(marking_db):
    db, user, site, other, assignment = marking_db
    service = MatrixMutationService(db)
    for mark in ['orange', 'orange', None, None]:
        result = service.patch_cell_mark(MatrixCellMarkPatch(
            site_id=site.id, date=date(2026, 10, 2), end_date=date(2026, 10, 6), mark=mark,
        ), user.id)
        assert [cell.date for cell in result['updated_cells']] == [date(2026, 10, d) for d in range(2, 7)]
        assert all(cell.mark == mark for cell in result['updated_cells'])
        assert all(cell.assignments[0].id == assignment.id for cell in result['updated_cells'])
        db.refresh(assignment)
        assert (assignment.start_date, assignment.end_date, assignment.note) == (date(2026, 10, 1), date(2026, 10, 7), 'Unverändert')
    remaining = {(item.site_id, item.mark_date) for item in db.scalars(select(PlanningCellMark))}
    assert remaining == {(site.id, date(2026, 10, 1)), (site.id, date(2026, 10, 7)), (other.id, date(2026, 10, 3))}
    assert len(list(db.scalars(select(AuditLog)))) == 20


def test_invalid_mark_range_does_not_change_data(marking_db):
    db, user, site, _, _ = marking_db
    for site_id, end in [(site.id, date(2026, 9, 30)), (99999, date(2026, 10, 5))]:
        with pytest.raises(HTTPException) as error:
            MatrixMutationService(db).patch_cell_mark(MatrixCellMarkPatch(
                site_id=site_id, date=date(2026, 10, 1), end_date=end, mark='orange',
            ), user.id)
        assert error.value.status_code == 400
    assert len(list(db.scalars(select(PlanningCellMark)))) == 4
    assert not list(db.scalars(select(AuditLog)))


def test_range_failure_rolls_back_the_entire_selection(marking_db, monkeypatch):
    db, user, site, _, _ = marking_db
    service = MatrixMutationService(db)
    original = service.audit.record
    calls = 0

    def fail_mid_range(**kwargs):
        nonlocal calls
        calls += 1
        if calls == 3:
            raise RuntimeError('simulated storage failure')
        original(**kwargs)

    monkeypatch.setattr(service.audit, 'record', fail_mid_range)
    before = {(m.site_id, m.mark_date) for m in db.scalars(select(PlanningCellMark))}
    with pytest.raises(RuntimeError):
        service.patch_cell_mark(MatrixCellMarkPatch(
            site_id=site.id, date=date(2026, 10, 1), end_date=date(2026, 10, 7), mark=None,
        ), user.id)
    db.rollback()
    assert {(m.site_id, m.mark_date) for m in db.scalars(select(PlanningCellMark))} == before
    assert not list(db.scalars(select(AuditLog)))
