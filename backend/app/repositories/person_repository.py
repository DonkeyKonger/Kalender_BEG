from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models.enums import PersonType
from app.models.person import Person


class PersonRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get(self, person_id: int, *, include_deleted: bool = False) -> Person | None:
        person = self.db.get(Person, person_id)
        if person is not None and person.deleted_at is not None and not include_deleted:
            return None
        return person

    def list(self, is_active: bool | None = None) -> list[Person]:
        statement = (
            select(Person)
            .options(selectinload(Person.users))
            .where(Person.deleted_at.is_(None))
            .order_by(Person.display_name)
        )
        if is_active is not None:
            statement = statement.where(Person.is_active == is_active)
        return list(self.db.scalars(statement))

    def find_by_display_or_short_code(self, value: str) -> list[Person]:
        statement = select(Person).where(
            Person.deleted_at.is_(None),
            (Person.display_name == value) | (Person.short_code == value),
        )
        return list(self.db.scalars(statement))

    def find_active_external_by_display_name(self, value: str) -> Person | None:
        statement = (
            select(Person)
            .where(
                Person.deleted_at.is_(None),
                Person.is_active.is_(True),
                Person.person_type.in_([PersonType.EXTERNAL, PersonType.EXTERNAL_TEMP]),
                Person.display_name == value,
            )
            .order_by(Person.id)
            .limit(1)
        )
        return self.db.scalar(statement)

    def add(self, person: Person) -> Person:
        self.db.add(person)
        self.db.flush()
        return person
