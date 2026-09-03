from datetime import date

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models import Base
from app.models.enums import PersonType, UserRole
from app.models.person import Person
from app.models.user import User
from app.services.person_hours_account_service import PersonHoursAccountService


def db_session() -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    return Session(engine)


def test_manual_adjustment_and_payout_update_hours_account_balance():
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

    service = PersonHoursAccountService(db)
    adjusted = service.create_manual_adjustment(
        person_id=person.id,
        hours_delta=5.5,
        effective_date=date(2026, 8, 3),
        note="Startwert Altbestand übernommen",
        current_user=user,
    )
    paid = service.create_payout(
        person_id=person.id,
        hours=2,
        effective_date=date(2026, 8, 4),
        note="Auszahlung Juli 2026",
        current_user=user,
    )

    assert adjusted.current_balance_minutes == 330
    assert paid.current_balance_minutes == 210
    assert [entry.entry_type for entry in paid.entries] == ["payout", "manual_adjustment"]
    assert paid.entries[0].minutes_delta == -120
    assert paid.entries[0].balance_after_minutes == 210
    assert paid.entries[1].minutes_delta == 330
    assert paid.entries[1].balance_after_minutes == 330
