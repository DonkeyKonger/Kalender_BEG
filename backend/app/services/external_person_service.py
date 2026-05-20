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

        name_parts = external_person_name_parts(cleaned)
        person = Person(
            first_name=name_parts["first_name"],
            last_name=name_parts["last_name"],
            display_name=name_parts["display_name"],
            short_code=name_parts["short_code"],
            person_type=PersonType.EXTERNAL_TEMP,
            is_active=True,
            notes="Aus Matrix-Schnelleingabe erzeugt.",
        )
        return self.people.add(person)


def external_person_name_parts(name: str) -> dict[str, str]:
    cleaned = " ".join(name.split())
    parts = [part for part in cleaned.replace(",", " ").split() if part]
    if not parts:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Externer Name fehlt.")

    first_name = parts[0]
    last_name = parts[-1] if len(parts) >= 2 else parts[0]
    return {
        "first_name": first_name,
        "last_name": last_name,
        "display_name": cleaned,
        "short_code": f"{first_name[:1]}.{last_name}",
    }
