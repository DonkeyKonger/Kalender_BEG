from datetime import date, time
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.models.enums import UserRole
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
