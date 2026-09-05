from datetime import date

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.api.dependencies import get_current_user
from app.api.routes import persons
from app.core.database import get_db
from app.models import Base
from app.models.enums import UserRole
from app.models.payroll_month import PayrollMonthPeriod, PayrollMonthPersonApprovalArtifact
from app.models.person import Person
from app.models.person_hours_account import PersonHoursAccountEntry as Entry
from app.models.user import User
from app.models.work_time_entry import WorkTimeEntry
from app.services.payroll_month_account_service import PayrollMonthAccountService
from app.services.payroll_period_guard import PayrollPeriodGuard
from app.services.person_hours_account_service import PersonHoursAccountService
from app.tests.test_payroll_month_account_integration import context, approve


def test_existing_regular_empty_zero_account_remains_known_through_manual_month_and_reopen():
    db, person, user, close = context(known=False)
    account = PersonHoursAccountService(db)
    assert account.get_account(person_id=person.id).current_balance_minutes == 0
    updated = account.create_manual_adjustment(person_id=person.id, hours_delta=2,
                                               effective_date=date(2026, 8, 31), note="Manual +2", current_user=user)
    monthly = PayrollMonthAccountService(db)
    assert monthly.transition(person.id).source_payload["baseline_minutes"] == 0
    assert updated.current_balance_minutes == 120
    approve(close, person, user)
    assert monthly.current_balance(person.id) == 240
    close.reopen_person_month(year=2026, month=8, person_id=person.id, reason="Recheck", current_user=user)
    assert monthly.current_balance(person.id) == 120
    approve(close, person, user)
    assert monthly.current_balance(person.id) == 240


def test_previously_misclassified_empty_zero_transition_recovers_without_rewriting_history():
    db, person, user, close = context(known=False)
    old_payload = {"baseline_minutes": None, "opening_id": None, "included_entries": [],
                   "captured_at": "2026-09-05T12:00:00+00:00"}
    transition = Entry(person_id=person.id, entry_type="monthly_transition", ledger_system="legacy",
                        source_type="monthly_transition", idempotency_key=f"monthly-transition:{person.id}",
                        minutes_delta=0, balance_after_minutes=None, is_active=True, source_payload=old_payload,
                        note="Anfangsbestand ungeklärt; Monatsbewegungen werden getrennt erfasst.")
    db.add(transition)
    db.flush()
    manual = Entry(person_id=person.id, entry_type="manual_adjustment", source_type="manual_adjustment",
                    ledger_system="daily", effective_date=date(2026, 8, 31), minutes_delta=120,
                    balance_after_minutes=None, note="Already recorded +2", is_active=True)
    db.add(manual)
    db.commit()
    monthly = PayrollMonthAccountService(db)
    assert PersonHoursAccountService(db).get_account(person_id=person.id).current_balance_minutes == 120
    approve(close, person, user)
    assert monthly.current_balance(person.id) == 240
    close.reopen_person_month(year=2026, month=8, person_id=person.id, reason="Recheck", current_user=user)
    assert monthly.current_balance(person.id) == 120
    assert transition.source_payload == old_payload
    assert transition.balance_after_minutes is None and manual.balance_after_minutes is None
    approve(close, person, user)
    assert monthly.current_balance(person.id) == 240


@pytest.mark.parametrize("global_close", [False, True])
def test_manual_adjustment_and_payout_in_locked_month_are_independent_of_payroll(global_close):
    db, person, user, close = context()
    approve(close, person, user)
    if global_close:
        close.lock_month(year=2026, month=8, confirmed=True, current_user=user)
    entries_before = [(entry.id, entry.minutes_delta, entry.balance_after_minutes, entry.is_active, entry.note)
                      for entry in db.scalars(select(Entry).order_by(Entry.id))]
    artifact = db.scalar(select(PayrollMonthPersonApprovalArtifact))
    retained = bytes(artifact.content)
    time_rows = [(entry.id, entry.work_minutes, entry.payroll_corrected_work_minutes)
                 for entry in db.scalars(select(WorkTimeEntry))]
    with pytest.raises(HTTPException):
        PayrollPeriodGuard(db).assert_date_mutable(date(2026, 8, 31), person_id=person.id)
    account = PersonHoursAccountService(db)
    account.create_manual_adjustment(person_id=person.id, hours_delta=2, effective_date=date(2026, 8, 31),
                                     note="Independent +2", current_user=user)
    account.create_manual_adjustment(person_id=person.id, hours_delta=-0.5, effective_date=date(2026, 8, 31),
                                     note="Independent -0.5", current_user=user)
    result = account.create_payout(person_id=person.id, hours=1, effective_date=date(2026, 8, 31),
                                  note="Independent payout", current_user=user)
    assert result.current_balance_minutes == 6150  # 6000 + monthly120 + manual120 - 30 - payout60.
    assert [(db.get(Entry, identifier).id, db.get(Entry, identifier).minutes_delta,
             db.get(Entry, identifier).balance_after_minutes, db.get(Entry, identifier).is_active,
             db.get(Entry, identifier).note) for identifier, *_ in entries_before] == entries_before
    assert bytes(artifact.content) == retained
    assert [(entry.id, entry.work_minutes, entry.payroll_corrected_work_minutes)
            for entry in db.scalars(select(WorkTimeEntry))] == time_rows
    with pytest.raises(HTTPException):
        PayrollPeriodGuard(db).assert_date_mutable(date(2026, 8, 31), person_id=person.id)
    if global_close:
        close.reopen_month(year=2026, month=8, reason="Recheck", current_user=user)
    else:
        close.reopen_person_month(year=2026, month=8, person_id=person.id, reason="Recheck", current_user=user)
    assert account.get_account(person_id=person.id).current_balance_minutes == 6030
    first_time = db.scalar(select(WorkTimeEntry).order_by(WorkTimeEntry.work_date))
    first_time.payroll_corrected_work_minutes = 660
    db.commit()
    approve(close, person, user)
    if global_close:
        close.lock_month(year=2026, month=8, confirmed=True, current_user=user)
    assert account.get_account(person_id=person.id).current_balance_minutes == 6210
    assert bytes(artifact.content) == retained
    manual_rows = list(db.scalars(select(Entry).where(Entry.ledger_system == "daily",
                                                    Entry.entry_type.in_(["manual_adjustment", "payout"]))))
    assert [row.minutes_delta for row in manual_rows] == [120, -30, -60]
    assert all(row.is_active for row in manual_rows)


@pytest.mark.parametrize("role", [UserRole.MONTEUR, UserRole.OFFICE])
@pytest.mark.parametrize("operation,payload", [
    ("manual-adjustment", {"hours_delta": 2, "note": "Denied"}),
    ("payout", {"hours": 1}),
])
def test_unauthorized_roles_still_cannot_append_manual_account_entries(role, operation, payload):
    db, person, user, _ = context()
    user.role = role
    user.office_page_permissions = ["export"]
    app = FastAPI()
    app.include_router(persons.router)
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_db] = lambda: db
    before = list(db.scalars(select(Entry.id)))
    with TestClient(app) as client:
        result = client.post(f"/persons/{person.id}/hours-account/{operation}",
                             json={**payload, "effective_date": "2026-08-31"})
    assert result.status_code == 403
    assert list(db.scalars(select(Entry.id))) == before


@pytest.mark.parametrize("role", [UserRole.ADMIN, UserRole.PROJECT_MANAGER, UserRole.OFFICE])
def test_existing_authorized_roles_can_append_via_api_without_reopening_month(role):
    engine = create_engine("sqlite+pysqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        person = Person(first_name="Manual", last_name="Test", display_name="Manual Test", short_code="MT")
        user = User(username="authorized", display_name="Authorized", password_hash="x", role=role,
                    office_page_permissions=["payroll"])
        period = PayrollMonthPeriod(year=2026, month=9, status="LOCKED")
        db.add_all([person, user, period])
        db.commit()
        app = FastAPI()
        app.include_router(persons.router)
        app.dependency_overrides[get_current_user] = lambda: user
        app.dependency_overrides[get_db] = lambda: db
        with TestClient(app) as client:
            result = client.post(f"/persons/{person.id}/hours-account/manual-adjustment",
                                 json={"hours_delta": 2, "note": "Independent", "effective_date": "2026-09-05"})
        assert result.status_code == 200
        assert result.json()["current_balance_minutes"] == 120
        db.refresh(period)
        assert period.status == "LOCKED"


@pytest.mark.parametrize("known_row", [False, True])
def test_actual_unknown_history_is_not_converted_to_regular_zero(known_row):
    db, person, user, _ = context(known=known_row, unclear=True)
    service = PersonHoursAccountService(db)
    assert service.get_account(person_id=person.id).current_balance_minutes is None
    result = service.create_manual_adjustment(person_id=person.id, hours_delta=2,
                                              effective_date=date(2026, 8, 31), note="Independent", current_user=user)
    assert result.current_balance_minutes is None
    assert PayrollMonthAccountService(db).transition(person.id).source_payload["included_entries"]
