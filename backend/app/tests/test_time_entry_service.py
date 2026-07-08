from datetime import date, datetime, time, timedelta
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.models import Base
from app.models.absence import Absence
from app.models.assignment import Assignment
from app.models.enums import AbsenceStatus, AbsenceType, PersonType, SiteStatus, UserRole
from app.models.person import Person
from app.models.person_hours_account import PersonHoursAccountEntry
from app.models.site import Site
from app.models.time_entry_weekly_review import TimeEntryWeeklyReview
from app.models.user import User
from app.models.work_time_entry import WorkTimeEntry
from app.services.time_entry_service import TimeEntryService


def service() -> TimeEntryService:
    item = TimeEntryService.__new__(TimeEntryService)
    item.db = SimpleNamespace()
    return item


def db_session() -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    return Session(engine)


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


def test_set_payroll_date_correction_moves_entry_with_original_date():
    entry = SimpleNamespace(
        id=1,
        person_id=4,
        work_date=date(2026, 6, 23),
        original_work_date=None,
        start_time=time(7, 30),
        end_time=time(13, 0),
    )
    commits: list[bool] = []
    item = TimeEntryService.__new__(TimeEntryService)
    item.db = SimpleNamespace(
        get=lambda model, entry_id: entry,
        scalars=lambda statement: [],
        commit=lambda: commits.append(True),
        refresh=lambda refreshed: None,
    )
    current_user = SimpleNamespace(id=7, role=UserRole.OFFICE)

    updated = item.set_payroll_date_correction(entry.id, work_date=date(2026, 6, 25), current_user=current_user)

    assert updated.work_date == date(2026, 6, 25)
    assert updated.original_work_date == date(2026, 6, 23)
    assert commits == [True]


def test_set_payroll_date_correction_rejects_other_week():
    entry = SimpleNamespace(
        id=1,
        person_id=4,
        work_date=date(2026, 6, 23),
        original_work_date=None,
        start_time=time(7, 30),
        end_time=time(13, 0),
    )
    item = TimeEntryService.__new__(TimeEntryService)
    item.db = SimpleNamespace(
        get=lambda model, entry_id: entry,
        commit=lambda: pytest.fail("Other-week move must not be committed."),
    )
    current_user = SimpleNamespace(id=7, role=UserRole.OFFICE)

    with pytest.raises(HTTPException) as error:
        item.set_payroll_date_correction(entry.id, work_date=date(2026, 6, 30), current_user=current_user)

    assert error.value.status_code == 400


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
    assert review.status == "reviewed"
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
    assert review.status == "reviewed"
    assert review.reviewed_by_user_id == 8
    assert review.reviewed_at is not None
    assert commits == [True]


def test_reset_weekly_review_marks_person_week_as_reset():
    db = db_session()
    person = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
        person_type=PersonType.INTERNAL,
    )
    user = User(username="office", display_name="Büro", password_hash="x", role=UserRole.OFFICE)
    db.add_all([person, user])
    db.commit()

    service = TimeEntryService(db)
    reviewed = service.mark_weekly_review(
        person_id=person.id,
        iso_year=2026,
        iso_week=24,
        current_user=user,
    )
    reset = service.reset_weekly_review(
        person_id=person.id,
        iso_year=2026,
        iso_week=24,
        current_user=user,
    )
    assert reset.id == reviewed.id
    assert reset.status == "reset"

    reviewed_again = service.mark_weekly_review(
        person_id=person.id,
        iso_year=2026,
        iso_week=24,
        current_user=user,
    )

    assert reviewed_again.id == reviewed.id
    assert reviewed_again.status == "reviewed"


def test_mark_weekly_review_books_hours_account_once():
    db = db_session()
    person = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
        person_type=PersonType.INTERNAL,
        weekly_hours=40,
    )
    user = User(username="office", display_name="Büro", password_hash="x", role=UserRole.OFFICE)
    db.add_all([person, user])
    db.flush()
    monday = date.fromisocalendar(2026, 24, 1)
    friday_entry = WorkTimeEntry(
        person=person,
        work_date=monday + timedelta(days=4),
        work_minutes=660,
        break_minutes=0,
        travel_minutes=0,
    )
    db.add_all([
        WorkTimeEntry(person=person, work_date=monday, work_minutes=480, break_minutes=0, travel_minutes=0),
        WorkTimeEntry(person=person, work_date=monday + timedelta(days=1), work_minutes=480, break_minutes=0, travel_minutes=0),
        WorkTimeEntry(person=person, work_date=monday + timedelta(days=2), work_minutes=480, break_minutes=0, travel_minutes=0),
        WorkTimeEntry(person=person, work_date=monday + timedelta(days=3), work_minutes=480, break_minutes=0, travel_minutes=0),
        friday_entry,
    ])
    db.commit()

    service = TimeEntryService(db)
    first_review = service.mark_weekly_review(
        person_id=person.id,
        iso_year=2026,
        iso_week=24,
        current_user=user,
    )
    second_review = service.mark_weekly_review(
        person_id=person.id,
        iso_year=2026,
        iso_week=24,
        current_user=user,
    )

    account_entries = list(db.scalars(select(PersonHoursAccountEntry)))
    assert first_review.id == second_review.id
    assert len(account_entries) == 1
    assert account_entries[0].entry_type == "weekly_balance"
    assert account_entries[0].minutes_delta == 180
    assert account_entries[0].balance_after_minutes == 180
    assert account_entries[0].weekly_actual_minutes == 2580
    assert account_entries[0].weekly_required_minutes == 2400
    assert account_entries[0].iso_year == 2026
    assert account_entries[0].iso_week == 24

    friday_entry.work_minutes = 600
    third_review = service.mark_weekly_review(
        person_id=person.id,
        iso_year=2026,
        iso_week=24,
        current_user=user,
    )
    corrected_entries = list(db.scalars(select(PersonHoursAccountEntry).order_by(PersonHoursAccountEntry.id)))
    assert third_review.id == first_review.id
    assert len(corrected_entries) == 2
    assert corrected_entries[1].minutes_delta == -60
    assert corrected_entries[1].balance_after_minutes == 120


def test_mark_weekly_review_counts_absence_days_in_hours_account():
    db = db_session()
    person = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
        person_type=PersonType.INTERNAL,
        weekly_hours=40,
    )
    user = User(username="office", display_name="Büro", password_hash="x", role=UserRole.OFFICE)
    db.add_all([person, user])
    db.flush()
    monday = date.fromisocalendar(2026, 28, 1)
    db.add_all([
        WorkTimeEntry(person=person, work_date=monday, work_minutes=480, break_minutes=0, travel_minutes=0),
        WorkTimeEntry(person=person, work_date=monday + timedelta(days=3), work_minutes=480, break_minutes=0, travel_minutes=0),
        WorkTimeEntry(person=person, work_date=monday + timedelta(days=4), work_minutes=300, break_minutes=0, travel_minutes=0),
        Absence(
            person=person,
            absence_type=AbsenceType.SICK,
            start_date=monday + timedelta(days=1),
            end_date=monday + timedelta(days=2),
            status=AbsenceStatus.ACTIVE,
        ),
    ])
    db.commit()

    TimeEntryService(db).mark_weekly_review(
        person_id=person.id,
        iso_year=2026,
        iso_week=28,
        current_user=user,
    )

    account_entries = list(db.scalars(select(PersonHoursAccountEntry)))
    assert len(account_entries) == 1
    assert account_entries[0].entry_type == "weekly_balance"
    assert account_entries[0].weekly_actual_minutes == 2220
    assert account_entries[0].weekly_required_minutes == 2400
    assert account_entries[0].minutes_delta == -180
    assert account_entries[0].balance_after_minutes == -180


def test_mark_weekly_review_tops_up_absence_day_without_double_counting():
    db = db_session()
    person = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
        person_type=PersonType.INTERNAL,
        weekly_hours=40,
    )
    user = User(username="office", display_name="Büro", password_hash="x", role=UserRole.OFFICE)
    db.add_all([person, user])
    db.flush()
    monday = date.fromisocalendar(2026, 29, 1)
    db.add_all([
        WorkTimeEntry(person=person, work_date=monday, work_minutes=300, break_minutes=0, travel_minutes=0),
        Absence(
            person=person,
            absence_type=AbsenceType.SICK,
            start_date=monday,
            end_date=monday + timedelta(days=1),
            status=AbsenceStatus.ACTIVE,
        ),
    ])
    db.commit()

    TimeEntryService(db).mark_weekly_review(
        person_id=person.id,
        iso_year=2026,
        iso_week=29,
        current_user=user,
    )

    account_entries = list(db.scalars(select(PersonHoursAccountEntry)))
    assert len(account_entries) == 1
    assert account_entries[0].weekly_actual_minutes == 960
    assert account_entries[0].weekly_required_minutes == 2400
    assert account_entries[0].minutes_delta == -1440


def test_mark_weekly_review_books_overtime_absence_without_weekly_minus():
    db = db_session()
    person = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
        person_type=PersonType.INTERNAL,
        weekly_hours=40,
    )
    user = User(username="office", display_name="Büro", password_hash="x", role=UserRole.OFFICE)
    db.add_all([person, user])
    db.flush()
    monday = date.fromisocalendar(2026, 30, 1)
    db.add_all([
        WorkTimeEntry(person=person, work_date=monday, work_minutes=480, break_minutes=0, travel_minutes=0),
        WorkTimeEntry(person=person, work_date=monday + timedelta(days=2), work_minutes=480, break_minutes=0, travel_minutes=0),
        WorkTimeEntry(person=person, work_date=monday + timedelta(days=3), work_minutes=480, break_minutes=0, travel_minutes=0),
        WorkTimeEntry(person=person, work_date=monday + timedelta(days=4), work_minutes=480, break_minutes=0, travel_minutes=0),
        Absence(
            person=person,
            absence_type=AbsenceType.FREE,
            start_date=monday + timedelta(days=1),
            end_date=monday + timedelta(days=1),
            status=AbsenceStatus.ACTIVE,
        ),
    ])
    db.commit()

    service = TimeEntryService(db)
    first_review = service.mark_weekly_review(
        person_id=person.id,
        iso_year=2026,
        iso_week=30,
        current_user=user,
    )
    second_review = service.mark_weekly_review(
        person_id=person.id,
        iso_year=2026,
        iso_week=30,
        current_user=user,
    )

    account_entries = list(db.scalars(select(PersonHoursAccountEntry)))
    assert first_review.id == second_review.id
    assert len(account_entries) == 1
    assert account_entries[0].entry_type == "overtime_absence"
    assert account_entries[0].minutes_delta == -480
    assert account_entries[0].balance_after_minutes == -480
    assert account_entries[0].weekly_actual_minutes is None
    assert account_entries[0].weekly_required_minutes is None


def test_mark_weekly_review_books_multiple_overtime_absence_days():
    db = db_session()
    person = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
        person_type=PersonType.INTERNAL,
        weekly_hours=40,
    )
    user = User(username="office", display_name="Büro", password_hash="x", role=UserRole.OFFICE)
    db.add_all([person, user])
    db.flush()
    monday = date.fromisocalendar(2026, 31, 1)
    db.add_all([
        WorkTimeEntry(person=person, work_date=monday, work_minutes=480, break_minutes=0, travel_minutes=0),
        WorkTimeEntry(person=person, work_date=monday + timedelta(days=3), work_minutes=480, break_minutes=0, travel_minutes=0),
        WorkTimeEntry(person=person, work_date=monday + timedelta(days=4), work_minutes=480, break_minutes=0, travel_minutes=0),
        Absence(
            person=person,
            absence_type=AbsenceType.FREE,
            start_date=monday + timedelta(days=1),
            end_date=monday + timedelta(days=2),
            status=AbsenceStatus.ACTIVE,
        ),
    ])
    db.commit()

    TimeEntryService(db).mark_weekly_review(
        person_id=person.id,
        iso_year=2026,
        iso_week=31,
        current_user=user,
    )

    account_entries = list(db.scalars(select(PersonHoursAccountEntry)))
    assert len(account_entries) == 1
    assert account_entries[0].entry_type == "overtime_absence"
    assert account_entries[0].minutes_delta == -960
    assert account_entries[0].balance_after_minutes == -960


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


def test_review_decision_assign_site_preserves_original_site_before_override():
    entry = SimpleNamespace(
        id=1,
        person_id=4,
        site_id=10,
        original_site_id=None,
        status="draft",
        time_review_status="open",
        time_review_method=None,
        reviewed_by_user_id=None,
        reviewed_at=None,
    )
    item = TimeEntryService.__new__(TimeEntryService)
    item.db = SimpleNamespace(
        get=lambda model, model_id: entry if model is WorkTimeEntry else SimpleNamespace(id=model_id),
        commit=lambda: None,
        refresh=lambda refreshed: None,
    )
    current_user = SimpleNamespace(id=9, role=UserRole.OFFICE)

    updated = item.apply_time_review_decision(
        entry.id,
        decision="assign_site",
        reviewed_site_id=20,
        current_user=current_user,
    )

    assert updated.original_site_id == 10
    assert updated.site_id == 20
    assert updated.time_review_method == "assign_site"
    assert updated.status == "reviewed"


def test_review_decision_assign_site_keeps_existing_original_site():
    entry = SimpleNamespace(
        id=1,
        person_id=4,
        site_id=20,
        original_site_id=10,
        status="draft",
        time_review_status="open",
        time_review_method="assign_site",
        reviewed_by_user_id=None,
        reviewed_at=None,
    )
    item = TimeEntryService.__new__(TimeEntryService)
    item.db = SimpleNamespace(
        get=lambda model, model_id: entry if model is WorkTimeEntry else SimpleNamespace(id=model_id),
        commit=lambda: None,
        refresh=lambda refreshed: None,
    )
    current_user = SimpleNamespace(id=9, role=UserRole.OFFICE)

    updated = item.apply_time_review_decision(
        entry.id,
        decision="assign_site",
        reviewed_site_id=30,
        current_user=current_user,
    )

    assert updated.original_site_id == 10
    assert updated.site_id == 30


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


def test_project_mounting_times_include_open_manual_entry_with_site_and_minutes():
    entry = SimpleNamespace(
        site_id=12,
        source="manual",
        work_minutes=480,
        corrected_work_minutes=None,
        time_review_status="open",
        time_review_method=None,
    )

    assert TimeEntryService.is_project_mounting_time_relevant(entry, None) is True


def test_project_mounting_times_include_manually_approved_entry():
    entry = SimpleNamespace(
        site_id=12,
        source="manual",
        work_minutes=480,
        corrected_work_minutes=None,
        time_review_status="manually_approved",
        time_review_method="manual_confirmed",
    )

    assert TimeEntryService.is_project_mounting_time_relevant(entry, None) is True


def test_project_mounting_times_include_corrected_entry():
    entry = SimpleNamespace(
        site_id=12,
        source="manual",
        work_minutes=450,
        corrected_work_minutes=450,
        time_review_status="corrected",
        time_review_method="manual_correction",
    )

    assert TimeEntryService.is_project_mounting_time_relevant(entry, None) is True


def test_project_mounting_times_include_accepted_gps_entry():
    entry = SimpleNamespace(
        site_id=12,
        source="manual",
        work_minutes=420,
        corrected_work_minutes=420,
        time_review_status="corrected",
        time_review_method="accept_gps",
    )

    assert TimeEntryService.is_project_mounting_time_relevant(entry, None) is True


def test_project_mounting_times_include_auto_plausible_entry():
    entry = SimpleNamespace(
        site_id=12,
        source="manual",
        work_minutes=480,
        corrected_work_minutes=None,
        time_review_status="open",
        time_review_method=None,
    )
    gps_evaluation = SimpleNamespace(work_minutes=470, review_notices=())

    assert TimeEntryService.is_project_mounting_time_relevant(entry, gps_evaluation) is True


def test_project_mounting_times_include_gps_conflict_and_not_verifiable_entries_with_minutes():
    conflicting_entry = SimpleNamespace(
        site_id=12,
        source="manual",
        work_minutes=480,
        corrected_work_minutes=None,
        time_review_status="open",
        time_review_method=None,
    )
    gps_evaluation = SimpleNamespace(work_minutes=480, review_notices=("GPS weicht von Planungsmatrix ab",))
    not_verifiable_entry = SimpleNamespace(
        site_id=12,
        source="manual",
        work_minutes=480,
        corrected_work_minutes=None,
        time_review_status="not_verifiable",
        time_review_method="mark_not_verifiable",
    )

    assert TimeEntryService.is_project_mounting_time_relevant(conflicting_entry, gps_evaluation) is True
    assert TimeEntryService.is_project_mounting_time_relevant(not_verifiable_entry, None) is True


def test_project_mounting_times_exclude_entries_without_site_or_minutes():
    no_site_entry = SimpleNamespace(
        site_id=None,
        source="manual",
        work_minutes=480,
        corrected_work_minutes=None,
    )
    no_minutes_entry = SimpleNamespace(
        site_id=12,
        source="manual",
        work_minutes=0,
        corrected_work_minutes=None,
        payroll_corrected_work_minutes=None,
        payroll_corrected_start_time=None,
        payroll_corrected_end_time=None,
        break_minutes=0,
    )
    gps_suggestion = SimpleNamespace(
        site_id=12,
        source="gps_suggestion",
        work_minutes=480,
        corrected_work_minutes=None,
    )

    assert TimeEntryService.is_project_mounting_time_relevant(no_site_entry, None) is False
    assert TimeEntryService.is_project_mounting_time_relevant(no_minutes_entry, None) is False
    assert TimeEntryService.is_project_mounting_time_relevant(gps_suggestion, None) is False


def test_project_mounting_work_minutes_prefers_payroll_correction():
    entry = SimpleNamespace(
        work_minutes=480,
        corrected_work_minutes=420,
        payroll_corrected_work_minutes=None,
        payroll_corrected_start_time=time(8, 0),
        payroll_corrected_end_time=time(13, 0),
        break_minutes=30,
    )

    assert TimeEntryService.project_mounting_work_minutes(entry) == 270

    entry.payroll_corrected_work_minutes = 300

    assert TimeEntryService.project_mounting_work_minutes(entry) == 300


def test_project_mounting_context_multiplies_external_workers_without_absence():
    db = db_session()
    site = Site(name="Baustelle", status=SiteStatus.ACTIVE)
    internal = Person(
        first_name="Christopher",
        last_name="Erichsen",
        display_name="Christopher Erichsen",
        short_code="CE",
        person_type=PersonType.INTERNAL,
    )
    external_available = Person(
        first_name="Max",
        last_name="Extern",
        display_name="Max Extern",
        short_code="ME",
        person_type=PersonType.EXTERNAL,
    )
    external_absent = Person(
        first_name="Krank",
        last_name="Extern",
        display_name="Krank Extern",
        short_code="KE",
        person_type=PersonType.EXTERNAL_TEMP,
    )
    db.add_all([site, internal, external_available, external_absent])
    db.flush()
    work_date = date(2026, 6, 22)
    entry = WorkTimeEntry(
        person_id=internal.id,
        site_id=site.id,
        work_date=work_date,
        start_time=time(8, 0),
        end_time=time(16, 0),
        break_minutes=30,
        travel_minutes=15,
        work_minutes=450,
        source="manual",
    )
    db.add(entry)
    db.add_all([
        Assignment(
            site_id=site.id,
            person_id=external_available.id,
            start_date=work_date,
            end_date=work_date,
        ),
        Assignment(
            site_id=site.id,
            person_id=external_absent.id,
            start_date=work_date,
            end_date=work_date,
        ),
        Absence(
            person_id=external_absent.id,
            absence_type=AbsenceType.SICK,
            start_date=work_date,
            end_date=work_date,
            status=AbsenceStatus.ACTIVE,
        ),
    ])
    db.commit()

    context = TimeEntryService(db).project_mounting_contexts([entry])[entry.id]

    assert context["multiplier"] == 2
    assert context["external_person_count"] == 1
    assert context["participant_ids"] == [internal.id, external_available.id]
    assert context["work_minutes"] == 900
    assert context["break_minutes"] == 60
    assert context["travel_minutes"] == 30
