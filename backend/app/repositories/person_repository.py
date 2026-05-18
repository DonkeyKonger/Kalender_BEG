from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.person import Person


class PersonRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get(self, person_id: int) -> Person | None:
        return self.db.get(Person, person_id)

    def list(self, is_active: bool | None = None) -> list[Person]:
        statement = select(Person).order_by(Person.display_name)
        if is_active is not None:
            statement = statement.where(Person.is_active == is_active)
        return list(self.db.scalars(statement))

    def find_by_display_or_short_code(self, value: str) -> list[Person]:
        statement = select(Person).where(
            (Person.display_name == value) | (Person.short_code == value)
        )
        return list(self.db.scalars(statement))

    def add(self, person: Person) -> Person:
        self.db.add(person)
        self.db.flush()
        return person
