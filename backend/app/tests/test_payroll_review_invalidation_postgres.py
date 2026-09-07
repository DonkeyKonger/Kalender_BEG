from datetime import date, datetime, time, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.models.payroll_month import PayrollMonthPersonApproval, PAYROLL_PERSON_MONTH_APPROVED
from app.models.person_hours_account import PersonHoursAccountEntry
from app.models.time_entry_weekly_review import TimeEntryWeeklyReview
from app.models.work_time_entry import WorkTimeEntry
from app.schemas.time_entry import TimeEntryCreate
from app.services.time_entry_service import TimeEntryService
from app.tests import test_payroll_month_postgres as postgres_tests

pg_session = postgres_tests.pg_session

pytestmark = pytest.mark.skipif(not postgres_tests.POSTGRES_URL, reason='requires isolated migrated PostgreSQL')


def reviewed_boundary_case(db):
    admin, worker = postgres_tests._payroll_users(db)
    stamp = datetime.now(timezone.utc)
    august_entry = WorkTimeEntry(
        person_id=worker.id, work_date=date(2026, 8, 31), start_time=time(8), end_time=time(16),
        work_minutes=480, break_minutes=0, payroll_reviewed_at=stamp,
        payroll_reviewed_by_user_id=admin.id,
    )
    review = TimeEntryWeeklyReview(
        person_id=worker.id, iso_year=2026, iso_week=36, status='reviewed',
        reviewed_by_user_id=admin.id, reviewed_at=stamp, daily_ledger_reference_id='retained-history',
    )
    history = PersonHoursAccountEntry(
        person_id=worker.id, entry_type='weekly_balance', minutes_delta=240,
        balance_after_minutes=240, ledger_system='legacy', is_active=True,
        note='Historical weekly booking', iso_year=2026, iso_week=36,
    )
    db.add_all([august_entry, review, history])
    db.flush()
    db.add(PayrollMonthPersonApproval(
        person_id=worker.id, year=2026, month=8, status=PAYROLL_PERSON_MONTH_APPROVED,
        approval_version=1, approved_at=stamp, approved_by_user_id=admin.id,
        blocker_snapshot_json=[],
    ))
    db.flush()
    return admin, worker, august_entry, review, history


def test_postgres_new_open_day_invalidates_week_without_touching_locked_day_or_ledger(pg_session):
    admin, worker, august, review, history = reviewed_boundary_case(pg_session)
    original_stamp = august.payroll_reviewed_at
    created = TimeEntryService(pg_session).create_entry(TimeEntryCreate(
        person_id=worker.id, work_date=date(2026, 9, 1), start_time=time(8), end_time=time(16),
        work_minutes=480, break_minutes=0, source='manual',
    ), current_user=admin)
    pg_session.refresh(review)
    pg_session.refresh(august)
    assert created.work_date == date(2026, 9, 1)
    assert review.status == 'reset'
    assert review.daily_ledger_reference_id == 'retained-history'
    assert august.payroll_reviewed_at == original_stamp
    assert history.minutes_delta == 240 and history.is_active
    assert list(pg_session.scalars(select(PersonHoursAccountEntry).where(
        PersonHoursAccountEntry.person_id == worker.id,
    ))) == [history]


def test_postgres_rejected_locked_day_mutation_does_not_invalidate_approval(pg_session):
    admin, worker, august, review, history = reviewed_boundary_case(pg_session)
    with pytest.raises(HTTPException) as caught:
        TimeEntryService(pg_session).create_entry(TimeEntryCreate(
            person_id=worker.id, work_date=date(2026, 8, 31), start_time=time(8), end_time=time(16),
            work_minutes=480, break_minutes=0, source='manual',
        ), current_user=admin)
    assert caught.value.status_code == 409
    pg_session.refresh(review)
    assert review.status == 'reviewed'
    assert august.payroll_reviewed_at is not None
    assert history.is_active
