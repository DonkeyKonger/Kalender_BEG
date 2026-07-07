from datetime import date
from types import SimpleNamespace

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models import Base
from app.models.enums import AbsenceStatus, AbsenceType, PersonType
from app.models.person import Person
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
