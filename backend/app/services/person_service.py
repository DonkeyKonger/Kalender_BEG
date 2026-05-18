from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.person import Person
from app.repositories.person_repository import PersonRepository
from app.schemas.person import PersonCreate, PersonUpdate


class PersonService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.people = PersonRepository(db)

    def list_people(self, is_active: bool | None = None) -> list[Person]:
        return self.people.list(is_active=is_active)

    def create_person(self, payload: PersonCreate) -> Person:
        person = Person(**payload.model_dump())
        self.people.add(person)
        self.db.commit()
        self.db.refresh(person)
        return person

    def update_person(self, person_id: int, payload: PersonUpdate) -> Person:
        person = self.people.get(person_id)
        if person is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Person nicht gefunden.")
        for field, value in payload.model_dump(exclude_unset=True).items():
            setattr(person, field, value)
        self.db.commit()
        self.db.refresh(person)
        return person
