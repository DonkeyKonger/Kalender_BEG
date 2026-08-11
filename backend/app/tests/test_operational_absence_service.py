from datetime import date, time

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.models import Base
from app.models.enums import PersonType, SiteStatus, UserRole
from app.models.person import Person
from app.models.site import Site
from app.models.user import User
from app.schemas.operational_absence import OperationalAbsenceCreate
from app.services.absence_service import AbsenceService
from app.services.matrix_service import MatrixService
from app.services.operational_absence_service import OperationalAbsenceService


def db_session() -> Session:
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return Session(engine)


def add_user_person(
    db: Session,
    *,
    name: str,
    role: UserRole,
    person_type: PersonType = PersonType.INTERNAL,
    user_active: bool = True,
    person_active: bool = True,
) -> tuple[User, Person]:
    first_name, last_name = name.split(" ", 1)
    person = Person(
        first_name=first_name,
        last_name=last_name,
        display_name=name,
        short_code=f"{first_name[0]}{last_name[0]}".upper(),
        person_type=person_type,
        is_active=person_active,
    )
    user = User(
        username=name.casefold().replace(" ", "."),
        display_name=name,
        password_hash="x",
        role=role,
        is_active=user_active,
        person=person,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    db.refresh(person)
    return user, person


def test_operational_absence_supports_minimal_and_full_entries_without_hr_absence():
    db = db_session()
    creator, manager = add_user_person(
        db,
        name="Christopher Erichsen",
        role=UserRole.PROJECT_MANAGER,
    )
    site = Site(
        site_number="8015",
        name="FFW Barmbek Hamburg",
        status=SiteStatus.ACTIVE,
    )
    db.add(site)
    db.commit()
    service = OperationalAbsenceService(db)

    minimal = service.create_operational_absence(
        OperationalAbsenceCreate(
            project_manager_id=manager.id,
            date=date(2026, 8, 11),
        ),
        user_id=creator.id,
    )
    full = service.create_operational_absence(
        OperationalAbsenceCreate(
            project_manager_id=manager.id,
            date=date(2026, 8, 12),
            start_time=time(9, 0),
            end_time=time(13, 0),
            site_id=site.id,
            text="  Baubesprechung  ",
        ),
        user_id=creator.id,
    )

    assert minimal.start_time is None
    assert minimal.end_time is None
    assert minimal.site is None
    assert minimal.text is None
    assert full.start_time == time(9, 0)
    assert full.end_time == time(13, 0)
    assert full.site_id == site.id
    assert full.text == "Baubesprechung"
    assert full.project_manager.display_name == "Christopher Erichsen"

    assert AbsenceService(db).list_absences(
        start=date(2026, 8, 1),
        end=date(2026, 8, 31),
    ) == []
    summary = AbsenceService(db).get_person_year_summary(person=manager, year=2026)
    assert summary.remaining_vacation_days == 0
    assert summary.sick_days == 0


@pytest.mark.parametrize(
    ("start_time", "end_time"),
    [
        (time(9, 0), None),
        (None, time(13, 0)),
        (time(13, 0), time(9, 0)),
        (time(9, 0), time(9, 0)),
    ],
)
def test_operational_absence_schema_rejects_incomplete_or_invalid_time_ranges(
    start_time,
    end_time,
):
    with pytest.raises(ValidationError):
        OperationalAbsenceCreate(
            project_manager_id=1,
            date=date(2026, 8, 11),
            start_time=start_time,
            end_time=end_time,
        )


@pytest.mark.parametrize(
    ("role", "person_type", "user_active", "person_active"),
    [
        (UserRole.OFFICE, PersonType.INTERNAL, True, True),
        (UserRole.MONTEUR, PersonType.INTERNAL, True, True),
        (UserRole.PROJECT_MANAGER, PersonType.EXTERNAL, True, True),
        (UserRole.PROJECT_MANAGER, PersonType.INTERNAL, False, True),
        (UserRole.PROJECT_MANAGER, PersonType.INTERNAL, True, False),
    ],
)
def test_operational_absence_rejects_non_project_manager_targets(
    role,
    person_type,
    user_active,
    person_active,
):
    db = db_session()
    creator, _ = add_user_person(db, name="Admin Person", role=UserRole.ADMIN)
    _, invalid_target = add_user_person(
        db,
        name="Falsche Person",
        role=role,
        person_type=person_type,
        user_active=user_active,
        person_active=person_active,
    )

    with pytest.raises(HTTPException) as error:
        OperationalAbsenceService(db).create_operational_absence(
            OperationalAbsenceCreate(
                project_manager_id=invalid_target.id,
                date=date(2026, 8, 11),
            ),
            user_id=creator.id,
        )

    assert error.value.status_code == 400


def test_operational_absence_options_reuse_active_project_manager_and_site_rules():
    db = db_session()
    _, manager = add_user_person(
        db,
        name="Zora Leitung",
        role=UserRole.PROJECT_MANAGER,
    )
    admin_user, admin_manager = add_user_person(
        db,
        name="Anna Admin",
        role=UserRole.ADMIN,
    )
    add_user_person(db, name="Olaf Office", role=UserRole.OFFICE)
    sites = [
        Site(site_number="1", name="Aktiv", status=SiteStatus.ACTIVE),
        Site(site_number="2", name="Pause", status=SiteStatus.PAUSED),
        Site(site_number="3", name="Geplant", status=SiteStatus.PLANNED),
        Site(site_number="4", name="Fertig", status=SiteStatus.COMPLETED),
        Site(site_number="5", name="Gelöscht", status=SiteStatus.DELETED),
    ]
    db.add_all(sites)
    db.commit()

    service = OperationalAbsenceService(db)

    assert [item.id for item in service.list_project_manager_options()] == [
        admin_manager.id,
        manager.id,
    ]
    assert {item.name for item in service.list_site_options()} == {
        "Aktiv",
        "Pause",
        "Geplant",
    }

    for unavailable_site in sites[-2:]:
        with pytest.raises(HTTPException) as error:
            service.create_operational_absence(
                OperationalAbsenceCreate(
                    project_manager_id=manager.id,
                    date=date(2026, 8, 11),
                    site_id=unavailable_site.id,
                ),
                user_id=admin_user.id,
            )
        assert error.value.status_code == 400


def test_operational_absence_range_sort_and_shared_delete_work():
    db = db_session()
    creator, later_manager = add_user_person(
        db,
        name="Zora Leitung",
        role=UserRole.PROJECT_MANAGER,
    )
    other_user, earlier_manager = add_user_person(
        db,
        name="Anna Leitung",
        role=UserRole.PROJECT_MANAGER,
    )
    service = OperationalAbsenceService(db)

    no_time = service.create_operational_absence(
        OperationalAbsenceCreate(
            project_manager_id=earlier_manager.id,
            date=date(2026, 8, 11),
        ),
        user_id=creator.id,
    )
    late = service.create_operational_absence(
        OperationalAbsenceCreate(
            project_manager_id=later_manager.id,
            date=date(2026, 8, 11),
            start_time=time(12, 0),
            end_time=time(13, 0),
        ),
        user_id=creator.id,
    )
    early = service.create_operational_absence(
        OperationalAbsenceCreate(
            project_manager_id=earlier_manager.id,
            date=date(2026, 8, 11),
            start_time=time(8, 0),
            end_time=time(9, 0),
        ),
        user_id=creator.id,
    )
    service.create_operational_absence(
        OperationalAbsenceCreate(
            project_manager_id=earlier_manager.id,
            date=date(2026, 8, 12),
        ),
        user_id=creator.id,
    )

    result = service.list_operational_absences(
        start=date(2026, 8, 11),
        end=date(2026, 8, 11),
    )

    assert [item.id for item in result] == [early.id, late.id, no_time.id]
    service.delete_operational_absence(late.id, user_id=other_user.id)
    assert [
        item.id
        for item in service.list_operational_absences(
            start=date(2026, 8, 11),
            end=date(2026, 8, 11),
        )
    ] == [early.id, no_time.id]


def test_operational_absence_changes_matrix_version_but_not_matrix_conflicts():
    db = db_session()
    creator, manager = add_user_person(
        db,
        name="Christopher Erichsen",
        role=UserRole.PROJECT_MANAGER,
    )
    matrix = MatrixService(db)
    before = matrix.get_version(
        start=date(2026, 8, 11),
        end=date(2026, 8, 11),
    ).version

    entry = OperationalAbsenceService(db).create_operational_absence(
        OperationalAbsenceCreate(
            project_manager_id=manager.id,
            date=date(2026, 8, 11),
        ),
        user_id=creator.id,
    )
    created = matrix.get_version(
        start=date(2026, 8, 11),
        end=date(2026, 8, 11),
    ).version

    assert created != before
    assert matrix._cell_conflict_flags([])["conflict_level"] == "none"

    OperationalAbsenceService(db).delete_operational_absence(
        entry.id,
        user_id=creator.id,
    )
    deleted = matrix.get_version(
        start=date(2026, 8, 11),
        end=date(2026, 8, 11),
    ).version
    assert deleted != created


def test_operational_absence_range_rejects_invalid_and_oversized_queries():
    db = db_session()
    service = OperationalAbsenceService(db)

    with pytest.raises(HTTPException) as reversed_error:
        service.list_operational_absences(
            start=date(2026, 8, 12),
            end=date(2026, 8, 11),
        )
    assert reversed_error.value.status_code == 400

    with pytest.raises(HTTPException) as oversized_error:
        service.list_operational_absences(
            start=date(2026, 1, 1),
            end=date(2027, 1, 2),
        )
    assert oversized_error.value.status_code == 400
