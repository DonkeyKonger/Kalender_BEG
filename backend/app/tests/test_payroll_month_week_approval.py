from datetime import date, time
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.models.enums import PersonType
from app.models.person import Person
from app.models.person_hours_account import PersonHoursAccountEntry
from app.models.work_time_entry import WorkTimeEntry
from app.schemas.payroll_month import PayrollMonthBlocker
from app.services import payroll_month_close_service as month_module
from app.services.gps_service import GpsPresenceService
from app.services.payroll_month_close_service import PayrollMonthCloseService
from app.services.payroll_month_export_service import PayrollMonthExportService
from app.services.payroll_xlsx_template import PayrollXlsxTemplateError
from app.services.time_entry_service import TimeEntryService
from app.tests.test_payroll_month_close_service import database, payroll_users


@pytest.fixture
def review_case(monkeypatch):
    db = database()
    admin, worker = payroll_users(db)
    entries = []

    def add_day(work_date):
        entry = WorkTimeEntry(
            person_id=worker.id, work_date=work_date, start_time=time(8), end_time=time(16),
            work_minutes=480, break_minutes=0, time_review_status="open",
        )
        db.add(entry)
        db.commit()
        entries.append(entry)
        return entry

    # Deliberately unclear automatic diagnostics and unmatched GPS stays. Real
    # month plans also produce missing-overnight warnings for these workdays.
    monkeypatch.setattr(GpsPresenceService, "evaluate_time_entries", lambda _self, values: {
        entry.id: SimpleNamespace(
            work_minutes=None, has_source_mismatch=True, review_notices=("nicht prüfbar",),
        ) for entry in values
    })
    monkeypatch.setattr(GpsPresenceService, "list_site_stays_for_review", lambda _self, **kw: [
        SimpleNamespace(person_id=entry.person_id, work_date=entry.work_date, site_id=999)
        for entry in entries if kw["date_from"] <= entry.work_date <= kw["date_to"]
    ])

    def review(iso_year, iso_week, reset=False):
        service = TimeEntryService(db)
        action = service.reset_weekly_review if reset else service.mark_weekly_review
        return action(
            person_id=worker.id, iso_year=iso_year, iso_week=iso_week, current_user=admin,
        )

    yield SimpleNamespace(
        db=db, admin=admin, worker=worker, add_day=add_day, review=review,
        service=PayrollMonthCloseService(db),
    )
    db.close()


def test_reviewed_week_resolves_all_month_subchecks_without_rewriting_diagnostics(review_case):
    case = review_case
    entry = case.add_day(date(2026, 8, 24))
    before = case.service.get_status(year=2026, month=8, current_user=case.admin)
    assert {item.code for item in before.blockers if item.work_date == entry.work_date} == {
        "payroll_week_not_reviewed", "open_time_or_gps_review",
        "unresolved_gps_time_entry", "travel_missing_overnight_status",
    }
    source_before = PayrollMonthExportService.source_manifest(
        PayrollMonthExportService(case.db).load_live_source(
            year=2026, month=8, current_user=case.admin,
        )
    )
    case.review(2026, 35)
    after = case.service.get_status(year=2026, month=8, current_user=case.admin)
    assert not [item for item in after.blockers if item.work_date == entry.work_date]
    # Other weeks are not silently approved; global and person counts agree.
    assert [item.code for item in after.blockers] == ["payroll_week_not_reviewed"] * 3
    assert after.person_approvals[0].blockers == after.blockers
    assert after.person_approvals[0].blocker_count == 3
    assert PayrollMonthExportService.source_manifest(
        PayrollMonthExportService(case.db).load_live_source(
            year=2026, month=8, current_user=case.admin,
        )
    ) == source_before
    assert entry.time_review_status == "open"
    assert entry.payroll_reviewed_at is None
    assert list(case.db.scalars(select(PersonHoursAccountEntry))) == []
    # The existing reset action restores exactly the previous rules and hints.
    case.review(2026, 35, reset=True)
    reopened = case.service.get_status(year=2026, month=8, current_user=case.admin)
    assert reopened.blockers == before.blockers


@pytest.mark.parametrize("work_date", [date(2026, 8, 1), date(2026, 8, 31), date(2027, 1, 1)])
def test_reviewed_partial_month_and_iso_year_boundary_weeks_resolve_subchecks(review_case, work_date):
    case = review_case
    case.add_day(work_date)
    iso_year, iso_week, _ = work_date.isocalendar()
    case.review(iso_year, iso_week)
    blockers = case.service.get_status(
        year=work_date.year, month=work_date.month, current_user=case.admin,
    ).blockers
    assert not [item for item in blockers if item.work_date == work_date]


def test_mixed_month_uses_actual_week_and_person_status(review_case):
    case = review_case
    case.add_day(date(2026, 8, 17))
    case.add_day(date(2026, 8, 24))
    # A review in the same week number of another year must not count.
    case.review(2025, 34)
    case.review(2026, 35)
    status = case.service.get_status(year=2026, month=8, current_user=case.admin)
    assert {item.code for item in status.blockers if item.work_date == date(2026, 8, 17)} == {
        "payroll_week_not_reviewed", "open_time_or_gps_review",
        "unresolved_gps_time_entry", "travel_missing_overnight_status",
    }
    assert not [item for item in status.blockers if item.work_date == date(2026, 8, 24)]
    other = Person(
        first_name="Other", last_name="Worker", display_name="Other Worker",
        person_type=PersonType.INTERNAL, is_active=True, weekly_hours=40, short_code="OW",
    )
    case.db.add(other)
    case.db.commit()
    other_entry = case.add_day(date(2026, 8, 24))
    other_entry.person_id = other.id
    case.db.commit()
    status = case.service.get_status(year=2026, month=8, current_user=case.admin)
    assert {item.code for item in status.blockers if item.person_id == other.id} >= {
        "payroll_week_not_reviewed", "open_time_or_gps_review",
        "unresolved_gps_time_entry", "travel_missing_overnight_status",
    }


def test_range_hint_needs_every_affected_week_reviewed():
    blocker = PayrollMonthBlocker(
        code="future_subcheck", message="Across weeks", person_id=1,
        work_date=date(2026, 8, 23), work_date_end=date(2026, 8, 24),
    )
    covered = PayrollMonthCloseService._covered_by_reviewed_weeks
    assert not covered(blocker, {(1, 2026, 35)})
    assert not covered(blocker, {(2, 2026, 34), (2, 2026, 35)})
    assert covered(blocker, {(1, 2026, 34), (1, 2026, 35)})


def test_day_validation_is_covered_but_month_template_failure_is_not(review_case, monkeypatch):
    case = review_case
    entry = case.add_day(date(2026, 8, 24))
    entry.end_time = None
    case.db.commit()
    assert "incomplete_work_interval" in {
        item.code for item in case.service.get_status(year=2026, month=8, current_user=case.admin).blockers
    }
    case.review(2026, 35)

    def invalid_template():
        raise PayrollXlsxTemplateError("Test: Vorlage fehlt")

    monkeypatch.setattr(month_module, "load_payroll_monthly_template", invalid_template)
    status = case.service.get_status(year=2026, month=8, current_user=case.admin)
    assert "incomplete_work_interval" not in {item.code for item in status.blockers}
    assert "payroll_template_invalid" in {item.code for item in status.blockers}
    assert status.person_approvals[0].has_blocking_technical_error


def test_person_approval_revalidates_the_same_week_aware_count(review_case):
    case = review_case
    case.add_day(date(2026, 8, 24))
    for week in (32, 33, 34, 35):
        case.review(2026, week)
    current = case.service.get_status(year=2026, month=8, current_user=case.admin)
    assert current.blockers == []
    assert current.person_approvals[0].blocker_count == 0
    # A stale client count must be rejected with the corrected count, not the
    # three automatic subdiagnostics. No approval/account mutation is retained.
    with pytest.raises(HTTPException) as caught:
        case.service.approve_person_month(
            year=2026, month=8, person_id=case.worker.id, confirmed=True,
            acknowledged_blocker_count=3, current_user=case.admin,
        )
    assert caught.value.detail["code"] == "payroll_person_month_blockers_changed"
    assert caught.value.detail["expected_blocker_count"] == 0
    approved = case.service.approve_person_month(
        year=2026, month=8, person_id=case.worker.id, confirmed=True,
        acknowledged_blocker_count=0, current_user=case.admin,
    )
    assert approved.person_approvals[0].status == "APPROVED"
    assert approved.person_approvals[0].blocker_count == 0
    assert approved.can_lock
