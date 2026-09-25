from datetime import date

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.models import Base
from app.models.assignment import Assignment
from app.models.enums import AssignmentType, PersonType, UserRole
from app.models.person import Person
from app.models.site import Site
from app.models.user import User
from app.schemas.matrix import MatrixCellPatch, MatrixEntryInput, MatrixRangePatch
from app.services.matrix_mutation_service import MatrixMutationService
from app.services.matrix_service import MatrixService
from app.services.push_notification_service import PushNotificationService


@pytest.fixture
def planning(monkeypatch):
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        user = User(username="planner", display_name="Planner", password_hash="x",
                    role=UserRole.ADMIN, is_active=True)
        site = Site(site_number="9999", name="Testbaustelle", status="active")
        people = [Person(first_name="Test", last_name=str(i), display_name=f"Test {i}",
                         short_code=f"T{i}", person_type=kind)
                  for i, kind in enumerate([PersonType.INTERNAL, PersonType.EXTERNAL], 1)]
        db.add_all([user, site, *people])
        db.commit()
        notified = []
        monkeypatch.setattr(PushNotificationService, "record_plan_change_for_person",
                            lambda self, person_id: notified.append(person_id))
        yield db, MatrixMutationService(db), site, people, user, notified
    engine.dispose()


def entries(*people):
    return [MatrixEntryInput(person_id=person.id) for person in people]


def add_week(db, site, person, user):
    assignment = Assignment(site_id=site.id, person_id=person.id,
                            start_date=date(2026, 9, 21), end_date=date(2026, 9, 25),
                            assignment_type=AssignmentType.SUPPORT, note="Unverändert behalten",
                            created_by_user_id=user.id, updated_by_user_id=user.id)
    db.add(assignment)
    db.commit()
    return assignment


@pytest.mark.parametrize("day", [21, 23, 25])
def test_day_colleague_does_not_split_or_recreate_existing_week(planning, day):
    db, service, site, people, user, notified = planning
    weekly = add_week(db, site, people[0], user)
    original_id, original_updated_at = weekly.id, weekly.updated_at
    result = service.patch_cell(MatrixCellPatch(site_id=site.id, date=date(2026, 9, day),
                                               entries=entries(*people)), user.id)
    retained = db.get(Assignment, original_id)
    assert retained is not None
    assert (retained.start_date, retained.end_date) == (date(2026, 9, 21), date(2026, 9, 25))
    assert retained.updated_at == original_updated_at
    assert retained.assignment_type == AssignmentType.SUPPORT
    assert retained.note == "Unverändert behalten"
    assert notified == [people[1].id]
    assert len(list(db.scalars(select(Assignment)))) == 2
    assert original_id in [a.id for a in result["updated_cells"][0].assignments]
    cells = MatrixService(db).get_site_cells(site_id=site.id, start=date(2026, 9, 21),
                                           end=date(2026, 9, 25))
    assert [[a.id for a in c.assignments if a.person.id == people[0].id] for c in cells] == [
        [original_id]] * 5
    service.patch_cell(MatrixCellPatch(site_id=site.id, date=date(2026, 9, day),
                                      entries=entries(people[0])), user.id)
    assert list(db.scalars(select(Assignment.id))) == [original_id]


def test_range_addition_and_repeat_keep_existing_week_and_only_fill_missing_dates(planning):
    db, service, site, people, user, notified = planning
    weekly = add_week(db, site, people[0], user)
    original_id = weekly.id
    payload = MatrixRangePatch(site_id=site.id, start_date=date(2026, 9, 20),
                              end_date=date(2026, 9, 26), entries=entries(*people))
    service.patch_range(payload, user.id)
    plans = list(db.scalars(select(Assignment).order_by(Assignment.start_date)))
    first_ranges = [(a.start_date.day, a.end_date.day) for a in plans
                    if a.person_id == people[0].id]
    assert first_ranges == [(20, 20), (21, 25), (26, 26)]
    assert db.get(Assignment, original_id).note == "Unverändert behalten"
    ids = {a.id for a in plans}
    notified.clear()
    service.patch_range(payload, user.id)
    assert set(db.scalars(select(Assignment.id))) == ids
    assert notified == []


def test_explicit_day_removal_still_splits_only_the_removed_person_and_refreshes_ids(planning):
    db, service, site, people, user, _ = planning
    first = add_week(db, site, people[0], user)
    second = add_week(db, site, people[1], user)
    first_id, second_id = first.id, second.id
    result = service.patch_cell(MatrixCellPatch(site_id=site.id, date=date(2026, 9, 23),
                                               entries=entries(people[1])), user.id)
    assert db.get(Assignment, first_id) is None
    assert db.get(Assignment, second_id).start_date == date(2026, 9, 21)
    assert len(result["updated_cells"]) == 5
    assert all(second_id in [a.id for a in cell.assignments] for cell in result["updated_cells"])
    assert all(first_id not in [a.id for a in cell.assignments] for cell in result["updated_cells"])
    assert [a.person.id for a in result["updated_cells"][2].assignments] == [people[1].id]


def test_rejected_change_does_not_modify_existing_week(planning):
    db, service, site, people, user, notified = planning
    weekly = add_week(db, site, people[0], user)
    original_id = weekly.id
    people[1].is_active = False
    db.commit()
    with pytest.raises(HTTPException) as error:
        service.patch_cell(MatrixCellPatch(site_id=site.id, date=date(2026, 9, 23),
                                          entries=entries(*people)), user.id)
    assert error.value.status_code == 409
    assert list(db.scalars(select(Assignment.id))) == [original_id]
    assert notified == []


@pytest.mark.parametrize("short_day", [21, 23, 25])
@pytest.mark.parametrize("send_baseline", [False, True])
def test_five_one_five_days_preserve_each_person_when_adding_a_week(planning, short_day, send_baseline):
    db, service, site, people, user, notified = planning
    weekly = add_week(db, site, people[0], user)
    one_day = Assignment(site_id=site.id, person_id=people[1].id,
                         start_date=date(2026, 9, short_day), end_date=date(2026, 9, short_day),
                         note="Nur dieser eine Tag", assignment_type=AssignmentType.SUPPORT)
    third = Person(first_name="Dritter", last_name="Monteur", display_name="Dritter Monteur",
                   short_code="DM", person_type=PersonType.INTERNAL)
    db.add_all([one_day, third])
    db.commit()
    retained = {a.id: (a.start_date, a.end_date, a.updated_at, a.note, a.assignment_type)
                for a in (weekly, one_day)}
    baseline = [people[0], *([people[1]] if short_day == 21 else [])]
    payload = MatrixRangePatch(site_id=site.id, start_date=date(2026, 9, 21), end_date=date(2026, 9, 25),
                               entries=entries(*baseline, third),
                               **({"initial_person_ids": [p.id for p in baseline]} if send_baseline else {}))
    result = service.patch_range(payload, user.id)
    db.expire_all()
    plans = list(db.scalars(select(Assignment)))
    assert len(plans) == 3
    for plan in plans:
        if plan.id in retained:
            assert (plan.start_date, plan.end_date, plan.updated_at, plan.note, plan.assignment_type) == retained[plan.id]
    assert {p.id: sum(any(a.person.id == p.id for a in cell.assignments) for cell in result["updated_cells"])
            for p in [*people, third]} == {people[0].id: 5, people[1].id: 1, third.id: 5}
    assert notified == [third.id]
    notified.clear()
    service.patch_range(payload, user.id)
    assert {a.id for a in plans} == set(db.scalars(select(Assignment.id)))
    assert notified == []


def test_range_without_changes_never_expands_short_assignment(planning):
    db, service, site, people, user, notified = planning
    weekly = add_week(db, site, people[0], user)
    short = Assignment(site_id=site.id, person_id=people[1].id,
                       start_date=date(2026, 9, 21), end_date=date(2026, 9, 21))
    db.add(short)
    db.commit()
    service.patch_range(MatrixRangePatch(site_id=site.id, start_date=date(2026, 9, 21), end_date=date(2026, 9, 25),
                                        entries=entries(*people), initial_person_ids=[p.id for p in people]), user.id)
    assert set(db.scalars(select(Assignment.id))) == {weekly.id, short.id}
    assert short.end_date == date(2026, 9, 21)
    assert notified == []


def test_range_removal_only_removes_explicit_baseline_person(planning):
    db, service, site, people, user, notified = planning
    first = add_week(db, site, people[0], user)
    first_id = first.id
    later = Assignment(site_id=site.id, person_id=people[1].id,
                       start_date=date(2026, 9, 23), end_date=date(2026, 9, 23))
    db.add(later)
    db.commit()
    service.patch_range(MatrixRangePatch(site_id=site.id, start_date=date(2026, 9, 21), end_date=date(2026, 9, 25),
                                        entries=[], initial_person_ids=[people[0].id]), user.id)
    assert db.get(Assignment, first_id) is None
    assert list(db.scalars(select(Assignment.id))) == [later.id]
    assert notified == [people[0].id]
