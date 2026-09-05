from datetime import date, time
import hashlib
from io import BytesIO
from zipfile import ZipFile
import xml.etree.ElementTree as ET

from fastapi import HTTPException
import pytest
from sqlalchemy import select, text

from app.models.enums import PersonType, UserRole
from app.models.payroll_month import PayrollMonthPeriod, PayrollMonthPersonApproval, PayrollMonthPersonApprovalArtifact, PayrollMonthSnapshot, PayrollMonthPersonSnapshot
from app.models.person import Person
from app.models.person_hours_account import PersonHoursAccountEntry as Entry
from app.models.user import User
from app.models.work_time_entry import WorkTimeEntry
from app.services.payroll_month_account_service import PayrollMonthAccountService, MONTHLY
from app.services.payroll_month_close_service import PayrollMonthCloseService
from app.services.payroll_month_export_service import PayrollMonthExportService
from app.services.person_hours_account_service import PersonHoursAccountService
from app.tests.test_payroll_daily_ledger_service import db_session
from app.tests.test_payroll_month_xlsx_service import cell_text


def context(*, known=True, weekly_hours=40, unclear=False):
    db = db_session()
    person = Person(first_name="Monthly", last_name="Test", display_name="Monthly Test", short_code="MT",
                    person_type=PersonType.INTERNAL, weekly_hours=weekly_hours)
    user = User(username="monthly-admin", display_name="Admin", password_hash="x", role=UserRole.ADMIN)
    db.add_all([person, user])
    db.flush()
    if known:
        db.add(Entry(person_id=person.id, entry_type="manual_adjustment", minutes_delta=6000,
                     balance_after_minutes=6000, note="Accepted current balance"))
    if unclear:
        db.add(Entry(person_id=person.id, entry_type="manual_adjustment", minutes_delta=0,
                     balance_after_minutes=None, note="Explizit ungeklärter Altbestand"))
    for day in range(1, 32):
        work_date = date(2026, 8, day)
        if work_date.weekday() < 5:
            minutes = 600 if day == 3 else 480
            db.add(WorkTimeEntry(person_id=person.id, work_date=work_date, start_time=time(7),
                                end_time=time(17 if day == 3 else 15), break_minutes=0,
                                work_minutes=minutes, time_review_status="manually_approved"))
    db.commit()
    return db, person, user, PayrollMonthCloseService(db)


def approve(service, person, user, month=8):
    status = service.get_status(year=2026, month=month, current_user=user)
    worker = next(item for item in status.person_approvals if item.person_id == person.id)
    assert not any(item.code.startswith(("schedule_", "opening_balance_", "previous_payroll")) for item in worker.blockers)
    return service.approve_person_month(year=2026, month=month, person_id=person.id, confirmed=True,
                                        acknowledged_blocker_count=worker.blocker_count, current_user=user)


def workbook_sheet(content):
    with ZipFile(BytesIO(content)) as workbook:
        return ET.fromstring(workbook.read("xl/worksheets/sheet1.xml"))


@pytest.mark.parametrize("known", [False, True])
def test_real_month_approval_without_day_setup_matches_excel_and_global_does_not_rebook(known):
    db, person, user, service = context(known=known, unclear=not known)
    approve(service, person, user)
    account_service = PayrollMonthAccountService(db)
    posting = db.scalar(select(Entry).where(Entry.entry_type == MONTHLY))
    assert posting.source_payload["totals"]["total_minutes"] == 170 * 60
    assert posting.source_payload["movement_minutes"] == 120
    assert posting.minutes_delta == 120
    assert account_service.current_balance(person.id) == (6120 if known else None)
    artifact = db.scalar(select(PayrollMonthPersonApprovalArtifact))
    original_bytes = bytes(artifact.content)
    sheet = workbook_sheet(original_bytes)
    assert float(cell_text(sheet, "D47")) * 1440 == pytest.approx(120)
    if not known:
        assert cell_text(sheet, "K50") == cell_text(sheet, "K51") == ""
    approve(service, person, user)  # Retry is not another booking or another version.
    before_ids = list(db.scalars(select(Entry.id).order_by(Entry.id)))
    result = service.lock_month(year=2026, month=8, confirmed=True, current_user=user)
    assert result.status == "LOCKED"
    assert list(db.scalars(select(Entry.id).order_by(Entry.id))) == before_ids
    worker_export = PayrollMonthExportService(db).worker_export(person_id=person.id, year=2026, month=8, current_user=user)
    assert worker_export == original_bytes
    snapshot = db.scalar(select(PayrollMonthSnapshot))
    row = db.scalar(select(PayrollMonthPersonSnapshot))
    assert row.movement_minutes == 120
    assert row.closing_balance_minutes == (6120 if known else None)
    assert snapshot.payload_json["schema_version"] == 2
    assert snapshot.payload_json["approved_person_sources"][0]["source_snapshot_sha256"]
    service.reopen_month(year=2026, month=8, reason="Correction", current_user=user)
    assert account_service.current_balance(person.id) == (6000 if known else None)
    assert bytes(artifact.content) == original_bytes
    approve(service, person, user)
    result = service.lock_month(year=2026, month=8, confirmed=True, current_user=user)
    assert result.snapshot_version == 2
    assert account_service.current_balance(person.id) == (6120 if known else None)


def test_manual_after_approval_never_updates_locked_history_or_retained_workbook():
    db, person, user, service = context()
    approve(service, person, user)
    original_rows = [(row.id, row.minutes_delta, row.balance_after_minutes) for row in db.scalars(select(Entry))]
    artifact = db.scalar(select(PayrollMonthPersonApprovalArtifact))
    retained = bytes(artifact.content)
    db.execute(text("""CREATE TRIGGER reject_locked_account_update BEFORE UPDATE ON person_hours_account_entries
      WHEN OLD.effective_date >= '2026-08-01' AND OLD.effective_date <= '2026-08-31'
       AND EXISTS (SELECT 1 FROM payroll_month_person_approvals WHERE person_id = OLD.person_id
                   AND year = 2026 AND month = 8 AND status = 'APPROVED')
      BEGIN SELECT RAISE(ABORT, 'payroll_person_month_locked'); END"""))
    account = PersonHoursAccountService(db).create_manual_adjustment(
        person_id=person.id, hours_delta=2, effective_date=date(2026, 9, 5), note="Independent", current_user=user)
    assert account.current_balance_minutes == 6240
    assert [(db.get(Entry, identifier).id, db.get(Entry, identifier).minutes_delta,
             db.get(Entry, identifier).balance_after_minutes) for identifier, _, _ in original_rows] == original_rows
    assert bytes(artifact.content) == retained
    service.reopen_person_month(year=2026, month=8, person_id=person.id, reason="Correction", current_user=user)
    assert PayrollMonthAccountService(db).current_balance(person.id) == 6120


def test_export_failure_rolls_back_transition_month_posting_and_approval(monkeypatch):
    db, person, user, service = context()
    def fail(*args, **kwargs):
        raise ValueError("Deliberate export failure")
    monkeypatch.setattr(PayrollMonthExportService, "build_worker_export_from_source", fail)
    with pytest.raises(ValueError, match="Deliberate export"):
        approve(service, person, user)
    assert PayrollMonthAccountService(db).transition(person.id) is None
    assert db.scalar(select(Entry).where(Entry.entry_type == MONTHLY)) is None
    assert db.scalar(select(PayrollMonthPersonApprovalArtifact)) is None
    assert PersonHoursAccountService(db).get_account(person_id=person.id).current_balance_minutes == 6000


def test_later_personal_approval_protects_frozen_balances_from_earlier_reopen():
    db, person, user, service = context()
    approve(service, person, user)
    approve(service, person, user, month=9)
    before = list(db.scalars(select(Entry.id)))
    with pytest.raises(HTTPException, match="Spätere Monteurmonate"):
        service.reopen_person_month(year=2026, month=8, person_id=person.id, reason="Too early", current_user=user)
    assert list(db.scalars(select(Entry.id))) == before
    status = service.get_status(year=2026, month=8, current_user=user)
    assert not status.person_approvals[0].can_reopen


def test_missing_contract_keeps_standard_export_and_nullable_month_snapshot():
    db, person, user, service = context(weekly_hours=None)
    approve(service, person, user)
    artifact = db.scalar(select(PayrollMonthPersonApprovalArtifact))
    sheet = workbook_sheet(artifact.content)
    assert cell_text(sheet, "D47") == "–"
    assert cell_text(sheet, "K51") == ""
    service.lock_month(year=2026, month=8, confirmed=True, current_user=user)
    row = db.scalar(select(PayrollMonthPersonSnapshot))
    assert row.movement_minutes is None and row.closing_balance_minutes is None
    assert PersonHoursAccountService(db).get_account(person_id=person.id).notices


def test_historical_daily_person_approval_global_close_and_reopen_do_not_infer_new_posting():
    db, person, user, service = context()
    reference = "historical-person-month:2026-08:v1"
    old_daily = Entry(person_id=person.id, entry_type="daily_balance", ledger_system="daily",
                      effective_date=date(2026, 8, 3), minutes_delta=300, balance_after_minutes=6300,
                      note="Old personal day booking", source_type="payroll_person_month_close",
                      source_reference_id=reference, is_active=True)
    approval = PayrollMonthPersonApproval(person_id=person.id, year=2026, month=8,
                                          status="APPROVED", approval_version=1, ledger_reference_id=reference)
    db.add_all([old_daily, approval])
    db.flush()
    export = PayrollMonthExportService(db)
    source = export.load_live_source(year=2026, month=8, current_user=user)
    content = export.build_worker_export_from_source(source=source, person_id=person.id,
                                                     opening_balance_minutes=6000, closing_balance_minutes=6300)
    artifact = PayrollMonthPersonApprovalArtifact(approval_id=approval.id, person_id=person.id, year=2026, month=8,
                                                  approval_version=1, ledger_reference_id=reference,
                                                  filename="historical.xlsx", content=content, byte_size=len(content),
                                                  content_sha256=hashlib.sha256(content).hexdigest(),
                                                  media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    db.add(artifact)
    db.commit()
    PersonHoursAccountService(db).create_manual_adjustment(person_id=person.id, hours_delta=1,
                                                          effective_date=date(2026, 9, 5), note="Independent", current_user=user)
    service.lock_month(year=2026, month=8, confirmed=True, current_user=user)
    assert db.scalar(select(Entry).where(Entry.entry_type == MONTHLY)) is None
    assert export.worker_export(person_id=person.id, year=2026, month=8, current_user=user) == content
    assert PayrollMonthAccountService(db).current_balance(person.id) == 6360
    service.reopen_month(year=2026, month=8, reason="Correct old approval", current_user=user)
    assert not old_daily.is_active
    assert PayrollMonthAccountService(db).current_balance(person.id) == 6060
    approve(service, person, user)
    assert PayrollMonthAccountService(db).current_balance(person.id) == 6180
    assert artifact.content == content


def test_reopening_historical_daily_approval_captures_current_balance_before_any_recalculation():
    db, person, user, service = context()
    previous = Entry(person_id=person.id, entry_type="daily_balance", ledger_system="daily",
                      effective_date=date(2026, 8, 3), minutes_delta=100, balance_after_minutes=999,
                      note="Historical recorded balance must remain exact", is_active=True)
    current = Entry(person_id=person.id, entry_type="daily_balance", ledger_system="daily",
                     effective_date=date(2026, 9, 3), minutes_delta=300, balance_after_minutes=6400,
                     note="Old September approval", source_type="payroll_person_month_close",
                     source_reference_id="old-september", is_active=True)
    db.add_all([previous, current, PayrollMonthPeriod(year=2026, month=8, status="LOCKED"),
                PayrollMonthPersonApproval(person_id=person.id, year=2026, month=9, status="APPROVED",
                                           approval_version=1, ledger_reference_id="old-september")])
    db.commit()
    db.execute(text("""CREATE TRIGGER preserve_august_history BEFORE UPDATE ON person_hours_account_entries
      WHEN OLD.effective_date >= '2026-08-01' AND OLD.effective_date <= '2026-08-31'
      BEGIN SELECT RAISE(ABORT, 'locked August history'); END"""))
    service.reopen_person_month(year=2026, month=9, person_id=person.id, reason="Old approval correction", current_user=user)
    assert previous.balance_after_minutes == 999 and previous.is_active
    assert not current.is_active
    monthly = PayrollMonthAccountService(db)
    assert monthly.transition(person.id).balance_after_minutes == 6400
    assert monthly.current_balance(person.id) == 6100
