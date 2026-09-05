from datetime import date

from fastapi import HTTPException
import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.models.person import Person
from app.models.person_hours_account import PersonHoursAccountEntry as Entry
from app.services.payroll_month_account_service import PayrollMonthAccountService, MONTHLY, REVERSAL
from app.services.payroll_month_xlsx_service import PayrollMonthTotals
from app.services.person_hours_account_service import PersonHoursAccountService
from app.tests.test_payroll_daily_ledger_service import db_session, configured_worker


def totals(delta):
    return PayrollMonthTotals(total_minutes=10080 + (delta or 0), normal_minutes=10080 if delta is not None else None,
                              overtime_minutes=delta, sick_day_count=0, sick_minutes=0, workday_count=21)


def legacy(db, person, minutes, *, week=32, entry_type="weekly_balance", effective=None, active=True):
    row = Entry(person_id=person.id, entry_type=entry_type, minutes_delta=minutes,
                balance_after_minutes=minutes, note="Retained original", iso_year=2026, iso_week=week,
                ledger_system="daily" if effective else "legacy", effective_date=effective, is_active=active)
    db.add(row)
    db.flush()
    return row


def post(service, person, delta=480, month=8, version=1):
    return service.post(person_id=person.id, year=2026, month=month,
                        reference_id=f"month:{person.id}:{month}:{version}", totals=totals(delta), user_id=None)


@pytest.mark.parametrize("old_automatic", [0, 300])
def test_transition_nets_old_automatic_and_reopen_only_reverses_actual_booking(old_automatic):
    db = db_session()
    person, user, _ = configured_worker(db, [480] * 5 + [0, 0], opening_minutes=6000 - old_automatic)
    old = legacy(db, person, old_automatic, entry_type="daily_balance", effective=date(2026, 8, 3))
    excluded_legacy = legacy(db, person, 9999)
    service = PayrollMonthAccountService(db)
    original = post(service, person)
    assert service.transition(person.id).balance_after_minutes == 6000
    assert original.source_payload["movement_minutes"] == 480
    assert original.minutes_delta == 480 - old_automatic
    assert original.source_payload["replaced_entry_ids"] == [old.id]
    assert service.current_balance(person.id) == 6480 - old_automatic
    assert post(service, person).id == original.id
    manual = PersonHoursAccountService(db)
    manual.create_manual_adjustment(person_id=person.id, hours_delta=2, effective_date=date(2026, 9, 5),
                                    note="Manual", current_user=user)
    manual.create_payout(person_id=person.id, hours=1, effective_date=date(2026, 9, 5), note="Payout", current_user=user)
    retained = original.balance_after_minutes
    assert service.reverse(original.source_reference_id, user_id=user.id)
    assert service.reverse(original.source_reference_id, user_id=user.id)
    assert service.current_balance(person.id) == 6060
    changed = post(service, person, delta=600, version=2)
    assert service.current_balance(person.id) == 6660 - old_automatic
    assert changed.minutes_delta == 600 - old_automatic
    assert original.balance_after_minutes == retained
    assert old.is_active and excluded_legacy.is_active
    assert old.note == excluded_legacy.note == "Retained original"
    assert len(list(db.scalars(select(Entry).where(Entry.entry_type == REVERSAL)))) == 1


@pytest.mark.parametrize("months", [(8, 9), (9, 8)])
@pytest.mark.parametrize("reversed_old", [False, True])
def test_cross_month_legacy_never_split_and_reversals_are_netted(months, reversed_old):
    db = db_session()
    person = Person(first_name="Legacy", last_name="Test", display_name="Legacy", short_code="LEG", weekly_hours=40)
    db.add(person)
    db.flush()
    legacy(db, person, 6000, entry_type="manual_adjustment", week=None)
    legacy(db, person, 300, week=36)  # 31 August–6 September; no daily allocation exists.
    if reversed_old:
        legacy(db, person, -300, week=36)
    service = PayrollMonthAccountService(db)
    rows = [post(service, person, month=month) for month in months]
    assert all(row.source_payload["movement_minutes"] == 480 for row in rows)
    if reversed_old:
        assert [row.minutes_delta for row in rows] == [480, 480]
        assert service.current_balance(person.id) == 6960
        assert not service.notices(person.id)
    else:
        assert [row.minutes_delta for row in rows] == [0, 0]
        assert all("Monatsgrenze" in row.source_payload["pending_reason"] for row in rows)
        assert service.current_balance(person.id) is None
        assert len(service.notices(person.id)) == 2


@pytest.mark.parametrize("months", [(8, 9), (9, 8)])
def test_identifiable_legacy_weeks_replaced_once_independent_of_month_order(months):
    db = db_session()
    person = Person(first_name="Legacy", last_name="Test", display_name="Legacy", short_code="LEG", weekly_hours=40)
    db.add(person)
    db.flush()
    legacy(db, person, 6000, entry_type="manual_adjustment", week=None)
    august = legacy(db, person, 300, week=32)
    september = legacy(db, person, 120, week=37)
    service = PayrollMonthAccountService(db)
    rows = [post(service, person, month=month) for month in months]
    assert service.current_balance(person.id) == 6960
    assert sorted(row.minutes_delta for row in rows) == [180, 360]
    assert {identifier for row in rows for identifier in row.source_payload["replaced_entry_ids"]} == {august.id, september.id}
    assert len([identifier for row in rows for identifier in row.source_payload["replaced_entry_ids"]]) == 2


@pytest.mark.parametrize("known_zero", [False, True])
def test_explicit_zero_is_known_but_missing_start_remains_null_in_schema(known_zero):
    db = db_session()
    if known_zero:
        person, _, _ = configured_worker(db, [480] * 5 + [0, 0])
    else:
        person = Person(first_name="New", last_name="Test", display_name="New", short_code="NEW", weekly_hours=40)
        db.add(person)
        db.flush()
    service = PayrollMonthAccountService(db)
    row = post(service, person)
    account = PersonHoursAccountService(db).get_account(person_id=person.id)
    assert row.minutes_delta == 480
    assert account.current_balance_minutes == (480 if known_zero else None)
    assert row.balance_after_minutes == (480 if known_zero else None)
    assert bool(account.notices) is not known_zero
    assert account.model_dump(mode="json")["current_balance_minutes"] == (480 if known_zero else None)


def test_missing_contract_saves_unknown_month_movement_not_zero_and_reopen_restores_known_balance():
    db = db_session()
    person, _, _ = configured_worker(db, [480] * 5 + [0, 0], opening_minutes=6000)
    service = PayrollMonthAccountService(db)
    row = post(service, person, delta=None)
    assert row.source_payload["movement_minutes"] is None
    assert row.source_payload["pending_reason"]
    assert service.current_balance(person.id) is None
    service.reverse(row.source_reference_id, user_id=None)
    assert service.current_balance(person.id) == 6000


def test_active_month_is_unique_beyond_reference_id_and_has_database_constraint():
    db = db_session()
    person, _, _ = configured_worker(db, [480] * 5 + [0, 0])
    service = PayrollMonthAccountService(db)
    first = post(service, person)
    with pytest.raises(HTTPException, match="aktive Monatsbuchung"):
        post(service, person, version=2)
    with pytest.raises(IntegrityError):
        with db.begin_nested():
            db.add(Entry(person_id=person.id, entry_type=MONTHLY, ledger_system="daily", is_active=True,
                         effective_date=first.effective_date, minutes_delta=1, balance_after_minutes=1, note="Duplicate"))
            db.flush()


def test_reopened_old_daily_posting_adjusts_captured_authority_without_rewriting_baseline():
    db = db_session()
    person, _, ledger_service = configured_worker(db, [480] * 5 + [0, 0], opening_minutes=6000)
    old = legacy(db, person, 300, entry_type="daily_balance", effective=date(2026, 8, 3))
    service = PayrollMonthAccountService(db)
    transition = service.capture(person.id, None)
    old.is_active = False  # Compatibility path for reopening an old daily-based approval.
    db.flush()
    assert ledger_service.recalculate_balance_history(person.id) == 6000
    row = post(service, person)
    assert row.minutes_delta == 480
    assert service.current_balance(person.id) == 6480
    assert transition.balance_after_minutes == 6300
    assert old.balance_after_minutes == 300


def test_manual_movements_with_missing_start_remain_independent_without_inventing_balance():
    db = db_session()
    person, user, _ = configured_worker(db, [480] * 5 + [0, 0])
    from app.models.payroll_daily_ledger import PersonHoursOpeningBalance
    # Isolated fixture represents a worker for whom no starting balance exists.
    db.delete(db.scalar(select(PersonHoursOpeningBalance)))
    db.commit()
    account = PersonHoursAccountService(db)
    assert account.get_account(person_id=person.id).current_balance_minutes is None
    result = account.create_manual_adjustment(person_id=person.id, hours_delta=2,
                                              effective_date=date(2026, 9, 5), note="Independent", current_user=user)
    assert result.current_balance_minutes is None
    assert result.entries[0].minutes_delta == 120
    row = post(PayrollMonthAccountService(db), person)
    assert row.minutes_delta == 480 and row.balance_after_minutes is None
