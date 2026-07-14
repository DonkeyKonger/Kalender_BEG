from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session

from app.models import Base
from app.models.enums import PersonType
from app.models.person import Person
from app.schemas.person import ExternalPersonCreate
from app.services.external_person_service import ExternalPersonService
from app.services.person_service import PersonService


def db_session() -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    return Session(engine)


def internal_person() -> Person:
    return Person(
        first_name="Christopher",
        last_name="Erichsen",
        display_name="Christopher Erichsen",
        short_code="CE",
        person_type=PersonType.INTERNAL,
        is_active=True,
    )


def test_external_creation_reuses_unique_internal_calendar_identity():
    db = db_session()
    person = internal_person()
    db.add(person)
    db.commit()

    resolved = PersonService(db).create_external_person(
        ExternalPersonCreate(display_name="C.Erichsen"),
        user_id=999,
    )

    assert resolved.id == person.id
    assert resolved.person_type == PersonType.INTERNAL
    assert db.scalar(select(func.count(Person.id))) == 1


def test_matrix_external_resolution_reuses_unique_internal_calendar_identity():
    db = db_session()
    person = internal_person()
    db.add(person)
    db.commit()

    resolved = ExternalPersonService(db).resolve_external_temp("  C.Erichsen  ")

    assert resolved.id == person.id
    assert resolved.person_type == PersonType.INTERNAL
    assert db.scalar(select(func.count(Person.id))) == 1


def test_ambiguous_internal_identity_is_not_guessed():
    db = db_session()
    db.add_all([
        internal_person(),
        Person(
            first_name="Clara",
            last_name="Erichsen",
            display_name="Clara Erichsen",
            short_code="C.Erichsen",
            person_type=PersonType.INTERNAL,
            is_active=True,
        ),
    ])
    db.commit()

    resolved = ExternalPersonService(db).resolve_external_temp("C.Erichsen")

    assert resolved.person_type == PersonType.EXTERNAL_TEMP
    assert db.scalar(select(func.count(Person.id))) == 3
