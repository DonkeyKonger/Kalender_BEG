from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.person import Person
from app.repositories.person_repository import PersonRepository
from app.schemas.person import PersonCreate, PersonUpdate
from app.services.audit_service import AuditService


REQUIRED_TEXT_FIELDS = {
    "first_name": "Vorname darf nicht leer sein.",
    "last_name": "Nachname darf nicht leer sein.",
    "display_name": "Anzeigename darf nicht leer sein.",
    "short_code": "Kuerzel darf nicht leer sein.",
}


class PersonService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.people = PersonRepository(db)
        self.audit = AuditService(db)

    def list_people(self, is_active: bool | None = None) -> list[Person]:
        return self.people.list(is_active=is_active)

    def create_person(self, payload: PersonCreate, user_id: int) -> Person:
        person = Person(**clean_person_values(payload.model_dump()))
        self.people.add(person)
        self.db.flush()
        self.audit.record(
            user_id=user_id,
            action="person.created",
            entity_type="person",
            entity_id=person.id,
            old_value=None,
            new_value=person_snapshot(person),
        )
        self.db.commit()
        self.db.refresh(person)
        return person

    def update_person(self, person_id: int, payload: PersonUpdate, user_id: int) -> Person:
        person = self.people.get(person_id)
        if person is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Person nicht gefunden.")
        old_value = person_snapshot(person)
        for field, value in clean_person_values(payload.model_dump(exclude_unset=True)).items():
            setattr(person, field, value)
        self.audit.record(
            user_id=user_id,
            action="person.updated",
            entity_type="person",
            entity_id=person.id,
            old_value=old_value,
            new_value=person_snapshot(person),
        )
        self.db.commit()
        self.db.refresh(person)
        return person


def clean_person_values(values: dict) -> dict:
    cleaned = dict(values)
    for field in ["first_name", "last_name", "display_name", "short_code", "email", "phone"]:
        if isinstance(cleaned.get(field), str):
            cleaned[field] = cleaned[field].strip()
    if not cleaned.get("display_name") and cleaned.get("first_name") and cleaned.get("last_name"):
        cleaned["display_name"] = f"{cleaned['first_name']} {cleaned['last_name']}"
    if not cleaned.get("short_code") and cleaned.get("first_name") and cleaned.get("last_name"):
        cleaned["short_code"] = f"{cleaned['first_name'][:1]}.{cleaned['last_name']}"
    for field, message in REQUIRED_TEXT_FIELDS.items():
        if field in cleaned and not cleaned.get(field):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, message)
    return cleaned


def person_snapshot(person: Person) -> dict:
    return {
        "id": person.id,
        "first_name": person.first_name,
        "last_name": person.last_name,
        "display_name": person.display_name,
        "short_code": person.short_code,
        "person_type": person.person_type.value,
        "is_active": person.is_active,
        "email": person.email,
        "phone": person.phone,
        "notes": person.notes,
    }
