from datetime import date, datetime, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.models import Base
from app.models.enums import PersonType, SiteStatus, UserRole
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


def test_dashboard_note_site_options_use_all_open_sites_and_sort_by_site_number():
    db = db_session()
    manager = Person(first_name="Chris", last_name="Erichsen", display_name="Chris Erichsen", short_code="CE")
    other_manager = Person(first_name="Sandro", last_name="König", display_name="Sandro König", short_code="SK")
    db.add_all([manager, other_manager])
    db.flush()

    user = User(
        username="christopher",
        display_name="Christopher",
        password_hash="x",
        role=UserRole.PROJECT_MANAGER,
        is_active=True,
        person_id=manager.id,
    )
    db.add(user)
    db.add_all(
        [
            Site(site_number="4400", name="Daimler Bremen", status=SiteStatus.ACTIVE, project_manager_person_id=manager.id),
            Site(site_number="1001", name="Büsum", status=SiteStatus.PAUSED, project_manager_person_id=manager.id),
            Site(site_number="2940", name="GEWOBA Bremerhaven", status=SiteStatus.PLANNED, project_manager_person_id=manager.id),
            Site(site_number="4661", name="Fischhalle Cuxhaven", status=SiteStatus.COMPLETED, project_manager_person_id=manager.id),
            Site(site_number="5000", name="Gelöscht", status=SiteStatus.DELETED, project_manager_person_id=manager.id),
            Site(site_number="1000", name="Andere Leitung", status=SiteStatus.ACTIVE, project_manager_person_id=other_manager.id),
            Site(site_number="9999", name="Ohne Leitung", status=SiteStatus.ACTIVE),
        ]
    )
    db.commit()

    sites = DashboardNoteService(db).list_site_options()

    assert [site.site_number for site in sites] == ["1000", "1001", "2940", "4400", "9999"]


def test_dashboard_note_site_options_do_not_require_a_user_person_assignment():
    db = db_session()
    user = User(
        username="office",
        display_name="Büro",
        password_hash="x",
        role=UserRole.OFFICE,
        is_active=True,
    )
    db.add_all(
        [
            user,
            Site(site_number="1001", name="Büsum", status=SiteStatus.ACTIVE),
        ]
    )
    db.commit()

    assert [site.site_number for site in DashboardNoteService(db).list_site_options()] == ["1001"]


def test_dashboard_note_employee_options_filter_and_sort_assignable_people():
    db = db_session()
    external = Person(
        first_name="Anna",
        last_name="Alpha",
        display_name="Anna Alpha",
        short_code="AA",
        person_type=PersonType.EXTERNAL,
        is_active=True,
    )
    worker_without_user = Person(
        first_name="Berta",
        last_name="Bauer",
        display_name="Berta Bauer",
        short_code="BB",
        person_type=PersonType.INTERNAL,
        is_active=True,
    )
    worker_with_user = Person(
        first_name="Max",
        last_name="Zorn",
        display_name="Max Zorn",
        short_code="MZ",
        person_type=PersonType.INTERNAL,
        is_active=True,
    )
    project_manager = Person(
        first_name="Paula",
        last_name="Leitung",
        display_name="Paula Leitung",
        short_code="PL",
        person_type=PersonType.INTERNAL,
        is_active=True,
    )
    disabled_worker = Person(
        first_name="Dieter",
        last_name="Konto",
        display_name="Dieter Konto",
        short_code="DK",
        person_type=PersonType.INTERNAL,
        is_active=True,
    )
    inactive_worker = Person(
        first_name="Ines",
        last_name="Inaktiv",
        display_name="Ines Inaktiv",
        short_code="II",
        person_type=PersonType.INTERNAL,
        is_active=False,
    )
    deleted_worker = Person(
        first_name="Dora",
        last_name="Gelöscht",
        display_name="Dora Gelöscht",
        short_code="DG",
        person_type=PersonType.INTERNAL,
        is_active=True,
        deleted_at=datetime.now(timezone.utc),
    )
    db.add_all([
        external,
        worker_without_user,
        worker_with_user,
        project_manager,
        disabled_worker,
        inactive_worker,
        deleted_worker,
    ])
    db.flush()
    db.add_all([
        User(
            username="max.worker",
            display_name="Max Zorn",
            password_hash="x",
            role=UserRole.MONTEUR,
            is_active=True,
            person_id=worker_with_user.id,
        ),
        User(
            username="paula.manager",
            display_name="Paula Leitung",
            password_hash="x",
            role=UserRole.PROJECT_MANAGER,
            is_active=True,
            person_id=project_manager.id,
        ),
        User(
            username="dieter.disabled",
            display_name="Dieter Konto",
            password_hash="x",
            role=UserRole.MONTEUR,
            is_active=False,
            person_id=disabled_worker.id,
        ),
    ])
    db.commit()

    people = DashboardNoteService(db).list_employee_options()

    assert [person.display_name for person in people] == [
        "Anna Alpha",
        "Berta Bauer",
        "Max Zorn",
    ]


def test_dashboard_note_update_keeps_unchanged_deleted_employee_assignment():
    db = db_session()
    employee = Person(
        first_name="Alt",
        last_name="Monteur",
        display_name="Alt Monteur",
        short_code="AM",
    )
    owner = User(
        username="owner",
        display_name="Owner",
        password_hash="x",
        role=UserRole.OFFICE,
        is_active=True,
    )
    db.add_all([employee, owner])
    db.commit()

    service = DashboardNoteService(db)
    note = service.create_note(
        DashboardNoteCreate(text="Historische Zuordnung", employee_id=employee.id),
        user_id=owner.id,
    )
    employee.deleted_at = datetime.now(timezone.utc)
    db.commit()

    updated = service.update_note(
        note.id,
        DashboardNoteUpdate(text="Weiterhin zugeordnet", employee_id=employee.id),
        user_id=owner.id,
    )

    assert updated.employee_id == employee.id
    assert updated.text == "Weiterhin zugeordnet"

    with pytest.raises(HTTPException) as error:
        service.create_note(
            DashboardNoteCreate(text="Neue Zuordnung", employee_id=employee.id),
            user_id=owner.id,
        )
    assert error.value.status_code == 400
