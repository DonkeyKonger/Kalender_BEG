"""Business invariants for the accepted-balance / 100-hour monthly transition."""
from copy import deepcopy
from datetime import date, time

import pytest
from sqlalchemy import select

from app.models.person_hours_account import PersonHoursAccountEntry as Entry
from app.models.payroll_month import PayrollMonthPersonApprovalArtifact
from app.models.work_time_entry import WorkTimeEntry
from app.services.payroll_month_account_service import ACCOUNT_POLICY, MONTHLY, PayrollMonthAccountService
from app.services.payroll_month_export_service import PayrollMonthExportService
from app.services.person_hours_account_service import PersonHoursAccountService
from app.tests.test_payroll_daily_ledger_service import db_session, configured_worker
from app.tests.test_payroll_month_account_integration import context, approve, workbook_sheet, cell_text
from app.tests.test_payroll_month_account_service import post


@pytest.mark.parametrize("balance,delta,credit,payout,closing", [
    (5400, 489, 489, 0, 5889),
    (5820, 489, 180, 309, 6000),
    (6000, 489, 0, 489, 6000),
    (5999, 2, 1, 1, 6000),
    (5999, 1, 1, 0, 6000),
    (0, 6000, 6000, 0, 6000),
    (0, 6001, 6000, 1, 6000),
    (-60, 6061, 6060, 1, 6000),
    (6000, -489, -489, 0, 5511),
    (100, -489, -489, 0, -389),
    (6000, 0, 0, 0, 6000),
    (6300, 489, 0, 489, 6300),  # Accepted/manual excess is not confiscated.
    (6300, -60, -60, 0, 6240),
])
def test_exact_minute_split_and_reversal(balance, delta, credit, payout, closing):
    db = db_session()
    person, _, _ = configured_worker(db, [480] * 5 + [0, 0], opening_minutes=balance)
    service = PayrollMonthAccountService(db)
    row = post(service, person, delta=delta)
    assert row.minutes_delta == credit
    assert row.source_payload['account_policy'] == ACCOUNT_POLICY
    assert row.source_payload['payout_minutes'] == payout
    assert row.source_payload['payout_surcharge_percent'] == 25
    assert row.source_payload['movement_minutes'] == credit + payout
    assert row.balance_after_minutes == closing
    assert service.current_balance(person.id) == closing
    assert post(service, person, delta=delta).id == row.id
    service.reverse(row.source_reference_id, user_id=None)
    service.reverse(row.source_reference_id, user_id=None)
    assert service.current_balance(person.id) == balance
    fresh = post(service, person, delta=delta, version=2)
    assert fresh.minutes_delta == credit and fresh.source_payload['payout_minutes'] == payout
    assert service.current_balance(person.id) == closing


@pytest.mark.parametrize('reason', [
    'Altbuchung KW 31/2026 über Monatsgrenze: Zuordnung offen.',
    'Alte Wochenbuchung ohne belastbare KW; Monatszuordnung offen.',
    'Alte Tagesbuchung ohne belastbares Datum; Monatszuordnung offen.',
])
def test_previously_pending_legacy_month_no_longer_hides_accepted_balance(reason):
    db = db_session()
    person, _, _ = configured_worker(db, [480] * 5 + [0, 0], opening_minutes=6000)
    service = PayrollMonthAccountService(db)
    transition = service.capture(person.id, None)
    # Persisted row in the exact shape of an old pending August approval.
    old = Entry(person_id=person.id, entry_type=MONTHLY, ledger_system='daily',
                effective_date=date(2026,8,31), minutes_delta=0, balance_after_minutes=None,
                note='Old unresolved month', is_active=True, source_type='payroll_month_close',
                source_reference_id='old-august', idempotency_key='monthly:old-august',
                source_payload={'pending_reason':reason, 'movement_minutes':489,
                                'transition_entry_id':transition.id})
    db.add(old)
    db.flush()
    retained = deepcopy(old.source_payload)
    assert PersonHoursAccountService(db).get_account(person_id=person.id).current_balance_minutes == 6000
    assert not service.notices(person.id)
    september = post(service, person, delta=489, month=9)
    assert september.source_payload['payout_minutes'] == 489
    assert september.source_payload['overridden_legacy_conflict_ids'] == [old.id]
    assert service.current_balance(person.id) == 6000
    assert old.source_payload == retained and old.balance_after_minutes is None


def test_september_manual_correction_is_excluded_from_reclosed_august_and_used_in_september():
    db = db_session()
    person, user, _ = configured_worker(db, [480] * 5 + [0, 0], opening_minutes=5820)
    service = PayrollMonthAccountService(db)
    august = post(service, person, delta=489)
    PersonHoursAccountService(db).create_manual_adjustment(
        person_id=person.id, hours_delta=-5, effective_date=date(2026,9,4),
        note='Einmalige Septemberkorrektur', current_user=user)
    service.reverse(august.source_reference_id, user_id=user.id)
    repeated = post(service, person, delta=489, version=2)
    assert repeated.source_payload['opening_balance_minutes'] == 5820
    assert repeated.source_payload['closing_balance_minutes'] == 6000
    assert repeated.source_payload['payout_minutes'] == 309
    assert service.current_balance(person.id) == 5700
    september = post(service, person, delta=489, month=9)
    assert september.source_payload['opening_balance_minutes'] == 5700
    assert september.minutes_delta == 300
    assert september.source_payload['payout_minutes'] == 189
    assert service.current_balance(person.id) == 6000


@pytest.mark.parametrize('opening,credit,payout,closing', [
    (5400,489,0,5889), (5820,180,309,6000), (6000,0,489,6000),
])
def test_real_48_hour_month_exports_only_surplus_and_preserves_approved_workbook(opening,credit,payout,closing):
    db, person, user, service = context()
    person.weekly_hours = 48
    initial = db.scalar(select(Entry))
    initial.minutes_delta = initial.balance_after_minutes = opening
    entries = list(db.scalars(select(WorkTimeEntry).order_by(WorkTimeEntry.work_date)))
    for entry in entries:
        entry.work_minutes = 600
        entry.end_time = time(17)
    entries[0].work_minutes = 585
    entries[0].end_time = time(16,45)
    db.commit()
    approve(service,person,user)
    posting = db.scalar(select(Entry).where(Entry.entry_type == MONTHLY))
    assert posting.source_payload['movement_minutes'] == 489
    assert posting.minutes_delta == credit
    assert posting.source_payload['payout_minutes'] == payout
    assert posting.balance_after_minutes == closing
    assert '25 % Zuschlag' in posting.note and 'keine Kontobuchung' in posting.note
    artifact = db.scalar(select(PayrollMonthPersonApprovalArtifact))
    content = bytes(artifact.content)
    sheet = workbook_sheet(content)
    assert float(cell_text(sheet,'E41')) * 1440 == pytest.approx(12585)
    assert float(cell_text(sheet,'D46')) * 1440 == pytest.approx(12096)
    assert float(cell_text(sheet,'D47')) * 1440 == pytest.approx(payout)
    assert float(cell_text(sheet,'K50')) * 1440 == pytest.approx(opening)
    assert float(cell_text(sheet,'K51')) * 1440 == pytest.approx(closing)
    assert all(cell_text(sheet, f'I{row}') == '' for row in range(46, 50))
    combined = PayrollMonthExportService(db).all_workers_export(year=2026,month=8,current_user=user)
    assert cell_text(workbook_sheet(combined),'D47') == cell_text(sheet,'D47')
    before_ids = list(db.scalars(select(Entry.id)))
    approve(service,person,user)
    assert list(db.scalars(select(Entry.id))) == before_ids
    service.reopen_person_month(year=2026,month=8,person_id=person.id,reason='Test',current_user=user)
    assert PayrollMonthAccountService(db).current_balance(person.id) == opening
    assert bytes(artifact.content) == content
    approve(service,person,user)
    fresh = db.scalar(select(PayrollMonthPersonApprovalArtifact).order_by(PayrollMonthPersonApprovalArtifact.id.desc()))
    assert float(cell_text(workbook_sheet(fresh.content),'D47')) * 1440 == pytest.approx(payout)


def test_negative_month_debits_account_but_never_exports_negative_paid_overtime():
    db, person, user, service = context()
    person.weekly_hours = 48  # 170h work minus 201:36 target = -31:36.
    db.commit()
    approve(service,person,user)
    posting = db.scalar(select(Entry).where(Entry.entry_type == MONTHLY))
    assert posting.minutes_delta == -1896
    artifact = db.scalar(select(PayrollMonthPersonApprovalArtifact))
    sheet = workbook_sheet(artifact.content)
    assert float(cell_text(sheet,'D47')) == 0
    assert all(cell_text(sheet, f'I{row}') == '' for row in range(46, 50))
    assert float(cell_text(sheet,'K51')) * 1440 == pytest.approx(4104)
