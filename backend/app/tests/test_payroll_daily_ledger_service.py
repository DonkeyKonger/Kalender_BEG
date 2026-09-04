from datetime import date, datetime, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session

from app.models import Base
from app.models.absence import Absence
from app.models.enums import AbsenceStatus, AbsenceType, PersonType, UserRole
from app.models.payroll_daily_ledger import PersonHoursOpeningBalance, PersonWeeklySchedule
from app.models.payroll_month import PAYROLL_MONTH_LOCKED, PayrollMonthPeriod
from app.models.person import Person
from app.models.person_hours_account import PersonHoursAccountEntry
from app.models.time_entry_weekly_review import TimeEntryWeeklyReview
from app.models.user import User
from app.models.work_time_entry import WorkTimeEntry
from app.schemas.payroll_setup import PayrollOpeningBalanceUpsert, PayrollWeeklyPlanUpsert
from app.services.payroll_daily_ledger_service import (
    ENTRY_TYPE_DAILY_BALANCE,
    LEDGER_SYSTEM_DAILY,
    PayrollDailyLedgerService,
    PayrollLedgerValidationError,
    PayrollSetupValidationError,
)
from app.services.person_hours_account_service import PersonHoursAccountService
from app.services.time_entry_service import TimeEntryService


def db_session() -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    return Session(engine)


def configured_worker(
    db: Session,
    weekday_minutes: list[int],
    *,
    opening_minutes: int = 0,
    name: str = "Test Monteur",
) -> tuple[Person, User, PayrollDailyLedgerService]:
    person = Person(
        first_name="Test",
        last_name="Monteur",
        display_name=name,
        short_code=name[:8],
        person_type=PersonType.INTERNAL,
        weekly_hours=sum(weekday_minutes) / 60,
    )
    user = User(
        username=f"office-{name}",
        display_name="Büro",
        password_hash="x",
        role=UserRole.OFFICE,
        office_page_permissions=["payroll"],
    )
    db.add_all([person, user])
    db.flush()
    service = PayrollDailyLedgerService(db)
    service.upsert_weekly_schedule(
        person_id=person.id,
        payload=PayrollWeeklyPlanUpsert(
            valid_from=date(2026, 8, 1),
            weekday_minutes=weekday_minutes,
            confirm=True,
        ),
        current_user=user,
    )
    service.upsert_opening_balance(
        person_id=person.id,
        payload=PayrollOpeningBalanceUpsert(
            effective_date=date(2026, 7, 31),
            minutes=opening_minutes,
            confirm=True,
        ),
        current_user=user,
    )
    db.commit()
    return person, user, service


def test_confirmed_schedule_must_match_contract_and_cannot_overlap():
    db = db_session()
    person, user, service = configured_worker(db, [480, 480, 480, 480, 480, 0, 0])

    with pytest.raises(PayrollSetupValidationError, match="Wochensumme"):
        service.upsert_weekly_schedule(
            person_id=person.id,
            payload=PayrollWeeklyPlanUpsert(
                valid_from=date(2026, 9, 1),
                valid_to=date(2026, 9, 30),
                weekday_minutes=[500, 500, 500, 500, 0, 0, 0],
                confirm=True,
            ),
            current_user=user,
        )

    with pytest.raises(PayrollSetupValidationError, match="unveränderlich"):
        service.upsert_weekly_schedule(
            person_id=person.id,
            payload=PayrollWeeklyPlanUpsert(
                valid_from=date(2026, 8, 1),
                weekday_minutes=[600, 600, 600, 600, 0, 0, 0],
                confirm=True,
            ),
            current_user=user,
        )


def test_new_schedule_versions_close_predecessor_without_overlapping():
    db = db_session()
    person, user, service = configured_worker(db, [480, 480, 480, 480, 480, 0, 0])
    person.weekly_hours = 40

    second = service.upsert_weekly_schedule(
        person_id=person.id,
        payload=PayrollWeeklyPlanUpsert(
            valid_from=date(2026, 9, 1),
            weekday_minutes=[600, 600, 600, 600, 0, 0, 0],
            confirm=True,
        ),
        current_user=user,
    )
    db.commit()
    first = db.scalar(select(PersonWeeklySchedule).where(
        PersonWeeklySchedule.person_id == person.id,
        PersonWeeklySchedule.valid_from == date(2026, 8, 1),
    ))

    assert first.valid_until == date(2026, 8, 31)
    assert second.weekday_minutes == (600, 600, 600, 600, 0, 0, 0)


def test_september_schedule_can_follow_locked_august_without_changing_august_targets():
    db = db_session()
    person, user, service = configured_worker(db, [480, 480, 480, 480, 480, 0, 0])
    db.add(PayrollMonthPeriod(year=2026, month=8, status=PAYROLL_MONTH_LOCKED))
    db.commit()

    service.upsert_weekly_schedule(
        person_id=person.id,
        payload=PayrollWeeklyPlanUpsert(
            valid_from=date(2026, 9, 1),
            weekday_minutes=[600, 600, 600, 600, 0, 0, 0],
            confirm=True,
        ),
        current_user=user,
    )
    db.commit()
    schedules = list(db.scalars(
        select(PersonWeeklySchedule)
        .where(PersonWeeklySchedule.person_id == person.id)
        .order_by(PersonWeeklySchedule.valid_from)
    ))

    assert schedules[0].valid_until == date(2026, 8, 31)
    assert schedules[0].target_minutes_for(date(2026, 8, 31)) == 480
    assert schedules[1].target_minutes_for(date(2026, 9, 1)) == 600


def test_open_ended_schedule_version_cannot_reach_a_later_locked_month():
    db = db_session()
    person, user, service = configured_worker(
        db, [480, 480, 480, 480, 480, 0, 0]
    )
    db.add(PayrollMonthPeriod(year=2026, month=11, status=PAYROLL_MONTH_LOCKED))
    db.commit()

    with pytest.raises(HTTPException) as caught:
        service.upsert_weekly_schedule(
            person_id=person.id,
            payload=PayrollWeeklyPlanUpsert(
                valid_from=date(2026, 10, 1),
                weekday_minutes=[600, 600, 600, 600, 0, 0, 0],
                confirm=True,
            ),
            current_user=user,
        )

    assert caught.value.status_code == 409
    assert caught.value.detail["year"] == 2026
    assert caught.value.detail["month"] == 11


def test_confirmed_opening_balance_is_immutable_and_supports_negative_minutes():
    db = db_session()
    person, user, service = configured_worker(
        db, [480, 480, 480, 480, 480, 0, 0], opening_minutes=-90
    )
    opening = db.scalar(select(PersonHoursOpeningBalance).where(
        PersonHoursOpeningBalance.person_id == person.id
    ))
    assert opening.balance_minutes == -90
    account = PersonHoursAccountService(db).get_account(person_id=person.id)
    assert account.current_balance_minutes == -90
    assert account.opening_balance is not None
    assert account.opening_balance.minutes == -90
    assert account.opening_balance.effective_date == date(2026, 7, 31)
    assert account.opening_balance.confirmed_by_name == "Büro"

    with pytest.raises(PayrollSetupValidationError, match="unveränderlich"):
        service.upsert_opening_balance(
            person_id=person.id,
            payload=PayrollOpeningBalanceUpsert(minutes=0, confirm=True),
            current_user=user,
        )


@pytest.mark.parametrize(
    ("weekday_minutes", "kind", "work_date", "target", "credit"),
    [
        ([480, 480, 480, 480, 480, 0, 0], AbsenceType.VACATION, date(2026, 8, 3), 480, 480),
        ([600, 600, 600, 600, 0, 0, 0], AbsenceType.VACATION, date(2026, 8, 3), 600, 600),
        ([480, 480, 480, 480, 480, 0, 0], AbsenceType.SICK, date(2026, 8, 3), 480, 480),
        ([480, 480, 480, 480, 480, 0, 0], AbsenceType.SCHOOL, date(2026, 8, 3), 480, 480),
        ([600, 600, 600, 600, 0, 0, 0], AbsenceType.VACATION, date(2026, 8, 7), 0, 0),
    ],
)
def test_absences_credit_exact_individual_daily_target(
    weekday_minutes, kind, work_date, target, credit
):
    db = db_session()
    person, user, service = configured_worker(db, weekday_minutes)
    db.add(Absence(
        person_id=person.id,
        absence_type=kind,
        start_date=work_date,
        end_date=work_date,
        status=AbsenceStatus.ACTIVE,
    ))
    db.commit()

    days = service.finalize_person_days(
        person_id=person.id,
        period_start=work_date,
        period_end=work_date,
        source="weekly_review",
        reference_id=f"review-{kind.value}-{work_date}",
        created_by_user_id=user.id,
    )

    assert len(days) == 1
    assert days[0].target_minutes == target
    assert days[0].credit_minutes == credit
    assert days[0].actual_minutes == credit
    assert days[0].movement_minutes == 0


def test_free_overrides_target_with_zero_and_creates_no_movement():
    db = db_session()
    person, user, service = configured_worker(db, [480, 480, 480, 480, 480, 0, 0])
    work_date = date(2026, 8, 3)
    db.add(Absence(
        person_id=person.id,
        absence_type=AbsenceType.FREE,
        start_date=work_date,
        end_date=work_date,
        status=AbsenceStatus.ACTIVE,
    ))
    db.commit()

    day = service.finalize_person_days(
        person_id=person.id,
        period_start=work_date,
        period_end=work_date,
        source="weekly_review",
        reference_id="free-day",
        created_by_user_id=user.id,
    )[0]

    assert (day.target_minutes, day.credit_minutes, day.actual_minutes) == (0, 0, 0)
    assert day.movement_minutes == 0


def test_public_holiday_has_zero_target_and_no_automatic_credit():
    db = db_session()
    person, user, service = configured_worker(db, [480, 480, 480, 480, 480, 0, 0])
    christmas_day = date(2026, 12, 25)  # Friday with a contractual target.

    day = service.finalize_person_days(
        person_id=person.id,
        period_start=christmas_day,
        period_end=christmas_day,
        source="weekly_review",
        reference_id="public-holiday",
        created_by_user_id=user.id,
    )[0]

    assert day.is_public_holiday is True
    assert (day.target_minutes, day.credit_minutes, day.actual_minutes) == (0, 0, 0)
    assert day.movement_minutes == 0


@pytest.mark.parametrize("conflict", ["different_absences", "work_and_absence"])
def test_ambiguous_daily_sources_block_finalization(conflict):
    db = db_session()
    person, user, service = configured_worker(db, [480, 480, 480, 480, 480, 0, 0])
    work_date = date(2026, 8, 3)
    db.add(Absence(
        person_id=person.id,
        absence_type=AbsenceType.VACATION,
        start_date=work_date,
        end_date=work_date,
        status=AbsenceStatus.ACTIVE,
    ))
    if conflict == "different_absences":
        db.add(Absence(
            person_id=person.id,
            absence_type=AbsenceType.SICK,
            start_date=work_date,
            end_date=work_date,
            status=AbsenceStatus.ACTIVE,
        ))
    else:
        db.add(WorkTimeEntry(
            person_id=person.id,
            work_date=work_date,
            work_minutes=480,
        ))
    db.commit()

    with pytest.raises(PayrollLedgerValidationError) as captured:
        service.finalize_person_days(
            person_id=person.id,
            period_start=work_date,
            period_end=work_date,
            source="weekly_review",
            reference_id=conflict,
            created_by_user_id=user.id,
        )

    assert captured.value.blockers[0].code in {
        "conflicting_absence_types",
        "work_absence_conflict",
    }


def test_day_finalization_is_idempotent_and_stale_sources_block_rebooking():
    db = db_session()
    person, user, service = configured_worker(db, [480, 480, 480, 480, 480, 0, 0])
    work_date = date(2026, 8, 3)
    entry = WorkTimeEntry(person_id=person.id, work_date=work_date, work_minutes=480)
    db.add(entry)
    db.commit()

    first = service.finalize_person_days(
        person_id=person.id,
        period_start=work_date,
        period_end=work_date,
        source="weekly_review",
        reference_id="review-1",
        created_by_user_id=user.id,
    )
    second = service.finalize_person_days(
        person_id=person.id,
        period_start=work_date,
        period_end=work_date,
        source="weekly_review",
        reference_id="review-1",
        created_by_user_id=user.id,
    )
    assert first[0].ledger_entry_id == second[0].ledger_entry_id
    assert db.scalar(select(func.count(PersonHoursAccountEntry.id)).where(
        PersonHoursAccountEntry.entry_type == ENTRY_TYPE_DAILY_BALANCE
    )) == 1

    entry.work_minutes = 600
    db.flush()
    with pytest.raises(PayrollLedgerValidationError) as captured:
        service.finalize_person_days(
            person_id=person.id,
            period_start=work_date,
            period_end=work_date,
            source="weekly_review",
            reference_id="review-1",
            created_by_user_id=user.id,
        )
    assert captured.value.blockers[0].code == "finalized_day_changed"


def test_cross_month_week_is_split_and_reopen_keeps_september_active():
    db = db_session()
    person, user, service = configured_worker(db, [480, 480, 480, 480, 480, 0, 0])

    days = service.finalize_person_days(
        person_id=person.id,
        period_start=date(2026, 8, 31),
        period_end=date(2026, 9, 6),
        source="weekly_review",
        reference_id="2026-W36",
        created_by_user_id=user.id,
    )
    assert [day.work_date for day in days] == [
        date(2026, 8, 31),
        date(2026, 9, 1),
        date(2026, 9, 2),
        date(2026, 9, 3),
        date(2026, 9, 4),
        date(2026, 9, 5),
        date(2026, 9, 6),
    ]

    deactivated = service.unfinalize_month(
        2026,
        8,
        source="month_reopen",
        reference_id="2026-08-v1",
    )
    assert deactivated == 1
    active_dates = list(db.scalars(
        select(PersonHoursAccountEntry.effective_date)
        .where(
            PersonHoursAccountEntry.ledger_system == LEDGER_SYSTEM_DAILY,
            PersonHoursAccountEntry.entry_type == ENTRY_TYPE_DAILY_BALANCE,
            PersonHoursAccountEntry.is_active.is_(True),
        )
        .order_by(PersonHoursAccountEntry.effective_date)
    ))
    assert active_dates == [date(2026, 9, day) for day in range(1, 7)]


def test_week_approval_and_reset_touch_only_open_side_of_cross_month_week():
    db = db_session()
    person, user, ledger = configured_worker(db, [480, 480, 480, 480, 480, 0, 0])
    ledger.finalize_person_days(
        person_id=person.id,
        period_start=date(2026, 8, 31),
        period_end=date(2026, 8, 31),
        source="month_close",
        reference_id="2026-08-v1",
        created_by_user_id=user.id,
    )
    db.add(PayrollMonthPeriod(year=2026, month=8, status=PAYROLL_MONTH_LOCKED))
    db.commit()

    time_entries = TimeEntryService(db)
    time_entries.mark_weekly_review(
        person_id=person.id,
        iso_year=2026,
        iso_week=36,
        current_user=user,
    )
    active = list(db.scalars(
        select(PersonHoursAccountEntry)
        .where(
            PersonHoursAccountEntry.entry_type == ENTRY_TYPE_DAILY_BALANCE,
            PersonHoursAccountEntry.is_active.is_(True),
        )
        .order_by(PersonHoursAccountEntry.effective_date)
    ))
    assert [entry.effective_date for entry in active] == [
        date(2026, 8, 31),
        *[date(2026, 9, day) for day in range(1, 7)],
    ]
    assert active[0].source_type == "month_close"
    assert {entry.source_type for entry in active[1:]} == {"WEEK_APPROVAL"}
    assert not any(entry.entry_type == "weekly_balance" for entry in active)

    time_entries.reset_weekly_review(
        person_id=person.id,
        iso_year=2026,
        iso_week=36,
        current_user=user,
    )
    remaining = list(db.scalars(
        select(PersonHoursAccountEntry).where(
            PersonHoursAccountEntry.entry_type == ENTRY_TYPE_DAILY_BALANCE,
            PersonHoursAccountEntry.is_active.is_(True),
        )
    ))
    assert len(remaining) == 1
    assert remaining[0].effective_date == date(2026, 8, 31)
    assert remaining[0].source_type == "month_close"


def test_locked_post_cutover_week_cannot_reset_a_transitional_legacy_review():
    db = db_session()
    person, user, _ledger = configured_worker(
        db, [480, 480, 480, 480, 480, 0, 0]
    )
    db.add_all([
        PayrollMonthPeriod(year=2026, month=8, status=PAYROLL_MONTH_LOCKED),
        TimeEntryWeeklyReview(
            person_id=person.id,
            iso_year=2026,
            iso_week=35,
            status="reviewed",
            reviewed_by_user_id=user.id,
            reviewed_at=datetime.now(timezone.utc),
            daily_ledger_reference_id=None,
        ),
    ])
    db.commit()

    with pytest.raises(HTTPException) as caught:
        TimeEntryService(db).reset_weekly_review(
            person_id=person.id,
            iso_year=2026,
            iso_week=35,
            current_user=user,
        )

    assert caught.value.status_code == 409
    assert "vollständig in abgeschlossenen Monaten" in str(caught.value.detail)


def test_month_result_uses_opening_and_all_effective_dated_new_entries():
    db = db_session()
    person, user, service = configured_worker(
        db, [480, 480, 480, 480, 480, 0, 0], opening_minutes=1110
    )
    # A legacy row remains visible but is replaced by the confirmed opening in
    # the authoritative balance.
    db.add(PersonHoursAccountEntry(
        person_id=person.id,
        entry_type="weekly_balance",
        minutes_delta=9999,
        balance_after_minutes=9999,
        note="Legacy",
        ledger_system="legacy",
        is_active=True,
    ))
    db.add_all([
        PersonHoursAccountEntry(
            person_id=person.id,
            entry_type="manual_adjustment",
            minutes_delta=60,
            balance_after_minutes=1170,
            note="Korrektur",
            ledger_system="daily",
            effective_date=date(2026, 8, 3),
            source_type="manual_adjustment",
            is_active=True,
        ),
        PersonHoursAccountEntry(
            person_id=person.id,
            entry_type="payout",
            minutes_delta=-30,
            balance_after_minutes=1140,
            note="Auszahlung",
            ledger_system="daily",
            effective_date=date(2026, 9, 1),
            source_type="payout",
            is_active=True,
        ),
    ])
    db.commit()

    assert service.balance_before(person.id, date(2026, 9, 1)) == 1170
    september = service.finalize_month(
        2026,
        9,
        source="month_close",
        reference_id="2026-09-v1",
        created_by_user_id=user.id,
    )
    result = september.people[0]

    assert result.opening_balance_minutes == 1170
    assert result.movement_minutes == -10590
    assert result.closing_balance_minutes == -9420
    assert result.days[0].other_movement_minutes == -30


def test_missing_confirmed_setup_blocks_readiness_without_guessing():
    db = db_session()
    person = Person(
        first_name="Ohne",
        last_name="Plan",
        display_name="Ohne Plan",
        short_code="OP",
        person_type=PersonType.INTERNAL,
        weekly_hours=40,
    )
    db.add(person)
    db.commit()

    readiness = PayrollDailyLedgerService(db).validate_month_readiness(2026, 8)

    assert readiness.is_ready is False
    assert {blocker.code for blocker in readiness.blockers} >= {
        "opening_balance_missing",
        "schedule_missing",
    }
    schedule_blockers = [blocker for blocker in readiness.blockers if blocker.code == "schedule_missing"]
    assert len(schedule_blockers) == 1
    assert schedule_blockers[0].work_date == date(2026, 8, 1)
    assert schedule_blockers[0].work_date_end == date(2026, 8, 31)
    assert "Regelmäßige Arbeitszeit" not in schedule_blockers[0].message
    assert "Ohne Plan" in schedule_blockers[0].message
    assert "40 vertraglichen Wochenstunden" in schedule_blockers[0].message
    assert "01.08.2026 bis 31.08.2026" in schedule_blockers[0].message


def test_empty_setup_does_not_activate_the_daily_payroll_process():
    db = db_session()
    service = PayrollDailyLedgerService(db)

    assert service.setup_status().is_ready is False
    assert service.is_process_active() is False
