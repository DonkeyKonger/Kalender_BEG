from datetime import date, datetime, time
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.models.enums import UserRole
from app.models.time_entry_weekly_review import TimeEntryWeeklyReview
from app.services.time_entry_service import TimeEntryService


def service() -> TimeEntryService:
    item = TimeEntryService.__new__(TimeEntryService)
    item.db = SimpleNamespace()
    return item


def test_monteur_cannot_read_other_person_time_entries():
    current_user = SimpleNamespace(role=UserRole.MONTEUR, person_id=5)

    with pytest.raises(HTTPException) as error:
        service()._effective_person_id(current_user, 6)

    assert error.value.status_code == 403


def test_work_minutes_can_be_calculated_from_start_end_and_break():
    minutes = service()._resolve_work_minutes(
        start_time=time(8, 0),
        end_time=time(12, 0),
        break_minutes=30,
        work_minutes=None,
    )

    assert minutes == 210


def test_end_time_must_be_after_start_time():
    with pytest.raises(HTTPException) as error:
        service()._resolve_work_minutes(
            start_time=time(12, 0),
            end_time=time(8, 0),
            break_minutes=0,
            work_minutes=None,
        )

    assert error.value.status_code == 400


def test_time_ranges_overlap_detects_real_overlap():
    assert TimeEntryService._time_ranges_overlap(time(8, 0), time(12, 0), time(11, 0), time(14, 0)) is True
    assert TimeEntryService._time_ranges_overlap(time(8, 0), time(12, 0), time(12, 0), time(14, 0)) is False


def test_overlap_guard_returns_structured_conflict():
    existing_entry = SimpleNamespace(
        id=3,
        site_id=9,
        site=SimpleNamespace(site_number="1010", name="Firma BEG"),
        start_time=time(6, 0),
        end_time=time(15, 0),
    )
    item = TimeEntryService.__new__(TimeEntryService)
    item.db = SimpleNamespace(scalars=lambda statement: [existing_entry])

    with pytest.raises(HTTPException) as error:
        item._ensure_no_time_overlap(
            person_id=4,
            work_date=date(2026, 6, 4),
            start_time=time(11, 0),
            end_time=time(18, 0),
        )

    assert error.value.status_code == 409
    assert error.value.detail["code"] == "time_entry_overlap"
    assert error.value.detail["conflicts"][0]["site_label"] == "1010 - Firma BEG"


def test_approve_time_review_marks_entry_with_user_audit():
    entry = SimpleNamespace(
        id=1,
        status="draft",
        time_review_status="open",
        time_review_method=None,
        reviewed_by_user_id=None,
        reviewed_at=None,
    )
    commits: list[bool] = []
    item = TimeEntryService.__new__(TimeEntryService)
    item.db = SimpleNamespace(
        get=lambda model, entry_id: entry,
        commit=lambda: commits.append(True),
        refresh=lambda refreshed: None,
    )
    current_user = SimpleNamespace(id=7, role=UserRole.OFFICE)

    updated = item.approve_time_review(entry.id, current_user)

    assert updated.time_review_status == "manually_approved"
    assert updated.time_review_method == "manual_confirmed"
    assert updated.status == "reviewed"
    assert updated.reviewed_by_user_id == 7
    assert updated.reviewed_at is not None
    assert commits == [True]


def test_set_payroll_row_review_toggles_independent_row_check():
    entry = SimpleNamespace(
        id=1,
        person_id=4,
        payroll_reviewed_by_user_id=None,
        payroll_reviewed_at=None,
    )
    commits: list[bool] = []
    item = TimeEntryService.__new__(TimeEntryService)
    item.db = SimpleNamespace(
        get=lambda model, entry_id: entry,
        commit=lambda: commits.append(True),
        refresh=lambda refreshed: None,
    )
    current_user = SimpleNamespace(id=7, role=UserRole.OFFICE)

    checked = item.set_payroll_row_review(entry.id, reviewed=True, current_user=current_user)

    assert checked.payroll_reviewed_by_user_id == 7
    assert checked.payroll_reviewed_at is not None

    unchecked = item.set_payroll_row_review(entry.id, reviewed=False, current_user=current_user)

    assert unchecked.payroll_reviewed_by_user_id is None
    assert unchecked.payroll_reviewed_at is None
    assert commits == [True, True]


def test_set_payroll_time_correction_stores_office_checked_time():
    entry = SimpleNamespace(
        id=1,
        person_id=4,
        payroll_corrected_start_time=None,
        payroll_corrected_end_time=None,
        payroll_corrected_work_minutes=None,
    )
    commits: list[bool] = []
    item = TimeEntryService.__new__(TimeEntryService)
    item.db = SimpleNamespace(
        get=lambda model, entry_id: entry,
        commit=lambda: commits.append(True),
        refresh=lambda refreshed: None,
    )
    current_user = SimpleNamespace(id=7, role=UserRole.OFFICE)

    updated = item.set_payroll_time_correction(
        entry.id,
        start_time=time(7, 30),
        end_time=time(13, 0),
        work_minutes=330,
        current_user=current_user,
    )

    assert updated.payroll_corrected_start_time == time(7, 30)
    assert updated.payroll_corrected_end_time == time(13, 0)
    assert updated.payroll_corrected_work_minutes == 330
    assert commits == [True]


def test_delete_entry_removes_open_own_time_entry():
    entry = SimpleNamespace(
        id=1,
        person_id=4,
        status="submitted",
        time_review_status="open",
        reviewed_by_user_id=None,
        reviewed_at=None,
        payroll_reviewed_by_user_id=None,
        payroll_reviewed_at=None,
        payroll_corrected_start_time=None,
        payroll_corrected_end_time=None,
        payroll_corrected_work_minutes=None,
    )
    deleted: list[object] = []
    commits: list[bool] = []
    item = TimeEntryService.__new__(TimeEntryService)
    item.db = SimpleNamespace(
        get=lambda model, entry_id: entry,
        delete=lambda removed: deleted.append(removed),
        commit=lambda: commits.append(True),
    )
    current_user = SimpleNamespace(id=7, role=UserRole.MONTEUR, person_id=4)

    item.delete_entry(entry.id, current_user)

    assert deleted == [entry]
    assert commits == [True]


def test_delete_entry_blocks_reviewed_time_entry():
    entry = SimpleNamespace(
        id=1,
        person_id=4,
        status="reviewed",
        time_review_status="manually_approved",
        reviewed_by_user_id=7,
        reviewed_at=datetime(2026, 6, 1, 8, 0),
        payroll_reviewed_by_user_id=None,
        payroll_reviewed_at=None,
        payroll_corrected_start_time=None,
        payroll_corrected_end_time=None,
        payroll_corrected_work_minutes=None,
    )
    item = TimeEntryService.__new__(TimeEntryService)
    item.db = SimpleNamespace(
        get=lambda model, entry_id: entry,
        delete=lambda removed: pytest.fail("Reviewed entries must not be deleted."),
        commit=lambda: pytest.fail("Reviewed entries must not be committed."),
    )
    current_user = SimpleNamespace(id=7, role=UserRole.MONTEUR, person_id=4)

    with pytest.raises(HTTPException) as error:
        item.delete_entry(entry.id, current_user)

    assert error.value.status_code == 409


def test_mark_weekly_review_creates_person_week_status():
    added: list[TimeEntryWeeklyReview] = []
    commits: list[bool] = []
    item = TimeEntryService.__new__(TimeEntryService)
    item.db = SimpleNamespace(
        get=lambda model, model_id: SimpleNamespace(id=model_id),
        scalar=lambda statement: None,
        add=lambda review: added.append(review),
        commit=lambda: commits.append(True),
        refresh=lambda refreshed: setattr(refreshed, "id", 12),
    )
    current_user = SimpleNamespace(id=7, role=UserRole.OFFICE)

    review = item.mark_weekly_review(person_id=4, iso_year=2026, iso_week=24, current_user=current_user)

    assert review.id == 12
    assert review.person_id == 4
    assert review.iso_year == 2026
    assert review.iso_week == 24
    assert review.reviewed_by_user_id == 7
    assert review.reviewed_at is not None
    assert added == [review]
    assert commits == [True]


def test_mark_weekly_review_updates_existing_person_week_status():
    existing = TimeEntryWeeklyReview(
        person_id=4,
        iso_year=2026,
        iso_week=24,
        reviewed_by_user_id=1,
        reviewed_at=datetime(2026, 6, 1, 8, 0),
    )
    commits: list[bool] = []
    item = TimeEntryService.__new__(TimeEntryService)
    item.db = SimpleNamespace(
        get=lambda model, model_id: SimpleNamespace(id=model_id),
        scalar=lambda statement: existing,
        add=lambda review: pytest.fail("Existing weekly review should be reused."),
        commit=lambda: commits.append(True),
        refresh=lambda refreshed: None,
    )
    current_user = SimpleNamespace(id=8, role=UserRole.PROJECT_MANAGER)

    review = item.mark_weekly_review(person_id=4, iso_year=2026, iso_week=24, current_user=current_user)

    assert review is existing
    assert review.reviewed_by_user_id == 8
    assert review.reviewed_at is not None
    assert commits == [True]


def test_monteur_cannot_mark_weekly_review():
    current_user = SimpleNamespace(id=9, role=UserRole.MONTEUR)

    with pytest.raises(HTTPException) as error:
        service().mark_weekly_review(person_id=4, iso_year=2026, iso_week=24, current_user=current_user)

    assert error.value.status_code == 403


def test_correct_time_review_preserves_original_and_marks_reviewed():
    entry = SimpleNamespace(
        id=1,
        person_id=4,
        work_minutes=480,
        original_work_minutes=None,
        corrected_work_minutes=None,
        status="draft",
        time_review_status="open",
        time_review_method=None,
        reviewed_by_user_id=None,
        reviewed_at=None,
    )
    item = TimeEntryService.__new__(TimeEntryService)
    item.db = SimpleNamespace(
        get=lambda model, entry_id: entry,
        commit=lambda: None,
        refresh=lambda refreshed: None,
    )
    current_user = SimpleNamespace(id=8, role=UserRole.PROJECT_MANAGER)

    updated = item.correct_time_review(entry.id, 450, current_user)

    assert updated.original_work_minutes == 480
    assert updated.corrected_work_minutes == 450
    assert updated.work_minutes == 450
    assert updated.time_review_status == "corrected"
    assert updated.time_review_method == "manual_correction"
    assert updated.status == "reviewed"
    assert updated.reviewed_by_user_id == 8


def test_review_decision_accept_gps_preserves_original_and_sets_final_minutes():
    entry = SimpleNamespace(
        id=1,
        person_id=4,
        work_minutes=480,
        original_work_minutes=None,
        corrected_work_minutes=None,
        status="draft",
        time_review_status="open",
        time_review_method=None,
        reviewed_by_user_id=None,
        reviewed_at=None,
    )
    item = TimeEntryService.__new__(TimeEntryService)
    item.db = SimpleNamespace(
        get=lambda model, entry_id: entry,
        commit=lambda: None,
        refresh=lambda refreshed: None,
    )
    current_user = SimpleNamespace(id=9, role=UserRole.OFFICE)

    updated = item.apply_time_review_decision(
        entry.id,
        decision="accept_gps",
        final_work_minutes=420,
        current_user=current_user,
    )

    assert updated.original_work_minutes == 480
    assert updated.corrected_work_minutes == 420
    assert updated.work_minutes == 420
    assert updated.time_review_status == "corrected"
    assert updated.time_review_method == "accept_gps"
    assert updated.status == "reviewed"
    assert updated.reviewed_by_user_id == 9


def test_deadline_auto_closes_previous_month_open_review_case():
    entry = SimpleNamespace(
        id=1,
        work_date=date(2026, 6, 30),
        work_minutes=480,
        status="draft",
        time_review_status="open",
        time_review_method=None,
        reviewed_by_user_id=99,
        reviewed_at=None,
    )
    commits: list[bool] = []
    item = TimeEntryService.__new__(TimeEntryService)
    item.db = SimpleNamespace(commit=lambda: commits.append(True))

    changed = item.auto_close_deadline_reviews([entry], {entry.id: None}, today=date(2026, 7, 5))

    assert changed is True
    assert entry.time_review_status == "auto_closed_by_deadline"
    assert entry.time_review_method == "deadline"
    assert entry.status == "reviewed"
    assert entry.reviewed_by_user_id is None
    assert entry.reviewed_at is not None
    assert commits == [True]


def test_deadline_does_not_close_current_month_review_case():
    entry = SimpleNamespace(
        id=1,
        work_date=date(2026, 7, 1),
        work_minutes=480,
        status="draft",
        time_review_status="open",
        time_review_method=None,
        reviewed_by_user_id=None,
        reviewed_at=None,
    )
    item = TimeEntryService.__new__(TimeEntryService)
    item.db = SimpleNamespace(commit=lambda: None)

    changed = item.auto_close_deadline_reviews([entry], {entry.id: None}, today=date(2026, 7, 5))

    assert changed is False
    assert entry.time_review_status == "open"


def test_project_mounting_times_exclude_unreviewed_manual_entry():
    entry = SimpleNamespace(
        work_minutes=480,
        corrected_work_minutes=None,
        time_review_status="open",
        time_review_method=None,
    )

    assert TimeEntryService.is_project_mounting_time_relevant(entry, None) is False


def test_project_mounting_times_include_manually_approved_entry():
    entry = SimpleNamespace(
        work_minutes=480,
        corrected_work_minutes=None,
        time_review_status="manually_approved",
        time_review_method="manual_confirmed",
    )

    assert TimeEntryService.is_project_mounting_time_relevant(entry, None) is True


def test_project_mounting_times_include_corrected_entry():
    entry = SimpleNamespace(
        work_minutes=450,
        corrected_work_minutes=450,
        time_review_status="corrected",
        time_review_method="manual_correction",
    )

    assert TimeEntryService.is_project_mounting_time_relevant(entry, None) is True


def test_project_mounting_times_include_accepted_gps_entry():
    entry = SimpleNamespace(
        work_minutes=420,
        corrected_work_minutes=420,
        time_review_status="corrected",
        time_review_method="accept_gps",
    )

    assert TimeEntryService.is_project_mounting_time_relevant(entry, None) is True


def test_project_mounting_times_include_auto_plausible_entry():
    entry = SimpleNamespace(
        work_minutes=480,
        corrected_work_minutes=None,
        time_review_status="open",
        time_review_method=None,
    )
    gps_evaluation = SimpleNamespace(work_minutes=470, review_notices=())

    assert TimeEntryService.is_project_mounting_time_relevant(entry, gps_evaluation) is True


def test_project_mounting_times_exclude_gps_conflict_and_not_verifiable_entries():
    conflicting_entry = SimpleNamespace(
        work_minutes=480,
        corrected_work_minutes=None,
        time_review_status="open",
        time_review_method=None,
    )
    gps_evaluation = SimpleNamespace(work_minutes=480, review_notices=("GPS weicht von Planungsmatrix ab",))
    not_verifiable_entry = SimpleNamespace(
        work_minutes=480,
        corrected_work_minutes=None,
        time_review_status="not_verifiable",
        time_review_method="mark_not_verifiable",
    )

    assert TimeEntryService.is_project_mounting_time_relevant(conflicting_entry, gps_evaluation) is False
    assert TimeEntryService.is_project_mounting_time_relevant(not_verifiable_entry, None) is False
