from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.enums import PersonType
from app.models.person import Person
from app.repositories.person_repository import PersonRepository


class ExternalPersonService:
    def __init__(self, db: Session) -> None:
        self.people = PersonRepository(db)

    def resolve_external_temp(self, name: str) -> Person:
        cleaned = " ".join(name.split())
        if not cleaned:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Externer Name fehlt.")

        matches = self.people.find_by_display_or_short_code(cleaned)
        if len(matches) > 1:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Eingabe ist nicht eindeutig.")
        if len(matches) == 1:
            return matches[0]

        person = Person(
            first_name=cleaned,
            last_name="",
            display_name=cleaned,
            short_code=self._short_code(cleaned),
            person_type=PersonType.EXTERNAL_TEMP,
            is_active=True,
            notes="Aus Matrix-Schnelleingabe erzeugt.",
        )
        return self.people.add(person)

    def _short_code(self, name: str) -> str:
        parts = [part for part in name.replace(",", " ").split() if part]
        if len(parts) >= 2:
            return f"{parts[0][:1]}.{parts[-1]}"
        return f"{name[:1]}.{name}"
