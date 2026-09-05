"""Deadline writes must not turn a payroll review read into a locked-row error."""

from datetime import date
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine, event, select, text
from sqlalchemy.orm import Session

from app.models import Base
from app.api.routes.time_entries import get_time_entry_review_week
from app.models.enums import PersonType, UserRole
from app.models.payroll_month import PayrollMonthPeriod, PayrollMonthPersonApproval
from app.models.person import Person
from app.models.work_time_entry import WorkTimeEntry
from app.services.time_entry_service import TimeEntryService
from app.services import time_entry_service


@pytest.fixture
def db():
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine, expire_on_commit=False) as session:
        session.add_all([
            Person(id=person_id, first_name="Test", last_name=str(person_id),
                   display_name=f"Test {person_id}", short_code=f"T{person_id}",
                   person_type=PersonType.INTERNAL)
            for person_id in (1, 2)
        ])
        session.commit()
        # SQLite analogue of migration 0111's PostgreSQL dated-row guard.
        # A forbidden write fails here instead of silently succeeding in SQLite.
        session.execute(text("""
            CREATE TRIGGER test_approved_person_guard BEFORE UPDATE ON work_time_entries
            WHEN EXISTS (
                SELECT 1 FROM payroll_month_person_approvals a
                WHERE a.person_id = OLD.person_id AND a.status = 'APPROVED'
                  AND a.year = CAST(strftime('%Y', OLD.work_date) AS INTEGER)
                  AND a.month = CAST(strftime('%m', OLD.work_date) AS INTEGER)
            )
            BEGIN SELECT RAISE(ABORT, 'payroll_person_month_locked'); END
        """))
        session.commit()
        yield session
    engine.dispose()


def entry(db, person_id=1, work_date=date(2026, 8, 31), **values):
    item = WorkTimeEntry(person_id=person_id, work_date=work_date, work_minutes=480, **values)
    db.add(item)
    db.commit()
    return item


def close(db, entries, today=date(2026, 9, 5)):
    return TimeEntryService(db).auto_close_deadline_reviews(
        entries, {item.id: None for item in entries}, today=today,
    )


def test_review_read_skips_approved_person_but_closes_other_person(db):
    approved = entry(db)
    open_person = entry(db, person_id=2)
    current_month = entry(db, person_id=2, work_date=date(2026, 9, 1))
    db.add(PayrollMonthPersonApproval(year=2026, month=8, person_id=1, status="APPROVED"))
    db.commit()

    assert close(db, [approved, open_person, current_month]) is True
    assert approved.time_review_status == "open"
    assert approved.reviewed_at is None
    assert open_person.time_review_status == "auto_closed_by_deadline"
    assert current_month.time_review_status == "open"
    assert len(list(db.scalars(select(WorkTimeEntry)))) == 3


def test_only_approved_entries_do_not_write_or_commit(db):
    approved = entry(db)
    db.add(PayrollMonthPersonApproval(year=2026, month=8, person_id=1, status="APPROVED"))
    db.commit()
    commits = []
    event.listen(db, "after_commit", lambda session: commits.append(True))

    assert close(db, [approved]) is False
    assert approved.time_review_status == "open"
    assert commits == []


def test_review_week_route_returns_details_across_month_boundary(db, monkeypatch):
    class DeadlineDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 9, 5)

    monkeypatch.setattr(time_entry_service, "date", DeadlineDate)
    approved = entry(db)
    open_person = entry(db, person_id=2)
    current_month = entry(db, person_id=2, work_date=date(2026, 9, 1))
    db.add(PayrollMonthPersonApproval(year=2026, month=8, person_id=1, status="APPROVED"))
    db.commit()

    # Exercise real list loading, GPS evaluation, deadline processing and response
    # serialization. Only the calendar is frozen; no production requests occur.
    result = get_time_entry_review_week(
        date_from=date(2026, 8, 31), date_to=date(2026, 9, 6),
        current_user=SimpleNamespace(role=UserRole.ADMIN, person_id=None), db=db,
    )
    assert {item.id for item in result.entries} == {approved.id, open_person.id, current_month.id}
    assert all(item.work_minutes == 480 for item in result.entries)
    assert approved.time_review_status == "open"
    assert open_person.time_review_status == "auto_closed_by_deadline"
    assert current_month.time_review_status == "open"


@pytest.mark.parametrize("lock_status,expected", [("LOCKED", False), ("OPEN", True)])
def test_global_month_lock_is_still_respected(db, lock_status, expected):
    item = entry(db)
    db.add(PayrollMonthPeriod(year=2026, month=8, status=lock_status))
    db.commit()
    assert close(db, [item]) is expected
    assert item.time_review_status == ("auto_closed_by_deadline" if expected else "open")


def test_reopened_person_can_auto_close_and_deadline_handles_year_boundary(db):
    item = entry(db, work_date=date(2026, 12, 31))
    db.add(PayrollMonthPersonApproval(year=2026, month=12, person_id=1, status="OPEN"))
    db.commit()
    assert close(db, [item], today=date(2027, 1, 4)) is False
    assert close(db, [item], today=date(2027, 1, 5)) is True


def test_deadline_lock_queries_scale_with_person_months_not_entries(db):
    entries = [entry(db) for _ in range(8)]
    statements = []
    def record(connection, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith("SELECT") and "payroll_month" in statement:
            statements.append(statement)
    event.listen(db.get_bind(), "before_cursor_execute", record)
    assert close(db, entries) is True
    assert len(statements) == 2  # one global lock check and one personal lock check


def test_terminal_reviews_need_no_lock_queries(db):
    item = entry(db, time_review_status="manually_approved")
    statements = []
    event.listen(db.get_bind(), "before_cursor_execute", lambda *args: statements.append(args[2]))
    assert close(db, [item]) is False
    assert statements == []
