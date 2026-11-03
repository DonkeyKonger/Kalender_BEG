from datetime import date, datetime, timedelta
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.models import Base
from app.models.absence import Absence
from app.models.audit_log import AuditLog
from app.models.enums import AbsenceStatus, AbsenceType, PersonType, UserRole
from app.models.person import Person
from app.models.time_entry_weekly_review import TimeEntryWeeklyReview
from app.models.user import User
from app.models.work_time_entry import WorkTimeEntry
from app.schemas.absence import AbsenceCreate, AbsenceUpdate
from app.services.absence_service import AbsenceService, absence_snapshot, clean_absence_values


def db_session() -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    return Session(engine)


def test_clean_absence_values_turns_blank_note_to_none():
    values = clean_absence_values({"note": "   "})

    assert values["note"] is None


def test_absence_snapshot_uses_json_safe_values():
    absence = SimpleNamespace(
        id=1,
        person_id=2,
        absence_type=AbsenceType.VACATION,
        start_date=date(2027, 1, 4),
        end_date=date(2027, 1, 8),
        status=AbsenceStatus.ACTIVE,
        note="Urlaub",
    )

    snapshot = absence_snapshot(absence)

    assert snapshot["absence_type"] == "vacation"
    assert snapshot["start_date"] == "2027-01-04"
    assert snapshot["status"] == "active"


def test_vacation_carryover_defaults_to_none_and_can_be_saved_per_person_year():
    db = db_session()
    person = Person(
        first_name="Marco",
        last_name="Becker",
        display_name="Marco Becker",
        short_code="MB",
        person_type=PersonType.INTERNAL,
    )
    db.add(person)
    db.commit()

    service = AbsenceService(db)
    assert service.get_vacation_carryover(person_id=person.id, year=2026) is None

    carryover = service.set_vacation_carryover(
        person_id=person.id,
        year=2026,
        carryover_days=4,
        user_id=None,
    )
    other_year = service.get_vacation_carryover(person_id=person.id, year=2027)

    assert carryover.person_id == person.id
    assert carryover.year == 2026
    assert carryover.carryover_days == 4
    assert other_year is None

    updated = service.set_vacation_carryover(
        person_id=person.id,
        year=2026,
        carryover_days=2,
        user_id=None,
    )
    assert updated.id == carryover.id
    assert updated.carryover_days == 2


def test_absence_create_update_and_delete_invalidate_all_affected_payroll_reviews():
    db = db_session()
    old_person = Person(
        first_name="Alt",
        last_name="Abwesend",
        display_name="Alt Abwesend",
        short_code="AA",
        person_type=PersonType.INTERNAL,
    )
    new_person = Person(
        first_name="Neu",
        last_name="Abwesend",
        display_name="Neu Abwesend",
        short_code="NA",
        person_type=PersonType.INTERNAL,
    )
    user = User(username="absence-invalidation", display_name="Büro", password_hash="x", role=UserRole.OFFICE)
    old_date = date.fromisocalendar(2026, 37, 3)
    new_start = date.fromisocalendar(2026, 38, 4)
    new_end = date.fromisocalendar(2026, 39, 2)
    db.add_all([old_person, new_person, user])
    db.flush()
    old_entry = WorkTimeEntry(
        person_id=old_person.id,
        work_date=old_date,
        work_minutes=480,
        break_minutes=0,
        travel_minutes=0,
        payroll_reviewed_by_user_id=user.id,
        payroll_reviewed_at=datetime(2026, 9, 9, 18, 0),
    )
    old_review = TimeEntryWeeklyReview(
        person_id=old_person.id,
        iso_year=2026,
        iso_week=37,
        status="reviewed",
        reviewed_by_user_id=user.id,
        reviewed_at=datetime(2026, 9, 11, 12, 0),
    )
    db.add_all([old_entry, old_review])
    db.commit()
    service = AbsenceService(db)

    absence = service.create_absence(AbsenceCreate(
        person_id=old_person.id,
        absence_type=AbsenceType.VACATION,
        start_date=old_date,
        end_date=old_date,
    ), user.id)

    db.refresh(old_entry)
    db.refresh(old_review)
    assert old_review.status == "reset"
    assert old_entry.payroll_reviewed_at is None

    new_entries = [
        WorkTimeEntry(
            person_id=new_person.id,
            work_date=work_date,
            work_minutes=480,
            break_minutes=0,
            travel_minutes=0,
            payroll_reviewed_by_user_id=user.id,
            payroll_reviewed_at=datetime(2026, 9, 20, 18, 0),
        )
        for work_date in (new_start, new_end)
    ]
    new_reviews = [
        TimeEntryWeeklyReview(
            person_id=new_person.id,
            iso_year=2026,
            iso_week=iso_week,
            status="reviewed",
            reviewed_by_user_id=user.id,
            reviewed_at=datetime(2026, 9, 25, 12, 0),
        )
        for iso_week in (38, 39)
    ]
    old_review.status = "reviewed"
    old_entry.payroll_reviewed_by_user_id = user.id
    old_entry.payroll_reviewed_at = datetime(2026, 9, 12, 18, 0)
    db.add_all([*new_entries, *new_reviews])
    db.commit()

    updated = service.update_absence(absence.id, AbsenceUpdate(
        person_id=new_person.id,
        start_date=new_start,
        end_date=new_end,
    ), user.id)

    assert (updated.person_id, updated.start_date, updated.end_date) == (
        new_person.id,
        new_start,
        new_end,
    )
    assert old_review.status == "reset"
    assert {review.status for review in new_reviews} == {"reset"}
    for entry in (old_entry, *new_entries):
        db.refresh(entry)
        assert entry.payroll_reviewed_by_user_id is None
        assert entry.payroll_reviewed_at is None

    for review in new_reviews:
        review.status = "reviewed"
    for entry in new_entries:
        entry.payroll_reviewed_by_user_id = user.id
        entry.payroll_reviewed_at = datetime(2026, 9, 26, 18, 0)
    db.commit()

    service.delete_absence(updated.id, user.id)

    assert db.get(type(updated), updated.id) is None
    assert {review.status for review in new_reviews} == {"reset"}
    assert all(entry.payroll_reviewed_at is None for entry in new_entries)
    assert len(list(db.scalars(select(TimeEntryWeeklyReview)))) == 3


def test_remove_absence_day_invalidates_removed_day_and_preserves_split_provenance():
    db = db_session()
    absent_person = Person(
        first_name="Mara",
        last_name="Test",
        display_name="Mara Test",
        short_code="MT",
        person_type=PersonType.INTERNAL,
    )
    creator_person = Person(
        first_name="Christopher",
        last_name="Erichsen",
        display_name="Christopher Erichsen",
        short_code="CE",
        person_type=PersonType.INTERNAL,
    )
    creator = User(
        username="creator",
        display_name="Christopher Erichsen",
        password_hash="x",
        role=UserRole.ADMIN,
        person=creator_person,
    )
    editor = User(
        username="editor",
        display_name="Anna Büro",
        password_hash="x",
        role=UserRole.OFFICE,
    )
    db.add_all([absent_person, creator, editor])
    db.commit()
    service = AbsenceService(db)
    removed_date = date.fromisocalendar(2026, 45, 3)
    absence = service.create_absence(
        AbsenceCreate(
            person_id=absent_person.id,
            absence_type=AbsenceType.VACATION,
            start_date=removed_date - timedelta(days=2),
            end_date=removed_date + timedelta(days=2),
            note="Urlaub",
        ),
        creator.id,
    )
    original_created_at = absence.created_at
    entry = WorkTimeEntry(
        person_id=absent_person.id,
        work_date=removed_date,
        work_minutes=480,
        break_minutes=0,
        travel_minutes=0,
        payroll_reviewed_by_user_id=editor.id,
        payroll_reviewed_at=datetime(2026, 11, 4, 18, 0),
    )
    review = TimeEntryWeeklyReview(
        person_id=absent_person.id,
        iso_year=2026,
        iso_week=45,
        status="reviewed",
        reviewed_by_user_id=editor.id,
        reviewed_at=datetime(2026, 11, 6, 12, 0),
    )
    db.add_all([entry, review])
    db.commit()

    remaining = service.remove_absence_day(absence.id, removed_date, editor.id)

    assert [(item.start_date, item.end_date) for item in remaining] == [
        (removed_date - timedelta(days=2), removed_date - timedelta(days=1)),
        (removed_date + timedelta(days=1), removed_date + timedelta(days=2)),
    ]
    assert {item.created_by_user_id for item in remaining} == {creator.id}
    assert {item.updated_by_user_id for item in remaining} == {editor.id}
    assert {item.created_at for item in remaining} == {original_created_at}
    assert {item.note for item in remaining} == {"Urlaub"}
    db.refresh(entry)
    db.refresh(review)
    assert entry.payroll_reviewed_by_user_id is None
    assert entry.payroll_reviewed_at is None
    assert review.status == "reset"
    audit = db.scalar(select(AuditLog).where(AuditLog.action == "absence.day_removed"))
    assert audit.user_id == editor.id
    assert audit.old_value_json["start_date"] == (removed_date - timedelta(days=2)).isoformat()
    assert audit.new_value_json["removed_date"] == removed_date.isoformat()


def test_remove_absence_day_handles_boundaries_single_days_and_invalid_date():
    db = db_session()
    person = Person(
        first_name="Mara",
        last_name="Test",
        display_name="Mara Test",
        short_code="MT",
        person_type=PersonType.INTERNAL,
    )
    user = User(
        username="editor",
        display_name="Anna Büro",
        password_hash="x",
        role=UserRole.OFFICE,
    )
    db.add_all([person, user])
    db.commit()
    service = AbsenceService(db)

    start_trimmed = service.create_absence(
        AbsenceCreate(
            person_id=person.id,
            absence_type=AbsenceType.VACATION,
            start_date=date(2026, 11, 2),
            end_date=date(2026, 11, 4),
        ),
        user.id,
    )
    start_result = service.remove_absence_day(
        start_trimmed.id,
        date(2026, 11, 2),
        user.id,
    )
    assert [(item.id, item.start_date, item.end_date) for item in start_result] == [
        (start_trimmed.id, date(2026, 11, 3), date(2026, 11, 4))
    ]

    end_result = service.remove_absence_day(
        start_trimmed.id,
        date(2026, 11, 4),
        user.id,
    )
    assert [(item.start_date, item.end_date) for item in end_result] == [
        (date(2026, 11, 3), date(2026, 11, 3))
    ]

    with pytest.raises(HTTPException) as caught:
        service.remove_absence_day(start_trimmed.id, date(2026, 11, 4), user.id)
    assert caught.value.status_code == 400
    assert db.get(Absence, start_trimmed.id).start_date == date(2026, 11, 3)

    removed = service.remove_absence_day(
        start_trimmed.id,
        date(2026, 11, 3),
        user.id,
    )
    assert removed == []
    assert db.get(Absence, start_trimmed.id) is None


def test_remove_absence_day_rolls_back_both_fragments_when_commit_fails(monkeypatch):
    db = db_session()
    person = Person(
        first_name="Mara",
        last_name="Test",
        display_name="Mara Test",
        short_code="MT",
        person_type=PersonType.INTERNAL,
    )
    user = User(
        username="editor",
        display_name="Anna Büro",
        password_hash="x",
        role=UserRole.OFFICE,
    )
    db.add_all([person, user])
    db.commit()
    service = AbsenceService(db)
    absence = service.create_absence(
        AbsenceCreate(
            person_id=person.id,
            absence_type=AbsenceType.VACATION,
            start_date=date(2026, 11, 2),
            end_date=date(2026, 11, 6),
        ),
        user.id,
    )
    original_id = absence.id
    real_commit = db.commit

    def fail_commit():
        raise RuntimeError("commit failed")

    monkeypatch.setattr(db, "commit", fail_commit)
    with pytest.raises(RuntimeError, match="commit failed"):
        service.remove_absence_day(original_id, date(2026, 11, 4), user.id)
    monkeypatch.setattr(db, "commit", real_commit)
    db.expire_all()

    persisted = list(db.scalars(select(Absence).order_by(Absence.id)))
    assert [(item.id, item.start_date, item.end_date) for item in persisted] == [
        (original_id, date(2026, 11, 2), date(2026, 11, 6))
    ]
    assert db.scalar(
        select(AuditLog).where(AuditLog.action == "absence.day_removed")
    ) is None
