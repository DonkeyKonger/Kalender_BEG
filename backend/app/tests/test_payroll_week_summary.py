from datetime import date, time, timedelta

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.models import Base
from app.models.absence import Absence
from app.models.enums import AbsenceStatus, AbsenceType, PersonType
from app.models.person import Person
from app.models.work_time_entry import WorkTimeEntry
from app.services.person_hours_account_service import OFFICE_ONLY_TIME_ENTRY_NOTE, PersonHoursAccountService


def db_session() -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    return Session(engine)


def add_person(db: Session) -> Person:
    person = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
        person_type=PersonType.INTERNAL,
    )
    db.add(person)
    db.flush()
    return person


def add_vacation(db: Session, person: Person, start: date, end: date) -> None:
    db.add(
        Absence(
            person=person,
            absence_type=AbsenceType.VACATION,
            start_date=start,
            end_date=end,
            status=AbsenceStatus.ACTIVE,
        )
    )


def payroll_summary(db: Session, person: Person, *, iso_year: int, iso_week: int):
    summaries = PersonHoursAccountService(db).payroll_week_summaries(
        iso_year=iso_year,
        iso_week=iso_week,
    )
    return next(summary for summary in summaries if summary.person_id == person.id)


def test_single_vacation_day_is_credited_in_day_and_week_totals():
    db = db_session()
    person = add_person(db)
    monday = date.fromisocalendar(2026, 31, 1)
    add_vacation(db, person, monday, monday)
    db.commit()

    summary = payroll_summary(db, person, iso_year=2026, iso_week=31)

    assert summary.work_minutes == 0
    assert summary.vacation_credit_minutes == 480
    assert summary.total_minutes == 480
    assert [(day.work_date, day.credit_minutes) for day in summary.vacation_days] == [(monday, 480)]
    assert list(db.scalars(select(WorkTimeEntry))) == []


def test_five_vacation_weekdays_are_credited_as_forty_hours():
    db = db_session()
    person = add_person(db)
    monday = date.fromisocalendar(2026, 31, 1)
    add_vacation(db, person, monday, monday + timedelta(days=4))
    db.commit()

    summary = payroll_summary(db, person, iso_year=2026, iso_week=31)

    assert summary.vacation_credit_minutes == 2400
    assert summary.total_minutes == 2400
    assert len(summary.vacation_days) == 5


def test_mixed_vacation_and_work_week_combines_server_values():
    db = db_session()
    person = add_person(db)
    monday = date.fromisocalendar(2026, 31, 1)
    add_vacation(db, person, monday, monday)
    db.add(
        WorkTimeEntry(
            person=person,
            work_date=monday + timedelta(days=1),
            work_minutes=360,
            break_minutes=0,
            travel_minutes=0,
        )
    )
    db.commit()

    summary = payroll_summary(db, person, iso_year=2026, iso_week=31)

    assert summary.work_minutes == 360
    assert summary.vacation_credit_minutes == 480
    assert summary.total_minutes == 840


def test_existing_office_manual_entry_uses_its_direct_time_in_week_total():
    db = db_session()
    person = add_person(db)
    monday = date.fromisocalendar(2026, 31, 1)
    db.add(
        WorkTimeEntry(
            person=person,
            work_date=monday,
            start_time=time(6, 0),
            end_time=time(12, 0),
            break_minutes=60,
            travel_minutes=0,
            work_minutes=300,
            note=OFFICE_ONLY_TIME_ENTRY_NOTE,
        )
    )
    db.commit()

    summary = payroll_summary(db, person, iso_year=2026, iso_week=31)

    assert summary.work_minutes == 300
    assert summary.vacation_credit_minutes == 0
    assert summary.total_minutes == 300


def test_vacation_weekend_does_not_receive_additional_credit():
    db = db_session()
    person = add_person(db)
    monday = date.fromisocalendar(2026, 31, 1)
    add_vacation(db, person, monday, monday + timedelta(days=6))
    db.commit()

    summary = payroll_summary(db, person, iso_year=2026, iso_week=31)

    assert summary.vacation_credit_minutes == 2400
    assert [day.work_date.weekday() for day in summary.vacation_days] == [0, 1, 2, 3, 4]


def test_overlapping_vacations_and_work_are_not_credited_twice():
    db = db_session()
    person = add_person(db)
    monday = date.fromisocalendar(2026, 31, 1)
    add_vacation(db, person, monday, monday)
    add_vacation(db, person, monday, monday)
    db.add(
        WorkTimeEntry(
            person=person,
            work_date=monday,
            work_minutes=300,
            break_minutes=0,
            travel_minutes=0,
        )
    )
    db.commit()

    summary = payroll_summary(db, person, iso_year=2026, iso_week=31)

    assert summary.work_minutes == 300
    assert summary.vacation_credit_minutes == 180
    assert summary.total_minutes == 480
    assert len(summary.vacation_days) == 1
