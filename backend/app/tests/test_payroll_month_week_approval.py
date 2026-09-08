from datetime import date, datetime, time, timezone
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
    monkeypatch.setattr(month_module, "_review_today", lambda: date(2027, 2, 1))
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
        "payroll_week_not_reviewed",
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
    assert [item.code for item in after.blockers] == ["payroll_week_not_reviewed"] * 3 + ["payroll_last_weekday_entry_missing"]
    assert after.person_approvals[0].blockers == after.blockers
    assert after.person_approvals[0].blocker_count == 4
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
        "payroll_week_not_reviewed",
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
        "payroll_week_not_reviewed",
        "unresolved_gps_time_entry", "travel_missing_overnight_status",
    }


def test_range_hint_needs_every_affected_week_reviewed():
    blocker = PayrollMonthBlocker(
        code="future_subcheck", message="Across weeks", person_id=1,
        work_date=date(2026, 8, 23), work_date_end=date(2026, 8, 24),
    )
    covered = PayrollMonthCloseService._covered_by_reviews
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
    last_day = case.add_day(date(2026, 8, 31))
    last_day.payroll_reviewed_at = datetime.now(timezone.utc)
    case.db.commit()
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
            acknowledged_blocker_count=3,
            acknowledged_blocker_fingerprint=(
                current.person_approvals[0].blocker_fingerprint
            ),
            current_user=case.admin,
        )
    assert caught.value.detail["code"] == "payroll_person_month_blockers_changed"
    assert caught.value.detail["expected_blocker_count"] == 0
    approved = case.service.approve_person_month(
        year=2026, month=8, person_id=case.worker.id, confirmed=True,
        acknowledged_blocker_count=0,
        acknowledged_blocker_fingerprint=current.person_approvals[0].blocker_fingerprint,
        current_user=case.admin,
    )
    assert approved.person_approvals[0].status == "APPROVED"
    assert approved.person_approvals[0].blocker_count == 0
    assert approved.can_lock


def test_individual_day_review_resolves_subchecks_and_reset_restores_them(review_case):
    case = review_case
    entry = case.add_day(date(2026, 8, 24))
    before = case.service.get_status(year=2026, month=8, current_user=case.admin)
    review_service = TimeEntryService(case.db)
    review_service.set_payroll_row_review(entry.id, reviewed=True, current_user=case.admin)
    after = case.service.get_status(year=2026, month=8, current_user=case.admin)
    # Monday's separate week reminder must survive the individual day review.
    assert {item.code for item in after.blockers if item.work_date == entry.work_date} == {
        "payroll_week_not_reviewed",
    }
    assert after.person_approvals[0].blockers == after.blockers
    assert after.person_approvals[0].blocker_count == len(after.blockers)
    assert entry.time_review_status == "open"
    assert list(case.db.scalars(select(PersonHoursAccountEntry))) == []
    review_service.set_payroll_row_review(entry.id, reviewed=False, current_user=case.admin)
    reopened = case.service.get_status(year=2026, month=8, current_user=case.admin)
    assert reopened.blockers == before.blockers


def test_day_review_requires_all_entries_and_does_not_cover_other_days_or_people(review_case):
    case = review_case
    first = case.add_day(date(2026, 9, 1))
    second = case.add_day(first.work_date)
    next_day = case.add_day(date(2026, 9, 2))
    review_service = TimeEntryService(case.db)
    review_service.set_payroll_row_review(first.id, reviewed=True, current_user=case.admin)
    partial = case.service.get_status(year=2026, month=9, current_user=case.admin)
    assert "open_time_or_gps_review" in {
        item.code for item in partial.blockers if item.work_date == first.work_date
    }
    review_service.set_payroll_row_review(second.id, reviewed=True, current_user=case.admin)
    complete = case.service.get_status(year=2026, month=9, current_user=case.admin)
    assert not [item for item in complete.blockers if item.work_date == first.work_date]
    assert [item for item in complete.blockers if item.work_date == next_day.work_date]
    covered = PayrollMonthCloseService._covered_by_reviews
    assert not covered(PayrollMonthBlocker(
        code="open_time_or_gps_review", message="Other worker", person_id=999,
        work_date=first.work_date,
    ), set(), {(case.worker.id, first.work_date)})
    assert PayrollMonthCloseService._reviewed_day_keys([]) == set()


@pytest.mark.parametrize("work_date", [date(2026, 8, 1), date(2026, 8, 31), date(2027, 1, 1)])
def test_individual_review_covers_partial_month_and_iso_year_boundaries(review_case, work_date):
    case = review_case
    entry = case.add_day(work_date)
    TimeEntryService(case.db).set_payroll_row_review(entry.id, reviewed=True, current_user=case.admin)
    status = case.service.get_status(year=work_date.year, month=work_date.month, current_user=case.admin)
    assert not [item for item in status.blockers if item.work_date == work_date]


def test_range_hints_need_full_day_or_week_coverage_and_undated_errors_remain():
    covered = PayrollMonthCloseService._covered_by_reviews
    blocker = PayrollMonthBlocker(
        code="future_subcheck", message="Across weeks", person_id=1,
        work_date=date(2026, 8, 23), work_date_end=date(2026, 8, 24),
    )
    assert not covered(blocker, set(), {(1, date(2026, 8, 23))})
    assert covered(blocker, {(1, 2026, 35)}, {(1, date(2026, 8, 23))})
    assert covered(blocker, set(), {(1, date(2026, 8, 23)), (1, date(2026, 8, 24))})
    assert not covered(PayrollMonthBlocker(
        code="payroll_template_invalid", message="Template error", person_id=1,
    ), {(1, 2026, 35)}, {(1, date(2026, 8, 24))})


def test_person_month_approval_revalidates_individual_day_review_counts(review_case):
    case = review_case
    entry = case.add_day(date(2026, 8, 24))
    before = case.service.get_status(year=2026, month=8, current_user=case.admin)
    TimeEntryService(case.db).set_payroll_row_review(entry.id, reviewed=True, current_user=case.admin)
    after = case.service.get_status(year=2026, month=8, current_user=case.admin)
    assert len(after.blockers) < len(before.blockers)
    with pytest.raises(HTTPException) as caught:
        case.service.approve_person_month(
            year=2026, month=8, person_id=case.worker.id, confirmed=True,
            acknowledged_blocker_count=len(before.blockers),
            acknowledged_blocker_fingerprint=(
                before.person_approvals[0].blocker_fingerprint
            ),
            current_user=case.admin,
        )
    assert caught.value.detail["expected_blocker_count"] == len(after.blockers)
    approved = case.service.approve_person_month(
        year=2026, month=8, person_id=case.worker.id, confirmed=True,
        acknowledged_blocker_count=len(after.blockers),
        acknowledged_blocker_fingerprint=after.person_approvals[0].blocker_fingerprint,
        current_user=case.admin,
    )
    assert approved.person_approvals[0].status == "APPROVED"
    assert approved.person_approvals[0].blocker_count == 0


def review_reminders(status):
    return [item for item in status.blockers if item.code in {
        "payroll_week_not_reviewed", "open_time_or_gps_review",
    }]


@pytest.mark.parametrize(("today", "week_starts"), [
    (date(2026, 9, 7), []),   # Current and future weeks are not due.
    (date(2026, 9, 11), []),  # Friday does not end the calendar week.
    (date(2026, 9, 13), []),  # Sunday itself is still part of the week.
    (date(2026, 9, 14), [date(2026, 9, 7)]),
    (date(2026, 9, 21), [date(2026, 9, 7), date(2026, 9, 14)]),
    (date(2026, 10, 1), [date(2026, 9, 7), date(2026, 9, 14), date(2026, 9, 21)]),
])
def test_full_weeks_have_only_one_review_reminder_after_sunday(review_case, monkeypatch, today, week_starts):
    case = review_case
    for day in (7, 8, 9, 10, 11):
        case.add_day(date(2026, 9, day))
    monkeypatch.setattr(month_module, "_review_today", lambda: today)
    status = case.service.get_status(year=2026, month=9, current_user=case.admin)
    assert [(item.code, item.work_date) for item in review_reminders(status)] == [
        ("payroll_week_not_reviewed", monday) for monday in week_starts
    ]
    assert status.person_approvals[0].blocker_count == len(status.blockers)
    # Concrete data problems are not missing-review reminders.
    assert {item.code for item in status.blockers} >= {
        "unresolved_gps_time_entry", "travel_missing_overnight_status",
    }


@pytest.mark.parametrize(("work_date", "today", "expected"), [
    (date(2026, 9, 1), date(2026, 8, 31), False),
    (date(2026, 9, 1), date(2026, 9, 1), False),
    (date(2026, 9, 1), date(2026, 9, 2), True),
    (date(2026, 9, 30), date(2026, 9, 29), False),
    (date(2026, 9, 30), date(2026, 9, 30), False),
    (date(2026, 9, 30), date(2026, 10, 1), True),
    (date(2027, 1, 1), date(2027, 1, 1), False),
    (date(2027, 1, 1), date(2027, 1, 2), True),
    (date(2026, 8, 1), date(2026, 8, 2), True),  # Weekend boundary day.
])
def test_boundary_day_review_is_due_from_following_day(review_case, monkeypatch, work_date, today, expected):
    case = review_case
    case.add_day(work_date)
    monkeypatch.setattr(month_module, "_review_today", lambda: today)
    status = case.service.get_status(year=work_date.year, month=work_date.month, current_user=case.admin)
    assert [item.work_date for item in review_reminders(status)
            if item.code == "open_time_or_gps_review"] == ([work_date] if expected else [])
    monday = work_date.fromordinal(work_date.toordinal() - work_date.weekday())
    assert not [item for item in review_reminders(status)
                if item.code == "payroll_week_not_reviewed" and item.work_date == monday]


def test_newly_due_week_invalidates_stale_month_confirmation(review_case, monkeypatch):
    case = review_case
    monkeypatch.setattr(month_module, "_review_today", lambda: date(2026, 9, 13))
    before = case.service.get_status(year=2026, month=9, current_user=case.admin)
    monkeypatch.setattr(month_module, "_review_today", lambda: date(2026, 9, 14))
    after = case.service.get_status(year=2026, month=9, current_user=case.admin)
    old = before.person_approvals[0]
    new = after.person_approvals[0]
    assert new.blocker_count == old.blocker_count + 1
    assert new.blocker_fingerprint != old.blocker_fingerprint
    with pytest.raises(HTTPException) as caught:
        case.service.approve_person_month(
            year=2026, month=9, person_id=case.worker.id, confirmed=True,
            acknowledged_blocker_count=old.blocker_count,
            acknowledged_blocker_fingerprint=old.blocker_fingerprint,
            current_user=case.admin,
        )
    assert caught.value.detail["code"] == "payroll_person_month_blockers_changed"
    assert caught.value.detail["expected_blocker_count"] == new.blocker_count


@pytest.mark.parametrize("instant", [
    datetime(2026, 9, 13, 22, 1, tzinfo=timezone.utc),
    datetime(2027, 1, 3, 23, 1, tzinfo=timezone.utc),
])
def test_review_clock_uses_berlin_date_after_local_midnight(monkeypatch, instant):
    class FixedDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            return instant.astimezone(tz)

    monkeypatch.setattr(month_module, "datetime", FixedDateTime)
    assert month_module._review_today() == date.fromordinal(instant.date().toordinal() + 1)


def test_empty_current_month_stays_open_until_last_weekday_has_entry(review_case, monkeypatch):
    case = review_case
    monkeypatch.setattr(month_module, "_review_today", lambda: date(2026, 9, 8))
    before = case.service.get_status(year=2026, month=9, current_user=case.admin)
    assert [item.code for item in before.blockers] == ["payroll_last_weekday_entry_missing"]
    approval = before.person_approvals[0]
    assert approval.status == "OPEN"
    assert approval.blocker_count == 1
    assert approval.blockers == before.blockers
    assert not approval.export_ready
    # A reviewed week alone must not make an empty month appear ready.
    case.review(2026, 40)
    assert case.service.get_status(year=2026, month=9, current_user=case.admin).blockers == before.blockers
    last_day = case.add_day(date(2026, 9, 30))
    last_day.payroll_reviewed_at = datetime.now(timezone.utc)
    case.db.commit()
    after = case.service.get_status(year=2026, month=9, current_user=case.admin)
    assert after.blockers == []
    assert after.person_approvals[0].status == "OPEN"
    assert after.person_approvals[0].blocker_fingerprint != approval.blocker_fingerprint
    case.db.delete(last_day)
    case.db.commit()
    case_entries = case.service.get_status(year=2026, month=9, current_user=case.admin)
    assert "payroll_last_weekday_entry_missing" in {item.code for item in case_entries.blockers}
