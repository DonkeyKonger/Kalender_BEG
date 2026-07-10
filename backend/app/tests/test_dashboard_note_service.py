from datetime import date

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.models import Base
from app.models.enums import UserRole
from app.models.person import Person
from app.models.site import Site
from app.models.user import User
from app.schemas.dashboard_note import DashboardNoteCreate, DashboardNoteUpdate
from app.services.dashboard_note_service import DashboardNoteService, clean_note_values


def db_session() -> Session:
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return Session(engine)


def test_clean_note_values_rejects_blank_text():
    with pytest.raises(HTTPException) as error:
        clean_note_values({"text": "   "})

    assert error.value.status_code == 400


def test_dashboard_note_lifecycle_with_assignments_and_soft_delete():
    db = db_session()
    site = Site(site_number="7239", name="HHLA Speicherblock V")
    person = Person(
        first_name="Sandro",
        last_name="König",
        display_name="Sandro König",
        short_code="SK",
    )
    user = User(
        username="admin",
        display_name="Administrator",
        password_hash="x",
        role=UserRole.ADMIN,
        is_active=True,
    )
    db.add_all([site, person, user])
    db.commit()

    service = DashboardNoteService(db)
    note = service.create_note(
        DashboardNoteCreate(
            text="  Unterlagen prüfen  ",
            due_date=date(2026, 7, 14),
            site_id=site.id,
            employee_id=person.id,
        ),
        user_id=user.id,
    )

    assert note.text == "Unterlagen prüfen"
    assert note.due_date == date(2026, 7, 14)
    assert note.site_id == site.id
    assert note.employee_id == person.id
    assert note.created_by_user_id == user.id

    completed = service.update_note(note.id, DashboardNoteUpdate(completed=True), user_id=user.id)

    assert completed.completed is True
    assert completed.completed_at is not None
    assert service.list_notes(user_id=user.id, completed=False) == []
    assert [entry.id for entry in service.list_notes(user_id=user.id, completed=True)] == [note.id]

    reopened = service.update_note(
        note.id,
        DashboardNoteUpdate(completed=False, due_date=None, site_id=None, employee_id=None),
        user_id=user.id,
    )

    assert reopened.completed is False
    assert reopened.completed_at is None
    assert reopened.due_date is None
    assert reopened.site_id is None
    assert reopened.employee_id is None

    service.delete_note(note.id, user_id=user.id)

    assert service.list_notes(user_id=user.id) == []


def test_dashboard_notes_are_scoped_to_owner():
    db = db_session()
    owner = User(
        username="christopher",
        display_name="Christopher",
        password_hash="x",
        role=UserRole.PROJECT_MANAGER,
        is_active=True,
    )
    other_user = User(
        username="office",
        display_name="Büro",
        password_hash="x",
        role=UserRole.OFFICE,
        is_active=True,
    )
    db.add_all([owner, other_user])
    db.commit()

    service = DashboardNoteService(db)
    note = service.create_note(
        DashboardNoteCreate(text="Nur meine Notiz"),
        user_id=owner.id,
    )

    assert [entry.id for entry in service.list_notes(user_id=owner.id)] == [note.id]
    assert service.list_notes(user_id=other_user.id) == []

    with pytest.raises(HTTPException) as update_error:
        service.update_note(note.id, DashboardNoteUpdate(completed=True), user_id=other_user.id)
    assert update_error.value.status_code == 404

    with pytest.raises(HTTPException) as delete_error:
        service.delete_note(note.id, user_id=other_user.id)
    assert delete_error.value.status_code == 404

    assert [entry.id for entry in service.list_notes(user_id=owner.id)] == [note.id]
