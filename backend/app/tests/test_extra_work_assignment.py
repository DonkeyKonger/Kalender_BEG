from datetime import date
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.models import Base
from app.models.assignment import Assignment
from app.models.person import Person
from app.models.site import Site
from app.services.extra_work_assignment import get_mobile_extra_work_assignment


def db_session() -> Session:
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return Session(engine)


def test_mobile_extra_work_assignment_resolves_only_the_current_users_assignment():
    db = db_session()
    person = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
    )
    site = Site(site_number="8007", name="Klinik")
    db.add_all([person, site])
    db.commit()
    assignment = Assignment(
        person_id=person.id,
        site_id=site.id,
        start_date=date(2026, 8, 24),
        end_date=date(2026, 8, 24),
    )
    db.add(assignment)
    db.commit()

    loaded = get_mobile_extra_work_assignment(
        db,
        assignment_id=assignment.id,
        current_user=SimpleNamespace(person_id=person.id),
    )

    assert loaded.id == assignment.id
    assert loaded.person.display_name == "Max Monteur"

    with pytest.raises(HTTPException) as foreign_assignment:
        get_mobile_extra_work_assignment(
            db,
            assignment_id=assignment.id,
            current_user=SimpleNamespace(person_id=person.id + 1),
        )
    assert foreign_assignment.value.status_code == 404
    assert foreign_assignment.value.detail == "Einsatz nicht gefunden."


def test_mobile_extra_work_assignment_requires_a_linked_person():
    db = db_session()

    with pytest.raises(HTTPException) as missing_person:
        get_mobile_extra_work_assignment(
            db,
            assignment_id=1,
            current_user=SimpleNamespace(person_id=None),
        )

    assert missing_person.value.status_code == 403
    assert missing_person.value.detail == "Dieser Benutzer ist keiner Person zugeordnet."
