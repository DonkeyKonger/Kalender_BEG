"""PostgreSQL-only integration checks for the payroll lock triggers.

Run against an isolated, fully migrated database with
``PAYROLL_POSTGRES_TEST_URL=postgresql+psycopg://... pytest ...``.
"""

from __future__ import annotations

from datetime import date, datetime, timezone
import os
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from app.models.enums import PersonType, UserRole
from app.models.payroll_daily_ledger import (
    PersonHoursOpeningBalance,
    PersonWeeklySchedule,
)
from app.models.payroll_month import (
    PAYROLL_MONTH_LOCKED,
    PAYROLL_MONTH_OPEN,
    PayrollMonthArtifact,
    PayrollMonthAudit,
    PayrollMonthPeriod,
    PayrollMonthPersonSnapshot,
    PayrollMonthSnapshot,
)
from app.models.person import Person
from app.models.user import User


POSTGRES_URL = os.getenv("PAYROLL_POSTGRES_TEST_URL")
pytestmark = pytest.mark.skipif(
    not POSTGRES_URL,
    reason="PAYROLL_POSTGRES_TEST_URL points to an isolated migrated PostgreSQL database",
)
MONTH_LOCK_BASE = 344_693_735_424


@pytest.fixture()
def pg_session():
    engine = create_engine(POSTGRES_URL)
    connection = engine.connect()
    transaction = connection.begin()
    session = Session(bind=connection)
    try:
        yield session
    finally:
        session.close()
        transaction.rollback()
        connection.close()
        engine.dispose()


def test_postgres_schedule_and_opening_balance_invariants(pg_session: Session):
    admin, worker = _payroll_users(pg_session)
    assert pg_session.scalar(text("SELECT payroll_month_advisory_key(2026, 8)")) == (
        MONTH_LOCK_BASE + 202_608
    )
    opening = PersonHoursOpeningBalance(
        person_id=worker.id,
        as_of_date=date(2026, 7, 31),
        balance_minutes=-90,
        is_confirmed=True,
        confirmed_by_user_id=admin.id,
        confirmed_at=datetime.now(timezone.utc),
    )
    schedule = PersonWeeklySchedule(
        person_id=worker.id,
        valid_from=date(2026, 8, 1),
        valid_until=None,
        monday_minutes=480,
        tuesday_minutes=480,
        wednesday_minutes=480,
        thursday_minutes=480,
        friday_minutes=480,
        saturday_minutes=0,
        sunday_minutes=0,
        weekly_total_minutes=2400,
        contract_weekly_minutes=2400,
        is_confirmed=True,
        confirmed_by_user_id=admin.id,
        confirmed_at=datetime.now(timezone.utc),
    )
    pg_session.add_all([opening, schedule])
    pg_session.flush()

    _expect_rejection(
        pg_session,
        "UPDATE person_hours_opening_balances SET balance_minutes = 0 WHERE id = :id",
        {"id": opening.id},
    )
    _expect_rejection(
        pg_session,
        """
        INSERT INTO person_weekly_schedules
          (person_id, valid_from, valid_until, monday_minutes, tuesday_minutes,
           wednesday_minutes, thursday_minutes, friday_minutes, saturday_minutes,
           sunday_minutes, weekly_total_minutes, contract_weekly_minutes,
           is_confirmed, created_at, updated_at)
        VALUES
          (:person_id, '2026-08-15', NULL, 480, 480, 480, 480, 480, 0, 0,
           2400, 2400, false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        """,
        {"person_id": worker.id},
    )

    pg_session.add(PayrollMonthPeriod(
        year=2026,
        month=8,
        status=PAYROLL_MONTH_LOCKED,
        locked_at=datetime.now(timezone.utc),
        locked_by_user_id=admin.id,
    ))
    pg_session.flush()

    # Closing the prior open-ended plan after August does not alter a locked
    # day's plan and must remain possible for normal effective-date versioning.
    schedule.valid_until = date(2026, 8, 31)
    pg_session.flush()
    september = PersonWeeklySchedule(
        person_id=worker.id,
        valid_from=date(2026, 9, 1),
        valid_until=None,
        monday_minutes=600,
        tuesday_minutes=600,
        wednesday_minutes=600,
        thursday_minutes=600,
        friday_minutes=0,
        saturday_minutes=0,
        sunday_minutes=0,
        weekly_total_minutes=2400,
        contract_weekly_minutes=2400,
        is_confirmed=True,
        confirmed_by_user_id=admin.id,
        confirmed_at=datetime.now(timezone.utc),
    )
    pg_session.add(september)
    pg_session.flush()

    _expect_rejection(
        pg_session,
        "UPDATE person_weekly_schedules SET monday_minutes = 450, "
        "weekly_total_minutes = 2370 WHERE id = :id",
        {"id": schedule.id},
    )


def test_postgres_locked_month_rejects_all_dated_payroll_writes(pg_session: Session):
    admin, worker = _payroll_users(pg_session)
    pg_session.add(PayrollMonthPeriod(
        year=2026,
        month=8,
        status=PAYROLL_MONTH_LOCKED,
        locked_at=datetime.now(timezone.utc),
        locked_by_user_id=admin.id,
    ))
    pg_session.flush()

    attempts = (
        (
            """
            INSERT INTO work_time_entries
              (person_id, work_date, break_minutes, travel_minutes, work_minutes,
               source, status, time_review_status, created_at, updated_at)
            VALUES
              (:person_id, '2026-08-04', 30, 0, 450, 'manual', 'submitted',
               'manually_approved', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            """,
            {"person_id": worker.id},
        ),
        (
            """
            INSERT INTO person_work_days
              (person_id, work_date, overnight_status, created_at, updated_at)
            VALUES
              (:person_id, '2026-08-04', 'none', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            """,
            {"person_id": worker.id},
        ),
        (
            """
            INSERT INTO absences
              (person_id, absence_type, start_date, end_date, status,
               created_at, updated_at)
            VALUES
              (:person_id, 'vacation', '2026-07-31', '2026-08-04', 'active',
               CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            """,
            {"person_id": worker.id},
        ),
        (
            """
            INSERT INTO person_hours_account_entries
              (person_id, entry_type, minutes_delta, balance_after_minutes, note,
               ledger_system, effective_date, source_type, is_active,
               created_at, updated_at)
            VALUES
              (:person_id, 'manual_adjustment', 60, 60, 'Korrektur', 'daily',
               '2026-08-04', 'manual_adjustment', true,
               CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            """,
            {"person_id": worker.id},
        ),
    )
    for statement, parameters in attempts:
        _expect_rejection(pg_session, statement, parameters)


def test_postgres_month_lock_key_serializes_a_parallel_dated_write():
    engine = create_engine(POSTGRES_URL)
    unique = uuid4().hex[:12]
    with engine.begin() as setup:
        person_id = setup.scalar(text(
            """
            INSERT INTO persons
              (first_name, last_name, display_name, short_code, person_type,
               is_active, employment_status, can_sign_measurements_immediately,
               address_location_status, created_at, updated_at)
            VALUES
              ('Lock', 'Probe', :display_name, :short_code, 'internal', true,
               'active', false, 'unchecked', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            RETURNING id
            """
        ), {"display_name": f"Lock Probe {unique}", "short_code": unique})
    first = engine.connect()
    second = engine.connect()
    first_transaction = first.begin()
    second_transaction = second.begin()
    try:
        first.execute(
            text("SELECT pg_advisory_xact_lock(:key)"),
            {"key": MONTH_LOCK_BASE + 202_608},
        )
        second.execute(text("SET LOCAL lock_timeout = '250ms'"))
        with pytest.raises(DBAPIError) as caught:
            second.execute(text(
                """
                INSERT INTO work_time_entries
                  (person_id, work_date, break_minutes, travel_minutes, work_minutes,
                   source, status, time_review_status, created_at, updated_at)
                VALUES
                  (:person_id, '2026-08-04', 0, 0, 60, 'manual', 'submitted',
                   'manually_approved', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                """
            ), {"person_id": person_id})
        assert getattr(caught.value.orig, "sqlstate", None) == "55P03"
    finally:
        second_transaction.rollback()
        first_transaction.rollback()
        second.close()
        first.close()
        with engine.begin() as cleanup:
            cleanup.execute(text("DELETE FROM persons WHERE id = :id"), {"id": person_id})
        engine.dispose()


def test_postgres_snapshots_artifacts_and_audits_are_append_only(pg_session: Session):
    admin, worker = _payroll_users(pg_session)
    period = PayrollMonthPeriod(year=2026, month=8, status=PAYROLL_MONTH_OPEN)
    pg_session.add(period)
    pg_session.flush()
    snapshot = PayrollMonthSnapshot(
        period_id=period.id,
        version=1,
        reference_id=f"append-only-{uuid4().hex}",
        period_start=date(2026, 8, 1),
        period_end=date(2026, 8, 31),
        cutover_date=date(2026, 8, 1),
        payload_json={"immutable": True},
        payload_sha256="0" * 64,
        created_by_user_id=admin.id,
    )
    pg_session.add(snapshot)
    pg_session.flush()
    person_row = PayrollMonthPersonSnapshot(
        snapshot_id=snapshot.id,
        person_id=worker.id,
        person_name=worker.display_name,
        opening_balance_minutes=0,
        movement_minutes=0,
        closing_balance_minutes=0,
        daily_values_json=[],
        source_sha256="1" * 64,
    )
    artifact = PayrollMonthArtifact(
        snapshot_id=snapshot.id,
        artifact_key="all_workers",
        filename="immutable_v1.xlsx",
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        content=b"immutable",
        byte_size=9,
        content_sha256="2" * 64,
    )
    audit = PayrollMonthAudit(
        period_id=period.id,
        snapshot_id=snapshot.id,
        action="MONTH_LOCKED",
        status_before=PAYROLL_MONTH_OPEN,
        status_after=PAYROLL_MONTH_LOCKED,
        user_id=admin.id,
    )
    pg_session.add_all([person_row, artifact, audit])
    pg_session.flush()

    for statement, row_id in (
        ("UPDATE payroll_month_snapshots SET payload_sha256 = :value WHERE id = :id", snapshot.id),
        ("DELETE FROM payroll_month_person_snapshots WHERE id = :id", person_row.id),
        ("UPDATE payroll_month_artifacts SET filename = :value WHERE id = :id", artifact.id),
        ("DELETE FROM payroll_month_audits WHERE id = :id", audit.id),
    ):
        _expect_rejection(
            pg_session,
            statement,
            {"id": row_id, "value": "changed"},
        )


def _expect_rejection(
    session: Session,
    statement: str,
    parameters: dict[str, object],
) -> None:
    with pytest.raises(DBAPIError):
        with session.begin_nested():
            session.execute(text(statement), parameters)


def _payroll_users(session: Session) -> tuple[User, Person]:
    unique = uuid4().hex[:12]
    worker = Person(
        first_name="PG",
        last_name="Worker",
        display_name=f"PG Worker {unique}",
        short_code=unique,
        person_type=PersonType.INTERNAL,
        is_active=True,
        weekly_hours=40,
    )
    admin = User(
        username=f"pg-admin-{unique}",
        display_name=f"PG Admin {unique}",
        password_hash="test",
        role=UserRole.ADMIN,
        is_active=True,
        must_change_password=False,
        office_page_permissions=[],
    )
    session.add_all([worker, admin])
    session.flush()
    return admin, worker
