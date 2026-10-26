from datetime import date

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.models.absence import Absence
from app.models.enums import AbsenceStatus, AbsenceType, PersonType, UserRole
from app.models.payroll_month import PayrollMonthPeriod, PayrollMonthPersonApproval
from app.models.person import Person
from app.models.user import User
from app.schemas.absence import AbsenceCreate, AbsenceUpdate
from app.services.absence_service import ABSENCE_PAYROLL_LOCK_MESSAGE, AbsenceService, absence_snapshot
from app.tests.test_absence_service import db_session


@pytest.fixture
def case():
    db = db_session()
    people = [Person(first_name=name, last_name="Test", display_name=name, short_code=name, person_type=PersonType.INTERNAL) for name in ("A", "B")]
    user = User(username="locks", display_name="Büro", password_hash="x", role=UserRole.OFFICE)
    db.add_all([*people, user])
    db.flush()
    absence = Absence(person_id=people[0].id, absence_type=AbsenceType.VACATION,
                      start_date=date(2026, 8, 31), end_date=date(2026, 9, 2), status=AbsenceStatus.ACTIVE)
    db.add(absence)
    db.commit()
    yield db, AbsenceService(db), people, user, absence
    db.close()


@pytest.mark.parametrize("scope", ["person", "global"])
@pytest.mark.parametrize("action", ["create", "update", "cancel", "delete", "move_date", "move_person"])
def test_closed_month_rejects_every_absence_change_with_requested_notice(case, scope, action):
    db, service, people, user, absence = case
    lock = (PayrollMonthPersonApproval(year=2026, month=8, person_id=people[0].id, status="APPROVED")
            if scope == "person" else PayrollMonthPeriod(year=2026, month=8, status="LOCKED"))
    db.add(lock)
    db.commit()
    before = absence_snapshot(absence)
    with pytest.raises(HTTPException) as caught:
        if action == "create":
            service.create_absence(AbsenceCreate(person_id=people[0].id, absence_type=AbsenceType.SICK,
                start_date=date(2026, 7, 31), end_date=date(2026, 9, 1)), user.id)
        elif action == "delete":
            service.delete_absence(absence.id, user.id)
        else:
            fields = {"update": {"note": "changed"}, "cancel": {"status": AbsenceStatus.CANCELLED},
                      "move_date": {"start_date": date(2026, 9, 1)}, "move_person": {"person_id": people[1].id}}[action]
            service.update_absence(absence.id, AbsenceUpdate(**fields), user.id)
    assert caught.value.status_code == 409
    assert caught.value.detail["message"] == ABSENCE_PAYROLL_LOCK_MESSAGE
    assert caught.value.detail["code"] == ("payroll_person_month_locked" if scope == "person" else "payroll_month_locked")
    assert absence_snapshot(absence) == before
    assert not db.new and not db.dirty and not db.deleted
    assert len(list(db.scalars(select(Absence)))) == 1


def test_moving_an_open_absence_into_an_approved_person_month_is_blocked(case):
    db, service, people, user, absence = case
    db.add(PayrollMonthPersonApproval(year=2026, month=9, person_id=people[1].id, status="APPROVED"))
    db.commit()
    with pytest.raises(HTTPException) as caught:
        service.update_absence(absence.id, AbsenceUpdate(person_id=people[1].id), user.id)
    assert caught.value.detail["message"] == ABSENCE_PAYROLL_LOCK_MESSAGE
    assert absence.person_id == people[0].id


def test_other_people_and_months_remain_editable_and_reopening_unlocks(case):
    db, service, people, user, absence = case
    lock = PayrollMonthPersonApproval(year=2026, month=8, person_id=people[0].id, status="APPROVED")
    db.add(lock)
    db.commit()
    for person_id, day in [(people[1].id, date(2026, 8, 5)), (people[0].id, date(2026, 9, 5))]:
        created = service.create_absence(AbsenceCreate(person_id=person_id, absence_type=AbsenceType.SICK,
            start_date=day, end_date=day), user.id)
        service.update_absence(created.id, AbsenceUpdate(note="allowed"), user.id)
        service.delete_absence(created.id, user.id)
    lock.status = "OPEN"
    db.commit()
    service.update_absence(absence.id, AbsenceUpdate(note="reopened"), user.id)
    assert absence.note == "reopened"
