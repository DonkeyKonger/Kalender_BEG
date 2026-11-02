from datetime import date
import importlib.util
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
from fastapi import HTTPException
from pydantic import ValidationError
import pytest
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import Session

from app.models import Base
from app.models.audit_log import AuditLog
from app.schemas.person import PersonCreate, PersonRead, PersonUpdate
from app.services.person_service import PersonService


@pytest.fixture
def db():
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session
    engine.dispose()


def create_person(db, **values):
    return PersonService(db).create_person(PersonCreate(
        first_name="Test", last_name="Monteur", display_name="Test Monteur", short_code="TM",
        **values,
    ), user_id=999)


def test_dates_survive_reload_and_are_audited_without_changing_status(db):
    person = create_person(db, employment_status="departed")
    assert person.employment_start_date is None
    assert person.employment_end_date is None
    updated = PersonService(db).update_person(person.id, PersonUpdate(
        employment_start_date="2020-05-01", employment_end_date="2026-10-31",
    ), user_id=999)
    db.expire_all()
    read = PersonRead.model_validate(updated)
    assert read.employment_start_date == date(2020, 5, 1)
    assert read.employment_end_date == date(2026, 10, 31)
    assert read.employment_status == "departed"
    assert read.is_active is False
    audit = db.scalar(select(AuditLog).where(AuditLog.action == "person.updated"))
    assert audit.old_value_json["employment_start_date"] is None
    assert audit.new_value_json["employment_start_date"] == "2020-05-01"
    assert audit.new_value_json["employment_end_date"] == "2026-10-31"


def test_dates_do_not_implicitly_change_current_status(db):
    person = create_person(db, employment_start_date="2020-05-01", employment_end_date="2021-05-01")
    assert person.is_active is True
    assert person.employment_status == "active"


def test_partial_update_preserves_omitted_date_and_allows_clearing(db):
    person = create_person(db, employment_start_date="2020-05-01", employment_end_date="2026-10-31")
    service = PersonService(db)
    updated = service.update_person(person.id, PersonUpdate(phone="123"), user_id=999)
    assert updated.employment_start_date == date(2020, 5, 1)
    assert updated.employment_end_date == date(2026, 10, 31)
    updated = service.update_person(person.id, PersonUpdate(employment_end_date=None), user_id=999)
    assert updated.employment_start_date == date(2020, 5, 1)
    assert updated.employment_end_date is None


@pytest.mark.parametrize("patch", [
    {"employment_end_date": "2019-12-31"},
    {"employment_start_date": "2027-01-01"},
])
def test_partial_update_rejects_invalid_period_before_mutation(db, patch):
    person = create_person(db, employment_start_date="2020-05-01", employment_end_date="2026-10-31")
    with pytest.raises(HTTPException) as caught:
        PersonService(db).update_person(person.id, PersonUpdate(**patch), user_id=999)
    assert caught.value.status_code == 400
    assert "Austrittsdatum" in caught.value.detail
    assert person.employment_start_date == date(2020, 5, 1)
    assert person.employment_end_date == date(2026, 10, 31)
    assert db.scalar(select(AuditLog).where(AuditLog.action == "person.updated")) is None


def test_payload_rejects_reversed_or_invalid_dates_and_accepts_same_day():
    with pytest.raises(ValidationError):
        PersonUpdate(employment_start_date="2026-10-02", employment_end_date="2026-10-01")
    with pytest.raises(ValidationError):
        PersonUpdate(employment_start_date="2026-02-30")
    assert PersonUpdate(employment_start_date="2026-10-01", employment_end_date="2026-10-01")


def test_migration_preserves_existing_people_without_inventing_dates():
    path = Path(__file__).parents[2] / "alembic/versions/20261102_0131_person_employment_dates.py"
    spec = importlib.util.spec_from_file_location("employment_migration", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    engine = create_engine("sqlite+pysqlite:///:memory:")
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE persons (id INTEGER PRIMARY KEY, display_name TEXT, is_active BOOLEAN)"))
        connection.execute(text("INSERT INTO persons VALUES (1, 'Bestand', 0)"))
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()
        row = connection.execute(text("SELECT * FROM persons")).mappings().one()
        assert dict(row) == dict(id=1, display_name="Bestand", is_active=0,
                                 employment_start_date=None, employment_end_date=None)
        migration.downgrade()
        assert connection.execute(text("SELECT * FROM persons")).one() == (1, "Bestand", 0)
    engine.dispose()
